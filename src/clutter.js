// Clutter detection: finds files and folders in a repo that nothing needs (stale/duplicate .env
// files, caches, test artefacts, editor/OS junk, backup and copy files) and gives organisation advice.
//
// Read-only: nothing here changes the disk. Removal goes through the action engine
// (actions.js 'clean-clutter'), which re-runs this scan at plan time so only freshly detected,
// untracked items can ever be removed.
//
// Privacy: env files are only ever hashed (to spot identical copies). Their contents are never
// stored, returned or logged.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { git } = require('./exec');
const { DAY, plural, list, HEAVY_DIRS } = require('./util');

const MAX_FILES = 40000;
const MAX_DEPTH = 6;
const MAX_HASH_BYTES = 5 * 1024 * 1024;
// Never descend into these: huge, owned by a tool, or not part of the source tree.
const NO_DESCEND = new Set([...HEAVY_DIRS, '.git', '.venv', 'venv', '.next', '.nuxt', '.svelte-kit', '.cxx', '.gradle']);

// Regenerable folders. `sure`: the name alone is unambiguous, so high confidence even when not ignored.
const CACHE_DIRS = {
  __pycache__: { category: 'cache', reason: 'Python bytecode cache', ignoreAs: '__pycache__/', sure: true },
  '.pytest_cache': { category: 'cache', reason: 'pytest cache', ignoreAs: '.pytest_cache/', sure: true },
  '.mypy_cache': { category: 'cache', reason: 'mypy cache', ignoreAs: '.mypy_cache/', sure: true },
  '.ruff_cache': { category: 'cache', reason: 'ruff cache', ignoreAs: '.ruff_cache/', sure: true },
  '.tox': { category: 'cache', reason: 'tox environments', ignoreAs: '.tox/', sure: true },
  '.parcel-cache': { category: 'cache', reason: 'Parcel cache', ignoreAs: '.parcel-cache/', sure: true },
  '.turbo': { category: 'cache', reason: 'Turborepo cache', ignoreAs: '.turbo/', sure: true },
  '.sass-cache': { category: 'cache', reason: 'Sass cache', ignoreAs: '.sass-cache/', sure: true },
  '.nyc_output': { category: 'test-artifact', reason: 'nyc coverage data', ignoreAs: '.nyc_output/', sure: true },
  htmlcov: { category: 'test-artifact', reason: 'Python coverage HTML report', ignoreAs: 'htmlcov/', sure: false },
  coverage: { category: 'test-artifact', reason: 'Test coverage report', ignoreAs: 'coverage/', sure: false },
  'test-results': { category: 'test-artifact', reason: 'Test runner output', ignoreAs: 'test-results/', sure: false },
  'playwright-report': { category: 'test-artifact', reason: 'Playwright report', ignoreAs: 'playwright-report/', sure: false },
};

// First match wins. `base` derives the name of the file this one is a leftover copy of.
const FILE_RULES = [
  { re: /^\.DS_Store$/, category: 'junk', reason: 'macOS folder metadata', confidence: 'high', ignoreAs: '.DS_Store' },
  { re: /^Thumbs\.db$/i, category: 'junk', reason: 'Windows thumbnail cache', confidence: 'high', ignoreAs: 'Thumbs.db' },
  { re: /^desktop\.ini$/i, category: 'junk', reason: 'Windows folder metadata', confidence: 'high', ignoreAs: 'desktop.ini' },
  { re: /^\._./, category: 'junk', reason: 'macOS resource-fork file', confidence: 'medium', ignoreAs: '._*', base: (n) => n.slice(2), highWithBase: true },
  { re: /\.sw[a-p]$/, category: 'junk', reason: 'Editor swap file (may hold unsaved edits)', confidence: 'medium', ignoreAs: '*.swp' },
  { re: /~$/, category: 'backup', reason: 'Editor backup file', confidence: 'medium', ignoreAs: '*~', base: (n) => n.slice(0, -1) },
  { re: /^\.#./, category: 'junk', reason: 'Emacs lock file', confidence: 'medium', ignoreAs: '.#*' },
  { re: /^#.+#$/, category: 'junk', reason: 'Emacs autosave file', confidence: 'medium', ignoreAs: '#*#' },
  { re: /^~\$./, category: 'junk', reason: 'Office lock file', confidence: 'medium', ignoreAs: null },
  { re: /\.(tmp|temp)$/i, category: 'temp', reason: 'Temporary file', confidence: 'medium', ignoreAs: '*.tmp' },
  { re: /\.orig$/, category: 'backup', reason: 'Leftover from a merge or patch', confidence: 'medium', ignoreAs: '*.orig', base: (n) => n.replace(/\.orig$/, '') },
  { re: /\.rej$/, category: 'backup', reason: 'Rejected patch hunk', confidence: 'medium', ignoreAs: '*.rej', base: (n) => n.replace(/\.rej$/, '') },
  { re: /\.bak$/i, category: 'backup', reason: 'Backup copy', confidence: 'medium', ignoreAs: '*.bak', base: (n) => n.replace(/\.bak$/i, '') },
  { re: /\.(old|backup)$/i, category: 'backup', reason: 'Backup copy', confidence: 'medium', ignoreAs: null, base: (n) => n.replace(/\.(old|backup)$/i, '') },
  { re: /^(npm-debug|yarn-debug|yarn-error|pnpm-debug|lerna-debug)\.log/, category: 'log', reason: 'Package manager crash log', confidence: 'high', ignoreAs: 'npm-debug.log*' },
  { re: /\.log$/i, category: 'log', reason: 'Log file', confidence: 'low', ignoreAs: '*.log' },
  { re: /^\.(eslint|stylelint)cache$/, category: 'cache', reason: 'Linter cache', confidence: 'high', regenerable: true, ignoreAs: null },
  { re: /^\.coverage$/, category: 'test-artifact', reason: 'Python coverage data', confidence: 'high', regenerable: true, ignoreAs: '.coverage' },
  { re: /\.pyc$/, category: 'cache', reason: 'Stray Python bytecode', confidence: 'high', regenerable: true, ignoreAs: '*.pyc' },
];
const COPY_RE = /^(.+?)(?: \(\d+\)| copy(?: \d+)?| - Copy(?: \(\d+\))?|[_-]copy\d*|\.copy)(\.[^.]+)?$/i;

const ENV_RE = /^\.env(?:[._\- (~].*)?$|^[\w-]+\.env(?:\.[\w-]+)?$/i;
const ENV_TEMPLATE_RE = /(^|[._-])(example|sample|template|dist|defaults?)([._-]|$)/i;
const ENV_STALE_RE = /(^|[._\- ])(bak|backup|old|orig|copy|save|saved|tmp|temp|swp|previous|prev|archive|unused)(\d*)$|~$|\(\d+\)$|\.\d{4}-?\d{2}-?\d{2}|\.\d{8,}$/i;
const ENV_TEST_RE = /^(\.env\.test(ing)?(\.local)?|test\.env)$/i;

// Patterns the 'gitignore-append' action may add. Anything else is refused.
const ENV_IGNORE = ['.env', '.env.*', '!.env.example'];
const IGNORE_OK = new Set([
  ...ENV_IGNORE,
  ...Object.values(CACHE_DIRS).map((c) => c.ignoreAs),
  ...FILE_RULES.map((r) => r.ignoreAs).filter(Boolean),
]);

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];
const SPLIT_DIRS = [['test', 'tests', '__tests__', 'spec'], ['doc', 'docs'], ['script', 'scripts'], ['example', 'examples'], ['asset', 'assets'], ['util', 'utils'], ['lib', 'libs']];
const MEDIA_RE = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|pdf)$/i;
const ARCHIVE_RE = /\.(zip|tar|tgz|tar\.gz|7z|rar)$/i;

const sha = async (p, size) => {
  if (size > MAX_HASH_BYTES) return null;
  try { return crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex'); } catch { return null; }
};

async function dirSize(p, budget = { n: 20000 }) {
  let total = 0;
  let ents;
  try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    if (budget.n-- <= 0) return total;
    if (e.isSymbolicLink()) continue;
    const c = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(c, budget);
    else { try { total += (await fsp.lstat(c)).size; } catch {} }
  }
  return total;
}

async function trackedSet(dir) {
  const r = await git(['ls-files', '-z'], { cwd: dir, timeout: 60000 });
  const files = new Set();
  const dirs = new Set();
  for (const f of r.stdout.split('\0')) {
    if (!f) continue;
    files.add(f);
    for (let i = f.lastIndexOf('/'); i > 0; i = f.lastIndexOf('/', i - 1)) {
      const d = f.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
    }
  }
  return { files, dirs };
}

async function ignoredSet(dir, paths) {
  if (!paths.length) return new Set();
  const r = await git(['check-ignore', '-z', '--stdin'], { cwd: dir, input: paths.join('\0') + '\0', timeout: 60000 });
  return new Set(r.stdout.split('\0').filter(Boolean)); // exit 1 (nothing ignored) just yields empty output
}

async function detectTests(dir) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch {}
  if (names.some((n) => /^(tests?|__tests__|spec|pytest\.ini|conftest\.py|tox\.ini)$/.test(n))) return true;
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
    const t = pkg.scripts && pkg.scripts.test;
    return !!t && !/no test specified/.test(t);
  } catch { return false; }
}

const envRank = (n) => (n === '.env' ? 0 : n === '.env.local' ? 1 : 2 + n.length);

async function scanClutter(dir) {
  const tracked = await trackedSet(dir);
  const hasTests = await detectTests(dir);
  const items = [];
  const trackedClutter = [];
  const liveEnv = []; // env files that are kept (rel paths)
  const root = { files: [], dirs: [], names: new Set() };
  let seen = 0;
  let truncated = false;

  const addItem = async (it) => {
    items.push({ ageDays: Math.max(0, Math.floor((Date.now() - it.mtime) / DAY)), regenerable: false, keep: null, ignoreAs: null, ...it, mode: it.regenerable ? 'delete' : 'trash' });
  };

  async function envInDir(abs, rel, names) {
    const files = [];
    for (const n of names) {
      const r = rel ? rel + '/' + n : n;
      if (tracked.files.has(r)) continue; // committed env files are reported as advice, never removed
      let st;
      try { st = await fsp.lstat(path.join(abs, n)); } catch { continue; }
      if (!st.isFile()) continue;
      files.push({ name: n, rel: r, size: st.size, mtime: st.mtimeMs, hash: st.size ? await sha(path.join(abs, n), st.size) : null });
    }
    const stale = files.filter((f) => ENV_STALE_RE.test(f.name));
    const live = files.filter((f) => !stale.includes(f));
    const flagged = new Set();
    const flag = (f, confidence, reason, keep = null) => {
      flagged.add(f);
      return addItem({ path: f.rel, name: f.name, kind: 'file', category: 'env', reason, confidence, size: f.size, mtime: f.mtime, keep, ignoreAs: null });
    };
    for (const f of stale) {
      const twin = f.hash && live.find((o) => o.hash === f.hash);
      if (twin) await flag(f, 'high', `Identical to ${twin.name}`, twin.rel);
      else await flag(f, 'medium', live.length ? 'Backup or copy that differs from the live env file: check before removing' : 'Stale backup with no live env file beside it');
    }
    const groups = new Map();
    for (const f of live) {
      if (f.size === 0) { await flag(f, 'medium', 'Empty env file'); continue; }
      if (f.hash) groups.set(f.hash, [...(groups.get(f.hash) || []), f]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => envRank(a.name) - envRank(b.name) || a.name.localeCompare(b.name));
      for (const f of g.slice(1)) await flag(f, 'medium', `Same contents as ${g[0].name}`, g[0].rel);
    }
    for (const f of live) {
      if (!flagged.has(f) && !hasTests && ENV_TEST_RE.test(f.name)) await flag(f, 'medium', 'Test env file, but this repo has no tests');
    }
    for (const f of live) if (!flagged.has(f)) liveEnv.push(f.rel);
  }

  async function walk(abs, rel, depth) {
    if (seen > MAX_FILES) { truncated = true; return; }
    let ents;
    try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    // Nested repos, git worktrees and virtualenvs are separate things: leave them alone.
    if (depth > 0 && ents.some((e) => e.name === '.git' || e.name === 'pyvenv.cfg')) return;
    if (depth === 0) {
      for (const e of ents) {
        root.names.add(e.name);
        if (e.isFile()) root.files.push(e.name);
        else if (e.isDirectory()) root.dirs.push(e.name);
      }
    }
    const fileNames = new Set(ents.filter((e) => e.isFile()).map((e) => e.name));
    const envNames = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        const rule = CACHE_DIRS[e.name];
        if (rule) {
          if (tracked.dirs.has(r)) { trackedClutter.push(r + '/'); continue; }
          const p = path.join(abs, e.name);
          let mtime = Date.now();
          try { mtime = (await fsp.lstat(p)).mtimeMs; } catch {}
          await addItem({ path: r, name: e.name, kind: 'dir', category: rule.category, reason: rule.reason, confidence: rule.sure ? 'high' : 'medium', size: await dirSize(p), mtime, regenerable: true, ignoreAs: rule.ignoreAs });
          continue;
        }
        if (NO_DESCEND.has(e.name) || depth + 1 > MAX_DEPTH) continue;
        await walk(path.join(abs, e.name), r, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      if (ENV_RE.test(e.name)) {
        if (!ENV_TEMPLATE_RE.test(e.name)) envNames.push(e.name);
        continue;
      }
      const rule = FILE_RULES.find((x) => x.re.test(e.name));
      const copy = !rule && COPY_RE.exec(e.name);
      if (!rule && !copy) continue;
      if (tracked.files.has(r)) { trackedClutter.push(r); continue; }
      let st;
      try { st = await fsp.lstat(path.join(abs, e.name)); } catch { continue; }
      const origName = rule ? rule.base && rule.base(e.name) : copy[1] + (copy[2] || '');
      const orig = origName && origName !== e.name && fileNames.has(origName) ? origName : null;
      let identical = false;
      if (orig) {
        try {
          const os = await fsp.lstat(path.join(abs, orig));
          identical = os.size === st.size && st.size <= MAX_HASH_BYTES && (await sha(path.join(abs, e.name), st.size)) === (await sha(path.join(abs, orig), os.size));
        } catch {}
      }
      const base = { path: r, name: e.name, kind: 'file', size: st.size, mtime: st.mtimeMs };
      if (rule) {
        await addItem({ ...base, category: rule.category, reason: identical ? `Identical to ${orig}` : rule.reason, confidence: identical || (rule.highWithBase && orig) ? 'high' : rule.confidence, regenerable: !!rule.regenerable, keep: orig ? (rel ? rel + '/' : '') + orig : null, ignoreAs: rule.ignoreAs });
      } else if (orig) {
        await addItem({ ...base, category: 'duplicate', reason: identical ? `Identical copy of ${orig}` : `Copy of ${orig} that has since diverged: review`, confidence: identical ? 'high' : 'low', keep: (rel ? rel + '/' : '') + orig });
      }
    }
    if (envNames.length) await envInDir(abs, rel, envNames);
  }

  await walk(dir, '', 0);

  // Ignore status decides confidence for ambiguous names and drives the .gitignore advice.
  const ignored = await ignoredSet(dir, [...items.map((i) => i.path), ...liveEnv]);
  for (const it of items) {
    it.ignored = ignored.has(it.path);
    if (it.ignored && it.confidence === 'medium' && (it.category === 'cache' || it.category === 'test-artifact')) it.confidence = 'high';
    // An ambiguous name (e.g. a folder called coverage that git does not ignore) might be real work: recoverable removal only.
    if (it.confidence !== 'high') it.mode = 'trash';
  }
  const envUnignored = liveEnv.filter((p) => !ignored.has(p));
  const order = { env: 0, duplicate: 1, backup: 2, temp: 3, junk: 4, cache: 5, 'test-artifact': 6, log: 7 };
  items.sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.path.localeCompare(b.path));

  const advice = buildAdvice({ items, trackedClutter, tracked, liveEnv, envUnignored, root });
  return { items, advice, count: items.length, totalSize: items.reduce((n, i) => n + i.size, 0), truncated };
}


function buildAdvice({ items, trackedClutter, tracked, liveEnv, envUnignored, root }) {
  const out = [];
  const add = (id, severity, title, detail, fix) => out.push({ id, category: 'Organisation', severity, title, detail, fix });

  const trackedEnv = [...tracked.files].filter((f) => ENV_RE.test(path.posix.basename(f)) && !ENV_TEMPLATE_RE.test(path.posix.basename(f)));
  if (trackedEnv.length)
    add('env-tracked', 'error', `${plural(trackedEnv.length, 'env file is', 'env files are')} committed to git`, `${list(trackedEnv)}. Anyone with access to the repo can read them, and history keeps them. Run "git rm --cached <file>", ignore them, and rotate any secrets they held.`);
  if (envUnignored.length)
    add('env-not-ignored', 'error', `${plural(envUnignored.length, 'env file is', 'env files are')} not git-ignored`, `${list(envUnignored)}. One careless "git add ." would commit your secrets.`, { type: 'gitignore-append', label: 'Add env rules to .gitignore', entries: ENV_IGNORE });
  const hasTemplate = [...root.names].some((n) => ENV_RE.test(n) && ENV_TEMPLATE_RE.test(n));
  if ((liveEnv.length || trackedEnv.length) && !hasTemplate)
    add('env-no-template', 'info', 'No .env.example', 'Commit a .env.example listing variable names (never values) so others know what to configure.');

  const unignored = items.filter((i) => !i.ignored && i.ignoreAs && ['cache', 'test-artifact', 'junk', 'temp', 'log', 'backup'].includes(i.category));
  const patterns = [...new Set(unignored.map((i) => i.ignoreAs))].filter((p) => IGNORE_OK.has(p));
  if (patterns.length)
    add('clutter-not-ignored', 'warn', `${plural(patterns.length, 'clutter pattern is', 'clutter patterns are')} not in .gitignore`, `${list(patterns, 8)}. Ignoring them stops the clutter coming back into commits.`, { type: 'gitignore-append', label: 'Add to .gitignore', entries: patterns });
  if (trackedClutter.length)
    add('tracked-clutter', 'warn', `${plural(trackedClutter.length, 'clutter file is', 'clutter files are')} committed`, `${list(trackedClutter)}. Untrack with "git rm --cached" and ignore them.`);

  const locks = LOCKFILES.filter((l) => root.names.has(l));
  if (locks.length > 1) add('multiple-lockfiles', 'warn', 'More than one lockfile', `${locks.join(', ')}. Pick one package manager and delete the others, or installs will drift apart.`);

  for (const group of SPLIT_DIRS) {
    const present = group.filter((n) => root.dirs.includes(n));
    if (present.length > 1) add('split-' + group[0], 'info', `Split folders: ${present.join(' and ')}`, `Merge them into one (\"${group[1]}\" is the common name).`);
  }

  const loose = root.files.filter((n) => !n.startsWith('.'));
  if (loose.length >= 20) add('root-sprawl', 'info', `${loose.length} loose files in the repo root`, 'Keep the root for config and README; move code into src/, helper scripts into scripts/ and notes into docs/.');
  const media = loose.filter((n) => MEDIA_RE.test(n));
  if (media.length >= 3) add('root-media', 'info', `${media.length} images/PDFs in the repo root`, `${list(media)}. Move them to docs/ or assets/.`);
  const archives = loose.filter((n) => ARCHIVE_RE.test(n));
  if (archives.length) add('root-archives', 'info', `${plural(archives.length, 'archive')} in the repo root`, `${list(archives)}. Archives rarely belong in git: keep them elsewhere or publish them as releases.`);
  return out;
}

// ---- Workspace-level advice (the folder that holds the repos) ----

const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle', 'CMakeLists.txt'];
const VARIANT_RE = /^(.+?)[-_. ](old|backup|bak|copy|copy\d*|tmp|temp|archive|archived|new|v?\d+)$/i;
const normRemote = (u) => (u || '').toLowerCase().replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, '$1/').replace(/^https?:\/\//, '').replace(/^[^@/]+@/, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
const nameStyle = (n) => (/\s/.test(n) ? 'spaces' : /[A-Z]/.test(n) && !/[-_]/.test(n) ? 'camelCase' : n.includes('_') && n.includes('-') ? 'mixed' : n.includes('_') ? 'snake_case' : /[A-Z]/.test(n) ? 'Mixed-Case' : 'kebab/lowercase');

async function workspaceAdvice(root, repos) {
  const out = [];
  const add = (id, severity, title, detail) => out.push({ id, category: 'Workspace', severity, title, detail });
  let ents = [];
  try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  const repoPaths = repos.map((r) => r.path);

  const looseFiles = ents.filter((e) => e.isFile() && !e.name.startsWith('.') && !/^readme/i.test(e.name)).map((e) => e.name);
  if (looseFiles.length) add('ws-loose-files', 'info', `${plural(looseFiles.length, 'loose file')} in the workspace root`, `${list(looseFiles)}. Keep the root for projects only: move these into a notes/ or _misc/ folder.`);
  const looseEnv = ents.filter((e) => e.isFile() && ENV_RE.test(e.name) && !ENV_TEMPLATE_RE.test(e.name)).map((e) => e.name);
  if (looseEnv.length) add('ws-loose-env', 'warn', 'Env files in the workspace root', `${list(looseEnv)}. They belong to no project and nothing in the workspace reads them.`);

  const untracked = [];
  const empty = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || NO_DESCEND.has(e.name)) continue;
    const abs = path.join(root, e.name);
    if (repoPaths.some((p) => p === abs || p.startsWith(abs + path.sep))) continue;
    let sub = [];
    try { sub = await fsp.readdir(abs); } catch { continue; }
    if (!sub.length) empty.push(e.name);
    else if (sub.some((n) => MANIFESTS.includes(n))) untracked.push(e.name);
  }
  if (untracked.length) add('ws-no-git', 'warn', `${plural(untracked.length, 'project')} without version control`, `${list(untracked)}. These look like projects but are not git repos: run "git init" or archive them.`);
  if (empty.length) add('ws-empty-dirs', 'info', `${plural(empty.length, 'empty folder')} in the workspace root`, `${list(empty)}. Safe to delete.`);

  const names = repos.map((r) => r.name);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const n of names) {
    const m = VARIANT_RE.exec(n);
    if (!m) continue;
    const base = lower.get(m[1].toLowerCase());
    if (base && base !== n) add('ws-variant-' + n, /^(old|backup|bak|copy\d*|tmp|temp|archived?)$/i.test(m[2]) ? 'warn' : 'info', `${n} looks like a copy of ${base}`, 'Two folders for one project drift apart. Keep one and archive or delete the other once you have checked nothing unique is in it.');
    else if (/^(old|backup|bak|copy|tmp|temp|archive|archived)$/i.test(m[2])) add('ws-stale-' + n, 'info', `${n} looks like an old or temporary repo`, 'Archive it on GitHub or delete it if it is finished with.');
  }

  const byRemote = new Map();
  for (const r of repos) {
    const k = normRemote(r.originUrl);
    if (k) byRemote.set(k, [...(byRemote.get(k) || []), r.name]);
  }
  for (const [k, ns] of byRemote) if (ns.length > 1) add('ws-dup-clone-' + k, 'warn', `${k.split('/').slice(1).join('/')} is cloned ${ns.length} times`, `${ns.join(', ')}. Keep one working copy per repository.`);

  if (names.length >= 5) {
    const styles = new Map();
    for (const n of names) styles.set(nameStyle(n), [...(styles.get(nameStyle(n)) || []), n]);
    const top = [...styles.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (styles.size > 1 && top[1].length / names.length < 0.8) add('ws-naming', 'info', 'Inconsistent folder naming', `Mixed styles: ${[...styles].map(([s, ns]) => `${s} (${ns.length})`).join(', ')}. Pick one convention (lowercase-kebab is the safest) for new repos.`);
  }
  return out;
}

module.exports = { scanClutter, workspaceAdvice, IGNORE_OK, ENV_IGNORE };
