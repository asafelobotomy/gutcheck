const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { discover, scanRepo, scanAll } = require('./scanner');
const github = require('./github');
const { createService } = require('./service');
const { appendAudit, readAudit } = require('./audit');
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
    service.recordScan(root, results);
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

// ---- Actions, clutter and report logic lives in service.js (testable without Electron) ----
const auditFile = () => path.join(app.getPath('userData'), 'audit.log');
const audit = (entry) => appendAudit(auditFile(), entry);
const trendFile = () => path.join(app.getPath('userData'), 'trend.json');
const trendStore = {
  read: () => JSON.parse(fs.readFileSync(trendFile(), 'utf8')),
  write: (a) => { const f = trendFile(); fs.writeFileSync(f + '.tmp', JSON.stringify(a)); fs.renameSync(f + '.tmp', f); },
};
const updateSettings = (patch) => { const s = { ...loadSettings(), ...patch }; saveSettings(s); return s; };
const service = createService({ known, settings: loadSettings, audit, trash: (f) => shell.trashItem(f), clipboard, trendStore, updateSettings });

handle('action:plan', (_e, { items }) => service.planActions(items));
handle('action:apply', (_e, { tokens }) => service.applyActions(tokens));
handle('clutter:scan', (_e, { dirs } = {}) => service.clutterScan(dirs));
handle('trend:get', () => service.trend());
handle('quality:scan', (_e, { dirs } = {}) => service.qualityScan(dirs));
handle('quality:settings', () => service.qualitySettings());
handle('quality:set', (_e, patch) => service.setQualitySettings(patch));
handle('report:copy', (_e, { dir } = {}) => service.copyReport(dir));

handle('audit:list', () => readAudit(auditFile()));

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
