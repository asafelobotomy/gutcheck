// Remote repos: one uncloned repo scanned from its cache clone, with working-copy checks left out,
// and the "GitHub checks only" result when there is no clone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gh = require('../src/github');
const { scanRemote, repoDir, ensureEmptyRepo, WORKING_COPY_IDS } = require('../src/remote-scan');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
gh.fetchFailedRuns = async () => ({ failed: [], error: null }); // no network in tests

// A stand-in for a cache clone, deliberately full of working-copy state that must not be reported.
function fakeClone() {
  const d = tmp('gutcheck-rs-clone-');
  const sh = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(d, '.github', 'workflows', 'ci.yml'), 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { a: '1' } }));
  fs.writeFileSync(path.join(d, 'README.md'), '# x\n');
  sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  sh('branch', 'other');
  fs.writeFileSync(path.join(d, 'stash.txt'), 's'); sh('add', 'stash.txt'); sh('stash', '-q');
  fs.writeFileSync(path.join(d, 'README.md'), '# changed\n');
  fs.writeFileSync(path.join(d, 'untracked.txt'), 'u');
  return d;
}

const listing = { owner: 'octo', name: 'app', isFork: false, isArchived: false, diskKB: 10, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z' };
const ghRes = {
  ok: true,
  snap: {
    remote: { owner: 'octo', name: 'app', url: 'https://github.com/octo/app', description: '', isPublic: true, archived: false, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z', openIssues: 0, viewerPermission: 'READ', alertsEnabled: false, deleteBranchOnMerge: false, isFork: false, hasIssues: true, topics: 0, languages: [], latestRelease: null, securityPolicy: false, contributing: false, codeOfConduct: false, ruleset: false },
    prs: [], protection: null, alertsTotal: 0, alerts: [],
  },
};

test('a remote result is labelled, has no working-copy findings, and keeps file and GitHub findings', async () => {
  const d = fakeClone();
  const r = await scanRemote(listing, { cacheDir: d, ghRes });
  assert.equal(r.source, 'remote');
  assert.equal(r.path, 'remote:octo/app');
  assert.equal(r.name, 'octo/app');
  assert.equal(r.cacheDir, d);
  assert.equal(r.partial, false);
  const ids = r.findings.map((f) => f.id);
  for (const id of ids) assert.ok(!WORKING_COPY_IDS.includes(id), `working-copy finding ${id} on a remote repo`);
  assert.ok(ids.includes('no-license'), 'file checks still run');
  assert.ok(ids.includes('wf-unpinned'), 'workflow checks still run');
  assert.ok(ids.includes('alerts-off'), 'GitHub checks still run');
  assert.equal(r.git.dirty, 0);
  assert.deepEqual(r.git.branches, []);
  assert.equal(r.localOnly, null);
});

test('no clone (too large): GitHub checks only, with the reason as an info finding', async () => {
  const root = tmp('gutcheck-rs-root-');
  const empty = await ensureEmptyRepo(root);
  const r = await scanRemote(listing, { cacheDir: null, emptyDir: empty, ghRes, reason: 'too-large' });
  assert.equal(r.partial, true);
  assert.equal(r.cacheDir, null);
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes('uncloned-too-large'));
  assert.ok(ids.includes('alerts-off'), 'GitHub checks still run');
  for (const id of ['no-license', 'no-readme', 'no-gitignore', 'ci-none', 'no-pr-template', 'no-issue-templates', 'no-security', 'no-contributing', 'no-coc']) assert.ok(!ids.includes(id), `file finding ${id} on a result with no files`);
  assert.equal(r.findings.find((f) => f.id === 'uncloned-too-large').severity, 'info');
});

test('a failed clone gives uncloned-clone-failed with the reason in the detail', async () => {
  const root = tmp('gutcheck-rs-root-');
  const r = await scanRemote(listing, { cacheDir: null, emptyDir: await ensureEmptyRepo(root), ghRes, reason: 'clone-failed: fatal: nope' });
  const f = r.findings.find((x) => x.id === 'uncloned-clone-failed');
  assert.ok(f);
  assert.match(f.detail, /fatal: nope/);
});

test('repoDir: the cache clone for remote repos, the folder for local ones', () => {
  assert.equal(repoDir({ source: 'remote', path: 'remote:o/n', cacheDir: '/c/o__n' }), '/c/o__n');
  assert.equal(repoDir({ source: 'remote', path: 'remote:o/n', cacheDir: null }), null);
  assert.equal(repoDir({ path: '/w/app' }), '/w/app');
});

test('the empty stand-in repo lives in the cache root under a name cleanup never touches', async () => {
  const root = tmp('gutcheck-rs-root-');
  const e = await ensureEmptyRepo(root);
  assert.equal(path.dirname(e), root);
  assert.ok(!path.basename(e).includes('__'));
  assert.ok(fs.existsSync(path.join(e, '.git')));
  assert.equal(await ensureEmptyRepo(root), e, 'made once');
});
