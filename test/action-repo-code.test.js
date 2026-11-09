// Actions and the programs a repo's own config or .git names (audit 2026-11-09, B9, B10):
// network steps refuse the repo's own ssh, askpass, credential and transport programs; steps that
// would run its hooks or filter drivers say so, are rated caution and are not run by Fix all on
// its own. Markers prove whether a program ran. git-lab gives a private HOME and global config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, GLOBAL, sh, repo, fresh, marker, put } = require('./helpers/git-lab');
const { plan, apply } = require('../src/actions');
const { scanRepo } = require('../src/scanner');
const { networkPrograms } = require('../src/git-safety');
const { main } = require('../src/cli');
const { isolatedEnv } = require('./helpers/env');

const planOn = async (d, action, over = (r) => r) => plan(over(await scanRepo(d, {})), action);
const gh = (r) => ({ ...r, remote: { owner: 'o', name: 'n', defaultBranch: 'main' }, prs: [], git: { ...r.git, remoteBranches: [{ name: 'old' }] } });
const NET = [{ type: 'fetch' }, { type: 'pull' }, { type: 'push' }, { type: 'delete-remote', branch: 'old' }];

// A repo whose main tracks an ssh remote (never reached: the plan is refused, or the ssh program
// is a marker that fails).
function sshRepo() {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'remote', 'add', 'origin', 'ssh://example.invalid/x.git');
  sh(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh(d, 'config', 'branch.main.remote', 'origin');
  sh(d, 'config', 'branch.main.merge', 'refs/heads/main');
  return d;
}

test('networkPrograms names the program keys and hides URLs, skipping empty values and plain url rewrites', () => {
  const e = (key, value = 'x') => ({ origin: 'file:.git/config', key, value });
  assert.deepEqual(networkPrograms([
    e('core.sshcommand'), e('core.askpass'), e('core.gitproxy'), e('remote.origin.uploadpack'), e('remote.origin.receivepack'),
    e('credential.helper'), e('credential.https://tok@example.com.helper'), e('credential.helper', ''),
    e('url.ext::sh -c id.insteadof', 'gh:'), e('url.https://example.com/.insteadof', 'gh:'), e('url.git@github.com:.pushinsteadof', 'gh:'), e('url.ssh://h/.insteadof', 's:'),
  ]), ['core.sshCommand', 'core.askPass', 'core.gitProxy', 'remote.origin.uploadpack', 'remote.origin.receivepack', 'credential.helper', 'credential.<url>.helper', 'url.<address>.insteadOf']);
});

test('B9: core.sshCommand from the repo\'s config refuses fetch, pull, push and delete-remote, and runs nothing', async () => {
  const d = sshRepo();
  const m = marker('exit 1');
  sh(d, 'config', 'core.sshCommand', m.prog);
  for (const action of NET) {
    const p = await planOn(d, action, gh);
    assert.equal(p.ok, false, action.type);
    assert.equal(p.error, 'This repo\'s own git config names programs to run for network commands (core.sshCommand). GutCheck won\'t run them; remove them or run git yourself.');
  }
  assert.equal(m.ran(), false);
});

test('B9: the same core.sshCommand in the user\'s global config is the user\'s own, and is allowed', async () => {
  const d = sshRepo();
  sh(d, 'config', 'core.sshCommand', 'ssh -o BatchMode=yes');
  sh(d, 'config', '--file', GLOBAL, 'core.sshCommand', 'ssh -o BatchMode=yes');
  try {
    for (const action of NET) assert.ok((await planOn(d, action, gh)).ok, action.type);
  } finally { sh(d, 'config', '--file', GLOBAL, '--unset', 'core.sshCommand'); }
});

test('B9: credential helpers, upload-pack, askpass and a non-http url rewrite are refused; an https rewrite is not', async () => {
  for (const [key, value, named] of [
    ['credential.helper', '!touch /tmp/x', 'credential.helper'],
    ['credential.https://example.com.helper', 'store', 'credential.<url>.helper'],
    ['remote.origin.uploadpack', 'sh -c id', 'remote.origin.uploadpack'],
    ['core.askPass', '/bin/true', 'core.askPass'],
    ['url.ext::sh -c id #.insteadOf', 'ssh://example.invalid/', 'url.<address>.insteadOf'],
  ]) {
    const d = sshRepo();
    sh(d, 'config', key, value);
    const p = await planOn(d, { type: 'fetch' });
    assert.equal(p.ok, false, key);
    assert.ok(p.error.includes(`(${named})`), p.error);
    assert.ok(!p.error.includes('example.com'), 'no URL in the message');
  }
  const d = sshRepo();
  sh(d, 'config', 'url.https://example.com/.insteadOf', 'ssh://example.invalid/');
  assert.ok((await planOn(d, { type: 'fetch' })).ok);
});

// A husky-style repo: core.hooksPath=.husky with a pre-commit hook that leaves a marker.
function huskyRepo() {
  const d = repo({ 'a.txt': '1\n' });
  const m = marker('true');
  put(d, '.husky/pre-commit', `#!/bin/sh\nexec '${m.prog}'\n`);
  fs.chmodSync(path.join(d, '.husky/pre-commit'), 0o755);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-qm', 'husky', '--no-verify');
  sh(d, 'config', 'core.hooksPath', '.husky');
  m.reset();
  return { d, m };
}

test('B10: a commit in a husky repo is caution, names the hook, and is marked as running the repo\'s code', async () => {
  const { d } = huskyRepo();
  const p = await planOn(d, { type: 'add-file', template: 'security', commit: true });
  assert.ok(p.ok, p.error);
  assert.equal(p.risk, 'caution');
  assert.equal(p.runsRepoCode, true);
  assert.ok(p.warnings.includes('This runs the repo\'s own pre-commit hook (.husky/pre-commit). That is the repo\'s code, not GutCheck\'s.'), p.warnings.join('\n'));
  fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
  const c = await planOn(d, { type: 'commit-all', message: 'x' });
  assert.equal(c.runsRepoCode, true);
  // Only the hooks a step triggers count: switching branches runs no pre-commit hook.
  sh(d, 'branch', 'topic');
  fs.rmSync(path.join(d, 'b.txt'));
  const s = await planOn(d, { type: 'checkout', branch: 'topic' });
  assert.equal(s.risk, 'safe');
  assert.equal(s.runsRepoCode, false);
});

test('B10: a repo with only the sample hooks stays safe and is not marked', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'branch', 'topic');
  assert.ok(fs.readdirSync(path.join(d, '.git', 'hooks')).some((f) => f.endsWith('.sample')));
  const p = await planOn(d, { type: 'checkout', branch: 'topic' });
  assert.equal(p.risk, 'safe');
  assert.equal(p.runsRepoCode, false);
  assert.deepEqual(p.warnings, []);
  // A hook file that is not executable is not run by git either.
  put(d, '.git/hooks/post-checkout', '#!/bin/sh\n');
  assert.equal((await planOn(d, { type: 'checkout', branch: 'topic' })).runsRepoCode, false);
});

test('B10: a linked worktree finds the hooks in the main repo\'s .git/hooks', async () => {
  const d = repo({ 'a.txt': '1\n' });
  put(d, '.git/hooks/post-checkout', '#!/bin/sh\n');
  fs.chmodSync(path.join(d, '.git/hooks/post-checkout'), 0o755);
  sh(d, 'branch', 'other');
  const wt = fresh('wt');
  sh(d, 'worktree', 'add', '-q', wt, '-b', 'wtb');
  const p = await planOn(wt, { type: 'checkout', branch: 'other' });
  assert.equal(p.risk, 'caution');
  assert.equal(p.runsRepoCode, true);
  assert.match(p.warnings.join('\n'), new RegExp(`post-checkout hook \\(${path.join(d, '.git', 'hooks', 'post-checkout').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\)`));
});

test('B10: config-based hooks and filter drivers from the repo\'s config are named; the user\'s global hooks folder is not', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'config', 'hook.lint.command', '/bin/true');
  sh(d, 'config', 'hook.lint.event', 'pre-commit');
  sh(d, 'config', 'filter.crypt.clean', 'cat');
  fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
  const p = await planOn(d, { type: 'commit-all', message: 'x' });
  assert.equal(p.runsRepoCode, true);
  const w = p.warnings.join('\n');
  assert.match(w, /pre-commit hook \(hook\.lint\.command in its git config\)/);
  assert.match(w, /\(filter\.crypt\)/);

  const e = repo({ 'a.txt': '1\n' });
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-hooks-'));
  put(hooks, 'post-checkout', '#!/bin/sh\n');
  fs.chmodSync(path.join(hooks, 'post-checkout'), 0o755);
  sh(e, 'config', '--file', GLOBAL, 'core.hooksPath', hooks);
  try {
    sh(e, 'branch', 'topic');
    const s = await planOn(e, { type: 'checkout', branch: 'topic' });
    assert.equal(s.runsRepoCode, false, 'the user\'s own hooks are not the repo\'s code');
  } finally { sh(e, 'config', '--file', GLOBAL, '--unset', 'core.hooksPath'); fs.rmSync(hooks, { recursive: true, force: true }); }
});

test('B10: Fix all does not run a husky repo\'s commit on its own; a repo without hooks still does', async () => {
  const root = fs.mkdtempSync(path.join(ROOT, 'ws-'));
  const data = fs.mkdtempSync(path.join(ROOT, 'data-'));
  const env = isolatedEnv({ GUTCHECK_DATA_DIR: data, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
  const run = async (argv) => { const o = []; const e = []; const code = await main(argv, { out: (s) => o.push(s), err: (s) => e.push(s), env }); return { code, out: o.join('\n'), err: e.join('\n') }; };
  const { d: h, m } = huskyRepo();
  fs.renameSync(h, path.join(root, 'husky'));
  const plain = repo({ 'README.md': '# plain\n' });
  fs.renameSync(plain, path.join(root, 'plain'));
  const dry = await run(['fix', 'husky', 'all', '--root', root]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /Not run on its own[\s\S]*Add \.gitignore and commit it[\s\S]*pre-commit hook/);
  assert.doesNotMatch(dry.out, /^\d+\. Add \.gitignore and commit it/m);
  const yes = await run(['fix', 'husky', 'all', '--yes', '--root', root]);
  assert.equal(yes.code, 0, yes.err + yes.out);
  assert.equal(m.ran(), false, 'the repo\'s pre-commit hook did not run');
  assert.equal(sh(path.join(root, 'husky'), 'log', '--format=%s'), 'husky\ninit', 'nothing was committed');
  const ok = await run(['fix', 'plain', 'all', '--yes', '--root', root]);
  assert.equal(ok.code, 0, ok.err + ok.out);
  assert.match(sh(path.join(root, 'plain'), 'log', '--format=%s'), /Add \.gitignore/);
});

test('B10: the app\'s Fix all review starts a step that runs the repo\'s code unticked', async () => {
  const { boot, tick } = require('./helpers/dom');
  const t = await boot({ repos: [] });
  const sent = [];
  const mk = (token, runsRepoCode) => ({ ok: true, token, repoName: 'app', title: token, risk: runsRepoCode ? 'caution' : 'safe', display: [{ text: 'git x' }], warnings: [], undo: null, confirmName: null, runsRepoCode });
  t.w.api.planActions = async () => [mk('hooked', true), mk('plain', false)];
  t.w.api.applyActions = async (tokens) => { sent.push(tokens); return []; };
  const r = { path: '/w/app' };
  t.w.runActions([{ repo: r, action: { type: 'x' } }, { repo: r, action: { type: 'y' } }], { ask: false, hold: t.w.FixAll.automatic });
  await tick();
  assert.deepEqual(t.$$('.modal .phead input[type=checkbox]').map((b) => b.checked), [false, true]);
  assert.match(t.$('.modal').textContent, /run the repo's own code \(its hooks or filter drivers\) start unticked/);
  t.$$('.modal button').find((b) => /^Apply/.test(b.textContent)).click();
  await tick();
  assert.deepEqual(sent, [['plain']]);
});
