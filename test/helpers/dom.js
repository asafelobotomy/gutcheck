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

async function boot({ repos = REPOS, trend = [], settings = { root: '/w' }, clutter = CLUTTER } = {}) {
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
    onBegin: () => {}, onRepo: (cb) => { onRepo = cb; },
  };
  const ctx = dom.getInternalVMContext();
  for (const f of ['metrics.js', 'app.js', 'clutter-view.js', 'dashboard.js']) new vm.Script(fs.readFileSync(path.join(DIR, f), 'utf8'), { filename: f }).runInContext(ctx);
  await tick();
  return { dom, w, doc: w.document, calls, $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)], run: (code) => new vm.Script(code).runInContext(ctx) };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const snap = (ts, avg, errors, scores = {}) => ({ ts, root: '/w', avg, errors, warns: 2, infos: 0, prs: 0, failingCI: 1, dirty: 1, ahead: 1, clutter: null, scores });

module.exports = { boot, tick, snap, REPOS, CLUTTER };
