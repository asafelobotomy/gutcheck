// Filter and diff drivers named in a repo's own config are programs git runs on its own: `git
// status` runs a clean filter on a stat-dirty file (audit B1), `git blame` runs textconv (B3). The
// driver names are per repo, so no fixed -c option can reach them. Before a scan's git call we
// read them (reading config runs nothing) and blank every one that comes from the repo's local or
// worktree config, including files that config pulls in with include.path.
//
// Global and system drivers are left alone: git-lfs installs `filter.lfs.process` globally, and
// without it LFS repos would show every tracked file as changed. Drivers set locally on purpose,
// such as git-crypt's, are deliberately disabled during scans too: a scan cannot tell them from
// an attacker's.
//
// An empty clean, smudge or process value is treated by git as "no driver", and required=false
// stops git refusing instead. An empty textconv or diff command makes git fail the command ("cannot
// run"): nothing runs, so it fails closed; blame passes --no-textconv so it keeps working.
const fs = require('node:fs');
const path = require('node:path');

const DRIVER_KEYS = '^(filter|diff)\\..+\\.(clean|smudge|process|textconv|command|required)$';
const KEY_RE = /^(filter|diff)\.(.+)\.(clean|smudge|process|textconv|command|required)$/;
// A scan makes dozens of git calls per repo within a few seconds; 15 s covers one repo's scan,
// and a change to the repo's config file is noticed at once through its mtime.
const DRIVER_TTL_MS = 15000;
const MAX_ENTRIES = 500;

// The config files that decide a repo's local drivers, found from cwd without running git.
function configFiles(cwd) {
  for (let dir = path.resolve(cwd), i = 0; i < 64; i++) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch {}
    if (st && st.isDirectory()) return [path.join(dotgit, 'config'), path.join(dotgit, 'config.worktree')];
    if (st && st.isFile()) {
      try {
        const gitdir = path.resolve(dir, /^gitdir: (.*)$/m.exec(fs.readFileSync(dotgit, 'utf8'))[1].trim());
        let common = gitdir;
        try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch {}
        return [path.join(common, 'config'), path.join(gitdir, 'config.worktree'), dotgit];
      } catch { return [dotgit]; }
    }
    const up = path.dirname(dir);
    if (up === dir) return [];
    dir = up;
  }
  return [];
}

// Changes when any of those files is written (mtime, size or inode). A few stat calls, no git.
function configSig(cwd) {
  return configFiles(cwd).map((f) => {
    try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return `${f}:-`; }
  }).join('|');
}

// `git config -z --show-scope` prints "scope\0key\nvalue\0" (no "\nvalue" for a bare key).
function overridesFrom(stdout) {
  const parts = stdout.split('\0');
  const out = [];
  const required = new Set();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    const key = parts[i + 1].split('\n')[0];
    if (scope !== 'local' && scope !== 'worktree') continue;
    const m = KEY_RE.exec(key);
    // `-c name=value` splits at the first "=", so a driver whose name holds one cannot be blanked.
    if (!m || key.includes('=')) throw new Error(`cannot switch off the git driver "${key.slice(0, 80)}" set in this repo's config`);
    if (m[3] === 'required') continue;
    out.push('-c', `${key}=`);
    if (m[1] === 'filter' && !required.has(m[2])) { required.add(m[2]); out.push('-c', `filter.${m[2]}.required=false`); }
  }
  return out;
}

module.exports = (run, READONLY_GIT) => {
  const cache = new Map(); // cwd (+env) -> { at, sig, p }

  async function lookup(cwd, env) {
    const r = await run('git', [...READONLY_GIT, 'config', '-z', '--show-scope', '--includes', '--get-regexp', DRIVER_KEYS], { cwd, env, timeout: 15000 });
    if (r.ok) return overridesFrom(r.stdout);
    if (r.code === 1 && !r.stdout) return []; // no driver keys at all
    throw new Error(`could not read its filter and diff drivers (${(r.stderr || '').trim().split('\n')[0].slice(0, 120)})`);
  }

  // The -c options that blank this repo's local drivers. Rejects (never resolves to "no
  // protection") when the drivers cannot be read.
  function driverOverrides(cwd, env) {
    const key = env ? `${cwd}\0${JSON.stringify(env)}` : cwd;
    const now = Date.now();
    const sig = configSig(cwd);
    const hit = cache.get(key);
    if (hit && hit.sig === sig && now - hit.at < DRIVER_TTL_MS) return hit.p;
    if (cache.size >= MAX_ENTRIES) for (const [k, v] of cache) if (now - v.at >= DRIVER_TTL_MS || cache.size >= MAX_ENTRIES) cache.delete(k);
    const p = lookup(cwd, env);
    const entry = { at: now, sig, p };
    cache.set(key, entry);
    p.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return p;
  }

  return { driverOverrides, overridesFrom, configSig, DRIVER_TTL_MS };
};
