// Secret item titles name their scope (repo, home, root), so files from different scopes never share a
// vault item; a clash drops just that file and backs up the rest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-scope-git-'));
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

test('titles: a repo named workspace and the root .env get distinct titles and vault names', async () => {
  const { tmp, mkCtl } = setup();
  const root = path.join(tmp, 'ws3');
  const repo = gitRepo(path.join(root, 'workspace'));
  const repoEnv = ignoredEnv(repo);
  put(root, '.env', 'ROOT=1\n');
  const ws = { repos: [{ path: repo, name: 'workspace' }], root };
  const ctl = mkCtl({ run: okRun() });
  const s = await ctl.scan({ ...ws, home: false });
  assert.deepEqual(s.items.map((i) => i.title).sort(), ['gutcheck: repo workspace/.env', 'gutcheck: root .env']);
  for (const [tool, target] of [['proton', 'Dev'], ['pass', '']]) {
    ctl.link({ tool, target });
    const p = await ctl.plan([repoEnv, path.join(root, '.env')], { via: 'app', ...ws });
    assert.ok(p.ok, p.error);
    assert.equal(p.display.length, 2, tool);
    assert.ok(!p.display.some((d) => /skipped/.test(d.text)), tool);
  }
  const p = await ctl.plan([repoEnv, path.join(root, '.env')], { via: 'app', ...ws });
  assert.deepEqual(p.display.map((d) => d.text.split('  ')[0]), ['pass insert -m -f gutcheck/repo/workspace/.env', 'pass insert -m -f gutcheck/root/.env']);
});

test('titles: a repo folder named ~ does not collide with the home folder', async () => {
  const { tmp, home, mkCtl } = setup();
  const root = path.join(tmp, 'ws4');
  const repo = gitRepo(path.join(root, '~'));
  const inRepo = ignoredEnv(repo, '.netrc');
  put(home, '.netrc', 'machine x login y password z\n');
  const ws = { repos: [{ path: repo, name: '~' }], root };
  const ctl = mkCtl({ run: okRun() });
  const s = await ctl.scan(ws);
  const titles = s.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['gutcheck: home ~/.netrc', 'gutcheck: repo ~/.netrc']);
  for (const [tool, target] of [['proton', 'Dev'], ['pass', ''], ['keepassxc', { db: '/d.kdbx', keyFile: '/k' }]]) {
    ctl.link({ tool, target });
    const p = await ctl.plan([inRepo, path.join(home, '.netrc')], { via: 'app', ...ws });
    assert.ok(p.ok, `${tool}: ${p.error}`);
    assert.ok(!p.display.some((d) => /skipped/.test(d.text)), tool);
  }
});

test('titles: a clash drops just the clashing file, notes it, and backs up the rest', async () => {
  const { tmp, mkCtl, record } = setup();
  const a = gitRepo(path.join(tmp, 'x', 'a', 'api'));
  const b = gitRepo(path.join(tmp, 'x', 'b', 'api'));
  const c = gitRepo(path.join(tmp, 'x', 'c', 'web'));
  const [ea, eb, ec] = [ignoredEnv(a), ignoredEnv(b), ignoredEnv(c)];
  // Repos outside the root fall back to their folder name: a and b both become "repo api/.env".
  const root = path.join(tmp, 'elsewhere');
  fs.mkdirSync(root);
  const loose = { repos: [{ path: a, name: 'api' }, { path: b, name: 'api' }, { path: c, name: 'web' }], root };
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([ea, eb, ec], { via: 'app', ...loose });
  assert.ok(p.ok, p.error);
  assert.match(p.title, /2 secret files/);
  const notes = p.display.filter((d) => /skipped/.test(d.text));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, 'repo api/.env: skipped: another file already uses this vault item title');
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.ok(r.ok);
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(record().entries).sort(), [ea, ec].sort());

  // Only the clashing file left (its title is recorded for a): refused as before.
  const again = await ctl.plan([eb], { via: 'app', ...loose });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'Two files would get the same vault item title: gutcheck: repo api/.env. Rename one or skip it.');
});

test('titles: a record written with the old titles keeps working through its key and item id', async () => {
  const { envPath, ws, mkCtl, record, dataDir, env } = setup();
  put(env.PASSWORD_STORE_DIR, '.gpg-id', 'me\n'); // pass counts as set up
  const old = (tool, extra) => ({ sha256: 'old', tool, target: '', itemId: 'gutcheck/api/.env', key: 'gutcheck/api/.env', title: 'gutcheck: api/.env', at: '2026-11-01T00:00:00.000Z', ...extra });
  const write = (e) => fs.writeFileSync(path.join(dataDir, 'secret-backups.json'), JSON.stringify({ version: 1, entries: { [envPath]: e }, skipped: {} }));
  write(old('pass'));
  const ctl = mkCtl({ run: okRun() });
  assert.equal((await ctl.scan(ws)).items.find((i) => i.real === envPath).status, 'changed');
  ctl.link({ tool: 'pass', target: '' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok(p.ok, p.error);
  assert.match(p.display[0].text, /^pass insert -m -f gutcheck\/api\/\.env {2}←/, 'the item saved before keeps its name');
  assert.equal((await ctl.apply(p.token, { via: 'app' })).ok, true);
  assert.equal(record().entries[envPath].key, 'gutcheck/api/.env');

  // An id-based tool: the old title belongs to this same file, so it is no clash; the new item gets the new title.
  write(old('proton', { target: 'Dev', itemId: 'OLDID_' + 'x'.repeat(30), key: 'gutcheck: api/.env' }));
  ctl.link({ tool: 'proton', target: 'Dev' });
  const q = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok(q.ok, q.error);
  assert.ok(!q.display.some((d) => /skipped/.test(d.text)));
  assert.equal((await ctl.apply(q.token, { via: 'app' })).ok, true);
  assert.equal(record().entries[envPath].title, 'gutcheck: repo api/.env');
});
