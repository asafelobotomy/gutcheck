// Round two of the review of B9 and B10 (audit 2026-11-09): hooks folders that reach the work tree
// through /proc or a symlink, settings included from the repo's own files, a re-check just before
// each plan of a batch runs, and hooks folders outside the tree. Markers prove whether a hook ran.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, GLOBAL, sh, repo, fresh, marker, put } = require('./helpers/git-lab');
const { sshUrl } = require('./helpers/fake-ssh');
const { plan } = require('../src/actions');
const { scanRepo } = require('../src/scanner');
const { createService } = require('../src/service');

const planOn = async (d, action) => plan(await scanRepo(d, {}), action);
const hook = (dir, rel, m) => { put(dir, rel, `#!/bin/sh\n'${m.prog}' </dev/null\ncat >/dev/null 2>&1\nexit 0\n`); fs.chmodSync(path.join(dir, rel), 0o755); };
const withGlobal = async (key, value, fn) => { sh(ROOT, 'config', '--file', GLOBAL, key, value); try { return await fn(); } finally { sh(ROOT, 'config', '--file', GLOBAL, '--unset', key); } };

// A repo with a tracked .husky/post-checkout hook and a branch topic.
function tracked() {
  const d = repo({ 'a.txt': '1\n' });
  const m = marker('true');
  hook(d, '.husky/post-checkout', m);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-qm', 'hooks');
  sh(d, 'branch', 'topic');
  m.reset();
  return { d, m };
}

test('round 2, 1: a repo-set hooks folder through /proc/self/cwd or a symlink to the repo marks checkout', async () => {
  const { d } = tracked();
  sh(d, 'config', 'core.hooksPath', '/proc/self/cwd/.husky');
  const p = await planOn(d, { type: 'checkout', branch: 'topic' });
  assert.equal(p.risk, 'caution');
  assert.equal(p.runsRepoCode, true);
  assert.match(p.warnings.join('\n'), /own git config chooses its hooks folder \(\/proc\/self\/cwd\/\.husky\)/);
  const link = fresh('lnk');
  fs.symlinkSync(d, link);
  sh(d, 'config', 'core.hooksPath', path.join(link, '.husky'));
  assert.equal((await planOn(d, { type: 'checkout', branch: 'topic' })).runsRepoCode, true);
});

test('round 2, 1: the user\'s own hooks folder through /proc/self/cwd or a symlink into the repo counts as the repo\'s files', async () => {
  const { d } = tracked();
  await withGlobal('core.hooksPath', '/proc/self/cwd/.husky', async () => {
    const p = await planOn(d, { type: 'checkout', branch: 'topic' });
    assert.equal(p.runsRepoCode, true);
    assert.match(p.warnings.join('\n'), /Your git config keeps hooks in each repo's files/);
  });
  const link = fresh('lnk');
  fs.symlinkSync(d, link);
  await withGlobal('core.hooksPath', path.join(link, '.husky'), async () => {
    assert.equal((await planOn(d, { type: 'checkout', branch: 'topic' })).runsRepoCode, true);
  });
});

test('round 2, 5: a relative hooks folder in the user\'s own config says so in the warning', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'branch', 'topic');
  await withGlobal('core.hooksPath', '.githooks', async () => {
    const p = await planOn(d, { type: 'checkout', branch: 'topic' });
    assert.equal(p.runsRepoCode, true);
    assert.ok(p.warnings.includes('Your git config keeps hooks in each repo\'s files (.githooks), so this step can run hooks that come with this repo\'s files. That is the repo\'s code, not GutCheck\'s.'), p.warnings.join('\n'));
  });
});

test('round 2, 4: a hooks folder outside the work tree (../shared-hooks) still plans, and its hooks are named', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'branch', 'topic');
  const shared = path.join(path.dirname(d), 'shared-hooks');
  sh(d, 'config', 'core.hooksPath', '../shared-hooks');
  let p = await planOn(d, { type: 'checkout', branch: 'topic' });
  assert.ok(p.ok, p.error);
  assert.equal(p.runsRepoCode, true, 'set by the repo\'s own config');
  sh(d, 'config', '--unset', 'core.hooksPath');
  const m = marker('true');
  hook(path.dirname(d), 'shared-hooks/post-checkout', m);
  try {
    await withGlobal('core.hooksPath', '../shared-hooks', async () => {
      p = await planOn(d, { type: 'checkout', branch: 'topic' });
      assert.ok(p.ok, p.error);
      assert.equal(p.runsRepoCode, true);
      assert.match(p.warnings.join('\n'), /post-checkout hook \(/);
      assert.doesNotMatch(p.warnings.join('\n'), /keeps hooks in each repo's files/);
    });
  } finally { fs.rmSync(shared, { recursive: true, force: true }); }
});

// The reviewer's chain: the repo's config includes ../repo.cfg (not there yet); a pull brings it,
// setting core.hooksPath=.h, with .h/pre-commit; a commit planned with the pull would run it.
async function chain() {
  const bare = fresh('bare');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'remote', 'add', 'origin', sshUrl(bare));
  sh(d, 'push', '-q', '-u', 'origin', 'main');
  const o = fresh('o');
  sh(ROOT, 'clone', '-q', bare, o);
  sh(o, 'config', 'user.email', 'a@a');
  sh(o, 'config', 'user.name', 'a');
  const m = marker('true');
  put(o, 'repo.cfg', '[core]\n\thooksPath = .h\n');
  hook(o, '.h/pre-commit', m);
  sh(o, 'add', '-A');
  sh(o, 'commit', '-qm', 'x');
  sh(o, 'push', '-q');
  fs.writeFileSync(path.join(d, 'b.txt'), 'dirty\n');
  sh(d, 'fetch', '-q');
  return { d, m };
}

test('round 2, 2a: settings included from the repo\'s own files mark pull and commit', async () => {
  const { d } = await chain();
  sh(d, 'config', 'include.path', '../repo.cfg');
  const r = await scanRepo(d, {});
  for (const action of [{ type: 'pull' }, { type: 'commit-all', message: 'm' }]) {
    const p = await plan(r, action);
    assert.ok(p.ok, p.error);
    assert.equal(p.runsRepoCode, true, action.type);
    assert.match(p.warnings.join('\n'), /reads settings from its own files \(\.\.\/repo\.cfg\)/, action.type);
  }
});

test('round 2, 2b: in a batch, a commit is held when the pull before it brought new hooks, and the hook does not run', async () => {
  const { d, m } = await chain();
  sh(d, 'config', 'include.path', '../repo.cfg');
  const known = new Map([[d, await scanRepo(d, {})]]);
  const svc = createService({ known, settings: () => ({}), audit() {} });
  const plans = await svc.planActions([{ dir: d, action: { type: 'pull' } }, { dir: d, action: { type: 'commit-all', message: 'm' } }]);
  assert.ok(plans.every((p) => p.ok), JSON.stringify(plans));
  const out = await svc.applyActions(plans.map((p) => p.token));
  assert.equal(out[0].ok, true, JSON.stringify(out[0]));
  assert.equal(out[1].ok, false);
  assert.equal(out[1].held, true);
  assert.match(out[1].error, /^Held: the repo changed after the preview\. .*pre-commit hook \(\.h\/pre-commit\)/);
  assert.equal(m.ran(), false);
  assert.ok(fs.existsSync(path.join(d, 'b.txt')) && /b\.txt/.test(sh(d, 'status', '--porcelain')), 'nothing was committed');
});

test('round 2, 2b: a plan is held when the repo gains a hook between preview and apply; an unchanged one runs', async () => {
  const d = repo({ 'a.txt': '1\n' });
  fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
  const known = new Map([[d, await scanRepo(d, {})]]);
  const svc = createService({ known, settings: () => ({}), audit() {} });
  let [p] = await svc.planActions([{ dir: d, action: { type: 'commit-all', message: 'm' } }]);
  assert.equal(p.runsRepoCode, false);
  const m = marker('true');
  hook(d, '.git/hooks/pre-commit', m);
  let [r] = await svc.applyActions([p.token]);
  assert.equal(r.held, true, JSON.stringify(r));
  assert.equal(m.ran(), false);
  fs.rmSync(path.join(d, '.git/hooks/pre-commit'));
  [p] = await svc.planActions([{ dir: d, action: { type: 'commit-all', message: 'm' } }]);
  [r] = await svc.applyActions([p.token]);
  assert.equal(r.ok, true, JSON.stringify(r));
});
