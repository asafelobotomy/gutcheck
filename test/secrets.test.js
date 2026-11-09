const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const P = require('../src/secret-patterns');

test('looksSecret: env files and keys, not templates or public keys', () => {
  for (const p of ['.env', 'api/.env.local', 'certs/server.key', 'a.pem', 'id_ed25519', 'ks.jks', 'credentials.json', 'service-account-prod.json', 'gcp-credentials.json', 'client_secret_123.json', 'android/key.properties', 'App.mobileprovision', '.netrc', '.pgpass'])
    assert.ok(P.looksSecret(p), p);
  for (const p of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'id_ed25519.pub', 'README.md', 'package.json'])
    assert.ok(!P.looksSecret(p), p);
});

test('isFixturePath', () => {
  assert.ok(P.isFixturePath('test/fixtures/key.pem'));
  assert.ok(P.isFixturePath('pkg/testdata/id_rsa'));
  assert.ok(!P.isFixturePath('src/attest/key.pem'));
});

test('classifyHead: TLS keys are never SSH', () => {
  assert.equal(P.classifyHead('-----BEGIN OPENSSH PRIVATE KEY-----', { inSshDir: false, name: 'x' }), 'ssh');
  assert.equal(P.classifyHead('-----BEGIN RSA PRIVATE KEY-----', { inSshDir: true, name: 'deploy' }), 'ssh');
  assert.equal(P.classifyHead('-----BEGIN RSA PRIVATE KEY-----', { inSshDir: false, name: 'id_rsa' }), 'ssh');
  assert.equal(P.classifyHead('-----BEGIN RSA PRIVATE KEY-----', { inSshDir: false, name: 'server.key' }), 'pem');
  assert.equal(P.classifyHead('-----BEGIN PRIVATE KEY-----', { inSshDir: true, name: 'tls' }), 'pem');
  assert.equal(P.classifyHead('API_KEY=1', { inSshDir: false, name: '.env' }), null);
});

const haveKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;
test('opensshFingerprint matches ssh-keygen -l, plain and encrypted', { skip: !haveKeygen && 'ssh-keygen not on PATH' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ssh-'));
  try {
    for (const [name, pw] of [['plain', ''], ['enc', 'pw']]) {
      const k = path.join(dir, name);
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', pw, '-f', k]);
      const want = execFileSync('ssh-keygen', ['-lf', k + '.pub']).toString().split(' ')[1];
      const got = P.opensshFingerprint(fs.readFileSync(k, 'utf8'));
      assert.equal(got.fingerprint, want);
      assert.equal(got.type, 'ssh-ed25519');
    }
    const rsa = path.join(dir, 'rsa');
    execFileSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '', '-f', rsa]);
    assert.equal(P.opensshFingerprint(fs.readFileSync(rsa, 'utf8')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(P.opensshFingerprint('garbage'), null);
  assert.equal(P.opensshFingerprint('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'), null);
});

test('readHead reads only the first bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-head-'));
  try {
    const f = path.join(dir, 'f');
    fs.writeFileSync(f, 'abcdefgh');
    assert.equal(await P.readHead(f, 3), 'abc');
    assert.ok(P.MAX_SECRET_BYTES > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
