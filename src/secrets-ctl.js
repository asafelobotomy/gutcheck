// The secrets controller: the only module that runs a password manager CLI. It links a tool,
// scans for secret files, previews a backup (single-use token), applies it (each file read once,
// hashed, and piped on stdin only), verifies the record against the vault, and records skips.
// Contents never reach argv, env, results, audit entries, the plan display or the record.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const exec = require('./exec');
const { plural } = require('./util');
const { ADAPTERS, TOOL_INFO } = require('./vault-adapters');
const { findRepoSecrets, findWorkspaceSecrets, findHomeSecrets } = require('./secrets');
const { createRecord, statusOf, secretAdvice } = require('./secret-status');
const { MAX_SECRET_BYTES } = require('./secret-patterns');

const PLAN_TTL = 5 * 60 * 1000;
const VAULT_TIMEOUT = 60000;
const MCP_REFUSAL = 'Backing up secrets runs only from the GutCheck app or CLI.';
const CHANGED = 'Changed since the preview. Rescan and review it again.';
const NOT_LINKED = 'Link a password manager first (Settings).';
const SCAN_FIRST = 'Scan the workspace first.';
const lockedText = (l, s) => (s.locked ? `${l.info.label} is locked or not signed in. ` : '') + (s.hint || l.info.unlockHint);
const CLASH = (t) => `Two files would get the same vault item title: ${t}. Rename one or skip it.`;
const GOOGLE = { id: 'google', label: 'Google Password Manager', found: false, reason: 'No CLI or write API' };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const refused = (via) => (via === 'mcp' ? { ok: false, error: MCP_REFUSAL } : null);
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"');
const isText = (s) => typeof s === 'string' && s.length <= 300 && !/[\0-\x1f\x7f]/.test(s) && !s.startsWith('-');
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
// A repo's label in titles: its path under the workspace root (posix), else its folder name.
function repoLabel(repoPath, root) {
  const rel = root ? path.relative(path.resolve(root), path.resolve(repoPath)) : '';
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(repoPath);
}

// Normalise and validate a target for a tool; returns { ok, target } or { ok: false }.
function checkTarget(tool, t) {
  if (tool === 'keepassxc') {
    if (!t || typeof t !== 'object') return { ok: false };
    const group = t.group == null || t.group === '' ? 'gutcheck' : t.group;
    const abs = (p) => isText(p) && path.isAbsolute(p);
    return abs(t.db) && abs(t.keyFile) && isText(group) ? { ok: true, target: { db: t.db, keyFile: t.keyFile, group } } : { ok: false };
  }
  const s = t == null ? '' : t;
  if (s === '') return { ok: tool !== 'proton' && tool !== '1password', target: '' };
  return isText(s) && s.trim() ? { ok: true, target: s } : { ok: false };
}

// Remove every stderr line that holds a non-empty line of any source, or any 8+ character run
// from one. Runs are found by checking each 8-char window of a line against a Set of the
// sources' 8-char substrings, so a 1 MB file costs one pass, not a substring scan per line.
function scrub(text, ...sources) {
  const lines = String(text || '').slice(0, 65536).split('\n');
  if (!lines.some((l) => l.trim())) return '';
  const grams = new Set();
  const short = new Set();
  for (const src of sources) {
    const s = Buffer.isBuffer(src) ? src.toString('utf8') : String(src == null ? '' : src);
    for (let i = 0; i + 8 <= s.length; i++) grams.add(s.slice(i, i + 8));
    for (const l of s.split(/\r?\n/)) { const t = l.trim(); if (t && t.length < 8) short.add(t); }
  }
  const leaks = (line) => {
    for (let i = 0; i + 8 <= line.length; i++) if (grams.has(line.slice(i, i + 8))) return true;
    for (const t of short) if (line.includes(t)) return true;
    return false;
  };
  return lines.filter((l) => l.trim() && !leaks(l)).join('\n').trim();
}

// First executable regular file named `bin` on PATH (symlinks resolved), or null.
function findBin(bin, env) {
  for (const dir of String((env && env.PATH) || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    try {
      const real = fs.realpathSync(path.join(dir, bin));
      if (!fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* next */ }
  }
  return null;
}

function createSecretsCtl({ dataDir, settings, run = exec.run, env = process.env, home = os.homedir(), audit = () => {} }) {
  const record = createRecord(path.join(dataDir, 'secret-backups.json'));
  const plans = new Map();
  let last = null; // { repos, root } of the last scan
  // The workspace to guard against: opts when given, else the last scan's, else none (refuse).
  const workspace = ({ repos, root } = {}) => {
    const w = Array.isArray(repos) || typeof root === 'string' ? { repos: Array.isArray(repos) ? repos : [], root: typeof root === 'string' ? root : null } : last;
    return w && (w.repos.length || w.root) ? w : null;
  };
  const opts = (input) => ({ input, timeout: VAULT_TIMEOUT, env });

  function linked() {
    const v = (settings.load() || {}).vault;
    if (!v || !ADAPTERS[v.tool]) return null;
    const t = checkTarget(v.tool, v.target);
    return t.ok ? { tool: v.tool, target: t.target, a: ADAPTERS[v.tool], info: TOOL_INFO[v.tool] } : null;
  }

  // The tool's binary: a real executable on PATH inside no scanned repo and outside the
  // workspace root. Fails closed when the workspace isn't known.
  function checkBin(a, ws) {
    if (!ws) return { error: SCAN_FIRST };
    const real = findBin(a.bin, env);
    if (!real) return { error: `${a.bin} was not found on PATH.` };
    const dirs = [...ws.repos.filter((r) => r && typeof r.path === 'string'), ...(ws.root ? [{ path: ws.root, name: 'workspace root' }] : [])];
    for (const r of dirs) {
      let root;
      try { root = fs.realpathSync(r.path); } catch { root = path.resolve(r.path); }
      if (real === root || real.startsWith(root + path.sep)) {
        return { error: `${a.bin} resolves to ${real}, inside a scanned repo or the workspace (${r.name || path.basename(root)}). GutCheck will not run it.` };
      }
    }
    return { path: real };
  }

  async function status(l, bin) {
    const hint = l.info.unlockHint;
    if (l.tool === 'pass') {
      const store = env.PASSWORD_STORE_DIR || path.join(env.HOME || home, '.password-store');
      if (!isFile(path.join(store, '.gpg-id'))) return { ok: false, locked: false, hint };
    }
    const r = await run(bin, l.a.statusCmd(l.target).args, opts(''));
    if (!r.ok && r.code === null) return { ok: false, locked: true, hint };
    return l.a.parseStatus(r);
  }

  function tools() {
    return [...Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label, found: !!findBin(a.bin, env), live: !!TOOL_INFO[a.id].live })), { ...GOOGLE }];
  }

  function link({ tool, target } = {}) {
    if (!Object.prototype.hasOwnProperty.call(ADAPTERS, tool)) return { ok: false, error: 'Unknown password manager.' };
    const t = checkTarget(tool, target);
    if (!t.ok) return { ok: false, error: `Invalid target for ${TOOL_INFO[tool].label}: ${ADAPTERS[tool].targetHelp}.` };
    settings.update({ vault: { tool, target: t.target } });
    return { ok: true };
  }

  async function test(wsOpts) {
    const l = linked();
    if (!l) return { ok: false, locked: false, hint: NOT_LINKED };
    const bin = checkBin(l.a, workspace(wsOpts));
    if (bin.error) return { ok: false, locked: false, hint: bin.error };
    const s = await status(l, bin.path);
    return { ok: !!s.ok, locked: !!s.locked, hint: s.ok ? '' : s.hint || l.info.unlockHint };
  }

  // home: false leaves out the home folder (a one-repo report has no use for it).
  async function scan({ repos, root, home: withHome = true } = {}) {
    const list = (Array.isArray(repos) ? repos : []).filter((r) => r && typeof r.path === 'string');
    last = { repos: list, root: typeof root === 'string' ? root : null };
    const found = [];
    for (const r of list) found.push(...await findRepoSecrets(r.path, { name: repoLabel(r.path, last.root) }));
    if (last.root) found.push(...await findWorkspaceSecrets(last.root));
    if (withHome !== false) found.push(...await findHomeSecrets({ home, env }));
    const byReal = new Map();
    for (const c of found) if (!byReal.has(c.real)) byReal.set(c.real, c);
    const cands = [...byReal.values()];
    const rec = record.load();
    const l = linked();
    return {
      ok: true, linked: !!l, tool: l ? l.tool : null,
      items: cands.map((c) => ({ ...c, ...statusOf(c, rec) })),
      advice: secretAdvice(cands, rec, { linked: !!l }),
    };
  }

  async function plan(paths, { via, repos, root } = {}) {
    const no = refused(via);
    if (no) return no;
    const now = Date.now();
    for (const [k, p] of plans) if (now - p.at > PLAN_TTL) plans.delete(k);
    const l = linked();
    if (!l) return { ok: false, error: NOT_LINKED };
    const ws = workspace({ repos, root });
    const bin = checkBin(l.a, ws);
    if (bin.error) return { ok: false, error: bin.error };
    const wanted = new Set();
    for (const p of Array.isArray(paths) ? paths : []) {
      if (typeof p !== 'string') continue;
      wanted.add(p);
      try { wanted.add(fs.realpathSync(p)); } catch { /* gone */ }
    }
    const fresh = await scan(ws);
    const items = [];
    const display = [];
    for (const c of fresh.items) {
      if (!wanted.has(c.real) || c.status === 'backed' || c.status === 'skipped' || !isFile(c.real)) continue;
      const save = l.a.saveCmd(c, l.target);
      if (save.error) return { ok: false, error: save.error };
      items.push({ cand: c, sha256: c.sha256, save });
      const steps = save.steps || [save];
      steps.forEach((s, i) => {
        const cmd = [l.a.bin, ...s.args.map(quote)].join(' ');
        const tail = i === steps.length - 1 ? `  ← contents of ${c.title.replace(/^gutcheck: /, '')} (${c.size} bytes)` : '';
        display.push({ text: cmd + tail });
      });
    }
    if (!items.length) return { ok: false, error: 'Nothing to back up: those files are already backed up, skipped or no longer found.' };
    // One vault item per title: pass/gopass insert -f would overwrite an item another file owns.
    const owners = new Map(Object.entries(record.load().entries).map(([real, e]) => [e && e.title, real]));
    const titles = new Set();
    for (const { cand } of items) {
      const other = owners.get(cand.title);
      if (titles.has(cand.title) || (other && other !== cand.real)) return { ok: false, error: CLASH(cand.title) };
      titles.add(cand.title);
    }
    const token = 's:' + crypto.randomBytes(16).toString('hex');
    plans.set(token, { at: now, l, bin: bin.path, ws, items });
    const where = l.tool === 'keepassxc' ? `${l.target.db}, group ${l.target.group}` : l.target || 'default';
    return {
      ok: true, token, title: `Back up ${plural(items.length, 'secret file')} to ${l.info.label}`, risk: 'caution', display,
      note: `Copies the file's contents into ${l.info.label} (${where}). The local file is not changed.`,
    };
  }

  // Read the file once (no symlinks, 1 MB at most) and check it still matches the preview.
  async function readPlanned(it) {
    let st;
    try { st = await fsp.lstat(it.cand.real); } catch { return { error: 'The file is gone. Rescan and review it again.' }; }
    if (st.isSymbolicLink()) return { error: 'The file is now a symlink. GutCheck does not save through links.' };
    const notFile = { error: 'The file is no longer a regular file of 1 MB or less.' };
    if (!st.isFile() || st.size > MAX_SECRET_BYTES) return notFile; // a FIFO or device would block open/read
    let fh;
    try {
      const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
      fh = await fsp.open(it.cand.real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      if (!(await fh.stat()).isFile()) return notFile;
      const max = MAX_SECRET_BYTES + 1; // read at most one byte past the limit
      const big = Buffer.alloc(max);
      let n = 0;
      for (let r; n < max && (r = (await fh.read(big, n, max - n, null)).bytesRead) > 0;) n += r;
      if (n > MAX_SECRET_BYTES) return notFile;
      const buf = big.subarray(0, n);
      return sha256(buf) === it.sha256 ? { buf } : { error: CHANGED };
    } catch { return { error: 'Could not read the file.' }; } finally { if (fh) await fh.close().catch(() => {}); }
  }

  function failText(r, l, ...sources) {
    if (r.code === null && !/ENOENT|EACCES/.test(r.stderr || '')) {
      return `${l.info.label} did not answer within 60 seconds or was stopped; it may be locked or waiting for a prompt. ${l.info.unlockHint}`.slice(0, 300);
    }
    return scrub(r.stderr, ...sources).slice(0, 300) || `${l.info.label} exited with code ${r.code}.`;
  }

  async function saveOne(p, it) {
    const { l } = p;
    const { cand } = it;
    const text = `Back up ${cand.title} to ${l.info.label}`;
    const fail = (out) => ({ text, ok: false, out });
    const got = await readPlanned(it);
    if (got.error) return fail(got.error);
    const { buf } = got;
    const steps = it.save.steps || [it.save];
    let r;
    let input = '';
    for (const step of steps) {
      input = '';
      if (step.encode) {
        try { input = step.encode(buf); } catch (e) { return fail(String((e && e.message) || 'Could not prepare the file for the password manager.').slice(0, 300)); }
      }
      r = await run(p.bin, step.args, opts(input));
      if (!r || !r.ok) return fail(failText(r || { code: null, stderr: '' }, l, buf, input));
    }
    const itemId = it.save.parseId(r.stdout);
    if (!itemId) return fail(scrub(r.stderr, buf, input).slice(0, 300) || `${l.info.label} returned no item ID, so nothing was recorded.`);
    record.update((rec) => {
      const e = { sha256: it.sha256, tool: l.tool, target: l.target, itemId, title: cand.title, at: new Date().toISOString() };
      if (cand.kind === 'ssh' && cand.fingerprint && l.a.fingerprintCmd(itemId, l.target)) e.fingerprint = cand.fingerprint;
      rec.entries[cand.real] = e;
      delete rec.skipped[cand.real];
    });
    return { text, ok: true, out: '' };
  }

  async function apply(token, { via } = {}) {
    const no = refused(via);
    if (no) return { ...no, results: [] };
    const p = plans.get(token);
    plans.delete(token);
    if (!p || Date.now() - p.at > PLAN_TTL) return { ok: false, error: 'This preview expired or was already used. Preview it again.', results: [] };
    const bin = checkBin(p.l.a, p.ws);
    if (bin.error || bin.path !== p.bin) return { ok: false, error: bin.error || `${p.l.a.bin} changed since the preview. Preview it again.`, results: [] };
    const s = await status(p.l, p.bin); // a locked vault fails here with the fixed hint, before any save
    if (!s.ok) return { ok: false, error: lockedText(p.l, s), results: [] };
    const results = [];
    for (const it of p.items) {
      const r = await saveOne(p, it);
      results.push(r);
      audit({ ok: r.ok, repo: 'Secrets', title: `Backed up ${it.cand.title} to ${p.l.info.label}` });
      if (!r.ok) break;
    }
    return { ok: results.length === p.items.length && results.every((r) => r.ok), results };
  }

  async function verify({ via, repos, root } = {}) {
    const no = refused(via);
    if (no) return no;
    const l = linked();
    if (!l) return { ok: false, error: NOT_LINKED };
    const bin = checkBin(l.a, workspace({ repos, root }));
    if (bin.error) return { ok: false, error: bin.error };
    const s = await status(l, bin.path);
    if (!s.ok) return { ok: false, error: lockedText(l, s) };
    const lists = new Map();
    const updates = new Map();
    for (const [real, e] of Object.entries(record.load().entries)) {
      if (!e || e.tool !== l.tool) continue;
      let present;
      const lc = l.a.listCmd(e.target);
      if (lc) {
        const key = JSON.stringify(e.target == null ? '' : e.target);
        if (!lists.has(key)) {
          const r = await run(bin.path, lc.args, opts(''));
          if (!r.ok) return { ok: false, error: l.info.unlockHint };
          lists.set(key, l.a.parseList(r.stdout, e.target));
        }
        present = lists.get(key).has(e.itemId);
      } else if (l.a.existsFs) present = l.a.existsFs(e.itemId, e.target, env);
      else continue;
      let mismatch = false;
      const fc = present && e.fingerprint ? l.a.fingerprintCmd(e.itemId, e.target) : null;
      if (fc) {
        const r = await run(bin.path, fc.args, opts(''));
        const fp = r.ok ? l.a.parseFingerprint(r.stdout) : null;
        mismatch = !!fp && fp !== e.fingerprint;
      }
      updates.set(real, { missing: !present, mismatch });
    }
    record.update((rec) => {
      for (const [real, u] of updates) {
        const e = rec.entries[real];
        if (!e) continue;
        for (const k of ['missing', 'mismatch']) { if (u[k]) e[k] = true; else delete e[k]; }
      }
    });
    const vals = [...updates.values()];
    return { ok: true, checked: vals.length, missing: vals.filter((u) => u.missing).length, mismatch: vals.filter((u) => u.mismatch).length };
  }

  function skip(real, reason) {
    if (typeof real !== 'string' || !path.isAbsolute(real)) return { ok: false, error: 'Expected an absolute path.' };
    record.update((rec) => { rec.skipped[real] = { reason: String(reason || '').slice(0, 200), at: new Date().toISOString() }; });
    return { ok: true };
  }

  function unskip(real) {
    if (typeof real !== 'string') return { ok: false, error: 'Expected a path.' };
    record.update((rec) => { delete rec.skipped[real]; });
    return { ok: true };
  }

  return { tools, link, test, scan, plan, apply, verify, skip, unskip, PLAN_TTL };
}

module.exports = { createSecretsCtl, scrub, findBin, repoLabel, PLAN_TTL, MCP_REFUSAL };
