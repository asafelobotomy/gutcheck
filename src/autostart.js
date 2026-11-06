// Launch on start up. Windows and macOS use Electron's login-item API; Linux has none, so we write
// (or remove) an XDG autostart entry, which KDE, GNOME, XFCE and friends all honour.
const fs = require('node:fs');
const path = require('node:path');

const ENTRY = 'gutcheck.desktop';
const HIDDEN_FLAG = '--hidden'; // start straight into the tray

// Desktop Entry spec: an argument with spaces or special characters is double-quoted, and inside
// the quotes " ` $ \ get a backslash. `%` is a field code, so it is doubled. The spec then applies
// the key-file string escapes on top (every backslash written twice, so a literal $ is \\$), and
// control characters cannot appear in a value at all.
const quoteArg = (a) => {
  if (/^[\w@+=:,./-]+$/.test(a)) return a;
  const exec = '"' + a.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%') + '"';
  return exec.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
};

function desktopEntry(exec, args = []) {
  const line = [exec, ...args].map(quoteArg).join(' ');
  return ['[Desktop Entry]', 'Type=Application', 'Name=GutCheck', 'Comment=Workspace health dashboard',
    `Exec=${line}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

// Packaged AppImages must relaunch the AppImage itself, not the temporary mount inside it.
function launchCommand(app, env = process.env, execPath = process.execPath) {
  if (app.isPackaged) return { exec: env.APPIMAGE || execPath, args: [HIDDEN_FLAG] };
  return { exec: execPath, args: [app.getAppPath(), '--no-sandbox', HIDDEN_FLAG] };
}

function setLinux(dir, enabled, cmd) {
  const file = path.join(dir, ENTRY);
  if (!enabled) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, desktopEntry(cmd.exec, cmd.args), { mode: 0o644 });
}

// `dir` is the XDG autostart folder (Linux only); it is a parameter so tests never touch the real one.
function setAutostart(app, enabled, { dir, platform = process.platform } = {}) {
  const on = !!enabled;
  if (platform === 'linux') setLinux(dir, on, launchCommand(app));
  else app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_FLAG] });
  return on;
}

function isAutostart(app, { dir, platform = process.platform } = {}) {
  if (platform === 'linux') return fs.existsSync(path.join(dir, ENTRY));
  return !!app.getLoginItemSettings().openAtLogin;
}

module.exports = { setAutostart, isAutostart, desktopEntry, launchCommand, quoteArg, HIDDEN_FLAG, ENTRY };
