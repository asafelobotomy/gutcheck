// Small helpers shared across modules.
const path = require('node:path');

const DAY = 86400000;
const DAYS_PER_YEAR = 365;
const MAX_PLAN_ITEMS = 500; // most items one clean-up plan may name
const COMMAND_TIMEOUT_MS = 60000; // generous ceiling for one git / gh call
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote, safe to paste into a shell
const plural = (n, w, pl = w + 's') => `${n} ${n === 1 ? w : pl}`;
// The folder box accepts "~/Projects" (as its placeholder suggests) and relative paths.
const expandHome = (p, home) => path.resolve(p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
// Text safe to print to a terminal or show as a name, one-to-one: "\" becomes "\\", C0 and C1
// controls and DEL become \xNN, and line separators, format characters (bidi controls, zero-width
// characters, BOM, soft hyphen, tags), variation selectors and invisible fillers become \u{...}.
const UNPRINTABLE = /[\\\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\p{Cf}\u{34f}\u{115f}\u{1160}\u{3164}\u{fe00}-\u{fe0f}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const printable = (s) => String(s).replace(UNPRINTABLE, (ch) => {
  if (ch === '\\') return '\\\\';
  const n = ch.codePointAt(0);
  return n <= 0x9f ? '\\x' + n.toString(16).padStart(2, '0') : '\\u{' + n.toString(16) + '}';
});
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

// A workflow that failed this many runs in a row is broken, not flaky: a re-run would fail again.
const BROKEN_RUN_STREAK = 3;

module.exports = { BROKEN_RUN_STREAK, expandHome, NODE_LOCKFILES, installCommand, DAYS_PER_YEAR, MAX_PLAN_ITEMS, COMMAND_TIMEOUT_MS, cmpVersion, DAY, daysAgo, sq, plural, printable, list, HEAVY_DIRS };
