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

function createSeenStore(file, io = fs) {
  const load = () => { try { const v = JSON.parse(io.readFileSync(file, 'utf8')); return v && Array.isArray(v.keys) ? v : null; } catch { return null; } };
  // A scan of a different workspace has nothing to compare with: everything would look new.
  function record(root, results) {
    const prev = load();
    const fresh = prev && prev.root === root ? newFindings(prev.keys, results) : [];
    try { io.writeFileSync(file + '.tmp', JSON.stringify({ root, ts: Date.now(), keys: findingKeys(results) })); io.renameSync(file + '.tmp', file); } catch {}
    return { compared: !!(prev && prev.root === root), fresh };
  }
  return { load, record };
}

// settings.schedule: { enabled, hours }. lastTs: the last scheduled (or any) scan's time.
function normalizeSchedule(s) {
  const v = s && typeof s === 'object' ? s : {};
  return { enabled: v.enabled === true, hours: HOURS.includes(Number(v.hours)) ? Number(v.hours) : 24 };
}
const isDue = (now, lastTs, sched) => sched.enabled && (!lastTs || now - lastTs >= sched.hours * HOUR);

// One notification for a batch of new findings: the worst first, repos named.
function notification(fresh) {
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
