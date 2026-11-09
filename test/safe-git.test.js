// Scans never run a program named in a repo's own git config (audit 2026-11-09, B1-B3).
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

test('READONLY_GIT carries the fixed hardening options', () => {
  const s = exec.READONLY_GIT.join(' ');
  for (const o of ['--no-optional-locks', 'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'log.showSignature=false', 'gpg.program=false', 'gpg.ssh.program=false', 'gpg.x509.program=false', 'protocol.ext.allow=never', 'protocol.fd.allow=never']) assert.ok(s.includes(o), o);
});
