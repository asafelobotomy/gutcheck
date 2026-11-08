// Legacy tests: deprecated or removed test APIs and frameworks, more than one unit-test runner in
// one project, and snapshot files left behind by tests that are gone (or never reviewed). Matches
// code with strings and comments blanked, except where the import path is the evidence. Read-only.

const path = require('node:path');
const { readText } = require('./stack');

const MAX_KEPT = 30;

// [lang, regex on code (strings blanked) or raw text, what it is, what replaces it, only for this runner?]
const APIS = [
  ['py', /^\s*(?:import\s+nose\b|from\s+nose(?:\.\w+)*\s+import\b)/m, 'nose', 'pytest (nose is unmaintained and fails on Python 3.12)', null, 'code'],
  ['py', /\bself\.(?:assertEquals|assertNotEquals|assertAlmostEquals|assertNotAlmostEquals|assert_|failUnless\w*|failIf\w*|assertRegexpMatches|assertNotRegexpMatches|assertRaisesRegexp|assertDictContainsSubset)\s*\(/, 'unittest aliases removed in Python 3.12', 'assertEqual, assertTrue, assertRegex, assertRaisesRegex', null, 'code'],
  ['py', /@pytest\.yield_fixture\b/, '@pytest.yield_fixture', '@pytest.fixture (it supports yield)', null, 'code'],
  ['py', /\bpytest\.warns\s*\(\s*None\s*\)/, 'pytest.warns(None)', 'warnings.catch_warnings() or pytest.warns(Warning)', null, 'code'],
  ['py', /^class\s+Test\w*[\s\S]*?^\s+def\s+(?:setup|teardown)\s*\(\s*self\s*\)/m, 'nose-style setup()/teardown() methods', 'setup_method / teardown_method or a fixture (removed in pytest 8)', null, 'code'],
  ['js', /\.(?:toBeCalled|toBeCalledTimes|toBeCalledWith|lastCalledWith|nthCalledWith|toReturn|toReturnTimes|toReturnWith|lastReturnedWith|nthReturnedWith|toThrowError)\s*\(/, 'matcher aliases removed in Jest 30', 'toHaveBeenCalled*, toHaveReturned*, toThrow', 'jest', 'code'],
  ['js', /\bjest\.genMockFromModule\s*\(/, 'jest.genMockFromModule', 'jest.createMockFromModule', 'jest', 'code'],
  ['js', /\bjasmine\.\w+/, 'jasmine globals', 'jest.fn / jest.spyOn (jest-circus has no jasmine)', 'jest', 'code'],
  ['js', /(?:from\s+|require\s*\(\s*)['"]enzyme(?:-adapter[\w-]*)?['"]/, 'Enzyme', 'React Testing Library (Enzyme has no React 18 adapter)', null, 'text'],
  ['js', /(?:from\s+|require\s*\(\s*)['"]@testing-library\/react-hooks['"]/, '@testing-library/react-hooks', 'renderHook from @testing-library/react', null, 'text'],
  ['js', /(?:from\s+|require\s*\(\s*)['"]react-test-renderer(?:\/[\w-]+)?['"]/, 'react-test-renderer (deprecated in React 19)', 'React Testing Library', null, 'text'],
  ['go', /"github\.com\/golang\/mock\//, 'github.com/golang/mock (archived)', 'go.uber.org/mock', null, 'text'],
  ['rs', /^\s*#!\[feature\(test\)\]|^\s*extern\s+crate\s+test\s*;/m, 'nightly-only libtest benchmarks (#[bench])', 'criterion or divan on stable Rust', null, 'code'],
];

function legacyApis(tests, stacks, dir) {
  const runner = (stacks.find((s) => s.id === 'node') || {}).runner;
  const hits = new Map();
  for (const f of tests) {
    for (const [lang, re, what, instead, only, src] of APIS) {
      if (lang !== f.lang || (only && only !== runner)) continue;
      const t = src === 'text' ? f.text : f.code;
      const m = re.exec(t);
      if (!m) continue;
      const h = hits.get(what) || hits.set(what, { what, instead, files: [] }).get(what);
      if (h.files.length < MAX_KEPT) h.files.push({ path: f.rel, line: t.slice(0, m.index + m[0].search(/\S/)).split('\n').length });
    }
  }
  // Rust: the tempdir crate (deprecated, merged into tempfile) in dev-dependencies.
  const cargo = readText(path.join(dir, 'Cargo.toml'));
  if (/^\s*tempdir\s*=/m.test(cargo)) hits.set('tempdir crate', { what: 'tempdir crate (deprecated)', instead: 'tempfile::tempdir()', files: [{ path: 'Cargo.toml' }] });
  return [...hits.values()];
}

// Which unit-test framework each JS test file uses: by import, else the configured runner's globals.
const JS_FW = [
  ['vitest', /(?:from\s+|require\s*\(\s*)['"]vitest['"]/],
  ['node:test', /(?:from\s+|require\s*\(\s*)['"](?:node:)?test['"]/],
  ['jest', /(?:from\s+|require\s*\(\s*)['"]@jest\/globals['"]/],
  ['mocha', /(?:from\s+|require\s*\(\s*)['"]mocha['"]/],
  ['ava', /(?:from\s+|require\s*\(\s*)['"]ava['"]/],
  ['tap', /(?:from\s+|require\s*\(\s*)['"]tap['"]/],
  ['tape', /(?:from\s+|require\s*\(\s*)['"]tape['"]/],
  ['uvu', /(?:from\s+|require\s*\(\s*)['"]uvu(?:\/assert)?['"]/],
  ['bun:test', /(?:from\s+|require\s*\(\s*)['"]bun:test['"]/],
];
const E2E = /@playwright\/test|['"]cypress['"]|\bcy\.\w+\(|(?:^|\/)(?:e2e|cypress|playwright)\//;

function mixedRunners(tests, stacks, nested) {
  const runner = (stacks.find((s) => s.id === 'node') || {}).runner;
  const globalsFw = { jest: 'jest', vitest: 'vitest', mocha: 'mocha' }[runner];
  const js = {};
  for (const f of tests) {
    if (f.lang !== 'js' || !f.cases || E2E.test(f.text) || E2E.test(f.rel) || nested.some((n) => f.rel.startsWith(n + '/'))) continue;
    const fw = (JS_FW.find(([, re]) => re.test(f.text)) || [globalsFw])[0];
    if (fw) (js[fw] || (js[fw] = [])).push(f.rel);
  }
  const out = [];
  if (Object.keys(js).length >= 2) out.push({ lang: 'JavaScript/TypeScript', runners: Object.entries(js).sort((a, b) => b[1].length - a[1].length).map(([name, files]) => ({ name, count: files.length, example: files[0] })) });
  // Python: nose next to pytest (pytest runs unittest classes, so TestCase is not a second runner).
  const nose = tests.filter((f) => f.lang === 'py' && /^\s*(?:import|from)\s+nose\b/m.test(f.code));
  const py = tests.filter((f) => f.lang === 'py' && f.cases);
  if (nose.length && nose.length < py.length) out.push({ lang: 'Python', runners: [{ name: 'pytest', count: py.length - nose.length, example: py.find((f) => !nose.includes(f)).rel }, { name: 'nose', count: nose.length, example: nose[0].rel }] });
  return out;
}

// Snapshot files whose test file is gone: Jest/Vitest __snapshots__/x.test.js.snap, syrupy
// __snapshots__/test_x.ambr, snapshottest snapshots/snap_test_x.py; and insta snapshots never reviewed.
function orphanSnapshots(files) {
  const set = new Set(files);
  const orphans = [];
  const pending = [];
  for (const f of files) {
    const d = path.dirname(path.dirname(f));
    const join = (n) => (d === '.' ? n : `${d}/${n}`);
    let m;
    if ((m = /(?:^|\/)__snapshots__\/([^/]+)\.snap$/.exec(f))) { if (!set.has(join(m[1]))) orphans.push({ path: f, test: join(m[1]) }); }
    else if ((m = /(?:^|\/)__snapshots__\/([^/]+)\.ambr$/.exec(f))) { if (!set.has(join(m[1] + '.py'))) orphans.push({ path: f, test: join(m[1] + '.py') }); }
    else if ((m = /(?:^|\/)snapshots\/snap_([^/]+\.py)$/.exec(f))) { if (!set.has(join(m[1]))) orphans.push({ path: f, test: join(m[1]) }); }
    else if (/\.snap\.new$|\.pending-snap$/.test(f)) pending.push({ path: f });
  }
  return { orphans: orphans.slice(0, MAX_KEPT), pending: pending.slice(0, MAX_KEPT) };
}

module.exports = { legacyApis, mixedRunners, orphanSnapshots, APIS };
