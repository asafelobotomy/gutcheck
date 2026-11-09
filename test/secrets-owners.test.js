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

const crypto = require('node:crypto');
const tag = (real) => '~' + crypto.createHash('sha256').update(real).digest('hex').slice(0, 8);
const saves = (calls) => calls.filter((c) => !['ls', 'info'].includes(c.args[0])).map((c) => (c.cmd === '/bin/sh' ? c.args.slice(3) : c.args).join(' '));

// Back up `rel` in <tmp>/ws1/api, rename ws1 to ws2, change the file, and plan it again.
async function movedWorkspace({ tool, target, rel = '.env' }) {
  const { tmp, mkCtl, record, env } = setup();
  put(env.PASSWORD_STORE_DIR, '.gpg-id', 'me\n');
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool, target });
  const repo = gitRepo(path.join(tmp, 'ws1', 'api'));
  put(repo, '.gitignore', '.env\n');
  put(repo, rel, 'A=1\n');
  const first = path.join(repo, rel);
  const p = await ctl.plan([first], { via: 'app', repos: [{ path: repo }], root: path.join(tmp, 'ws1') });
  assert.ok(p.ok, p.error);
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  const oldName = record().entries[first].itemId;
  fs.renameSync(path.join(tmp, 'ws1'), path.join(tmp, 'ws2'));
  const moved = path.join(tmp, 'ws2', 'api', rel);
  fs.appendFileSync(moved, 'ROTATED=1\n');
  calls.length = 0;
  const q = await ctl.plan([moved], { via: 'app', repos: [{ path: path.join(tmp, 'ws2', 'api') }], root: path.join(tmp, 'ws2') });
  assert.ok(q.ok, q.error);
  assert.ok((await ctl.apply(q.token, { via: 'app' })).ok);
  return { first, moved, oldName, q, calls, record };
}

test('owners: after the workspace folder is renamed, pass saves a new suffixed item and keeps the old one', async () => {
  const { first, moved, oldName, q, calls, record } = await movedWorkspace({ tool: 'pass', target: '' });
  assert.equal(oldName, 'gutcheck/@repo/api/.env');
  const name = `gutcheck/@repo/api/.env${tag(moved)}`;
  assert.deepEqual(q.display.map((d) => d.text.split('  ←')[0]), [`pass insert -m -f ${name}`]);
  assert.deepEqual(q.warnings, [`repo api/.env is saved as a new item; the backup of ${first} (no longer found) is kept as ${oldName}.`]);
  assert.deepEqual(saves(calls), [`insert -m -f ${name}`], 'nothing is written to the old name');
  assert.deepEqual(Object.keys(record().entries).sort(), [first, moved].sort(), 'the old record entry is kept');
  assert.equal(record().entries[moved].key, name);
});

test('owners: a 326-character name and a KeePassXC entry get a new suffixed item too', async () => {
  const long = 'd'.repeat(120) + '/' + 'e'.repeat(120) + '/' + 'f'.repeat(60) + '/.env';
  const a = await movedWorkspace({ tool: 'pass', target: '', rel: long });
  assert.ok(a.oldName.length > 300);
  assert.deepEqual(saves(a.calls), [`insert -m -f ${a.oldName}${tag(a.moved)}`]);
  assert.equal(a.q.warnings.length, 1);
  const k = await movedWorkspace({ tool: 'keepassxc', target: { db: '/d.kdbx', keyFile: '/k' } });
  const entry = `${k.oldName}${tag(k.moved)}`;
  assert.deepEqual(saves(k.calls), [`add --no-password -k /k /d.kdbx ${entry}`, `attachment-import --no-password -k /k /d.kdbx ${entry} .env /dev/stdin`]);
});

test('owners: a repointed dotfiles link gets a new pass item; Proton just saves a new item', async () => {
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
    if (tool === 'pass') {
      assert.match(q.display[0].text, new RegExp(`^pass insert -m -f gutcheck/@home/%7E/\\.netrc${tag(path.join(b, 'netrc'))}  ←`));
      assert.deepEqual(q.warnings, [`home ~/.netrc is saved as a new item; the backup of ${path.join(a, 'netrc')} (~/.netrc no longer points to it) is kept as gutcheck/@home/%7E/.netrc.`]);
    } else assert.deepEqual(q.warnings, [], 'a new item never overwrites the old one');
    assert.ok((await ctl.apply(q.token, { via: 'app' })).ok);
    assert.deepEqual(Object.keys(record().entries).sort(), [path.join(a, 'netrc'), path.join(b, 'netrc')].sort(), tool);
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

test('owners: relinking to an equivalent target still never overwrites a gone owner\'s backup', async () => {
  const { tmp, ws, envPath, mkCtl, dataDir } = setup();
  const gone = path.join(tmp, 'gone', 'api', '.env'); // the file this name was saved from, no longer found
  const base = { sha256: 'old', title: 'gutcheck: repo api/.env', at: '2026-11-01T00:00:00.000Z' };
  const ctl = mkCtl({ run: okRun() });
  for (const t of ['gutcheck', '/gutcheck/']) {
    writeRecord(dataDir, { [gone]: { ...base, tool: 'pass', target: '', itemId: 'gutcheck/@repo/api/.env', key: 'gutcheck/@repo/api/.env' } });
    ctl.link({ tool: 'pass', target: t });
    const p = await ctl.plan([envPath], { via: 'app', ...ws });
    assert.ok(p.ok, p.error);
    assert.equal(p.display[0].text.split('  ←')[0], `pass insert -m -f gutcheck/@repo/api/.env${tag(envPath)}`, t);
    assert.equal(p.warnings.length, 1, t);
  }
  writeRecord(dataDir, { [gone]: { ...base, tool: 'keepassxc', target: { db: '/d.kdbx', keyFile: '/k', group: 'g' }, itemId: 'g/@repo%2Fapi%2F.env', key: 'g/@repo%2Fapi%2F.env' } });
  ctl.link({ tool: 'keepassxc', target: { db: '/d.kdbx', keyFile: '/k', group: 'g/' } });
  const k = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok(k.ok, k.error);
  assert.deepEqual(k.display.map((d) => d.text.split('  ←')[0]), [
    `keepassxc-cli add --no-password -k /k /d.kdbx g/@repo%2Fapi%2F.env${tag(envPath)}`,
    `keepassxc-cli attachment-import --no-password -k /k /d.kdbx g/@repo%2Fapi%2F.env${tag(envPath)} .env /dev/stdin`]);
  // Another database is another store: the same entry name there is no clash.
  ctl.link({ tool: 'keepassxc', target: { db: '/other.kdbx', keyFile: '/k', group: 'g' } });
  const o = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok(o.ok, o.error);
  assert.deepEqual(o.warnings, []);
});
