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

async function trackedFiles(dir) {
  const r = await git(['ls-files', '-z'], { cwd: dir, timeout: COMMAND_TIMEOUT_MS });
  if (!r.ok) return null; // fail closed: an unknown tracked set must never make committed files look unbacked
  return new Set(r.stdout.split('\0').filter(Boolean));
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

// opts.name: the repo's label in titles and advice (default: the folder name). Callers pass the path
// relative to the workspace root, so two nested repos named alike never share a vault item title.
async function findRepoSecrets(dir, { name } = {}) {
  let root;
  try { root = await fsp.realpath(dir); } catch { return []; }
  const tracked = await trackedFiles(root);
  if (!tracked) return [];
  const repo = typeof name === 'string' && name ? name : path.basename(dir);
  const found = new Map(); // real path -> candidate
  let seen = 0;

  const consider = async (abs, relHere) => {
    let real;
    try { real = await fsp.realpath(abs); } catch { return; }
    const rel = posix(path.relative(root, real));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // target outside the repo
    if (tracked.has(rel) || found.has(real)) return;
    const c = await makeCandidate({ real, scope: 'repo', repo, rel, title: `gutcheck: ${repo}/${rel}` });
    if (c) found.set(real, c);
  };

  const walk = async (d, depth, prefix) => {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > MAX_FILES) return;
      const rel = prefix + e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !NO_DESCEND.has(e.name)) await walk(abs, depth + 1, rel + '/');
      } else if ((e.isFile() || e.isSymbolicLink()) && P.looksSecret(rel)) {
        await consider(abs, rel);
      }
    }
  };
  await walk(root, 0, '');
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
    const c = await makeCandidate({ real, scope: 'workspace', repo: null, rel: e.name, title: `gutcheck: workspace/${e.name}` });
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
    const c = await makeCandidate({ real, scope: 'home', repo: null, rel, title: `gutcheck: ~/${rel}`, ...opts });
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
    return { abs: dir, real: dir, scope: 'home', repo: null, rel, title: `gutcheck: ~/${rel}`, size, sha256: sha256(lines.join('\n')), kind: 'file', fingerprint: null, keyType: null, confidence: 'high' };
  } catch { return null; }
}

module.exports = { findRepoSecrets, findWorkspaceSecrets, findHomeSecrets };
