// Scan safety on an older git: a wrapper reports git 2.25 (before --show-scope and before
// GIT_NO_LAZY_FETCH) and rejects --show-scope, then hands everything else to the real git.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, sh, fresh, repo, marker, statDirty } = require('./helpers/git-lab');

const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const bin = path.join(ROOT, 'oldgit');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
[ "$1" = "--version" ] && { echo "git version 2.25.1"; exit 0; }
for a in "$@"; do [ "$a" = "--show-scope" ] && { echo "error: unknown option \\\`show-scope'" >&2; exit 129; }; done
exec '${realGit}' "$@"
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const exec = require('../src/exec');

test('without --show-scope a repo-local clean filter is still blanked and the scan works', async () => {
  const d = repo({ 'a.txt': 'hello\n', '.gitattributes': '* filter=evil\n' });
  const m = marker();
  sh(d, 'config', 'filter.evil.clean', m.prog);
  statDirty(d, 'a.txt');
  const st = await exec.git(['status', '--porcelain=v2', '--branch'], { cwd: d });
  assert.ok(st.ok, st.stderr);
  assert.equal(m.ran(), false);
});

test('a partial clone is refused on a git too old to stop lazy fetches', async () => {
  const src = repo({ a: 'a\n' }, 'src');
  const bare = fresh('remote');
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(src, 'push', '-q', bare, 'main');
  sh(bare, 'config', 'uploadpack.allowFilter', 'true');
  const pc = fresh('pc');
  execFileSync(realGit, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${bare}`, pc], { stdio: 'ignore' });
  const m = marker('exec git-upload-pack "$@"');
  sh(pc, 'config', 'remote.origin.uploadpack', m.prog);
  const r = await exec.git(['rev-list', '--objects', '--all'], { cwd: pc });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /partial clone/);
  assert.equal(m.ran(), false);
});
