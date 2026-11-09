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
  assert.deepEqual(s.steps[0].args, ['add', '--no-password', '-k', '/k', '/d.kdbx', 'gutcheck/api/.env']);
  assert.deepEqual(s.steps[1].args, ['attachment-import', '--no-password', '-k', '/k', '/d.kdbx', 'gutcheck/api/.env', '.env', '/dev/stdin']);
  assert.equal(s.steps[1].stdin, true);
  assert.equal(s.parseId(''), 'gutcheck/api/.env');
  const l = ADAPTERS.keepassxc.listCmd(kp);
  assert.deepEqual(l.args, ['ls', '-R', '-f', '--no-password', '-k', '/k', '/d.kdbx', 'gutcheck']);
  assert.ok(ADAPTERS.keepassxc.parseList('api/.env\nother\n').has('gutcheck/api/.env'));
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
