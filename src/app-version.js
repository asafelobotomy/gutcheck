// Which GutCheck the user has installed, so the unpacked copy agents run (mcp-app/<version>/) can
// tell it is out of date. The app records its version in the data folder each time it starts; the
// MCP server compares its own version with that and says how to update. Nothing is fetched.

const fs = require('node:fs');
const path = require('node:path');
const { cmpVersion } = require('./util');

const FILE = 'app-version.json';

// Called by the app (never by the MCP copy, which would record its own older version).
function recordAppVersion(dataDir, version) {
  try {
    const f = path.join(dataDir, FILE);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: String(version), at: new Date().toISOString() }) + '\n');
    fs.renameSync(tmp, f);
  } catch {}
}

// A notice for agents when the installed app is newer than this server, else null.
function outdatedNotice(dataDir, version) {
  let installed;
  try { installed = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')).version; } catch { return null; }
  if (!installed || cmpVersion(version, installed) >= 0) return null;
  return `This MCP server is GutCheck ${version}, but GutCheck ${installed} is installed. Its checks and fixes may be out of date. Tell the user: open GutCheck, go to Settings > AI agents, press Update, then start a new agent session.`;
}

// Unpacked copies under mcp-app/ that no agent config points at any more, except `keep` (the
// version being connected). Returned as { path, mtime } for a trash step.
function staleCopies(dataDir, keep, inUse = []) {
  const root = path.join(dataDir, 'mcp-app');
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(root, n);
    if (n === String(keep) || inUse.some((c) => c && (c === dir || c.startsWith(dir + path.sep)))) continue;
    try { const st = fs.lstatSync(dir); if (st.isDirectory()) out.push({ path: dir, mtime: st.mtimeMs }); } catch {}
  }
  return out;
}

module.exports = { recordAppVersion, outdatedNotice, staleCopies };
