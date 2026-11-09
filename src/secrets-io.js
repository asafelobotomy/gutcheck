// File and process helpers for the secrets controller: reading a planned file once, scrubbing a
// CLI's stderr of the file's lines, finding a vault binary, and keeping the scanned workspace out of
// what a vault CLI runs (its binary, its PATH and its cwd). Contents never leave readPlanned's result.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_SECRET_BYTES } = require('./secret-patterns');

const CHANGED = 'Changed since the preview. Rescan and review it again.';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Remove every stderr line that holds a non-empty line of any source, or any 8+ character run
// from one. Runs are found by checking each 8-char window of a line against a Set of the
// sources' 8-char substrings, so a 1 MB file costs one pass, not a substring scan per line.
function scrub(text, ...sources) {
  const lines = String(text || '').slice(0, 65536).split('\n');
  if (!lines.some((l) => l.trim())) return '';
  const grams = new Set();
  const short = new Set();
  for (const src of sources) {
    const s = Buffer.isBuffer(src) ? src.toString('utf8') : String(src == null ? '' : src);
    for (let i = 0; i + 8 <= s.length; i++) grams.add(s.slice(i, i + 8));
    for (const l of s.split(/\r?\n/)) { const t = l.trim(); if (t && t.length < 8) short.add(t); }
  }
  const leaks = (line) => {
    for (let i = 0; i + 8 <= line.length; i++) if (grams.has(line.slice(i, i + 8))) return true;
    for (const t of short) if (line.includes(t)) return true;
    return false;
  };
  return lines.filter((l) => l.trim() && !leaks(l)).join('\n').trim();
}

// First executable regular file named `bin` on PATH (symlinks resolved), or null.
function findBin(bin, env) {
  for (const dir of String((env && env.PATH) || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    try {
      const real = fs.realpathSync(path.join(dir, bin));
      if (!fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* next */ }
  }
  return null;
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The scanned folders, real paths: each repo, then the workspace root ({ root, name, isRoot }).
function wsDirs(ws) {
  if (!ws) return [];
  const repos = ws.repos.filter((r) => r && typeof r.path === 'string').map((r) => ({ root: realOr(r.path), name: r.name || path.basename(r.path), isRoot: false }));
  return [...repos, ...(ws.root ? [{ root: realOr(ws.root), name: 'workspace root', isRoot: true }] : [])];
}

// The scanned folder that holds `p` (a real path), or null.
function containing(p, ws) {
  return wsDirs(ws).find((d) => p === d.root || p.startsWith(d.root + path.sep)) || null;
}

// PATH for a vault CLI: absolute entries only, none inside a scanned repo or the workspace root, so a
// `#!/usr/bin/env node` or a call to gpg can't pick up a repo's binaries ("" and "." mean the cwd).
function safePath(pathVar, ws) {
  const keep = [];
  for (const dir of String(pathVar || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || containing(realOr(dir), ws) || keep.includes(dir)) continue;
    keep.push(dir);
  }
  return keep.join(path.delimiter);
}

// Read the file once (no symlinks, 1 MB at most) and check it still matches the preview's hash.
async function readPlanned(real, expected) {
  let st;
  try { st = await fsp.lstat(real); } catch { return { error: 'The file is gone. Rescan and review it again.' }; }
  if (st.isSymbolicLink()) return { error: 'The file is now a symlink. GutCheck does not save through links.' };
  const notFile = { error: 'The file is no longer a regular file of 1 MB or less.' };
  if (!st.isFile() || st.size > MAX_SECRET_BYTES) return notFile; // a FIFO or device would block open/read
  let fh;
  try {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    fh = await fsp.open(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!(await fh.stat()).isFile()) return notFile;
    const max = MAX_SECRET_BYTES + 1; // read at most one byte past the limit
    const big = Buffer.alloc(max);
    let n = 0;
    for (let r; n < max && (r = (await fh.read(big, n, max - n, null)).bytesRead) > 0;) n += r;
    if (n > MAX_SECRET_BYTES) return notFile;
    const buf = big.subarray(0, n);
    return sha256(buf) === expected ? { buf } : { error: CHANGED };
  } catch { return { error: 'Could not read the file.' }; } finally { if (fh) await fh.close().catch(() => {}); }
}

module.exports = { scrub, findBin, containing, safePath, readPlanned, sha256, CHANGED };
