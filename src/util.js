// Small helpers shared across modules.

const DAY = 86400000;
const DAYS_PER_YEAR = 365;
const MAX_PLAN_ITEMS = 500; // most items one clean-up plan may name
const COMMAND_TIMEOUT_MS = 60000; // generous ceiling for one git / gh call
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote, safe to paste into a shell
const plural = (n, w, pl = w + 's') => `${n} ${n === 1 ? w : pl}`;
const list = (a, max = 6) => a.slice(0, max).join(', ') + (a.length > max ? `, +${a.length - max} more` : '');

// Folders no scan should descend into: huge build/dependency output owned by a tool.
const HEAVY_DIRS = ['node_modules', 'target', 'dist', 'build', 'vendor'];

// Node lockfiles, and the install command that matches the one a project uses.
const NODE_LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];
function installCommand(names) {
  if (names.includes('pnpm-lock.yaml')) return ['pnpm', 'install'];
  if (names.includes('yarn.lock')) return ['yarn', 'install'];
  if (names.includes('bun.lock') || names.includes('bun.lockb')) return ['bun', 'install'];
  return ['npm', 'install'];
}

// Dotted numeric version compare (-1, 0, 1); prerelease tags are ignored. Good enough to tell
// "behind" from "ahead", which `npm outdated` reports alike (e.g. a retracted latest release).
function cmpVersion(a, b) {
  const n = (v) => String(v).replace(/^[^\d]*/, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { NODE_LOCKFILES, installCommand, DAYS_PER_YEAR, MAX_PLAN_ITEMS, COMMAND_TIMEOUT_MS, cmpVersion, DAY, daysAgo, sq, plural, list, HEAVY_DIRS };
