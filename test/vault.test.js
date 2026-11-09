const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ADAPTERS, TOOL_INFO } = require('../src/vault-adapters');

const SECRET = 'API_KEY=hunter2-unique-marker';
const c = { title: 'gutcheck: api/.env', rel: '.env', kind: 'file', size: SECRET.length };
const kp = { db: '/d.kdbx', keyFile: '/k', group: 'gutcheck' };
const tgt = (id) => (id === 'keepassxc' ? kp : 'Dev');

for (const [id, a] of Object.entries(ADAPTERS)) {
  test(`${id}: content never in argv, always in encoded stdin`, () => {
    const s = a.saveCmd(c, tgt(id));
    const all = s.steps || [s];
    for (const st of all) assert.ok(!JSON.stringify(st.args).includes('hunter2'));
    const enc = all.map((st) => (st.encode ? String(st.encode(Buffer.from(SECRET))) : '')).join('');
    assert.ok(enc.includes('hunter2') || Buffer.from(enc, 'base64').toString().includes('hunter2'));
  });
  test(`${id}: has info, status command and a fixed-text parseStatus`, () => {
    assert.ok(a.label && a.bin && a.targetHelp);
    assert.equal(TOOL_INFO[id].live, id === 'proton');
    assert.ok(TOOL_INFO[id].unlockHint);
    assert.ok(Array.isArray(a.statusCmd(tgt(id)).args));
    const r = a.parseStatus({ ok: false, stdout: 'LEAK-ME', stderr: 'LEAK-ME' });
    assert.equal(r.ok, false);
    assert.ok(!String(r.hint).includes('LEAK-ME'));
  });
}

test('proton ssh keys import from /dev/stdin', () => {
  const s = ADAPTERS.proton.saveCmd({ ...c, kind: 'ssh', title: 'gutcheck: ~/.ssh/id_ed25519' }, 'Dev');
  assert.deepEqual(s.args.slice(0, 6), ['item', 'create', 'ssh-key', 'import', '--from-private-key', '/dev/stdin']);
  assert.deepEqual(s.args.slice(6), ['--title', 'gutcheck: ~/.ssh/id_ed25519', '--vault-name', 'Dev']);
  const raw = Buffer.from([0, 1, 2]);
  assert.deepEqual(s.encode(raw), raw);
});

test('proton note save uses a template on stdin', () => {
  const s = ADAPTERS.proton.saveCmd(c, 'Dev');
  assert.deepEqual(s.args, ['item', 'create', 'note', '--vault-name', 'Dev', '--from-template', '-']);
  const j = JSON.parse(s.encode(Buffer.from(SECRET)));
  assert.deepEqual(j, { title: c.title, note: SECRET, extra_fields: [] });
});

test('proton parseId takes the bare id line', () => {
  const id = 'MfEmlPW3WSPOmNDYWKm_ncPcK3g6DImo_MnoV1sZIsmHaAZMyS2cq-rm8yG2eQdOYrka2ZfuifhrnMXX-R1vQg==';
  assert.equal(ADAPTERS.proton.saveCmd(c, 'Dev').parseId(id + '\n'), id);
  assert.equal(ADAPTERS.proton.saveCmd(c, 'Dev').parseId('Error: x'), null);
});

test('proton parseStatus: logged in when info has an id', () => {
  assert.equal(ADAPTERS.proton.parseStatus({ ok: true, stdout: '{"id":"u1"}' }).ok, true);
  const bad = ADAPTERS.proton.parseStatus({ ok: true, stdout: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.hint, /pass-cli login/);
});

test('proton parseList and parseFingerprint use recorded output', () => {
  const list = '{"items":[{"id":"A","title":"t","item_type":"Note","state":"Active"},{"id":"B","title":"u","item_type":"SshKey","state":"Active"}],"folders":[]}';
  const a = ADAPTERS.proton;
  assert.deepEqual(a.listCmd('Dev').args, ['item', 'list', '--vault-name', 'Dev', '--filter-state', 'active', '--output', 'json']);
  const ids = a.parseList(list);
  assert.ok(ids.has('A') && ids.has('B') && ids.size === 2);
  assert.equal(a.parseList('garbage').size, 0);
  assert.deepEqual(a.fingerprintCmd('ID1', 'Dev').args,
    ['ssh-agent', 'debug', '--vault-name', 'Dev', '--item-id', 'ID1', '--output', 'json']);
  const dbg = JSON.stringify({ valid_keys: [{ title: 'k', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:oMJ63abc' }], invalid_items: [] });
  assert.equal(a.parseFingerprint(dbg), 'SHA256:oMJ63abc');
  const inv = JSON.stringify({ valid_keys: [], invalid_items: [{ title: 'k', reason: 'SSH key is encrypted but no passphrase found in custom fields' }] });
  assert.equal(a.parseFingerprint(inv), null);
  assert.equal(a.parseFingerprint('x'), null);
});

test('bitwarden refuses notes over 10000 characters', () => {
  assert.match(ADAPTERS.bitwarden.saveCmd({ ...c, size: 10001 }, '').error, /10,000/);
  const s = ADAPTERS.bitwarden.saveCmd(c, '');
  assert.throws(() => s.encode(Buffer.from('x'.repeat(10001))), /10,000/);
});

test('bitwarden save: no argv content, folderId null or given', () => {
  const s = ADAPTERS.bitwarden.saveCmd(c, '');
  assert.deepEqual(s.args, ['create', 'item']);
  const j = JSON.parse(Buffer.from(s.encode(Buffer.from(SECRET)), 'base64').toString());
  assert.deepEqual(j, { type: 2, secureNote: { type: 0 }, name: c.title, notes: SECRET, folderId: null });
  const j2 = JSON.parse(Buffer.from(ADAPTERS.bitwarden.saveCmd(c, 'f-1').encode(Buffer.from('a')), 'base64').toString());
  assert.equal(j2.folderId, 'f-1');
  assert.equal(s.parseId('{"id":"abc","notes":"x"}'), 'abc');
  assert.equal(s.parseId('bad'), null);
});

test('bitwarden parseStatus maps locked/unauthenticated to hints', () => {
  const b = ADAPTERS.bitwarden;
  assert.deepEqual(b.parseStatus({ ok: true, stdout: '{"status":"locked"}' }).locked, true);
  assert.match(b.parseStatus({ ok: true, stdout: '{"status":"locked"}' }).hint, /bw unlock/);
  assert.match(b.parseStatus({ ok: true, stdout: '{"status":"unauthenticated"}' }).hint, /bw login/);
  assert.equal(b.parseStatus({ ok: true, stdout: '{"status":"unlocked"}' }).ok, true);
});

test('bitwarden parseList reads only ids', () => {
  const ids = ADAPTERS.bitwarden.parseList('[{"id":"i1","notes":"SECRET"},{"id":"i2"}]');
  assert.deepEqual([...ids].sort(), ['i1', 'i2']);
  assert.deepEqual(ADAPTERS.bitwarden.listCmd('f1').args, ['list', 'items', '--folderid', 'f1']);
});

test('binary content is base64 for text-only tools', () => {
  const bin = Buffer.from([0, 1, 2, 255]);
  const enc = JSON.parse(ADAPTERS.proton.saveCmd(c, 'Dev').encode(bin));
  assert.match(enc.note, /^base64:\n/);
  assert.equal(ADAPTERS.pass.saveCmd(c, '').encode(bin), 'base64:\n' + bin.toString('base64'));
});

test('1password saves a document and parses the id', () => {
  const s = ADAPTERS['1password'].saveCmd(c, 'Dev');
  assert.deepEqual(s.args, ['document', 'create', '-', '--title', c.title, '--file-name', '.env', '--vault', 'Dev', '--tags', 'gutcheck', '--format', 'json']);
  assert.equal(s.parseId('{"uuid":"u1"}'), 'u1');
  assert.equal(s.parseId('{"id":"i1"}'), 'i1');
  assert.equal(s.parseId('x'), null);
  assert.equal(ADAPTERS['1password'].parseStatus({ ok: true, stdout: '{}' }).ok, true);
  assert.match(ADAPTERS['1password'].parseStatus({ ok: false }).hint, /op signin/);
});

test('keepassxc saves in two steps, key file only', () => {
  const s = ADAPTERS.keepassxc.saveCmd(c, kp);
  assert.equal(s.steps.length, 2);
  assert.deepEqual(s.steps[0].args, ['add', '--no-password', '-k', '/k', '/d.kdbx', 'gutcheck/api_.env']);
  assert.deepEqual(s.steps[1].args, ['attachment-import', '--no-password', '-k', '/k', '/d.kdbx', 'gutcheck/api_.env', '.env', '/dev/stdin']);
  assert.equal(s.steps[1].stdin, true);
  assert.equal(s.parseId(''), 'gutcheck/api_.env');
  const l = ADAPTERS.keepassxc.listCmd(kp);
  assert.deepEqual(l.args, ['ls', '-R', '-f', '--no-password', '-k', '/k', '/d.kdbx', 'gutcheck']);
  assert.ok(ADAPTERS.keepassxc.parseList('api_.env\nother\n').has('gutcheck/api_.env'));
  const n = ADAPTERS.keepassxc.saveCmd({ ...c, title: 'gutcheck: ~/.ssh/a/b' }, kp);
  assert.equal(n.parseId(''), 'gutcheck/home_.ssh_a_b');
  assert.equal(n.steps[0].args[5].split('/').length, 2);
});

test('pass and gopass entry names, ids and existence', () => {
  const p = ADAPTERS.pass.saveCmd({ ...c, title: 'gutcheck: ~/.aws/cred entials' }, '');
  assert.deepEqual(p.args, ['insert', '-m', '-f', 'gutcheck/home/.aws/cred_entials']);
  assert.equal(p.parseId(''), 'gutcheck/home/.aws/cred_entials');
  assert.deepEqual(ADAPTERS.gopass.saveCmd(c, 'keys').args, ['insert', '-f', 'keys/api/.env']);
  assert.deepEqual(ADAPTERS.gopass.listCmd('').args, ['ls', '--flat']);
  assert.ok(ADAPTERS.gopass.parseList('gutcheck/api/.env\nx\n').has('gutcheck/api/.env'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-'));
  fs.mkdirSync(path.join(dir, 'gutcheck/api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gutcheck/api/.env.gpg'), 'x');
  const env = { PASSWORD_STORE_DIR: dir };
  assert.equal(ADAPTERS.pass.existsFs('gutcheck/api/.env', '', env), true);
  assert.equal(ADAPTERS.pass.existsFs('gutcheck/nope', '', env), false);
  fs.rmSync(dir, { recursive: true });
});

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
const okRun = (calls = []) => async (cmd, args, o) => { calls.push({ cmd, args, input: String(o.input), opts: o }); return { ok: true, code: 0, stdout: OK_ID + '\n', stderr: '' }; };

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
  const run = async () => ({ ok: false, code: 1, stdout: 'STDOUT-LEAK', stderr: 'parse error near: API_KEY=hunter2-unique-marker\nnear: zzunique-marker-tail\nhint: unlock' });
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
  const run = async (cmd, args, o) => { seen.push(o); return { ok: false, code: null, stdout: '', stderr: 'Command failed: killed' }; };
  const ctl = mkCtl({ run });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.ok(seen.length && seen.every((o) => o.timeout === 60000 && o.input != null));
  assert.match(r.results[0].out, /locked/);
  assert.match(r.results[0].out, /pass-cli login/);
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
  const { mkCtl, env } = setup();
  const ctl = mkCtl({ run: okRun() });
  const t = ctl.tools();
  assert.equal(t.find((x) => x.id === 'proton').found, true);
  assert.equal(t.find((x) => x.id === 'bitwarden').found, false);
  assert.deepEqual(t.find((x) => x.id === 'google'), { id: 'google', label: 'Google Password Manager', found: false, reason: 'No CLI or write API' });
  ctl.link({ tool: 'pass', target: '' });
  assert.equal((await ctl.test()).ok, false);
  fs.mkdirSync(env.PASSWORD_STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.PASSWORD_STORE_DIR, '.gpg-id'), 'me@example.com\n');
  assert.equal((await ctl.test()).ok, true);
});

test('verify marks missing and mismatch; locked changes nothing', async () => {
  const { home, ws, mkCtl, record, dataDir } = setup();
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n');
  let n = 0;
  const ids = ['A'.repeat(24), 'B'.repeat(24)];
  const ctl = mkCtl({ run: async () => ({ ok: true, code: 0, stdout: ids[n++] + '\n', stderr: '' }) });
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
  const lr = await locked.verify({ via: 'app' });
  assert.equal(lr.ok, false);
  assert.match(lr.error, /pass-cli login/);
  assert.deepEqual(record(), before);
  const run = async (cmd, args) => {
    if (args[0] === 'info') return { ok: true, code: 0, stdout: '{"id":"u"}', stderr: '' };
    if (args[0] === 'item') return { ok: true, code: 0, stdout: JSON.stringify({ items: [{ id: sshId }] }), stderr: '' };
    return { ok: true, code: 0, stdout: JSON.stringify({ valid_keys: [{ fingerprint: 'SHA256:new' }] }), stderr: '' };
  };
  assert.deepEqual(await mkCtl({ run }).verify({ via: 'app' }), { ok: true, checked: 2, missing: 1, mismatch: 1 });
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
