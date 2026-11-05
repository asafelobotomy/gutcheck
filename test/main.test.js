// Loads src/main.js with a fake `electron` and checks the IPC wiring: sender trust, input checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

function load() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-main-'));
  const handlers = new Map();
  const opened = [];
  const noop = () => {};
  const electron = {
    app: { getPath: () => userData, whenReady: () => ({ then: noop }), on: noop, requestSingleInstanceLock: () => true, isPackaged: true, getAppPath: () => '/app', getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: noop },
    BrowserWindow: function () {}, session: {}, dialog: {}, clipboard: { writeText: noop },
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    shell: { openExternal: (u) => opened.push(['url', u]), openPath: (p) => opened.push(['path', p]), trashItem: async () => {} },
  };
  const orig = Module._load;
  Module._load = function (req, ...a) { return req === 'electron' ? electron : orig.call(this, req, ...a); };
  const file = require.resolve('../src/main.js');
  delete require.cache[file];
  try { require(file); } finally { Module._load = orig; }
  const page = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href;
  const call = (ch, arg, url = page) => handlers.get(ch)({ senderFrame: { url } }, arg);
  return { handlers, call, opened, userData };
}

test('every IPC channel is registered', () => {
  const { handlers } = load();
  for (const c of ['settings:get', 'settings:set', 'auth:status', 'rate:get', 'dir:pick', 'scan:start', 'scan:one', 'action:plan', 'action:apply', 'clutter:scan', 'report:copy', 'trend:get', 'quality:scan', 'quality:set', 'audit:list', 'background:get', 'background:set', 'open:url', 'open:folder']) assert.ok(handlers.has(c), c);
});

test('quality settings round-trip through IPC with validation', async () => {
  const { call } = load();
  assert.equal((await call('quality:set', { maxLines: 650, locMode: 'code', ignore: ['legacy/'] })).maxLines, 650);
  assert.deepEqual((await call('settings:get')).quality, { maxLines: 650, locMode: 'code', ignore: ['legacy/'] });
  assert.equal((await call('quality:set', { maxLines: -4 })).maxLines, 650, 'an invalid value keeps the current one');
  assert.equal((await call('quality:set', 'junk')).maxLines, 650);
  assert.equal((await call('quality:scan', {})).ok, false); // nothing scanned yet
});

test('only the bundled page may call privileged IPC', async () => {
  const { handlers, call } = load();
  for (const ch of handlers.keys()) {
    await assert.rejects(async () => call(ch, {}, 'https://evil.example/index.html'), /Untrusted sender/, ch);
    await assert.rejects(async () => call(ch, {}, 'file:///tmp/other.html'), /Untrusted sender/, ch);
  }
  assert.deepEqual(await call('settings:get'), {});
});

test('settings:set only accepts a boolean readOnly and persists it', async () => {
  const { call, userData } = load();
  await call('settings:set', { readOnly: 'yes', root: '/etc' });
  assert.deepEqual(await call('settings:get'), {});
  await call('settings:set', { readOnly: true });
  assert.equal((await call('settings:get')).readOnly, true);
  assert.ok(fs.existsSync(path.join(userData, 'settings.json')));
});

test('startup and tray options accept only booleans and write the autostart entry', async () => {
  const { call, userData } = load();
  const entry = path.join(userData, 'autostart', 'gutcheck.desktop');
  const first = await call('background:get');
  assert.deepEqual([first.launchOnStartup, first.minimizeToTray, first.closeToTray], [false, false, false]);
  await call('background:set', { minimizeToTray: 'yes', closeToTray: 1, launchOnStartup: 'true', evil: true });
  assert.deepEqual(await call('settings:get'), {});
  assert.equal(fs.existsSync(entry), false);
  const on = await call('background:set', { minimizeToTray: true, closeToTray: true, launchOnStartup: true });
  assert.deepEqual([on.launchOnStartup, on.minimizeToTray, on.closeToTray], [true, true, true]);
  if (process.platform === 'linux') assert.match(fs.readFileSync(entry, 'utf8'), /--hidden/);
  const off = await call('background:set', { launchOnStartup: false });
  assert.equal(off.launchOnStartup, false);
  assert.equal(off.closeToTray, true, 'untouched options are kept');
  assert.equal((await call('background:set', 'junk')).closeToTray, true);
});

test('settings survive damage: bad JSON is kept aside, non-objects read as empty, writes are atomic', async () => {
  const { call, userData } = load();
  const file = path.join(userData, 'settings.json');
  fs.writeFileSync(file, '{"readOnly": tr');
  assert.deepEqual(await call('settings:get'), {});
  assert.equal(fs.readFileSync(file + '.bad', 'utf8'), '{"readOnly": tr', 'the damaged file is kept for recovery');
  fs.writeFileSync(file, 'null');
  assert.deepEqual(await call('settings:get'), {});
  await call('settings:set', { readOnly: true });
  await call('background:set', { closeToTray: true });
  assert.deepEqual(await call('settings:get'), { readOnly: true, closeToTray: true }, 'separate handlers never clobber each other');
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('a missing request argument fails safely instead of throwing', async () => {
  const { handlers, call } = load();
  for (const ch of ['scan:start', 'scan:one', 'action:plan', 'action:apply']) await handlers.get(ch)({ senderFrame: { url: pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href } });
  assert.equal((await call('scan:start', { root: __filename })).ok, false, 'a file is not a workspace folder');
});

test('open:url allows only github.com https links; open:folder only scanned repos', async () => {
  const { call, opened } = load();
  await call('open:url', 'https://github.com/me/x');
  await call('open:url', 'https://github.com.evil.example/x');
  await call('open:url', 'file:///etc/passwd');
  await call('open:url', 'http://github.com/me/x');
  await call('open:folder', '/etc');
  assert.deepEqual(opened, [['url', 'https://github.com/me/x']]);
});

test('requests with bad input fail safely', async () => {
  const { call } = load();
  assert.deepEqual((await call('scan:start', { root: '/definitely/not/here' })).ok, false);
  assert.equal((await call('scan:one', { dir: '/nope' })).ok, false);
  assert.equal((await call('action:plan', { items: [] }))[0].ok, false);
  assert.deepEqual(await call('action:apply', { tokens: 'x' }), []);
  assert.equal((await call('clutter:scan', {})).ok, false);
  assert.equal((await call('report:copy', {})).ok, false);
  assert.deepEqual(await call('trend:get'), []);
  assert.deepEqual(await call('audit:list'), []);
});
