// The rescue copy: apply's safe git run steps and no-overwrite copy step, then the rescue-bundle
// plan and its apply against real throwaway repos (private HOME and global config).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, sh, put, repo, fresh } = require('./helpers/git-lab');
const { apply } = require('../src/apply');

const stat = (f) => { const s = fs.statSync(f); return { size: s.size, mtimeMs: s.mtimeMs }; };
const copyStep = (root, dest, rels) => ({ kind: 'copy', root, dest, files: rels.map((rel) => ({ rel, ...stat(path.join(root, rel)) })), display: 'copy untracked files' });
const dirOf = () => { const d = fresh('dest'); return d; };

// ---- Task 4: apply

test('a safeGit run step runs through ctx.safeGit, never ctx.run', async () => {
  const seen = [];
  const ctx = {
    run: async () => { throw new Error('ctx.run must not be called'); },
    safeGit: async (args, cwd, opts) => { seen.push({ args, cwd, opts }); return { ok: true, stdout: '', stderr: '' }; },
  };
  const r = await apply({ steps: [{ safeGit: true, cmd: 'git', args: ['bundle', 'verify', 'x'], cwd: ROOT, timeout: 1234, display: 'git bundle verify x' }] }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0].args, ['bundle', 'verify', 'x']);
  assert.equal(seen[0].cwd, ROOT);
  assert.equal(seen[0].opts.timeout, 1234);
});

test('copy copies the listed files and keeps their bytes', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  put(d, 'notes/n.txt', 'hello\n');
  const dest = dirOf();
  const r = await apply({ steps: [copyStep(d, dest, ['notes/n.txt'])] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(fs.readFileSync(path.join(dest, 'notes/n.txt'), 'utf8'), 'hello\n');
  assert.equal(fs.statSync(path.join(dest, 'notes')).mode & 0o777, 0o700);
});

test('copy refuses when a file grew after planning, and copies nothing', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  put(d, 'one.txt', '1'); put(d, 'two.txt', '2');
  const dest = dirOf();
  const step = copyStep(d, dest, ['one.txt', 'two.txt']);
  put(d, 'two.txt', '22');
  const r = await apply({ steps: [step] });
  assert.equal(r.ok, false);
  assert.match(r.results[0].out, /changed since the preview/);
  assert.equal(fs.existsSync(path.join(dest, 'one.txt')), false);
});

test('copy refuses a file that became a symlink', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  put(d, 'x.txt', 'x');
  const dest = dirOf();
  const step = copyStep(d, dest, ['x.txt']);
  fs.rmSync(path.join(d, 'x.txt'));
  fs.symlinkSync('/etc/hostname', path.join(d, 'x.txt'));
  const r = await apply({ steps: [step] });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(dest, 'x.txt')), false);
});

test('copy refuses a path that leaves the repo', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  const outside = fresh('outside'); fs.mkdirSync(outside); put(outside, 's.txt', 's');
  const dest = dirOf();
  const rel = path.relative(d, path.join(outside, 's.txt'));
  const r = await apply({ steps: [{ kind: 'copy', root: d, dest, files: [{ rel, ...stat(path.join(outside, 's.txt')) }], display: 'copy' }] });
  assert.equal(r.ok, false);
});

test('copy never overwrites an existing destination file', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  put(d, 'n.txt', 'new');
  const dest = dirOf(); put(dest, 'n.txt', 'old');
  const r = await apply({ steps: [copyStep(d, dest, ['n.txt'])] });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(dest, 'n.txt'), 'utf8'), 'old');
});

test('copy handles a name with a newline and a leading dash', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  const odd = '-odd\nname.txt';
  put(d, odd, 'odd');
  const dest = dirOf();
  const r = await apply({ steps: [copyStep(d, dest, [odd])] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(fs.readFileSync(path.join(dest, odd), 'utf8'), 'odd');
});

// ---- Task 5: the rescue-bundle action
const { plan } = require('../src/actions');
const { scanRepo } = require('../src/scanner');
const { execFileSync } = require('node:child_process');

const commitFile = (d, rel, text) => { put(d, rel, text); sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', rel); };
// A pushed main, an unpushed feature branch, a stash holding an untracked file, a modified tracked
// file, and untracked files of every kind the copy must keep or skip.
function fullRepo() {
  const d = repo({ 'a.txt': 'a\n', '.gitignore': 'build.log\n' });
  const bare = fresh('bare');
  sh(path.dirname(bare), 'init', '-q', '--bare', bare);
  sh(d, 'remote', 'add', 'origin', bare);
  sh(d, 'push', '-q', '-u', 'origin', 'main');
  sh(d, 'switch', '-q', '-c', 'feature'); commitFile(d, 'f.txt', 'feature\n'); sh(d, 'switch', '-q', 'main');
  put(d, 'stashed.txt', 'stashed\n'); sh(d, 'stash', 'push', '-q', '-u', '-m', 's');
  put(d, 'a.txt', 'changed\n');
  put(d, 'notes.txt', 'keep me\n');
  put(d, 'build.log', 'ignored\n');
  put(d, '.env', 'TOKEN=x\n');
  put(d, 'big.bin', 'x'.repeat(2048));
  fs.symlinkSync('notes.txt', path.join(d, 'link.txt'));
  return d;
}
const state = (d) => [sh(d, 'status', '--porcelain=v2', '--branch'), sh(d, 'for-each-ref'), sh(d, 'stash', 'list')].join('\n---\n');
const rescuePlan = async (d, o = {}) => plan(await scanRepo(d, {}), { type: 'rescue-bundle', dest: o.dest }, { workspaceRoot: o.ws || fresh('ws'), repoPaths: [d], maxFileBytes: 1024, ...o.ctx });
const baseDir = () => { const b = fresh('rescue'); return b; };
const destOf = (p) => p.steps.find((s) => s.kind === 'mkdir').path;

test('rescue plan refuses a destination inside the workspace or the repo', async () => {
  const d = fullRepo();
  assert.match((await rescuePlan(d, { dest: path.join(path.dirname(d), 'r'), ws: path.dirname(d) })).error, /outside the workspace/);
  assert.match((await rescuePlan(d, { dest: path.join(d, 'r'), ws: fresh('ws') })).error, /outside the workspace/);
});

test('rescue plan refuses a destination that already has files', async () => {
  const d = fullRepo();
  const base = baseDir();
  const first = await rescuePlan(d, { dest: base });
  put(destOf(first), 'x', 'x');
  assert.match((await rescuePlan(d, { dest: base })).error, /already has files/);
});

test('rescue plan says nothing to save for an empty repo with no files', async () => {
  const d = fresh('empty'); fs.mkdirSync(d); sh(d, 'init', '-q', '-b', 'main');
  const p = await rescuePlan(d, { dest: baseDir() });
  assert.equal(p.ok, false);
  assert.equal(p.nothing, true);
});

test('rescue plan uses safe git for every git step, and gives the bundle 30 minutes', async () => {
  const p = await rescuePlan(fullRepo(), { dest: baseDir() });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.risk, 'safe');
  const gitSteps = p.steps.filter((s) => s.args);
  assert.ok(gitSteps.length >= 4);
  assert.ok(gitSteps.every((s) => s.safeGit === true));
  assert.equal(gitSteps.find((s) => s.args[0] === 'bundle' && s.args[1] === 'create').timeout, 30 * 60 * 1000);
});

test('rescue apply saves everything, restores it, and leaves the repo unchanged', async () => {
  const d = fullRepo();
  const before = state(d);
  const p = await rescuePlan(d, { dest: baseDir() });
  assert.equal(p.ok, true, p.error);
  const r = await apply(p);
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(state(d), before, 'the repo is unchanged');
  const dest = destOf(p);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o700);

  const clone = fresh('restore');
  execFileSync('git', ['clone', '-q', path.join(dest, 'repo.bundle'), clone]);
  assert.match(sh(clone, 'branch', '-a'), /feature/);
  sh(clone, 'apply', path.join(dest, 'uncommitted.patch'));
  assert.equal(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8'), 'changed\n');
  sh(clone, 'apply', path.join(dest, 'stash-0.patch'));
  assert.equal(fs.readFileSync(path.join(clone, 'stashed.txt'), 'utf8'), 'stashed\n');

  assert.deepEqual(fs.readdirSync(path.join(dest, 'untracked')), ['notes.txt']);
  const manifest = fs.readFileSync(path.join(dest, 'MANIFEST.txt'), 'utf8');
  assert.match(manifest, /skipped \.env: secret/);
  assert.match(manifest, /skipped big\.bin: too large/);
  assert.match(manifest, /skipped link\.txt: not a regular file/);
  assert.match(manifest, /Not included: local work inside submodules and linked worktrees/);
  assert.doesNotMatch(manifest, /TOKEN=x|keep me/);
});

test('a failing bundle step stops apply and keeps the folder', async () => {
  const p = await rescuePlan(fullRepo(), { dest: baseDir() });
  const ctx = { safeGit: async (args) => (args[0] === 'bundle' ? { ok: false, stdout: '', stderr: 'No space left on device' } : { ok: true, stdout: '', stderr: '' }) };
  const r = await apply(p, ctx);
  assert.equal(r.ok, false);
  assert.match(r.results.pop().out, /No space left/);
  assert.ok(fs.existsSync(destOf(p)));
  assert.match(p.note, /what was written so far stays there/);
});
