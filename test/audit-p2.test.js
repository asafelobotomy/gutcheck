// Correctness fixes from the 2026-11-16 audit (K3, K4, K6): each failed in a small real repo first.
// K2's false alarm is in test/accuracy.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { put, sh, repo, fresh } = require('./helpers/git-lab');

const { scanClutter } = require('../src/clutter');
const { scanQuality } = require('../src/quality');
const { bigDirSize } = require('../src/clutter-rules');
const { bump } = require('../scripts/version');

test('K3: a failed file listing fails the clutter and quality scans instead of calling tracked files clutter', async () => {
  const d = repo({ 'notes.bak': 'keep\n', '.env.old': 'A=1\n', 'a.js': 'const a = 1;\n' });
  const ok = await scanClutter(d);
  assert.ok(!ok.items.some((i) => i.path === 'notes.bak'), 'a committed file is not removable clutter');
  fs.writeFileSync(path.join(d, '.git', 'index'), 'not an index');
  await assert.rejects(scanClutter(d), /could not list this repo's files/);
  await assert.rejects(scanQuality(d), /could not list this repo's files/);
});

test('K4: du\'s total is used even when it exits 1 over one unreadable folder', { skip: process.getuid && process.getuid() === 0 ? 'root can read everything' : false }, async () => {
  const d = fresh('big');
  fs.mkdirSync(path.join(d, 'locked'), { recursive: true });
  fs.writeFileSync(path.join(d, 'data.bin'), Buffer.alloc(512 * 1024, 1));
  fs.chmodSync(path.join(d, 'locked'), 0o000);
  try {
    const { run } = require('../src/exec');
    const du = await run('du', ['-sk', '--', d]);
    assert.equal(du.ok, false, 'du reports the unreadable folder');
    assert.equal(await bigDirSize(d), Number(du.stdout.split('\t')[0]) * 1024);
  } finally { fs.chmodSync(path.join(d, 'locked'), 0o700); }
});

test('K6: an Unreleased entry holding $&, $\' or $$ is moved as written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-bump-'));
  try {
    const entry = "- Shell quoting: `$'\\n'`, `$&`, `$$` and `` $` `` are kept as written.";
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.0.0', packages: { '': { name: 'x', version: '1.0.0' } } }));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n${entry}\n\n## [1.0.0] - 2026-01-01\n\n- First.\n`);
    assert.equal(bump(root, 'patch', { today: '2026-11-16' }), '1.0.1');
    assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), `# Changelog\n\n## [Unreleased]\n\n## [1.0.1] - 2026-11-16\n\n### Fixed\n\n${entry}\n\n## [1.0.0] - 2026-01-01\n\n- First.\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
