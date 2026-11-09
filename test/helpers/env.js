// An environment for an engine or CLI under test: a temp HOME (and XDG config folder), so a report or
// secrets scan never reads the developer's real home folder. The temp folders go when the run ends.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const homes = [];
process.on('exit', () => { for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch {} } });

function isolatedEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-home-'));
  homes.push(home);
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...extra };
}

module.exports = { isolatedEnv };
