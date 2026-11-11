// Scheduled scans and "what is new since the last scan". Each scan stores the ids of the findings it
// found (seen.json in the data folder, ids only, no details). The next scan's findings that were not in
// that set are new: the app notifies about those after a scheduled scan, and `gutcheck scan --new`
// prints only them (for a cron job or systemd timer). Ignored findings never count as new.

const fs = require('node:fs');
const { repoKey } = require('./policy');

const HOURS = [1, 3, 6, 12, 24, 72, 168]; // choices offered in Settings
const CHECK_EVERY_MS = 5 * 60 * 1000; // how often the app looks whether a scheduled scan is due
const HOUR = 60 * 60 * 1000;

const keyOf = (r, f) => `${repoKey(r)}|${f.id}`;

function findingKeys(results) {
  const keys = [];
  for (const r of results || []) if (!r.error) for (const f of r.findings || []) keys.push(keyOf(r, f));
  return keys;
}

// prev: array of keys, or null when nothing was stored yet (then nothing counts as new).
function newFindings(prev, results) {
  if (!Array.isArray(prev)) return [];
  const seen = new Set(prev);
  const out = [];
  for (const r of results || []) if (!r.error) for (const f of r.findings || []) if (!seen.has(keyOf(r, f))) out.push({ repo: r.name, id: f.id, severity: f.severity, title: f.title });
  return out;
}

// seen.json keeps one set of keys per workspace and depth ("<root>|deep" or "<root>|normal"): a deep
// scan finds more than a normal one, so comparing the two would report the difference as new.
const MAX_SETS = 20;
const failedRepo = (r) => !!(r.error || (r.remote && r.remote.unreachable));

function createSeenStore(file, io = fs) {
  const read = () => {
    try {
      const v = JSON.parse(io.readFileSync(file, 'utf8'));
      if (v && v.sets && typeof v.sets === 'object') return v;
      if (v && Array.isArray(v.keys) && v.root) return { sets: { [`${v.root}|normal`]: { ts: v.ts, keys: v.keys } } }; // older single-set file
    } catch {}
    return { sets: {} };
  };
  const load = (root, { deep = false } = {}) => read().sets[`${root}|${deep ? 'deep' : 'normal'}`] || null;
  // A repo whose scan failed, or whose GitHub data could not be fetched, keeps its previous keys, so
  // its findings do not all come back as new once it scans again.
  // carry(repoKey): keep the previous findings of those repos (a scan that could not see them).
  function record(root, results, { deep = false, carry = null } = {}) {
    const all = read();
    const id = `${root}|${deep ? 'deep' : 'normal'}`;
    const prev = all.sets[id];
    const fresh = prev ? newFindings(prev.keys, results.filter((r) => !failedRepo(r))) : [];
    const keys = findingKeys(results.filter((r) => !failedRepo(r)));
    if (prev) {
      // An unreachable remote changes repoKey to the folder name, so match the owner/name form too.
      const kept = new Set(results.filter(failedRepo).flatMap((r) => [repoKey(r), r.remote && r.remote.owner ? `${r.remote.owner}/${r.remote.name}` : null].filter(Boolean).map((k) => k + '|')));
      for (const k of prev.keys) if (kept.has(k.slice(0, k.lastIndexOf('|') + 1))) keys.push(k);
    }
    if (prev && carry) for (const k of prev.keys) if (carry(k.slice(0, k.lastIndexOf('|'))) && !keys.includes(k)) keys.push(k);
    all.sets[id] = { ts: Date.now(), keys };
    const ids = Object.keys(all.sets).sort((a, b) => all.sets[b].ts - all.sets[a].ts).slice(0, MAX_SETS);
    try { io.writeFileSync(file + '.tmp', JSON.stringify({ sets: Object.fromEntries(ids.map((k) => [k, all.sets[k]])) })); io.renameSync(file + '.tmp', file); } catch {}
    return { compared: !!prev, fresh };
  }
  return { load, record };
}

// settings.schedule: { enabled, hours }. lastTs: the last scheduled (or any) scan's time.
function normalizeSchedule(s) {
  const v = s && typeof s === 'object' ? s : {};
  return { enabled: v.enabled === true, hours: HOURS.includes(Number(v.hours)) ? Number(v.hours) : 24 };
}
const isDue = (now, lastTs, sched) => sched.enabled && (!lastTs || now - lastTs >= sched.hours * HOUR);

// One notification for a batch of new findings: warnings and errors only, the worst first, repos named.
function notification(all) {
  const fresh = (all || []).filter((f) => f.severity === 'error' || f.severity === 'warn');
  if (!fresh.length) return null;
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...fresh].sort((a, b) => order[a.severity] - order[b.severity]);
  const repos = [...new Set(sorted.map((f) => f.repo))];
  const errors = sorted.filter((f) => f.severity === 'error').length;
  return {
    title: `GutCheck: ${fresh.length} new finding${fresh.length === 1 ? '' : 's'}${errors ? ` (${errors} error${errors === 1 ? '' : 's'})` : ''}`,
    body: sorted.slice(0, 3).map((f) => `${f.repo}: ${f.title}`).join('\n') + (sorted.length > 3 ? `\n…in ${repos.length} repo${repos.length === 1 ? '' : 's'}` : ''),
  };
}

module.exports = { HOURS, CHECK_EVERY_MS, findingKeys, newFindings, createSeenStore, normalizeSchedule, isDue, notification };
