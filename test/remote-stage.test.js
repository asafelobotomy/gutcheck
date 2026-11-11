// Remote repos: the second stage of a workspace scan (listing, size limit, clone failures, the
// `known` map, progress, cache clean-up) and the workspace advice when GitHub cannot be reached.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gh = require('../src/github');
const { runRemoteStage } = require('../src/remote-stage');
const { createWorkspaceScanner } = require('../src/workspace-scan');
const { createService } = require('../src/service');
const { normalizeRemoteSettings } = require('../src/remote-settings');

gh.fetchFailedRuns = async () => ({ failed: [], error: null });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const gitRepo = (d, origin) => {
  if (fs.existsSync(path.join(d, '.git'))) return d;
  fs.mkdirSync(d, { recursive: true });
  const sh = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'README.md'), '# x\n'); sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  if (origin) sh('remote', 'add', 'origin', origin);
  return d;
};
const L = (name, o = {}) => ({ owner: 'octo', name, isFork: false, isArchived: false, diskKB: 10, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z', ...o });
const snap = (name) => ({ ok: true, snap: { remote: { owner: 'octo', name, url: `https://github.com/octo/${name}`, description: 'd', isPublic: false, archived: false, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z', openIssues: 0, viewerPermission: 'READ', alertsEnabled: true, isFork: false, hasIssues: false, topics: 1, languages: [], latestRelease: null, ruleset: false }, prs: [], protection: null, alertsTotal: 0, alerts: [] } });

// A cache whose sync hands back a prepared clone and records what was asked of it.
function fakeCache(root, { fail = new Set() } = {}) {
  const calls = { sync: [], evict: [], cleanup: [] };
  return {
    root, calls,
    sync: async (l) => { calls.sync.push(l.name); if (fail.has(l.name)) return { ok: false, error: 'fatal: boom' }; return { ok: true, dir: gitRepo(path.join(root, `octo__${l.name}`)), fetched: true }; },
    evictFor: (need, max, keep) => { calls.evict.push({ need, max, keep: [...keep] }); return []; },
    cleanup: (keep) => { calls.cleanup.push([...keep]); return []; },
    sizeBytes: () => 123,
  };
}
const deps = (o) => ({ fetch: async (refs) => new Map(refs.map((r) => [`${r.owner}/${r.name}`, snap(r.name)])), ...o });

test('disabled: nothing is listed and the stage reports it did not run', async () => {
  let listed = false;
  const r = await runRemoteStage(deps({ localResults: [], settings: normalizeRemoteSettings({}), cache: fakeCache(tmp('gc-st-')), list: async () => { listed = true; return { ok: true, repos: [] }; } }));
  assert.equal(listed, false);
  assert.equal(r.status.ran, false);
  assert.deepEqual(r.results, []);
});

test('listing fails: no remote results, the error is kept, the cache is not cleaned', async () => {
  const cache = fakeCache(tmp('gc-st-'));
  const r = await runRemoteStage(deps({ localResults: [], settings: normalizeRemoteSettings({ enabled: true }), cache, list: async () => ({ ok: false, error: 'gh auth login' }) }));
  assert.deepEqual(r.results, []);
  assert.equal(r.status.ran, true);
  assert.equal(r.status.error, 'gh auth login');
  assert.deepEqual(cache.calls.cleanup, []);
});

test('too large is never cloned; a failed clone falls back to GitHub checks only; space is made before cloning', async () => {
  const cache = fakeCache(tmp('gc-st-'), { fail: new Set(['broken']) });
  const listing = [L('big', { diskKB: 600 * 1024 }), L('broken'), L('fine', { diskKB: 2048 })];
  const r = await runRemoteStage(deps({ localResults: [], settings: normalizeRemoteSettings({ enabled: true, cacheMaxGB: 1 }), cache, list: async () => ({ ok: true, repos: listing }) }));
  const by = Object.fromEntries(r.results.map((x) => [x.name, x]));
  assert.ok(!cache.calls.sync.includes('big'));
  assert.equal(by['octo/big'].partial, true);
  assert.ok(by['octo/big'].findings.some((f) => f.id === 'uncloned-too-large'));
  assert.equal(by['octo/broken'].partial, true);
  assert.ok(by['octo/broken'].findings.some((f) => f.id === 'uncloned-clone-failed' && /boom/.test(f.detail)));
  assert.equal(by['octo/fine'].partial, false);
  const ev = cache.calls.evict.find((e) => e.need === 2048 * 1024);
  assert.ok(ev, 'evictFor called with the new clone\'s size');
  assert.equal(ev.max, 1024 ** 3);
  assert.deepEqual(r.status.excluded, []);
  assert.equal(r.status.included, 3);
  assert.deepEqual(cache.calls.cleanup, [['octo/big', 'octo/broken', 'octo/fine']]);
});

test('workspace scan: remote repos join `known` under remote:, progress continues, a repo cloned since is dropped', async () => {
  const root = tmp('gc-st-ws-');
  gitRepo(path.join(root, 'local1'));
  const cache = fakeCache(tmp('gc-st-cache-'));
  let listing = [L('app'), L('lib')];
  const known = new Map();
  const progress = [];
  const service = { forgetPlans() {}, recordScan() {} };
  const ws = createWorkspaceScanner({
    known, service, policy: () => null, onRepo: (res, done, total) => progress.push([res.name, done, total]),
    remote: { settings: () => ({ enabled: true }), cache, ...deps({ list: async () => ({ ok: true, repos: listing }) }) },
  });
  const out = await ws.scan({ root });
  assert.ok(out.ok);
  assert.deepEqual([...known.keys()].filter((k) => k.startsWith('remote:')).sort(), ['remote:octo/app', 'remote:octo/lib']);
  assert.deepEqual(progress.map((p) => p.slice(1)), [[1, 1], [2, 3], [3, 3]], 'the total grows once the remote repos are known');
  assert.equal(ws.remoteStatus().included, 2);

  gitRepo(path.join(root, 'app'), 'https://github.com/octo/app.git');
  const again = await ws.scan({ root });
  assert.ok(again.ok);
  assert.ok(!known.has('remote:octo/app'), 'cloned in the workspace now');
  assert.ok(known.has('remote:octo/lib'));
  assert.deepEqual(cache.calls.cleanup.at(-1), ['octo/lib']);
  assert.ok(ws.remoteStatus().excluded.some((x) => x.name === 'app' && x.why === 'cloned'));

  const off = await ws.scan({ root, remote: false });
  assert.ok(off.ok);
  assert.ok(![...known.keys()].some((k) => k.startsWith('remote:')), 'remote: false skips the stage for one run');
});

test('refresh of a remote key rescans that repo', async () => {
  const root = tmp('gc-st-ws-');
  gitRepo(path.join(root, 'local1'));
  const cache = fakeCache(tmp('gc-st-cache-'));
  const known = new Map();
  const ws = createWorkspaceScanner({
    known, service: { forgetPlans() {}, recordScan() {} }, policy: () => null,
    remote: { settings: () => ({ enabled: true }), cache, ...deps({ list: async () => ({ ok: true, repos: [L('app')] }) }) },
  });
  await ws.scan({ root });
  const before = cache.calls.sync.length;
  const res = await ws.refresh('remote:octo/app');
  assert.equal(res.path, 'remote:octo/app');
  assert.equal(cache.calls.sync.length, before + 1);
});

test('workspace advice says when remote repos could not be checked', async () => {
  const known = new Map();
  const svc = createService({ known, settings: () => ({}), audit() {}, remoteStatus: () => ({ ran: true, error: 'gh auth login', included: 0, excluded: [], cloned: 0, cacheBytes: 0 }) });
  const root = tmp('gc-st-adv-');
  const advice = await svc.wsAdvice(root);
  const a = advice.find((x) => x.id === 'uncloned-unavailable');
  assert.ok(a);
  assert.equal(a.severity, 'info');
  assert.equal(a.title, 'Remote repos not checked');
  assert.equal(a.detail, 'gh auth login');
});
