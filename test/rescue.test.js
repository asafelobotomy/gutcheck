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
