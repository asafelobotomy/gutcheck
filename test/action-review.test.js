// Follow-ups from the independent review of B9 and B10 (audit 2026-11-09): hooks that arrive with
// the checked-out files, submodule recursion, local-path and helper remotes, alternate-refs and
// signing-key commands, and Fix all's hold everywhere it runs. Markers prove whether a program ran.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, GLOBAL, sh, repo, fresh, marker, put } = require('./helpers/git-lab');
const { sshUrl } = require('./helpers/fake-ssh');
const { isolatedEnv } = require('./helpers/env');
const { plan, apply } = require('../src/actions');
const { scanRepo } = require('../src/scanner');

const planOn = async (d, action, over = (r) => r) => plan(over(await scanRepo(d, {})), action);
const run = async (d, action, over) => { const p = await planOn(d, action, over); return { p, res: p.ok ? await apply(p) : null }; };
const hook = (dir, rel, m) => { put(dir, rel, `#!/bin/sh\n'${m.prog}' </dev/null\ncat >/dev/null\nexit 0\n`); fs.chmodSync(path.join(dir, rel), 0o755); };
const noHooks = (d, ...a) => sh(d, '-c', 'core.hooksPath=/dev/null', ...a);

// core.hooksPath=.husky, and a branch topic whose files add .husky/<name>; main has no hooks.
function arriving(name) {
  const d = repo({ 'a.txt': '1\n' });
  const m = marker('true');
  sh(d, 'config', 'core.hooksPath', '.husky');
  noHooks(d, 'switch', '-q', '-c', 'topic');
  hook(d, `.husky/${name}`, m);
  noHooks(d, 'add', '-A');
  noHooks(d, 'commit', '-qm', 'hook');
  noHooks(d, 'switch', '-q', 'main');
  m.reset();
  return { d, m };
}

test('review 1: a post-checkout hook that arrives with the branch is named, and the plan is caution', async () => {
  const { d } = arriving('post-checkout');
  const p = await planOn(d, { type: 'checkout', branch: 'topic' });
  assert.equal(p.risk, 'caution');
  assert.equal(p.runsRepoCode, true);
  assert.match(p.warnings.join('\n'), /post-checkout hook \(\.husky\/post-checkout, in the files of topic\)/);
  assert.match(p.warnings.join('\n'), /own git config chooses its hooks folder \(\.husky\)/);
});

test('review 1: merge (post-merge), pull and commit are marked whenever the hooks folder is inside the repo', async () => {
  const { d } = arriving('post-merge');
  const m = await planOn(d, { type: 'merge-branch', branch: 'topic', mode: 'ff' });
  assert.equal(m.runsRepoCode, true);
  assert.match(m.warnings.join('\n'), /post-merge hook \(\.husky\/post-merge, in the files of topic\)/);
  fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
  const c = await planOn(d, { type: 'commit-all', message: 'x' });
  assert.equal(c.runsRepoCode, true, 'no hook is there yet, but the repo\'s files decide which run');
  const bare = fresh('bare');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(d, 'remote', 'add', 'origin', sshUrl(bare));
  noHooks(d, 'push', '-q', '-u', 'origin', 'main');
  const pl = await planOn(d, { type: 'pull' });
  assert.ok(pl.ok, pl.error);
  assert.equal(pl.runsRepoCode, true);
});

test('review 2: a repo-local submodule.recurse=true does not reach into the submodule (its filter and hooks do not run)', async () => {
  const sub = repo({ 's.txt': 's\n' });
  const d = repo({ 'a.txt': '1\n' });
  sh(d, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
  sh(d, 'commit', '-qm', 'sub');
  sh(d, 'switch', '-q', '-c', 'topic');
  fs.writeFileSync(path.join(d, 'sub', 's.txt'), 'changed\n');
  sh(path.join(d, 'sub'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'c');
  sh(d, 'commit', '-qam', 'bump');
  sh(d, 'switch', '-q', 'main');
  sh(d, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q');
  const subHead = sh(path.join(d, 'sub'), 'rev-parse', 'HEAD');
  sh(d, 'config', 'submodule.recurse', 'true');
  const sg = path.join(d, '.git', 'modules', 'sub');
  const smudge = marker('cat');
  sh(path.join(d, 'sub'), 'config', 'filter.x.smudge', smudge.prog);
  put(sg, 'info/attributes', '* filter=x\n');
  const subHook = marker('true');
  hook(sg, 'hooks/post-checkout', subHook);
  hook(sg, 'hooks/reference-transaction', subHook);
  const { p, res } = await run(d, { type: 'checkout', branch: 'topic' });
  assert.ok(p.ok && res.ok, JSON.stringify(res || p));
  assert.equal(smudge.ran(), false, 'the submodule\'s filter did not run');
  assert.equal(subHook.ran(), false, 'the submodule\'s hooks did not run');
  assert.equal(sh(path.join(d, 'sub'), 'rev-parse', 'HEAD'), subHead, 'the submodule was not checked out');
});

test('review 3, 6: local-path, file://, self and helper remotes are refused for every network action, and run nothing', async () => {
  const bare = fresh('bare');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  const m = marker('true');
  hook(bare, 'hooks/pre-receive', m);
  const gh = (r) => ({ ...r, remote: { owner: 'o', name: 'n', defaultBranch: 'main' }, prs: [], git: { ...r.git, upstream: r.git.upstream, remoteBranches: [{ name: 'old' }] } });
  for (const [what, setup] of [
    ['a local path', (d) => sh(d, 'remote', 'add', 'origin', bare)],
    ['a file:// URL', (d) => sh(d, 'remote', 'add', 'origin', `file://${bare}`)],
    ['the repo itself', (d) => sh(d, 'remote', 'add', 'origin', '.')],
    ['a remote helper', (d) => sh(d, 'remote', 'add', 'origin', 'evil::x')],
    ['remote.origin.vcs', (d) => { sh(d, 'remote', 'add', 'origin', 'x'); sh(d, 'config', 'remote.origin.vcs', 'evil'); }],
    ['a local push URL', (d) => { sh(d, 'remote', 'add', 'origin', sshUrl(bare)); sh(d, 'remote', 'set-url', '--push', 'origin', bare); }],
    ['a global rewrite to a local path', (d) => { sh(d, 'remote', 'add', 'origin', 'ssh://lab.invalid/x'); sh(d, 'config', '--file', GLOBAL, `url.${bare}.insteadOf`, 'ssh://lab.invalid/x'); }],
  ]) {
    const d = repo({ 'a.txt': '1\n' });
    setup(d);
    sh(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    sh(d, 'config', 'branch.main.remote', 'origin');
    sh(d, 'config', 'branch.main.merge', 'refs/heads/main');
    try {
      const types = what === 'a local push URL' ? ['push', 'delete-remote'] : ['fetch', 'pull', 'push', 'delete-remote'];
      for (const type of types) {
        const { p } = await run(d, { type, branch: 'old' }, gh);
        assert.equal(p.ok, false, `${what}: ${type}`);
        assert.match(p.error, /remote "origin" is a local folder, a file:\/\/ URL or a remote helper/, `${what}: ${type}`);
        assert.ok(!p.error.includes(bare), 'no URL in the message');
      }
    } finally { if (what.startsWith('a global')) sh(d, 'config', '--file', GLOBAL, '--unset', `url.${bare}.insteadOf`); }
  }
  assert.equal(m.ran(), false, 'the local remote\'s pre-receive hook did not run');
});

test('review 3: a plain ssh remote still pushes', async () => {
  const bare = fresh('bare');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'remote', 'add', 'origin', sshUrl(bare));
  const { p, res } = await run(d, { type: 'push' });
  assert.ok(p.ok && res.ok, JSON.stringify(res || p));
  assert.equal(sh(bare, 'rev-parse', 'main'), sh(d, 'rev-parse', 'main'));
});

test('review 4: core.alternateRefsCommand from the repo\'s config does not run on fetch or push', async () => {
  const bare = fresh('bare');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  const other = repo({ 'o.txt': 'o\n' });
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'remote', 'add', 'origin', sshUrl(bare));
  sh(d, 'push', '-q', '-u', 'origin', 'main');
  const o = fresh('o');
  sh(ROOT, 'clone', '-q', bare, o);
  fs.writeFileSync(path.join(o, 'n.txt'), 'n');
  sh(o, 'add', '-A');
  sh(o, '-c', 'user.email=a@a', '-c', 'user.name=a', 'commit', '-qm', 'n');
  sh(o, 'push', '-q', 'origin', 'main:newb');
  fs.writeFileSync(path.join(d, '.git', 'objects', 'info', 'alternates'), path.join(other, '.git', 'objects') + '\n');
  const m = marker('true');
  sh(d, 'config', 'core.alternateRefsCommand', m.prog);
  let { p, res } = await run(d, { type: 'fetch' });
  assert.ok(p.ok && res.ok, JSON.stringify(res || p));
  assert.equal(m.ran(), false, 'fetch');
  fs.writeFileSync(path.join(d, 'z.txt'), 'z');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-qm', 'z');
  ({ p, res } = await run(d, { type: 'push' }));
  assert.ok(p.ok && res.ok, JSON.stringify(res || p));
  assert.equal(m.ran(), false, 'push');
});

test('review 5: gpg.ssh.defaultKeyCommand does not run; commits are unsigned, and the plan says so when you sign', async () => {
  const m = marker('echo "key::ssh-ed25519 AAAA"');
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'config', 'commit.gpgSign', 'true');
  sh(d, 'config', 'gpg.format', 'ssh');
  sh(d, 'config', 'gpg.ssh.defaultKeyCommand', m.prog);
  fs.writeFileSync(path.join(d, 'a.txt'), '2\n');
  let { p, res } = await run(d, { type: 'commit-all', message: 'x' });
  assert.ok(res && res.ok, JSON.stringify(res || p));
  assert.equal(m.ran(), false, 'commit-all');
  assert.equal(p.note, null, 'signing is the repo\'s setting here, not the user\'s');
  sh(d, '-c', 'commit.gpgSign=false', 'switch', '-q', '-c', 't');
  fs.writeFileSync(path.join(d, 'b.txt'), 'b');
  sh(d, 'add', '-A');
  sh(d, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'b');
  sh(d, 'switch', '-q', 'main');
  ({ p, res } = await run(d, { type: 'merge-branch', branch: 't', mode: 'no-ff' }));
  assert.ok(res && res.ok, JSON.stringify(res || p));
  assert.equal(m.ran(), false, 'merge --no-ff');
  sh(d, 'config', '--file', GLOBAL, 'commit.gpgSign', 'true');
  try {
    fs.writeFileSync(path.join(d, 'a.txt'), '3\n');
    p = await planOn(d, { type: 'commit-all', message: 'y' });
    assert.match(p.note, /Your git config signs commits \(commit\.gpgSign\), but GutCheck's commits are not signed/);
  } finally { sh(d, 'config', '--file', GLOBAL, '--unset', 'commit.gpgSign'); }
});

test('review 7: the overview\'s bulk Fix all starts a step that runs the repo\'s code unticked', async () => {
  const { boot, tick } = require('./helpers/dom');
  const fix = { type: 'pull', label: 'Pull' };
  const mk = (name) => ({ path: `/w/${name}`, name, score: 80, grade: 'B', prs: [], ci: { failed: [] }, alerts: [], files: {}, remote: null,
    git: { branch: 'main', dirty: 0, ahead: 0, behind: 1, upstream: 'origin/main', branches: [], remoteBranches: [], mergedBranches: [], remotes: ['origin'] },
    findings: [{ id: 'git-behind', severity: 'warn', category: 'Git', title: 'Behind upstream', detail: '', fix }] });
  const t = await boot({ repos: [mk('a'), mk('b')] });
  t.w.api.planActions = async (items) => items.map((i, k) => ({ ok: true, token: 't' + k, repoName: i.dir, title: 'Pull', risk: k ? 'safe' : 'caution', display: [{ text: 'git x' }], warnings: [], undo: null, runsRepoCode: k === 0 }));
  t.$('#scan').click(); await tick(80);
  t.$('#overview').click(); await tick();
  const b = t.$$('button').find((x) => /^Fix all 2/.test(x.textContent));
  assert.ok(b, 'the overview offers a bulk fix');
  b.click(); await tick();
  assert.deepEqual(t.$$('.modal .phead input[type=checkbox]').map((x) => x.checked), [false, true]);
});

test('review 7: Fix all through the engine (CLI, MCP) returns held plans without a token', async () => {
  const { createEngine } = require('../src/engine');
  const root = fs.mkdtempSync(path.join(ROOT, 'ws-'));
  const data = fs.mkdtempSync(path.join(ROOT, 'data-'));
  const d = path.join(root, 'husky');
  fs.renameSync(repo({ 'a.txt': '1\n' }), d);
  sh(d, 'config', 'core.hooksPath', '.husky');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ root }));
  const e = createEngine({ env: isolatedEnv({ GUTCHECK_DATA_DIR: data, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' }), allowActions: true });
  const out = await e.plan({ items: [{ repo: 'husky', all: true }] });
  assert.ok(out.ok, out.error);
  assert.ok(out.held && out.held.length, JSON.stringify(out));
  for (const h of out.held) {
    assert.equal(h.token, undefined);
    assert.match(h.note, /ask the user to run this in the GutCheck app or CLI/);
  }
  assert.ok(out.plans.every((p) => !p.ok || !p.runsRepoCode));
});

test('review 8: fetch with no remotes says there is nothing to fetch, and the app shows no Fetch button', async () => {
  const d = repo({ 'a.txt': '1\n' });
  const r = await scanRepo(d, {});
  assert.deepEqual(r.git.remotes, []);
  const p = await plan(r, { type: 'fetch' });
  assert.equal(p.ok, false);
  assert.equal(p.nothing, true);
  assert.equal(p.error, 'Nothing to fetch: this repo has no remotes.');
  const { boot, tick } = require('./helpers/dom');
  const t = await boot({ repos: [{ ...r, findings: [], score: 100, grade: 'A', prs: [], ci: { failed: [] }, alerts: [] }] });
  t.$('#scan').click(); await tick(80);
  t.$$('#repos li')[0].click(); await tick();
  assert.ok(!t.$$('.toolbar button').some((b) => b.textContent === 'Fetch & prune'));
  t.w.api.planActions = async () => [{ ok: false, nothing: true, repoName: 'x', error: 'Nothing to fetch: this repo has no remotes.' }];
  await t.w.runActions([{ repo: r, action: { type: 'fetch' } }]);
  assert.notEqual(t.$('#toast').className, 'bad');
  assert.match(t.$('#toast').textContent, /Nothing to fetch/);
});
