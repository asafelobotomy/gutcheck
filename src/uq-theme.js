// uQ's theme for the window, following the Electron recipe in uq-tokens' README
// (src/vendor/uq-tokens). The main process reads $XDG_STATE_HOME/uq/theme/tokens.json for the
// renderer (`uq-tokens:read`) and watches $XDG_STATE_HOME/uq: uqd replaces theme/ atomically, so a
// watch on the file or on theme/ itself is lost after the first change. The renderer validates
// every value before it becomes CSS (renderer/uq-theme.mjs). Without uQ nothing is read or sent and
// the app keeps its own colours. Read-only: GutCheck never writes there.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 64 * 1024;
const CHANGED = 'uq-tokens-changed';

// $XDG_STATE_HOME/uq (only an absolute XDG_STATE_HOME counts), else ~/.local/state/uq.
function uqDir(env = process.env, home = require('node:os').homedir()) {
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(state, 'uq');
}

// The tokens.json text, or null when it is missing, not a file, unreadable or 64 KiB or more.
function readTokens(dir) {
  const file = path.join(dir, 'theme', 'tokens.json');
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size >= MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Calls onChange whenever theme/ under dir changes. Returns the watcher, or null when dir doesn't
// exist (uQ isn't installed: the app's own theme stays until it is restarted).
function watchTheme(dir, onChange) {
  try {
    const w = fs.watch(dir, { persistent: false }, (_event, name) => {
      if (name === 'theme' || name == null) onChange();
    });
    w.on('error', () => {});
    return w;
  } catch {
    return null;
  }
}

module.exports = { uqDir, readTokens, watchTheme, CHANGED, MAX_BYTES };
