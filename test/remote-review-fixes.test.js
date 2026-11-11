// Remote repos: fixes from the whole-branch review. Each test reproduces one finding.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run } = require('../src/exec');
const gh = require('../src/github');
const scanner = require('../src/scanner');
const { createRemoteCache } = require('../src/remote-cache');
const { scanRemote, ensureEmptyRepo } = require('../src/remote-scan');
const { runRemoteStage } = require('../src/remote-stage');
const { createWorkspaceScanner } = require('../src/workspace-scan');
const { createSeenStore } = require('../src/schedule');
const { repoKey } = require('../src/policy');

gh.fetchFailedRuns = async () => ({ failed: [], error: null });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const listing = (o = {}) => ({ owner: 'octo', name: 'app', isFork: false, isArchived: false, diskKB: 1, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z', ...o });
function origin(files = {}) {
  const base = tmp('gc-fix-origin-');
  const work = path.join(base, 'work');
  const bare = path.join(base, 'bare.git');
  fs.mkdirSync(work);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  sh(work, 'init', '-q', '-b', 'main'); sh(work, 'config', 'user.email', 't@t'); sh(work, 'config', 'user.name', 't');
  sh(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const commit = (f) => { for (const [k, v] of Object.entries(f)) fs.writeFileSync(path.join(work, k), v); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '--allow-empty', '-m', 'c'); sh(work, 'push', '-q', bare, 'HEAD:refs/heads/main'); };
  commit({ 'README.md': 'hi\n', ...files });
  return { bare, commit };
}
function testRun(extraEnv = {}, failOn = null) {
  const calls = [];
  const r = (cmd, args, opts = {}) => {
    calls.push({ cmd, args: [...args] });
    if (failOn && args.includes(failOn)) return Promise.resolve({ ok: false, code: 128, stdout: '', stderr: 'fatal: unable to access network' });
    let i = 0;
    while (args[i] === '-c') i += 2;
    return run(cmd, [...args.slice(0, i), '-c', 'protocol.file.allow=always', ...args.slice(i)], { ...opts, env: { ...(opts.env || {}), ...extraEnv } });
  };
  return { run: r, calls };
}
const userConfig = (text) => { const h = tmp('gc-fix-home-'); const f = path.join(h, 'gitconfig'); fs.writeFileSync(f, text); return { f, h }; };

test('review I2: a filter driver from the user config never runs on a remote repo\'s files', async () => {
  const { f, h } = userConfig('');
  const marker = path.join(h, 'marker');
  fs.writeFileSync(f, `[filter "crypt"]\n\tsmudge = touch ${marker}\n\tprocess = touch ${marker}\n\trequired = true\n[filter "my.dotted"]\n\tsmudge = touch ${marker}\n`);
  const o = origin({ '.gitattributes': '*.txt filter=crypt\n*.md filter=my.dotted\n', 'a.txt': 'secret\n' });
  const root = tmp('gc-fix-root-');
  const t = testRun({ GIT_CONFIG_GLOBAL: f, GIT_CONFIG_NOSYSTEM: '1' });
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  const r = await cache.sync(listing());
  assert.ok(r.ok, r.error);
  assert.ok(!fs.existsSync(marker), 'smudge did not run on clone');
  o.commit({ 'b.txt': 'more\n' });
  const again = await cache.sync(listing({ pushedAt: '2026-11-02T00:00:00Z' }));
  assert.ok(again.ok, again.error);
  assert.ok(!fs.existsSync(marker), 'smudge did not run on refresh');
});

test('review I3: clones in progress live where eviction and clean-up never look', async () => {
  const o = origin();
  const root = tmp('gc-fix-root-');
  const t = testRun();
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  await cache.sync(listing());
  const target = t.calls.find((c) => c.args.includes('clone')).args.at(-1);
  assert.equal(path.dirname(path.dirname(target)), root);
  assert.equal(path.basename(path.dirname(target)), '.partial');
  fs.mkdirSync(path.join(root, '.partial', 'octo__other-999'), { recursive: true });
  cache.cleanup(new Set());
  cache.evictFor(10 ** 12, 1, new Set());
  assert.ok(fs.existsSync(path.join(root, '.partial', 'octo__other-999')), 'another clone in progress is left alone');
});

test('review I4: a failed fetch keeps the good copy instead of deleting it', async () => {
  const o = origin();
  const root = tmp('gc-fix-root-');
  const ok = testRun();
  await createRemoteCache({ root, run: ok.run, urlFor: () => o.bare }).sync(listing());
  const failing = testRun({}, 'fetch');
  const r = await createRemoteCache({ root, run: failing.run, urlFor: () => o.bare }).sync(listing({ pushedAt: '2026-11-09T00:00:00Z' }));
  assert.ok(r.ok, r.error);
  assert.equal(r.fetched, false);
  assert.equal(r.stale, true);
  assert.ok(fs.existsSync(path.join(root, 'octo__app', 'README.md')));
  assert.ok(!failing.calls.some((c) => c.args.includes('clone')), 'no new clone attempted');
});

test('review I4: a failed re-clone (branch renamed) leaves no half copy and reports the error', async () => {
  const root = tmp('gc-fix-root-');
  const o = origin();
  await createRemoteCache({ root, run: testRun().run, urlFor: () => o.bare }).sync(listing());
  const r = await createRemoteCache({ root, run: testRun({}, 'clone').run, urlFor: () => o.bare }).sync(listing({ defaultBranch: 'trunk' }));
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.partial')), []);
});

test('review I5: an error in the remote stage itself leaves the local scan intact', async () => {
  const root = tmp('gc-fix-ws-');
  const d = path.join(root, 'local1');
  fs.mkdirSync(d);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  const known = new Map();
  const recorded = [];
  const ws = createWorkspaceScanner({
    known, service: { forgetPlans() {}, recordScan: (r, res) => recorded.push(res.length) }, policy: () => null,
    remote: { settings: () => ({ enabled: true }), cache: { root: tmp('gc-fix-c-'), cleanup() {}, sizeBytes: () => 0, evictFor() {} }, list: async () => ({ ok: true, repos: [listing()] }), fetch: async () => { throw new Error('socket hang up'); } },
  });
  const out = await ws.scan({ root });
  assert.ok(out.ok);
  assert.ok(known.has(d));
  assert.deepEqual(recorded, [1]);
  assert.match(ws.remoteStatus().error, /socket hang up/);
});

test('review I5: the stand-in empty repo does not need git 2.28 (no init -b)', async () => {
  const calls = [];
  const fake = async (cmd, args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; };
  const root = tmp('gc-fix-empty-');
  await ensureEmptyRepo(root, fake);
  assert.ok(!calls[0].includes('-b'));
});

test('review I6: findings of remote repos are carried over a scan whose remote stage failed', () => {
  const dir = tmp('gc-fix-seen-');
  const seen = createSeenStore(path.join(dir, 'seen.json'));
  const f = (id) => ({ id, severity: 'warn', title: id, category: 'x' });
  const local = { path: '/w/a', name: 'a', remote: { owner: 'me', name: 'a' }, findings: [f('l1')] };
  const rem = { path: 'remote:me/b', name: 'me/b', source: 'remote', remote: { owner: 'me', name: 'b' }, findings: [f('r1')] };
  seen.record('/w', [local, rem]);
  seen.record('/w', [local], { carry: (key) => key !== 'me/a' });
  const third = seen.record('/w', [local, rem]);
  assert.deepEqual(third.fresh, [], 'nothing new: the remote repo\'s findings were carried over');
});

test('review I7: cache size comes from the recorded sizes, not a walk of every file', async () => {
  const o = origin();
  const root = tmp('gc-fix-root-');
  const cache = createRemoteCache({ root, run: testRun().run, urlFor: () => o.bare });
  await cache.sync(listing());
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'octo__app.json'), 'utf8'));
  assert.ok(meta.bytes > 0, 'size recorded after clone');
  fs.writeFileSync(path.join(root, 'octo__app.json'), JSON.stringify({ ...meta, bytes: 7777777 }));
  assert.equal(cache.sizeBytes(), 7777777);
});

test('review: a partial repo with unreachable GitHub still keys ignores by owner/name', async () => {
  const root = tmp('gc-fix-key-');
  const r = await scanRemote(listing(), { cacheDir: null, emptyDir: await ensureEmptyRepo(root), ghRes: { ok: false, error: 'offline' }, reason: 'clone-failed: x' });
  assert.deepEqual(r.ref, { owner: 'octo', name: 'app' });
  assert.equal(repoKey(r), 'octo/app');
});

test('review: the clone always names its remote origin (clone.defaultRemoteName)', async () => {
  const o = origin();
  const { f } = userConfig('[clone]\n\tdefaultRemoteName = upstream\n');
  const root = tmp('gc-fix-root-');
  const t = testRun({ GIT_CONFIG_GLOBAL: f, GIT_CONFIG_NOSYSTEM: '1' });
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  await cache.sync(listing());
  o.commit({ 'x.md': 'x\n' });
  const r = await cache.sync(listing({ pushedAt: '2026-11-04T00:00:00Z' }));
  assert.ok(r.ok, r.error);
  assert.equal(r.fetched, true);
  assert.equal(t.calls.filter((c) => c.args.includes('clone')).length, 1, 'refreshed, not cloned again');
});

test('review: a deep scan never runs npm in a cache copy', async () => {
  const seenOpts = [];
  const orig = scanner.collectLocal;
  scanner.collectLocal = async (dir, opts) => { seenOpts.push(opts); return orig(dir, opts); };
  try {
    const root = tmp('gc-fix-deep-');
    const c = path.join(root, 'clone');
    fs.mkdirSync(c);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: c });
    await scanRemote(listing(), { cacheDir: c, ghRes: null, deep: true });
  } finally { scanner.collectLocal = orig; }
  assert.equal(seenOpts[0].deep, false);
});

test('review I1: rescanning a remote repo goes through the remote refresh, not a folder scan', async () => {
  const root = tmp('gc-fix-ws-');
  const d = path.join(root, 'local1');
  fs.mkdirSync(d);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  const croot = tmp('gc-fix-c-');
  const clone = path.join(croot, 'octo__app');
  fs.mkdirSync(clone);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: clone });
  const cache = { root: croot, sync: async () => ({ ok: true, dir: clone, fetched: false }), cleanup() {}, sizeBytes: () => 0, evictFor() {} };
  const ws = createWorkspaceScanner({ known: new Map(), service: { forgetPlans() {}, recordScan() {} }, policy: () => null,
    remote: { settings: () => ({ enabled: true }), cache, list: async () => ({ ok: true, repos: [listing()] }), fetch: async (refs) => new Map(refs.map((x) => [`${x.owner}/${x.name}`, { ok: false, error: 'offline' }])) } });
  await ws.scan({ root });
  const out = await ws.rescan('remote:octo/app', { deep: true });
  assert.ok(out.ok, out.error);
  assert.equal(out.res.path, 'remote:octo/app');
  const local = await ws.rescan(d, { deep: false });
  assert.ok(local.ok);
  assert.equal(local.res.path, d);
});

test('review I5 (stage): runRemoteStage makes the empty repo only when a repo needs it', async () => {
  const cache = { root: path.join(tmp('gc-fix-lazy-'), 'not', 'made'), sync: async () => ({ ok: false, error: 'x' }), evictFor() {}, cleanup() {}, sizeBytes: () => 0 };
  const r = await runRemoteStage({ localResults: [], settings: { enabled: true, orgs: [], forks: false, archived: false, skip: [], maxSizeMB: 500, cacheMaxGB: 5 }, cache, list: async () => ({ ok: true, repos: [] }), fetch: async () => new Map() });
  assert.equal(r.status.included, 0);
  assert.ok(!fs.existsSync(path.join(cache.root, '.empty')));
});
