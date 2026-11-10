// Workspace advice: how much disk the global package caches in the home folder use, with each tool's
// own prune command printed. Read-only: sizes come from du (clutter-rules' bigDirSize), nothing is run
// or deleted. Fixed default paths only (no `go env`, no tool is started).

const os = require('node:os');
const path = require('node:path');
const { bigDirSize } = require('./clutter-rules');
const { list } = require('./util');

const THRESHOLD_KIB = 1048576; // 1 GB: below that a cache is not worth a line
// Each entry: paths under home (the first that exists and is over the threshold counts, all are listed),
// the tool's own command, and the cost of clearing it.
const CACHES = [
  { name: 'npm cache', paths: ['.npm/_cacache'], cmd: 'npm cache verify', note: 'npm\'s docs call the cache self-healing and say clearing it is rarely needed; verify garbage-collects it. "npm cache clean --force" deletes all of it.' },
  { name: 'pnpm store', paths: ['.local/share/pnpm/store', '.cache/pnpm'], cmd: 'pnpm store prune', note: 'removes packages no project links to; the rest is hard-linked into projects and stays' },
  { name: 'uv cache', paths: ['.cache/uv'], cmd: 'uv cache prune', note: 'removes unused entries; "uv cache clean" empties it' },
  { name: 'pip cache', paths: ['.cache/pip'], cmd: 'pip cache purge', note: 'wheels are downloaded again when needed' },
  { name: 'cargo registry', paths: ['.cargo/registry'], cmd: 'cargo clean   # per project, in each project folder; or, third party and optional: cargo install cargo-cache', note: 'cargo has no built-in command for the registry cache; it is downloaded again on the next build' },
  { name: 'cargo git checkouts', paths: ['.cargo/git'], cmd: null, note: 'same as the registry cache: cargo fetches them again' },
  { name: 'Gradle caches', paths: ['.gradle/caches'], cmd: 'gradle --stop   # Gradle cleans its own caches in the background when the daemon stops; ~/.gradle/caches may be deleted by hand only when no build is running', note: 'dependencies are downloaded again, so the next build is slow' },
  { name: 'Go build cache', paths: ['.cache/go-build'], cmd: 'go clean -cache', note: 'rebuilt on the next build' },
  { name: 'Go module cache', paths: ['go/pkg/mod'], cmd: 'go clean -modcache', note: 'modules are downloaded again; read-only files, so use the go command, not rm' },
];
const REF = 'https://docs.astral.sh/uv/concepts/cache/';
const gb = (k) => (k >= 1048576 ? `${(k / 1048576).toFixed(1)} GB` : `${Math.round(k / 1024)} MB`);

// opts: { home, thresholdKiB } are injectable for tests.
async function cacheAdvice(opts = {}) {
  const home = opts.home || os.homedir();
  const min = opts.thresholdKiB == null ? THRESHOLD_KIB : opts.thresholdKiB;
  const found = (await Promise.all(CACHES.map(async (c) => {
    let kib = 0;
    const where = [];
    for (const p of c.paths) {
      const k = Math.round((await bigDirSize(path.join(home, p)).catch(() => 0)) / 1024);
      if (k > 0) { kib += k; where.push(p); }
    }
    return kib >= min ? { ...c, kib, where } : null;
  }))).filter(Boolean).sort((a, b) => b.kib - a.kib);
  if (!found.length) return [];
  const total = found.reduce((n, f) => n + f.kib, 0);
  const lines = found.map((f) => `${f.name} (${f.where.map((p) => '~/' + p).join(', ')}): ${gb(f.kib)}${f.cmd ? `, prune with: ${f.cmd}` : ''}. ${f.note}.`);
  return [{
    id: 'ws-cache-sizes', severity: 'info', title: `${gb(total)} in global package caches (${list(found.map((f) => f.name), 4)})`,
    detail: `${lines.join(' ')} Nothing here is a source of truth: every cache is downloaded or rebuilt on demand, at the price of a slower next install or build. Run the commands yourself, not while an install or build is running. GutCheck deletes nothing.`,
    cmds: found.filter((f) => f.cmd).map((f) => f.cmd),
    ref: REF,
  }];
}

module.exports = { cacheAdvice, CACHES, THRESHOLD_KIB };
