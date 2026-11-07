// Loads the real renderer (index.html + scripts, in the same order) into jsdom with a fake
// window.api, so view code can be tested without Electron.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();

const F = (id, severity, category, title, fix) => ({ id, severity, category, title, detail: '', fix });
const mk = (name, score, grade, findings, o = {}) => ({
  path: '/w/' + name, name, score, grade, findings, prs: [], ci: { failed: [] }, alerts: [], files: { license: true, readme: true },
  remote: { pushedAt: ago(3), url: 'https://github.com/me/' + name },
  git: { branch: 'main', dirty: 0, ahead: 0, behind: 0, branches: [{ name: 'main', current: true, date: ago(2) }], remoteBranches: [], mergedBranches: [] }, ...o,
});

const REPOS = [
  mk('alpha', 100, 'A', []),
  mk('beta', 82, 'B', [F('a', 'warn', 'Branches', '2 uncommitted changes'), F('b', 'info', 'Docs & Licence', 'Missing SECURITY.md')], { git: { branch: 'main', dirty: 2, ahead: 1, behind: 0, branches: [{ name: 'main', current: true, date: ago(2) }], remoteBranches: [], mergedBranches: [] } }),
  mk('gamma', 52, 'D', [F('c', 'error', 'CI', 'Failed: build on main'), F('d', 'error', 'Docs & Licence', 'Missing LICENSE')], { files: { license: false, readme: true }, ci: { failed: [{}] } }),
];

const CLUTTER = { ok: true, workspace: [{ id: 'ws', category: 'Workspace', severity: 'info', title: 'Loose files', detail: 'a.txt' }], repos: [
  { path: '/w/gamma', name: 'gamma', count: 2, totalSize: 2048, truncated: false, items: [
    { path: '.env.bak', name: '.env.bak', kind: 'file', category: 'env', reason: 'Identical to .env', confidence: 'high', size: 20, ageDays: 3, keep: '.env', ignored: false, mode: 'trash' },
    { path: 'coverage', name: 'coverage', kind: 'dir', category: 'test-artifact', reason: 'Test coverage report', confidence: 'medium', size: 2028, ageDays: 1, keep: null, ignored: false, mode: 'trash' }],
  advice: [{ id: 'env-not-ignored', category: 'Organisation', severity: 'error', title: '1 env file is not git-ignored', detail: '.env', fix: { type: 'gitignore-append', label: 'Add env rules to .gitignore', entries: ['.env'] } }] }] };

const QUALITY = { ok: true, settings: { maxLines: 400, locMode: 'total', ignore: [] }, repos: [
  { path: '/w/gamma', name: 'gamma', files: 12, lines: 2400, sourceFiles: 10, testFiles: 2, languages: [{ lang: 'JavaScript', files: 10, lines: 2000 }, { lang: 'Python', files: 2, lines: 400 }],
    loc: { max: 400, mode: 'total', overCount: 1, over: [{ path: 'src/big.js', lines: 950, code: 800, measured: 950, lang: 'JavaScript', test: false }], largest: [{ path: 'src/big.js', lines: 950, measured: 950 }, { path: 'src/small.js', lines: 120, measured: 120 }] },
    magic: { total: 30, denseFiles: 1, files: [{ path: 'src/big.js', count: 30, examples: [{ line: 12, value: '5000', text: 'setTimeout(f, 5000);' }] }], repeated: [{ value: 5000, count: 4, files: 2, uses: [{ path: 'src/big.js', line: 12 }] }], reuse: [{ value: 86400000, constant: 'DAY_MS', definedIn: 'src/c.js:1', count: 2, uses: [{ path: 'src/big.js', line: 40 }] }], constants: { files: [], definitions: 1 } },
    markers: { TODO: 2, FIXME: 1, HACK: 0, XXX: 0, total: 3, items: [{ path: 'src/big.js', line: 7, kind: 'TODO', text: 'tidy' }] },
    debug: [], debugCount: 0, secrets: [{ path: 'src/cfg.js', line: 3, kind: 'AWS access key' }], secretCount: 1, largeFiles: [], skipped: {}, truncated: false,
    advice: [{ id: 'q-secrets', category: 'Code quality', severity: 'error', title: '1 possible hardcoded secret', detail: 'src/cfg.js:3 (AWS access key)' }, { id: 'q-loc', category: 'Code quality', severity: 'warn', title: '1 file over 400 lines', detail: 'src/big.js (950)' }] },
] };

async function boot({ repos = REPOS, trend = [], settings = { root: '/w' }, clutter = CLUTTER, quality = QUALITY } = {}) {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///app/index.html' });
  const w = dom.window;
  const calls = [];
  let onRepo = () => {};
  w.api = {
    settings: async () => settings, rate: async () => null, authStatus: async () => ({ ok: true }), pickDir: async () => '/w',
    scan: async () => { repos.forEach((r, i) => onRepo({ res: r, done: i + 1, total: repos.length })); return { ok: true, count: repos.length }; },
    rescan: async () => ({ ok: false }),
    planActions: async (items) => { calls.push(['plan', items]); return items.map((i) => ({ ok: true, token: 't', repoName: 'gamma', title: 'Remove', risk: 'danger', display: [{ text: 'move to trash' }], warnings: [], undo: null, confirmName: 'gamma' })); },
    applyActions: async () => [], audit: async () => [], setSettings: async (p) => { calls.push(['settings', p]); return {}; }, openUrl: async () => {}, openFolder: async () => {},
    copyReport: async (d) => { calls.push(['copy', d]); return { ok: true, chars: 5000, repos: 1 }; },
    clutterScan: async (d) => { calls.push(['clutterScan', d]); return clutter; },
    trend: async () => trend,
    qualityScan: async (d) => { calls.push(['qualityScan', d]); return quality; },
    setQualitySettings: async (p) => { calls.push(['qualitySet', p]); return { ...quality.settings, ...p }; },
    background: async () => ({ launchOnStartup: false, minimizeToTray: true, closeToTray: false, trayAvailable: true, scheduleEnabled: false, scheduleHours: '24' }),
    setBackground: async (p) => { calls.push(['background', p]); return { launchOnStartup: !!p.launchOnStartup, minimizeToTray: true, closeToTray: false, trayAvailable: true }; },
    agents: async (allow) => { calls.push(['agents', allow]); const a = allow === undefined ? false : !!allow; return { allowActions: a, command: `/x/GutCheck.AppImage --mcp${a ? ' --allow-actions' : ''}`, clients: [
      { id: 'claude-code', name: 'Claude Code', kind: 'cli', installed: true, configured: false, file: null, docs: 'https://code.claude.com/docs/en/mcp', snippet: 'claude mcp add …' },
      { id: 'cursor', name: 'Cursor', kind: 'json', installed: false, configured: false, file: '/h/.cursor/mcp.json', docs: 'https://cursor.com/docs/context/mcp', snippet: '{}' }] }; },
    planAgent: async (id, allow, remove) => { calls.push(['planAgent', id, allow, remove]); return { ok: true, token: 'tk', title: 'Connect GutCheck to Claude Code', display: ['claude mcp add --transport stdio --scope user gutcheck -- /x --mcp'], preview: null, note: null, allowActions: allow }; },
    applyAgent: async (tok) => { calls.push(['applyAgent', tok]); return { ok: true, title: 'Connect', results: [{ text: 'claude mcp add', ok: true, out: '' }] }; },
    copyAgent: async (id, allow) => { calls.push(['copyAgent', id, allow]); return { ok: true }; },
    testsScan: async (d) => { calls.push(['testsScan', d]); return TESTS; },
    setIgnore: async (o) => { calls.push(['ignore', o]); return { ok: true }; }, drift: async () => ({ file: '/d/baseline.json', rules: null }), initBaseline: async () => ({ ok: true }), openBaseline: async () => {}, onDone: () => {},
    onBegin: () => {}, onRepo: (cb) => { onRepo = cb; },
  };
  const ctx = dom.getInternalVMContext();
  for (const f of ['metrics.js', 'app.js', 'modals.js', 'overview-view.js', 'clutter-view.js', 'quality-view.js', 'tests-view.js', 'dashboard.js', 'agents-view.js', 'policy-view.js']) new vm.Script(fs.readFileSync(path.join(DIR, f), 'utf8'), { filename: f }).runInContext(ctx);
  await tick();
  return { dom, w, doc: w.document, calls, $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)], run: (code) => new vm.Script(code).runInContext(ctx) };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const snap = (ts, avg, errors, scores = {}) => ({ ts, root: '/w', avg, errors, warns: 2, infos: 0, prs: 0, failingCI: 1, dirty: 1, ahead: 1, clutter: null, scores });

const TESTS = { ok: true, repos: [
  { path: '/w/gamma', name: 'gamma', testCases: 12, testFiles: 2, stacks: [{ id: 'python', name: 'Python', runner: 'pytest', root: '.' }], skipped: [], focused: [], untested: [], untestedCount: 0,
    runnable: [{ stack: 'python', root: '.', name: 'Python', coverage: true, mutation: true }],
    results: { coverage: { percent: 41, file: 'coverage.xml', date: '2026-11-01T00:00:00.000Z', lowest: [{ path: 'a.py', percent: 10, lines: 40 }] }, junit: null, mutation: null },
    advice: [{ id: 't-ci-none', category: 'Tests', severity: 'warn', title: 'No CI runs the 12 tests', detail: '' }, { id: 't-coverage', category: 'Tests', severity: 'warn', title: 'Line coverage 41%', detail: '', fix: { type: 'tests-run', label: 'Run coverage again…', kind: 'coverage', stack: 'python', root: '.' } }] },
  { path: '/w/alpha', name: 'alpha', testCases: 0, testFiles: 0, stacks: [], skipped: [], focused: [], untested: [], runnable: [], results: {}, advice: [{ id: 't-none', category: 'Tests', severity: 'warn', title: 'No tests', detail: '' }] }] };

module.exports = { boot, tick, snap, REPOS, CLUTTER };
