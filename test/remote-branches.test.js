// Remote repos (part 2, section 8): archiving an inactive repo, branches read from GitHub, and the
// API branch actions (delete on GitHub, open a PR, close a PR and delete its branch).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const actions = require('../src/actions');
const FixAll = require('../src/renderer/fix-all');
const { checkRepoSettings } = require('../src/checks');

const OID = (c) => c.repeat(40);
const old = new Date(Date.now() - 400 * 86400000).toISOString();
const remoteResult = (o = {}) => ({
  path: 'remote:octo/app', name: 'octo/app', source: 'remote', cacheDir: null, partial: true, score: 90, grade: 'A', findings: [],
  git: { branch: null, branches: [], remoteBranches: [], mergedBranches: [], dirty: 0, ahead: 0, behind: 0 },
  remote: { owner: 'octo', name: 'app', url: 'https://github.com/octo/app', defaultBranch: 'main', viewerPermission: 'ADMIN', protection: false, pushedAt: old },
  prs: [{ number: 7, title: 'Feature', isDraft: false, headRefName: 'feat', headRefOid: OID('f') }, { number: 8, title: 'From a fork', isDraft: false, headRefName: 'patch-1', headRefOid: OID('9') }],
  ci: { failed: [] }, files: {}, hygiene: {}, deps: {},
  ghBranches: [
    { name: 'feat', oid: OID('f'), date: '2026-10-01T00:00:00Z', unique: 3, mergedPr: null },
    { name: 'old/done', oid: OID('a'), date: '2026-09-01T00:00:00Z', unique: 0, mergedPr: null },
    { name: 'squashed', oid: OID('b'), date: '2026-08-01T00:00:00Z', unique: 2, mergedPr: 12 },
    { name: 'idea', oid: OID('c'), date: '2026-07-01T00:00:00Z', unique: 4, mergedPr: null },
  ],
  ...o,
});
const args = (p) => p.steps.map((s) => [s.cmd, ...s.args].join(' '));

/* ---------------------------------------------------------------- archive */

test('inactive offers archiving only to an admin', () => {
  const s = (perm) => ({ remote: { owner: 'octo', name: 'app', defaultBranch: 'main', pushedAt: old, viewerPermission: perm, archived: false }, protection: true });
  const fix = (perm) => (checkRepoSettings(s(perm)).find((f) => f.id === 'inactive') || {}).fix;
  assert.deepEqual(fix('ADMIN'), { type: 'repo-archive', label: 'Archive…' });
  assert.equal(fix('WRITE'), undefined);
});

test('repo-archive on a remote repo: gh repo archive, danger, confirm by owner/name; refused without admin', async () => {
  const p = await actions.plan(remoteResult(), { type: 'repo-archive' });
  assert.ok(p.ok, p.error);
  assert.deepEqual(args(p), ['gh repo archive octo/app --yes']);
  assert.equal(p.steps[0].cwd, os.tmpdir());
  assert.equal(p.risk, 'danger');
  assert.equal(p.confirmName, 'octo/app');
  assert.ok(p.warnings.some((w) => /unarchive/i.test(w)));
  const r = remoteResult();
  r.remote.viewerPermission = 'WRITE';
  const q = await actions.plan(r, { type: 'repo-archive' });
  assert.equal(q.ok, false);
  assert.match(q.error, /Admin permission/);
});

test('Fix all asks before archiving, starts on leave it, and archives after every other GitHub change', () => {
  const f = (id, fix) => ({ id, severity: 'info', category: 'Repo', title: id, detail: '', fix });
  const r = remoteResult({ findings: [f('inactive', { type: 'repo-archive', label: 'Archive…' }), f('alerts-off', { type: 'security-enable', label: 'Enable', feature: 'alerts' })] });
  const p = FixAll.plan(r);
  const d = p.decisions.find((x) => x.id === 'inactive');
  assert.ok(d);
  assert.equal(d.choices[d.pick].action, null, 'starts on leave it');
  const order = FixAll.order(r, p.actions, [{ action: d.choices[0].action }, { action: { type: 'pr-close', number: 7 } }, { action: { type: 'delete-remote', branches: ['old/done'] } }]).actions.map((a) => a.type);
  assert.equal(order[order.length - 1], 'repo-archive');
});

/* ---------------------------------------------------------------- branches from GitHub */

const rb = require('../src/remote-branches');
const { scanRemote } = require('../src/remote-scan');

const node = (name, oid, date, behindBy, merged = null) => ({ name, target: { oid, committedDate: date }, compare: { behindBy }, associatedPullRequests: { nodes: merged ? [merged] : [] } });
const payload = { data: { repository: { refs: { totalCount: 6, nodes: [
  node('main', OID('0'), '2026-11-01T00:00:00Z', 0),
  node('feat', OID('f'), '2026-10-01T00:00:00Z', 3),
  node('old/done', OID('a'), '2026-09-01T00:00:00Z', 0),
  node('squashed', OID('b'), '2026-08-01T00:00:00Z', 2, { number: 12, headRefOid: OID('b') }),
  node('moved-on', OID('d'), '2026-07-15T00:00:00Z', 1, { number: 13, headRefOid: OID('e') }),
  node('-rf', OID('c'), '2026-07-01T00:00:00Z', 1),
] } } } };

test('parseBranches: unique commits, merged by ancestry or by a squash PR at the same commit, default and unsafe names dropped', () => {
  assert.deepEqual(rb.parseBranches(payload, 'main'), [
    { name: 'feat', oid: OID('f'), date: '2026-10-01T00:00:00Z', unique: 3, mergedPr: null },
    { name: 'old/done', oid: OID('a'), date: '2026-09-01T00:00:00Z', unique: 0, mergedPr: null },
    { name: 'squashed', oid: OID('b'), date: '2026-08-01T00:00:00Z', unique: 2, mergedPr: 12 },
    { name: 'moved-on', oid: OID('d'), date: '2026-07-15T00:00:00Z', unique: 1, mergedPr: null },
  ]);
  assert.equal(rb.isMerged({ unique: 0, mergedPr: null }), true);
  assert.equal(rb.isMerged({ unique: 2, mergedPr: 12 }), true);
  assert.equal(rb.isMerged({ unique: 1, mergedPr: null }), false);
});

test('fetchBranches passes owner, name and default branch as variables; a failure is null, not none', async () => {
  const calls = [];
  const ok = await rb.fetchBranches({ owner: 'octo', name: 'app' }, 'main', { run: async (cmd, a) => { calls.push([cmd, a]); return { ok: true, stdout: JSON.stringify(payload), stderr: '' }; } });
  assert.equal(ok.length, 4);
  const [cmd, a] = calls[0];
  assert.equal(cmd, 'gh');
  assert.deepEqual(a.slice(0, 2), ['api', 'graphql']);
  for (const v of ['o=octo', 'n=app', 'd=main']) assert.ok(a.includes(v), v);
  assert.ok(!a.find((x) => x.startsWith('query=')).includes('octo'), 'never built into the query');
  assert.equal(await rb.fetchBranches({ owner: 'octo', name: 'app' }, 'main', { run: async () => ({ ok: false, stdout: '', stderr: 'HTTP 502' }) }), null);
  assert.equal(await rb.fetchBranches({ owner: 'octo', name: 'app' }, null, { run: async () => assert.fail('no call without a default branch') }), null);
});

test('fetchRemoteData adds each repo\'s branches to its GitHub result', async () => {
  const snap = { remote: { owner: 'octo', name: 'app', defaultBranch: 'main' } };
  const m = await rb.fetchRemoteData([{ owner: 'octo', name: 'app' }], { fetchRepos: async () => new Map([['octo/app', { ok: true, snap }]]), branches: async (ref, def) => [{ name: `${ref.name}-${def}` }] });
  assert.deepEqual(m.get('octo/app').branches, [{ name: 'app-main' }]);
});

test('branchFindings: merged branches in one finding, unmerged ones without a PR each, open PR branches left alone', () => {
  const r = remoteResult();
  const fs_ = rb.branchFindings(r.ghBranches, { remote: r.remote, prs: r.prs });
  const merged = fs_.find((f) => f.id === 'gh-merged-branches');
  assert.equal(merged.severity, 'info');
  assert.deepEqual(merged.fix, { type: 'delete-remote', label: 'Delete them on GitHub…', branches: ['old/done', 'squashed'] });
  assert.deepEqual(fs_.filter((f) => f.id.startsWith('gh-branch-no-pr-')).map((f) => [f.id, f.fix]), [['gh-branch-no-pr-idea', { type: 'pr-create', label: 'Open a PR…', branch: 'idea' }]], 'feat has PR #7');
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `b${i}`, oid: OID('1'), date: '2026-01-01T00:00:00Z', unique: 1, mergedPr: null }));
  assert.equal(rb.branchFindings(many, { remote: r.remote, prs: [] }).length, 5, 'at most five');
  const reader = rb.branchFindings(r.ghBranches, { remote: { ...r.remote, viewerPermission: 'READ' }, prs: r.prs });
  assert.ok(reader.every((f) => !f.fix), 'no fixes without push permission');
  assert.deepEqual(rb.branchFindings(null, { remote: r.remote, prs: [] }), []);
});

test('scanRemote keeps the GitHub branches and adds their findings', async () => {
  const { ensureEmptyRepo } = require('../src/remote-scan');
  const dir = await ensureEmptyRepo(require('node:fs').mkdtempSync(require('node:path').join(os.tmpdir(), 'gc-rb-')));
  const snap = { remote: { owner: 'octo', name: 'app', url: 'https://github.com/octo/app', defaultBranch: 'main', viewerPermission: 'ADMIN', pushedAt: '2026-11-01T00:00:00Z', archived: false }, prs: [], protection: true, alerts: [], alertsTotal: 0 };
  const branches = [{ name: 'old/done', oid: OID('a'), date: '2026-09-01T00:00:00Z', unique: 0, mergedPr: null }];
  const res = await scanRemote({ owner: 'octo', name: 'app', diskKB: 1 }, { emptyDir: dir, ghRes: { ok: true, snap, branches }, reason: 'too-large' });
  assert.deepEqual(res.ghBranches, branches);
  assert.ok(res.findings.some((f) => f.id === 'gh-merged-branches'));
});

/* ---------------------------------------------------------------- API branch actions */

test('delete-remote on a remote repo: a commit check, then an API delete, per branch; caution when merged, undo restores', async () => {
  const p = await actions.plan(remoteResult(), { type: 'delete-remote', branches: ['old/done', 'squashed'] });
  assert.ok(p.ok, p.error);
  assert.deepEqual(args(p), [
    'gh api repos/octo/app/git/ref/heads/old/done --jq .object.sha', 'gh api -X DELETE repos/octo/app/git/refs/heads/old/done',
    'gh api repos/octo/app/git/ref/heads/squashed --jq .object.sha', 'gh api -X DELETE repos/octo/app/git/refs/heads/squashed',
  ]);
  assert.deepEqual(p.steps.filter((s) => s.kind === 'check').map((s) => s.expect), [OID('a'), OID('b')]);
  assert.ok(p.steps.every((s) => s.cwd === os.tmpdir()));
  assert.equal(p.risk, 'caution');
  assert.equal(p.undo, `gh api -X POST repos/octo/app/git/refs -f ref=refs/heads/old/done -f sha=${OID('a')}\ngh api -X POST repos/octo/app/git/refs -f ref=refs/heads/squashed -f sha=${OID('b')}`);
});

test('delete-remote on a remote repo: unmerged work is danger; default, open PR, unknown and unread branches are refused', async () => {
  const d = await actions.plan(remoteResult(), { type: 'delete-remote', branch: 'idea' });
  assert.ok(d.ok, d.error);
  assert.equal(d.risk, 'danger');
  assert.equal(d.confirmName, 'octo/app');
  const no = async (o, re, r = remoteResult()) => { const p = await actions.plan(r, { type: 'delete-remote', ...o }); assert.equal(p.ok, false); assert.match(p.error, re); };
  await no({ branch: 'main' }, /default branch/);
  await no({ branch: 'feat' }, /PR #7 is open/);
  await no({ branch: 'nope' }, /not a branch on GitHub/);
  await no({ branches: [] }, /Choose/);
  await no({ branch: 'idea' }, /could not read this repository's branches/, remoteResult({ ghBranches: null }));
});

test('the commit check refuses a branch pushed to since the preview', async () => {
  const p = await actions.plan(remoteResult(), { type: 'delete-remote', branch: 'old/done' });
  const calls = [];
  const r = await actions.apply(p, { run: async (cmd, a) => { calls.push(a.join(' ')); return { ok: true, code: 0, stdout: `${OID('9')}\n`, stderr: '' }; } });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, 'the delete never ran');
  assert.match(r.results[0].out, /changed since the scan/);
});

test('branch names are URL-encoded in API paths', async () => {
  const r = remoteResult();
  r.ghBranches.push({ name: 'fix#1', oid: OID('e'), date: null, unique: 0, mergedPr: null });
  const p = await actions.plan(r, { type: 'delete-remote', branch: 'fix#1' });
  assert.ok(p.ok, p.error);
  assert.match(args(p)[1], /git\/refs\/heads\/fix%231$/);
  assert.match(p.undo, /ref=refs\/heads\/fix#1 /);
});

test('pr-create on a remote repo: from the GitHub branch, with a title, no --fill; refuses merged and PR branches', async () => {
  const p = await actions.plan(remoteResult(), { type: 'pr-create', branch: 'idea' });
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.steps[0].args, ['pr', 'create', '-R', 'octo/app', '--head', 'idea', '--base', 'main', '--title', 'idea', '--body', '']);
  const t = await actions.plan(remoteResult(), { type: 'pr-create', branch: 'idea', title: 'Try the idea' });
  assert.ok(t.steps[0].args.includes('Try the idea'));
  for (const [b, re] of [['feat', /already open/], ['old/done', /no commits that are not in main/], ['nope', /not a branch on GitHub/]]) {
    const q = await actions.plan(remoteResult(), { type: 'pr-create', branch: b });
    assert.equal(q.ok, false);
    assert.match(q.error, re);
  }
});

test('pr-close with deleteBranch: close, then delete the head branch at the PR\'s commit; never a fork\'s or a local repo\'s', async () => {
  const p = await actions.plan(remoteResult(), { type: 'pr-close', number: 7, deleteBranch: true });
  assert.ok(p.ok, p.error);
  assert.deepEqual(args(p), ['gh pr close 7 -R octo/app', 'gh api repos/octo/app/git/ref/heads/feat --jq .object.sha', 'gh api -X DELETE repos/octo/app/git/refs/heads/feat']);
  assert.match(p.undo, /gh pr reopen 7/);
  assert.match(p.undo, /ref=refs\/heads\/feat/);
  const fork = await actions.plan(remoteResult(), { type: 'pr-close', number: 8, deleteBranch: true });
  assert.equal(fork.ok, false);
  assert.match(fork.error, /will not delete it/);
  const local = { ...remoteResult(), source: undefined, path: os.tmpdir() };
  const l = await actions.plan(local, { type: 'pr-close', number: 7, deleteBranch: true });
  assert.equal(l.ok, false);
});

test('Fix all: merged branches and no-PR branches are questions; close offers deleting the branch; deletes run after closes', () => {
  const r = remoteResult();
  r.findings = [...rb.branchFindings(r.ghBranches, { remote: r.remote, prs: r.prs }), { id: 'pr-superseded-7', severity: 'info', category: 'PRs', title: 'PR #7 is superseded', detail: '', fix: { type: 'pr-close', label: 'Close…', number: 7 } }];
  const p = FixAll.plan(r);
  const by = (id) => p.decisions.find((d) => d.id === id);
  const m = by('gh-merged-branches');
  const { label, ...del } = m.choices[m.pick].action;
  assert.deepEqual(del, { type: 'delete-remote', branches: ['old/done', 'squashed'] });
  const n = by('gh-branch-no-pr-idea');
  assert.equal(n.choices[n.pick].action, null, 'starts on leave it');
  assert.deepEqual(n.choices.map((c) => c.action && c.action.type), ['pr-create', 'delete-remote', null]);
  assert.deepEqual(n.choices[0].fields.map((f) => f.name), ['title']);
  const c = by('pr-superseded-7');
  assert.ok(c.choices.some((x) => x.action && x.action.deleteBranch === true), 'close and delete its branch');
  const order = FixAll.order(r, [], [{ action: m.choices[0].action }, { action: c.choices[0].action }]).actions.map((a) => a.type);
  assert.deepEqual(order, ['pr-close', 'delete-remote']);
  const local = FixAll.plan({ ...r, source: undefined, ghBranches: undefined });
  assert.ok(!local.decisions.find((d) => d.id === 'pr-superseded-7').choices.some((x) => x.action && x.action.deleteBranch), 'not on a cloned repo');
});
