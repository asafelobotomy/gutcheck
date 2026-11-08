// The Tests part of the "Copy for LLM" report: what the review found, and ordered steps an agent
// can follow to improve the tests. Agents write tests here; GutCheck only points at the gaps.

const { upkeepFix } = require('./upkeep');

const clip = (s, n = 160) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

function testsSection(t) {
  if (!t || t.error) return '';
  const L = [`\n**Tests** (${t.testCases} test cases in ${t.testFiles} files${t.inlineTests ? `, ${t.inlineTests} inline Rust tests` : ''}; stacks: ${t.stacks.map((s) => `${s.name}${s.runner ? ` (${s.runner})` : ''}`).join(', ') || 'none found'})`];
  const r = t.results || {};
  if (r.coverage) L.push(`Coverage: ${r.coverage.percent}% of lines (${r.coverage.file}, ${r.coverage.date.slice(0, 10)}). Least covered:\n` + r.coverage.lowest.slice(0, 8).map((f) => `- \`${clip(f.path)}\` ${f.percent}% of ${f.lines} lines`).join('\n'));
  if (r.junit) L.push(`Last test report: ${r.junit.tests} tests, ${r.junit.failed} failed, ${r.junit.skipped} skipped, ${r.junit.time}s.`);
  if (r.mutation) L.push(`Mutation testing (${r.mutation.tool}): score ${r.mutation.score}%, ${r.mutation.survived} survived. Survivors:\n` + r.mutation.examples.slice(0, 8).map((e) => `- \`${clip(e)}\``).join('\n'));
  if (t.untested && t.untested.length) L.push('Largest source files with no test named after them:\n' + t.untested.slice(0, 8).map((u) => `- \`${clip(u.path)}\` (${u.lines} lines)`).join('\n'));
  return L.length > 1 ? L.join('\n') + '\n' : '';
}

const Q = 8; // with the other code-quality steps
const STEPS = {
  't-failing': { phase: 2, rank: 0, why: 'Tests fail in the latest report.', note: 'Run the failing tests, find the cause in the code (or the test, if the behaviour changed on purpose), and fix it. Never delete or skip a failing test to make it pass.' },
  't-ci-none': { phase: 2, rank: 5, why: 'Nothing runs the tests automatically.', note: 'Add a GitHub Actions workflow that installs the project and runs its test command on push and pull request. Pin actions to commit SHAs and set permissions: contents: read.' },
  't-ci': { phase: 2, rank: 5, why: 'Some of the tests never run in CI.', note: 'Add the missing test command to the existing workflow (a separate job is fine).' },
  't-focused': { phase: 2, rank: 1, why: 'A focused test hides every other test.', note: 'Remove .only / fit / fdescribe from each listed place.' },
  't-no-assert': { phase: Q, rank: 1, why: 'Tests that assert nothing always pass.', note: 'For each listed file, add assertions on the behaviour each test is named after (return values, state, errors). Keep tests that only check "does not crash" but name them that way.' },
  't-none': { phase: Q, rank: 2, why: 'Nothing checks that the code works.', note: 'Set up the usual test runner for this language, then write tests for the most important module first: its main success path, one failure path and one edge case.' },
  't-untested': { phase: Q, rank: 3, why: 'Large files have no tests named after them.', note: 'Starting with the largest listed file, write tests for its public functions. If a coverage report exists, prefer its least-covered files. Do not chase a coverage number: test behaviour that matters.' },
  't-coverage': { phase: Q, rank: 3, why: 'Much of the code never runs under test.', note: 'Write tests for the least-covered files listed under Tests, behaviour first. Re-run coverage to check.' },
  't-mutation': { phase: Q, rank: 4, why: 'Tests run the code but would not notice it breaking.', note: 'For each surviving mutant listed under Tests, add or tighten an assertion that fails when that change is made. Do not change the code to kill a mutant.' },
  't-skipped': { phase: Q, rank: 6, why: 'Skipped tests check nothing.', note: 'For each skipped test, ask the owner: fix it, or delete it. Do not unskip a test without making it pass.' },
  't-sleep': { phase: Q, rank: 7, why: 'Fixed waits make tests slow and flaky.', note: 'Replace sleeps with waiting for the condition (polling with a timeout, events, or a fake clock).' },
  't-network': { phase: Q, rank: 7, why: 'Tests that need the internet are flaky.', note: 'Replace real HTTP calls with a local fake server or recorded responses.' },
  't-slow': { phase: Q, rank: 8, why: 'Slow tests get skipped by people in a hurry.', note: 'Look at what the listed tests wait on; mark genuinely slow ones so they can run separately.' },
  't-ratio': { phase: Q, rank: 9, why: 'There is little test code for the size of the project.', cmds: [] },
  't-ruff': { phase: Q, rank: 9, why: 'pytest style issues.', cmds: ['ruff check --select PT .'], note: 'Fix them by hand or with ruff --fix after reviewing the diff.' },
};

function testsFix(id) {
  const s = STEPS[id] || upkeepFix(id);
  if (!s) return null; // coverage-none, mutation-none, stale: the app offers a run; nothing for an agent to edit
  return { cmds: [], ...s };
}

module.exports = { testsSection, testsFix };
