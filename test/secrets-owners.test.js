// Who owns a vault item: an owner whose file is gone (a renamed workspace, a repointed dotfiles link)
// no longer blocks the file that now has its title, and old-format names never meet the scoped ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-owners-git-'));
const GLOBAL = path.join(GIT_HOME, 'gitconfig');
fs.writeFileSync(GLOBAL, '[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
process.on('exit', () => fs.rmSync(GIT_HOME, { recursive: true, force: true }));

const { setup, okRun } = require('./helpers/vault-ctl');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (dir, rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q');
  return dir;
}
const ignoredEnv = (dir, name = '.env') => { put(dir, '.gitignore', '.env*\n.netrc\n'); put(dir, name, 'K=' + dir + '\n'); return path.join(dir, name); };

const ours = (tool, target, extra) => ({ sha256: 'old', tool, target, at: '2026-11-01T00:00:00.000Z', ...extra });
const writeRecord = (dataDir, entries) => fs.writeFileSync(path.join(dataDir, 'secret-backups.json'), JSON.stringify({ version: 1, entries, skipped: {} }));

test('owners: after the workspace folder is renamed, pass replaces the old backup and moves the record', async () => {
  const { tmp, mkCtl, record, env } = setup();
  put(env.PASSWORD_STORE_DIR, '.gpg-id', 'me\n');
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'pass', target: '' });
  const first = ignoredEnv(gitRepo(path.join(tmp, 'ws1', 'api')));
  let ws = { repos: [{ path: path.dirname(first) }], root: path.join(tmp, 'ws1') };
  const p = await ctl.plan([first], { via: 'app', ...ws });
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  fs.renameSync(path.join(tmp, 'ws1'), path.join(tmp, 'ws2'));
  const moved = path.join(tmp, 'ws2', 'api', '.env');
  fs.appendFileSync(moved, 'ROTATED=1\n');
  ws = { repos: [{ path: path.dirname(moved) }], root: path.join(tmp, 'ws2') };
  const q = await ctl.plan([moved], { via: 'app', ...ws });
  assert.ok(q.ok, q.error);
  assert.deepEqual(q.display.map((d) => d.text.split('  ←')[0]), ['pass insert -m -f gutcheck/@repo/api/.env']);
  assert.deepEqual(q.warnings, [`repo api/.env replaces the backup of ${first}, which no longer exists`]);
  assert.ok((await ctl.apply(q.token, { via: 'app' })).ok);
  assert.deepEqual(Object.keys(record().entries), [moved]);
  assert.equal(record().entries[moved].key, 'gutcheck/@repo/api/.env');
});

test('owners: a repointed dotfiles link replaces its pass backup; Proton just saves a new item', async () => {
  const { tmp, home, ws, mkCtl, record, env, dataDir } = setup();
  put(env.PASSWORD_STORE_DIR, '.gpg-id', 'me\n');
  const a = path.join(tmp, 'dots', 'a'), b = path.join(tmp, 'dots', 'b');
  put(a, 'netrc', 'machine a login a password a\n');
  put(b, 'netrc', 'machine b login b password b\n');
  const link = path.join(home, '.netrc');
  for (const [tool, target] of [['pass', ''], ['proton', 'Dev']]) {
    writeRecord(dataDir, {});
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(path.join(a, 'netrc'), link);
    const ctl = mkCtl({ run: okRun() });
    ctl.link({ tool, target });
    const p = await ctl.plan([link], { via: 'app', ...ws });
    assert.ok((await ctl.apply(p.token, { via: 'app' })).ok, tool);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(b, 'netrc'), link);
    const q = await ctl.plan([link], { via: 'app', ...ws });
    assert.ok(q.ok, `${tool}: ${q.error}`);
    assert.equal(q.display.length, 1, tool);
    const entries = () => Object.keys(record().entries).sort();
    if (tool === 'pass') {
      assert.deepEqual(q.warnings, [`home ~/.netrc replaces the backup of ${path.join(a, 'netrc')}, which ~/.netrc no longer points to`]);
      assert.ok((await ctl.apply(q.token, { via: 'app' })).ok);
      assert.deepEqual(entries(), [path.join(b, 'netrc')]);
    } else {
      assert.deepEqual(q.warnings, [], 'a new item never overwrites the old one');
      assert.ok((await ctl.apply(q.token, { via: 'app' })).ok);
      assert.deepEqual(entries(), [path.join(a, 'netrc'), path.join(b, 'netrc')].sort());
    }
  }
});

test('owners: an owner whose file still exists elsewhere still blocks the name', async () => {
  const { tmp, mkCtl, dataDir } = setup();
  const live = path.join(tmp, 'other', '.env');
  put(path.dirname(live), '.env', 'X=1\n');
  const env1 = ignoredEnv(gitRepo(path.join(tmp, 'w', 'api')));
  writeRecord(dataDir, { [live]: ours('proton', 'Dev', { itemId: 'ID_' + 'y'.repeat(30), key: 'gutcheck: repo api/.env', title: 'gutcheck: repo api/.env' }) });
  const ctl = mkCtl({ run: okRun() });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const r = await ctl.plan([env1], { via: 'app', repos: [{ path: path.dirname(env1) }], root: path.join(tmp, 'w') });
  assert.equal(r.ok, false);
  assert.match(r.error, /same vault item title: gutcheck: repo api\/\.env/);
});

test('names: an old-format name for a repo named root never meets the new root .env', async () => {
  const { tmp, mkCtl, dataDir, env } = setup();
  put(env.PASSWORD_STORE_DIR, '.gpg-id', 'me\n');
  const root = path.join(tmp, 'ws6');
  const old = ignoredEnv(gitRepo(path.join(root, 'root')));
  // Saved before the scope words: the repo "root" got the pass name gutcheck/root/.env.
  writeRecord(dataDir, { [old]: ours('pass', '', { sha256: 'stale', itemId: 'gutcheck/root/.env', key: 'gutcheck/root/.env', title: 'gutcheck: root/.env' }) });
  put(root, '.env', 'ROOT=1\n');
  const ctl = mkCtl({ run: okRun() });
  ctl.link({ tool: 'pass', target: '' });
  const p = await ctl.plan([old, path.join(root, '.env')], { via: 'app', repos: [{ path: path.dirname(old) }], root });
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.display.map((d) => d.text.split('  ←')[0]), ['pass insert -m -f gutcheck/root/.env', 'pass insert -m -f gutcheck/@root/.env']);
  assert.deepEqual(p.warnings, []);
});
