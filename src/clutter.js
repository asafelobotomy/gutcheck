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
const { DAY, COMMAND_TIMEOUT_MS, NODE_LOCKFILES, plural, list, HEAVY_DIRS } = require('./util');

const MAX_FILES = 40000;
const MAX_DEPTH = 6;
const MAX_HASH_BYTES = 5 * 1024 * 1024;
// Never descend into these: huge, owned by a tool, or not part of the source tree.
const NO_DESCEND = new Set([...HEAVY_DIRS, '.git', '.venv', 'venv', '.next', '.nuxt', '.svelte-kit', '.cxx', '.gradle']);

const { CACHE_DIRS, FILE_RULES, VENV_NAMES, buildOutput, bigDirSize, dirSize, STALE_LOG_DAYS, STALE_BACKUP_DAYS, SCRATCH_DIR_RE } = require('./clutter-rules');

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
  'target/',
  ...FILE_RULES.map((r) => r.ignoreAs).filter(Boolean),
]);

const LOCKFILES = NODE_LOCKFILES;
const SPLIT_DIRS = [['test', 'tests', '__tests__', 'spec'], ['doc', 'docs'], ['script', 'scripts'], ['example', 'examples'], ['asset', 'assets'], ['util', 'utils'], ['lib', 'libs']];
const MEDIA_RE = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|pdf)$/i;
const ARCHIVE_RE = /\.(zip|tar|tgz|tar\.gz|7z|rar)$/i;

const sameFile = async (a, b) => {
  try {
    const [x, y] = await Promise.all([fsp.lstat(a), fsp.lstat(b)]);
    return x.size === y.size && x.size <= MAX_HASH_BYTES && (await sha(a, x.size)) === (await sha(b, y.size));
  } catch { return false; }
};
const sha = async (p, size) => {
  if (size > MAX_HASH_BYTES) return null;
  try { return crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex'); } catch { return null; }
};


async function trackedSet(dir) {
  const r = await git(['ls-files', '-z'], { cwd: dir, timeout: COMMAND_TIMEOUT_MS });
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
  const r = await git(['check-ignore', '-z', '--stdin'], { cwd: dir, input: paths.join('\0') + '\0', timeout: COMMAND_TIMEOUT_MS });
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
  const nested = []; // git repos inside this one that are not submodules
  let seen = 0;
  let templateSeen = false;
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
    // A .git FILE is a linked worktree or a submodule checkout (it points back at a git dir): not a stray repo.
    if (depth > 0 && ents.some((e) => e.name === '.git')) { if (nested.length < 20 && ents.some((e) => e.name === '.git' && e.isDirectory())) nested.push(rel); return; }
    if (depth > 0 && ents.some((e) => e.name === 'pyvenv.cfg')) return;
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
        // Known caches keep their own label; virtualenvs (uv tags them too) are environments, not build output.
        const build = !CACHE_DIRS[e.name] && !VENV_NAMES.has(e.name) && !tracked.dirs.has(r) && await buildOutput(path.join(abs, e.name), e.name, fileNames, path.basename(abs));
        if (build) {
          const p = path.join(abs, e.name);
          let mtime = Date.now();
          try { mtime = (await fsp.lstat(p)).mtimeMs; } catch {}
          await addItem({ path: r, name: e.name, kind: 'dir', category: 'build', reason: `${build.reason}; rebuilt by ${build.rebuild}`, confidence: build.sure ? 'high' : 'medium', size: await bigDirSize(p), mtime, regenerable: true, costly: true, ignoreAs: build.ignoreAs });
          continue;
        }
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
        if (!ENV_TEMPLATE_RE.test(e.name)) envNames.push(e.name); else templateSeen = true; // a template anywhere in the repo counts
        continue;
      }
      const rule = FILE_RULES.find((x) => x.re.test(e.name));
      let copy = !rule && COPY_RE.exec(e.name);
      // A "copy" name is only a copy when the original sits beside it (fan_identity_copy.py with no
      // fan_identity.py is a module about copying, not a duplicate).
      if (copy && !fileNames.has(copy[1] + (copy[2] || ''))) copy = null;
      if (!rule && !copy) continue;
      if (tracked.files.has(r)) {
        // A committed copy that has diverged from its original is deliberate: only exact copies are clutter.
        if (!copy || (await sameFile(path.join(abs, e.name), path.join(abs, copy[1] + (copy[2] || ''))))) trackedClutter.push(r);
        continue;
      }
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
    if (it.ignored && it.confidence === 'medium' && (it.category === 'cache' || it.category === 'test-artifact' || it.category === 'build')) it.confidence = 'high';
    // Logs, temp files and backups git ignores are scratch output: old ones are stale, recent ones may still be in use.
    if (it.ignored && it.kind === 'file' && ['log', 'temp', 'backup'].includes(it.category) && it.confidence !== 'high') {
      const scratch = SCRATCH_DIR_RE.test(it.path);
      const stale = it.ageDays >= (it.category === 'backup' ? STALE_BACKUP_DAYS : STALE_LOG_DAYS);
      it.confidence = stale ? 'high' : 'medium';
      it.reason += `; git-ignored${scratch ? ' scratch folder' : ''}, ${stale ? `untouched for ${it.ageDays} days` : 'changed recently, may still be in use'}`;
    }
    // An ambiguous name (e.g. a folder called coverage that git does not ignore) might be real work: recoverable removal only.
    if (it.confidence !== 'high') it.mode = 'trash';
  }
  const envUnignored = liveEnv.filter((p) => !ignored.has(p));
  const order = { env: 0, duplicate: 1, backup: 2, temp: 3, junk: 4, cache: 5, 'test-artifact': 6, log: 7, build: 8 };
  items.sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.path.localeCompare(b.path));

  let gitmodules = '';
  try { gitmodules = await fsp.readFile(path.join(dir, '.gitmodules'), 'utf8'); } catch {}
  const subs = new Set([...gitmodules.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]));
  // Declared submodules and git-ignored folders (build areas, vendored checkouts) are deliberate.
  const nestedIgnored = await ignoredSet(dir, nested);
  const strays = nested.filter((n) => !subs.has(n) && !nestedIgnored.has(n));
  const advice = buildAdvice({ items, trackedClutter, tracked, liveEnv, envUnignored, root, nested: strays, templateSeen });
  return { items, advice, count: items.length, totalSize: items.reduce((n, i) => n + i.size, 0), truncated };
}


function buildAdvice({ items, trackedClutter, tracked, liveEnv, envUnignored, root, nested = [], templateSeen = false }) {
  const out = [];
  const add = (id, severity, title, detail, fix) => out.push({ id, category: 'Organisation', severity, title, detail, fix });

  const trackedEnv = [...tracked.files].filter((f) => ENV_RE.test(path.posix.basename(f)) && !ENV_TEMPLATE_RE.test(path.posix.basename(f)));
  if (trackedEnv.length)
    add('env-tracked', 'error', `${plural(trackedEnv.length, 'env file is', 'env files are')} committed to git`, `${list(trackedEnv)}. Anyone with access to the repo can read them, and history keeps them. Run "git rm --cached <file>", ignore them, and rotate any secrets they held.`);
  if (envUnignored.length)
    add('env-not-ignored', 'error', `${plural(envUnignored.length, 'env file is', 'env files are')} not git-ignored`, `${list(envUnignored)}. One careless "git add ." would commit your secrets.`, { type: 'gitignore-append', label: 'Add env rules to .gitignore', entries: ENV_IGNORE });
  const hasTemplate = templateSeen || [...root.names].some((n) => ENV_RE.test(n) && ENV_TEMPLATE_RE.test(n));
  if ((liveEnv.length || trackedEnv.length) && !hasTemplate)
    add('env-no-template', 'info', 'No .env.example', 'Commit a .env.example listing variable names (never values) so others know what to configure.');

  const unignored = items.filter((i) => !i.ignored && i.ignoreAs && ['cache', 'test-artifact', 'junk', 'temp', 'log', 'backup'].includes(i.category));
  const patterns = [...new Set(unignored.map((i) => i.ignoreAs))].filter((p) => IGNORE_OK.has(p));
  if (patterns.length)
    add('clutter-not-ignored', 'warn', `${plural(patterns.length, 'clutter pattern is', 'clutter patterns are')} not in .gitignore`, `${list(patterns, 8)}. Ignoring them stops the clutter coming back into commits.`, { type: 'gitignore-append', label: 'Add to .gitignore', entries: patterns });
  if (trackedClutter.length)
    add('tracked-clutter', 'warn', `${plural(trackedClutter.length, 'clutter file is', 'clutter files are')} committed`, `${list(trackedClutter)}. Untrack with "git rm --cached" and ignore them.`);

  if (nested.length)
    add('nested-repo', 'warn', `${plural(nested.length, 'git repository', 'git repositories')} inside this repo`, `${list(nested)}. This repo does not track their files, so they are easy to lose or commit by accident. Make each a submodule, or move it out.`);

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

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rs|go|rb|java|kt|c|cc|cpp|h|hpp|cs|php|swift|sh|lua|gd|dart|zig)$/i;
const NOTE_EXT = /\.(md|markdown|txt|rst|org|adoc|pdf|docx?|odt)$/i;

// What a folder without git holds, looking at most two levels down: 'code', 'notes' or null.
async function folderKind(abs, top) {
  const names = [...top];
  for (const n of top.slice(0, 50)) {
    if (n.startsWith('.') || NO_DESCEND.has(n)) continue;
    try { if ((await fsp.stat(path.join(abs, n))).isDirectory()) names.push(...(await fsp.readdir(path.join(abs, n))).slice(0, 200)); } catch {}
  }
  return names.some((n) => CODE_EXT.test(n)) ? 'code' : names.some((n) => NOTE_EXT.test(n)) ? 'notes' : null;
}

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
  const notes = [];
  const empty = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || NO_DESCEND.has(e.name)) continue;
    const abs = path.join(root, e.name);
    if (repoPaths.some((p) => p === abs || p.startsWith(abs + path.sep))) continue;
    let sub = [];
    try { sub = await fsp.readdir(abs); } catch { continue; }
    if (!sub.length) { empty.push(e.name); continue; }
    const kind = sub.some((n) => MANIFESTS.includes(n)) ? 'code' : await folderKind(abs, sub);
    if (kind === 'code') untracked.push(e.name);
    else if (kind === 'notes') notes.push(e.name);
  }
  if (untracked.length) add('ws-no-git', 'warn', `${plural(untracked.length, 'project')} without version control`, `${list(untracked)}. These look like projects but are not git repos: run "git init" or archive them.`);
  if (notes.length) add('ws-no-git-notes', 'info', `${plural(notes.length, 'folder')} of notes without version control`, `${list(notes)}. Documents only, not backed up anywhere: put them in a git repo (or the project they belong to) if you want to keep them.`);
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

module.exports = { scanClutter, workspaceAdvice, IGNORE_OK };
