// Regression tests from cleaning ~/Projects on 2026-11-16: the clutter scan said ~60 GB of target/
// folders, but /home is btrfs with compress=zstd:3, so du's sizes were before compression and only
// ~24 GB came free. Sizes on a compressing disk are now labelled, and a clean-up reports what it freed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-accdisk-'));
const GLOBAL = path.join(ROOT, 'gitconfig');
fs.mkdirSync(path.join(ROOT, 'home'));
fs.writeFileSync(GLOBAL, '');
Object.assign(process.env, { HOME: path.join(ROOT, 'home'), GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { compressionOf } = require('../src/disk-space');
const { plan, apply } = require('../src/actions');
const { scanRepo } = require('../src/scanner');

const MOUNTS = [
  '/dev/nvme0n1p2 / btrfs rw,relatime,ssd,subvol=/@ 0 0',
  '/dev/nvme0n1p2 /home btrfs rw,relatime,compress=zstd:3,ssd,discard=async,subvol=/@home 0 0',
  '/dev/sda1 /home/me/data ext4 rw,relatime 0 0',
  '/dev/sdb1 /mnt/my\\040disk btrfs rw,compress-force=lzo 0 0',
  '/dev/sdc1 /srv btrfs rw,compress=no 0 0',
  '/dev/sdd1 /bc bcachefs rw,compression=lz4 0 0',
].join('\n');

test('a btrfs mount with compress= makes sizes "before compression"', () => {
  assert.equal(compressionOf('/home/me/Projects/uq/target', MOUNTS), 'btrfs zstd:3');
  assert.equal(compressionOf('/home', MOUNTS), 'btrfs zstd:3');
  assert.equal(compressionOf('/mnt/my disk/repo', MOUNTS), 'btrfs lzo', 'escaped mount points and compress-force');
  assert.equal(compressionOf('/bc/repo', MOUNTS), 'bcachefs lz4');
});

test('no compression is claimed where there is none', () => {
  assert.equal(compressionOf('/etc/x', MOUNTS), null, 'btrfs without compress=');
  assert.equal(compressionOf('/home/me/data/repo', MOUNTS), null, 'the longest mount point wins');
  assert.equal(compressionOf('/srv/repo', MOUNTS), null, 'compress=no');
  assert.equal(compressionOf('/home2/repo', '/dev/x /home btrfs rw,compress=zstd 0 0\n/dev/y / ext4 rw 0 0'), null, '/home2 is not under /home');
  assert.equal(compressionOf('/x', ''), null);
});

test('a clean-up reports the free space it really gained', async () => {
  const d = path.join(ROOT, 'repo');
  fs.mkdirSync(path.join(d, '.pytest_cache'), { recursive: true });
  fs.writeFileSync(path.join(d, '.pytest_cache', 'x'), 'y'.repeat(4096));
  fs.writeFileSync(path.join(d, '.gitignore'), '.pytest_cache/\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  const p = await plan(await scanRepo(d, {}), { type: 'clean-clutter', paths: ['.pytest_cache'] });
  assert.ok(p.ok, JSON.stringify(p));
  const a = await apply(p);
  assert.ok(a.ok, JSON.stringify(a));
  assert.equal(a.results.length, p.steps.length + 1);
  assert.match(a.results.at(-1).text, /^Free space on this disk: [+−]\d.* \(measured\)$/);
  assert.equal(fs.existsSync(path.join(d, '.pytest_cache')), false);
});
