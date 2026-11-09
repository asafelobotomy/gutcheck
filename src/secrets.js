// Read-only discovery of local dev secrets that are not committed: repo files (ignored or
// untracked), loose .env files in the workspace root, and a fixed list of home-folder credentials.
//
// Never runs a vault CLI or repo code. Reads headers and hashes files; contents are never returned,
// logged or kept beyond the sha256 and (for OpenSSH keys) the public-key fingerprint.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { git } = require('./exec');
const { COMMAND_TIMEOUT_MS, HEAVY_DIRS } = require('./util');
const P = require('./secret-patterns');

const MAX_FILES = 40000;
const MAX_DEPTH = 6;
const NO_DESCEND = new Set([...HEAVY_DIRS, '.git', '.venv', 'venv', '.next', '.nuxt', '.svelte-kit', '.cxx', '.gradle']);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

// Item titles name their scope with one of three fixed words, so no two scopes share a title:
// "gutcheck: repo <label>/<rel>", "gutcheck: home ~/<rel>", "gutcheck: root <name>".
const TITLE = {
  repo: (label, rel) => `gutcheck: repo ${label}/${rel}`,
  home: (rel) => `gutcheck: home ~/${rel}`,
  root: (name) => `gutcheck: root ${name}`,
};

// git ls-files -s prints about 70 bytes a path, three times plain ls-files: a big buffer, so a large
// repo isn't silently skipped. An overflow is reported (see findRepoSecrets), never read as "nothing".
const LS_MAX_BUFFER = 128 * 1024 * 1024;

// The tracked paths, and the gitlinks (submodules, mode 160000) among them. Read-only, via exec.git.
// { error } when the list could not be read: fail closed, as an unknown tracked set must never make
// committed files look unbacked.
async function trackedFiles(dir, maxBuffer = LS_MAX_BUFFER) {
  const r = await git(['ls-files', '-s', '-z'], { cwd: dir, timeout: COMMAND_TIMEOUT_MS, maxBuffer });
  if (!r.ok) return { error: /maxBuffer/i.test(r.stderr) ? 'too many tracked files for git ls-files' : null };
  const tracked = new Set();
  const gitlinks = new Set();
  for (const rec of r.stdout.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const p = rec.slice(tab + 1);
    tracked.add(p);
    if (rec.startsWith('160000 ')) gitlinks.add(p);
  }
  return { tracked, gitlinks };
}

// A checkout of its own: .git is a folder (or a link to one), or a file whose first line is "gitdir: "
// (a submodule or a worktree). Any other .git entry is just a file.
async function isCheckout(abs) {
  const g = path.join(abs, '.git');
  try {
    const st = await fsp.stat(g);
    if (st.isDirectory()) return true;
    if (!st.isFile() || st.size > 4096) return false;
    return (await fsp.readFile(g, 'utf8')).startsWith('gitdir: ');
  } catch { return false; }
}

// Build a candidate for one regular file, or null (too big, unreadable, not a file).
async function makeCandidate({ real, scope, repo, rel, title, inSshDir = false, onlyKind = null, gate = null }) {
  try {
    const st = await fsp.stat(real);
    if (!st.isFile() || st.size > P.MAX_SECRET_BYTES) return null;
    const buf = await fsp.readFile(real);
    const text = buf.toString('utf8');
    if (gate && !gate(text)) return null;
    const first = text.split('\n')[0];
    const head = P.classifyHead(first, { inSshDir, name: path.basename(rel || real) }); // the name as found (a link's own name)
    if (onlyKind && head !== onlyKind) return null;
    const fp = head === 'ssh' ? P.opensshFingerprint(text) : null;
    return {
      abs: real, real, scope, repo, rel, title, size: st.size, sha256: sha256(buf),
      kind: head || 'file', fingerprint: fp ? fp.fingerprint : null, keyType: fp ? fp.type : null,
      confidence: scope === 'repo' && P.isFixturePath(rel) ? 'low' : 'high',
    };
  } catch { return null; }
}

// The checkout's git dir, resolved (a .git link or "gitdir: ../.git" can lead back to a parent's).
async function gitDir(dir) {
  const r = await git(['rev-parse', '--absolute-git-dir'], { cwd: dir, timeout: COMMAND_TIMEOUT_MS });
  const d = r.ok ? r.stdout.trim() : '';
  if (!d) return null;
  try { return await fsp.realpath(d); } catch { return d; }
}

// opts.name: the repo's label in titles and advice (default: the folder name). Callers pass the path
// relative to the workspace root, so two nested repos named alike never share a vault item title.
// opts.problems: an array that gets { repo, error } when a tracked list could not be read.
// A submodule, nested clone or worktree checkout inside the repo is scanned as its own repo (its own
// ls-files), with titles under the parent's label; the file and depth limits are shared.
async function findRepoSecrets(dir, { name, problems = null, maxBuffer = LS_MAX_BUFFER } = {}) {
  let top;
  try { top = await fsp.realpath(dir); } catch { return []; }
  const repo = typeof name === 'string' && name ? name : path.basename(dir);
  const found = new Map(); // real path -> candidate
  const budget = { seen: 0 };

  // root: this checkout's folder; prefix: its path under the top repo ('' or 'libs/sub/');
  // gitDirs: the git dirs of this checkout and the ones around it.
  async function scanCheckout(root, prefix, depth0, gitDirs) {
    const idx = await trackedFiles(root, maxBuffer);
    if (!idx.tracked) {
      const where = prefix ? `${repo}/${prefix.slice(0, -1)}` : repo;
      if (problems) problems.push({ repo, error: `Secrets not checked in ${where}: ${idx.error || 'git could not list its tracked files'}.` });
      return;
    }
    const { tracked, gitlinks } = idx;
    // A folder that is a gitlink or a checkout is another repo: its files are committed or ignored
    // there, so this one never reports them (they are scanned as that repo's own). A checkout whose git
    // dir is this one's (or an outer one's) is just a folder of it.
    const nested = new Map(); // rel folder -> boolean
    const otherRepo = async (abs) => await isCheckout(abs) && !gitDirs.has(await gitDir(abs));
    const isNested = async (relDir) => {
      if (!nested.has(relDir)) nested.set(relDir, gitlinks.has(relDir) || await otherRepo(path.join(root, relDir)));
      return nested.get(relDir);
    };
    const inNested = async (rel) => {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) if (await isNested(parts.slice(0, i).join('/'))) return true;
      return false;
    };

    const consider = async (abs) => {
      let real;
      try { real = await fsp.realpath(abs); } catch { return; }
      const rel = posix(path.relative(root, real));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // target outside this checkout
      if (tracked.has(rel) || found.has(real) || await inNested(rel)) return; // a link may point into a submodule
      const relTop = prefix + rel;
      const c = await makeCandidate({ real, scope: 'repo', repo, rel: relTop, title: TITLE.repo(repo, relTop) });
      if (c) found.set(real, c);
    };

    const walk = async (d, depth, relDir) => {
      let ents;
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (++budget.seen > MAX_FILES) return;
        const rel = relDir + e.name;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) {
          if (depth >= MAX_DEPTH || NO_DESCEND.has(e.name)) continue;
          if (!await isNested(rel)) await walk(abs, depth + 1, rel + '/');
          else if (await isCheckout(abs)) { // a gitlink with no checkout is empty
            const own = await gitDir(abs);
            if (own && gitDirs.has(own)) continue; // a gitlink folder pointing back at an outer git dir
            await scanCheckout(abs, `${prefix}${rel}/`, depth + 1, own ? new Set([...gitDirs, own]) : gitDirs);
          }
        } else if ((e.isFile() || e.isSymbolicLink()) && P.looksSecret(rel)) {
          await consider(abs);
        }
      }
    };
    await walk(root, depth0, '');
  }

  const own = await gitDir(top);
  await scanCheckout(top, '', 0, new Set(own ? [own] : []));
  return [...found.values()];
}

async function findWorkspaceSecrets(root) {
  let ents;
  try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const e of ents) {
    if (!/^\.env/i.test(e.name) || !P.looksSecret(e.name) || e.isDirectory()) continue;
    let real;
    try { real = await fsp.realpath(path.join(root, e.name)); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const c = await makeCandidate({ real, scope: 'workspace', repo: null, rel: e.name, title: TITLE.root(e.name) });
    if (c) out.push(c);
  }
  return out;
}

const NPM_AUTH = /^\s*[^#;].*(_authToken|_auth)\s*=/m;
const dockerHasAuth = (text) => {
  try {
    const a = JSON.parse(text).auths;
    return !!a && typeof a === 'object' && Object.values(a).some((v) => v && typeof v === 'object' && 'auth' in v);
  } catch { return false; }
};

async function findHomeSecrets({ home, env = {} }) {
  if (!home) return [];
  const cfg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const out = [];
  // `at` is where the file is looked for; a dotfiles symlink (stow, chezmoi, yadm) is followed, so the
  // candidate's `real` is the target (what apply reads) while its name stays ~/<rel> of the link.
  const add = async (at, opts = {}) => {
    let real;
    try { real = await fsp.realpath(at); } catch { return; }
    const rel = posix(path.relative(home, at));
    const c = await makeCandidate({ real, scope: 'home', repo: null, rel, title: TITLE.home(rel), ...opts });
    if (c) out.push(c);
  };
  const entries = async (d) => { try { return await fsp.readdir(d, { withFileTypes: true }); } catch { return []; } };

  for (const e of await entries(path.join(home, '.ssh'))) {
    if (e.isFile() || e.isSymbolicLink()) await add(path.join(home, '.ssh', e.name), { inSshDir: true, onlyKind: 'ssh' });
  }
  await add(path.join(home, '.npmrc'), { gate: (t) => NPM_AUTH.test(t) });
  await add(path.join(home, '.docker', 'config.json'), { gate: dockerHasAuth });
  const plain = [['.pypirc'], ['.cargo', 'credentials'], ['.cargo', 'credentials.toml'], ['.netrc'], ['.pgpass'], ['.git-credentials'], ['.aws', 'credentials'], ['.kube', 'config']];
  for (const p of plain) await add(path.join(home, ...p));
  await add(path.join(cfg, 'gcloud', 'application_default_credentials.json'));
  for (const e of await entries(path.join(home, '.android'))) {
    if (/\.(?:keystore|jks)$/i.test(e.name)) await add(path.join(home, '.android', e.name));
  }
  const gpg = await gnupgCandidate(home);
  if (gpg) out.push(gpg);
  return out;
}

// One entry for the private-keys folder; its hash changes when a key is added or replaced.
async function gnupgCandidate(home) {
  const dir = path.join(home, '.gnupg', 'private-keys-v1.d');
  try {
    const names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
    if (!names.length) return null;
    const lines = [];
    let size = 0;
    for (const n of names) { const s = (await fsp.stat(path.join(dir, n))).size; size += s; lines.push(`${n}:${s}`); }
    const rel = '.gnupg/private-keys-v1.d';
    return { abs: dir, real: dir, scope: 'home', repo: null, rel, title: TITLE.home(rel), size, sha256: sha256(lines.join('\n')), kind: 'file', fingerprint: null, keyType: null, confidence: 'high' };
  } catch { return null; }
}

module.exports = { TITLE, findRepoSecrets, findWorkspaceSecrets, findHomeSecrets };
