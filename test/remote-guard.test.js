// Remote repos: file fixes cannot be planned on one (GitHub API fixes can: remote-api-fixes.test.js),
// and code that reads a repo's folder uses the cache clone or leaves remote repos out, never opening
// "remote:owner/name" as a path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createService } = require('../src/service');
const FixAll = require('../src/renderer/fix-all');
const { buildReport } = require('../src/report');

const GUARD = 'This fix changes files or local git, and the repo is not cloned in this workspace. Clone it to fix this; fixes as pull requests come in a later version.';
const NOTE = 'Not cloned in this workspace: GitHub fixes (pull requests, CI, protection, security and repository settings) run here; fixes that change files need a clone for now.';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function clone() {
  const d = tmp('gc-guard-clone-');
  const sh = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'big.js'), 'x\n'.repeat(500));
  sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  return d;
}

const finding = { id: 'no-description', category: 'Repo', severity: 'info', title: 'Repo has no GitHub description', detail: 'x', fix: { type: 'repo-edit', label: 'Set description…', deleteBranchOnMerge: true } };
const remoteResult = (o = {}) => ({
  path: 'remote:octo/app', name: 'octo/app', source: 'remote', cacheDir: null, partial: true, score: 99, grade: 'A',
  findings: [finding, { id: 'no-license', category: 'Docs & Licence', severity: 'info', title: 'Missing LICENSE', detail: 'x', fix: { type: 'add-file', label: 'Add', template: 'license' } }],
  git: { branch: null, branches: [], dirty: 0, ahead: 0, behind: 0 }, remote: { owner: 'octo', name: 'app', url: 'https://github.com/octo/app', defaultBranch: 'main' }, prs: [], ci: { failed: [] }, files: {}, hygiene: {}, ...o,
});

test('planActions refuses a file fix on a remote repo', async () => {
  const known = new Map([['remote:octo/app', remoteResult()]]);
  const svc = createService({ known, settings: () => ({}), audit() {} });
  const [p] = await svc.planActions([{ dir: 'remote:octo/app', action: { type: 'add-file', template: 'license' } }]);
  assert.equal(p.ok, false);
  assert.equal(p.error, GUARD);
  assert.equal(svc.hasPlans(), false);
});

test('Fix all on a remote repo offers the API fix and skips the file fix', () => {
  const p = FixAll.plan(remoteResult());
  assert.deepEqual(p.actions.map((a) => a.type), ['repo-edit']);
  assert.deepEqual(p.decisions, []);
  assert.deepEqual(p.skipped.map((s) => s.id), ['no-license']);
});

test('the LLM report keeps a remote repo\'s findings but gives no commands to run in a folder', () => {
  const text = buildReport({ repos: [remoteResult()] });
  assert.ok(text.includes('octo/app'));
  assert.ok(text.includes('Repo has no GitHub description'));
  assert.ok(text.includes(NOTE));
  assert.ok(text.includes('-R octo/app'), 'gh commands name the repo');
  assert.ok(text.includes('gutcheck fix octo/app all'));
  assert.ok(!/^\s*cd /m.test(text), 'no cd into a folder that does not exist');
  assert.ok(!text.includes('remote:octo/app'), 'the internal key is not shown as a path');
});

test('clutter and quality read the cache clone; partial results and tests leave remote repos out', async () => {
  const c = clone();
  const known = new Map([
    ['remote:octo/app', remoteResult({ cacheDir: c, partial: false })],
    ['remote:octo/big', remoteResult({ path: 'remote:octo/big', name: 'octo/big' })],
  ]);
  const svc = createService({ known, settings: () => ({ quality: { maxLines: 400 } }), audit() {} });
  const cl = await svc.clutterScan();
  assert.ok(cl.ok, cl.error);
  assert.deepEqual(cl.repos.map((r) => [r.path, r.name, !!r.error]), [['remote:octo/app', 'octo/app', false]]);
  const q = await svc.qualityScan();
  assert.ok(q.ok, q.error);
  assert.deepEqual(q.repos.map((r) => r.name), ['octo/app']);
  assert.equal(q.repos[0].loc.overCount, 1, 'big.js in the clone was read');
  const t = await svc.testsScan();
  assert.equal(t.ok, false, 'no local repos to review');
});

test('the report reads quality from the cache clone and skips the folder-only sections', async () => {
  const c = clone();
  const known = new Map([['remote:octo/app', remoteResult({ cacheDir: c, partial: false })]]);
  const svc = createService({ known, settings: () => ({ quality: { maxLines: 400 } }), audit() {} });
  const r = await svc.reportText('remote:octo/app');
  assert.ok(r.ok, r.error);
  assert.ok(r.text.includes('big.js'), 'quality from the clone');
});
