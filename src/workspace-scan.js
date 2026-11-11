// One workspace scan for the app, the CLI and the MCP server, so the three behave the same way.
// It owns the `known` map (path -> latest result, the only repos actions may touch): a new scan
// clears it and forgets reviewed plans; concurrent callers share one scan; a scan of another folder
// waits for the running one first. Refreshing one repo after a change never puts back a repo from a
// workspace that was replaced while it ran.

const fs = require('node:fs');
const os = require('node:os');
const { discover, scanRepo, scanAll } = require('./scanner');
const github = require('./github');
const { expandHome } = require('./util');
const { normalizeRemoteSettings } = require('./remote-settings');
const { runRemoteStage, refreshRemote } = require('./remote-stage');
const { repoKey } = require('./policy');
const path = require('node:path');
const { gitCommonDir } = require('./clutter-rules');

// Linked worktrees whose main checkout is in the same scan: Map(worktree dir -> main checkout dir).
async function worktreeLinks(dirs) {
  const set = new Set(dirs);
  const links = new Map();
  for (const d of dirs) {
    const common = await gitCommonDir(d);
    const main = path.basename(common) === '.git' ? path.dirname(common) : null;
    if (main && main !== d && set.has(main)) links.set(d, main);
  }
  return links;
}

// deps: { known, service, policy: () => policy data, seen?: seen store, onBegin?(total), onRepo?(res, done, total, stage),
//         remote?: { settings: () => raw settings.remote, cache: remote-cache.js, list?, fetch? } (repos not cloned here) }
function createWorkspaceScanner({ known, service, policy, seen = null, onBegin = () => {}, onRepo = () => {}, remote = null }) {
  let running = null; // { key, promise }
  let gen = 0; // bumped by every workspace scan
  let last = { root: null, deep: false }; // the scan `known` came from
  let lastFresh = null; // new findings from the last scan that recorded them (null: nothing compared)
  let remoteStatus = null; // what the last scan's remote stage did (null: no remote stage configured)
  let remoteListing = new Map(); // remote:owner/name -> listing, for refresh()
  let worktrees = new Map(); // linked worktree dir -> its main checkout, when both are scanned

  // A folder as typed ("~/Projects", " /w ") to an absolute existing directory, or an error.
  function resolveRoot(want) {
    if (typeof want !== 'string' || !want.trim()) return { error: 'No workspace folder: pass root (for example ~/Projects).' };
    const abs = expandHome(want.trim(), os.homedir());
    try { if (fs.statSync(abs).isDirectory()) return { root: abs }; } catch {}
    return { error: `Folder does not exist: ${abs}` };
  }

  const remoteSettings = (override) => {
    const s = normalizeRemoteSettings(remote && remote.settings());
    return typeof override === 'boolean' ? { ...s, enabled: override } : s;
  };

  // opts: { root, deep, recordSeen (compare with and update seen.json), onProgress(done, total, name),
  //         remote (true/false: include repos not cloned here for this scan, whatever the setting says) }
  async function scan({ root: want, deep = false, recordSeen = false, onProgress, remote: remoteOverride } = {}) {
    const r = resolveRoot(want);
    if (r.error) return { ok: false, error: r.error };
    const key = `${r.root}|${!!deep}|${!!recordSeen}|${remoteOverride}`;
    while (running) {
      if (running.key === key) return running.promise; // the same scan is already under way: share it
      try { await running.promise; } catch {}
    }
    const promise = (async () => {
      const dirs = discover(r.root);
      worktrees = await worktreeLinks(dirs);
      gen++;
      known.clear();
      service.forgetPlans(); // plans reviewed for the previous workspace can no longer run
      last = { root: r.root, deep: !!deep };
      onBegin(dirs.length);
      const local = await scanAll(dirs, { deep: !!deep, policy, worktreeOf: worktrees }, (res, done, total) => {
        known.set(res.path, res);
        onRepo(res, done, total, 'local');
        if (onProgress) onProgress(done, total, res.name);
      });
      let results = local;
      remoteListing = new Map();
      if (remote) {
        const myGen = gen;
        let total = dirs.length;
        let done = dirs.length;
        // A failure of the stage itself (network, disk) is reported, never a failed workspace scan.
        const st = await runRemoteStage({
          localResults: local, settings: remoteSettings(remoteOverride), cache: remote.cache, policy, list: remote.list, fetch: remote.fetch,
          onBegin: (n) => { total = dirs.length + n; },
          onRepo: (res) => {
            if (myGen !== gen) return;
            known.set(res.path, res);
            onRepo(res, ++done, total, 'remote');
            if (onProgress) onProgress(done, total, res.name);
          },
        }).catch((e) => ({ results: [], listing: new Map(), status: { ran: true, error: String((e && e.message) || e).split('\n')[0].slice(0, 300), included: 0, excluded: [], cloned: 0, cacheBytes: 0 } }));
        remoteStatus = st.status;
        remoteListing = st.listing;
        results = [...local, ...st.results];
      }
      service.recordScan(r.root, results);
      let fresh = null;
      // When this scan could not see the remote repos, keep their findings for the next comparison.
      const localKeys = new Set(local.map(repoKey));
      const blind = !!remote && (remoteOverride === false || !!(remoteStatus && remoteStatus.error));
      const carry = blind ? (k) => !localKeys.has(k) : null;
      if (recordSeen && seen) { const rec = seen.record(r.root, results, { deep: !!deep, carry }); fresh = rec.compared ? rec.fresh : null; lastFresh = fresh; }
      return { ok: true, root: r.root, count: results.length, rate: github.getRate(), fresh };
    })();
    running = { key, promise };
    try { return await promise; } finally { if (running && running.promise === promise) running = null; }
  }

  // Wait for a scan in flight, so nobody reads a half-filled workspace.
  async function settled() { while (running) { try { await running.promise; } catch {} } }

  // Rescan one repo of the current workspace with the same depth as the scan it came from.
  async function refresh(dir) {
    if (!known.has(dir)) return null;
    const g = gen;
    const l = remoteListing.get(dir);
    if (String(dir).startsWith('remote:') && !l) return null;
    const res = l
      ? await refreshRemote(l, { settings: remoteSettings(), cache: remote.cache, policy, fetch: remote.fetch })
      : await scanRepo(dir, { deep: last.deep, policy, worktreeOf: worktrees });
    if (g !== gen || !known.has(dir)) return null; // the workspace was rescanned meanwhile
    known.set(dir, res);
    return res;
  }
  // Rescan one repo with a chosen depth (the app's Rescan button): a remote repo refreshes its copy.
  async function rescan(dir, { deep = false } = {}) {
    if (!known.has(dir)) return { ok: false, error: 'Unknown repo' };
    const g = gen;
    const res = remoteListing.has(dir) ? await refresh(dir) : await scanRepo(dir, { deep: !!deep, policy, worktreeOf: worktrees });
    if (!res || g !== gen || !known.has(dir)) return { ok: false, error: 'The workspace was rescanned meanwhile' };
    known.set(dir, res);
    return { ok: true, res };
  }
  async function refreshAll() { for (const d of [...known.keys()]) await refresh(d); }

  return {
    resolveRoot, scan, settled, refresh, rescan, refreshAll,
    busy: () => !!running,
    root: () => last.root,
    deep: () => last.deep,
    generation: () => gen,
    lastFresh: () => lastFresh,
    remoteStatus: () => remoteStatus,
  };
}

module.exports = { createWorkspaceScanner };
