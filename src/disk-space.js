// What a byte count from du means on this disk, and how much space a clean-up really freed.
// btrfs and bcachefs can compress files as they are written. Then du, stat and `btrfs filesystem du`
// all give the size before compression. Build output compresses well, so 60 GB of target/ folders
// can free only 24 GB. The size on disk needs root to read (compsize), so GutCheck instead says when
// its sizes are before compression, and measures free space before and after a clean-up.
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./exec');

// /proc/self/mounts escapes space, tab, newline and backslash as octal (\040 ...).
const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

// The compression a mount applies to new files, e.g. "btrfs zstd:3", or null. `mounts` is the text of
// /proc/self/mounts (read when omitted; null off Linux). The longest mount point containing dir wins.
function compressionOf(dir, mounts) {
  if (mounts === undefined) {
    try { mounts = fs.readFileSync('/proc/self/mounts', 'utf8'); } catch { return null; }
  }
  let abs = path.resolve(dir);
  try { abs = fs.realpathSync(abs); } catch {}
  let best = null;
  for (const line of String(mounts || '').split('\n')) {
    const [, mp, type, opts] = line.split(' ');
    if (!mp || !type) continue;
    const m = unescape(mp);
    const inside = m === '/' || abs === m || abs.startsWith(m.endsWith('/') ? m : m + '/');
    if (inside && (!best || m.length > best.m.length)) best = { m, type, opts: (opts || '').split(',') };
  }
  if (!best) return null;
  const opt = (names) => {
    for (const o of best.opts) {
      const [k, v] = o.split('=');
      if (names.includes(k) && v && v !== 'no' && v !== 'none') return v;
    }
    return null;
  };
  const algo = best.type === 'btrfs' ? opt(['compress', 'compress-force'])
    : best.type === 'bcachefs' ? opt(['compression', 'background_compression']) : null;
  return algo ? `${best.type} ${algo}` : null;
}

// Bytes free for an ordinary user on the disk holding dir, or null.
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

// Free space after a clean-up, once the filesystem has written out the deletes: btrfs only returns
// freed space when its transaction commits, which `sync -f` forces for that one filesystem.
async function freeBytesSettled(dir) {
  await run('sync', ['-f', '--', dir], { timeout: 60000 }).catch(() => null);
  return freeBytes(dir);
}

const COMPRESSED_NOTE = 'sizes are before compression, so deleting frees less than they add up to';

module.exports = { compressionOf, freeBytes, freeBytesSettled, COMPRESSED_NOTE };
