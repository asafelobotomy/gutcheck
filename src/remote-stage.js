// The second stage of a workspace scan: repos on GitHub that are not cloned in the workspace.
// List them, skip what the settings leave out, fetch their GitHub data in one batch, keep a shallow
// cache clone of each (remote-cache.js) and scan it (remote-scan.js). If GitHub cannot be reached
// the stage reports why and returns nothing, so the local scan stands on its own.

const github = require('./github');
const { listRemote, selectUncloned } = require('./remote-list');
const { scanRemote, ensureEmptyRepo } = require('./remote-scan');
const { fetchRemoteData } = require('./remote-branches');

const GB = 1024 ** 3;
const key = (r) => `${r.owner}/${r.name}`;
const idle = (o = {}) => ({ ran: false, error: null, included: 0, excluded: [], cloned: 0, cacheBytes: 0, ...o });

// The empty stand-in repo, made only when a repo has no copy to scan.
function lazyEmpty(root) {
  let p = null;
  return () => (p = p || ensureEmptyRepo(root));
}

async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}

// One repo: clone or refresh its copy (unless too large), then scan. ctx: { settings, cache, emptyDir(), ghRes, policy, keep }
async function scanOne(l, ctx) {
  const { settings, cache } = ctx;
  const base = { ghRes: ctx.ghRes, policy: ctx.policy };
  if (l.diskKB > settings.maxSizeMB * 1024) return { res: await scanRemote(l, { ...base, emptyDir: await ctx.emptyDir(), reason: 'too-large' }), fetched: false };
  cache.evictFor(l.diskKB * 1024, settings.cacheMaxGB * GB, ctx.keep);
  const s = await cache.sync(l);
  if (!s.ok) return { res: await scanRemote(l, { ...base, emptyDir: await ctx.emptyDir(), reason: `clone-failed: ${s.error}` }), fetched: false };
  return { res: await scanRemote(l, { ...base, cacheDir: s.dir }), fetched: !!s.fetched };
}

// deps: { localResults, settings (normalized), cache, policy, onBegin?(n), onRepo?(res),
//         list = listRemote, fetch = fetchRemoteData (repo data and branches), force }
async function runRemoteStage({ localResults, settings, cache, policy, onBegin = () => {}, onRepo = () => {}, list = listRemote, fetch = fetchRemoteData, force = false }) {
  if (!settings.enabled) return { results: [], status: idle(), listing: new Map() };
  const lr = await list({ orgs: settings.orgs, onCall: () => github.noteCall('graphql') });
  if (!lr.ok) return { results: [], status: idle({ ran: true, error: lr.error }), listing: new Map() };
  const localRefs = (localResults || []).filter((r) => r && !r.error && r.remote).map((r) => ({ owner: r.remote.owner, name: r.remote.name }));
  const { include, excluded } = selectUncloned(lr.repos, localRefs, settings);
  onBegin(include.length);
  const ghMap = include.length ? await fetch(include.map((l) => ({ owner: l.owner, name: l.name })), { force }) : new Map();
  const emptyDir = lazyEmpty(cache.root);
  const keep = new Set(include.map(key));
  const results = [];
  let cloned = 0;
  await pool(include, 2, async (l) => {
    let out;
    try {
      out = await scanOne(l, { settings, cache, emptyDir, ghRes: ghMap.get(key(l)) || null, policy, keep });
    } catch (e) {
      out = { res: { path: `remote:${key(l)}`, name: key(l), source: 'remote', error: String((e && e.message) || e), findings: [], score: 0, grade: '?' }, fetched: false };
    }
    if (out.fetched) cloned++;
    results.push(out.res);
    onRepo(out.res);
  });
  cache.cleanup(keep);
  const listing = new Map(include.map((l) => [`remote:${key(l)}`, l]));
  return { results, listing, status: { ran: true, error: null, included: include.length, excluded, cloned, cacheBytes: cache.sizeBytes() } };
}

// Rescan one remote repo after a change on GitHub (bypasses the GitHub cache).
async function refreshRemote(l, { settings, cache, policy, fetch = fetchRemoteData }) {
  const ghMap = await fetch([{ owner: l.owner, name: l.name }], { force: true });
  const emptyDir = lazyEmpty(cache.root);
  return (await scanOne(l, { settings, cache, emptyDir, ghRes: ghMap.get(key(l)) || null, policy, keep: new Set([key(l)]) })).res;
}

module.exports = { runRemoteStage, refreshRemote, scanOne };
