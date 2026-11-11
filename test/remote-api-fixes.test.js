// Remote repos (part 2): GitHub API fixes run on a repo that is not cloned here, with only gh steps
// that name the repo and run in a neutral folder; every fix that changes files or local git is refused.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const actions = require('../src/actions');
const { createService } = require('../src/service');
const FixAll = require('../src/renderer/fix-all');

const FILE_FIX = 'This fix changes files or local git, and the repo is not cloned in this workspace. Clone it to fix this; fixes as pull requests come in a later version.';
const SHA = 'a'.repeat(40);
const remoteResult = (o = {}) => ({
  path: 'remote:octo/app', name: 'octo/app', source: 'remote', cacheDir: null, partial: true, score: 90, grade: 'A', findings: [],
  git: { branch: null, branches: [], remoteBranches: [], mergedBranches: [], dirty: 0, ahead: 0, behind: 0 },
  remote: { owner: 'octo', name: 'app', url: 'https://github.com/octo/app', defaultBranch: 'main', viewerPermission: 'ADMIN', protection: false, latestRelease: 'v1.0.0' },
  prs: [{ number: 7, title: 'Bump x', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', headRefOid: SHA, headRefName: 'bump' }, { number: 8, title: 'WIP', isDraft: true, headRefName: 'wip' }, { number: 9, title: 'Red', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: 'FAILURE', headRefName: 'red' }],
  ci: { failed: [{ databaseId: 42, workflowName: 'CI' }] }, tagRulesets: [], actionsSettings: { defaultPermissions: 'write', canApprovePrs: true },
  files: {}, hygiene: {}, deps: {}, ...o,
});

const API = [
  { type: 'repo-edit', description: 'x' },
  { type: 'security-enable', feature: 'alerts' },
  { type: 'protect-branch', preset: 'minimal' },
  { type: 'protect-tags' },
  { type: 'actions-settings', setting: 'read-token' },
  { type: 'run-rerun', runId: 42 },
  { type: 'pr-merge', number: 7, method: 'squash', deleteBranch: true },
  { type: 'pr-close', number: 7 },
  { type: 'pr-ready', number: 8 },
];

test('API_ACTIONS is the allowlist from the spec', () => {
  // repo-archive, pr-create and delete-remote: remote-branches.test.js.
  assert.deepEqual([...FixAll.API_ACTIONS].sort(), [...API.map((a) => a.type), 'repo-archive', 'pr-create', 'delete-remote'].sort());
});

for (const a of API) {
  test(`${a.type} plans on a remote repo with only gh steps, in a neutral folder, naming octo/app`, async () => {
    const p = await actions.plan(remoteResult(), a);
    assert.ok(p.ok, p.error);
    assert.ok(p.steps.length);
    for (const s of p.steps) {
      assert.equal(s.cmd, 'gh');
      assert.equal(s.cwd, os.tmpdir());
      assert.ok(!s.safeGit);
    }
    assert.match(p.steps.map((s) => s.args.join(' ')).join('\n'), /octo\/app/);
  });
}

for (const a of [{ type: 'add-file', template: 'license' }, { type: 'commit-all', message: 'x' }, { type: 'pull' }, { type: 'delete-local', branch: 'bump' }, { type: 'unprotect-branch' }, { type: 'gitignore-append', entries: ['node_modules/'] }]) {
  test(`${a.type} is refused on a remote repo`, async () => {
    const p = await actions.plan(remoteResult(), a);
    assert.equal(p.ok, false);
    assert.equal(p.error, FILE_FIX);
  });
}

test('a danger plan on a remote repo asks for owner/name', async () => {
  const p = await actions.plan(remoteResult(), { type: 'pr-merge', number: 9, method: 'squash' });
  assert.ok(p.ok, p.error);
  assert.equal(p.risk, 'danger');
  assert.equal(p.confirmName, 'octo/app');
});

test('the repo-edit plan runs gh repo edit octo/app in the temp folder', async () => {
  const p = await actions.plan(remoteResult(), { type: 'repo-edit', description: 'A tool' });
  const calls = [];
  const r = await actions.apply(p, { run: async (cmd, args, o) => { calls.push({ cmd, args, cwd: o.cwd }); return { ok: true, code: 0, stdout: '', stderr: '' }; } });
  assert.ok(r.ok);
  assert.deepEqual(calls, [{ cmd: 'gh', args: ['repo', 'edit', 'octo/app', '--description', 'A tool'], cwd: os.tmpdir() }]);
});

test('service: a remote API plan is stored, and the file fix next to it is refused', async () => {
  const known = new Map([['remote:octo/app', remoteResult()]]);
  const svc = createService({ known, settings: () => ({}), audit() {} });
  const [ok, bad] = await svc.planActions([
    { dir: 'remote:octo/app', action: { type: 'security-enable', feature: 'alerts' } },
    { dir: 'remote:octo/app', action: { type: 'add-file', template: 'license' } },
  ]);
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.repoName, 'octo/app');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, FILE_FIX);
  assert.equal(svc.hasPlans(), true);
});

test('Fix all on a remote repo: API fixes offered, file fixes skipped with the reason', () => {
  const f = (id, severity, fix) => ({ id, severity, category: 'Repo', title: id, detail: '', fix });
  const r = remoteResult({ findings: [
    f('merge-delete', 'info', { type: 'repo-edit', label: 'Turn on', deleteBranchOnMerge: true }),
    f('alerts-off', 'warn', { type: 'security-enable', label: 'Enable', feature: 'alerts' }),
    f('pr-stale', 'info', { type: 'pr-close', label: 'Close', number: 7 }),
    f('no-license', 'warn', { type: 'add-file', label: 'Add', template: 'license' }),
    f('ignore-env', 'warn', { type: 'gitignore-append', label: 'Add rules', entries: ['.env'] }),
  ] });
  const p = FixAll.plan(r);
  assert.deepEqual(p.actions.map((a) => a.type).sort(), ['repo-edit', 'security-enable']);
  assert.deepEqual(p.decisions.map((d) => d.id), ['pr-stale']);
  assert.deepEqual(p.skipped.map((s) => [s.id, s.reason]).sort(), [['ignore-env', 'changes files; the repo is not cloned here'], ['no-license', 'changes files; the repo is not cloned here']]);
  assert.ok(!('blocked' in p));
  assert.deepEqual(FixAll.order(r, p.actions).actions.map((a) => a.type).sort(), ['repo-edit', 'security-enable'], 'no push added');
});
