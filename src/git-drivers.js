// Filter and diff drivers named in a repo's own config are programs git runs on its own: `git
// status` runs a clean filter on a stat-dirty file (audit B1), `git blame` runs textconv (B3). The
// driver names are per repo, so no fixed -c option can reach them. Before a scan's git call we
// read them (reading config runs nothing) and blank every one that does not come from the user's
// own config: global, system, or the command line (GIT_CONFIG_PARAMETERS). That covers the repo's
// local and worktree config and any file it pulls in with include.path or includeIf.
//
// Trust is decided by value, not by file: a repo key whose value is the same as that key's global
// or system value is kept, since it runs nothing the user's own config would not. So `git lfs
// install --local` next to a global `git lfs install` keeps working. Drivers that exist only in
// the repo's config, such as git-crypt's, are deliberately disabled during scans: a scan cannot
// tell them from an attacker's. This needs only --show-origin (git 2.8), not --show-scope (2.26).
//
// An empty clean, smudge or process value is treated by git as "no driver", and required=false
// stops git refusing instead. An empty textconv or diff command makes git fail the command ("cannot
// run"): nothing runs, so it fails closed; blame passes --no-textconv so it keeps working.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEYS = '^((filter|diff)\\..+\\.(clean|smudge|process|textconv|command|required)|extensions\\.partialclone|remote\\..+\\.promisor|include\\.path|includeif\\..+\\.path)$';
const DRIVER_RE = /^(filter|diff)\.(.+)\.(clean|smudge|process|textconv|command|required)$/;
// A scan makes dozens of git calls per repo within a few seconds; 15 s covers one repo's scan.
// The repo's config files, HEAD (for includeIf onbranch:) and every included file are watched
// too, and scans and actions drop a repo's entry before they start (forget).
const DRIVER_TTL_MS = 15000;
const MAX_ENTRIES = 500;
// GIT_NO_LAZY_FETCH (git 2.44) stops a partial clone fetching missing objects, which would run
// the repo's remote.<r>.uploadpack, core.sshCommand or credential helper during a scan.
const LAZY_FETCH_GIT = [2, 44];

// The files that decide a repo's config, found from cwd without running git.
function repoFiles(cwd) {
  for (let dir = path.resolve(cwd), i = 0; i < 64; i++) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch {}
    if (st && st.isDirectory()) return ['config', 'config.worktree', 'HEAD'].map((f) => path.join(dotgit, f));
    if (st && st.isFile()) {
      try {
        const gitdir = path.resolve(dir, /^gitdir: (.*)$/m.exec(fs.readFileSync(dotgit, 'utf8'))[1].trim());
        let common = gitdir;
        try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch {}
        return [path.join(common, 'config'), path.join(gitdir, 'config.worktree'), path.join(gitdir, 'HEAD'), dotgit];
      } catch { return [dotgit]; }
    }
    const up = path.dirname(dir);
    if (up === dir) return [];
    dir = up;
  }
  return [];
}

// Changes when any of these files is written (mtime, size or inode). A few stat calls, no git.
const statSig = (files) => files.map((f) => {
  try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return `${f}:-`; }
}).join('|');

// `git config -z --show-origin` prints "origin\0key\nvalue\0" (no "\nvalue" for a bare key).
function entries(stdout) {
  const parts = stdout.split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf('\n');
    out.push({ origin: parts[i], key: nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl), value: nl < 0 ? null : parts[i + 1].slice(nl + 1) });
  }
  return out;
}

// Every config file the lookup saw, plus the files include keys point at (even ones whose
// includeIf is false now, so a later branch switch or edit is noticed).
function watchedFiles(cwd, all) {
  const files = new Set();
  const fileOf = (origin) => (origin.startsWith('file:') ? path.resolve(cwd, origin.slice(5)) : null);
  for (const e of all) {
    const f = fileOf(e.origin);
    if (f) files.add(f);
    if (/^include(if\..+)?\.path$/.test(e.key) && e.value) {
      const v = e.value.startsWith('~/') ? path.join(os.homedir(), e.value.slice(2)) : e.value;
      files.add(path.isAbsolute(v) ? v : path.resolve(f ? path.dirname(f) : cwd, v));
    }
  }
  return [...files];
}

const cmpVer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

// The -c options that blank every driver the user's own config does not also set to that value.
function overridesFrom(all, trusted, gitVersion) {
  const ok = new Set(trusted.map((e) => `${e.key}\n${e.value}`));
  const out = [];
  const required = new Set();
  for (const e of all) {
    if (e.origin === 'command line:' || ok.has(`${e.key}\n${e.value}`)) continue;
    if (e.key === 'extensions.partialclone' || (/^remote\..+\.promisor$/.test(e.key) && !/^(false|no|off|0)$/i.test(e.value || ''))) {
      if (cmpVer(gitVersion, LAZY_FETCH_GIT) < 0) throw new Error(`this repo is a partial clone, and git ${gitVersion.join('.')} cannot stop it fetching (git 2.44 or newer can)`);
      continue;
    }
    if (/^remote\./.test(e.key)) continue;
    const m = DRIVER_RE.exec(e.key);
    if (!m || m[3] === 'required') continue;
    // `-c name=value` splits at the first "=", so a driver whose name holds one cannot be blanked.
    if (e.key.includes('=')) throw new Error(`cannot switch off the git driver "${e.key.slice(0, 80)}" set in this repo's config`);
    out.push('-c', `${e.key}=`);
    if (m[1] === 'filter' && !required.has(m[2])) { required.add(m[2]); out.push('-c', `filter.${m[2]}.required=false`); }
  }
  return out;
}

module.exports = (run, READONLY_GIT, SAFE_ENV) => {
  const cache = new Map(); // cwd (+env) -> { at, sig, p, watched, watchedSig }
  let version = null;

  // [major, minor] of the git on PATH, asked once.
  const gitVersion = () => (version = version || run('git', ['--version'], { timeout: 15000 }).then((r) => {
    const m = /(\d+)\.(\d+)/.exec(r.stdout || '');
    if (!m) { version = null; throw new Error('could not tell which git version is installed'); }
    return [Number(m[1]), Number(m[2])];
  }));

  async function query(cwd, env, scope) {
    const r = await run('git', [...READONLY_GIT, 'config', '-z', '--show-origin', '--includes', ...scope, '--get-regexp', KEYS], { cwd, env: { ...env, ...SAFE_ENV }, timeout: 15000 });
    if (r.ok) return entries(r.stdout);
    if (r.code === 1 && !r.stdout) return []; // no such keys (or no such file)
    throw new Error(`could not read its filter and diff drivers (${(r.stderr || '').trim().split('\n')[0].slice(0, 120)})`);
  }

  async function lookup(cwd, env) {
    const [all, global, system, ver] = await Promise.all([query(cwd, env, []), query(cwd, env, ['--global']), query(cwd, env, ['--system']), gitVersion()]);
    return { overrides: overridesFrom(all, [...global, ...system], ver), watched: watchedFiles(cwd, all) };
  }

  // The -c options that blank this repo's own drivers. Rejects (never resolves to "no
  // protection") when the drivers cannot be read.
  function driverOverrides(cwd, env) {
    const key = env ? `${cwd}\0${JSON.stringify(env)}` : cwd;
    const now = Date.now();
    const sig = statSig(repoFiles(cwd));
    const hit = cache.get(key);
    if (hit && hit.sig === sig && now - hit.at < DRIVER_TTL_MS && (!hit.watched || statSig(hit.watched) === hit.watchedSig)) return hit.p;
    if (cache.size >= MAX_ENTRIES) for (const [k, v] of cache) if (now - v.at >= DRIVER_TTL_MS || cache.size >= MAX_ENTRIES) cache.delete(k);
    const entry = { at: now, sig, p: null, watched: null, watchedSig: null };
    entry.p = lookup(cwd, env).then((r) => { entry.watched = r.watched; entry.watchedSig = statSig(r.watched); return r.overrides; });
    cache.set(key, entry);
    entry.p.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return entry.p;
  }

  // Drop what is cached for a repo folder (and folders inside it): before a scan, after an action.
  function forget(dir) {
    const root = path.resolve(dir);
    for (const k of cache.keys()) { const c = path.resolve(k.split('\0')[0]); if (c === root || c.startsWith(root + path.sep)) cache.delete(k); }
  }

  return { driverOverrides, forget, DRIVER_TTL_MS };
};
