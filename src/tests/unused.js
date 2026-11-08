// Unused tests: test helpers and fixtures nothing references, test files the runner never collects,
// and tests whose imported module no longer exists. Reads files and configs only; nothing runs.

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('../exec');
const { COMMAND_TIMEOUT_MS } = require('../util');
const { readJson, readText } = require('./stack');

const MAX_KEPT = 30;
const TEST_DIR = /(^|\/)(?:tests?|__tests__|specs?|testing|testutils?|test_?helpers)\//;
// Data and conventions that are used by name or by folder, not by an import.
const DATA_DIR = /(^|\/)(?:fixtures?|__fixtures__|testdata|test-data|data|snapshots|__snapshots__|__mocks__|mocks|cassettes|golden|samples?|corpus)\//;
const CONFIG_NAME = /(^|\/)(?:conftest\.py|__init__\.py|__main__\.py|setup\w*\.[cm]?[jt]s|[\w.-]*\.config\.[cm]?[jt]s|global[-_]?(?:setup|teardown)\w*\.[cm]?[jt]s|jest\.\w+\.[cm]?[jt]s|vitest\.\w+\.[cm]?[jt]s|mocharc\.[cm]?js|\.mocharc\.[cm]?js|karma\.conf\.js|run_?tests?\.\w+|main\.go|noxfile\.py|tox\.ini)$/;
const ROOT_CONFIGS = ['package.json', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'tox.ini', 'Makefile', 'justfile', 'Cargo.toml', 'go.mod', '.mocharc.json', '.mocharc.yml', '.mocharc.js', 'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js', 'playwright.config.ts', 'playwright.config.js', 'vitest.workspace.ts'];

// Root configs, plus runner and package configs in sub-projects (web/vite.config.ts names setup files).
const NESTED_CONFIG = /(?:^|\/)(?:package\.json|pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|Cargo\.toml|[\w-]+\.config\.[cm]?[jt]s|vitest\.workspace\.[jt]s|\.mocharc\.\w+)$/;
function configText(dir, files = []) {
  let t = ROOT_CONFIGS.map((f) => readText(path.join(dir, f))).join('\n');
  for (const f of files.filter((x) => x.includes('/') && NESTED_CONFIG.test(x)).slice(0, 60)) t += '\n' + readText(path.join(dir, f)).slice(0, 100000);
  try { for (const f of fs.readdirSync(path.join(dir, '.github', 'workflows'))) t += readText(path.join(dir, '.github', 'workflows', f)); } catch {}
  return t;
}

// Helper files (code in a test folder with no test cases) and pytest fixtures and Go test helpers
// that nothing else names. `kept`: [{ rel, lang, cases, text }] for every code file in a test folder.
function unusedHelpers(kept, cfg) {
  const helpers = [];
  const fixtures = [];
  const goFuncs = [];
  const hay = (self) => kept.filter((k) => k.rel !== self).map((k) => k.text).join('\n') + '\n' + cfg;
  const word = (w) => new RegExp(`(?<![\\w$])${w.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
  // Only in a test folder that holds tests: src/tests/ full of scanner code is not a helper folder.
  const rootOf = (rel) => { const m = TEST_DIR.exec(rel); return m ? rel.slice(0, m.index + m[0].length) : null; };
  const testRoots = new Set(kept.filter((k) => k.cases).map((k) => rootOf(k.rel)).filter(Boolean));
  for (const k of kept) {
    if (k.cases || !TEST_DIR.test(k.rel) || !testRoots.has(rootOf(k.rel)) || DATA_DIR.test(k.rel) || CONFIG_NAME.test(k.rel) || !['js', 'py'].includes(k.lang)) continue;
    let name = path.basename(k.rel).replace(/\.[^.]+$/, '');
    if (name === 'index') name = path.basename(path.dirname(k.rel));
    if (name.length < 3 || /^(?:d|types?|globals?)$/.test(name) || k.rel.endsWith('.d.ts')) continue;
    if (!word(name).test(hay(k.rel))) helpers.push({ path: k.rel });
  }
  // pytest fixtures: used as a parameter name, in usefixtures("name"), or by another fixture.
  const py = kept.filter((k) => k.lang === 'py');
  const pyText = py.map((k) => k.text).join('\n');
  for (const k of py) {
    const re = /@pytest\.fixture\b(\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
    let m;
    while ((m = re.exec(k.text))) {
      const args = m[1] || '';
      if (/autouse\s*=\s*True|name\s*=/.test(args) || /^pytest_/.test(m[2])) continue;
      if ((pyText.match(word(m[2])) || []).length <= 1) fixtures.push({ path: k.rel, line: k.text.slice(0, m.index).split('\n').length, name: m[2] });
    }
  }
  // Go: a plain function in a _test.go file that no _test.go file in the same package calls.
  const goByDir = new Map();
  for (const k of kept) if (k.lang === 'go' && k.rel.endsWith('_test.go')) (goByDir.get(path.dirname(k.rel)) || goByDir.set(path.dirname(k.rel), []).get(path.dirname(k.rel))).push(k);
  for (const files of goByDir.values()) {
    const text = files.map((f) => f.code).join('\n');
    for (const f of files) {
      const re = /^func\s+(\w+)\s*(?:\[[^\]]*\])?\s*\(/gm;
      let m;
      while ((m = re.exec(f.code))) {
        if (/^(?:Test|Benchmark|Example|Fuzz)/.test(m[1]) || m[1] === 'init') continue;
        if ((text.match(word(m[1])) || []).length <= 1) goFuncs.push({ path: f.rel, line: f.code.slice(0, m.index).split('\n').length, name: m[1] });
      }
    }
  }
  return { helpers: helpers.slice(0, MAX_KEPT), fixtures: fixtures.slice(0, MAX_KEPT), goFuncs: goFuncs.slice(0, MAX_KEPT) };
}

// A glob as a regex over repo-relative paths: **, *, ?, {a,b}, [..], ?(x), +(x), @(x).
function globRe(g) {
  const s = g.replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') { i++; if (s[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; }
    else if (c === '*') out += '[^/]*';
    else if ('?+@'.includes(c) && s[i + 1] === '(') { const end = s.indexOf(')', i); out += `(?:${s.slice(i + 2, end).split('|').map((p) => globRe(p).source.slice(1, -1)).join('|')})${c === '?' ? '?' : c === '+' ? '+' : ''}`; i = end; }
    else if (c === '?') out += '[^/]';
    else if (c === '{') { const end = s.indexOf('}', i); out += `(?:${s.slice(i + 1, end).split(',').map((p) => globRe(p).source.slice(1, -1)).join('|')})`; i = end; }
    else if (c === '[') { const end = s.indexOf(']', i); out += s.slice(i, end + 1); i = end; }
    else out += esc(c);
  }
  return new RegExp(`^${out}$`);
}
const esc = (x) => x.replace(/[.+^${}()|\\]/g, '\\$&');

const DEFAULTS = {
  node: ['**/*.test.{js,cjs,mjs,ts,cts,mts}', '**/*-test.{js,cjs,mjs,ts}', '**/*_test.{js,cjs,mjs,ts}', '**/test-*.{js,cjs,mjs,ts}', '**/test.{js,cjs,mjs,ts}', '**/test/**/*.{js,cjs,mjs,ts}'],
  vitest: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  jest: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
  mocha: ['test/*.{js,cjs,mjs}'],
};

// The patterns the JS runner collects, from its config or script when they are plain enough to read.
function jsPatterns(dir, runner) {
  const pkg = readJson(path.join(dir, 'package.json')) || {};
  const script = String((pkg.scripts && pkg.scripts.test) || '');
  const strings = (t) => [...t.matchAll(/["'`]([^"'`\s]+)["'`]/g)].map((m) => m[1]);
  if (runner === 'node') {
    const m = /^\s*node\s+((?:--[\w-]+(?:=\S+)?\s+)*)--test((?:\s+--[\w-]+(?:=\S+)?)*)((?:\s+[^\s&|;-][^\s&|;]*)*)\s*$/.exec(script);
    if (!m) return null; // more than one command, or flags we cannot read: do not guess
    const args = m[3].trim().split(/\s+/).filter(Boolean).map((a) => a.replace(/^['"]|['"]$/g, ''));
    if (!args.length) return DEFAULTS.node.map(globRe);
    return args.map((a) => (/[*?{[]/.test(a) ? globRe(a) : fs.existsSync(path.join(dir, a)) && fs.statSync(path.join(dir, a)).isDirectory() ? globRe(`${a.replace(/\/$/, '')}/**/*.{js,cjs,mjs,ts}`) : globRe(a)));
  }
  // A config file, project, root or folder chosen on the command line: the defaults do not apply.
  if (runner !== 'node' && /(?:^|\s)(?:--config|-c|--project|--projects|--dir|--root|--rootDir|--roots|--workspace|--testPathPattern|--selectProjects)\b/.test(script)) return null;
  if (runner === 'jest') {
    const tm = pkg.jest && (pkg.jest.testMatch || pkg.jest.testRegex);
    if (Array.isArray(tm) && tm.every((x) => typeof x === 'string')) return pkg.jest.testMatch ? tm.map((g) => globRe(g.replace(/^<rootDir>\//, ''))) : null;
    const cfg = ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs'].map((f) => readText(path.join(dir, f))).join('');
    if (/testMatch|testRegex|roots\s*:|projects\s*:/.test(cfg) || pkg.jest) return null;
    return DEFAULTS.jest.map(globRe);
  }
  if (runner === 'vitest') {
    const cfg = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js', 'vite.config.mts'].map((f) => readText(path.join(dir, f))).join('');
    if (/workspace|projects\s*:|dir\s*:|root\s*:/.test(cfg) || ['ts', 'js', 'mts', 'mjs', 'json'].some((e) => fs.existsSync(path.join(dir, `vitest.workspace.${e}`)))) return null;
    const inc = /\binclude\s*:\s*\[([^\]]*)\]/.exec(cfg);
    return inc ? strings(inc[1]).map(globRe) : DEFAULTS.vitest.map(globRe);
  }
  if (runner === 'mocha') {
    if (/--recursive|--spec|\btest\/\S|\.mocharc/.test(script) || ['.mocharc.json', '.mocharc.yml', '.mocharc.yaml', '.mocharc.js', '.mocharc.cjs'].some((f) => fs.existsSync(path.join(dir, f)))) return null;
    const args = script.replace(/^\s*mocha\s*/, '').trim();
    return args && !/[&|;]/.test(args) && !args.startsWith('-') ? args.split(/\s+/).map(globRe) : DEFAULTS.mocha.map(globRe);
  }
  return null;
}

// pytest: testpaths and python_files from pytest.ini, pyproject.toml, setup.cfg or tox.ini.
function pytestConfig(dir) {
  const ini = readText(path.join(dir, 'pytest.ini')) + readText(path.join(dir, 'tox.ini')) + readText(path.join(dir, 'setup.cfg'));
  const toml = readText(path.join(dir, 'pyproject.toml'));
  const sec = (/\[tool\.pytest\.ini_options\]([\s\S]*?)(?:\n\[|$)/.exec(toml) || [])[1] || (/\[(?:pytest|tool:pytest)\]([\s\S]*?)(?:\n\[|$)/.exec(ini) || [])[1] || '';
  const val = (k) => { const m = new RegExp(`^\\s*${k}\\s*=\\s*(\\[[^\\]]*\\]|.*)$`, 'm').exec(sec); return m ? (m[1].match(/[^\s"',[\]]+/g) || []) : null; };
  return { testpaths: val('testpaths'), files: val('python_files') || ['test_*.py', '*_test.py'] };
}

// A JS file that is a test for this runner: it imports a test framework, or (for runners with
// globals) calls describe/it/test with an assertion. Code that merely lives in a tests/ folder is not.
const FRAMEWORK_IMPORT = /(?:from\s+|require\s*\(\s*)['"](?:node:test|vitest|@jest\/globals|mocha|ava|tap|tape|uvu|bun:test)['"]/;
function looksLikeJsTest(c, runner) {
  if (FRAMEWORK_IMPORT.test(c.text)) return true;
  return runner !== 'node' && /(?:^|[^.\w])(?:describe|it|test)\s*\(/.test(c.code) && /\bexpect\s*\(|\bassert\b/.test(c.code);
}

// Test files nothing collects: JS outside the runner's patterns, Python test modules pytest's
// python_files or testpaths skip, Go tests in files not named _test.go, Rust test files under tests/
// in a folder no `mod` line includes.
function notCollected(dir, { stacks, candidates, nested }) {
  const out = [];
  const node = stacks.find((s) => s.id === 'node');
  const pats = node && node.runner && jsPatterns(dir, node.runner);
  const e2e = /@playwright\/test|['"]cypress['"]|\bcy\.\w+\(|from ['"]@?(?:wdio|detox|puppeteer)/;
  for (const c of candidates) {
    if (out.length >= MAX_KEPT || !c.cases || nested.some((n) => c.rel.startsWith(n + '/'))) continue;
    if (c.lang === 'js' && pats && c.isTest && looksLikeJsTest(c, node.runner) && !e2e.test(c.text) && !/(^|\/)(?:e2e|cypress|playwright)\//.test(c.rel) && !pats.some((re) => re.test(c.rel))) out.push({ path: c.rel, why: `the ${node.runner} test command does not match it` });
    if (c.lang === 'go' && !c.rel.endsWith('_test.go') && /\*testing\.T\)/.test(c.code)) out.push({ path: c.rel, why: 'go test only compiles files ending in _test.go' });
    if (c.lang === 'rs' && /(^|\/)tests\/[^/]+\/[^/]+\.rs$/.test(c.rel) && !/\/main\.rs$/.test(c.rel)) {
      const mod = path.basename(c.rel, '.rs') === 'mod' ? path.basename(path.dirname(c.rel)) : path.basename(c.rel, '.rs');
      const inc = new RegExp(`\\bmod\\s+${mod}\\b|#\\[path\\s*=\\s*"[^"]*${mod}`);
      if (!candidates.some((o) => o.lang === 'rs' && o.rel !== c.rel && inc.test(o.text))) out.push({ path: c.rel, why: 'cargo only builds tests/*.rs; no mod line includes this file' });
    }
  }
  const py = stacks.find((s) => s.id === 'python');
  if (py && py.runner === 'pytest') {
    const cfg = pytestConfig(dir);
    const nameRes = cfg.files.map((g) => globRe(g));
    for (const c of candidates) {
      if (out.length >= MAX_KEPT || c.lang !== 'py' || !c.cases || !TEST_DIR.test(c.rel) || DATA_DIR.test(c.rel) || /(^|\/)conftest\.py$/.test(c.rel)) continue;
      if (!nameRes.some((re) => re.test(path.basename(c.rel)))) out.push({ path: c.rel, why: `pytest only collects ${cfg.files.join(' / ')}` });
      else if (cfg.testpaths && !cfg.testpaths.some((p) => c.rel === p || c.rel.startsWith(p.replace(/\/$/, '') + '/'))) out.push({ path: c.rel, why: `outside testpaths (${cfg.testpaths.join(', ')})` });
    }
  }
  return out;
}

const JS_EXT = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json', '.node', '.vue', '.svelte'];
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// Imports in test files that point at a local module that is no longer there.
async function missingTargets(dir, tests) {
  const out = [];
  const ignored = async (rel) => (await git(['check-ignore', '-q', '--', rel], { cwd: dir, timeout: COMMAND_TIMEOUT_MS })).ok;
  for (const f of tests) {
    if (out.length >= MAX_KEPT) break;
    if (f.lang === 'js') {
      const re = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\b(?:vi|jest)\.mock\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"?#]+)\1/gm;
      for (const m of f.text.matchAll(re)) {
        const target = path.join(path.dirname(f.rel), m[2]);
        const abs = path.join(dir, target);
        const base = abs.replace(/\.(?:[cm]?js|jsx)$/, '');
        if (JS_EXT.some((e) => exists(abs + e) || exists(base + e) || exists(path.join(abs, 'index' + e)))) continue;
        const parent = path.dirname(target);
        if (!exists(path.join(dir, parent)) && (await ignored(target))) continue; // build output not built yet
        if (/(^|\/)(?:dist|build|out|lib|target|generated|gen|\.next)(\/|$)/.test(target)) continue;
        out.push({ path: f.rel, line: f.text.slice(0, m.index).split('\n').length, target: m[2] });
      }
    } else if (f.lang === 'py') {
      const re = /^\s*(?:from\s+(\.*[\w.]*)\s+import\b|import\s+([\w.]+))/gm;
      for (const m of f.code.matchAll(re)) {
        const mod = m[1] != null ? m[1] : m[2];
        if (!mod || mod === '__future__' || /^\.+$/.test(mod)) continue;
        const rel = mod.startsWith('.');
        const parts = mod.replace(/^\.+/, '').split('.');
        let roots;
        if (rel) { let d = path.dirname(f.rel); for (let i = 1; i < mod.match(/^\.+/)[0].length; i++) d = path.dirname(d); roots = [d]; }
        else { roots = ['.', 'src', 'lib']; for (let d = path.dirname(f.rel); d && d !== '.'; d = path.dirname(d)) roots.push(d); }
        const isMod = (r, ps) => { const p = path.join(dir, r, ...ps); return exists(p + '.py') || exists(p + '.pyi') || exists(path.join(p, '__init__.py')) || (exists(p) && fs.statSync(p).isDirectory()) || (exists(path.dirname(p)) && fs.readdirSync(path.dirname(p)).some((n) => n.startsWith(path.basename(p) + '.') && /\.(?:so|pyd|pyx)$/.test(n))); };
        const local = rel ? roots : roots.filter((r) => isMod(r, parts.slice(0, 1)));
        if (!local.length || local.some((r) => isMod(r, parts))) continue;
        out.push({ path: f.rel, line: f.code.slice(0, m.index).split('\n').length, target: mod });
      }
    }
  }
  return out.slice(0, MAX_KEPT);
}

module.exports = { unusedHelpers, notCollected, missingTargets, globRe, jsPatterns, pytestConfig, configText, TEST_DIR, DATA_DIR };
