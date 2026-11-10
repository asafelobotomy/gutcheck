// Git 2.54 can run hooks defined in config (hook.<name>.command + hook.<name>.event). They run
// even with core.hooksPath=/dev/null, so a repo's own config could run a program during a scan or
// a plan's read-only git call. GutCheck switches off the repo's own ones (git-drivers.js) and the
// plan preview names them (git-safety.js). Markers prove whether a program ran.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, GLOBAL, sh, repo, marker, put } = require('./helpers/git-lab');
const exec = require('../src/exec');
const { defaultCtx } = require('../src/apply');
const { plan } = require('../src/actions');
const { scanRepo } = require('../src/scanner');

const [MAJ, MIN] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })).slice(1).map(Number);
const HAS_CONFIG_HOOKS = MAJ > 2 || (MAJ === 2 && MIN >= 54);
const opts = { skip: HAS_CONFIG_HOOKS ? false : 'needs git 2.54 (config-based hooks)' };

const hooked = (d, name, event, prog) => { sh(d, 'config', `hook.${name}.command`, prog); sh(d, 'config', '--add', `hook.${name}.event`, event); };
const two = () => repo({ 'a.txt': '1\n' });

test('control: a config hook runs under the old hardening alone', opts, () => {
  const d = two();
  const m = marker();
  hooked(d, 'evil', 'pre-commit', m.prog);
  sh(d, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-q', '-m', 'x');
  assert.equal(m.ran(), true, 'the repro no longer reproduces');
});

for (const [event, args] of [
  ['pre-commit', ['commit', '--allow-empty', '-q', '-m', 'x']],
  ['post-commit', ['commit', '--allow-empty', '-q', '-m', 'x']],
  ['reference-transaction', ['update-ref', 'refs/heads/other', 'HEAD']],
  ['post-checkout', ['checkout', '-q', 'topic']],
  ['post-merge', ['merge', '-q', 'topic']],
]) {
  test(`exec.git does not run a repo's config hook on ${event} (${args[0]})`, opts, async () => {
    const d = two();
    sh(d, 'checkout', '-q', '-b', 'topic');
    put(d, 'c.txt', 'c\n');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'c');
    sh(d, 'checkout', '-q', 'main');
    const m = marker();
    hooked(d, 'evil', event, m.prog);
    const r = await exec.git(args, { cwd: d });
    assert.ok(r.ok, r.stderr);
    assert.equal(m.ran(), false, `${event} hook ran`);
  });
}

test('safeGit (plans and checks) does not run a repo\'s config hook', opts, async () => {
  const d = two();
  const m = marker();
  hooked(d, 'evil', 'reference-transaction', m.prog);
  const r = await defaultCtx().safeGit(['update-ref', 'refs/heads/other', 'HEAD'], d);
  assert.ok(r.ok, r.stderr);
  assert.equal(m.ran(), false);
});

test('a hook with dots and capitals in its name, and one from an included file, are switched off', opts, async () => {
  const d = two();
  const m = marker();
  hooked(d, 'My.Lint.v2', 'pre-commit', m.prog);
  const m2 = marker();
  const inc = path.join(ROOT, `inc-hook${Date.now()}.cfg`);
  fs.writeFileSync(inc, `[hook "from-inc"]\n\tcommand = ${m2.prog}\n\tevent = pre-commit\n`);
  sh(d, 'config', 'include.path', inc);
  const r = await exec.git(['commit', '--allow-empty', '-q', '-m', 'x'], { cwd: d });
  assert.ok(r.ok, r.stderr);
  assert.equal(m.ran(), false, 'dotted name ran');
  assert.equal(m2.ran(), false, 'included hook ran');
});

test('an event in the repo with a command from the user\'s own config is switched off too', opts, async () => {
  const d = two();
  const m = marker();
  sh(d, 'config', '--file', GLOBAL, 'hook.gl.command', m.prog);
  try {
    sh(d, 'config', 'hook.gl.event', 'pre-commit');
    const r = await exec.git(['commit', '--allow-empty', '-q', '-m', 'x'], { cwd: d });
    assert.ok(r.ok, r.stderr);
    assert.equal(m.ran(), false);
  } finally { sh(d, 'config', '--file', GLOBAL, '--unset', 'hook.gl.command'); }
});

test('the user\'s own config hook is trusted: not switched off, not named in a plan', opts, async () => {
  const d = two();
  const m = marker();
  sh(d, 'config', '--file', GLOBAL, 'hook.mine.command', m.prog);
  sh(d, 'config', '--file', GLOBAL, 'hook.mine.event', 'pre-commit');
  try {
    const r = await exec.git(['commit', '--allow-empty', '-q', '-m', 'x'], { cwd: d });
    assert.ok(r.ok, r.stderr);
    assert.equal(m.ran(), true, 'the user\'s own hook was blocked');
    fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
    const p = await plan(await scanRepo(d, {}), { type: 'commit-all', message: 'x' });
    assert.equal(p.runsRepoCode, false);
  } finally { sh(d, 'config', '--file', GLOBAL, '--remove-section', 'hook.mine'); }
});

test('the plan names a repo config hook by name and event, never its command, and holds the step', opts, async () => {
  const d = two();
  hooked(d, 'lint', 'pre-commit', 'echo SECRET_TOKEN_abc123 >/dev/null');
  fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
  const p = await plan(await scanRepo(d, {}), { type: 'commit-all', message: 'x' });
  assert.equal(p.runsRepoCode, true);
  const w = p.warnings.join('\n');
  assert.match(w, /pre-commit hook \(hook\.lint\.command in its git config\)/);
  assert.doesNotMatch(JSON.stringify(p.warnings), /SECRET_TOKEN/);
});

test('the plan names a hook whose event is the repo\'s and whose command is the user\'s', opts, async () => {
  const d = two();
  sh(d, 'config', '--file', GLOBAL, 'hook.gl2.command', '/bin/true');
  try {
    sh(d, 'config', 'hook.gl2.event', 'pre-commit');
    fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
    const p = await plan(await scanRepo(d, {}), { type: 'commit-all', message: 'x' });
    assert.equal(p.runsRepoCode, true);
    assert.match(p.warnings.join('\n'), /pre-commit hook \(hook\.gl2\.event in its git config\)/);
  } finally { sh(d, 'config', '--file', GLOBAL, '--remove-section', 'hook.gl2'); }
});

test('a hook the repo disables, or one for an event the step does not trigger, is not named', opts, async () => {
  const d = two();
  hooked(d, 'off', 'pre-commit', '/bin/true');
  sh(d, 'config', 'hook.off.enabled', 'false');
  hooked(d, 'other', 'pre-push', '/bin/true');
  fs.writeFileSync(path.join(d, 'b.txt'), '2\n');
  const p = await plan(await scanRepo(d, {}), { type: 'commit-all', message: 'x' });
  assert.doesNotMatch(p.warnings.join('\n'), /hook\./);
});

test('without config hooks nothing is added to the git call', async () => {
  const d = repo({ 'a.txt': '1\n' });
  const r = await exec.git(['status', '--porcelain'], { cwd: d });
  assert.ok(r.ok, r.stderr);
  assert.ok(put);
});
