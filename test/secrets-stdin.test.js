const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exec = require('../src/exec');
const { pipeCall } = require('../src/secrets-ctl');
const { SECRET, setup, okRun } = require('./helpers/vault-ctl');

test('stdinPath steps run as /bin/sh with the vault bin as $0; content stays on stdin', async () => {
  const { home, ws, env, mkCtl } = setup();
  fs.mkdirSync(path.join(home, '.ssh'));
  const KEY = `-----BEGIN RSA PRIVATE KEY-----\n${SECRET}\n-----END RSA PRIVATE KEY-----\n`;
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), KEY);
  const calls = [];
  const ctl = mkCtl({ run: okRun(calls) });
  ctl.link({ tool: 'proton', target: 'Dev' });
  const s = await ctl.scan(ws);
  const key = s.items.find((i) => i.real.endsWith('id_rsa'));
  const p = await ctl.plan([key.real], { via: 'app' });
  assert.ok(p.ok, p.error);
  assert.match(p.display[0].text, /^pass-cli item create ssh-key import --from-private-key \/dev\/stdin /); // the real command, not the wrapper
  assert.ok(!p.display[0].text.includes('/bin/sh'));
  assert.ok((await ctl.apply(p.token, { via: 'app' })).ok);
  assert.equal(calls[0].cmd, '/bin/sh');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-c', 'cat | exec "$0" "$@"', path.join(env.PATH, 'pass-cli')]);
  assert.deepEqual(calls[0].args.slice(3, 7), ['item', 'create', 'ssh-key', 'import']);
  assert.equal(calls[0].input, KEY);
  assert.ok(!calls[0].args.join(' ').includes('hunter2'));
});

test('a vault CLI that opens /dev/stdin gets the bytes through the wrapper; bare run fails with ENXIO', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-fix-'));
  const fake = path.join(dir, 'fake-vault');
  const out = path.join(dir, 'out');
  fs.writeFileSync(fake, '#!/bin/sh\ncat "$1" > "$2"\n', { mode: 0o755 });
  const payload = '-----BEGIN KEY-----\nline "two" $HOME `x`\n\x00bin\n-----END KEY-----\n';
  const bare = await exec.run(fake, ['/dev/stdin', out], { input: payload });
  assert.equal(bare.ok, false);
  assert.match(bare.stderr, /No such device or address|ENXIO/);
  const c = pipeCall(fake, ['/dev/stdin', out]);
  assert.equal(c.cmd, '/bin/sh');
  const r = await exec.run(c.cmd, c.args, { input: payload });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(fs.readFileSync(out, 'latin1'), payload);
  const bad = path.join(dir, 'fail-vault');
  fs.writeFileSync(bad, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const f = pipeCall(bad, []);
  assert.equal((await exec.run(f.cmd, f.args, { input: 'x' })).code, 7); // exit status is the vault CLI's
  fs.rmSync(dir, { recursive: true, force: true });
});
