const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { reviewTests } = require('../src/tests/review');
const R = require('../src/tests/results');
const { planTestRun, runnable } = require('../src/tests/runs');
const { scanTests, buildTestAdvice } = require('../src/tests');
const { testsSection, testsFix } = require('../src/tests/report');
const { apply } = require('../src/apply');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const tmp = (p = 'gutcheck-t-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const repo = () => { const d = tmp(); sh(d, 'init', '-q', '-b', 'main'); return d; };
const rm = (...d) => d.forEach((x) => fs.rmSync(x, { recursive: true, force: true }));
const big = (n, line = 'x = 1') => Array.from({ length: n }, () => line).join('\n');

test('layer 1: counts tests per language, inline Rust tests, focused/skipped/assertion-free tests, sleeps, network, untested files, CI', async () => {
  const d = repo();
  try {
    put(d, 'package.json', JSON.stringify({ devDependencies: { vitest: '1' }, scripts: { test: 'vitest' } }));
    put(d, 'src/cart.test.js', "it('adds', () => { expect(add(1)).toBe(1) });\nit.only('focus', () => { expect(1).toBe(1) });\nit.skip('later', () => {});\n");
    put(d, 'src/empty.test.js', "test('runs', () => { add(1) });\n");
    put(d, 'src/helper.test.js', "test('uses a helper', () => { checkTotals(cart) });\n");
    put(d, 'pyproject.toml', '[project]\nname="x"\n[tool.pytest.ini_options]\n');
    put(d, 'tests/test_api.py', 'import time, requests\n\ndef test_live():\n    requests.get("https://api.github.com/x")\n    time.sleep(2)\n    assert True\n\n@pytest.mark.skip\ndef test_off():\n    assert 1\n');
    put(d, 'Cargo.toml', '[package]\nname="x"\n');
    put(d, 'src/lib.rs', 'pub fn f() -> u8 { 1 }\n' + big(10, '// code') + '\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn f_works() { assert_eq!(super::f(), 1); }\n    #[test]\n    #[ignore]\n    fn slow() {}\n}\n');
    put(d, 'src/smoke.rs', '#[cfg(test)]\nmod tests {\n    #[test]\n    fn parse_does_not_panic() { let _ = 1; }\n}\n');
    put(d, 'src/big_module.py', big(80));
    put(d, 'src/cart.js', big(60, 'let a = 1;'));
    put(d, '.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npx vitest run\n      - run: cargo test\n');
    const t = await reviewTests(d);
    assert.deepEqual(t.stacks.map((s) => `${s.id}:${s.runner}`).sort(), ['node:vitest', 'python:pytest', 'rust:cargo']);
    assert.deepEqual([t.byLang.js.testCases, t.byLang.py.testCases, t.byLang.rs.testCases], [5, 2, 3]);
    assert.equal(t.inlineTests, 3);
    assert.deepEqual(t.focused.map((x) => [x.path, x.line]), [['src/cart.test.js', 2]]);
    assert.deepEqual(t.skipped.map((x) => x.path).sort(), ['src/cart.test.js', 'src/lib.rs', 'tests/test_api.py']);
    assert.deepEqual(t.noAssert.map((x) => x.path), ['src/empty.test.js'], 'helpers like checkTotals() and "does_not_panic" tests count');
    assert.deepEqual(t.sleeps.map((x) => x.path), ['tests/test_api.py']);
    assert.deepEqual(t.network.map((x) => x.path), ['tests/test_api.py']);
    assert.deepEqual(t.untested.map((u) => u.path), ['src/big_module.py'], 'cart.js has cart.test.js; lib.rs has inline tests');
    assert.deepEqual(t.ci, { workflows: true, runs: { node: true, python: false, rust: true } });
  } finally { rm(d); }
});

test('layer 2: coverage, JUnit and mutation parsers', () => {
  assert.deepEqual(R.parseLcov('SF:/r/src/a.js\nLF:10\nLH:4\nend_of_record\nSF:src/b.js\nLF:0\nLH:0\nend_of_record\n', '/r'), [{ path: 'src/a.js', hit: 4, total: 10 }, { path: 'src/b.js', hit: 0, total: 0 }]);
  assert.deepEqual(R.parseCobertura('<coverage><class filename="m/a.py"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class><class filename="m/a.py"><lines><line number="3" hits="2"/></lines></class></coverage>', '/r'), [{ path: 'm/a.py', hit: 2, total: 3 }]);
  assert.deepEqual(R.parseGoCover('mode: set\nx/a.go:1.1,2.2 3 1\nx/a.go:4.1,5.2 2 0\n'), [{ path: 'x/a.go', hit: 3, total: 5 }]);
  assert.deepEqual(R.parseJacoco('<report><package name="app/x"><sourcefile name="A.kt"><counter type="LINE" missed="3" covered="7"/></sourcefile></package></report>'), [{ path: 'app/x/A.kt', hit: 7, total: 10 }]);
  const j = R.parseJunit('<testsuite><testcase classname="a" name="ok" time="0.1"/><testcase name="bad" time="7"><failure/></testcase><testcase name="s" time="0"><skipped/></testcase></testsuite>');
  assert.deepEqual([j.tests, j.failed, j.skipped, j.time, j.failures, j.slowest[0]], [3, 1, 1, 7.1, ['bad'], { name: 'bad', time: 7 }]);
  const cm = R.parseCargoMutants(JSON.stringify({ outcomes: [{ summary: 'Success', scenario: 'Baseline' }, { summary: 'CaughtMutant', scenario: { Mutant: {} } }, { summary: 'MissedMutant', scenario: { Mutant: { file: 'src/a.rs', span: { start: { line: 9 } }, replacement: 'true' } } }] }));
  assert.deepEqual([cm.killed, cm.survived, cm.examples], [1, 1, ['src/a.rs:9 true']]);
  const st = R.parseStryker(JSON.stringify({ files: { 'a.js': { mutants: [{ status: 'Killed' }, { status: 'Survived', mutatorName: 'EqualityOperator', location: { start: { line: 4 } } }, { status: 'NoCoverage', mutatorName: 'BlockStatement', location: { start: { line: 8 } } }] } } }));
  assert.deepEqual([st.killed, st.survived, st.examples[1]], [1, 2, 'a.js:8 BlockStatement (no test runs this code)']);
  assert.deepEqual(R.parseMutmut('a.x__mutmut_1: survived\na.x__mutmut_2: killed\n'), { tool: 'mutmut', killed: 1, survived: 1, examples: ['a.x__mutmut_1'] });
});

test('layer 2: readResults finds the newest report in the repo or GutCheck\'s run folder', () => {
  const d = tmp();
  const run = tmp();
  try {
    put(d, 'coverage/lcov.info', 'SF:a.js\nLF:100\nLH:20\nend_of_record\n');
    const old = (Date.now() - 40 * 864e5) / 1000;
    fs.utimesSync(path.join(d, 'coverage/lcov.info'), old, old);
    put(run, 'lcov.info', 'SF:a.js\nLF:100\nLH:90\nend_of_record\nSF:b.js\nLF:50\nLH:10\nend_of_record\n');
    put(run, 'junit.xml', '<testsuite><testcase name="t" time="1"/></testsuite>');
    put(run, 'mutants.out/outcomes.json', JSON.stringify({ outcomes: [{ summary: 'MissedMutant', scenario: { Mutant: { file: 'a.rs', span: { start: { line: 1 } } } } }, { summary: 'CaughtMutant' }] }));
    const r = R.readResults(d, run);
    assert.equal(r.coverage.percent, 66.7, 'the newer run wins over the old report');
    assert.deepEqual(r.coverage.lowest.map((f) => f.path), ['b.js', 'a.js']);
    assert.equal(r.junit.tests, 1);
    assert.deepEqual([r.mutation.tool, r.mutation.score], ['cargo-mutants', 50]);
    assert.deepEqual(R.readResults(tmp(), null), { coverage: null, junit: null, mutation: null });
  } finally { rm(d, run); }
});

test('layer 3: runs are dangerous, write to GutCheck\'s run folder, and refuse with an install hint when a tool is missing', async () => {
  const d = repo();
  try {
    put(d, 'Cargo.toml', '[package]\nname="x"\n');
    put(d, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const calls = [];
    const ctx = (have) => ({ runDir: () => '/runs/x', run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: have.some((h) => [cmd, ...args].join(' ').includes(h)) }; } });
    const r = { path: d, name: 'x' };
    await assert.rejects(planTestRun(r, { kind: 'coverage', stack: 'rust' }, ctx([])), /cargo-llvm-cov is not installed.*cargo install cargo-llvm-cov/s);
    await assert.rejects(planTestRun(r, { kind: 'mutation', stack: 'rust' }, ctx([])), /cargo install cargo-mutants/);
    await assert.rejects(planTestRun(r, { kind: 'mutation', stack: 'node' }, ctx([])), /Stryker is not set up/);
    await assert.rejects(planTestRun(r, { kind: 'bogus' }, ctx([])), /coverage or mutation/);
    const p = await planTestRun(r, { kind: 'coverage', stack: 'rust' }, ctx(['llvm-cov --version']));
    assert.equal(p.risk, 'danger');
    assert.match(p.warnings[0], /execute its code/);
    assert.deepEqual(p.steps[0], { kind: 'mkdir', path: '/runs/x', display: "create GutCheck's run folder /runs/x" });
    assert.deepEqual(p.steps[1].args, ['llvm-cov', '--workspace', '--lcov', '--output-path', '/runs/x/lcov.info']);
    const n = await planTestRun(r, { kind: 'coverage', stack: 'node' }, ctx([]));
    assert.ok(n.steps[1].args.includes('--experimental-test-coverage') && n.steps[1].args.includes('--test-reporter-destination=/runs/x/lcov.info'));
    assert.deepEqual(runnable([{ id: 'rust', root: '.', name: 'Rust' }, { id: 'gradle', root: 'android', name: 'Gradle' }]).map((x) => [x.stack, x.coverage, x.mutation]), [['rust', true, true], ['gradle', false, false]]);
  } finally { rm(d); }
});

test('apply: mkdir, okCodes for tools that exit non-zero on findings, and saveOutput', async () => {
  const out = tmp();
  try {
    const dir = path.join(out, 'runs', 'r');
    const res = await apply({ steps: [
      { kind: 'mkdir', path: dir, display: 'mkdir' },
      { kind: 'cmd', cmd: 'm', args: ['run'], display: 'run', okCodes: [0, 2] },
      { kind: 'cmd', cmd: 'm', args: ['results'], display: 'results', saveOutput: path.join(dir, 'res.txt') },
    ] }, { run: async (cmd, args) => (args[0] === 'run' ? { ok: false, code: 2, stdout: '', stderr: 'survivors' } : { ok: true, code: 0, stdout: 'a: survived\n', stderr: '' }) });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'res.txt'), 'utf8'), 'a: survived\n');
    const bad = await apply({ steps: [{ kind: 'cmd', cmd: 'm', args: ['run'], display: 'run', okCodes: [0, 2] }] }, { run: async () => ({ ok: false, code: 3, stdout: '', stderr: 'crash' }) });
    assert.equal(bad.ok, false);
  } finally { rm(out); }
});

test('advice: CI gaps, coverage and mutation thresholds, runs offered as fixes; report steps never ask to skip a failing test', async () => {
  const base = { testCases: 40, testFiles: 4, sourceFiles: 20, sourceLines: 3000, testLines: 900, inlineTests: 0, stacks: [{ id: 'python', name: 'Python', root: '.' }], byLang: { py: { testCases: 40 } },
    focused: [], skipped: [], noAssert: [], sleeps: [], network: [], untested: [{ path: 'a.py', lines: 300 }], untestedCount: 3, ruff: null,
    ci: { workflows: true, runs: { python: false } }, runnable: [{ stack: 'python', root: '.', name: 'Python', coverage: true, mutation: true }], results: { coverage: null, junit: null, mutation: null } };
  const ids = (t) => buildTestAdvice({ ...t, byLangFor: (id) => (id === 'python' ? 40 : 0) }).map((a) => a.id);
  assert.deepEqual(ids(base), ['t-ci', 't-untested', 't-coverage-none']);
  const now = new Date().toISOString();
  const withCov = { ...base, results: { coverage: { percent: 42, file: 'coverage.xml', date: now, lowest: [{ path: 'a.py', percent: 10 }] }, junit: { failed: 2, failures: ['t1', 't2'], file: 'j.xml', slowest: [{ name: 'slow', time: 9 }] }, mutation: { tool: 'mutmut', score: 40, killed: 4, survived: 6, examples: ['m1'] } } };
  const adv = buildTestAdvice({ ...withCov, byLangFor: () => 40 });
  assert.deepEqual(adv.map((a) => [a.id, a.severity]), [['t-ci', 'warn'], ['t-coverage', 'warn'], ['t-failing', 'error'], ['t-slow', 'info'], ['t-mutation', 'warn']], 'name-matching is dropped once real coverage exists');
  const fix = buildTestAdvice({ ...base, byLangFor: () => 40 }).find((a) => a.id === 't-coverage-none').fix;
  assert.deepEqual(fix, { type: 'tests-run', label: 'Run coverage…', kind: 'coverage', stack: 'python', root: '.' });
  assert.match(testsFix('t-failing').note, /Never delete or skip a failing test/);
  assert.equal(testsFix('t-coverage-none'), null);
  assert.match(testsSection({ ...withCov, untested: [] }), /Coverage: 42% of lines[\s\S]*Mutation testing \(mutmut\): score 40%/);
});

test('scanTests on a repo with no tests', async () => {
  const d = repo();
  try {
    for (let i = 0; i < 6; i++) put(d, `src/m${i}.py`, big(50));
    const t = await scanTests(d, { env: { GUTCHECK_DATA_DIR: tmp() } });
    assert.deepEqual(t.advice.map((a) => a.id), ['t-none']);
  } finally { rm(d); }
});
