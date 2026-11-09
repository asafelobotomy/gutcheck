// Password manager adapters: argv builders, stdin encoders and output parsers only.
// Nothing here spawns a process. Secret contents only ever pass through encode(buf).
const fs = require('fs');
const os = require('os');
const path = require('path');

const BW_NOTE_MAX = 10000;
const ID_RE = /^[A-Za-z0-9_-]{20,}={0,2}$/;

const TOOL_INFO = {
  proton: { label: 'Proton Pass', live: true, unlockHint: 'Run "pass-cli login" in a terminal, then try again.' },
  '1password': { label: '1Password', live: false, unlockHint: 'Run "op signin" (or unlock the 1Password app with CLI integration), then try again.' },
  bitwarden: { label: 'Bitwarden', live: false, unlockHint: 'Run "bw unlock" and export BW_SESSION (or "bw login" first), then try again.' },
  keepassxc: { label: 'KeePassXC', live: false, unlockHint: 'Use a key-file-only database (no master password) and check the database and key file paths.' },
  pass: { label: 'pass', live: false, unlockHint: 'Run "pass init <gpg-id>" and make sure gpg-agent can unlock your key, then try again.' },
  gopass: { label: 'gopass', live: false, unlockHint: 'Run "gopass setup" and make sure gpg-agent can unlock your key, then try again.' },
};

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
const baseName = (rel) => path.basename(String(rel || 'file'));

// The title without "gutcheck: ", with every byte outside [A-Za-z0-9_./-] percent-encoded (UTF-8),
// "%" and "~" included, and the scope word as an "@" folder: "gutcheck: repo my app/.env" ->
// "@repo/my%20app/.env", "gutcheck: home ~/.netrc" -> "@home/%7E/.netrc", "gutcheck: root .env" ->
// "@root/.env". Injective: the encoding is, and the scope words are fixed and hold no "/". A title
// from before the scope words (still in an old record) is encoded whole, as it was then; that
// encoding writes "@" as "%40", so old names never meet the "@" folders.
function slug(title) {
  const hex = (b) => '%' + b.toString(16).toUpperCase().padStart(2, '0');
  const enc = (s) => s.replace(/[^\w./-]/gu, (ch) => [...Buffer.from(ch, 'utf8')].map(hex).join(''));
  const t = String(title).replace(/^gutcheck:\s*/, '');
  const m = /^(repo|home|root) ([\s\S]*)$/.exec(t);
  return m ? `@${m[1]}/${enc(m[2])}` : enc(t);
}

// UTF-8 text without NULs, else "base64:\n<b64>" (for text-only tools).
function textOf(buf) {
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (!t.includes('\0')) return t;
  } catch { /* not utf-8 */ }
  return 'base64:\n' + Buffer.from(buf).toString('base64');
}

// Status parsers return only fixed text in hint, never tool output.
function signedIn(id, test) {
  return ({ ok, stdout }) => {
    const good = !!ok && test(stdout);
    return { ok: good, locked: !good, hint: good ? '' : TOOL_INFO[id].unlockHint };
  };
}
const idFromJson = (stdout) => { const j = parseJson(stdout); return j && (j.id || j.uuid) || null; };
// null (not an empty set) when the output isn't the expected shape: verify then changes nothing.
const idsOf = (arr) => (Array.isArray(arr) ? new Set(arr.map((x) => x && x.id).filter(Boolean)) : null);
// Line-based listings (keepassxc ls, gopass ls --flat): text with no control characters.
const nameLines = (o) => (typeof o === 'string' && !/[\0-\x08\x0b-\x1f\x7f]/.test(o.replace(/\r\n/g, '\n')) ? lines(o) : null);

function make(id, bin, targetHelp, rest) {
  const nul = () => null;
  return { id, label: TOOL_INFO[id].label, bin, targetHelp, listCmd: nul, parseList: () => new Set(),
    fingerprintCmd: nul, parseFingerprint: nul, ...rest };
}

const proton = make('proton', 'pass-cli', 'Vault name', {
  statusCmd: () => ({ args: ['info', '--output', 'json'] }),
  parseStatus: signedIn('proton', (o) => { const j = parseJson(o); return !!(j && j.id); }),
  saveCmd(cand, vault) {
    const parseId = (o) => { const t = String(o || '').trim(); return ID_RE.test(t) ? t : null; };
    if (cand.kind === 'ssh') {
      return { key: cand.title, args: ['item', 'create', 'ssh-key', 'import', '--from-private-key', '/dev/stdin', '--title', cand.title, '--vault-name', vault],
        encode: (buf) => buf, stdinPath: true, parseId };
    }
    return { key: cand.title, args: ['item', 'create', 'note', '--vault-name', vault, '--from-template', '-'],
      encode: (buf) => JSON.stringify({ title: cand.title, note: textOf(buf), extra_fields: [] }), parseId };
  },
  listCmd: (vault) => ({ args: ['item', 'list', '--vault-name', vault, '--filter-state', 'active', '--output', 'json'] }),
  parseList: (o) => idsOf((parseJson(o) || {}).items),
  fingerprintCmd: (itemId, vault) => ({ args: ['ssh-agent', 'debug', '--vault-name', vault, '--item-id', itemId, '--output', 'json'] }),
  parseFingerprint: (o) => {
    const k = ((parseJson(o) || {}).valid_keys || [])[0];
    return k && typeof k.fingerprint === 'string' && k.fingerprint ? k.fingerprint : null;
  },
});

const onepassword = make('1password', 'op', 'Vault name', {
  statusCmd: () => ({ args: ['whoami', '--format', 'json'] }),
  parseStatus: signedIn('1password', () => true),
  saveCmd: (cand, vault) => ({
    key: cand.title,
    args: ['document', 'create', '-', '--title', cand.title, '--file-name', baseName(cand.rel), '--vault', vault, '--tags', 'gutcheck', '--format', 'json'],
    encode: (buf) => buf, parseId: idFromJson,
  }),
  listCmd: (vault) => ({ args: ['item', 'list', '--vault', vault, '--tags', 'gutcheck', '--format', 'json'] }),
  parseList: (o) => idsOf(parseJson(o)),
});

const bitwarden = make('bitwarden', 'bw', 'Folder ID (optional)', {
  statusCmd: () => ({ args: ['status'] }),
  parseStatus({ ok, stdout }) {
    const st = ok ? (parseJson(stdout) || {}).status : null;
    if (st === 'unlocked') return { ok: true, locked: false, hint: '' };
    if (st === 'locked') return { ok: false, locked: true, hint: TOOL_INFO.bitwarden.unlockHint };
    if (st === 'unauthenticated') return { ok: false, locked: true, hint: 'Run "bw login", then "bw unlock" and export BW_SESSION, then try again.' };
    return { ok: false, locked: false, hint: TOOL_INFO.bitwarden.unlockHint };
  },
  saveCmd(cand, folderId) {
    if (cand.size > BW_NOTE_MAX) {
      return { error: `Bitwarden notes are limited to 10,000 characters; this file is ${cand.size}. Use 1Password or KeePassXC, which take attachments.` };
    }
    return {
      key: cand.title,
      args: ['create', 'item'],
      encode(buf) {
        const notes = textOf(buf);
        if (notes.length > BW_NOTE_MAX) throw new Error('Bitwarden notes are limited to 10,000 characters.');
        const item = { type: 2, secureNote: { type: 0 }, name: cand.title, notes, folderId: folderId || null };
        return Buffer.from(JSON.stringify(item)).toString('base64');
      },
      parseId: idFromJson,
    };
  },
  syncCmd: () => ({ args: ['sync'] }),
  listCmd: (folderId) => ({ args: folderId ? ['list', 'items', '--folderid', folderId] : ['list', 'items'] }),
  parseList: (o) => idsOf(parseJson(o)),
});

// KeePassXC: key-file-only database, group/title entry paths, no ids.
const kpBase = (t) => ['--no-password', '-k', t.keyFile, t.db];
// One flat entry per file: the slug with "/" encoded too ("%" already is), so names stay distinct.
const kpEntry = (cand, t) => `${(t.group || 'gutcheck').replace(/\/+$/, '')}/${slug(cand.title).replace(/\//g, '%2F')}`;
const keepassxc = make('keepassxc', 'keepassxc-cli', 'Path to the .kdbx file, its key file and a group', {
  statusCmd: (t) => ({ args: ['ls', ...kpBase(t)] }),
  parseStatus: ({ ok }) => ({ ok: !!ok, locked: !ok, hint: ok ? '' : TOOL_INFO.keepassxc.unlockHint }),
  named: true,
  // { update, itemId }: the entry this file was saved to before. It exists, so no add, and -f
  // replaces the attachment (attachment-import refuses an existing one without it).
  saveCmd(cand, t, o = {}) {
    const { update = false, itemId = null } = o;
    const entry = update && itemId ? itemId : kpEntry(cand, t) + suffixOf(o);
    const [noPw, k, key, db] = kpBase(t);
    const imp = { args: ['attachment-import', ...(update ? ['-f'] : []), noPw, k, key, db, entry, baseName(cand.rel), '/dev/stdin'], stdin: true, stdinPath: true, encode: (buf) => buf };
    return { key: entry, steps: update ? [imp] : [{ args: ['add', noPw, k, key, db, entry] }, imp], parseId: () => entry };
  },
  listCmd: (t) => ({ args: ['ls', '-R', '-f', ...kpBase(t), (t.group || 'gutcheck').replace(/\/+$/, '')] }),
  parseList(o, t) {
    const g = ((t && t.group) || 'gutcheck').replace(/\/+$/, '');
    const ls = nameLines(o);
    if (!ls) return null;
    const out = new Set();
    for (const l of ls) if (!l.endsWith('/')) { out.add(l); out.add(`${g}/${l}`); }
    return out;
  },
});

// { suffix }: "~" and 8 hex, added to a new name whose plain form a gone file's backup still holds.
// slug() writes "~" as %7E, so a suffixed name never equals a plain one.
const suffixOf = (o) => (o && /^~[0-9a-f]{8}$/.test(o.suffix || '') ? o.suffix : '');

function passLike(id, bin, insertFlags, extra) {
  const sub = (t) => String(t || '').replace(/^\/+|\/+$/g, '') || 'gutcheck';
  return make(id, bin, 'Subfolder (optional, default gutcheck)', {
    named: true,
    // A file saved before keeps its name (itemId); insert -f overwrites that item.
    saveCmd(cand, t, o = {}) {
      const { update = false, itemId = null } = o;
      const name = update && itemId ? itemId : `${sub(t)}/${slug(cand.title)}${suffixOf(o)}`;
      return { key: name, args: ['insert', ...insertFlags, name], encode: (buf) => textOf(buf), parseId: () => name };
    },
    ...extra,
  });
}

const pass = passLike('pass', 'pass', ['-m', '-f'], {
  statusCmd: () => ({ args: ['ls'] }),
  parseStatus: ({ ok }) => ({ ok: !!ok, locked: false, hint: ok ? '' : TOOL_INFO.pass.unlockHint }),
  existsFs(itemId, target, env) {
    const e = env || process.env;
    const store = e.PASSWORD_STORE_DIR || path.join(e.HOME || os.homedir(), '.password-store');
    try { return fs.statSync(path.join(store, `${itemId}.gpg`)).isFile(); } catch { return false; }
  },
});

const gopass = passLike('gopass', 'gopass', ['-f'], {
  statusCmd: () => ({ args: ['ls', '--flat'] }),
  parseStatus: ({ ok }) => ({ ok: !!ok, locked: false, hint: ok ? '' : TOOL_INFO.gopass.unlockHint }),
  listCmd: () => ({ args: ['ls', '--flat'] }),
  parseList: (o) => { const ls = nameLines(o); return ls ? new Set(ls) : null; },
});

// Where a tool's items live, in a comparable form: two links with equal stores share item names.
// pass and gopass: one store (the subfolder is part of each name); KeePassXC: the database's real path.
function storeOf(tool, t) {
  if (tool === 'pass' || tool === 'gopass') return '';
  if (tool !== 'keepassxc') return JSON.stringify(t == null ? '' : t);
  let db = t && typeof t === 'object' ? String(t.db || '') : '';
  try { db = fs.realpathSync(db); } catch { /* a missing database keeps its path */ }
  return db;
}
// A link's target, normalised: "", "gutcheck" and "/gutcheck/" are one pass folder, "g" and "g/" one group.
function targetKey(tool, t) {
  if (tool === 'pass' || tool === 'gopass') return String(t || '').replace(/^\/+|\/+$/g, '') || 'gutcheck';
  if (tool === 'keepassxc') return JSON.stringify([storeOf(tool, t), String((t && t.group) || 'gutcheck').replace(/\/+$/, '')]);
  return storeOf(tool, t);
}

const ADAPTERS = { proton, '1password': onepassword, bitwarden, keepassxc, pass, gopass };

module.exports = { storeOf, targetKey, ADAPTERS, TOOL_INFO, BW_NOTE_MAX, slug, textOf };
