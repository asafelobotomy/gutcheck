// Bypasses of the scan-safety layer found in review (audit 2026-11-09, B1-B5 follow-up).
// Each attack leaves a marker file when its program runs; scans and plans must leave none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, GLOBAL, put, sh, fresh, repo, marker, statDirty } = require('./helpers/git-lab');

const exec = require('../src/exec');
const { collectLocal, scanRepo } = require('../src/scanner');
const { plan, apply } = require('../src/actions');

test('a submodule\'s own clean filter does not run through the parent\'s scan', async () => {
  const sub = repo({ 'f.txt': 'a\n', '.gitattributes': '* filter=subevil\n' }, 'sub');
  const parent = repo({ 'a.txt': 'p\n' }, 'parent');
  sh(parent, 'submodule', 'add', '-q', sub, 'sub');
  sh(parent, 'commit', '-qm', 'add sub');
  const m = marker();
  sh(path.join(parent, 'sub'), 'config', 'filter.subevil.clean', m.prog);
  sh(parent, 'config', 'submodule.sub.ignore', 'none');
  statDirty(path.join(parent, 'sub'), 'f.txt');
  const local = await collectLocal(parent, {});
  assert.equal(m.ran(), false, 'the submodule filter ran from the scan');
  assert.equal(local.git.branch, 'main');
  statDirty(path.join(parent, 'sub'), 'f.txt');
  const p = await plan(await scanRepo(parent, {}), { type: 'commit-all', message: 'x' });
  assert.equal(m.ran(), false, 'the submodule filter ran from planning');
  assert.equal(p.ok, false, 'nothing to commit');
});

test('a partial clone does not lazy-fetch (and run remote.origin.uploadpack) during a scan', async () => {
  const src = repo({ 'd/a': 'a\n', b: 'b\n' }, 'src');
  const bare = fresh('remote');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(src, 'push', '-q', bare, 'main');
  sh(bare, 'config', 'uploadpack.allowFilter', 'true');
  const pc = fresh('pc');
  sh(ROOT, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${bare}`, pc);
  const m = marker('exec git-upload-pack "$@"');
  sh(pc, 'config', 'remote.origin.uploadpack', m.prog);
  for (const args of [['status', '--porcelain'], ['rev-list', '--objects', '--all'], ['log', '--name-only', '-1'], ['ls-tree', '-r', 'HEAD']]) await exec.git(args, { cwd: pc });
  await collectLocal(pc, { deep: true });
  assert.equal(m.ran(), false, 'a lazy fetch ran the repo\'s uploadpack');
});

test('planning commit-all and its check step do not run a repo clean filter', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=evil\n' });
  const m = marker();
  sh(d, 'config', 'filter.evil.clean', m.prog);
  put(d, 'new.txt', 'new\n');
  const scanned = await scanRepo(d, {});
  statDirty(d, 'a.txt');
  const p = await plan(scanned, { type: 'commit-all', message: 'x' });
  assert.ok(p.ok, p.error);
  assert.equal(m.ran(), false, 'planning ran the filter');
  statDirty(d, 'a.txt');
  const r = await apply({ steps: [p.steps[0]] });
  assert.ok(r.ok, JSON.stringify(r.results));
  assert.equal(m.ran(), false, 'the check step ran the filter');
});

test('an includeIf onbranch: filter is seen right after a branch switch (no stale cache)', async () => {
  const inc = path.join(ROOT, 'onb.inc');
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=onb\n' });
  const m = marker();
  fs.writeFileSync(inc, `[filter "onb"]\n\tclean = ${m.prog}\n`);
  sh(d, 'config', 'includeIf.onbranch:feature.path', inc);
  sh(d, 'branch', 'feature');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
  sh(d, 'symbolic-ref', 'HEAD', 'refs/heads/feature');
  statDirty(d, 'a.txt');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
  assert.equal(m.ran(), false, 'the onbranch filter ran');
});

test('an edit to an included config file is seen at once', async () => {
  const inc = path.join(ROOT, 'later.inc');
  fs.writeFileSync(inc, '');
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=later\n' });
  sh(d, 'config', 'include.path', inc);
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
  const m = marker();
  fs.writeFileSync(inc, `[filter "later"]\n\tclean = ${m.prog}\n`);
  statDirty(d, 'a.txt');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
  assert.equal(m.ran(), false, 'the newly included filter ran');
});

test('scans and actions drop a repo\'s cached drivers before they start and after they finish', async () => {
  const d = repo({ 'a.txt': 'hello\n' });
  const seen = [];
  const orig = exec.forgetGitDrivers;
  exec.forgetGitDrivers = (dir) => { seen.push(dir); return orig(dir); };
  try {
    await collectLocal(d, {});
    assert.deepEqual(seen, [d], 'collectLocal forgets first');
    const p = await plan(await scanRepo(d, {}), { type: 'fetch' });
    seen.length = 0;
    await apply(p, { run: async () => ({ ok: true, stdout: '', stderr: '' }) });
    assert.deepEqual(seen, [d], 'apply forgets afterwards');
  } finally { exec.forgetGitDrivers = orig; }
});

test('git lfs ls-files cannot fall back to a repo alias named lfs', async () => {
  const d = repo({ 'a.txt': 'hello\n' });
  const m = marker('true');
  sh(d, 'config', 'alias.lfs', `!${m.prog}`);
  const bin = fresh('bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  const PATH = process.env.PATH;
  process.env.PATH = bin; // git without git-lfs
  try {
    await exec.git(['lfs', 'ls-files', '-n'], { cwd: d });
  } finally { process.env.PATH = PATH; }
  assert.equal(m.ran(), false, 'the lfs alias ran');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok, 'builtins still work with their alias blanked');
});

test('git-lfs installed in the repo as well as globally keeps LFS files clean', { skip: !hasLfs() && 'git-lfs is not installed' }, async () => {
  fs.writeFileSync(GLOBAL, '[protocol "file"]\n\tallow = always\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n');
  try {
    const d = repo({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' });
    sh(d, 'lfs', 'install', '--local');
    put(d, 'a.bin', 'x'.repeat(2000));
    sh(d, 'add', 'a.bin');
    sh(d, 'commit', '-qm', 'lfs');
    statDirty(d, 'a.bin');
    const local = await collectLocal(d, {});
    assert.equal(local.git.dirty, 0, 'LFS files show as changed');
  } finally { fs.writeFileSync(GLOBAL, '[protocol "file"]\n\tallow = always\n'); }
});

function hasLfs() { try { execFileSync('git-lfs', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('a repo value for a driver the user trusts globally is still blanked when it differs', async () => {
  const g = marker();
  fs.writeFileSync(GLOBAL, `[protocol "file"]\n\tallow = always\n[filter "x"]\n\tclean = ${g.prog}\n`);
  try {
    const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=x\n' });
    const m = marker();
    sh(d, 'config', 'filter.x.clean', m.prog);
    statDirty(d, 'a.txt');
    assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
    assert.equal(m.ran(), false, 'the repo\'s value ran');
    sh(d, 'config', 'filter.x.clean', g.prog);
    statDirty(d, 'a.txt');
    g.reset();
    assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
    assert.equal(g.ran(), true, 'a repo value equal to the global one is kept');
  } finally { fs.writeFileSync(GLOBAL, '[protocol "file"]\n\tallow = always\n'); }
});

test('a repo lfs.extension cannot run through the trusted global git-lfs filter; the scan reports an error', { skip: !hasLfs() && 'git-lfs is not installed' }, async () => {
  execFileSync('git', ['lfs', 'install', '--skip-repo'], { cwd: ROOT, stdio: 'ignore' }); // into the temp global config
  try {
    const d = repo({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' });
    put(d, 'a.bin', 'x'.repeat(500));
    sh(d, 'add', 'a.bin');
    sh(d, 'commit', '-qm', 'lfs');
    const m = marker();
    sh(d, 'config', 'lfs.extension.evil.clean', `${m.prog} %f`);
    sh(d, 'config', 'lfs.extension.evil.smudge', 'cat');
    sh(d, 'config', 'lfs.extension.evil.priority', '0');
    put(d, 'a.bin', 'y'.repeat(500));
    await exec.git(['status', '--porcelain'], { cwd: d });
    assert.equal(m.ran(), false, 'the lfs extension ran');
    await assert.rejects(collectLocal(d, {}), /git status failed/);
    assert.equal(m.ran(), false);
  } finally { fs.writeFileSync(GLOBAL, '[protocol "file"]\n\tallow = always\n'); }
});

test('a relative include is watched correctly when git runs from a subfolder', async () => {
  const d = repo({ 'sub/a.txt': 'hello\n', '.gitattributes': '* filter=rel\n' });
  const inc = path.join(d, '.git', 'rel.inc');
  fs.writeFileSync(inc, '');
  sh(d, 'config', 'include.path', 'rel.inc'); // relative to .git/config's folder
  const sub = path.join(d, 'sub');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: sub })).ok);
  const m = marker();
  fs.writeFileSync(inc, `[filter "rel"]\n\tclean = ${m.prog}\n`);
  statDirty(d, 'sub/a.txt');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: sub })).ok);
  assert.equal(m.ran(), false, 'the newly included filter ran');
});

test('a repo lfs.storage outside the repo gets no objects from a scan', { skip: !hasLfs() && 'git-lfs is not installed' }, async () => {
  execFileSync('git', ['lfs', 'install', '--skip-repo'], { cwd: ROOT, stdio: 'ignore' });
  try {
    const d = repo({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' });
    put(d, 'a.bin', 'x'.repeat(500));
    sh(d, 'add', 'a.bin');
    sh(d, 'commit', '-qm', 'lfs');
    const outside = fresh('lfs-elsewhere');
    sh(d, 'config', 'lfs.storage', outside);
    put(d, 'a.bin', 'z'.repeat(500));
    await collectLocal(d, {});
    assert.equal(fs.existsSync(outside), false, 'git-lfs wrote outside the repo');
  } finally { fs.writeFileSync(GLOBAL, '[protocol "file"]\n\tallow = always\n'); }
});
