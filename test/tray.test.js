const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrayController } = require('../src/tray');
const { setAutostart, isAutostart, desktopEntry, launchCommand, quoteArg } = require('../src/autostart');

function rig(settings = {}, { trayFails = false } = {}) {
  const log = [];
  const handlers = {};
  const winHandlers = {};
  const win = {
    visible: true, minimized: false,
    isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    show() { this.visible = true; }, hide() { this.visible = false; },
    restore() { this.minimized = false; }, focus() {},
    on: (ev, fn) => { winHandlers[ev] = fn; },
  };
  const trayHandlers = {};
  function Tray() {
    if (trayFails) throw new Error('no tray');
    return { setToolTip() {}, setContextMenu: (m) => { log.menu = m; }, on: (e, fn) => { trayHandlers[e] = fn; } };
  }
  const app = { on: (e, fn) => { handlers[e] = fn; }, quit: () => log.push('quit'), requestSingleInstanceLock: () => !log.locked };
  const ctl = createTrayController({ app, Tray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromPath: (p) => p }, getWindow: () => win, getSettings: () => settings });
  ctl.attach(win);
  return { ctl, win, log, handlers, winHandlers, trayHandlers, settings };
}

test('the bundled tray icon exists and is a PNG', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'tray.png'));
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('minimise and close only hide the window when the option is on and a tray exists', () => {
  const r = rig({});
  r.ctl.create();
  r.winHandlers.minimize();
  assert.equal(r.win.visible, true, 'off by default');
  let prevented = 0;
  r.winHandlers.close({ preventDefault: () => prevented++ });
  assert.equal(prevented, 0);

  r.settings.minimizeToTray = true;
  r.settings.closeToTray = true;
  r.winHandlers.minimize();
  assert.equal(r.win.visible, false);
  r.win.visible = true;
  r.winHandlers.close({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(r.win.visible, false);
});

test('Quit from the tray really closes; before-quit lets the window close', () => {
  const r = rig({ closeToTray: true });
  r.ctl.create();
  r.log.menu.find((m) => m.label === 'Quit').click();
  assert.ok(r.log.includes('quit'));
  let prevented = 0;
  r.winHandlers.close({ preventDefault: () => prevented++ });
  assert.equal(prevented, 0, 'not trapped after quitting');
});

test('without a tray the window is never hidden, so it cannot be lost', () => {
  const r = rig({ minimizeToTray: true, closeToTray: true }, { trayFails: true });
  assert.equal(r.ctl.create(), null);
  assert.equal(r.ctl.hasTray(), false);
  r.winHandlers.minimize();
  let prevented = 0;
  r.winHandlers.close({ preventDefault: () => prevented++ });
  assert.equal(r.win.visible, true);
  assert.equal(prevented, 0);
});

test('clicking the tray toggles the window; a second launch brings it back', () => {
  const r = rig({});
  r.ctl.create();
  r.trayHandlers.click();
  assert.equal(r.win.visible, false);
  r.trayHandlers.click();
  assert.equal(r.win.visible, true);
  r.win.visible = false;
  r.win.minimized = true;
  assert.equal(r.ctl.singleInstance(), true);
  r.handlers['second-instance']();
  assert.deepEqual([r.win.visible, r.win.minimized], [true, false]);
  r.log.locked = true;
  assert.equal(r.ctl.singleInstance(), false);
});

test('autostart writes and removes an XDG entry that relaunches hidden', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-auto-'));
  const dir = path.join(base, 'autostart');
  const app = { isPackaged: true, getAppPath: () => '/opt/app' };
  const opts = { dir, platform: 'linux' };
  try {
    assert.equal(isAutostart(app, opts), false);
    setAutostart(app, true, opts);
    assert.equal(isAutostart(app, opts), true);
    assert.match(fs.readFileSync(path.join(dir, 'gutcheck.desktop'), 'utf8'), /^Exec=.* --hidden$/m);
    setAutostart(app, false, opts);
    assert.equal(isAutostart(app, opts), false);
    setAutostart(app, false, opts); // turning it off twice is fine
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('autostart uses the AppImage path, quotes awkward paths, and uses login items off Linux', () => {
  assert.deepEqual(launchCommand({ isPackaged: true }, { APPIMAGE: '/home/me/My Apps/GutCheck.AppImage' }, '/tmp/.mount/x'), { exec: '/home/me/My Apps/GutCheck.AppImage', args: ['--hidden'] });
  assert.deepEqual(launchCommand({ isPackaged: false, getAppPath: () => '/src/gc' }, {}, '/usr/bin/electron'), { exec: '/usr/bin/electron', args: ['/src/gc', '--no-sandbox', '--hidden'] });
  assert.equal(quoteArg('/plain/path-1.0'), '/plain/path-1.0');
  assert.equal(quoteArg('/a b/$x"y'), '"/a b/\\$x\\"y"');
  assert.match(desktopEntry('/My Apps/g', ['--hidden']), /Exec="\/My Apps\/g" --hidden/);
  const calls = [];
  const app = { setLoginItemSettings: (o) => calls.push(o), getLoginItemSettings: () => ({ openAtLogin: true }) };
  setAutostart(app, true, { platform: 'win32' });
  assert.deepEqual(calls[0], { openAtLogin: true, args: ['--hidden'] });
  assert.equal(isAutostart(app, { platform: 'darwin' }), true);
});

test('the logo, window icon and tray icon are all bundled and valid PNG/SVG files', () => {
  const dir = path.join(__dirname, '..', 'src', 'assets');
  const png = (f) => fs.readFileSync(path.join(dir, f)).subarray(0, 4).toString('hex');
  assert.equal(png('icon.png'), '89504e47');
  assert.equal(png('tray.png'), '89504e47');
  assert.match(fs.readFileSync(path.join(dir, 'logo.svg'), 'utf8'), /^<svg /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build.linux.icon, 'src/assets/icon.png');
});
