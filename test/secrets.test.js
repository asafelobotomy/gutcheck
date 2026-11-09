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

// ---- discovery (src/secrets.js) ----
const S = require('../src/secrets');
const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, rel, content = 'x') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `gutcheck-${n}-`));
const repo = () => {
  const dir = tmp('secrets');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'T');
  sh(dir, 'config', 'user.email', 't@e.com');
  return dir;
};
const keygen = (file) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
const OPENSSH = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n';

test('repo: ignored and untracked secrets found; committed, template, big and node_modules skipped', async () => {
  const dir = repo();
  try {
    put(dir, '.gitignore', '.env\n');
    put(dir, '.env', 'A=1');
    put(dir, '.env.example', 'A=');
    put(dir, 'server.key', 'k');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-qm', 'first');
    put(dir, 'config/.env.local', 'B=2');
    put(dir, 'node_modules/x/.env', 'C=3');
    fs.writeFileSync(path.join(dir, 'big.pem'), Buffer.alloc(1024 * 1024 + 1, 'a'));
    put(dir, 'test/fixtures/id_rsa', OPENSSH);
    const c = await S.findRepoSecrets(dir);
    assert.deepEqual(c.map((x) => x.rel).sort(), ['.env', 'config/.env.local', 'test/fixtures/id_rsa']);
    assert.equal(c.find((x) => x.rel === 'test/fixtures/id_rsa').confidence, 'low');
    assert.equal(c.find((x) => x.rel === '.env').confidence, 'high');
    assert.match(c[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(c.find((x) => x.rel === '.env').title, `gutcheck: ${path.basename(dir)}/.env`);
    assert.equal(c.find((x) => x.rel === '.env').repo, path.basename(dir));
    assert.equal(c.find((x) => x.rel === '.env').kind, 'file');
    assert.equal(c.find((x) => x.rel === 'test/fixtures/id_rsa').kind, 'ssh');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('repo: a symlinked secret is reported once by its real path', async () => {
  const dir = repo();
  try {
    put(dir, '.gitignore', '.env\n');
    put(dir, 'shared/.env', 'A=1');
    fs.mkdirSync(path.join(dir, 'app'));
    fs.symlinkSync('../shared/.env', path.join(dir, 'app/.env'));
    sh(dir, 'add', '.gitignore');
    sh(dir, 'commit', '-qm', 'first');
    const c = await S.findRepoSecrets(dir);
    assert.equal(c.filter((x) => x.real.endsWith('shared/.env')).length, 1);
    assert.equal(c.length, 1);
    assert.ok(c.every((x) => x.abs === x.real));
    assert.equal(c[0].rel, 'shared/.env');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('repo: a symlink to a tracked file or to outside the repo is dropped', async () => {
  const dir = repo();
  const outside = tmp('outside');
  try {
    put(dir, 'tracked.key', 'k');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-qm', 'first');
    put(outside, 'x.env', 'A=1');
    fs.symlinkSync('tracked.key', path.join(dir, 'link.key'));
    fs.symlinkSync(path.join(outside, 'x.env'), path.join(dir, '.env'));
    assert.deepEqual(await S.findRepoSecrets(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('workspace: loose .env files only, not templates or other files', async () => {
  const root = tmp('ws');
  try {
    put(root, '.env', 'A=1');
    put(root, '.env.example', 'A=');
    put(root, 'server.key', 'k');
    const c = await S.findWorkspaceSecrets(root);
    assert.deepEqual(c.map((x) => x.title), ['gutcheck: workspace/.env']);
    assert.equal(c[0].scope, 'workspace');
    assert.equal(c[0].repo, null);
    assert.deepEqual(await S.findWorkspaceSecrets('/nonexistent-gc'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('home: fixed list only, content-gated, unreadable files skipped', async () => {
  const home = tmp('home');
  try {
    fs.mkdirSync(path.join(home, '.ssh'));
    keygen(path.join(home, '.ssh/id_ed25519'));
    put(home, '.ssh/known_hosts', 'host ssh-ed25519 AAAA');
    put(home, '.ssh/config', 'Host *\n');
    put(home, '.npmrc', '# registry=x\nregistry=https://r.example\n');
    put(home, '.pypirc', '[pypi]\n');
    put(home, '.docker/config.json', '{"auths":{}}');
    put(home, '.aws/credentials', '[default]\n');
    fs.chmodSync(path.join(home, '.aws/credentials'), 0);
    const c = await S.findHomeSecrets({ home, env: {} });
    const want = ['gutcheck: ~/.pypirc', 'gutcheck: ~/.ssh/id_ed25519'];
    if (process.getuid && process.getuid() === 0) want.unshift('gutcheck: ~/.aws/credentials');
    assert.deepEqual(c.map((x) => x.title).sort(), want.sort());
    const k = c.find((x) => x.kind === 'ssh');
    assert.equal(k.fingerprint.startsWith('SHA256:'), true);
    assert.equal(k.keyType, 'ssh-ed25519');
    assert.equal(k.scope, 'home');
    assert.equal(k.repo, null);
  } finally { fs.chmodSync(path.join(home, '.aws/credentials'), 0o600); fs.rmSync(home, { recursive: true, force: true }); }
});

test('home: .npmrc with _authToken and docker auths with auth are found', async () => {
  const home = tmp('home');
  try {
    put(home, '.npmrc', '//registry.npmjs.org/:_authToken=abc\n');
    put(home, '.docker/config.json', '{"auths":{"ghcr.io":{"auth":"eHg="}}}');
    put(home, '.config/gcloud/application_default_credentials.json', '{}');
    put(home, '.android/debug.keystore', 'k');
    const c = await S.findHomeSecrets({ home, env: {} });
    assert.deepEqual(c.map((x) => x.title).sort(), [
      'gutcheck: ~/.android/debug.keystore', 'gutcheck: ~/.config/gcloud/application_default_credentials.json',
      'gutcheck: ~/.docker/config.json', 'gutcheck: ~/.npmrc']);
    // XDG_CONFIG_HOME moves the gcloud lookup
    const x = await S.findHomeSecrets({ home, env: { XDG_CONFIG_HOME: path.join(home, 'nowhere') } });
    assert.ok(!x.some((i) => /gcloud/.test(i.title)));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('home: gnupg private-keys folder is one entry whose hash changes with its keys', async () => {
  const home = tmp('home');
  try {
    fs.mkdirSync(path.join(home, '.gnupg/private-keys-v1.d'), { recursive: true });
    assert.deepEqual(await S.findHomeSecrets({ home, env: {} }), []);
    put(home, '.gnupg/private-keys-v1.d/a.key', 'one');
    const a = (await S.findHomeSecrets({ home, env: {} }))[0];
    assert.equal(a.title, 'gutcheck: ~/.gnupg/private-keys-v1.d');
    assert.equal(a.kind, 'file');
    put(home, '.gnupg/private-keys-v1.d/b.key', 'two');
    const b = (await S.findHomeSecrets({ home, env: {} }))[0];
    assert.notEqual(a.sha256, b.sha256);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('home: a missing HOME returns []', async () => {
  assert.deepEqual(await S.findHomeSecrets({ home: '/nonexistent-gc', env: {} }), []);
});

test('repo: when git ls-files fails (not a repo) nothing is reported', async () => {
  const dir = tmp('notgit');
  try {
    put(dir, '.env', 'A=1');
    put(dir, 'server.key', 'k');
    assert.deepEqual(await S.findRepoSecrets(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const R = require('../src/secret-status');
const cand = (o) => ({ abs: '/r/.env', real: '/r/.env', scope: 'repo', repo: 'r', rel: '.env', title: 'gutcheck: r/.env', size: 3, sha256: 'a'.repeat(64), kind: 'file', fingerprint: null, keyType: null, confidence: 'high', ...o });
const emptyRec = () => ({ version: 1, entries: {}, skipped: {} });

test('statusOf covers every state', () => {
  const rec = { version: 1, entries: { '/r/.env': { sha256: 'a'.repeat(64) }, '/r/old': { sha256: 'b'.repeat(64) }, '/r/gone': { sha256: 'c'.repeat(64), missing: true }, '/r/k': { sha256: 'd'.repeat(64), mismatch: true } }, skipped: { '/r/t.key': { reason: 'throwaway', at: '' } } };
  assert.equal(R.statusOf(cand(), rec).status, 'backed');
  assert.equal(R.statusOf(cand({ real: '/r/old' }), rec).status, 'changed');
  assert.equal(R.statusOf(cand({ real: '/r/new', sha256: 'e'.repeat(64) }), rec).status, 'unbacked');
  assert.equal(R.statusOf(cand({ real: '/r/gone', sha256: 'c'.repeat(64) }), rec).status, 'missing');
  assert.equal(R.statusOf(cand({ real: '/r/k', sha256: 'd'.repeat(64) }), rec).status, 'mismatch');
  assert.equal(R.statusOf(cand({ real: '/r/t.key' }), rec).status, 'skipped');
});

test('a copy of a backed-up file counts as backed', () => {
  const rec = { version: 1, entries: { '/a/.env': { sha256: 'a'.repeat(64) } }, skipped: {} };
  assert.deepEqual(R.statusOf(cand({ real: '/b/.env' }), rec), { status: 'backed', sameAs: '/a/.env' });
  // a missing entry does not vouch for a copy
  const gone = { version: 1, entries: { '/a/.env': { sha256: 'a'.repeat(64), missing: true } }, skipped: {} };
  assert.equal(R.statusOf(cand({ real: '/b/.env' }), gone).status, 'unbacked');
});

test('record file is 0600, atomic and survives a corrupt file', () => {
  const dir = tmp('rec');
  try {
    const file = path.join(dir, 'sub', 'secret-backups.json');
    const store = R.createRecord(file);
    assert.deepEqual(store.load(), emptyRec());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', 'old', { mode: 0o666 });
    const r = store.update((x) => { x.entries['/r/.env'] = { sha256: 'a'.repeat(64) }; });
    assert.ok(r.entries['/r/.env']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(file + '.tmp'));
    assert.equal(store.load().entries['/r/.env'].sha256, 'a'.repeat(64));
    fs.writeFileSync(file, 'nope');
    assert.deepEqual(store.load(), emptyRec());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('advice: paths only, no contents; low-confidence excluded from severity', () => {
  const a = R.secretAdvice([cand(), cand({ real: '/r/test/fixtures/id_rsa', rel: 'test/fixtures/id_rsa', confidence: 'low' })], emptyRec(), { linked: true });
  const u = a.find((x) => x.id === 'secret-unbacked');
  assert.equal(u.severity, 'warn');
  assert.equal(u.repo, 'r');
  assert.equal(u.category, 'Secrets');
  assert.match(u.title, /^1 secret file exists only on this machine$/);
  assert.match(u.detail, /Probably test keys: test\/fixtures\/id_rsa/);
  assert.deepEqual(u.fix, { type: 'secret-backup', paths: ['/r/.env'] });
});

test('advice: grouping, changed, workspace, unlinked, low-only and empty groups', () => {
  const rec = { version: 1, entries: { '/r/old': { sha256: 'b'.repeat(64) }, '/r/gone': { sha256: 'c'.repeat(64), missing: true }, '/r/ok': { sha256: 'e'.repeat(64) } }, skipped: { '/r/skip': { reason: 'x', at: '' } } };
  const cs = [
    cand({ real: '/r/old', rel: 'old' }), cand({ real: '/r/gone', rel: 'gone', sha256: 'c'.repeat(64) }),
    cand({ real: '/r/ok', rel: 'ok', sha256: 'e'.repeat(64) }), cand({ real: '/r/skip', rel: 'skip' }),
    cand({ real: '/q/.env', repo: 'q', rel: '.env', sha256: 'f'.repeat(64), confidence: 'low' }),
    cand({ real: '/w/a.pem', scope: 'workspace', repo: null, rel: 'a.pem', title: 'gutcheck: workspace/a.pem', sha256: '1'.repeat(64) }),
    cand({ real: '/h/.npmrc', scope: 'home', repo: null, rel: '.npmrc', title: 'gutcheck: ~/.npmrc', sha256: '2'.repeat(64) })];
  const a = R.secretAdvice(cs, rec, { linked: false });
  assert.deepEqual(a.map((x) => x.id).sort(), ['secret-changed', 'secret-unbacked', 'secret-unbacked', 'ws-secret-unbacked']);
  const ch = a.find((x) => x.id === 'secret-changed');
  assert.equal(ch.severity, 'info');
  assert.equal(ch.title, '1 secret file changed since the last backup');
  const r = a.find((x) => x.id === 'secret-unbacked' && x.repo === 'r');
  assert.equal(r.title, '1 secret file exists only on this machine');
  assert.match(r.detail, /gone/);
  assert.match(r.detail, /missing/);
  assert.deepEqual(r.fix, { type: 'secret-link' });
  const q = a.find((x) => x.repo === 'q');
  assert.equal(q.severity, 'info');
  const ws = a.find((x) => x.id === 'ws-secret-unbacked');
  assert.match(ws.title, /^2 secret files exist only on this machine$/);
  assert.match(ws.detail, /a\.pem/);
  assert.match(ws.detail, /~\/\.npmrc/);
  assert.equal(ws.repo, undefined);
  assert.deepEqual(R.secretAdvice([], emptyRec(), { linked: true }), []);
});
