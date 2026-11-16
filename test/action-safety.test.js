// Actions against a repo whose .git/config someone else wrote (audit 2026-11-16, E1-E3). Each
// attack leaves a marker file when its program runs, or a file outside the repo when it escapes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, put, sh, fresh, repo, marker } = require('./helpers/git-lab');

const exec = require('../src/exec');
const { scanRepo } = require('../src/scanner');
const { plan, apply, recheck } = require('../src/actions');

const rescuePlan = async (d) => plan(await scanRepo(d, {}), { type: 'rescue-bundle', dest: fresh('rescue') }, { workspaceRoot: fresh('ws'), repoPaths: [d] });
const destOf = (p) => p.steps.find((s) => s.kind === 'mkdir').path;

// A blobless clone of a repo with a second branch, so switching to it needs a blob it lacks.
function partialClone() {
  const src = repo({ a: 'a\n' }, 'src');
  sh(src, 'switch', '-q', '-c', 'other');
  put(src, 'b', 'only on other\n'); sh(src, 'add', '-A'); sh(src, 'commit', '-qm', 'b');
  sh(src, 'switch', '-q', 'main');
  const bare = fresh('remote');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(src, 'push', '-q', bare, 'main', 'other');
  sh(bare, 'config', 'uploadpack.allowFilter', 'true');
  const pc = fresh('pc');
  sh(ROOT, 'clone', '-q', '--filter=blob:none', `file://${bare}`, pc);
  sh(pc, 'branch', '-q', 'other', 'origin/other');
  return pc;
}

test('E2: the rescue copy does not run diff.external, and its patch holds the changes', async () => {
  const d = repo({ 'f.txt': 'one\n' });
  put(d, 'f.txt', 'one\ntwo\n');
  const m = marker('exit 0');
  sh(d, 'config', 'diff.external', m.prog);
  const p = await rescuePlan(d);
  assert.equal(p.ok, true, p.error);
  const r = await apply(p);
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(m.ran(), false, 'the repo\'s external diff program ran');
  assert.match(fs.readFileSync(path.join(destOf(p), 'uncommitted.patch'), 'utf8'), /^\+two$/m);
});

test('E2: a stash patch is git\'s own diff too', async () => {
  const d = repo({ 'f.txt': 'one\n' });
  put(d, 'f.txt', 'one\nstashed\n');
  sh(d, 'stash', '-q');
  const m = marker('exit 0');
  sh(d, 'config', 'diff.external', m.prog);
  const p = await rescuePlan(d);
  assert.equal(p.ok, true, p.error);
  assert.equal((await apply(p)).ok, true);
  assert.equal(m.ran(), false);
  assert.match(fs.readFileSync(path.join(destOf(p), 'stash-0.patch'), 'utf8'), /^\+stashed$/m);
});

test('E3: core.worktree pointing at another folder refuses scans and plans; nothing is written there', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  sh(d, 'switch', '-q', '-c', 'feature');
  put(d, '.config/autostart/evil.desktop', 'x\n'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'f');
  sh(d, 'switch', '-q', 'main');
  const scanned = await scanRepo(d, {});
  const before = await plan(scanned, { type: 'checkout', branch: 'feature' });
  assert.equal(before.ok, true, before.error);

  const outside = fresh('outside');
  fs.mkdirSync(outside);
  sh(d, 'config', 'core.worktree', outside);
  exec.forgetGitDrivers(d);
  const st = await exec.git(['status', '--porcelain'], { cwd: d });
  assert.equal(st.ok, false);
  assert.match(st.stderr, /core\.worktree/);
  const p = await plan(scanned, { type: 'checkout', branch: 'feature' });
  assert.equal(p.ok, false);
  assert.match(p.error, /core\.worktree/);
  // A plan made before the config changed is held when it is about to run.
  assert.match(await recheck(before), /core\.worktree/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('E3: a core.worktree that names the repo folder itself (as a submodule\'s does) is fine', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  sh(d, 'config', 'core.worktree', '..');
  exec.forgetGitDrivers(d);
  assert.equal((await exec.git(['status', '--porcelain'], { cwd: d })).ok, true);
  sh(d, 'config', 'core.worktree', d);
  exec.forgetGitDrivers(d);
  assert.equal((await exec.git(['status', '--porcelain'], { cwd: d })).ok, true);
});

test('E1: every action git step forbids a lazy fetch unless the repo is a partial clone', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  sh(d, 'branch', 'other');
  const p = await plan(await scanRepo(d, {}), { type: 'checkout', branch: 'other' });
  assert.equal(p.ok, true, p.error);
  const gits = p.steps.filter((s) => s.cmd === 'git');
  assert.ok(gits.length > 0);
  for (const s of gits) assert.equal(s.env.GIT_NO_LAZY_FETCH, '1');
});

test('E1: a partial clone whose config names an uploadpack program is refused for a plain switch', async () => {
  const pc = partialClone();
  const scanned = await scanRepo(pc, {});
  const m = marker('exec git-upload-pack "$@"');
  sh(pc, 'config', 'remote.origin.uploadpack', m.prog);
  exec.forgetGitDrivers(pc);
  const p = await plan(scanned, { type: 'checkout', branch: 'other' });
  assert.equal(p.ok, false);
  assert.match(p.error, /remote\.origin\.uploadpack/);
  assert.equal(m.ran(), false);
});

test('E1: a partial clone of a local folder is refused; lazy fetch is never left on unchecked', async () => {
  // The lab's remote is file://, which actions never talk to: the same refusal a fetch gets.
  const pc = partialClone();
  const p = await plan(await scanRepo(pc, {}), { type: 'checkout', branch: 'other' });
  assert.equal(p.ok, false);
  assert.match(p.error, /local folder|file:\/\//);
});

test('E1: a partial clone with a plain network remote may fetch, and the plan says so', async () => {
  const pc = partialClone();
  const scanned = await scanRepo(pc, {});
  sh(pc, 'config', 'remote.origin.url', 'https://example.invalid/o/n.git');
  exec.forgetGitDrivers(pc);
  const p = await plan(scanned, { type: 'checkout', branch: 'other' });
  assert.equal(p.ok, true, p.error);
  assert.match(p.note, /partial clone/);
  for (const s of p.steps.filter((x) => x.cmd === 'git')) assert.equal(s.env.GIT_NO_LAZY_FETCH, undefined);
});

test('E4: fetch, pull and push refuse a repo whose own config redirects or weakens the connection', async () => {
  const { networkSettings } = require('../src/git-safety');
  const e = (key, value) => ({ key, value, origin: 'file:.git/config' });
  assert.deepEqual(networkSettings([
    e('http.proxy', 'http://token@attacker:8080'), e('http.sslverify', 'false'), e('http.sslverify', null), e('http.https://github.com/.extraheader', 'X: y'),
    e('remote.origin.proxy', 'http://a'), e('remote.-x y.proxy', 'http://a'), e('url.https://attacker/.pushinsteadof', 'https://github.com/'),
    e('http.proxy', ''), e('http.postbuffer', '524288000'), e('core.sshcommand', 'x'),
  ]), ['http.proxy', 'http.sslverify', 'http.extraheader', 'remote.origin.proxy', 'remote.<name>.proxy', 'url.<address>.pushInsteadOf']);

  const d = repo({ 'a.txt': 'a\n' });
  sh(d, 'remote', 'add', 'origin', 'https://github.com/o/n.git');
  const scanned = await scanRepo(d, {});
  assert.equal((await plan(scanned, { type: 'fetch' })).ok, true);
  for (const [key, value, named] of [['http.proxy', 'http://user:tok@attacker.invalid:8080', 'http.proxy'], ['http.sslVerify', 'false', 'http.sslverify'], ['remote.origin.proxy', 'http://attacker.invalid', 'remote.origin.proxy'], ['url.https://attacker.invalid/.pushInsteadOf', 'https://github.com/', 'url.<address>.pushInsteadOf']]) {
    sh(d, 'config', key, value);
    const p = await plan(scanned, { type: 'fetch' });
    assert.equal(p.ok, false, key);
    assert.ok(p.error.includes(`(${named})`), p.error);
    assert.ok(!p.error.includes('attacker'), 'no address or token in the message');
    sh(d, 'config', '--unset', key);
  }
  // The user's own proxy (global config) is theirs to set.
  sh(d, 'config', '--file', process.env.GIT_CONFIG_GLOBAL, 'http.proxy', 'http://corp.invalid:3128');
  try { assert.equal((await plan(scanned, { type: 'fetch' })).ok, true); } finally { sh(d, 'config', '--file', process.env.GIT_CONFIG_GLOBAL, '--unset', 'http.proxy'); }
});

test('F2: the rescue copy saves edits made after the last scan', async () => {
  const d = repo({ 'f.txt': 'one\n' });
  const scanned = await scanRepo(d, {}); // clean at scan time
  put(d, 'f.txt', 'one\nlater\n');
  const p = await plan(scanned, { type: 'rescue-bundle', dest: fresh('rescue') }, { workspaceRoot: fresh('ws'), repoPaths: [d] });
  assert.equal(p.ok, true, p.error);
  assert.equal((await apply(p)).ok, true);
  assert.match(fs.readFileSync(path.join(destOf(p), 'uncommitted.patch'), 'utf8'), /^\+later$/m);
});
