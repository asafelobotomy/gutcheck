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
