// System tray: a tray icon with Show/Quit, minimise-to-tray, close-to-tray, and a single instance.
// Takes everything from Electron as parameters so it can be tested with fakes.
const path = require('node:path');

const ICON = path.join(__dirname, 'assets', 'tray.png');

function createTrayController({ app, Tray, Menu, nativeImage, getWindow, getSettings, icon = ICON }) {
  let tray = null;
  let quitting = false;

  const show = () => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  };
  const hide = () => { const w = getWindow(); if (w && !w.isDestroyed()) w.hide(); };
  const toggle = () => { const w = getWindow(); if (w && w.isVisible() && !w.isMinimized()) hide(); else show(); };
  const quit = () => { quitting = true; app.quit(); };

  function create() {
    if (tray) return tray;
    try {
      tray = new Tray(nativeImage.createFromPath(icon));
    } catch {
      tray = null; // no tray available: the window then never hides, so it can't get lost
      return null;
    }
    tray.setToolTip('GutCheck');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show GutCheck', click: show },
      { type: 'separator' },
      { label: 'Quit', click: quit },
    ]));
    tray.on('click', toggle);
    return tray;
  }

  // Hide instead of minimise / close when the matching setting is on and a tray icon exists.
  function attach(win) {
    win.on('minimize', () => { if (tray && getSettings().minimizeToTray) hide(); });
    win.on('close', (e) => {
      if (quitting || !tray || !getSettings().closeToTray) return;
      e.preventDefault();
      hide();
    });
  }

  // One running copy: a second launch (e.g. from the menu) brings the first one back.
  function singleInstance() {
    if (!app.requestSingleInstanceLock()) { app.quit(); return false; }
    app.on('second-instance', show);
    return true;
  }

  app.on('before-quit', () => { quitting = true; });

  return { create, attach, show, hide, toggle, quit, singleInstance, hasTray: () => !!tray };
}

module.exports = { createTrayController };
