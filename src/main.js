const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { discover, scanRepo, scanAll } = require('./scanner');
const github = require('./github');
const actions = require('./actions');
const crypto = require('node:crypto');
const { run } = require('./exec');

let win;
let scanning = false;
const RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html');
// Only our own bundled page may call privileged IPC.
const trusted = (e) => {
  try {
    const u = new URL(e.senderFrame.url);
    return u.protocol === 'file:' && path.normalize(decodeURIComponent(u.pathname)) === RENDERER_FILE;
  } catch {
    return false;
  }
};
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Untrusted sender');
    return fn(e, ...args);
  });
}
const known = new Map(); // path -> latest scan result (only these paths may be acted on)
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadSettings = () => {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
};
const saveSettings = (s) => fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0f1115', title: 'GutCheck',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function openExternal(url) {
  if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
}

handle('settings:get', () => loadSettings());

handle('auth:status', async () => {
  const r = await run('gh', ['auth', 'status']);
  return { ok: r.ok }; // never forward gh's output (account, scopes) to the renderer
});

handle('rate:get', () => github.refreshRate());

handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('scan:start', async (_e, { root, deep }) => {
  if (typeof root !== 'string' || !fs.existsSync(root)) return { ok: false, error: 'Folder does not exist' };
  if (scanning) return { ok: false, error: 'A scan is already running' };
  scanning = true;
  try {
    saveSettings({ ...loadSettings(), root, deep: !!deep });
    const dirs = discover(root);
    known.clear();
    win.webContents.send('scan:begin', { total: dirs.length });
    const results = await scanAll(dirs, { deep: !!deep }, (res, done, total) => {
      known.set(res.path, res);
      win.webContents.send('scan:repo', { res, done, total });
    });
    return { ok: true, count: results.length, rate: github.getRate() };
  } finally {
    scanning = false;
  }
});

handle('scan:one', async (_e, { dir, deep }) => {
  if (!known.has(dir)) return { ok: false, error: 'Unknown repo' };
  const res = await scanRepo(dir, { deep: !!deep });
  known.set(dir, res);
  return { ok: true, res, rate: github.getRate() };
});

// ---- Actions: plan -> user confirms -> apply the stored plan (never renderer-supplied steps) ----
const plans = new Map(); // token -> { plan, expires }
const busy = new Set(); // repo paths with an action in flight
const PLAN_TTL = 5 * 60 * 1000;
const auditFile = () => path.join(app.getPath('userData'), 'audit.log');

function audit(entry) {
  try { fs.appendFileSync(auditFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

const publicPlan = (token, p) => ({ ok: true, token, type: p.type, repoPath: p.repoPath, repoName: p.repoName, title: p.title, risk: p.risk, display: p.display, warnings: p.warnings, undo: p.undo, body: p.body, note: p.note, confirmName: p.confirmName });

handle('action:plan', async (_e, { items }) => {
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) return [{ ok: false, error: 'Bad request' }];
  const readOnly = !!loadSettings().readOnly;
  const out = [];
  for (const it of items) {
    const repo = it && known.get(it.dir);
    const p = await actions.plan(repo, it && it.action, { readOnly });
    if (!p.ok) { out.push({ ...p, repoName: repo && repo.name }); continue; }
    const token = crypto.randomBytes(16).toString('hex');
    plans.set(token, { plan: p, expires: Date.now() + PLAN_TTL });
    out.push(publicPlan(token, p));
  }
  for (const [t, v] of plans) if (v.expires < Date.now()) plans.delete(t);
  return out;
});

handle('action:apply', async (_e, { tokens }) => {
  if (!Array.isArray(tokens)) return [];
  const out = [];
  for (const token of tokens) {
    const entry = plans.get(token);
    plans.delete(token); // single use
    if (!entry || entry.expires < Date.now()) { out.push({ ok: false, error: 'Plan expired. Please review it again.' }); continue; }
    const p = entry.plan;
    if (loadSettings().readOnly) { out.push({ ok: false, repoName: p.repoName, error: 'Read-only mode is on.' }); continue; }
    if (busy.has(p.repoPath)) { out.push({ ok: false, repoName: p.repoName, error: 'Another action is running on this repo.' }); continue; }
    busy.add(p.repoPath);
    try {
      const r = await actions.apply(p);
      audit({ repo: p.repoName, path: p.repoPath, action: p.type, risk: p.risk, title: p.title, ok: r.ok, steps: r.results.map((x) => ({ cmd: x.text, ok: x.ok })) });
      let res = null;
      try { res = await scanRepo(p.repoPath, { deep: false }); known.set(p.repoPath, res); } catch {}
      out.push({ ok: r.ok, repoName: p.repoName, title: p.title, results: r.results, res, rate: github.getRate() });
    } finally {
      busy.delete(p.repoPath);
    }
  }
  return out;
});

handle('audit:list', () => {
  try {
    return fs.readFileSync(auditFile(), 'utf8').trim().split('\n').filter(Boolean).slice(-200).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
});

handle('settings:set', (_e, patch) => {
  const s = loadSettings();
  if (patch && typeof patch.readOnly === 'boolean') s.readOnly = patch.readOnly;
  saveSettings(s);
  return s;
});

handle('open:url', (_e, url) => openExternal(url));
handle('open:folder', (_e, dir) => { if (known.has(dir)) shell.openPath(dir); });

// Defence in depth: the app loads only its own bundled page, so deny every permission request,
// all webviews and all new windows.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
