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

// deps: { known, service, policy: () => policy data, seen?: seen store, onBegin?(total), onRepo?(res, done, total) }
function createWorkspaceScanner({ known, service, policy, seen = null, onBegin = () => {}, onRepo = () => {} }) {
  let running = null; // { key, promise }
  let gen = 0; // bumped by every workspace scan
  let last = { root: null, deep: false }; // the scan `known` came from
  let lastFresh = null; // new findings from the last scan that recorded them (null: nothing compared)

  // A folder as typed ("~/Projects", " /w ") to an absolute existing directory, or an error.
  function resolveRoot(want) {
    if (typeof want !== 'string' || !want.trim()) return { error: 'No workspace folder: pass root (for example ~/Projects).' };
    const abs = expandHome(want.trim(), os.homedir());
    try { if (fs.statSync(abs).isDirectory()) return { root: abs }; } catch {}
    return { error: `Folder does not exist: ${abs}` };
  }

  // opts: { root, deep, recordSeen (compare with and update seen.json), onProgress(done, total, name) }
  async function scan({ root: want, deep = false, recordSeen = false, onProgress } = {}) {
    const r = resolveRoot(want);
    if (r.error) return { ok: false, error: r.error };
    const key = `${r.root}|${!!deep}|${!!recordSeen}`;
    while (running) {
      if (running.key === key) return running.promise; // the same scan is already under way: share it
      try { await running.promise; } catch {}
    }
    const promise = (async () => {
      const dirs = discover(r.root);
      gen++;
      known.clear();
      service.forgetPlans(); // plans reviewed for the previous workspace can no longer run
      last = { root: r.root, deep: !!deep };
      onBegin(dirs.length);
      const results = await scanAll(dirs, { deep: !!deep, policy }, (res, done, total) => {
        known.set(res.path, res);
        onRepo(res, done, total);
        if (onProgress) onProgress(done, total, res.name);
      });
      service.recordScan(r.root, results);
      let fresh = null;
      if (recordSeen && seen) { const rec = seen.record(r.root, results, { deep: !!deep }); fresh = rec.compared ? rec.fresh : null; lastFresh = fresh; }
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
    const res = await scanRepo(dir, { deep: last.deep, policy });
    if (g !== gen || !known.has(dir)) return null; // the workspace was rescanned meanwhile
    known.set(dir, res);
    return res;
  }
  async function refreshAll() { for (const d of [...known.keys()]) await refresh(d); }

  return {
    resolveRoot, scan, settled, refresh, refreshAll,
    busy: () => !!running,
    root: () => last.root,
    deep: () => last.deep,
    generation: () => gen,
    lastFresh: () => lastFresh,
  };
}

module.exports = { createWorkspaceScanner };
