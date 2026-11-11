// Where GutCheck keeps its own files. Matches Electron's app.getPath('userData') for this app, so the
// app, the CLI and the MCP server share settings, History, trends and test-run output.

const os = require('node:os');
const path = require('node:path');
const { validRef } = require('./remote-settings');

const APP_NAME = 'GutCheck'; // Electron names the data folder after productName

function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.GUTCHECK_DATA_DIR) return env.GUTCHECK_DATA_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

// Output of test runs for one repo (coverage, JUnit, mutation reports), outside the repo itself.
const runDir = (repoPath, env = process.env) => path.join(dataDir(env), 'runs', path.resolve(repoPath).replace(/[^A-Za-z0-9]/g, '-'));

// Shallow clones of repos that are on GitHub but not cloned in the workspace: <owner>__<name>.
// Owners never contain "_", so the first "__" splits a folder name back into owner and name.
const remoteCacheRoot = (env = process.env) => path.join(dataDir(env), 'remote-cache');
function remoteDir(owner, name, env = process.env) {
  if (!validRef({ owner, name })) throw new Error('Unsupported repository name');
  return path.join(remoteCacheRoot(env), `${owner}__${name}`);
}
function remoteKeyFromDir(base) {
  const i = typeof base === 'string' ? base.indexOf('__') : -1;
  if (i < 1) return null;
  const ref = { owner: base.slice(0, i), name: base.slice(i + 2) };
  return validRef(ref) ? ref : null;
}

module.exports = { dataDir, runDir, remoteCacheRoot, remoteDir, remoteKeyFromDir, APP_NAME };
