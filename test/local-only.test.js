// Local-only work: what a repo holds that exists on no remote (branches, stashes, changes), its
// finding, and the workspace, CLI and MCP views. Real throwaway repos with a private HOME.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { sh, put, repo, fresh } = require('./helpers/git-lab');
const { collectLocalOnly, summarizeLocalOnly } = require('../src/local-only');
const { scanRepo } = require('../src/scanner');

const facts = (o = {}) => ({ branch: 'main', noRemote: false, upstreamGone: false, stashes: 0, uncommitted: 0, untracked: 0, detachedOnly: 0, ...o });

// A repo whose main is pushed to a local bare remote.
function pushed(files = { 'a.txt': 'a\n' }) {
  const d = repo(files);
  const bare = fresh('bare');
  sh(path.dirname(bare), 'init', '-q', '--bare', bare);
  sh(d, 'remote', 'add', 'origin', bare);
  sh(d, 'push', '-q', '-u', 'origin', 'main');
  return d;
}
const commit = (d, msg) => { put(d, `${msg}.txt`, msg); sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', msg); };

test('counts a branch with commits on no remote next to a pushed one', async () => {
  const d = pushed();
  sh(d, 'switch', '-q', '-c', 'feature'); commit(d, 'f1'); commit(d, 'f2'); sh(d, 'switch', '-q', 'main');
  const lo = await collectLocalOnly(d, facts());
  assert.deepEqual(lo.branches, [{ name: 'feature', ahead: 2 }]);
  assert.equal(lo.neverPushed, false);
  assert.equal(lo.any, true);
});

test('no remote-tracking refs: every branch counts and neverPushed is true', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  sh(d, 'branch', 'side');
  const lo = await collectLocalOnly(d, facts({ noRemote: true }));
  assert.equal(lo.neverPushed, true);
  assert.deepEqual(lo.branches.map((b) => b.name).sort(), ['main', 'side']);
  assert.ok(lo.branches.every((b) => b.ahead === 1));
});

test('more than 50 branches sets truncated and counts 50', async () => {
  const d = repo({ 'a.txt': 'a\n' });
  for (let i = 0; i < 55; i++) sh(d, 'branch', `b${String(i).padStart(2, '0')}`);
  const lo = await collectLocalOnly(d, facts({ noRemote: true }));
  assert.equal(lo.truncated, true);
  assert.equal(lo.branches.length, 50);
});

test('a branch named --help is counted, not read as an option', async () => {
  const d = pushed();
  commit(d, 'x'); // one commit no remote has
  sh(d, 'update-ref', 'refs/heads/--help', 'HEAD');
  sh(d, 'reset', '-q', '--hard', 'HEAD~1');
  const lo = await collectLocalOnly(d, facts());
  assert.deepEqual(lo.branches, [{ name: '--help', ahead: 1 }]);
});

test('a clean pushed repo reports any === false and summarize returns empty', async () => {
  const lo = await collectLocalOnly(pushed(), facts());
  assert.equal(lo.any, false);
  assert.equal(summarizeLocalOnly(lo), '');
});

test('summarizeLocalOnly names each kind of work', () => {
  const lo = { branches: [{ name: 'x', ahead: 1 }], stashes: 1, uncommitted: 3, untracked: 1, noRemote: false, upstreamGone: false, detachedOnly: 0, any: true };
  assert.equal(summarizeLocalOnly(lo), '1 branch, 1 stash, 3 uncommitted, 1 untracked');
});

test('the scan counts untracked apart from uncommitted and stores localOnly', async () => {
  const d = pushed();
  put(d, 'a.txt', 'changed\n');
  put(d, 'new.txt', 'new\n');
  const r = await scanRepo(d, {});
  assert.equal(r.git.untracked, 1);
  assert.equal(r.git.dirty, 2);
  assert.equal(r.localOnly.uncommitted, 1);
  assert.equal(r.localOnly.untracked, 1);
  assert.equal(r.localOnly.any, true);
});
