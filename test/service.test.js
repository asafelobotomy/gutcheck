const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createService } = require('../src/service');
const { scanRepo } = require('../src/scanner');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-svc-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'T'); sh(dir, 'config', 'user.email', 't@e.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(dir, '.env'), 'S=1');
  fs.writeFileSync(path.join(dir, '.env.bak'), 'S=1');
  const known = new Map([[dir, await scanRepo(dir, {})]]);
  const s = { readOnly: false, root: path.dirname(dir) };
  const audit = [];
  const trashed = [];
  const clip = [];
  const svc = createService({ known, settings: () => s, audit: (e) => audit.push(e), trash: async (p) => { trashed.push(path.basename(p)); fs.rmSync(p); }, clipboard: { writeText: (t) => clip.push(t) } });
  return { dir, known, s, audit, trashed, clip, svc };
}

test('plan then apply: tokens are single-use, audited, and results rescanned', async () => {
  const { dir, svc, audit, trashed } = await setup();
  try {
    const [p] = await svc.planActions([{ dir, action: { type: 'clean-clutter', paths: ['.env.bak'] } }]);
    assert.ok(p.ok, p.error);
    assert.equal(p.confirmName, path.basename(dir));
    assert.equal(p.steps, undefined, 'steps must stay server-side');
    const [refused] = await svc.applyActions([p.token]);
    assert.match(refused.error, /dangerous action: confirm it/, 'a dangerous plan needs its repo name from every caller');
    assert.deepEqual(trashed, []);
    const [p2] = await svc.planActions([{ dir, action: { type: 'clean-clutter', paths: ['.env.bak'] } }]);
    const [r] = await svc.applyActions([p2.token], { confirm: { [p2.token]: path.basename(dir) } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(trashed, ['.env.bak']);
    assert.equal(audit.length, 1);
    const [again] = await svc.applyActions([p2.token], { confirm: { [p2.token]: path.basename(dir) } });
    assert.equal(again.ok, false);
    assert.match(again.error, /expired/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad input, unknown repos and read-only mode are refused', async () => {
  const { dir, svc, s, trashed } = await setup();
  try {
    assert.equal((await svc.planActions([]))[0].ok, false);
    assert.equal((await svc.planActions([{ dir: '/etc', action: { type: 'fetch' } }]))[0].ok, false);
    assert.deepEqual(await svc.applyActions('nope'), []);
    const [p] = await svc.planActions([{ dir, action: { type: 'clean-clutter', paths: ['.env.bak'] } }]);
    s.readOnly = true;
    const [r] = await svc.applyActions([p.token], { confirm: { [p.token]: path.basename(dir) } });
    assert.equal(r.ok, false);
    assert.match(r.error, /Read-only/);
    assert.equal((await svc.planActions([{ dir, action: { type: 'fetch' } }]))[0].ok, false);
    assert.deepEqual(trashed, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a new workspace scan voids old plans, and a repo dropped from the workspace cannot be acted on', async () => {
  const { dir, svc, known, trashed } = await setup();
  try {
    const plan1 = (await svc.planActions([{ dir, action: { type: 'clean-clutter', paths: ['.env.bak'] } }]))[0];
    svc.forgetPlans();
    assert.match((await svc.applyActions([plan1.token]))[0].error, /expired/);
    const plan2 = (await svc.planActions([{ dir, action: { type: 'clean-clutter', paths: ['.env.bak'] } }]))[0];
    known.delete(dir);
    assert.match((await svc.applyActions([plan2.token], { confirm: { [plan2.token]: path.basename(dir) } }))[0].error, /no longer in the scanned workspace/);
    assert.deepEqual(trashed, []);
    assert.equal(known.has(dir), false, 'nothing puts the old repo back');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown token cannot run anything', async () => {
  const { dir, svc } = await setup();
  try {
    const [r] = await svc.applyActions(['0'.repeat(32)]);
    assert.equal(r.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clutterScan covers known repos only and copyReport writes the clipboard without env contents', async () => {
  const { dir, svc, clip } = await setup();
  try {
    const out = await svc.clutterScan();
    assert.ok(out.ok);
    assert.equal(out.repos.length, 1);
    assert.ok(out.repos[0].items.some((i) => i.path === '.env.bak'));
    assert.equal((await svc.clutterScan(['/etc'])).ok, false);

    const c = await svc.copyReport(dir);
    assert.ok(c.ok);
    assert.equal(clip.length, 1);
    assert.match(clip[0], /# GutCheck report/);
    assert.match(clip[0], /\.env\.bak/);
    assert.ok(!clip[0].includes('S=1'));
    assert.equal((await svc.copyReport('/nope')).ok, false);
    assert.equal(clip.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trend history: one snapshot per scan, rapid rescans merge, scoped to the workspace, capped', async () => {
  const { dir, known, s } = await setup();
  try {
    let disk = [];
    const svc = createService({ known, settings: () => s, audit() {}, trash: async () => {}, clipboard: { writeText() {} }, trendStore: { read: () => disk, write: (a) => { disk = JSON.parse(JSON.stringify(a)); } } });
    const results = [...known.values()];
    svc.recordScan(s.root, results);
    svc.recordScan(s.root, results); // within 10 minutes: replaces
    assert.equal(disk.length, 1);
    assert.deepEqual(Object.keys(disk[0].scores), [path.basename(dir)]);
    assert.ok(!JSON.stringify(disk).includes(dir), 'no absolute paths on disk, only names and scores');

    disk[0].ts -= 3600e3; // pretend the first scan was an hour ago
    svc.recordScan(s.root, results);
    assert.equal(disk.length, 2);
    await svc.clutterScan(); // a full clutter scan stamps the latest snapshot
    assert.equal(typeof disk[1].clutter, 'number');
    assert.equal(svc.trend().length, 2);
    s.root = '/some/other/root';
    assert.equal(svc.trend().length, 0);

    s.root = path.dirname(dir);
    disk = Array.from({ length: 400 }, (_, i) => ({ ts: i, root: s.root, scores: {} }));
    svc.recordScan(s.root, results);
    assert.ok(disk.length <= 365);
    assert.ok(svc.trend().length <= 90);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt or missing trend file is treated as empty', async () => {
  const { dir, known, s } = await setup();
  try {
    const svc = createService({ known, settings: () => s, audit() {}, trash: async () => {}, clipboard: { writeText() {} }, trendStore: { read: () => { throw new Error('ENOENT'); }, write() {} } });
    assert.deepEqual(svc.trend(), []);
    svc.recordScan(s.root, [...known.values()]); // must not throw
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed change stops the later ones for the same repo, shared across one-token calls', async () => {
  const { dir, svc, trashed, known } = await setup();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-svc-bare-'));
  try {
    const name = path.basename(dir);
    // A real upstream, so pull plans fine; it is then removed, so the pull fails when applied.
    sh(bare, 'init', '-q', '--bare');
    sh(dir, 'remote', 'add', 'origin', bare); sh(dir, 'push', '-q', '-u', 'origin', 'main');
    known.set(dir, await scanRepo(dir, {}));
    const breakUpstream = () => fs.rmSync(bare, { recursive: true, force: true });
    const plans = await svc.planActions([{ dir, action: { type: 'pull' } }, { dir, action: { type: 'clean-clutter', paths: ['.env.bak'] } }]);
    assert.ok(plans.every((p) => p.ok), JSON.stringify(plans));
    breakUpstream();
    const confirm = { [plans[1].token]: name };
    const out = await svc.applyActions(plans.map((p) => p.token), { confirm });
    assert.equal(out[0].ok, false);
    assert.equal(out[1].skipped, true);
    assert.match(out[1].error, /earlier change to this repo failed/);
    assert.deepEqual(trashed, []);
    // The same through separate calls that share a failed set (as the engine applies tokens).
    const again = await svc.planActions([{ dir, action: { type: 'pull' } }, { dir, action: { type: 'clean-clutter', paths: ['.env.bak'] } }]);
    const failed = new Set();
    await svc.applyActions([again[0].token], { failed });
    const [second] = await svc.applyActions([again[1].token], { confirm: { [again[1].token]: name }, failed });
    assert.equal(second.skipped, true);
    assert.deepEqual(trashed, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bare, { recursive: true, force: true }); }
});
