// The secrets controller after the whole-branch review: item keys, symlinked home files, what a vault
// CLI may resolve, unreadable lists, KeePassXC re-backups, bw sync, audit titles and bad records.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { OK_ID, STATUS_OK, setup, okRun } = require('./helpers/vault-ctl');
const { ADAPTERS } = require('../src/vault-adapters');

function addRepo(dir, file = '.env') {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(dir, file), 'K=' + dir + '\n');
  return path.join(dir, file);
}

test('pass: "my app" and "my_app" get distinct item names, so neither overwrites the other', async () => {
  const { tmp, mkCtl } = setup();
  const root = path.join(tmp, 'ws3');
  const a = addRepo(path.join(root, 'my app')), b = addRepo(path.join(root, 'my_app'));
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'pass', target: '' });
  const ws = { repos: [{ path: path.dirname(a), name: 'my app' }, { path: path.dirname(b), name: 'my_app' }], root };
  const p = await ctl.plan([a, b], { via: 'app', ...ws });
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.display.map((d) => d.text.split('  ←')[0]).sort(), ['pass insert -m -f gutcheck/@repo/my%20app/.env', 'pass insert -m -f gutcheck/@repo/my_app/.env']);
});

test('a key clash drops the second file of two with one key; a key recorded for another file is refused', async () => {
  const { repo, envPath, ws, mkCtl, dataDir } = setup();
  const local = path.join(repo, '.env.local');
  fs.writeFileSync(local, 'L=1\n');
  const ctl = mkCtl({ run: okRun() });
  ctl.link({ tool: 'pass', target: '' });
  const orig = ADAPTERS.pass.saveCmd;
  ADAPTERS.pass.saveCmd = (c, t, o) => ({ ...orig(c, t, o), key: 'gutcheck/same' }); // as if two titles slugged alike
  try {
    const r = await ctl.plan([envPath, local], { via: 'app', ...ws });
    assert.ok(r.ok, r.error);
    assert.match(r.title, /^Back up 1 secret file/);
    assert.deepEqual(r.display.map((d) => d.text.split('  ←')[0]), ['pass insert -m -f gutcheck/@repo/api/.env']);
    assert.deepEqual(r.warnings, ['skipped: repo api/.env.local: another file already uses the vault item name gutcheck/same']);
    assert.equal(r.skipped, 1);
  } finally { ADAPTERS.pass.saveCmd = orig; }
  const rec = require('../src/secret-status').createRecord(path.join(dataDir, 'secret-backups.json'));
  const elsewhere = path.join(dataDir, 'elsewhere.env'); // still on disk, so it still owns the name
  fs.writeFileSync(elsewhere, 'E=1\n');
  rec.update((x) => { x.entries[elsewhere] = { sha256: 'f', tool: 'pass', target: '', itemId: 'gutcheck/@repo/api/.env', title: 'gutcheck: old' }; });
  const r2 = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.equal(r2.error, 'Two files would get the same vault item name: gutcheck/@repo/api/.env. Rename one or skip it.');
  assert.equal((await ctl.plan([local], { via: 'app', ...ws })).ok, true);
});

test('a symlinked ~/.npmrc (dotfiles) is named by the link, saved from its target and recorded as backed', async () => {
  const { home, ws, mkCtl, record } = setup();
  const target = path.join(home, 'dotfiles', 'npmrc');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, '//registry.npmjs.org/:_authToken=npm-hunter3\n');
  fs.symlinkSync(target, path.join(home, '.npmrc'));
  fs.symlinkSync(path.join(home, 'nowhere'), path.join(home, '.netrc')); // a dangling link is skipped
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const item = (await ctl.scan(ws)).items.find((i) => i.scope === 'home');
  assert.deepEqual([item.title, item.rel, item.real], ['gutcheck: home ~/.npmrc', '.npmrc', target]);
  assert.ok(!(await ctl.scan(ws)).items.some((i) => i.rel === '.netrc'));
  const p = await ctl.plan([path.join(home, '.npmrc')], { via: 'app', ...ws });
  assert.ok(p.ok, p.error);
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(calls[0].input.includes('npm-hunter3'));
  assert.equal(record().entries[target].title, 'gutcheck: home ~/.npmrc');
  assert.equal((await ctl.scan(ws)).items.find((i) => i.real === target).status, 'backed');
});

test('every vault call runs in the home folder with a PATH free of relative and workspace entries', async () => {
  const { env, home, envPath, ws, mkCtl, repo, tmp } = setup();
  const binDir = env.PATH;
  fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
  env.PATH = ['', '.', 'rel/bin', path.join(repo, 'node_modules', '.bin'), ws.root, binDir, '/usr/bin', path.join(tmp, 'ws', 'api', '..', 'api')].join(path.delimiter);
  const seen = [];
  const run = async (cmd, args, o) => { seen.push(o); return args[0] === 'info' ? STATUS_OK : { ok: true, code: 0, stdout: OK_ID, stderr: '' }; };
  const ctl = mkCtl({ run });
  ctl.link({ tool: 'proton', target: 'Dev' });
  await ctl.test(ws);
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  await ctl.verify({ via: 'app', ...ws });
  assert.ok(seen.length >= 4);
  for (const o of seen) {
    assert.equal(o.cwd, home);
    assert.equal(o.env.PATH, [binDir, '/usr/bin'].join(path.delimiter));
    assert.equal(o.env.HOME, home); // the rest of the env is kept
  }
});

test('verify: an unreadable list or a failed list after a good status changes nothing', async () => {
  const { envPath, ws, mkCtl, record } = setup();
  const ctl = mkCtl({ run: okRun() });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  const before = record();
  const listing = (res) => async (cmd, args) => (args[0] === 'info' ? STATUS_OK : res);
  const garbage = await mkCtl({ run: listing({ ok: true, code: 0, stdout: 'Welcome! <html>', stderr: '' }) }).verify({ via: 'app', ...ws });
  assert.deepEqual(garbage, { ok: false, error: 'Proton Pass listed its items in a form GutCheck could not read, so nothing was changed.' });
  assert.deepEqual(record(), before);
  const failed = await mkCtl({ run: listing({ ok: false, code: 1, stdout: '', stderr: 'boom' }) }).verify({ via: 'app', ...ws });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /pass-cli login/);
  assert.deepEqual(record(), before);
});

test('KeePassXC: a changed file is re-backed up with attachment-import -f onto its recorded entry', async () => {
  const { envPath, ws, mkCtl, record } = setup();
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'keepassxc', target: { db: '/h/v.kdbx', keyFile: '/h/v.keyx', group: 'gutcheck' } });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  // attachment-import reads /dev/stdin, so it runs as: /bin/sh -c 'cat | exec "$0" "$@"' <bin> <args>
  const saves = () => calls.filter((c) => c.args[0] !== 'ls').map((c) => (c.cmd === '/bin/sh' ? c.args.slice(3) : c.args));
  assert.deepEqual(saves().map((a) => a[0]), ['add', 'attachment-import']);
  const entry = record().entries[envPath].itemId;
  assert.equal(entry, 'gutcheck/@repo%2Fapi%2F.env');
  fs.appendFileSync(envPath, 'NEW=1\n');
  calls.length = 0;
  const p2 = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok(p2.ok, p2.error);
  assert.equal(p2.display.length, 1);
  assert.ok((await ctl.apply(p2.token, { via: 'app' })).ok);
  assert.deepEqual(saves(), [['attachment-import', '-f', '--no-password', '-k', '/h/v.keyx', '/h/v.kdbx', entry, '.env', '/dev/stdin']]);
  assert.equal((await ctl.scan(ws)).items.find((i) => i.real === envPath).status, 'backed');
});

test('Bitwarden verify syncs first; a failed sync changes nothing', async () => {
  const { envPath, ws, mkCtl, record } = setup();
  const seq = [];
  let syncOk = true;
  const run = async (cmd, args) => {
    seq.push(args.join(' '));
    if (args[0] === 'status') return { ok: true, code: 0, stdout: '{"status":"unlocked"}', stderr: '' };
    if (args[0] === 'sync') return { ok: syncOk, code: syncOk ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'list') return { ok: true, code: 0, stdout: '[]', stderr: '' };
    return { ok: true, code: 0, stdout: '{"id":"bw-1"}', stderr: '' };
  };
  const ctl = mkCtl({ run });
  ctl.link({ tool: 'bitwarden', target: '' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  seq.length = 0;
  assert.deepEqual(await ctl.verify({ via: 'app', ...ws }), { ok: true, checked: 1, missing: 1, mismatch: 0 });
  assert.deepEqual(seq, ['status', 'sync', 'list items']);
  const before = record();
  syncOk = false;
  const r = await ctl.verify({ via: 'app', ...ws });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Bitwarden could not sync, so nothing was changed\./);
  assert.deepEqual(record(), before);
});

test('the audit says "Back up" for a failed save and "Backed up" for a saved one', async () => {
  const { envPath, ws, mkCtl } = setup();
  const log = [];
  let ok = false;
  const run = async (cmd, args) => (args[0] === 'info' ? STATUS_OK : ok ? { ok: true, code: 0, stdout: OK_ID, stderr: '' } : { ok: false, code: 1, stdout: '', stderr: 'no' });
  const ctl = mkCtl({ run, audit: (e) => log.push(e) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  await ctl.apply((await ctl.plan([envPath], { via: 'app', ...ws })).token, { via: 'app' });
  ok = true;
  await ctl.apply((await ctl.plan([envPath], { via: 'app', ...ws })).token, { via: 'app' });
  assert.deepEqual(log.map((e) => [e.ok, e.title]), [[false, 'Back up gutcheck: repo api/.env to Proton Pass'], [true, 'Backed up gutcheck: repo api/.env to Proton Pass']]);
});

test('a record with null or non-object entries loads and scans without crashing', async () => {
  const { envPath, ws, mkCtl, dataDir } = setup();
  fs.writeFileSync(path.join(dataDir, 'secret-backups.json'), JSON.stringify({ version: 1, entries: { [envPath]: null, '/x': 5, '/y': { sha256: 'z' } }, skipped: { '/s': null } }));
  const { createRecord, statusOf } = require('../src/secret-status');
  const rec = createRecord(path.join(dataDir, 'secret-backups.json')).load();
  assert.deepEqual(Object.keys(rec.entries), ['/y']);
  assert.deepEqual(rec.skipped, {});
  assert.equal(statusOf({ real: '/a', sha256: 'q' }, { entries: { '/a': null, '/b': 'x', '/c': null } }).status, 'unbacked');
  assert.equal((await mkCtl({ run: okRun() }).scan(ws)).items.find((i) => i.real === envPath).status, 'unbacked');
});
