const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { plan, apply } = require('../src/actions');
const { scanRepo } = require('../src/scanner');

const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-test-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'first');
  return dir;
}

// Plan + apply in one go against the real repo, then rescan.
async function doit(dir, action) {
  const repo = await scanRepo(dir, {});
  const p = await plan(repo, action);
  assert.ok(p.ok, p.error);
  const r = await apply(p);
  assert.ok(r.ok, JSON.stringify(r.results));
  return p;
}

test('local branch workflow against a real git repo', async () => {
  const dir = tempRepo();
  try {
    await doit(dir, { type: 'create-branch', name: 'feature/x' });
    assert.equal(sh(dir, 'branch', '--show-current'), 'feature/x');
    fs.writeFileSync(path.join(dir, 'b.txt'), '2\n');

    // commit-all: previews the files and commits them
    let repo = await scanRepo(dir, {});
    const cp = await plan(repo, { type: 'commit-all', message: 'add b' });
    assert.ok(cp.ok);
    assert.match(cp.warnings[0], /b\.txt/);
    assert.equal(cp.risk, 'caution');
    await apply(cp);
    assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'add b');

    await doit(dir, { type: 'checkout', branch: 'main' });
    await doit(dir, { type: 'merge-branch', branch: 'feature/x', mode: 'ff' });
    assert.ok(fs.existsSync(path.join(dir, 'b.txt')));

    // now merged, so a plain delete is allowed and is only "caution"
    repo = await scanRepo(dir, {});
    const dp = await plan(repo, { type: 'delete-local', branch: 'feature/x' });
    assert.equal(dp.risk, 'caution');
    assert.match(dp.undo, /git branch feature\/x [0-9a-f]+/);
    await apply(dp);
    assert.equal(sh(dir, 'branch', '--list', 'feature/x'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unmerged branches need force, and force is classed as dangerous', async () => {
  const dir = tempRepo();
  try {
    sh(dir, 'switch', '-qc', 'wip');
    fs.writeFileSync(path.join(dir, 'w.txt'), 'w\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-qm', 'wip');
    sh(dir, 'switch', '-q', 'main');
    const repo = await scanRepo(dir, {});
    const soft = await plan(repo, { type: 'delete-local', branch: 'wip' });
    assert.equal(soft.ok, false);
    const hard = await plan(repo, { type: 'delete-local', branch: 'wip', force: true });
    assert.equal(hard.risk, 'danger');
    assert.equal(hard.confirmName, repo.name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('add-file writes a template, refuses to overwrite, and can commit just that file', async () => {
  const dir = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'untouched\n');
    const p = await doit(dir, { type: 'add-file', template: 'license', commit: true });
    assert.equal(p.risk, 'caution');
    assert.match(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), /Test User/);
    assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'Add MIT licence');
    assert.match(sh(dir, 'status', '--short'), /dirty\.txt/); // other changes were not committed
    const repo = await scanRepo(dir, {});
    assert.equal((await plan(repo, { type: 'add-file', template: 'license' })).ok, false);
    assert.equal((await plan(repo, { type: 'add-file', template: '../../etc/passwd' })).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------ GitHub-backed actions: planned and checked without touching the network ------------ */

const ghRepo = (over = {}) => ({
  path: '/work/demo',
  name: 'demo',
  remote: { owner: 'o', name: 'demo', defaultBranch: 'main', viewerPermission: 'ADMIN', archived: false, description: 'd' },
  git: { branch: 'main', dirty: 0, upstream: 'origin/main', detached: false, branches: [{ name: 'main', current: true }, { name: 'topic' }], remoteBranches: [{ name: 'main' }, { name: 'topic' }, { name: 'old' }], mergedBranches: [] },
  prs: [
    { number: 1, title: 'ok', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', headRefName: 'topic' },
    { number: 2, title: 'draft', isDraft: true, mergeable: 'MERGEABLE', statusCheckRollup: 'NONE', headRefName: 'd' },
    { number: 3, title: 'conflict', isDraft: false, mergeable: 'CONFLICTING', statusCheckRollup: 'SUCCESS', headRefName: 'c' },
    { number: 4, title: 'red', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: 'FAILURE', headRefName: 'r' },
  ],
  ci: { failed: [{ databaseId: 77, workflowName: 'CI' }] },
  ...over,
});

test('pr-merge builds the exact gh command and rejects bad PRs', async () => {
  const repo = ghRepo();
  const ok = await plan(repo, { type: 'pr-merge', number: 1, method: 'squash', deleteBranch: true });
  assert.deepEqual(ok.steps[0].args, ['pr', 'merge', '1', '--squash', '-R', 'o/demo', '--delete-branch']);
  assert.equal(ok.risk, 'caution');
  assert.equal((await plan(repo, { type: 'pr-merge', number: 2, method: 'squash' })).ok, false); // draft
  assert.equal((await plan(repo, { type: 'pr-merge', number: 3, method: 'squash' })).ok, false); // conflicts
  assert.equal((await plan(repo, { type: 'pr-merge', number: 99, method: 'squash' })).ok, false); // unknown
  assert.equal((await plan(repo, { type: 'pr-merge', number: 1, method: 'yolo' })).ok, false);
  assert.equal((await plan(repo, { type: 'pr-merge', number: 4, method: 'squash' })).risk, 'danger'); // failing checks
});

test('remote branch deletion is guarded', async () => {
  const repo = ghRepo();
  const ok = await plan(repo, { type: 'delete-remote', branch: 'old' });
  assert.equal(ok.risk, 'danger');
  assert.equal(ok.confirmName, 'demo');
  assert.deepEqual(ok.steps[0].args.slice(-4), ['push', 'origin', '--delete', 'old']);
  assert.equal((await plan(repo, { type: 'delete-remote', branch: 'main' })).ok, false); // default
  assert.equal((await plan(repo, { type: 'delete-remote', branch: 'topic' })).ok, false); // has open PR
  assert.equal((await plan(repo, { type: 'delete-remote', branch: 'nope' })).ok, false);
  assert.equal((await plan(repo, { type: 'delete-remote', branch: '--force' })).ok, false);
});

test('branch protection sends a JSON body on stdin and needs admin', async () => {
  const repo = ghRepo();
  const p = await plan(repo, { type: 'protect-branch', preset: 'basic' });
  assert.ok(p.ok);
  assert.deepEqual(p.steps[0].args.slice(0, 4), ['api', '-X', 'PUT', 'repos/o/demo/branches/main/protection']);
  const body = JSON.parse(p.steps[0].input);
  assert.equal(body.allow_force_pushes, false);
  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 0);
  assert.equal((await plan(ghRepo({ remote: { ...repo.remote, viewerPermission: 'READ' } }), { type: 'protect-branch', preset: 'basic' })).ok, false);
  assert.equal((await plan(repo, { type: 'protect-branch', preset: 'nonsense' })).ok, false);
  assert.equal((await plan(repo, { type: 'unprotect-branch' })).risk, 'danger');
});

test('apply stops at the first failing step and uses the injected runner', async () => {
  const calls = [];
  const runner = async (cmd, args, o) => { calls.push([cmd, args, o.input]); return { ok: calls.length < 3, stdout: calls.length === 1 ? ' M a\n' : '', stderr: calls.length < 3 ? '' : 'boom' }; };
  const p = await plan(ghRepo({ git: { ...ghRepo().git, dirty: 1 } }), { type: 'commit-all', message: 'x' }, { run: async () => ({ ok: true, stdout: ' M a', stderr: '' }) });
  const r = await apply(p, { run: runner });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 3); // status check matched, add -A succeeded, commit failed; nothing after
  // A file that appeared after the preview (here a new .env) stops the commit before anything is staged.
  const drift = [];
  const changed = await apply(p, { run: async (cmd, args) => { drift.push(args); return { ok: true, stdout: ' M a\n?? .env\n', stderr: '' }; } });
  assert.equal(changed.ok, false);
  assert.equal(drift.length, 1);
  assert.match(changed.results[0].out, /changed since the preview/);
  const prot = await plan(ghRepo(), { type: 'protect-branch', preset: 'basic' });
  await apply(prot, { run: runner });
  assert.ok(calls.at(-1)[2].includes('required_pull_request_reviews'));
});

test('append and write refuse to follow a symlink out of the repo', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-link-'));
  try {
    const repo = path.join(base, 'repo');
    const outside = path.join(base, 'outside.txt');
    fs.mkdirSync(repo);
    fs.writeFileSync(outside, 'keep\n');
    fs.symlinkSync(outside, path.join(repo, '.gitignore'));
    fs.symlinkSync(base, path.join(repo, '.github'));
    const append = await apply({ steps: [{ kind: 'append', root: repo, path: path.join(repo, '.gitignore'), content: '.env\n', display: 'append' }] });
    assert.equal(append.ok, false);
    assert.match(append.results[0].out, /symbolic link/);
    const write = await apply({ steps: [{ kind: 'write', root: repo, path: path.join(repo, '.github', 'x.yml'), content: 'x', display: 'write' }] });
    assert.equal(write.ok, false);
    assert.match(write.results[0].out, /outside the repository/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n');
    assert.equal(fs.existsSync(path.join(base, 'x.yml')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('hygiene fixes: worktree prune and security features plan the exact documented calls, admin only', async () => {
  const wt = await plan(ghRepo(), { type: 'worktree-prune' });
  assert.ok(wt.ok, wt.error);
  assert.deepEqual(wt.display.map((d) => d.text), ['git worktree prune -v']);
  const want = {
    'code-scanning': 'gh api -X PATCH repos/o/demo/code-scanning/default-setup -f state=configured',
    'private-reporting': 'gh api -X PUT repos/o/demo/private-vulnerability-reporting',
    'push-protection': 'gh api -X PATCH repos/o/demo --input -',
  };
  for (const [feature, text] of Object.entries(want)) {
    const p = await plan(ghRepo(), { type: 'security-enable', feature });
    assert.ok(p.ok, feature);
    assert.ok(p.display[0].text.startsWith(text), `${feature}: ${p.display[0].text}`);
  }
  const notAdmin = await plan(ghRepo({ remote: { ...ghRepo().remote, viewerPermission: 'WRITE' } }), { type: 'security-enable', feature: 'code-scanning' });
  assert.equal(notAdmin.ok, false);
});

test('read-only mode and unknown actions are refused at plan time', async () => {
  const repo = ghRepo();
  assert.equal((await plan(repo, { type: 'fetch' }, { readOnly: true })).ok, false);
  assert.equal((await plan(repo, { type: 'rm-rf' })).ok, false);
  assert.equal((await plan(repo, { type: '__proto__' })).ok, false);
  assert.equal((await plan(repo, { type: 'constructor' })).ok, false);
  assert.equal((await plan(null, { type: 'fetch' })).ok, false);
});

test('repo-edit sanitises text and archive is dangerous', async () => {
  const repo = ghRepo();
  const p = await plan(repo, { type: 'repo-edit', description: 'hello\nworld\u0000', deleteBranchOnMerge: true });
  assert.deepEqual(p.steps[0].args, ['repo', 'edit', 'o/demo', '--description', 'hello world', '--delete-branch-on-merge=true']);
  assert.equal((await plan(repo, { type: 'repo-edit' })).ok, false);
  assert.equal((await plan(repo, { type: 'repo-archive' })).risk, 'danger');
});
