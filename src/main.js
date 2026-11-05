const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { discover, scanRepo, scanAll } = require('./scanner');
const { execute, describe, NEEDS_CONFIRM } = require('./actions');
const { run } = require('./exec');

let win;
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

ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('auth:status', async () => {
  const r = await run('gh', ['auth', 'status']);
  return { ok: r.ok, text: (r.stdout + r.stderr).trim() };
});

ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('scan:start', async (_e, { root, deep }) => {
  if (typeof root !== 'string' || !fs.existsSync(root)) return { ok: false, error: 'Folder does not exist' };
  saveSettings({ ...loadSettings(), root, deep: !!deep });
  const dirs = discover(root);
  known.clear();
  win.webContents.send('scan:begin', { total: dirs.length });
  const results = await scanAll(dirs, { deep }, (res, done, total) => {
    known.set(res.path, res);
    win.webContents.send('scan:repo', { res, done, total });
  });
  return { ok: true, count: results.length };
});

ipcMain.handle('scan:one', async (_e, { dir, deep }) => {
  if (!known.has(dir)) return { ok: false, error: 'Unknown repo' };
  const res = await scanRepo(dir, { deep });
  known.set(dir, res);
  return { ok: true, res };
});

ipcMain.handle('action:run', async (_e, { dir, action }) => {
  const repo = known.get(dir);
  if (!repo) return { ok: false, stderr: 'Unknown repo' };
  if (!action || typeof action.type !== 'string') return { ok: false, stderr: 'Bad action' };
  if (NEEDS_CONFIRM.has(action.type)) {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Proceed'], defaultId: 0, cancelId: 0, message: describe(action, repo.name) });
    if (r.response !== 1) return { ok: false, stderr: 'Cancelled', cancelled: true };
  }
  return execute(dir, repo, action);
});

ipcMain.handle('open:url', (_e, url) => openExternal(url));
ipcMain.handle('open:folder', (_e, dir) => { if (known.has(dir)) shell.openPath(dir); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
