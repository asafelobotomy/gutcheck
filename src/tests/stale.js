// Stale tests: switched-off markers (skip, todo, fixme, xfail) left in for months, and test files
// untouched while the code they are named after changed a lot. Ages come from git blame and git log
// through exec.git (hooks and fsmonitor off). A skip whose reason names a platform, tool or
// environment it waits for is deliberate, not stale. Read-only.

const { git } = require('../exec');
const { COMMAND_TIMEOUT_MS } = require('../util');

const STALE_DAYS = 180;
const DRIFT_COMMITS = 10; // commits to the code since the test last changed
const DRIFT_DAYS = 180; // and the test untouched this long
const LOG_COMMITS = 2000;
const MAX_KEPT = 30;

// Markers beyond skips: xfail (pytest: passes silently once fixed, unless strict) and vitest's test.fails.
const XFAIL = { py: /@pytest\.mark\.xfail\b(?![^\n]*strict\s*=\s*True)/g, js: /\b(?:it|test)\.fails\s*\(/g };

// A reason that names what the test waits for: an OS, CI, a tool, a service, hardware or a slow mode.
const DELIBERATE = /\b(?:windows|win32|linux|mac ?os|macos|darwin|posix|unix|wsl|android|ios|arm64|x86|32-?bit|64-?bit|platform|os|ci|offline|network|internet|docker|podman|gpu|cuda|display|headless|root|sudo|privileg\w*|requires?|only on|not (?:supported|available)|unavailable|missing|installed|slow|long[- ]running|manual|interactive|integration|e2e|credentials?|api[ _-]?key|token|env(?:ironment)?)\b/i;

function reasonOf(raw) {
  const q = /(?:reason\s*=\s*|skip[A-Za-z]*\s*\(\s*|fixme\s*\(\s*|todo\s*\(\s*|ignore\s*=\s*)(["'`])([^"'`]{0,200})\1/i.exec(raw);
  if (q) return q[2].trim();
  const c = /(?:^|\s)#(?!\[)\s*(.{3,200})$|\/\/\s*(.{3,200})$/.exec(raw); // a trailing comment
  return c ? (c[1] || c[2]).trim() : '';
}

// Lines that are xfail / .fails markers (strings blanked in `code`, so markers inside strings do not count).
function xfailMarkers(tests) {
  const out = [];
  for (const f of tests) {
    const re = XFAIL[f.lang];
    if (!re) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(f.code)) && out.length < MAX_KEPT) out.push({ path: f.rel, line: f.code.slice(0, m.index).split('\n').length, kind: 'xfail' });
  }
  return out;
}

// { line -> author time (seconds) } for the given lines of one file; uncommitted lines get now.
async function blameLines(dir, rel, lines) {
  // --no-textconv: a repo's diff driver must not run (audit B3), on top of exec.git's own guard.
  const args = ['blame', '--no-textconv', '--line-porcelain', ...lines.flatMap((l) => ['-L', `${l},${l}`]), '--', rel];
  const r = await git(args, { cwd: dir, timeout: COMMAND_TIMEOUT_MS });
  const out = {};
  if (!r.ok) return out;
  let cur = null;
  for (const l of r.stdout.split('\n')) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
    if (h) { cur = { line: Number(h[2]), zero: /^0+$/.test(h[1]) }; continue; }
    const t = /^author-time (\d+)/.exec(l);
    if (t && cur) { out[cur.line] = cur.zero ? Date.now() / 1000 : Number(t[1]); cur = null; }
  }
  return out;
}

// Skipped and xfail tests, each with its age in days and whether its reason makes it deliberate.
async function markerAges(dir, markers, rawByPath) {
  const byFile = new Map();
  for (const m of markers) (byFile.get(m.path) || byFile.set(m.path, []).get(m.path)).push(m);
  const now = Date.now() / 1000;
  for (const [rel, list] of byFile) {
    const raw = (rawByPath.get(rel) || '').split('\n');
    // The reason may sit on the marker line or the line after (a decorator over its def).
    for (const m of list) { const r = reasonOf(raw[m.line - 1] || '') || reasonOf(raw[m.line] || ''); m.reason = r.slice(0, 80); m.deliberate = !!r && DELIBERATE.test(r); }
    const times = await blameLines(dir, rel, [...new Set(list.map((m) => m.line))]);
    for (const m of list) if (times[m.line] != null) m.age = Math.floor((now - times[m.line]) / 86400);
  }
  return markers;
}

// Per file: the times of the commits that touched it, newest first, from one git log.
async function fileHistory(dir) {
  const r = await git(['log', '-n', String(LOG_COMMITS), '--no-merges', '--no-renames', '--format=%x01%ct', '--name-only'], { cwd: dir, timeout: COMMAND_TIMEOUT_MS });
  const byFile = new Map();
  let commits = 0;
  if (!r.ok) return { byFile, complete: false, commits };
  let t = 0;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('\x01')) { t = Number(l.slice(1)); commits++; continue; }
    if (l && t) (byFile.get(l) || byFile.set(l, []).get(l)).push(t);
  }
  return { byFile, complete: commits < LOG_COMMITS, commits };
}

// Test files whose named module (same stem) changed in many commits since the test last did.
function drift(history, pairs) {
  const out = [];
  const now = Date.now() / 1000;
  for (const { test, source } of pairs) {
    const tt = history.byFile.get(test);
    const st = history.byFile.get(source);
    if (!st || (!tt && history.complete)) continue; // untracked test, or a new one
    const last = tt ? tt[0] : 0;
    const since = st.filter((x) => x > last).length;
    const idle = Math.floor((now - (last || st[st.length - 1])) / 86400);
    if (since >= DRIFT_COMMITS && idle >= DRIFT_DAYS) out.push({ path: test, source, commits: since, days: tt ? idle : null });
  }
  return out.sort((a, b) => b.commits - a.commits).slice(0, MAX_KEPT);
}

async function staleness(dir, { skipped, tests, rawByPath, pairs }) {
  const markers = await markerAges(dir, [...skipped.map((s) => ({ ...s })), ...xfailMarkers(tests)].slice(0, 60), rawByPath);
  const old = markers.filter((m) => m.age != null && m.age >= STALE_DAYS && !m.deliberate);
  const history = await fileHistory(dir);
  return { markers, oldMarkers: old.slice(0, MAX_KEPT), xfail: markers.filter((m) => m.kind === 'xfail'), drift: drift(history, pairs) };
}

module.exports = { staleness, reasonOf, DELIBERATE, STALE_DAYS, DRIFT_COMMITS, blameLines, fileHistory, drift, xfailMarkers };
