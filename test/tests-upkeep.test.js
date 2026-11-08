const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { reviewTests } = require('../src/tests/review');
const { buildTestAdvice } = require('../src/tests');
const { testsFix } = require('../src/tests/report');
const { globRe } = require('../src/tests/unused');
const { testBodies } = require('../src/tests/consolidate');
const { reasonOf } = require('../src/tests/stale');

const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const repo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-up-'));
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) execFileSync('git', a, { cwd: d });
  return d;
};
// Commit everything as if it happened `days` ago.
const commit = (d, days, msg = 'c') => {
  const when = new Date(Date.now() - days * 86400000).toISOString();
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: d, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
};
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const ids = (t) => buildTestAdvice({ ...t, runnable: [], results: {}, byLangFor: () => 0 }).map((a) => a.id);

test('consolidate: near-identical tests, copies between files, repeated setup, tiny files for one module', async () => {
  const d = repo();
  try {
    put(d, 'package.json', JSON.stringify({ devDependencies: { vitest: '1' }, scripts: { test: 'vitest run' } }));
    const same = (label) => `it('${label}', () => {\n  const r = parse('${label}')\n  expect(r.kind).toBe('${label}')\n})\n`;
    put(d, 'src/parse.test.js', ['a', 'b', 'c'].map(same).join('\n') + "it('other', () => {\n  expect(parse('')).toBe(null)\n  expect(1).toBe(1)\n})\n");
    const body = '    client = make_client()\n    r = client.get("/a")\n    assert r.status == 200\n    assert r.json() == {}\n    assert r.headers\n    assert not r.cookies\n';
    put(d, 'tests/test_one.py', `def test_get():\n${body}`);
    put(d, 'tests/test_two.py', `def test_get_again():\n${body}`);
    const setup = (n) => `def test_s${n}(tmp_path):\n    cfg = load_config(tmp_path / "x")\n    cfg.save(tmp_path / "y")\n    app = App(cfg, debug=True)\n    assert app.run_${n}()\n`;
    put(d, 'tests/test_setup.py', [1, 2, 3, 4, 5].map(setup).join('\n'));
    put(d, 'src/cart.js', 'module.exports = {}\n');
    for (const n of ['add', 'remove', 'clear']) put(d, `src/cart.${n}.test.js`, `it('${n}', () => { expect(cart.${n}()).toBe(1) })\n`);
    const t = await reviewTests(d);
    assert.deepEqual(t.upkeep.duplicates.map((x) => [x.path, x.count]), [['src/parse.test.js', 3]]);
    assert.deepEqual(t.upkeep.copies.map((c) => c.map((x) => x.path).sort()), [['tests/test_one.py', 'tests/test_two.py']]);
    assert.deepEqual(t.upkeep.setup.map((x) => [x.path, x.count]), [['tests/test_setup.py', 5]]);
    assert.deepEqual(t.upkeep.tinyFiles.map((g) => [g.module, g.files.length]), [['cart', 3]]);
    for (const id of ['t-dup', 't-dup-copies', 't-setup', 't-tiny-files']) assert.ok(ids(t).includes(id), id);
  } finally { rm(d); }
});

test('stale: old skips and xfails, recent skips stay "skipped", tests untouched while the code changed', async () => {
  const d = repo();
  try {
    put(d, 'pyproject.toml', '[tool.pytest.ini_options]\n');
    put(d, 'tests/test_old.py', '@pytest.mark.skip\ndef test_off():\n    assert 1\n\n@pytest.mark.xfail\ndef test_x():\n    assert 0\n');
    put(d, 'calc.py', 'def f():\n    return 0\n');
    put(d, 'tests/test_calc.py', 'def test_f():\n    assert f() == 0\n');
    commit(d, 400);
    for (let i = 1; i <= 10; i++) { put(d, 'calc.py', `def f():\n    return ${i}\n`); commit(d, 300 - i); }
    put(d, 'tests/test_new.py', '@pytest.mark.skip\ndef test_later():\n    assert 1\n');
    commit(d, 2);
    const t = await reviewTests(d);
    assert.deepEqual(t.upkeep.oldMarkers.map((m) => `${m.path}:${m.line}:${m.kind}`).sort(), ['tests/test_old.py:1:skipped', 'tests/test_old.py:5:xfail']);
    assert.deepEqual(t.upkeep.drift.map((x) => [x.path, x.source, x.commits]), [['tests/test_calc.py', 'calc.py', 10]]);
    const advice = buildTestAdvice({ ...t, runnable: [], results: {}, byLangFor: () => 0 });
    assert.match(advice.find((a) => a.id === 't-stale-skip').detail, /test_old\.py:1 \(skipped 13 months, no reason\)/);
    assert.equal(advice.find((a) => a.id === 't-skipped').detail.split('.')[0], 'tests/test_new', 'only the recent skip is left under t-skipped');
    assert.ok(!advice.some((a) => a.id === 't-xfail'), 'an old xfail is listed once, as stale');
    assert.ok(advice.some((a) => a.id === 't-drift'));
  } finally { rm(d); }
});

test('unused: helper files, fixtures and Go helpers nobody uses; files the runner never collects; imports of deleted modules', async () => {
  const d = repo();
  try {
    put(d, 'package.json', JSON.stringify({ scripts: { test: 'node --test test/*.test.js' } }));
    put(d, 'test/a.test.js', "const test = require('node:test');\nconst { make } = require('./helpers/make');\nconst gone = require('../src/gone');\ntest('a', () => { assert.ok(make()) });\n");
    put(d, 'test/helpers/make.js', 'module.exports = { make: () => 1 };\n');
    put(d, 'test/helpers/forgotten.js', 'module.exports = { old: () => 1 };\n');
    put(d, 'test/sub/b.test.js', "const test = require('node:test');\ntest('b', () => { assert.ok(1) });\n");
    put(d, 'pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    put(d, 'app/__init__.py', '');
    put(d, 'tests/conftest.py', '@pytest.fixture\ndef used_db():\n    return 1\n\n@pytest.fixture\ndef lonely():\n    return 2\n\n@pytest.fixture(autouse=True)\ndef env():\n    yield\n');
    put(d, 'tests/test_db.py', 'from app.models import User\n\ndef test_db(used_db):\n    assert used_db\n');
    put(d, 'tests/checks_misc.py', 'def test_never_collected():\n    assert True\n');
    put(d, 'go.mod', 'module x\n');
    put(d, 'pkg/x_test.go', 'package pkg\nfunc helperUsed() int { return 1 }\nfunc helperDead() int { return 2 }\nfunc TestX(t *testing.T) { if helperUsed() != 1 { t.Fatal("x") } }\n');
    put(d, 'pkg/x_tests.go', 'package pkg\nimport "testing"\nfunc TestY(t *testing.T) { t.Fatal("x") }\n');
    put(d, 'Cargo.toml', '[package]\nname = "x"\n');
    put(d, 'tests/support/extra.rs', '#[test]\nfn lost() { assert!(true); }\n');
    const t = await reviewTests(d);
    const u = t.upkeep;
    assert.deepEqual(u.helpers.map((h) => h.path), ['test/helpers/forgotten.js']);
    assert.deepEqual(u.fixtures.map((f) => f.name), ['lonely'], 'used and autouse fixtures are fine');
    assert.deepEqual(u.goFuncs.map((f) => f.name), ['helperDead']);
    assert.deepEqual(u.notCollected.map((x) => x.path).sort(), ['pkg/x_tests.go', 'test/sub/b.test.js', 'tests/checks_misc.py', 'tests/support/extra.rs']);
    assert.deepEqual(u.missing.map((x) => x.target).sort(), ['../src/gone', 'app.models']);
    for (const id of ['t-unused-helper', 't-not-collected', 't-missing-target']) assert.ok(ids(t).includes(id), id);
  } finally { rm(d); }
});

test('legacy: deprecated APIs, mixed runners, orphaned and unreviewed snapshots', async () => {
  const d = repo();
  try {
    put(d, 'package.json', JSON.stringify({ devDependencies: { jest: '29' }, scripts: { test: 'jest' } }));
    put(d, 'src/a.test.js', "test('a', () => { expect(fn).toBeCalledWith(1) });\n");
    put(d, 'src/b.test.js', "const { test } = require('node:test');\ntest('b', () => { assert.ok(1) });\n");
    put(d, 'src/__snapshots__/a.test.js.snap', 'exports[`a 1`] = `x`;\n');
    put(d, 'src/__snapshots__/deleted.test.js.snap', 'exports[`a 1`] = `x`;\n');
    put(d, 'tests/test_old.py', 'import nose\nclass TestX(unittest.TestCase):\n    def test_a(self):\n        self.assertEquals(1, 1)\n');
    put(d, 'tests/__snapshots__/test_gone.ambr', '');
    put(d, 'go.mod', 'module x\n');
    put(d, 'm_test.go', 'package x\nimport "github.com/golang/mock/gomock"\nfunc TestM(t *testing.T) { t.Fatal() }\n');
    put(d, 'crate/tests/snapshots/x__y.snap.new', '');
    const t = await reviewTests(d);
    const u = t.upkeep;
    assert.deepEqual(u.legacy.map((l) => l.what).sort(), ['github.com/golang/mock (archived)', 'matcher aliases removed in Jest 30', 'nose', 'unittest aliases removed in Python 3.12']);
    assert.deepEqual(u.mixed.map((m) => m.runners.map((r) => r.name).sort()), [['jest', 'node:test']]);
    assert.deepEqual(u.orphanSnapshots.map((s) => s.path).sort(), ['src/__snapshots__/deleted.test.js.snap', 'tests/__snapshots__/test_gone.ambr']);
    assert.deepEqual(u.pendingSnapshots.map((s) => s.path), ['crate/tests/snapshots/x__y.snap.new']);
    const all = ids(t);
    for (const id of ['t-legacy-nose', 't-mixed-runners', 't-orphan-snapshot', 't-pending-snapshot']) assert.ok(all.includes(id), id);
  } finally { rm(d); }
});

test('every upkeep finding has a "Copy for LLM" step', () => {
  for (const id of ['t-not-collected', 't-missing-target', 't-stale-skip', 't-xfail', 't-drift', 't-dup', 't-dup-copies', 't-setup', 't-tiny-files', 't-unused-helper', 't-mixed-runners', 't-orphan-snapshot', 't-pending-snapshot', 't-legacy-nose']) {
    const s = testsFix(id);
    assert.ok(s && s.why && (s.note || s.cmds.length), id);
  }
});

test('helpers: globs, test bodies, skip reasons', () => {
  assert.ok(globRe('**/*.{test,spec}.?(c|m)[jt]s?(x)').test('a/b/x.test.tsx'));
  assert.ok(globRe('test/*.test.js').test('test/a.test.js'));
  assert.ok(!globRe('test/*.test.js').test('test/sub/a.test.js'));
  assert.ok(globRe('**/__tests__/**/*.[jt]s?(x)').test('__tests__/a.js'));
  const js = testBodies("test('x', async ({ page }) => {\n  await page.goto('')\n  expect(1).toBe(1)\n})\n", 'js');
  assert.deepEqual(js[0].lines, ["await page.goto('')", 'expect(0).toBe(0)']);
  assert.equal(testBodies('#[test]\nfn a() {\n    let x = 1;\n    assert_eq!(x, 1);\n}\n', 'rs')[0].lines.length, 2);
  assert.equal(testBodies('func TestA(t *testing.T) {\n\tx := 1\n\tif x != 1 { t.Fatal() }\n}\n', 'go')[0].lines.length, 2);
  assert.equal(reasonOf('@pytest.mark.skip(reason="Windows only")'), 'Windows only');
  assert.equal(reasonOf('\tt.Skip("needs docker")'), 'needs docker');
  assert.equal(reasonOf('it.skip(() => {})'), '');
});
