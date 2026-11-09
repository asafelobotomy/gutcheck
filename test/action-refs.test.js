// Scanned ref names never reach a git command line as options, and fetch and pull only write
// remote-tracking branches, whatever the repo's refspecs say (audit 2026-11-09, B6-B8).
// Real throwaway repos and local bare remotes; git-lab gives a private HOME and global config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, sh, repo, fresh } = require('./helpers/git-lab');
const { sshUrl } = require('./helpers/fake-ssh');
const { plan, apply } = require('../src/actions');
const { scanRepo } = require('../src/scanner');

const heads = (d) => sh(d, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags');
const commit = (d, file, text) => { fs.writeFileSync(path.join(d, file), text); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', text.trim()); };

// Plan, and apply only if planned: a refused plan must also leave the repo as it was.
async function act(d, action, over = (r) => r) {
  const p = await plan(over(await scanRepo(d, {})), action);
  return { p, applied: p.ok ? await apply(p) : null };
}

// A bare remote with main, gone and keep; a clone whose main tracks origin/main, with an
// unpushed local branch feat and a local tag.
function cloned() {
  const bare = fresh('bare');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'remote', 'add', 'origin', sshUrl(bare));
  sh(d, 'push', '-q', 'origin', 'main:gone', 'main:keep');
  sh(d, 'push', '-q', '-u', 'origin', 'main');
  sh(d, 'switch', '-q', '-c', 'feat');
  commit(d, 'f.txt', 'unpushed\n');
  sh(d, 'switch', '-q', 'main');
  sh(d, 'tag', 'mine');
  sh(d, 'fetch', '-q', 'origin');
  return { bare, d };
}

// A second clone that adds work to the bare remote.
function otherClone(bare) {
  const o = fresh('other');
  sh(ROOT, 'clone', '-q', bare, o);
  sh(o, 'config', 'user.email', 't@t');
  sh(o, 'config', 'user.name', 't');
  return o;
}

test('B7: a branch named --orphan=wipe is refused for checkout, and the work tree is left intact', async () => {
  const d = repo({ 'a.txt': '1\n', 'b.txt': '2\n' });
  sh(d, 'update-ref', 'refs/heads/--orphan=wipe', 'HEAD');
  const r = await scanRepo(d, {});
  assert.ok(r.git.branches.some((b) => b.name === '--orphan=wipe'), 'the scan lists it');
  const { p } = await act(d, { type: 'checkout', branch: '--orphan=wipe' });
  assert.equal(p.ok, false);
  assert.match(p.error, /not a safe branch name/);
  assert.equal(sh(d, 'branch', '--show-current'), 'main');
  assert.equal(sh(d, 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(path.join(d, 'a.txt')) && fs.existsSync(path.join(d, 'b.txt')));
});

test('B7: merge, create-branch from, delete-local and delete-merged refuse a "-"-leading name', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'update-ref', 'refs/heads/-x', 'HEAD');
  const before = heads(d);
  for (const action of [
    { type: 'merge-branch', branch: '-x', mode: 'ff' },
    { type: 'merge-branch', branch: '-x', mode: 'no-ff' },
    { type: 'create-branch', name: 'side', from: '-x' },
    { type: 'delete-local', branch: '-x', force: true },
  ]) {
    const { p } = await act(d, action);
    assert.equal(p.ok, false, action.type);
    assert.match(p.error, /not a safe branch name/, action.type);
  }
  const { p } = await act(d, { type: 'delete-merged', branches: ['-x'] }, (r) => ({ ...r, git: { ...r.git, mergedBranches: ['-x'] } }));
  assert.equal(p.ok, false);
  assert.equal(heads(d), before);
});

test('B7: checkout, create-branch, merge and delete-local still work, with --end-of-options before the name', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'branch', 'topic');
  let { p, applied } = await act(d, { type: 'create-branch', name: 'side', from: 'topic' });
  assert.ok(applied.ok, JSON.stringify(applied.results));
  assert.equal(p.display[0].text, 'git switch --no-recurse-submodules -c side --end-of-options topic');
  commit(d, 'b.txt', 'side\n');
  ({ p, applied } = await act(d, { type: 'checkout', branch: 'main' }));
  assert.equal(p.display[0].text, 'git switch --no-recurse-submodules --end-of-options main');
  assert.ok(applied.ok);
  ({ p, applied } = await act(d, { type: 'merge-branch', branch: 'side', mode: 'ff' }));
  assert.equal(p.display[0].text, 'git merge --ff-only --end-of-options side');
  assert.ok(applied.ok, JSON.stringify(applied.results));
  assert.equal(sh(d, 'rev-parse', 'main'), sh(d, 'rev-parse', 'side'));
  ({ p, applied } = await act(d, { type: 'delete-local', branch: 'topic', force: true }));
  assert.match(p.undo, /^git branch topic [0-9a-f]+$/, 'the plan-time rev-parse still finds the branch');
  assert.ok(applied.ok);
});

test('B7: delete-remote refuses a "-"-leading remote branch and deletes a normal one by refspec', async () => {
  const { bare, d } = cloned();
  sh(d, 'update-ref', 'refs/remotes/origin/--mirror', 'HEAD');
  const gh = (r) => ({ ...r, remote: { owner: 'o', name: 'n', defaultBranch: 'main' }, prs: [] });
  const bad = await act(d, { type: 'delete-remote', branch: '--mirror' }, gh);
  assert.equal(bad.p.ok, false);
  assert.match(bad.p.error, /not a safe branch name/);
  assert.deepEqual(sh(bare, 'branch', '--format=%(refname:short)').split('\n').sort(), ['gone', 'keep', 'main']);
  const good = await act(d, { type: 'delete-remote', branch: 'gone' }, gh);
  assert.ok(good.p.ok, good.p.error);
  assert.equal(good.p.display[0].text, 'git push --no-follow-tags --recurse-submodules=no -- origin :refs/heads/gone');
  assert.ok(good.applied.ok, JSON.stringify(good.applied.results));
  assert.deepEqual(sh(bare, 'branch', '--format=%(refname:short)').split('\n').sort(), ['keep', 'main']);
});

test('B8: fetch with a refspec that writes local branches leaves them (and local tags) intact', async () => {
  const { bare, d } = cloned();
  sh(d, 'config', '--add', 'remote.origin.fetch', '+refs/heads/zzz/*:refs/heads/*');
  sh(d, 'config', 'fetch.pruneTags', 'true');
  const o = otherClone(bare);
  sh(o, 'switch', '-q', '-c', 'zzz/feat');
  commit(o, 'z.txt', 'hostile\n');
  sh(o, 'push', '-q', 'origin', 'zzz/feat');
  const before = heads(d);
  const { p, applied } = await act(d, { type: 'fetch' });
  assert.ok(p.ok, p.error);
  assert.equal(p.risk, 'safe');
  assert.ok(applied.ok, JSON.stringify(applied.results));
  assert.equal(heads(d), before, 'no local branch or tag was deleted or moved');
  assert.equal(sh(d, 'rev-parse', 'refs/remotes/origin/zzz/feat'), sh(o, 'rev-parse', 'HEAD'));
});

test('B8: fetch still updates remote-tracking branches and prunes deleted ones', async () => {
  const { bare, d } = cloned();
  const o = otherClone(bare);
  sh(o, 'push', '-q', 'origin', '--delete', 'gone');
  commit(o, 'n.txt', 'new\n');
  sh(o, 'push', '-q', 'origin', 'main:newb');
  const { p, applied } = await act(d, { type: 'fetch' });
  assert.equal(p.display[0].text, "git fetch --prune --no-prune-tags --no-recurse-submodules --refmap= -- origin '+refs/heads/*:refs/remotes/origin/*'");
  assert.ok(applied.ok, JSON.stringify(applied.results));
  assert.deepEqual(sh(d, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin').split('\n').filter((x) => x !== 'origin').sort(), ['origin/keep', 'origin/main', 'origin/newb']);
  assert.equal(sh(d, 'rev-parse', 'origin/newb'), sh(o, 'rev-parse', 'HEAD'));
});

test('B8: fetch skips a remote whose name could be an option, and says so', async () => {
  const { d } = cloned();
  fs.appendFileSync(path.join(d, '.git', 'config'), '[remote "-x"]\n\turl = /nowhere\n');
  const { p } = await act(d, { type: 'fetch' });
  assert.ok(p.ok, p.error);
  assert.equal(p.steps.length, 1);
  assert.match(p.warnings.join('\n'), /Skipped 1 remote/);
});

test('B8: pull with a refspec that writes local branches fast-forwards and leaves other branches intact', async () => {
  const { bare, d } = cloned();
  sh(d, 'config', '--add', 'remote.origin.fetch', '+refs/heads/zzz/*:refs/heads/*');
  const o = otherClone(bare);
  commit(o, 'm.txt', 'ahead\n');
  sh(o, 'push', '-q', 'origin', 'main');
  sh(o, 'switch', '-q', '-c', 'zzz/feat');
  commit(o, 'z.txt', 'hostile\n');
  sh(o, 'push', '-q', 'origin', 'zzz/feat');
  const feat = sh(d, 'rev-parse', 'feat');
  const { p, applied } = await act(d, { type: 'pull' });
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.display.map((x) => x.text), [
    'git fetch --no-prune --no-recurse-submodules --refmap= -- origin +refs/heads/main:refs/remotes/origin/main',
    'git merge --ff-only --end-of-options refs/remotes/origin/main',
  ]);
  assert.ok(applied.ok, JSON.stringify(applied.results));
  assert.equal(sh(d, 'rev-parse', 'feat'), feat, 'feat was not overwritten');
  assert.equal(sh(d, 'rev-parse', 'main'), sh(bare, 'rev-parse', 'main'), 'main fast-forwarded');
  assert.ok(!sh(d, 'for-each-ref', 'refs/remotes/origin/zzz').length, 'only the upstream was fetched');
});

test('B8: pull refuses an upstream whose remote branch name is not safe', async () => {
  const { d } = cloned();
  sh(d, 'config', 'branch.main.merge', 'refs/heads/-x');
  const { p } = await act(d, { type: 'pull' }, (r) => ({ ...r, git: { ...r.git, upstream: 'origin/-x' } }));
  assert.equal(p.ok, false);
  assert.match(p.error, /not a safe branch name/);
});
