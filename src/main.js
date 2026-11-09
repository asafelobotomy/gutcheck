const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { scanRepo } = require('./scanner');
const github = require('./github');
const { createService } = require('./service');
const { appendAudit, readAudit } = require('./audit');
const { run } = require('./exec');
const { createTrayController } = require('./tray');
const { setAutostart, isAutostart, HIDDEN_FLAG } = require('./autostart');
const { createSettingsStore } = require('./settings');
const { createAgentConnect } = require('./agent-connect');
const { createPolicyStore, driftReport, inactiveIgnores } = require('./policy');
const sched = require('./schedule');
const { createWorkspaceScanner } = require('./workspace-scan');
const { dataDir } = require('./paths');
const { createSecretsCtl } = require('./secrets-ctl');
const { registerIpc: registerSecretsIpc } = require('./secrets-glue');

// The CLI and MCP server find the data folder through paths.js (GUTCHECK_DATA_DIR first); the app
// uses the same one, so all three share settings, ignores and History.
if (app.setPath) app.setPath('userData', dataDir());

let win;
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
const policy = () => createPolicyStore(app.getPath('userData')); // ignores.json and baseline.json
const seen = () => sched.createSeenStore(path.join(app.getPath('userData'), 'seen.json'));
const policyNow = () => policy().load();

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
handle('app:version', () => app.getVersion());

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

// One workspace scan, shared with the CLI and MCP (workspace-scan.js). Results stream to the window if it exists.
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
let ws = null; // made once the service exists, below

handle('scan:start', async (_e, { root, deep } = {}) => {
  const r = ws.resolveRoot(root);
  if (r.error) return { ok: false, error: 'Folder does not exist' };
  if (ws.busy()) return { ok: false, error: 'A scan is already running' };
  updateSettings({ root: r.root, deep: !!deep });
  const out = await ws.scan({ root: r.root, deep: !!deep });
  if (out.ok) updateSettings({ lastScanAt: Date.now() });
  return out;
});

// Scheduled scans: every few minutes, check whether one is due; notify only about new warnings and
// errors. A scan never starts while a change is waiting in an open review: it would expire the plans.
async function scheduledScan() {
  const s = loadSettings();
  if (ws.busy() || service.hasPlans() || !s.root || !isDir(s.root) || !sched.isDue(Date.now(), s.lastScanAt, sched.normalizeSchedule(s.schedule))) return;
  let out = { ok: false, error: 'Scheduled scan failed' };
  try {
    out = await ws.scan({ root: s.root, deep: !!s.deep, recordSeen: true });
    if (out.ok) updateSettings({ lastScanAt: Date.now() });
  } catch (e) {
    out = { ok: false, error: 'Scheduled scan failed: ' + ((e && e.message) || e) };
  } finally {
    send('scan:done', out); // the window hides its progress bar whatever happened
  }
  const n = sched.notification(out.fresh || []);
  if (n && Notification.isSupported()) {
    const note = new Notification({ title: n.title, body: n.body, icon: path.join(__dirname, 'assets', 'icon.png') });
    note.on('click', () => { if (win) { win.show(); win.focus(); } });
    note.show();
  }
}

handle('scan:one', async (_e, { dir, deep } = {}) => {
  if (!known.has(dir)) return { ok: false, error: 'Unknown repo' };
  const g = ws.generation();
  const res = await scanRepo(dir, { deep: !!deep, policy: policyNow });
  if (g !== ws.generation() || !known.has(dir)) return { ok: false, error: 'The workspace was rescanned meanwhile' };
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
const rescan = async (dir) => (await ws.refresh(dir)) || known.get(dir); // same depth as the scan it came from
// Secret files and their password-manager backup: the only code that runs a vault CLI (secrets-ctl.js).
const secretsCtl = createSecretsCtl({ dataDir: app.getPath('userData'), settings: { load: loadSettings, update: updateSettings }, audit: (e) => audit({ ...e, via: 'app' }) });
const service = createService({ known, settings: loadSettings, audit, trash: (f) => shell.trashItem(f), clipboard, rescan, trendStore, updateSettings, secretsCtl });
ws = createWorkspaceScanner({ known, service, policy: policyNow, seen: seen(), onBegin: (total) => send('scan:begin', { total }), onRepo: (res, done, total) => send('scan:repo', { res, done, total }) });

handle('action:plan', (_e, { items } = {}) => service.planActions(items));
// confirm: { token: the repo name the user typed } for each dangerous plan; the service checks it.
handle('action:apply', (_e, { tokens, confirm } = {}) => service.applyActions(tokens, { confirm: confirm && typeof confirm === 'object' ? confirm : {} }));
handle('clutter:scan', (_e, { dirs } = {}) => service.clutterScan(dirs));
handle('trend:get', () => service.trend());
handle('quality:scan', (_e, { dirs } = {}) => service.qualityScan(dirs));
handle('tests:scan', (_e, { dirs } = {}) => service.testsScan(dirs));
handle('quality:set', (_e, patch) => service.setQualitySettings(patch));
handle('report:copy', (_e, { dir } = {}) => service.copyReport(dir));
registerSecretsIpc(handle, service.secrets, () => !!loadSettings().readOnly); // secrets:scan, tools, link, test, plan, apply, verify, skip

handle('audit:list', () => readAudit(auditFile()));

// Ignores (with a reason) and the baseline: GutCheck's own data, not the repos. Each change is logged.
const rescanKnown = (dir) => ws.refresh(dir); // null if the workspace was rescanned meanwhile
handle('ignore:set', async (_e, { dir, id, reason, remove, allRepos } = {}) => {
  if (loadSettings().readOnly) return { ok: false, error: 'Read-only mode is on.' };
  const r = known.get(dir);
  if (!r && !allRepos) return { ok: false, error: 'Unknown repo' };
  const key = allRepos ? '*' : r.ignoreKey;
  const res = remove ? policy().removeIgnore(key, String(id || '')) : policy().setIgnore(key, String(id || ''), reason, 'app');
  if (!res.ok) return res;
  audit({ ok: true, repo: allRepos ? 'all repos' : r.name, title: `${remove ? 'Stopped ignoring' : 'Ignored'} ${id}${remove ? '' : `: ${res.reason}`}`, via: 'app' });
  if (allRepos) { await ws.refreshAll(); return { ok: true, all: true, repos: [...known.values()] }; }
  return { ok: true, res: await rescanKnown(dir) };
});
handle('drift:get', () => { const p = policyNow(); const b = p.baseline; return { file: policy().baselineFile, rules: b ? driftReport([...known.values()], b) : null, inactive: inactiveIgnores(p.ignores) }; });
handle('baseline:init', async () => {
  if (loadSettings().readOnly) return { ok: false, error: 'Read-only mode is on.' };
  const i = policy().initBaseline();
  await ws.refreshAll(); // every repo's drift changes
  return { ...i, repos: [...known.values()] };
});
handle('baseline:open', () => { const f = policy().baselineFile; if (fs.existsSync(f)) shell.openPath(f); });

handle('settings:set', (_e, patch) => updateSettings(patch && typeof patch.readOnly === 'boolean' ? { readOnly: patch.readOnly } : {}));

// Startup and tray options. Only booleans are accepted; launch-on-start-up is stored by the OS/desktop.
const background = (s = loadSettings()) => { const sc = sched.normalizeSchedule(s.schedule); return { launchOnStartup: isAutostart(app, { dir: autostartDir() }), minimizeToTray: !!s.minimizeToTray, closeToTray: !!s.closeToTray, trayAvailable: trayCtl.hasTray(), scheduleEnabled: sc.enabled, scheduleHours: String(sc.hours) }; };
handle('background:get', () => background());
handle('background:set', (_e, patch) => {
  const p = patch && typeof patch === 'object' ? patch : {};
  const patchSched = typeof p.scheduleEnabled === 'boolean' || p.scheduleHours != null ? { schedule: sched.normalizeSchedule({ ...sched.normalizeSchedule(loadSettings().schedule), ...(typeof p.scheduleEnabled === 'boolean' ? { enabled: p.scheduleEnabled } : {}), ...(p.scheduleHours != null ? { hours: Number(p.scheduleHours) } : {}) }) } : {};
  const s = updateSettings({ ...Object.fromEntries(BACKGROUND_KEYS.filter((k) => typeof p[k] === 'boolean').map((k) => [k, p[k]])), ...patchSched });
  let error = null;
  if (typeof p.launchOnStartup === 'boolean') {
    try { setAutostart(app, p.launchOnStartup, { dir: autostartDir() }); } catch (e) { error = 'Could not change the login item: ' + (e && e.message); }
  }
  return { ...background(s), error };
});

// Settings > AI agents: connect GutCheck's MCP server to installed coding agents (plan, review, apply).
const agents = createAgentConnect({ launch: { env: process.env, execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath(), dataDir: app.getPath('userData'), version: app.getVersion() }, audit, trash: (f) => shell.trashItem(f) });
const agentAllow = (v) => (typeof v === 'boolean' ? v : !!loadSettings().agentAllowActions);
handle('agents:status', (_e, { allowActions } = {}) => ({ ...agents.status(agentAllow(allowActions)), allowActions: agentAllow(allowActions) }));
// The "allow actions" choice is saved when the user connects (agents:apply), not while reviewing.
const pendingAllow = new Map(); // agent plan token -> the allowActions it was planned with
handle('agents:plan', (_e, { id, allowActions, remove } = {}) => {
  if (loadSettings().readOnly) return { ok: false, error: 'Read-only mode is on.' };
  const p = agents.plan(String(id || ''), { allowActions: agentAllow(allowActions), remove: remove === true });
  if (p && p.ok && p.token && typeof allowActions === 'boolean') pendingAllow.set(p.token, allowActions);
  return p;
});
handle('agents:cleanup', (_e, { days } = {}) => (loadSettings().readOnly ? { ok: false, error: 'Read-only mode is on.' } : agents.planCleanup(Number(days))));
// Permission rules of a scanned repo: shapes and hashes only. One value is returned on request, for the
// app's own review dialog; it is never logged, saved, or sent anywhere else.
const localRules = (dir) => { try { const c = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')); return c && c.permissions && Array.isArray(c.permissions.allow) ? c.permissions.allow.filter((x) => typeof x === 'string') : []; } catch { return []; } };
handle('agents:rules', (_e, { dir } = {}) => (known.has(dir) ? { ok: true, rules: localRules(dir).map(require('./agent-context').classifyRule) } : { ok: false, error: 'Unknown repo' }));
handle('agents:reveal-rule', (_e, { dir, hash } = {}) => {
  if (!known.has(dir)) return { ok: false, error: 'Unknown repo' };
  const v = localRules(dir).find((x) => require('./agent-context').hashRule(x) === hash);
  return v == null ? { ok: false, error: 'That rule is no longer in the file.' } : { ok: true, value: v };
});
handle('agents:fix', (_e, { fix } = {}) => (loadSettings().readOnly ? { ok: false, error: 'Read-only mode is on.' } : agents.planFix(fix && typeof fix === 'object' ? fix : {}, [...known.values()].filter((r) => !r.error))));
handle('agents:usage', (_e, { live } = {}) => agents.usageScan({ live: live === true && !loadSettings().readOnly, repos: [...known.values()].filter((r) => !r.error).map((r) => ({ path: r.path, name: r.name })) }));
handle('agents:apply', async (_e, { token } = {}) => {
  if (loadSettings().readOnly) return { ok: false, error: 'Read-only mode is on.' };
  const t = String(token || '');
  const allow = pendingAllow.get(t);
  pendingAllow.delete(t);
  const r = await agents.apply(t);
  if (r && r.ok && typeof allow === 'boolean') updateSettings({ agentAllowActions: allow });
  return r;
});
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
    setInterval(() => { scheduledScan().catch(() => {}); }, sched.CHECK_EVERY_MS).unref();
  });
  app.on('window-all-closed', () => app.quit());
}
