// Where a large repository's space is: files in the current tree, older versions of those files,
// files deleted since, and objects nothing points to. Read-only (deep scans only). The point is to
// tell whether rewriting history would actually help before anyone considers it: GutCheck itself
// never rewrites history, it only explains the options and their cost.

const { git } = require('./exec');

const TIMEOUT_MS = 3 * 60 * 1000;
const BIG_OUTPUT = 512 * 1024 * 1024;
const REWRITE_WORTH = 0.3; // history-only data must be at least this share of the pack...
const REWRITE_MIN = 200 * 1024 * 1024; // ...and at least this big, before a rewrite is worth its cost
const BINARY_EXT = /\.(png|jpe?g|gif|webp|tiff?|psd|exr|hdr|blend|glb|gltf|fbx|obj|npy|npz|zip|7z|tar|gz|mp[34]|wav|ogg|mov|webm|pdf|bin|so|dll|exe|appimage|apk)$/i;

// Extensions end up in shell commands (report-fixes.js sizeStep), so only plain ones are kept by name.
const SAFE_EXT = /^[A-Za-z0-9_+-]{1,16}$/;
const ext = (p) => { const m = /\.([^./]+)$/.exec(p); return !m ? '(none)' : SAFE_EXT.test(m[1]) ? m[1].toLowerCase() : '(other)'; };
const folder = (p) => { const s = p.split('/'); return s.length > 2 ? s.slice(0, 2).join('/') + '/' : s.length > 1 ? s[0] + '/' : '(root)'; };
const top = (m, n) => [...m.entries()].map(([k, v]) => ({ name: k, bytes: v.bytes, count: v.count })).sort((a, b) => b.bytes - a.bytes).slice(0, n);
const bump = (m, k, bytes) => { const v = m.get(k) || { bytes: 0, count: 0 }; v.bytes += bytes; v.count++; m.set(k, v); };

async function analyzeHistory(dir) {
  const opts = { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: BIG_OUTPUT };
  const [all, reach, head, lfs] = await Promise.all([
    git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize:disk)'], opts),
    git(['rev-list', '--objects', '--all'], opts),
    git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], opts),
    git(['lfs', 'ls-files', '-n'], { cwd: dir }),
  ]);
  if (!all.ok || !reach.ok) return null;
  const pathOf = new Map();
  for (const l of reach.stdout.split('\n')) { const i = l.indexOf(' '); if (i > 0) pathOf.set(l.slice(0, i), l.slice(i + 1)); }
  const headOid = new Set();
  const headPaths = new Set();
  for (const rec of head.stdout.split('\0')) {
    const t = rec.indexOf('\t');
    if (t < 0) continue;
    const [, type, oid] = rec.slice(0, t).split(' ');
    if (type === 'blob') { headOid.add(oid); headPaths.add(rec.slice(t + 1)); }
  }
  const sums = { current: 0, oldVersions: 0, deleted: 0, unreachable: 0, other: 0 };
  const byFolder = new Map();
  const byExt = new Map();
  const deletedFolders = new Map();
  const oldFiles = new Map();
  let binaryCurrent = 0;
  for (const l of all.stdout.split('\n')) {
    const [oid, type, size] = l.split(' ');
    if (!oid) continue;
    const bytes = Number(size) || 0;
    if (type !== 'blob') { sums.other += bytes; continue; }
    const p = pathOf.get(oid);
    if (p === undefined) { sums.unreachable += bytes; continue; }
    if (headOid.has(oid)) {
      sums.current += bytes;
      bump(byFolder, folder(p), bytes);
      bump(byExt, ext(p), bytes);
      if (BINARY_EXT.test(p)) binaryCurrent += bytes;
    } else if (headPaths.has(p)) { sums.oldVersions += bytes; bump(oldFiles, p, bytes); } else { sums.deleted += bytes; bump(deletedFolders, folder(p), bytes); }
  }
  const total = Object.values(sums).reduce((a, b) => a + b, 0);
  const historyOnly = sums.oldVersions + sums.deleted;
  return {
    total, ...sums, historyOnly, binaryCurrent,
    rewriteWorthIt: historyOnly >= REWRITE_MIN && historyOnly / Math.max(1, total) >= REWRITE_WORTH,
    folders: top(byFolder, 6), extensions: top(byExt, 5), oldFiles: top(oldFiles, 5),
    // Only folders with nothing left in the current tree: removing one from history cannot touch a current file.
    deletedFolders: top(new Map([...deletedFolders].filter(([f]) => f !== '(root)' && ![...headPaths].some((p) => p.startsWith(f)))), 5),
    lfsFiles: lfs.ok ? lfs.stdout.split('\n').filter(Boolean).length : null,
  };
}

const fmt = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);

// Plain-language verdict for the repo-size finding.
function historyVerdict(h) {
  if (!h) return null;
  const parts = [`Of ${fmt(h.total)} stored: current files ${fmt(h.current)}, older versions ${fmt(h.oldVersions)}, deleted files ${fmt(h.deleted)}${h.unreachable ? `, unreferenced ${fmt(h.unreachable)} (git gc removes it)` : ''}.`];
  if (h.rewriteWorthIt) parts.push(`Rewriting history could save about ${fmt(h.historyOnly)}${h.deletedFolders.length ? ` (deleted: ${h.deletedFolders.slice(0, 3).map((f) => `${f.name} ${fmt(f.bytes)}`).join(', ')})` : ''}. That changes every commit id and needs a force-push: GutCheck does not do it, but the report gives the steps.`);
  else parts.push(`Rewriting history would save about ${fmt(h.historyOnly)} (${Math.round((100 * h.historyOnly) / Math.max(1, h.total))}%): most of the size is the files you have now. Biggest: ${h.folders.slice(0, 3).map((f) => `${f.name} ${fmt(f.bytes)}`).join(', ')}. ${h.binaryCurrent / Math.max(1, h.current) > 0.5 ? 'Mostly binary files (' + h.extensions.filter((e) => SAFE_EXT.test(e.name)).slice(0, 3).map((e) => e.name).join(', ') + '): Git LFS for new versions, or keeping archives and generated files out of git, are what would help.' : 'Consider whether everything here belongs in git.'}`);
  return parts.join(' ');
}

module.exports = { analyzeHistory, historyVerdict, SAFE_EXT, REWRITE_WORTH, REWRITE_MIN };
