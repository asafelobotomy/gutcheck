// Files inside a submodule or a nested repo are not the parent's: they are committed (or ignored)
// there, so the parent never reports or backs them up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-nested-git-'));
const GLOBAL = path.join(GIT_HOME, 'gitconfig');
fs.writeFileSync(GLOBAL, '[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
process.on('exit', () => fs.rmSync(GIT_HOME, { recursive: true, force: true }));

const S = require('../src/secrets');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (dir, rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q');
  return dir;
}

test('repo: a submodule\'s committed .env is not the parent\'s; the parent\'s own .env still is', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sub-')));
  try {
    const src = gitRepo(path.join(tmp, 'src'));
    put(src, '.env', 'FROM_SUB=1\n');
    put(src, 'deploy.pem', '-----BEGIN PRIVATE KEY-----\nx\n');
    sh(src, 'add', '-A');
    sh(src, 'commit', '-qm', 'sub');
    const bare = path.join(tmp, 'sub.git');
    execFileSync('git', ['clone', '-q', '--bare', src, bare]);
    const parent = gitRepo(path.join(tmp, 'parent'));
    sh(parent, 'commit', '-q', '--allow-empty', '-m', 'init');
    sh(parent, 'submodule', 'add', '-q', bare, 'libs/sub');
    sh(parent, 'commit', '-qm', 'add sub');
    assert.ok(fs.existsSync(path.join(parent, 'libs/sub/.env')));
    put(parent, '.env', 'PARENT=1\n');
    put(parent, 'libs/sub/.env.local', 'SUB_LOCAL=1\n'); // the submodule's own uncommitted file
    fs.symlinkSync('libs/sub/deploy.pem', path.join(parent, 'linked.pem')); // a link into the submodule
    const c = await S.findRepoSecrets(parent, { name: 'parent' });
    assert.deepEqual(c.map((x) => x.rel).sort(), ['.env', 'libs/sub/.env.local']);
    assert.deepEqual(c.map((x) => x.title).sort(), ['gutcheck: repo parent/.env', 'gutcheck: repo parent/libs/sub/.env.local']);
    assert.ok(c.every((x) => x.repo === 'parent'), 'advice stays with the workspace repo');

    // A gitlink whose folder lost its .git file (a moved or half-cloned submodule) is still not walked.
    fs.rmSync(path.join(parent, 'libs/sub/.git'), { recursive: true, force: true });
    assert.deepEqual((await S.findRepoSecrets(parent)).map((x) => x.rel).sort(), ['.env']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('repo: a nested plain repo\'s files are not the parent\'s', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-nest-')));
  try {
    const parent = gitRepo(path.join(tmp, 'parent'));
    const inner = gitRepo(path.join(parent, 'tools', 'inner'));
    put(inner, '.env', 'INNER=1\n');
    put(inner, 'id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n');
    sh(inner, 'add', '-A');
    sh(inner, 'commit', '-qm', 'inner');
    // A worktree-style nested checkout has a .git file, not a folder.
    const wt = path.join(parent, 'wt');
    put(wt, '.git', 'gitdir: /nowhere\n');
    put(wt, '.env', 'WT=1\n');
    put(parent, 'app/.env.local', 'PARENT=1\n');
    put(inner, '.env.local', 'INNER_LOCAL=1\n'); // scanned as the nested repo's own, with its own ls-files
    const c = await S.findRepoSecrets(parent);
    assert.deepEqual(c.map((x) => x.rel).sort(), ['app/.env.local', 'tools/inner/.env.local']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('repo: an in-repo worktree is scanned as its own checkout', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wt-')));
  try {
    const parent = gitRepo(path.join(tmp, 'parent'));
    put(parent, '.gitignore', '.worktrees/\n.env\n');
    put(parent, 'app.env.key', 'committed');
    sh(parent, 'add', '-A');
    sh(parent, 'commit', '-qm', 'init');
    sh(parent, 'worktree', 'add', '-q', '-b', 'feat', '.worktrees/feat');
    put(parent, '.worktrees/feat/.env', 'FEAT=1\n');
    const c = await S.findRepoSecrets(parent, { name: 'p' });
    assert.deepEqual(c.map((x) => x.title), ['gutcheck: repo p/.worktrees/feat/.env'], 'its committed app.env.key is tracked there');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('repo: a .git entry that is not a checkout (garbage file, dangling link) does not hide a folder', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-garbage-')));
  try {
    const r = gitRepo(path.join(tmp, 'r'));
    put(r, 'config/.git', 'not a gitdir line\n');
    put(r, 'config/.env', 'A=1\n');
    put(r, 'x/.env', 'B=1\n');
    fs.symlinkSync('/nonexistent-gc', path.join(r, 'x', '.git'));
    assert.deepEqual((await S.findRepoSecrets(r)).map((x) => x.rel).sort(), ['config/.env', 'x/.env']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('repo: a tracked list too big to read is reported as a problem, not as no secrets', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-big-')));
  try {
    const r = gitRepo(path.join(tmp, 'r'));
    for (let i = 0; i < 20; i++) put(r, `f${i}.txt`, 'x');
    sh(r, 'add', '-A');
    put(r, '.env', 'A=1\n');
    const problems = [];
    assert.deepEqual(await S.findRepoSecrets(r, { name: 'r', problems, maxBuffer: 64 }), []);
    assert.deepEqual(problems, [{ repo: 'r', error: 'Secrets not checked in r: too many tracked files for git ls-files.' }]);
    assert.equal((await S.findRepoSecrets(r)).length, 1, 'the default buffer fits');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('repo: a nested .git that resolves to the parent\'s own git dir is the parent\'s folder', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-samegit-')));
  try {
    const r = gitRepo(path.join(tmp, 'r'));
    put(r, 'a/deploy.pem', '-----BEGIN PRIVATE KEY-----\nx\n');
    put(r, 'b/deploy.pem', '-----BEGIN PRIVATE KEY-----\ny\n');
    sh(r, 'add', '-A');
    sh(r, 'commit', '-qm', 'keys');
    fs.symlinkSync(path.join(r, '.git'), path.join(r, 'a', '.git'));
    put(r, 'b/.git', 'gitdir: ../.git\n');
    put(r, 'b/.env', 'UNTRACKED=1\n');
    const problems = [];
    assert.deepEqual((await S.findRepoSecrets(r, { problems })).map((x) => x.rel), ['b/.env'], 'committed in the parent');
    assert.deepEqual(problems, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('repo: a nested checkout git cannot list is reported, not silently dropped', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-nestfail-')));
  try {
    const r = gitRepo(path.join(tmp, 'r'));
    put(r, 'wt/.git', 'gitdir: /nowhere-gc\n');
    put(r, 'wt/.env', 'WT=1\n');
    const problems = [];
    assert.deepEqual(await S.findRepoSecrets(r, { name: 'r', problems }), []);
    assert.deepEqual(problems, [{ repo: 'r', error: 'Secrets not checked in r/wt: git could not list its tracked files.' }]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
