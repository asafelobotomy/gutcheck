// The "safe" push action pushes one branch, whatever the repo's config says (audit 2026-11-09, B5).
// Real local repos and bare remotes; the remote's other branches and commits must survive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-push-'));
const GLOBAL = path.join(ROOT, 'gitconfig');
fs.mkdirSync(path.join(ROOT, 'home'));
fs.writeFileSync(GLOBAL, '');
Object.assign(process.env, { HOME: path.join(ROOT, 'home'), GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { plan, apply } = require('../src/actions');
const { sshUrl } = require('./helpers/fake-ssh');
const { scanRepo } = require('../src/scanner');

let n = 0;
const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (d, text) => { fs.writeFileSync(path.join(d, 'a.txt'), text); sh(d, 'commit', '-qam', text); };

// A bare remote with main, other and keep; a clone whose main tracks origin/main and is one ahead.
function setup() {
  const bare = path.join(ROOT, `bare${++n}.git`);
  const d = path.join(ROOT, `work${n}`);
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@t');
  sh(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), '1\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-qm', 'one');
  sh(d, 'remote', 'add', 'origin', sshUrl(bare));
  sh(d, 'push', '-q', 'origin', 'main:other', 'main:keep');
  sh(d, 'push', '-q', '-u', 'origin', 'main');
  commit(d, '2\n');
  return { d, bare, heads: () => sh(bare, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads') };
}

async function push(d) {
  const p = await plan(await scanRepo(d, {}), { type: 'push' });
  if (!p.ok) return { planned: p };
  return { planned: p, applied: await apply(p) };
}

test('B5: remote.origin.mirror=true does not delete the remote\'s other branches', async () => {
  const { d, bare, heads } = setup();
  const before = heads();
  sh(d, 'config', 'remote.origin.mirror', 'true');
  const r = await push(d);
  assert.ok(r.planned.ok, r.planned.error);
  assert.ok(r.applied.ok, JSON.stringify(r.applied.results));
  assert.deepEqual(sh(bare, 'branch', '--format=%(refname:short)').split('\n').sort(), ['keep', 'main', 'other']);
  assert.equal(sh(bare, 'rev-parse', 'main'), sh(d, 'rev-parse', 'main'));
  assert.equal(heads().split('\n').filter((l) => !l.startsWith('main ')).join('\n'), before.split('\n').filter((l) => !l.startsWith('main ')).join('\n'));
});

test('B5: remote.origin.mirror=true with no upstream yet still pushes only the branch', async () => {
  const { d, bare } = setup();
  sh(d, 'switch', '-q', '-c', 'feat');
  commit(d, '3\n');
  sh(d, 'config', 'remote.origin.mirror', 'true');
  const r = await push(d);
  assert.ok(r.planned.ok && r.applied.ok, JSON.stringify(r));
  assert.deepEqual(sh(bare, 'branch', '--format=%(refname:short)').split('\n').sort(), ['feat', 'keep', 'main', 'other']);
  assert.equal(sh(d, 'rev-parse', '--abbrev-ref', 'feat@{u}'), 'origin/feat');
});

test('B5: a forcing remote.origin.push refspec does not force-push', async () => {
  const { d, bare } = setup();
  const remoteMain = sh(bare, 'rev-parse', 'main');
  sh(d, 'push', '-q');
  const pushed = sh(bare, 'rev-parse', 'main');
  assert.notEqual(pushed, remoteMain);
  sh(d, 'reset', '-q', '--hard', 'HEAD~1');
  commit(d, 'diverged\n');
  sh(d, 'config', 'remote.origin.push', '+refs/heads/main:refs/heads/main');
  const r = await push(d);
  assert.ok(r.planned.ok, r.planned.error);
  assert.equal(r.applied.ok, false, 'a non-fast-forward push must be rejected');
  assert.equal(sh(bare, 'rev-parse', 'main'), pushed, 'the remote main was overwritten');
});

test('B5: a forcing push refspec cannot redirect the push onto another remote branch', async () => {
  const { d, bare } = setup();
  const other = sh(bare, 'rev-parse', 'other');
  sh(d, 'config', 'remote.origin.push', '+refs/heads/main:refs/heads/other');
  const r = await push(d);
  assert.ok(r.planned.ok && r.applied.ok, JSON.stringify(r));
  assert.equal(sh(bare, 'rev-parse', 'other'), other);
  assert.equal(sh(bare, 'rev-parse', 'main'), sh(d, 'rev-parse', 'main'));
});

test('B5: a branch named --mirror is refused', async () => {
  const { d, heads } = setup();
  const before = heads();
  sh(d, 'update-ref', 'refs/heads/--mirror', 'HEAD');
  sh(d, 'symbolic-ref', 'HEAD', 'refs/heads/--mirror');
  const r = await push(d);
  assert.equal(r.planned.ok, false, 'the push was planned');
  assert.match(r.planned.error, /branch name/i);
  assert.equal(heads(), before);
});

test('push: push.followTags and push.recurseSubmodules in repo config do not widen the push', async () => {
  const { d, bare } = setup();
  sh(d, 'tag', '-a', '-m', 'release', 'v9.9.9');
  sh(d, 'config', 'push.followTags', 'true');
  sh(d, 'config', 'push.recurseSubmodules', 'on-demand');
  const r = await push(d);
  assert.ok(r.planned.ok && r.applied.ok, JSON.stringify(r));
  assert.equal(sh(bare, 'tag', '--list'), '', 'a tag was pushed that the preview did not show');
  assert.ok(r.planned.steps[0].args.includes('--no-follow-tags') && r.planned.steps[0].args.includes('--recurse-submodules=no'));
});

test('push: a normal push to a same-name upstream still works', async () => {
  const { d, bare } = setup();
  const r = await push(d);
  assert.ok(r.planned.ok && r.applied.ok, JSON.stringify(r));
  assert.equal(sh(bare, 'rev-parse', 'main'), sh(d, 'rev-parse', 'main'));
  assert.equal(sh(d, 'status', '--porcelain=v2', '--branch').includes('# branch.ab +0 -0'), true);
});

test('push: a normal push sends the branch to its upstream branch, and -u sets a new upstream', async () => {
  const { d, bare } = setup();
  sh(d, 'push', '-q', 'origin', 'main:develop');
  sh(d, 'switch', '-q', '-c', 'dev', '--track', 'origin/develop');
  commit(d, 'dev work\n');
  const r = await push(d);
  assert.ok(r.planned.ok && r.applied.ok, JSON.stringify(r));
  assert.equal(sh(bare, 'rev-parse', 'develop'), sh(d, 'rev-parse', 'dev'));
  assert.equal(sh(bare, 'branch', '--list', 'dev'), '', 'pushed to the upstream branch, not a new one');
  assert.match(r.planned.display[0].text, /^git push --no-follow-tags --recurse-submodules=no -- origin refs\/heads\/dev:refs\/heads\/develop$/);

  sh(d, 'switch', '-q', '-c', 'fresh');
  commit(d, 'fresh\n');
  const f = await push(d);
  assert.ok(f.planned.ok && f.applied.ok, JSON.stringify(f));
  assert.equal(sh(bare, 'rev-parse', 'fresh'), sh(d, 'rev-parse', 'fresh'));
  assert.equal(sh(d, 'rev-parse', '--abbrev-ref', 'fresh@{u}'), 'origin/fresh');
  assert.match(f.planned.display[0].text, /^git push --no-follow-tags --recurse-submodules=no -u -- origin refs\/heads\/fresh:refs\/heads\/fresh$/);
});
