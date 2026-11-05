const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../src/checks');
const { parseGithubRemote } = require('../src/scanner');

const base = () => ({
  remote: { owner: 'o', name: 'r', url: 'https://github.com/o/r', isPublic: true, description: 'x', defaultBranch: 'main', pushedAt: new Date().toISOString(), openIssues: 0 },
  git: { branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, branches: [], mergedBranches: [] },
  files: { license: true, readme: true, gitignore: true, security: true, contributing: true, codeOfConduct: true, prTemplate: true },
  deps: { manifestsWithoutLock: [], needsInstall: false, outdated: null, outdatedNames: [] },
  ci: { failed: [], error: null }, prs: [], alerts: [], hasWorkflows: true, protection: true,
});

test('clean repo scores 100', () => {
  const r = evaluate(base());
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
});

test('missing licence and failed CI are errors with fixes', () => {
  const s = base();
  s.files.license = false;
  s.ci.failed = [{ databaseId: 7, workflowName: 'CI', headBranch: 'main', displayTitle: 't', createdAt: new Date().toISOString() }];
  const r = evaluate(s);
  assert.ok(r.findings.find((f) => f.id === 'no-license' && f.fix.type === 'add-file'));
  assert.ok(r.findings.find((f) => f.id === 'ci-failed-7' && f.fix.type === 'run-rerun'));
  assert.equal(r.score, 70);
});

test('local-only repo is flagged', () => {
  const s = base();
  s.remote = null;
  assert.ok(evaluate(s).findings.find((f) => f.id === 'no-remote'));
});

test('merged branches offer a delete fix', () => {
  const s = base();
  s.git.mergedBranches = ['old'];
  assert.equal(evaluate(s).findings.find((f) => f.id === 'git-merged').fix.type, 'delete-merged');
});

test('parseGithubRemote handles ssh and https', () => {
  assert.deepEqual(parseGithubRemote('git@github.com:a/b.git'), { owner: 'a', name: 'b' });
  assert.deepEqual(parseGithubRemote('https://github.com/a/b'), { owner: 'a', name: 'b' });
  assert.equal(parseGithubRemote('https://gitlab.com/a/b'), null);
});

test('parseGithubRemote rejects unexpected characters', () => {
  assert.equal(parseGithubRemote('https://github.com/a/b;rm -rf'), null);
  assert.equal(parseGithubRemote('https://github.com/a/b$(x)'), null);
});

const { checkPRs, checkDeps, checkFiles, checkRepoSettings } = require('../src/checks');
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();

test('PR checks: conflicts, failing checks, stale, and ready-to-merge with a fix', () => {
  const ids = checkPRs({ prs: [
    { number: 1, title: 'a', mergeable: 'CONFLICTING', statusCheckRollup: 'SUCCESS', updatedAt: iso(1) },
    { number: 2, title: 'b', mergeable: 'MERGEABLE', statusCheckRollup: 'FAILURE', updatedAt: iso(1) },
    { number: 3, title: 'c', mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', updatedAt: iso(45) },
    { number: 4, title: 'd', mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', reviewDecision: 'APPROVED', updatedAt: iso(1) },
    { number: 5, title: 'e', isDraft: true, mergeable: 'MERGEABLE', updatedAt: iso(90) },
  ] });
  assert.deepEqual(ids.map((f) => f.id).sort(), ['pr-ci-2', 'pr-conflict-1', 'pr-ready-4', 'pr-stale-3']);
  assert.equal(ids.find((f) => f.id === 'pr-ready-4').fix.type, 'pr-merge');
});

test('dependency checks: lockfiles, install, outdated, alerts', () => {
  const out = checkDeps({ deps: { manifests: ['package.json'], manifestsWithoutLock: ['package.json'], needsInstall: true, outdated: 2, outdatedNames: ['a', 'b'] }, files: { dependabotConfig: false }, remote: { alertsEnabled: false, url: 'u' }, alerts: [{ severity: 'high' }] });
  assert.deepEqual(out.map((f) => f.id).sort(), ['alerts-off', 'dependabot', 'deps-not-installed', 'deps-outdated', 'no-dependabot-config', 'no-lock-package.json']);
  assert.equal(out.find((f) => f.id === 'dependabot').severity, 'error');
});

test('public repos get community-file nudges, private ones do not', () => {
  const base = { files: { license: true, readme: true, gitignore: true }, remote: { isPublic: true, description: 'x' } };
  assert.ok(checkFiles(base).some((f) => f.id === 'no-security'));
  assert.ok(!checkFiles({ ...base, remote: { isPublic: false, description: 'x' } }).some((f) => f.id === 'no-security'));
});

test('repo settings: unprotected default branch and long inactivity', () => {
  const ids = checkRepoSettings({ remote: { archived: false, defaultBranch: 'main', pushedAt: iso(400), openIssues: 30 }, protection: false }).map((f) => f.id);
  assert.deepEqual(ids.sort(), ['inactive', 'many-issues', 'no-protection']);
});

test('cmpVersion tells behind from ahead (npm lists a package ahead of a retracted latest)', () => {
  const { cmpVersion } = require('../src/util');
  assert.equal(cmpVersion('26.18.1', '26.18.0'), 1);
  assert.equal(cmpVersion('1.2.3', '1.10.0'), -1);
  assert.equal(cmpVersion('v2.0.0-beta.1', '2.0.0'), 0);
  assert.equal(cmpVersion('1.0', '1.0.0'), 0);
});
