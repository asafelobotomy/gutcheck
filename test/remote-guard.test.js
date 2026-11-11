// Remote repos (part 1): no fix can be planned on one, and code that reads a repo's folder uses the
// cache clone or leaves remote repos out, never opening "remote:owner/name" as a path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createService } = require('../src/service');
const FixAll = require('../src/renderer/fix-all');
const { buildReport } = require('../src/report');

const GUARD = 'Fixes for uncloned repos come in a later version; clone the repo to fix it now.';
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

test('planActions refuses every action on a remote repo', async () => {
  const known = new Map([['remote:octo/app', remoteResult()]]);
  const svc = createService({ known, settings: () => ({}), audit() {} });
  const [p] = await svc.planActions([{ dir: 'remote:octo/app', action: { type: 'repo-edit', description: 'x' } }]);
  assert.equal(p.ok, false);
  assert.equal(p.error, GUARD);
  assert.equal(svc.hasPlans(), false);
});

test('Fix all offers nothing on a remote repo and says why', () => {
  const p = FixAll.plan(remoteResult());
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.decisions, []);
  assert.equal(p.blocked, GUARD);
});

test('the LLM report keeps a remote repo\'s findings but gives no commands to run in a folder', () => {
  const text = buildReport({ repos: [remoteResult()] });
  assert.ok(text.includes('octo/app'));
  assert.ok(text.includes('Repo has no GitHub description'));
  assert.ok(text.includes(GUARD));
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
