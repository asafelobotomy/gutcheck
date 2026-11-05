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
    const [r] = await svc.applyActions([p.token]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(trashed, ['.env.bak']);
    assert.equal(audit.length, 1);
    const [again] = await svc.applyActions([p.token]);
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
    const [r] = await svc.applyActions([p.token]);
    assert.equal(r.ok, false);
    assert.match(r.error, /Read-only/);
    assert.equal((await svc.planActions([{ dir, action: { type: 'fetch' } }]))[0].ok, false);
    assert.deepEqual(trashed, []);
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
