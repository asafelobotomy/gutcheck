// Scans never run a program named in a repo's own git config (audit 2026-11-09, B1-B4).
// Each attack writes a marker file when its program runs; the scan must leave no marker.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// A private HOME and global git config, so the developer's own config plays no part.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-safegit-'));
const HOME = path.join(ROOT, 'home');
const GLOBAL = path.join(ROOT, 'gitconfig');
fs.mkdirSync(HOME);
fs.writeFileSync(GLOBAL, '');
Object.assign(process.env, { HOME, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const exec = require('../src/exec');
const { collectLocal } = require('../src/scanner');
const { collectRelease } = require('../src/release');
const { scanTests } = require('../src/tests');
const { blameLines } = require('../src/tests/stale');

let n = 0;
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const repo = (files) => {
  const d = path.join(ROOT, `repo${++n}`);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@t');
  sh(d, 'config', 'user.name', 't');
  for (const [rel, text] of Object.entries(files)) put(d, rel, text);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'init');
  return d;
};
// A program that leaves a marker when it runs. `body` runs after the marker is written.
const marker = (body = 'cat') => {
  const m = path.join(ROOT, `marker${++n}`);
  const prog = path.join(ROOT, `prog${n}.sh`);
  fs.writeFileSync(prog, `#!/bin/sh\necho ran >> '${m}'\n${body}\n`, { mode: 0o755 });
  return { prog, ran: () => fs.existsSync(m) };
};
// Change a file's mtime so git must re-read it (and run its clean filter) to know it is unchanged.
const statDirty = (d, rel) => { const t = new Date(Date.now() - 86400000 * (++n)); fs.utimesSync(path.join(d, rel), t, t); };

test('B1: the scan\'s git status does not run a clean filter from .git/config', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=evil\n' });
  const m = marker();
  sh(d, 'config', 'filter.evil.clean', m.prog);
  statDirty(d, 'a.txt');
  const local = await collectLocal(d, {});
  assert.equal(m.ran(), false, 'the clean filter ran');
  assert.equal(local.git.branch, 'main');
  assert.equal(local.git.dirty, 0);
});

test('B1: a required process filter from .git/config is not run, and status still succeeds', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=evil\n' });
  const m = marker('exit 1');
  sh(d, 'config', 'filter.evil.process', m.prog);
  sh(d, 'config', 'filter.evil.required', 'true');
  statDirty(d, 'a.txt');
  const st = await exec.git(['status', '--porcelain=v2', '--branch'], { cwd: d });
  assert.equal(m.ran(), false, 'the process filter ran');
  assert.ok(st.ok, st.stderr);
  assert.match(st.stdout, /# branch\.head main/);
});

test('B1: a filter pulled in by include.path from local config is also disabled', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=inc\n' });
  const m = marker();
  const inc = path.join(ROOT, `inc${++n}.cfg`);
  fs.writeFileSync(inc, `[filter "inc"]\n\tclean = ${m.prog}\n`);
  sh(d, 'config', 'include.path', inc);
  statDirty(d, 'a.txt');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
  assert.equal(m.ran(), false);
});

test('B1: a driver added to .git/config after a scan is seen on the next call (no stale cache)', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=late\n' });
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
  const m = marker();
  sh(d, 'config', 'filter.late.clean', m.prog);
  statDirty(d, 'a.txt');
  assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
  assert.equal(m.ran(), false);
});

test('B1: a driver name git cannot override on the command line makes the call refuse, not run unprotected', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=a=b\n' });
  const m = marker();
  sh(d, 'config', 'filter.a=b.clean', m.prog);
  statDirty(d, 'a.txt');
  const st = await exec.git(['status', '--porcelain'], { cwd: d });
  assert.equal(m.ran(), false);
  assert.equal(st.ok, false);
  assert.match(st.stderr, /refus/i);
});

test('a global filter driver (git-lfs style) still runs: only repo-local drivers are disabled', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=glob\n' });
  const m = marker();
  fs.writeFileSync(GLOBAL, `[filter "glob"]\n\tclean = ${m.prog}\n`);
  try {
    statDirty(d, 'a.txt');
    assert.ok((await exec.git(['status', '--porcelain'], { cwd: d })).ok);
    assert.equal(m.ran(), true, 'the global driver did not run');
  } finally { fs.writeFileSync(GLOBAL, ''); }
});

test('B2: the release scan\'s git log does not run gpg.program for a signed-looking commit', async () => {
  const d = repo({ 'a.txt': 'hello\n' });
  const tree = sh(d, 'rev-parse', 'HEAD^{tree}');
  const body = `tree ${tree}\nparent ${sh(d, 'rev-parse', 'HEAD')}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const c = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: d, input: body, encoding: 'utf8' }).trim();
  sh(d, 'tag', 'v1.0.0', c);
  const m = marker('exit 1');
  sh(d, 'config', 'log.showSignature', 'true');
  sh(d, 'config', 'gpg.program', m.prog);
  sh(d, 'config', 'gpg.ssh.program', m.prog);
  sh(d, 'config', 'gpg.x509.program', m.prog);
  const rel = await collectRelease(d);
  assert.equal(m.ran(), false, 'gpg ran');
  assert.equal(rel.latest, 'v1.0.0');
  assert.equal(rel.taggedAt, '2023-11-14T22:13:20Z');
});

test('B3: the tests scan\'s git blame does not run a textconv driver, and still dates the skip', async () => {
  const d = repo({ 'tests/test_old.py': '@pytest.mark.skip\ndef test_off():\n    assert 1\n', '.gitattributes': '* diff=evil\n' });
  const m = marker('cat "$1"');
  sh(d, 'config', 'diff.evil.textconv', m.prog);
  const times = await blameLines(d, 'tests/test_old.py', [1]);
  assert.equal(m.ran(), false, 'textconv ran from blameLines');
  assert.ok(times[1] > 0, 'blame still works');
  const t = await scanTests(d);
  assert.equal(m.ran(), false, 'textconv ran from scanTests');
  assert.ok(t.upkeep, 'scanTests completed');
});

// Runs the deep scan's npm with a fake npm first on PATH and the given parent env; returns npm's env.
async function npmEnvFor(extra) {
  const d = repo({ 'package.json': JSON.stringify({ dependencies: { leftpad: '1.0.0' } }), '.npmrc': 'registry=http://127.0.0.1:9/leak/${GH_TOKEN}/\nproxy=http://127.0.0.1:9/\n' });
  fs.mkdirSync(path.join(d, 'node_modules'));
  const bin = path.join(ROOT, `bin${++n}`);
  const out = path.join(ROOT, `npm-env${n}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nenv > '${out}'\necho "ARGS $*" >> '${out}'\necho '{}'\n`, { mode: 0o755 });
  const all = { PATH: `${bin}:${process.env.PATH}`, ...extra };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(all)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    await collectLocal(d, { deep: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /ARGS outdated --json/);
  return { bin, env: Object.fromEntries(text.split('\n').filter((l) => l.includes('=') && !l.startsWith('ARGS')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
}
const NO_PROXY_ENV = { HTTPS_PROXY: undefined, https_proxy: undefined, HTTP_PROXY: undefined, http_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined, NODE_EXTRA_CA_CERTS: undefined };

test('B4: npm outdated gets a scrubbed environment and a pinned registry', async () => {
  const { bin, env } = await npmEnvFor({ ...NO_PROXY_ENV, GH_TOKEN: 'gh-secret-x', AWS_SECRET_ACCESS_KEY: 'aws-secret-x', npm_config_registry: 'http://127.0.0.1:9/' });
  for (const k of ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GIT_CONFIG_GLOBAL']) assert.equal(env[k], undefined, `${k} reached npm`);
  assert.ok(!Object.values(env).some((v) => v.includes('secret-x')), 'a secret value reached npm');
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
  // `false`, not empty: npm ignores an empty env value and would take the proxy from the .npmrc.
  for (const k of ['npm_config_proxy', 'npm_config_https_proxy']) assert.equal(env[k], 'false', k);
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(env.npm_config_logs_max, '0');
  assert.equal(env.npm_config_update_notifier, 'false');
  assert.equal(env.npm_config_fund, 'false');
  assert.equal(env.npm_config_audit, 'false');
  assert.equal(env.HOME, HOME);
  assert.ok(env.PATH.startsWith(bin));
});

test('B4: npm keeps the user\'s own proxy and extra CA certificates from the environment', async () => {
  const { env } = await npmEnvFor({ ...NO_PROXY_ENV, HTTPS_PROXY: 'http://proxy.corp:3128', http_proxy: 'http://proxy.corp:3129', NO_PROXY: 'localhost,.corp', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem', GH_TOKEN: 'gh-secret-x' });
  assert.equal(env.npm_config_https_proxy, 'http://proxy.corp:3128');
  assert.equal(env.npm_config_proxy, 'http://proxy.corp:3129');
  assert.equal(env.npm_config_noproxy, 'localhost,.corp');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/corp-ca.pem');
  assert.equal(env.HTTPS_PROXY, undefined, 'passed only as npm settings');
  assert.equal(env.GH_TOKEN, undefined);
});

test('READONLY_GIT carries the fixed hardening options', () => {
  const s = exec.READONLY_GIT.join(' ');
  for (const o of ['--no-optional-locks', 'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'log.showSignature=false', 'gpg.program=false', 'gpg.ssh.program=false', 'gpg.x509.program=false', 'protocol.ext.allow=never', 'protocol.fd.allow=never']) assert.ok(s.includes(o), o);
});
