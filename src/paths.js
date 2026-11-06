// Where GutCheck keeps its own files. Matches Electron's app.getPath('userData') for this app, so the
// app, the CLI and the MCP server share settings, History, trends and test-run output.

const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'GutCheck'; // Electron names the data folder after productName

function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.GUTCHECK_DATA_DIR) return env.GUTCHECK_DATA_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

// Output of test runs for one repo (coverage, JUnit, mutation reports), outside the repo itself.
const runDir = (repoPath, env = process.env) => path.join(dataDir(env), 'runs', path.resolve(repoPath).replace(/[^A-Za-z0-9]/g, '-'));

module.exports = { dataDir, runDir, APP_NAME };
