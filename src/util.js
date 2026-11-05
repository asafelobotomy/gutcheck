// Small helpers shared across modules.

const DAY = 86400000;
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote, safe to paste into a shell
const plural = (n, w, pl = w + 's') => `${n} ${n === 1 ? w : pl}`;
const list = (a, max = 6) => a.slice(0, max).join(', ') + (a.length > max ? `, +${a.length - max} more` : '');

// Folders no scan should descend into: huge build/dependency output owned by a tool.
const HEAVY_DIRS = ['node_modules', 'target', 'dist', 'build', 'vendor'];

module.exports = { DAY, daysAgo, sq, plural, list, HEAVY_DIRS };
