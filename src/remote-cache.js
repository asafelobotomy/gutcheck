// GutCheck's own shallow clones of repos that are on GitHub but not in the workspace, under
// dataDir()/remote-cache/<owner>__<name>/ with <owner>__<name>.json beside it. Nothing from the repo
// can run: hooks, fsmonitor, every filter driver your own git config defines (LFS included) and the
// ext/fd/file transports are switched off on every clone and fetch, the URL is built here (never
// read from config), and a clone whose own config holds anything `clone` does not write is thrown
// away and cloned again instead of fetched into. Clones in progress live in .partial/, which
// eviction and clean-up never touch; a copy is replaced only once its new clone succeeded.

const fs = require('node:fs');
const path = require('node:path');
const { run: execRun, SAFE_GIT_ENV } = require('./exec');
const { remoteKeyFromDir } = require('./paths');
const { validRef } = require('./remote-settings');

const CLONE_CONFIG = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never', '-c', 'protocol.file.allow=never',
  '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
]);
const CLONE_ENV = Object.freeze({ ...SAFE_GIT_ENV, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' });
const TIMEOUT_MS = 5 * 60 * 1000;

const defaultUrlFor = (ref) => `https://github.com/${ref.owner}/${ref.name}.git`;
const keyOf = (ref) => `${ref.owner}/${ref.name}`;
const baseOf = (ref) => `${ref.owner}__${ref.name}`;

// git's first line, with any user[:password]@ removed from URLs.
const cleanError = (s) => (String(s || '').trim().split('\n')[0] || 'git failed').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]*@/gi, '$1').slice(0, 300);

// Keys `git clone --depth 1 --single-branch --no-tags --branch <b>` writes; anything else means
// something other than GutCheck changed the clone.
function configOk(entries, url, branch) {
  for (const [k, v] of entries) {
    if (/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/.test(k)) continue;
    if (k === 'extensions.objectformat') continue;
    if (k === 'remote.origin.url') { if (v !== url) return false; continue; }
    if (k === 'remote.origin.fetch' || k === 'remote.origin.tagopt') continue;
    if (k === `branch.${branch.toLowerCase()}.remote` || k === `branch.${branch.toLowerCase()}.merge`) continue;
    return false;
  }
  return true;
}

function treeBytes(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(p); } catch {}
  for (const e of names) n += treeBytes(path.join(p, e));
  return n;
}

// Every filter driver named in the user's global or system config: a remote repo's .gitattributes
// can point any of them at its files, so each is emptied for GutCheck's clone and fetch.
async function filterOverrides(run) {
  const names = new Set(['lfs']);
  for (const scope of ['--global', '--system']) {
    const r = await run('git', ['config', scope, '--includes', '--get-regexp', '^filter\\.'], { env: { ...SAFE_GIT_ENV }, timeout: 30000 });
    for (const line of (r.ok ? r.stdout : '').split('\n')) {
      const m = /^filter\.(.+)\.[a-z]+(?:\s|$)/i.exec(line);
      if (m) names.add(m[1]);
    }
  }
  return [...names].flatMap((n) => ['-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// deps: { root, run = exec.run, urlFor = defaultUrlFor, now = Date.now }
function createRemoteCache({ root, run = execRun, urlFor = defaultUrlFor, now = Date.now }) {
  const git = async (args, cwd) => run('git', [...CLONE_CONFIG, ...(await filterOverrides(run)), ...args], { cwd, env: { ...CLONE_ENV }, timeout: TIMEOUT_MS });

  async function readConfig(dir) {
    const r = await run('git', ['config', '--local', '-z', '--list'], { cwd: dir, env: { ...SAFE_GIT_ENV }, timeout: 30000 });
    if (!r.ok) return null;
    return r.stdout.split('\0').filter(Boolean).map((e) => { const i = e.indexOf('\n'); return i < 0 ? [e.toLowerCase(), ''] : [e.slice(0, i).toLowerCase(), e.slice(i + 1)]; });
  }

  function writeMeta(ref, meta) {
    fs.writeFileSync(path.join(root, baseOf(ref) + '.json'), JSON.stringify(meta));
  }

  // Clone into .partial/ and swap it in only once it worked, so a failed clone never costs the old copy
  // more than it already lost (sync only re-clones a copy it cannot use).
  async function clone(ref, listing, dir) {
    const partial = path.join(root, '.partial');
    const tmp = path.join(partial, `${baseOf(ref)}-${process.pid}`);
    rm(tmp);
    fs.mkdirSync(partial, { recursive: true });
    const r = await git(['clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', listing.defaultBranch, '--no-recurse-submodules', '--origin', 'origin', '--', urlFor(ref), tmp], root);
    if (!r.ok) { rm(tmp); return { ok: false, error: cleanError(r.stderr) }; }
    rm(dir);
    fs.renameSync(tmp, dir);
    const at = new Date(now()).toISOString();
    writeMeta(ref, { branch: listing.defaultBranch, pushedAt: listing.pushedAt || null, clonedAt: at, lastScannedAt: now(), bytes: treeBytes(dir) });
    return { ok: true, dir, fetched: true };
  }

  // listing: { owner, name, defaultBranch, pushedAt }. Resolves { ok, dir, fetched } or { ok: false, error }.
  async function sync(listing) {
    const ref = { owner: listing.owner, name: listing.name };
    if (!validRef(ref) || !listing.defaultBranch) return { ok: false, error: 'Unsupported repository' };
    const dir = path.join(root, baseOf(ref));
    const meta = readJSON(path.join(root, baseOf(ref) + '.json'));
    const usable = meta && meta.branch === listing.defaultBranch && fs.existsSync(path.join(dir, '.git'));
    if (!usable) return clone(ref, listing, dir);
    const cfg = await readConfig(dir);
    if (!cfg || !configOk(cfg, urlFor(ref), listing.defaultBranch)) return clone(ref, listing, dir);
    if (meta.pushedAt && listing.pushedAt && listing.pushedAt <= meta.pushedAt) {
      writeMeta(ref, { ...meta, lastScannedAt: now() });
      return { ok: true, dir, fetched: false };
    }
    const f = await git(['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', '--', listing.defaultBranch], dir);
    if (!f.ok) { // GitHub or the network failed: keep scanning the copy we have, and try again next scan
      writeMeta(ref, { ...meta, lastScannedAt: now() });
      return { ok: true, dir, fetched: false, stale: true };
    }
    const reset = await git(['reset', '-q', '--hard', 'FETCH_HEAD'], dir);
    if (!reset.ok) return clone(ref, listing, dir); // a broken clone is replaced, not patched
    writeMeta(ref, { ...meta, pushedAt: listing.pushedAt || null, lastScannedAt: now(), bytes: treeBytes(dir) });
    return { ok: true, dir, fetched: true };
  }

  // The cache's own entries: [{ key, ref, dir, json, lastScannedAt }]; anything else in root is left alone.
  function entries() {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    const out = new Map();
    for (const e of names) {
      const base = e.isDirectory() ? e.name : e.isFile() && e.name.endsWith('.json') ? e.name.slice(0, -5) : null;
      const ref = base && remoteKeyFromDir(base);
      if (!ref) continue;
      const k = keyOf(ref);
      if (!out.has(k)) out.set(k, { key: k, ref, dir: path.join(root, base), json: path.join(root, base + '.json') });
    }
    for (const x of out.values()) {
      const m = readJSON(x.json);
      x.lastScannedAt = (m && Number(m.lastScannedAt)) || 0;
      x.bytes = m && Number(m.bytes) > 0 ? Number(m.bytes) : null; // recorded after each clone or fetch
    }
    return [...out.values()];
  }
  const bytesOf = (x) => (x.bytes != null ? x.bytes : treeBytes(x.dir)); // a walk only for copies made before sizes were recorded
  const drop = (x) => { rm(x.dir); rm(x.json); };
  const inKeep = (keep, k) => keep && (keep.has(k) || keep.has(k.toLowerCase()));

  const sizeBytes = () => entries().reduce((n, x) => n + bytesOf(x), 0);

  // Make room for needBytes under maxBytes, oldest scan first. Returns the keys deleted.
  function evictFor(needBytes, maxBytes, keep = new Set()) {
    const list = entries().map((x) => ({ ...x, bytes: bytesOf(x) }));
    let total = list.reduce((n, x) => n + x.bytes, 0);
    const gone = [];
    for (const x of list.sort((a, b) => a.lastScannedAt - b.lastScannedAt)) {
      if (total + needBytes <= maxBytes) break;
      if (inKeep(keep, x.key)) continue;
      drop(x);
      total -= x.bytes;
      gone.push(x.key);
    }
    return gone;
  }

  function cleanup(keep = new Set()) {
    const gone = [];
    for (const x of entries()) if (!inKeep(keep, x.key)) { drop(x); gone.push(x.key); }
    return gone;
  }

  const clear = () => { for (const x of entries()) drop(x); };

  return { sync, sizeBytes, evictFor, cleanup, clear, root };
}

module.exports = { createRemoteCache, defaultUrlFor, CLONE_CONFIG, cleanError };
