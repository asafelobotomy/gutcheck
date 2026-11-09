const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanClutter } = require('../src/clutter');

const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, rel, content = 'x') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-scratch-'));
  sh(dir, 'init', '-q', '-b', 'main');
  put(dir, 'a.txt', 'one');
  sh(dir, 'add', '-A');
  sh(dir, '-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-qm', 'first');
  return dir;
}
const advice = (r, id) => r.advice.find((a) => a.id === id);

test('pytest temp folders with their own --basetemp names are found, and their pile-up gets advice', async () => {
  const dir = repo();
  try {
    put(dir, '.gitignore', '.tmp/\n');
    put(dir, 'pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"\n');
    put(dir, '.tmp/pytest-main/test_login0/db.sqlite');
    put(dir, '.tmp/pytest-side/popen-gw0/test_x0/f');
    put(dir, '.tmp/pytest-money/library-template0/f');
    put(dir, '.tmp/pytest-notes/readme.md'); // no pytest test folders inside: left alone
    put(dir, 'tools/pytest-plugin/src/a.py'); // not under a temp folder: left alone
    const r = await scanClutter(dir);
    const temps = r.items.filter((i) => i.category === 'build').map((i) => i.path).sort();
    assert.deepEqual(temps, ['.tmp/pytest-main', '.tmp/pytest-money', '.tmp/pytest-side']);
    const a = advice(r, 'test-temp-buildup');
    assert.ok(a, 'three pytest temp folders get advice');
    assert.equal(a.severity, 'warn');
    assert.match(a.title, /3 pytest temp folders/);
    assert.match(a.detail, /\.tmp\/pytest-main/);
    assert.match(a.detail, /one --basetemp folder/);
    assert.match(a.detail, /tmp_path_retention_policy = "failed"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('test temp advice: a single small pytest folder is fine, and a retention policy already set is not suggested again', async () => {
  const dir = repo();
  try {
    put(dir, '.gitignore', '.tmp/\n');
    put(dir, '.tmp/pytest/test_a0/f');
    let r = await scanClutter(dir);
    assert.equal(advice(r, 'test-temp-buildup'), undefined, 'one reused --basetemp folder is how pytest is meant to work');
    put(dir, 'pytest.ini', '[pytest]\ntmp_path_retention_policy = failed\n');
    put(dir, '.tmp/pytest-b/test_b0/f');
    r = await scanClutter(dir);
    const a = advice(r, 'test-temp-buildup');
    assert.ok(a);
    assert.doesNotMatch(a.detail, /tmp_path_retention_policy/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('git-ignored logs and backups piling up get advice to clean up when the run ends; a few small ones do not', async () => {
  const dir = repo();
  try {
    put(dir, '.gitignore', '.tmp/\n');
    for (let i = 0; i < 5; i++) put(dir, `.tmp/run${i}.log`);
    let r = await scanClutter(dir);
    assert.equal(advice(r, 'scratch-buildup'), undefined, 'five small logs are not a pile-up');
    // One large log (sparse, so the test writes nothing real) is enough.
    fs.truncateSync(path.join(dir, '.tmp/run0.log'), 60 * 1024 * 1024);
    for (let i = 0; i < 3; i++) put(dir, `.tmp/db${i}.bak`);
    r = await scanClutter(dir);
    const a = advice(r, 'scratch-buildup');
    assert.ok(a);
    assert.equal(a.severity, 'info');
    assert.match(a.title, /8 git-ignored logs and backups/);
    assert.match(a.title, /60 MB/);
    assert.match(a.detail, /\.tmp\/run0\.log \(60 MB\)/, 'names the largest file');
    assert.match(a.detail, /when they finish/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('many small git-ignored logs count as a pile-up; logs git does not ignore do not', async () => {
  const dir = repo();
  try {
    put(dir, '.gitignore', 'logs/\n');
    for (let i = 0; i < 25; i++) put(dir, `logs/step${i}.log`);
    for (let i = 0; i < 25; i++) put(dir, `kept/step${i}.log`);
    const r = await scanClutter(dir);
    const a = advice(r, 'scratch-buildup');
    assert.ok(a);
    assert.match(a.title, /^25 git-ignored/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
