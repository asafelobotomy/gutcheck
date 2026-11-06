// Layer 1: read a repo's tests without running anything. Counts test cases per language (including
// Rust tests written inside source files), finds switched-off and focused tests, test files without
// any assertion, sleeps and live network calls in tests, source files no test is named after, and
// whether CI runs the tests at all. Read-only and static, like every other scan.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { git, run } = require('../exec');
const { COMMAND_TIMEOUT_MS } = require('../util');
const R = require('../quality/rules');
const { detectStacks, CI_TEST_RE, GENERIC_TEST_RE } = require('./stack');

const MAX_FILES = 8000;
const MAX_READ = 512 * 1024;
const MAX_KEPT = 30;

// Per language: what a test case, a switched-off test, a focused test, an assertion and a sleep look like.
const LANG = {
  js: { exts: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts'],
    test: /(?:^|[^.\w])(?:it|test)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))*\s*\(/g,
    skip: /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|(?:^|[^.\w])x(?:it|describe|test)\s*\(/g,
    only: /\b(?:it|test|describe)\.only\s*\(|(?:^|[^.\w])f(?:it|describe)\s*\(/g,
    assert: /\bassert\b|\bexpect\s*\(|\.should\b|\bt\.(?:is|true|false|deepEqual|throws|pass)\b/,
    sleep: /\bawait\s+(?:sleep|delay|wait|setTimeoutP?)\s*\(\s*\d{3,}|new Promise\s*\(\s*\(?\w*\)?\s*=>\s*setTimeout\s*\([^)]*,\s*\d{3,}/g },
  py: { exts: ['py'],
    test: /^\s*(?:async\s+)?def\s+test\w*\s*\(/gm,
    skip: /@(?:pytest\.mark\.(?:skip|xfail)|unittest\.skip\w*)\b/g,
    only: null,
    assert: /\bassert\b|pytest\.raises|self\.assert\w+\(|\.assert_\w+\(/,
    sleep: /\btime\.sleep\s*\(\s*(?:[1-9]|0\.[1-9])/g },
  rs: { exts: ['rs'],
    test: /#\[(?:tokio::|async_std::)?test\b[^\]]*\]/g,
    skip: /#\[ignore\b/g,
    only: null,
    assert: /\bassert(?:_eq|_ne|_matches)?!|\.unwrap\(\)|\.expect\(|panic!|\?;/,
    sleep: /(?:thread|tokio::time|async_std::task)::sleep\s*\(/g },
  go: { exts: ['go'],
    test: /^func\s+Test\w*\s*\(\s*\w+\s+\*testing\.T\)/gm,
    skip: /\bt\.Skip(?:f|Now)?\s*\(/g,
    only: null,
    assert: /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\b(?:assert|require)\.\w+\(/,
    sleep: /\btime\.Sleep\s*\(/g },
  kt: { exts: ['kt', 'java'],
    test: /@Test\b/g,
    skip: /@(?:Ignore|Disabled)\b/g,
    only: null,
    assert: /\bassert\w*\s*\(|\bexpect\w*\s*\(|\bshould\w*\b|\bverify\s*[({]/,
    sleep: /\b(?:Thread\.sleep|delay)\s*\(\s*\d{3,}/g },
  sh: { exts: ['sh', 'bats', 'bash'],
    test: /^\s*@test\s|^\s*(?:function\s+)?test_\w+\s*\(\)/gm,
    skip: /^\s*skip\b/gm,
    only: null,
    assert: /\bassert\w*|\[\[.*\]\]|\[ .* \]|\|\|\s*(?:fail|exit 1|return 1)|\bfail\b/,
    sleep: /^\s*sleep\s+[1-9]/gm },
};
const LANG_BY_EXT = Object.fromEntries(Object.entries(LANG).flatMap(([k, v]) => v.exts.map((e) => [e, k])));
const HELPER_ASSERT = /\b\w*(?:assert|check|verify|expect|ensure|must)\w*\s*[(!]/i;
const SMOKE_NAME = /\b(?:fn|def|func|it|test)\s*\(?\s*['"`]?\w*(?:does_?not_?panic|no_?panic|does_?not_?crash|doesnt_?crash|smoke)\w*/i;
const NETWORK_RE = /\b(?:fetch|axios\.\w+|requests\.\w+|httpx\.\w+|urllib\.request\.urlopen|reqwest::\w+|http\.Get|http\.Post)\s*\(\s*["'`]https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|example\.(?:com|org))/;

const count = (re, text) => (re ? (text.match(re) || []).length : 0);
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const stem = (rel) => path.basename(rel).replace(/\.[^.]+$/, '').replace(/^test_|_test$|\.(test|spec)$|_spec$|Test$|Tests$/, '').toLowerCase();
const isTestPath = (rel) => R.TEST_RE.test(rel) || /(^|\/)tests\/[^/]+\.rs$|(^|\/)tests?\.rs$|Tests?\.(kt|java)$|(^|\/)test_[^/]+\.sh$|\.bats$/.test(rel) || /(^|\/)src\/(test|androidTest)\//.test(rel);
const NOT_A_MODULE = /(^|\/)(main|index|__init__|mod|lib|setup|conftest|build)\.\w+$|(^|\/)_?(archive|legacy|vendor|third_party)\//;

async function listFiles(dir) {
  const r = await git(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, timeout: COMMAND_TIMEOUT_MS });
  return r.stdout.split('\0').filter(Boolean).filter((rel) => !rel.split('/').slice(0, -1).some((s) => R.SKIP_SEGMENTS.has(s)) && !R.SKIP_FILE_RE.test(rel));
}

// Workflow files, read as text: which stacks' tests does CI run?
function ciCoverage(dir, stacks) {
  let text = '';
  const wf = path.join(dir, '.github', 'workflows');
  try { for (const f of fs.readdirSync(wf)) if (/\.ya?ml$/.test(f)) text += fs.readFileSync(path.join(wf, f), 'utf8').slice(0, 200000) + '\n'; } catch {}
  if (!text) return { workflows: false, runs: {} };
  const generic = GENERIC_TEST_RE.test(text);
  return { workflows: true, runs: Object.fromEntries(stacks.map((s) => [s.id, CI_TEST_RE[s.id] ? CI_TEST_RE[s.id].test(text) || generic : generic])) };
}

// ruff's flake8-pytest-style rules (PT), only when ruff is installed. ruff reads code, it never runs it.
async function ruffPytest(dir, testFiles) {
  const py = testFiles.filter((f) => f.endsWith('.py')).slice(0, 2000);
  if (!py.length) return null;
  const r = await run('ruff', ['check', '--isolated', '--no-cache', '--select', 'PT', '--output-format', 'json', '--exit-zero', '--', ...py], { cwd: dir, timeout: COMMAND_TIMEOUT_MS });
  if (!r.ok) return null; // not installed, or failed: optional
  try {
    const items = JSON.parse(r.stdout || '[]');
    const byRule = {};
    for (const i of items) byRule[i.code] = (byRule[i.code] || 0) + 1;
    return { total: items.length, byRule, items: items.slice(0, MAX_KEPT).map((i) => ({ path: path.relative(dir, i.filename), line: i.location && i.location.row, rule: i.code, message: String(i.message).slice(0, 120) })) };
  } catch { return null; }
}

async function reviewTests(dir) {
  const stacks = detectStacks(dir);
  const files = (await listFiles(dir)).slice(0, MAX_FILES);
  const byLang = {};
  const out = { stacks, testFiles: 0, testCases: 0, inlineTests: 0, sourceFiles: 0, testLines: 0, sourceLines: 0, skipped: [], focused: [], noAssert: [], sleeps: [], network: [], untested: [], byLang };
  const testStems = new Set();
  const sources = [];
  for (const rel of files) {
    const ext = path.extname(rel).slice(1).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;
    let text;
    try { const st = await fsp.stat(path.join(dir, rel)); if (st.size > MAX_READ) continue; text = await fsp.readFile(path.join(dir, rel), 'utf8'); } catch { continue; }
    if (text.includes('\0') || R.GENERATED_RE.test(text.slice(0, 600))) continue;
    const L = LANG[lang];
    const lines = text.split('\n').length;
    const isTest = isTestPath(rel);
    const cases = count(L.test, text);
    const inline = lang === 'rs' && !isTest && /#\[cfg\(test\)\]/.test(text) ? cases : 0;
    const b = byLang[lang] || (byLang[lang] = { testFiles: 0, testCases: 0, sourceFiles: 0 });
    if (!isTest && !inline) { out.sourceFiles++; out.sourceLines += lines; b.sourceFiles++; sources.push({ rel, lines, lang }); continue; }
    if (isTest) { out.testFiles++; out.testLines += lines; b.testFiles++; testStems.add(stem(rel)); } else {
      // Rust: the #[cfg(test)] module at the end of a source file is test code, the rest is source.
      const testPart = text.slice(text.indexOf('#[cfg(test)]')).split('\n').length;
      out.inlineTests += inline; out.sourceFiles++; out.sourceLines += lines - testPart; out.testLines += testPart; b.sourceFiles++; testStems.add(stem(rel));
    }
    out.testCases += cases; b.testCases += cases;
    if (!cases) continue;
    const at = (re, list, kind) => { if (!re) return; re.lastIndex = 0; let m; while ((m = re.exec(text)) && list.length < MAX_KEPT) list.push({ path: rel, line: lineOf(text, m.index), kind }); };
    at(L.skip, out.skipped, 'skipped');
    at(L.only, out.focused, 'focused');
    at(L.sleep, out.sleeps, 'sleep');
    const body = isTest ? text : text.slice(text.indexOf('#[cfg(test)]'));
    // Project helpers count as assertions (check(...), verify_x(...), expectOk(...)), and so do tests
    // whose names say they only check that nothing crashes.
    if (!L.assert.test(body) && !HELPER_ASSERT.test(body) && !SMOKE_NAME.test(body) && out.noAssert.length < MAX_KEPT) out.noAssert.push({ path: rel, cases });
    const net = NETWORK_RE.exec(text);
    if (net && out.network.length < MAX_KEPT) out.network.push({ path: rel, line: lineOf(text, net.index) });
  }
  // Source files no test file is named after (and, for Rust, without inline tests). Largest first.
  out.untested = sources.filter((s) => !testStems.has(stem(s.rel)) && !NOT_A_MODULE.test(s.rel) && s.lines >= 40)
    .sort((a, b) => b.lines - a.lines).slice(0, 12).map((s) => ({ path: s.rel, lines: s.lines }));
  out.untestedCount = sources.filter((s) => !testStems.has(stem(s.rel)) && !NOT_A_MODULE.test(s.rel)).length;
  // Stacks known only from the tests themselves (no manifest at the root): Python and shell test suites.
  const ids = new Set(stacks.map((s) => s.id));
  if (!ids.has('python') && (byLang.py || {}).testCases) stacks.push({ id: 'python', name: 'Python', root: '.', runner: files.some((f) => /(^|\/)conftest\.py$/.test(f)) ? 'pytest' : 'pytest', venv: null, pytestCov: false, inferred: true });
  if ((byLang.sh || {}).testCases || files.some((f) => f.endsWith('.bats'))) stacks.push({ id: 'shell', name: 'Shell', root: '.', runner: files.some((f) => f.endsWith('.bats')) ? 'bats' : 'script', inferred: true });
  out.ci = ciCoverage(dir, stacks);
  out.ruff = await ruffPytest(dir, files.filter(isTestPath));
  return out;
}

module.exports = { reviewTests, LANG, isTestPath, stem, ciCoverage };
