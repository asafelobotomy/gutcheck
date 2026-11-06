// Test review for one repo: the static review (layer 1), results that already exist (layer 2) and
// what can be run (layer 3), turned into advice rows like every other finding. Read-only.

const { reviewTests } = require('./review');
const { readResults } = require('./results');
const { runnable } = require('./runs');
const { runDir } = require('../paths');
const { plural, list } = require('../util');

const COVERAGE_WARN = 50;
const COVERAGE_INFO = 75;
const MUTATION_WARN = 60;
const SLOW_TEST_S = 5;
const RATIO_LOW = 0.1;
const STALE_DAYS = 30;

const at = (x) => `${x.path}${x.line ? ':' + x.line : ''}`;

function buildTestAdvice(t) {
  const out = [];
  const add = (id, severity, title, detail, fix) => out.push({ id, category: 'Tests', severity, title, detail, fix });
  const total = t.testCases;
  const canRun = (kind) => t.runnable.find((x) => x[kind]);
  const runFix = (kind, label) => { const s = canRun(kind); return s ? { type: 'tests-run', label, kind, stack: s.stack, root: s.root } : undefined; };

  if (!total && t.sourceFiles >= 5) add('t-none', 'warn', 'No tests', `${t.sourceFiles} source files and no test cases found. Start with the module that would hurt most if it broke.`);
  if (total) {
    const notRun = t.stacks.filter((s) => (t.byLangFor(s.id) || 0) > 0 && t.ci.workflows && !t.ci.runs[s.id]);
    if (!t.ci.workflows) add('t-ci-none', 'warn', `No CI runs the ${plural(total, 'test')}`, 'Nothing runs them on push or pull request, so a break is noticed late. Add a workflow that runs the test command.');
    else if (notRun.length) add('t-ci', 'warn', `CI does not run the ${notRun.map((s) => s.name).join(' and ')} tests`, `The workflows never call ${notRun.map((s) => ({ rust: 'cargo test', python: 'pytest', node: 'the npm test script', go: 'go test', gradle: 'gradle test', shell: 'the test scripts' }[s.id] || 'the tests')).join(' or ')}.`);
  }
  if (t.focused.length) add('t-focused', 'warn', `${plural(t.focused.length, 'focused test')} (.only)`, `${list(t.focused.map(at), 5)}. A focused test makes the runner skip every other test in that file or suite.`);
  if (t.noAssert.length) add('t-no-assert', 'warn', `${plural(t.noAssert.length, 'test file')} without assertions`, `${list(t.noAssert.map((x) => `${x.path} (${plural(x.cases, 'test')})`), 5)}. A test that asserts nothing passes whatever the code does.`);
  if (t.skipped.length) add('t-skipped', 'info', `${plural(t.skipped.length, 'skipped test')}`, `${list(t.skipped.map(at), 5)}. Fix them, or delete them if they are no longer wanted.`);
  if (t.sleeps.length) add('t-sleep', 'info', `${plural(t.sleeps.length, 'sleep')} in tests`, `${list(t.sleeps.map(at), 5)}. Fixed waits make tests slow and flaky: wait for the condition instead.`);
  if (t.network.length) add('t-network', 'info', `${plural(t.network.length, 'test file')} calling real servers`, `${list(t.network.map(at), 5)}. Tests that need the internet fail offline and when the server changes: use a local fake.`);
  if (total && t.untested.length && !t.results.coverage) add('t-untested', 'info', `${plural(t.untestedCount, 'source file')} with no test named after it`, `Largest: ${list(t.untested.map((u) => `${u.path} (${u.lines} lines)`), 6)}. A name match is only a hint: a coverage run shows what really runs.`, t.results.coverage ? undefined : runFix('coverage', 'Run coverage…'));
  if (total && t.sourceLines >= 2000 && t.testLines / t.sourceLines < RATIO_LOW) add('t-ratio', 'info', 'Little test code for the amount of code', `${t.testLines} lines of tests for ${t.sourceLines} lines of code (${Math.round((100 * t.testLines) / t.sourceLines)}%).`);
  if (t.ruff && t.ruff.total) add('t-ruff', 'info', `${plural(t.ruff.total, 'pytest style issue')} (ruff PT rules)`, `${Object.entries(t.ruff.byRule).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} x${v}`).join(', ')}. ${list(t.ruff.items.map((i) => `${i.path}:${i.line} ${i.message}`), 3)}`);

  const c = t.results.coverage;
  const age = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (c && c.percent != null) {
    const sev = c.percent < COVERAGE_WARN ? 'warn' : c.percent < COVERAGE_INFO ? 'info' : null;
    if (sev) add('t-coverage', sev, `Line coverage ${c.percent}%`, `From ${c.file} (${age(c.date)} days old). Least covered: ${list(c.lowest.map((f) => `${f.path} ${f.percent}%`), 6)}.`, age(c.date) > STALE_DAYS ? runFix('coverage', 'Run coverage again…') : undefined);
    else if (age(c.date) > STALE_DAYS) add('t-coverage-stale', 'info', `Coverage report is ${age(c.date)} days old`, `${c.file} shows ${c.percent}%, but the code has moved on since.`, runFix('coverage', 'Run coverage again…'));
  } else if (total && canRun('coverage')) add('t-coverage-none', 'info', 'Coverage never measured', 'No coverage report found. Measuring it shows which code no test runs at all.', runFix('coverage', 'Run coverage…'));

  const j = t.results.junit;
  if (j && j.failed) add('t-failing', 'error', `${plural(j.failed, 'failing test')} in the last report`, `${list(j.failures, 5)} (${j.file}).`);
  if (j) { const slow = j.slowest.filter((s) => s.time >= SLOW_TEST_S); if (slow.length) add('t-slow', 'info', `${plural(slow.length, 'slow test')} (${SLOW_TEST_S}s or more)`, list(slow.map((s) => `${s.name} ${s.time}s`), 5)); }

  const m = t.results.mutation;
  if (m && m.score != null && m.score < MUTATION_WARN) add('t-mutation', 'warn', `Mutation score ${m.score}%: tests miss ${plural(m.survived, 'deliberate bug')}`, `${m.tool}: ${m.killed} caught, ${m.survived} survived. Examples: ${list(m.examples, 4)}. Each survivor is a change to the code that no test noticed: add an assertion that would.`);
  else if (!m && total && c && c.percent >= COVERAGE_WARN && canRun('mutation')) add('t-mutation-none', 'info', 'Test strength never measured', 'Coverage shows which code runs, not whether the tests would notice it breaking. Mutation testing checks that (it is slow).', runFix('mutation', 'Run mutation testing…'));
  return out;
}

async function scanTests(dir, { env } = {}) {
  const t = await reviewTests(dir);
  t.results = readResults(dir, runDir(dir, env));
  t.runnable = runnable(t.stacks);
  const extOf = { rust: 'rs', python: 'py', node: 'js', go: 'go', gradle: 'kt', shell: 'sh' };
  t.byLangFor = (id) => (t.byLang[extOf[id]] || {}).testCases;
  t.advice = buildTestAdvice(t);
  delete t.byLangFor;
  return t;
}

module.exports = { scanTests, buildTestAdvice };
