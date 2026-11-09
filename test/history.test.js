const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { analyzeHistory, historyVerdict } = require('../src/history');
const { sizeStep } = require('../src/report-fixes');
const { checkGitHygiene } = require('../src/checks-hygiene');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const rand = (kb) => crypto.randomBytes(kb * 1024); // incompressible, so disk sizes are predictable

test('analyzeHistory splits storage into current files, older versions, deleted files and unreferenced objects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-hist-'));
  try {
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'assets', 'old'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'old', 'gone.png'), rand(300));
    fs.writeFileSync(path.join(dir, 'assets', 'pic.png'), rand(200));
    fs.mkdirSync(path.join(dir, 'assets', 'live'));
    fs.writeFileSync(path.join(dir, 'assets', 'live', 'keep.txt'), 'k');
    fs.writeFileSync(path.join(dir, 'assets', 'live', 'drop.bin'), rand(5));
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'one');
    sh(dir, 'rm', '-q', 'assets/live/drop.bin');
    fs.writeFileSync(path.join(dir, 'assets', 'pic.png'), rand(100)); // pic.png v1 becomes an older version
    sh(dir, 'rm', '-q', 'assets/old/gone.png');
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'two');
    fs.writeFileSync(path.join(dir, 'loose.bin'), rand(50));
    sh(dir, 'add', 'loose.bin'); sh(dir, 'rm', '-q', '--cached', 'loose.bin'); // a blob no commit points to
    sh(dir, 'gc', '-q');

    const h = await analyzeHistory(dir);
    const kb = (b) => Math.round(b / 1024);
    assert.ok(kb(h.current) >= 100 && kb(h.current) < 120, `current ${kb(h.current)}`);
    assert.ok(kb(h.oldVersions) >= 200 && kb(h.oldVersions) < 220, `old ${kb(h.oldVersions)}`);
    assert.ok(kb(h.deleted) >= 305 && kb(h.deleted) < 325, `deleted ${kb(h.deleted)}`);
    assert.ok(kb(h.unreachable) >= 50, `unreachable ${kb(h.unreachable)}`);
    assert.deepEqual(h.deletedFolders.map((f) => f.name), ['assets/old/'], 'only folders with nothing left in HEAD');
    assert.deepEqual(h.oldFiles.map((f) => f.name), ['assets/pic.png']);
    assert.equal(h.extensions[0].name, 'png');
    assert.equal(h.rewriteWorthIt, false, 'too small to be worth a rewrite');
    assert.match(historyVerdict(h), /current files .*older versions .*deleted files .*unreferenced .*git gc removes it/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const H = (o) => ({ total: 5e9, current: 3.6e9, oldVersions: 1.2e9, deleted: 0.07e9, unreachable: 0, historyOnly: 1.27e9, binaryCurrent: 3.5e9, rewriteWorthIt: false,
  folders: [{ name: 'assets/_source/', bytes: 2e9 }, { name: 'assets/_archive/', bytes: 1.4e9 }], extensions: [{ name: 'png' }, { name: 'jpg' }, { name: 'glb' }], deletedFolders: [{ name: 'shots/', bytes: 7e7 }], oldFiles: [], ...o });

test('the verdict says when a rewrite would not help, and when it would; the step never rewrites without the owner', () => {
  const keep = historyVerdict(H());
  assert.match(keep, /Rewriting history would save about 1\.2 GB \(25%\): most of the size is the files you have now/);
  assert.match(keep, /Git LFS for new versions/);
  const worth = historyVerdict(H({ current: 1e9, historyOnly: 3e9, rewriteWorthIt: true }));
  assert.match(worth, /Rewriting history could save about 2\.8 GB.*GutCheck does not do it/);

  const s = sizeStep(H());
  assert.ok(s.cmds.includes("git lfs track '*.png' '*.jpg' '*.glb'"));
  assert.ok(s.cmds.some((c) => c === "git rm -r --cached -- 'assets/_archive'   # then add it to .gitignore"), 'archives are suggested to leave git');
  assert.ok(s.cmds.some((c) => c.startsWith('git clone --mirror')), 'a backup comes before any rewrite');
  assert.ok(s.cmds.indexOf('git clone --mirror . ../backup-before-rewrite.git   # full backup first') < s.cmds.findIndex((c) => c.startsWith('git filter-repo --invert-paths')));
  assert.match(s.note, /only if the owner asks/);
  assert.match(sizeStep(null).note, /Deep scan/);
});

test('the repo-size finding carries the verdict after a deep scan, and asks for one otherwise', () => {
  const base = { stashes: 0, goneBranches: [], prunableWorktrees: 0, remote: null, noCommits: false, submodulesUninit: 0, storage: { packKiB: 5.2 * 1024 * 1024, loose: 0, garbage: 0 } };
  const f = (h) => checkGitHygiene({ hygiene: h, git: {} }).find((x) => x.id === 'repo-size');
  assert.match(f(base).detail, /Run a Deep scan/);
  assert.match(f({ ...base, history: H() }).detail, /most of the size is the files you have now/);
});
