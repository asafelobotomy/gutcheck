const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET = 'API_KEY=hunter2-unique-marker';

// ---- Controller (secrets-ctl.js): fake run, temp dataDir, temp repo, fake bin on a temp PATH ----
const { execFileSync } = require('node:child_process');
const { createSettingsStore } = require('../src/settings');

const OK_ID = 'ID_' + 'x'.repeat(30);
function setup({ binInRepo = false } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vctl-')));
  const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), wsRoot = path.join(tmp, 'ws');
  const repo = path.join(wsRoot, 'api');
  for (const d of [dataDir, home, repo]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  const envPath = path.join(repo, '.env');
  fs.writeFileSync(envPath, SECRET + '\nOTHER=plain\n');
  const binDir = binInRepo ? path.join(repo, 'bin') : path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const b of ['pass-cli', 'pass']) fs.writeFileSync(path.join(binDir, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const ws = { repos: [{ path: repo, name: 'api' }], root: wsRoot };
  const env = { PATH: binDir, HOME: home, PASSWORD_STORE_DIR: path.join(home, '.password-store') };
  const mkCtl = (o = {}) => require('../src/secrets-ctl').createSecretsCtl({
    dataDir, settings: createSettingsStore(path.join(dataDir, 'settings.json')), env, home, ...o });
  const record = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'secret-backups.json'), 'utf8'));
  return { tmp, dataDir, home, repo, envPath, ws, env, mkCtl, record };
}
const STATUS_OK = { ok: true, code: 0, stdout: '{"id":"u"}', stderr: '' };
// Answers the status call (pass-cli info) as signed in; records only save calls.
const okRun = (calls = []) => async (cmd, args, o) => {
  if (args[0] === 'info') return STATUS_OK;
  calls.push({ cmd, args, input: String(o.input), opts: o });
  return { ok: true, code: 0, stdout: OK_ID + '\n', stderr: '' };
};

test('plan/apply: content only on stdin, record written, results clean', async () => {
  const { envPath, ws, dataDir, mkCtl } = setup();
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  assert.equal(ctl.link({ tool: 'proton', target: 'Dev' }).ok, true);
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok(p.ok, p.error);
  assert.match(p.token, /^s:[0-9a-f]{32}$/);
  assert.equal(p.risk, 'caution');
  assert.ok(!JSON.stringify(p).includes('hunter2'));
  assert.match(p.display[0].text, /^pass-cli item create note --vault-name Dev --from-template -  ← contents of api\/\.env \(\d+ bytes\)$/);
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.ok(r.ok && !JSON.stringify(r).includes('hunter2'));
  assert.ok(!JSON.stringify(r).includes(OK_ID)); // no stdout in results
  assert.ok(calls[0].input.includes('hunter2') && !calls[0].args.join(' ').includes('hunter2'));
  assert.equal((await ctl.scan(ws)).items.find((i) => i.real === envPath).status, 'backed');
  assert.equal(fs.statSync(path.join(dataDir, 'secret-backups.json')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'secret-backups.json'), 'utf8').includes('hunter2'));
  assert.equal((await ctl.apply(p.token, { via: 'app' })).ok, false); // single use
});

test('plan uses the last scan, never trusts the caller list, and needs a link', async () => {
  const { envPath, ws, mkCtl, tmp } = setup();
  const ctl = mkCtl({ run: okRun() });
  assert.equal((await ctl.plan([envPath], { via: 'app', ...ws })).ok, false); // not linked
  assert.equal(ctl.link({ tool: 'nope', target: 'x' }).ok, false);
  assert.equal(ctl.link({ tool: 'keepassxc', target: 'x' }).ok, false);
  ctl.link({ tool: 'proton', target: 'Dev' });
  await ctl.scan(ws);
  const outside = path.join(tmp, 'outside.env');
  fs.writeFileSync(outside, 'X=1');
  assert.equal((await ctl.plan([outside], { via: 'cli' })).ok, false);
  assert.equal((await ctl.plan([envPath, outside], { via: 'cli' })).display.length, 1);
});

test('apply stops when the file changed after the preview, and records nothing', async () => {
  const { envPath, ws, mkCtl, dataDir } = setup();
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  fs.appendFileSync(envPath, 'NEW=1\n');
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].out, 'Changed since the preview. Rescan and review it again.');
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(path.join(dataDir, 'secret-backups.json')));
});

test('apply refuses a file that became a symlink', async () => {
  const { envPath, ws, mkCtl, tmp } = setup();
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  const other = path.join(tmp, 'other');
  fs.copyFileSync(envPath, other);
  fs.rmSync(envPath);
  fs.symlinkSync(other, envPath);
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.equal(r.ok, false);
  assert.match(r.results[0].out, /symlink/i);
  assert.equal(calls.length, 0);
});

test('a failing CLI that echoes the input shows scrubbed stderr', async () => {
  const { envPath, ws, mkCtl, dataDir } = setup();
  const run = async (cmd, args) => (args[0] === 'info' ? STATUS_OK : { ok: false, code: 1, stdout: 'STDOUT-LEAK', stderr: 'parse error near: API_KEY=hunter2-unique-marker\nnear: zzunique-marker-tail\nhint: unlock' });
  const ctl = mkCtl({ run });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  const r = await ctl.apply(p.token, { via: 'app' });
  const out = r.results[0].out;
  assert.equal(r.ok, false);
  assert.ok(!out.includes('hunter2') && !out.includes('unique-marker') && !out.includes('STDOUT-LEAK'));
  assert.match(out, /hint: unlock/);
  assert.ok(out.length <= 300);
  assert.ok(!fs.existsSync(path.join(dataDir, 'secret-backups.json')));
});

test('a hanging CLI is bounded: input given, timeout 60000, result says locked', async () => {
  const { envPath, ws, mkCtl } = setup();
  const seen = [];
  let statusHangs = false;
  const run = async (cmd, args, o) => {
    seen.push(o);
    if (args[0] === 'info' && !statusHangs) return STATUS_OK;
    return { ok: false, code: null, stdout: '', stderr: 'Command failed: killed' };
  };
  const ctl = mkCtl({ run });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  const r = await ctl.apply(p.token, { via: 'app' }); // the save hangs
  assert.ok(seen.length && seen.every((o) => o.timeout === 60000 && o.input != null));
  assert.match(r.results[0].out, /locked/);
  assert.match(r.results[0].out, /pass-cli login/);
  statusHangs = true; // now the status check itself hangs: apply stops before any save
  const p2 = await ctl.plan([envPath], { via: 'app', ...ws });
  const r2 = await ctl.apply(p2.token, { via: 'app' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /locked/);
  assert.deepEqual(r2.results, []);
  const t = await ctl.test();
  assert.equal(t.ok, false);
  assert.ok(seen.every((o) => o.timeout === 60000 && o.input != null));
});

test('MCP is refused for plan, apply and verify', async () => {
  const { envPath, mkCtl } = setup();
  const ctl = mkCtl({ run: okRun() });
  ctl.link({ tool: 'proton', target: 'Dev' });
  for (const r of [await ctl.plan([envPath], { via: 'mcp' }), await ctl.apply('x', { via: 'mcp' }), await ctl.verify({ via: 'mcp' })])
    assert.equal(r.error, 'Backing up secrets runs only from the GutCheck app or CLI.');
});

test('a vault bin inside a scanned repo is refused', async () => {
  const { envPath, ws, mkCtl } = setup({ binInRepo: true });
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.equal(p.ok, false);
  assert.match(p.error, /inside a scanned repo/);
  assert.equal(calls.length, 0);
});

test('tools lists found CLIs plus a disabled Google entry; pass test needs .gpg-id', async () => {
  const { mkCtl, env, ws } = setup();
  const ctl = mkCtl({ run: okRun() });
  const t = ctl.tools();
  assert.equal(t.find((x) => x.id === 'proton').found, true);
  assert.equal(t.find((x) => x.id === 'bitwarden').found, false);
  assert.deepEqual(t.find((x) => x.id === 'google'), { id: 'google', label: 'Google Password Manager', found: false, reason: 'No CLI or write API' });
  ctl.link({ tool: 'pass', target: '' });
  assert.equal((await ctl.test(ws)).ok, false);
  fs.mkdirSync(env.PASSWORD_STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.PASSWORD_STORE_DIR, '.gpg-id'), 'me@example.com\n');
  assert.equal((await ctl.test(ws)).ok, true);
});

test('verify marks missing and mismatch; locked changes nothing', async () => {
  const { home, ws, mkCtl, record, dataDir } = setup();
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n');
  let n = 0;
  const ids = ['A'.repeat(24), 'B'.repeat(24)];
  const ctl = mkCtl({ run: async (cmd, args) => (args[0] === 'info' ? STATUS_OK : { ok: true, code: 0, stdout: ids[n++] + '\n', stderr: '' }) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const s = await ctl.scan(ws);
  assert.equal(s.items.length, 2);
  const p = await ctl.plan(s.items.map((i) => i.real), { via: 'app' }); // reuses the scan's workspace
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  const rec = require('../src/secret-status').createRecord(path.join(dataDir, 'secret-backups.json'));
  const key = Object.keys(rec.load().entries).find((k) => k.endsWith('id_rsa'));
  rec.update((r) => { r.entries[key].fingerprint = 'SHA256:old'; }); // as if the key's fingerprint was known
  const before = record();
  const sshId = before.entries[key].itemId;
  const locked = mkCtl({ run: async () => ({ ok: true, code: 0, stdout: 'nope', stderr: '' }) });
  const lr = await locked.verify({ via: 'app', ...ws });
  assert.equal(lr.ok, false);
  assert.match(lr.error, /pass-cli login/);
  assert.deepEqual(record(), before);
  const run = async (cmd, args) => {
    if (args[0] === 'info') return { ok: true, code: 0, stdout: '{"id":"u"}', stderr: '' };
    if (args[0] === 'item') return { ok: true, code: 0, stdout: JSON.stringify({ items: [{ id: sshId }] }), stderr: '' };
    return { ok: true, code: 0, stdout: JSON.stringify({ valid_keys: [{ fingerprint: 'SHA256:new' }] }), stderr: '' };
  };
  assert.deepEqual(await mkCtl({ run }).verify({ via: 'app', ...ws }), { ok: true, checked: 2, missing: 1, mismatch: 1 });
  const after = record().entries;
  assert.equal(after[key].mismatch, true);
  assert.equal(Object.entries(after).find(([k]) => k !== key)[1].missing, true);
  const st = await ctl.scan(ws);
  assert.deepEqual(st.items.map((i) => i.status).sort(), ['mismatch', 'missing']);
});

test('skip/unskip', async () => {
  const { envPath, ws, mkCtl } = setup();
  const ctl = mkCtl({ run: okRun() });
  assert.equal(ctl.skip(envPath, 'throwaway').ok, true);
  assert.equal((await ctl.scan(ws)).items.find((i) => i.real === envPath).status, 'skipped');
  assert.equal(ctl.unskip(envPath).ok, true);
  assert.equal((await ctl.scan(ws)).items.find((i) => i.real === envPath).status, 'unbacked');
});

test('the bin check fails closed: no workspace known, or bin inside a repo on a fresh ctl', async () => {
  const { envPath, mkCtl, ws } = setup({ binInRepo: true });
  const calls = [];
  const fresh = () => { const c = mkCtl({ run: okRun(calls) }); c.link({ tool: 'proton', target: 'Dev' }); return c; };
  assert.match((await fresh().verify({ via: 'cli', ...ws })).error, /inside a scanned repo/);
  assert.match((await fresh().test(ws)).hint, /inside a scanned repo/);
  assert.equal((await fresh().verify({ via: 'cli' })).error, 'Scan the workspace first.');
  assert.equal((await fresh().test()).hint, 'Scan the workspace first.');
  assert.equal((await fresh().plan([envPath], { via: 'app' })).error, 'Scan the workspace first.');
  assert.equal((await fresh().plan([envPath], { via: 'app', repos: [] })).error, 'Scan the workspace first.');
  // a bin under the workspace root (outside every listed repo) is refused too
  assert.match((await fresh().verify({ via: 'cli', repos: [], root: path.dirname(ws.repos[0].path) })).error, /inside a scanned repo or the workspace/);
  assert.equal(calls.length, 0);
});

test('a locked vault that exits non-zero stops apply with the fixed hint before any save', async () => {
  const { envPath, ws, mkCtl } = setup();
  const calls = [];
  const run = async (cmd, args, o) => {
    calls.push(args[0]);
    if (args[0] === 'info') return { ok: false, code: 1, stdout: '', stderr: 'session expired ' + SECRET };
    return { ok: true, code: 0, stdout: OK_ID, stderr: '' };
  };
  const ctl = mkCtl({ run });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Proton Pass is locked or not signed in. Run "pass-cli login" in a terminal, then try again.');
  assert.deepEqual(calls, ['info']);
});

test('a FIFO at the planned path fails fast', { timeout: 5000 }, async (t) => {
  const { envPath, ws, mkCtl } = setup();
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  fs.rmSync(envPath);
  try { execFileSync('mkfifo', [envPath]); } catch { t.skip('mkfifo unavailable'); return; }
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.equal(r.ok, false);
  assert.match(r.results[0].out, /regular file/);
  assert.equal(calls.length, 0);
});

// A repo with an ignored .env, for the title tests.
function addRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(dir, '.env'), 'K=' + dir + '\n');
  return dir;
}

test('titles: two nested repos with the same folder name get distinct titles; a title clash refuses the plan', async () => {
  const { tmp, mkCtl, record } = setup();
  const root = path.join(tmp, 'ws2');
  const a = addRepo(path.join(root, 'a', 'api'));
  const b = addRepo(path.join(root, 'b', 'api'));
  const ctl = mkCtl({ run: okRun() });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const nested = { repos: [{ path: a, name: 'api' }, { path: b, name: 'api' }], root };
  const s = await ctl.scan(nested);
  const titles = s.items.filter((i) => i.scope === 'repo').map((i) => i.title).sort();
  assert.deepEqual(titles, ['gutcheck: a/api/.env', 'gutcheck: b/api/.env']);
  assert.deepEqual(s.advice.map((x) => x.repo).filter(Boolean).sort(), ['a/api', 'b/api']);
  assert.equal((await ctl.plan([path.join(a, '.env'), path.join(b, '.env')], { via: 'app', ...nested })).ok, true);

  // Repos outside any root fall back to the folder name, so both would be "api/.env": refused.
  const loose = { repos: [{ path: a, name: 'api' }, { path: b, name: 'api' }], root: tmp + '/elsewhere' };
  fs.mkdirSync(loose.root);
  const clash = await ctl.plan([path.join(a, '.env'), path.join(b, '.env')], { via: 'app', ...loose });
  assert.deepEqual(clash, { ok: false, error: 'Two files would get the same vault item title: gutcheck: api/.env. Rename one or skip it.' });

  // A title already recorded for another file is refused too.
  const p = await ctl.plan([path.join(a, '.env')], { via: 'app', ...loose });
  assert.ok(p.ok, p.error);
  assert.equal((await ctl.apply(p.token, { via: 'app' })).ok, true);
  assert.equal(record().entries[path.join(a, '.env')].title, 'gutcheck: api/.env');
  const again = await ctl.plan([path.join(b, '.env')], { via: 'app', ...loose });
  assert.equal(again.error, 'Two files would get the same vault item title: gutcheck: api/.env. Rename one or skip it.');
});

test('scan with home: false leaves out the home folder', async () => {
  const { home, ws, mkCtl } = setup();
  fs.mkdirSync(path.join(home, '.aws'));
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\nk=v\n');
  const ctl = mkCtl({ run: okRun() });
  assert.ok((await ctl.scan(ws)).items.some((i) => i.scope === 'home'));
  assert.ok(!(await ctl.scan({ ...ws, home: false })).items.some((i) => i.scope === 'home'));
});

test('scan returns the saved tool and target for the app panel; the MCP view leaves the target out', async () => {
  const { ws, mkCtl } = setup();
  const ctl = mkCtl({ run: okRun() });
  assert.equal((await ctl.scan(ws)).target, null);
  ctl.link({ tool: 'keepassxc', target: { db: '/h/v.kdbx', keyFile: '/h/v.keyx', group: 'g' } });
  const s = await ctl.scan(ws);
  assert.deepEqual([s.tool, s.target], ['keepassxc', { db: '/h/v.kdbx', keyFile: '/h/v.keyx', group: 'g' }]);
  const { createSecretsService, mcpView } = require('../src/secrets-glue');
  const svc = createSecretsService({ ctl, known: new Map(ws.repos.map((r) => [r.path, r])), settings: () => ({ root: ws.root }) });
  assert.deepEqual((await svc.scan()).target, s.target);
  assert.ok(!('target' in mcpView(s)));
});
