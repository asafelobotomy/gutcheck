const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { discover, scanRepo, scanAll } = require('./scanner');
const github = require('./github');
const { createService } = require('./service');
const { appendAudit, readAudit } = require('./audit');
const { run } = require('./exec');
const { expandHome } = require('./util');
const { createTrayController } = require('./tray');
const { setAutostart, isAutostart, HIDDEN_FLAG } = require('./autostart');
const { createSettingsStore } = require('./settings');
const { createAgentConnect } = require('./agent-connect');

let win;
let scanning = false;
const RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html');
// Only our own bundled page may call privileged IPC. fileURLToPath also handles Windows drive letters.
const trusted = (e) => {
  try {
    return fileURLToPath(e.senderFrame.url) === RENDERER_FILE;
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
const store = () => createSettingsStore(path.join(app.getPath('userData'), 'settings.json'));
const loadSettings = () => store().load();
const updateSettings = (patch) => store().update(patch); // every settings write goes through here

const trayCtl = createTrayController({ app, Tray, Menu, nativeImage, getWindow: () => win, getSettings: () => loadSettings() });
const autostartDir = () => path.join(app.getPath('appData'), 'autostart');
const BACKGROUND_KEYS = ['minimizeToTray', 'closeToTray'];

function createWindow() {
  // Started by the login item (--hidden) and a tray icon exists: stay in the tray until clicked.
  const startHidden = process.argv.includes(HIDDEN_FLAG) && trayCtl.hasTray();
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#0f1115', title: 'GutCheck', icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  trayCtl.attach(win);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.loadFile(RENDERER_FILE);
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Only GitHub pages and the agents' own MCP docs (linked from Settings > AI agents) open externally.
const AGENT_DOCS = new Set(require('./agent-connect').clients().map((c) => c.docs));
function openExternal(url) {
  if (/^https:\/\/github\.com\//.test(url) || AGENT_DOCS.has(url)) shell.openExternal(url);
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

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

handle('scan:start', async (_e, { root, deep } = {}) => {
  if (typeof root !== 'string' || !root.trim()) return { ok: false, error: 'Folder does not exist' };
  root = expandHome(root.trim(), os.homedir());
  if (!isDir(root)) return { ok: false, error: 'Folder does not exist' };
  if (scanning) return { ok: false, error: 'A scan is already running' };
  scanning = true;
  try {
    updateSettings({ root, deep: !!deep });
    const dirs = discover(root);
    known.clear();
    service.forgetPlans(); // plans reviewed for the previous workspace can no longer run
    win.webContents.send('scan:begin', { total: dirs.length });
    const results = await scanAll(dirs, { deep: !!deep }, (res, done, total) => {
      known.set(res.path, res);
      win.webContents.send('scan:repo', { res, done, total });
    });
    service.recordScan(root, results);
    return { ok: true, root, count: results.length, rate: github.getRate() };
  } finally {
    scanning = false;
  }
});

handle('scan:one', async (_e, { dir, deep } = {}) => {
  if (!known.has(dir)) return { ok: false, error: 'Unknown repo' };
  const res = await scanRepo(dir, { deep: !!deep });
  if (!known.has(dir)) return { ok: false, error: 'The workspace was rescanned meanwhile' };
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
const rescan = (dir) => scanRepo(dir, { deep: !!loadSettings().deep }); // keep deep findings after an action
const service = createService({ known, settings: loadSettings, audit, trash: (f) => shell.trashItem(f), clipboard, rescan, trendStore, updateSettings });

handle('action:plan', (_e, { items } = {}) => service.planActions(items));
handle('action:apply', (_e, { tokens } = {}) => service.applyActions(tokens));
handle('clutter:scan', (_e, { dirs } = {}) => service.clutterScan(dirs));
handle('trend:get', () => service.trend());
handle('quality:scan', (_e, { dirs } = {}) => service.qualityScan(dirs));
handle('quality:set', (_e, patch) => service.setQualitySettings(patch));
handle('report:copy', (_e, { dir } = {}) => service.copyReport(dir));

handle('audit:list', () => readAudit(auditFile()));

handle('settings:set', (_e, patch) => updateSettings(patch && typeof patch.readOnly === 'boolean' ? { readOnly: patch.readOnly } : {}));

// Startup and tray options. Only booleans are accepted; launch-on-start-up is stored by the OS/desktop.
const background = (s = loadSettings()) => ({ launchOnStartup: isAutostart(app, { dir: autostartDir() }), minimizeToTray: !!s.minimizeToTray, closeToTray: !!s.closeToTray, trayAvailable: trayCtl.hasTray() });
handle('background:get', () => background());
handle('background:set', (_e, patch) => {
  const p = patch && typeof patch === 'object' ? patch : {};
  const s = updateSettings(Object.fromEntries(BACKGROUND_KEYS.filter((k) => typeof p[k] === 'boolean').map((k) => [k, p[k]])));
  let error = null;
  if (typeof p.launchOnStartup === 'boolean') {
    try { setAutostart(app, p.launchOnStartup, { dir: autostartDir() }); } catch (e) { error = 'Could not change the login item: ' + (e && e.message); }
  }
  return { ...background(s), error };
});

// Settings > AI agents: connect GutCheck's MCP server to installed coding agents (plan, review, apply).
const agents = createAgentConnect({ launch: { env: process.env, execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath() }, audit });
const agentAllow = (v) => (typeof v === 'boolean' ? v : !!loadSettings().agentAllowActions);
handle('agents:status', (_e, { allowActions } = {}) => ({ ...agents.status(agentAllow(allowActions)), allowActions: agentAllow(allowActions) }));
handle('agents:plan', (_e, { id, allowActions, remove } = {}) => {
  if (typeof allowActions === 'boolean') updateSettings({ agentAllowActions: allowActions });
  if (loadSettings().readOnly) return { ok: false, error: 'Read-only mode is on.' };
  return agents.plan(String(id || ''), { allowActions: agentAllow(allowActions), remove: remove === true });
});
handle('agents:cleanup', (_e, { days } = {}) => (loadSettings().readOnly ? { ok: false, error: 'Read-only mode is on.' } : agents.planCleanup(Number(days))));
handle('agents:apply', (_e, { token } = {}) => (loadSettings().readOnly ? { ok: false, error: 'Read-only mode is on.' } : agents.apply(String(token || ''))));
handle('agents:copy', (_e, { id, allowActions } = {}) => {
  const c = agents.status(agentAllow(allowActions)).clients.find((x) => x.id === id);
  if (!c) return { ok: false };
  clipboard.writeText(c.snippet);
  return { ok: true };
});

handle('open:url', (_e, url) => openExternal(url));
handle('open:folder', (_e, dir) => { if (known.has(dir)) shell.openPath(dir); });

// One running copy: a second launch only wakes the first one (singleInstance quits this process).
if (trayCtl.singleInstance()) {
  // Defence in depth: the app loads only its own bundled page, so deny every permission request,
  // all webviews and all new windows.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    // A moved or updated AppImage: point the login entry at the copy that is running now.
    try { if (app.isPackaged && isAutostart(app, { dir: autostartDir() })) setAutostart(app, true, { dir: autostartDir() }); } catch {}
    trayCtl.create();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
