// The local record of which secret files were backed up, how each candidate compares to it,
// and the findings built from that. No vault I/O here. The record holds hashes and item ids,
// never contents, and is written 0600.
const fs = require('node:fs');
const path = require('node:path');
const { plural, list } = require('./util');

const fresh = () => ({ version: 1, entries: {}, skipped: {} });
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function createRecord(file, io = fs) {
  function load() {
    let v;
    try { v = JSON.parse(io.readFileSync(file, 'utf8')); } catch { return fresh(); }
    if (!isObject(v) || v.version !== 1) return fresh();
    return { version: 1, entries: isObject(v.entries) ? v.entries : {}, skipped: isObject(v.skipped) ? v.skipped : {} };
  }
  function save(rec) {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    io.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    io.chmodSync(tmp, 0o600); // an old temp file keeps its mode; rename keeps the temp's
    io.renameSync(tmp, file);
    try { io.chmodSync(file, 0o600); } catch {}
  }
  function update(fn) {
    const rec = load();
    fn(rec);
    save(rec);
    return rec;
  }
  return { load, save, update };
}

function statusOf(c, rec) {
  if (rec.skipped && rec.skipped[c.real]) return { status: 'skipped' };
  const e = rec.entries && rec.entries[c.real];
  if (e) {
    if (e.missing) return { status: 'missing' };
    if (e.mismatch) return { status: 'mismatch' };
    return { status: e.sha256 === c.sha256 ? 'backed' : 'changed' };
  }
  for (const [p, o] of Object.entries(rec.entries || {}))
    if (o.sha256 === c.sha256 && !o.missing && !o.mismatch) return { status: 'backed', sameAs: p };
  return { status: 'unbacked' };
}

const name = (c) => c.rel || c.title.replace(/^gutcheck: /, '');
const display = (c) => (c.scope === 'home' ? `~/${name(c)}` : name(c));

function group(cands, rec) {
  const unbacked = [], changed = [];
  for (const c of cands) {
    const { status } = statusOf(c, rec);
    if (status === 'changed') changed.push({ c, status });
    else if (status === 'unbacked' || status === 'missing' || status === 'mismatch') unbacked.push({ c, status });
  }
  return { unbacked, changed };
}

function build(id, items, rec, linked, repo) {
  if (!items.length) return null;
  const high = items.filter((i) => i.c.confidence !== 'low');
  const low = items.filter((i) => i.c.confidence === 'low');
  const changed = /changed$/.test(id);
  const n = high.length;
  let title;
  if (changed) title = `${plural(n || low.length, 'secret file')} changed since the last backup`;
  else title = `${plural(n || low.length, 'secret file')} ${(n || low.length) === 1 ? 'exists' : 'exist'} only on this machine`;
  const label = (i) => display(i.c) + (i.status === 'missing' ? ' (missing from the vault)' : i.status === 'mismatch' ? ' (key differs from the vault item)' : '');
  const parts = [];
  if (high.length) parts.push(list(high.map(label)));
  if (low.length) parts.push(`Probably test keys: ${list(low.map(label))}`);
  const advice = {
    id, category: 'Secrets', severity: n && !changed ? 'warn' : 'info', title,
    detail: parts.join('. '),
    fix: linked ? { type: 'secret-backup', paths: high.map((i) => i.c.real) } : { type: 'secret-link' },
  };
  if (repo) advice.repo = repo;
  return advice;
}

function secretAdvice(cands, rec, { linked } = {}) {
  const byRepo = new Map();
  const ws = [];
  for (const c of cands) {
    if (c.scope === 'repo' && c.repo) { if (!byRepo.has(c.repo)) byRepo.set(c.repo, []); byRepo.get(c.repo).push(c); } else ws.push(c);
  }
  const out = [];
  const add = (a) => { if (a) out.push(a); };
  for (const [repo, cs] of byRepo) {
    const g = group(cs, rec);
    add(build('secret-unbacked', g.unbacked, rec, linked, repo));
    add(build('secret-changed', g.changed, rec, linked, repo));
  }
  const g = group(ws, rec);
  add(build('ws-secret-unbacked', g.unbacked, rec, linked));
  add(build('ws-secret-changed', g.changed, rec, linked));
  return out;
}

module.exports = { createRecord, statusOf, secretAdvice };
