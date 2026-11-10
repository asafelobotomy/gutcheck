const test = require('node:test');
const assert = require('node:assert');
const { tagProtection, checkRepoRules, workflowsDeclarePermissions } = require('../src/repo-rules');
const { plan } = require('../src/actions');
const { buildReport } = require('../src/report');

const rs = (types, o = {}) => ({ name: 'r', include: ['refs/tags/v*'], exclude: [], types, ...o });
const remote = { owner: 'o', name: 'demo', isPublic: true, viewerPermission: 'ADMIN', archived: false, defaultBranch: 'main', latestRelease: null };
const snap = (o = {}) => ({
  remote, release: { latest: 'v1.2.0', vTag: 'v1.2.0', vTags: 3 },
  hasWorkflows: true, tagRulesets: [], actionsSettings: null, hygiene: { workflows: null }, ...o,
});
const ids = (s) => checkRepoRules(s).map((f) => f.id);

test('tagProtection needs deletion and non_fast_forward on a ruleset that covers the tag', () => {
  assert.equal(tagProtection([], 'v1.0.0').state, 'none');
  assert.equal(tagProtection([rs(['deletion', 'non_fast_forward', 'update'])], 'v1.0.0').state, 'covered');
  assert.equal(tagProtection([rs(['deletion'])], 'v1.0.0').state, 'partial');
  assert.deepEqual(tagProtection([rs(['deletion'])], 'v1.0.0').missing, ['non_fast_forward']);
  assert.equal(tagProtection([rs(['deletion', 'non_fast_forward'], { include: ['refs/tags/release-*'] })], 'v1.0.0').state, 'none', 'pattern does not cover the tag');
  assert.equal(tagProtection([rs(['deletion', 'non_fast_forward'], { include: ['~ALL'] })], 'v1.0.0').state, 'covered');
  assert.equal(tagProtection([rs(['deletion', 'non_fast_forward'], { exclude: ['refs/tags/v1.*'] })], 'v1.0.0').state, 'none');
  assert.equal(tagProtection([rs(['deletion']), rs(['non_fast_forward'])], 'v1.0.0').state, 'covered', 'rulesets stack');
});

test('tag protection finding: only for repos with release tags, only when readable', () => {
  assert.deepEqual(ids(snap()), ['tag-protection']);
  assert.deepEqual(ids(snap({ tagRulesets: null })), [], 'unreadable is not "unprotected"');
  assert.deepEqual(ids(snap({ tagRulesets: [rs(['deletion', 'non_fast_forward'])] })), []);
  assert.deepEqual(ids(snap({ release: { latest: null, vTags: 0 } })), [], 'no release tags');
  assert.deepEqual(ids(snap({ remote: { ...remote, archived: true } })), []);
  assert.deepEqual(ids(snap({ remote: { ...remote, viewerPermission: 'WRITE' } })), []);
  const f = checkRepoRules(snap())[0];
  assert.equal(f.severity, 'warn');
  assert.equal(f.fix.type, 'protect-tags');
});

const wf = (o = {}) => ({ files: 1, unpinned: [], noPermissions: [], injections: [], prTarget: [], writeAll: [], selfHosted: [], codeql: false, ...o });
test('repo-level Actions settings findings', () => {
  const a = (o, extra = {}) => snap({ release: null, tagRulesets: null, actionsSettings: { enabled: true, shaPinningRequired: false, defaultPermissions: 'read', canApprovePrs: false, ...o }, hygiene: { workflows: wf() }, ...extra });
  assert.deepEqual(ids(a({})), ['actions-sha-pinning-available'], 'all pinned: can require it');
  assert.deepEqual(ids(a({ shaPinningRequired: true })), []);
  assert.deepEqual(ids(a({ enabled: false, defaultPermissions: 'write', canApprovePrs: true })), [], 'Actions disabled');
  const w = checkRepoRules(a({ defaultPermissions: 'write', canApprovePrs: true }));
  assert.deepEqual(w.map((f) => f.id).sort(), ['actions-approve-prs', 'actions-sha-pinning-available', 'actions-token-write']);
  assert.equal(w.find((f) => f.id === 'actions-token-write').fix.setting, 'read-token');
  const risky = checkRepoRules(a({ defaultPermissions: 'write' }, { hygiene: { workflows: wf({ noPermissions: [{ file: 'a.yml', jobLevel: false }] }) } }));
  assert.equal(risky.find((f) => f.id === 'actions-token-write').fix, undefined, 'no fix while a workflow has no permissions block');
  assert.ok(!ids(a({}, { hygiene: { workflows: wf({ unpinned: [{ uses: 'x/y@v1' }] }) } })).includes('actions-sha-pinning-available'), 'unpinned actions: never suggest requiring pinning');
  assert.ok(!ids(a({}, { hygiene: { workflows: null } })).includes('actions-sha-pinning-available'));
  assert.ok(!ids(a({ defaultPermissions: 'write' }, { remote: { ...remote, archived: true } })).length);
  assert.equal(workflowsDeclarePermissions(wf({ noPermissions: [{ file: 'a', jobLevel: true }] })), true);
});

const rem = (o = {}) => ({ owner: 'o', name: 'demo', viewerPermission: 'ADMIN', archived: false, ...o });
const ghRepo = (o = {}) => ({ path: '/tmp/x', remote: rem(), tagRulesets: [], release: { latest: 'v1.0.0', vTags: 1 }, actionsSettings: { enabled: true, defaultPermissions: 'write', canApprovePrs: true }, ...o });

test('protect-tags plans an additive tag ruleset with admin bypass', async () => {
  const p = await plan(ghRepo(), { type: 'protect-tags' });
  assert.ok(p.ok, p.error);
  assert.equal(p.risk, 'caution');
  assert.deepEqual(p.steps[0].args.slice(0, 4), ['api', '-X', 'POST', 'repos/o/demo/rulesets']);
  const b = JSON.parse(p.steps[0].input);
  assert.equal(b.target, 'tag');
  assert.equal(b.enforcement, 'active');
  assert.deepEqual(b.conditions.ref_name.include, ['refs/tags/v*']);
  assert.deepEqual(b.rules.map((x) => x.type).sort(), ['deletion', 'non_fast_forward', 'update']);
  assert.deepEqual(b.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
  assert.ok(p.warnings.some((w) => /v1/.test(w)), 'warns about moving tags such as v1');
  assert.equal((await plan(ghRepo({ remote: rem({ viewerPermission: 'WRITE' }) }), { type: 'protect-tags' })).ok, false);
  assert.equal((await plan(ghRepo({ remote: rem({ archived: true }) }), { type: 'protect-tags' })).ok, false);
  assert.match((await plan(ghRepo({ tagRulesets: [rs(['deletion', 'non_fast_forward'])] }), { type: 'protect-tags' })).error, /already/);
});

test('actions-settings plans previewed PUTs', async () => {
  const t = await plan(ghRepo(), { type: 'actions-settings', setting: 'read-token' });
  assert.ok(t.ok, t.error);
  assert.deepEqual(t.steps[0].args.slice(0, 4), ['api', '-X', 'PUT', 'repos/o/demo/actions/permissions/workflow']);
  assert.deepEqual(JSON.parse(t.steps[0].input), { default_workflow_permissions: 'read' });
  assert.equal(t.risk, 'caution');
  assert.ok(t.warnings.some((w) => /permissions:/.test(w)));
  const a = await plan(ghRepo(), { type: 'actions-settings', setting: 'no-approve' });
  assert.deepEqual(JSON.parse(a.steps[0].input), { can_approve_pull_request_reviews: false });
  assert.equal((await plan(ghRepo(), { type: 'actions-settings', setting: 'x' })).ok, false);
  assert.equal((await plan(ghRepo({ actionsSettings: { enabled: true, defaultPermissions: 'read', canApprovePrs: false } }), { type: 'actions-settings', setting: 'read-token' })).ok, false, 'already read-only');
  assert.equal((await plan(ghRepo({ remote: rem({ viewerPermission: 'READ' }) }), { type: 'actions-settings', setting: 'read-token' })).ok, false);
});

test('Copy for LLM has steps for the new findings', () => {
  const base = { path: '/x', name: 'demo', git: { branch: 'main', branches: [], mergedBranches: [], dirty: 0, ahead: 0, behind: 0 }, files: { license: true, readme: true, gitignore: true }, deps: { manifests: [], manifestsWithoutLock: [], needsInstall: false, outdated: null, outdatedNames: [] }, prs: [], ci: { failed: [], error: null }, alerts: [], protection: true };
  const s = { ...base, ...snap({ actionsSettings: { enabled: true, shaPinningRequired: false, defaultPermissions: 'write', canApprovePrs: true }, hygiene: { workflows: wf(), storage: { packKiB: 0, loose: 0, garbage: 0 }, tags: 3, goneBranches: [], stashes: 0 } }) };
  const md = buildReport({ repos: [{ ...s, findings: checkRepoRules(s), score: 90, grade: 'A' }] });
  assert.match(md, /rulesets/);
  assert.match(md, /actions\/permissions\/workflow/);
  assert.match(md, /sha_pinning_required/);
});
