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

test('community files: defaults from the owner\'s .github repo count; licence severity follows visibility', () => {
  const files = { license: false, readme: true, gitignore: true, prTemplate: true };
  const withDefaults = checkFiles({ files, remote: { isPublic: true, description: 'x', securityPolicy: true, contributing: true, codeOfConduct: true } }).map((f) => f.id);
  assert.deepEqual(withDefaults, ['no-license'], 'GitHub-provided defaults are not reported missing');
  const sev = (remote) => checkFiles({ files, remote }).find((f) => f.id === 'no-license').severity;
  assert.equal(sev({ isPublic: true, description: 'x', securityPolicy: true, contributing: true, codeOfConduct: true }), 'error');
  assert.equal(sev({ isPublic: false, description: 'x' }), 'info');
  assert.equal(sev(null), 'info');
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

test('a detached HEAD has no branch name, so no "no upstream" finding or push command', () => {
  const { evaluate } = require('../src/checks');
  const s = { git: { branch: null, detached: true, upstream: null, ahead: 0, behind: 0, dirty: 0, branches: [], remoteBranches: [], mergedBranches: [] }, remote: { owner: 'o', name: 'n' }, files: {}, deps: { manifestsWithoutLock: [] }, prs: [], ci: { failed: [] }, alerts: [] };
  const ids = evaluate(s).findings.map((f) => f.id);
  assert.ok(ids.includes('git-detached'));
  assert.ok(!ids.includes('git-no-upstream'));
});

const snapOf = (o = {}) => ({ git: { branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, branches: [], remoteBranches: [], mergedBranches: [] }, remote: { owner: 'o', name: 'n', isPublic: false, description: 'd' }, files: { license: true, readme: true, gitignore: true }, deps: { manifests: [], manifestsWithoutLock: [] }, prs: [], ci: { failed: [] }, alerts: [], hasWorkflows: true, ...o });

test('uncommitted changes on a detached HEAD say so and offer no commit that would fail', () => {
  const { evaluate } = require('../src/checks');
  const f = evaluate(snapOf({ git: { ...snapOf().git, branch: null, detached: true, upstream: null, dirty: 2 } })).findings.find((x) => x.id === 'git-dirty');
  assert.doesNotMatch(f.detail, /null/);
  assert.equal(f.fix, undefined);
  assert.equal(evaluate(snapOf({ git: { ...snapOf().git, dirty: 1 } })).findings.find((x) => x.id === 'git-dirty').fix.type, 'commit-all');
});

test('a repo with no commits gets no "push and set upstream" button', () => {
  const { evaluate } = require('../src/checks');
  const g = { ...snapOf().git, upstream: null };
  assert.ok(evaluate(snapOf({ git: g })).findings.some((f) => f.id === 'git-no-upstream'));
  assert.ok(!evaluate(snapOf({ git: g, hygiene: { noCommits: true, storage: {}, goneBranches: [] } })).findings.some((f) => f.id === 'git-no-upstream'));
});

test('the Node CI template is only offered where npm ci can run; the issue count is called issues', () => {
  const { evaluate, checkRepoSettings } = require('../src/checks');
  const ciNone = (deps) => evaluate(snapOf({ hasWorkflows: false, deps: { manifests: ['package.json'], manifestsWithoutLock: [], ...deps } })).findings.find((f) => f.id === 'ci-none');
  assert.equal(ciNone({ npmLock: true }).fix.template, 'ci-node');
  assert.equal(ciNone({ npmLock: false }).fix, undefined, 'yarn/pnpm or no lockfile: npm ci would fail');
  assert.equal(checkRepoSettings(snapOf({ remote: { ...snapOf().remote, openIssues: 40 } })).find((f) => f.id === 'many-issues').title, '40 open issues');
});

test('a remote on another host is info, not "not backed up"; an AUR package repo skips project-file checks', () => {
  const s = base();
  s.remote = null;
  s.originUrl = 'ssh://aur@aur.archlinux.org/pkg.git';
  const f = evaluate(s).findings.find((x) => x.id === 'no-remote');
  assert.equal(f.severity, 'info');
  assert.match(f.detail, /origin is aur\.archlinux\.org/);
  assert.ok(!f.detail.includes('aur@'), 'no user or path from the URL');
  const aur = base();
  aur.files = { aurPackage: true };
  assert.ok(!evaluate(aur).findings.some((x) => ['no-readme', 'no-license', 'no-gitignore'].includes(x.id)));
});

test('the current branch losing its upstream is a warning', () => {
  const s = base();
  s.hygiene = { currentGone: true, goneBranches: [], storage: {}, project: null };
  const f = evaluate(s).findings.find((x) => x.id === 'git-upstream-gone');
  assert.equal(f.severity, 'warn');
  assert.match(f.title, /main/);
});
