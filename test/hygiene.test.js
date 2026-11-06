const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { auditWorkflow, auditWorkflows } = require('../src/workflows');
const { collectHygiene, remoteIssue } = require('../src/hygiene');
const { checkWorkflows, checkGitHygiene, checkProject, checkSecurityFeatures } = require('../src/checks-hygiene');
const { hygieneFix } = require('../src/report-fixes');
const { rulesetCovers, refMatches } = require('../src/github');
const { depFolderAdvice } = require('../src/workspace');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-hy-'));
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const $ = (s) => '$' + '{{ ' + s + ' }}'; // keeps workflow expressions out of this file's own template literals

const RISKY = [
  'on:',
  '  pull_request_target:',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '        with:',
  `          ref: ${$('github.event.pull_request.head.sha')}`,
  `      - run: echo "${$('github.event.pull_request.title')}"`,
  '      - name: block',
  '        run: |',
  '          echo ok',
  `          git checkout ${$('github.head_ref')}`,
  '        env:',
  `          SAFE: ${$('github.event.issue.title')}`,
  '      - uses: ./local-action',
  '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7',
].join('\n');

test('workflow audit: script injection only inside run:, PR-head checkout, unpinned actions, permissions', () => {
  const r = auditWorkflow('.github/workflows/ci.yml', RISKY);
  assert.deepEqual(r.injections.map((x) => [x.line, x.expr]), [[10, 'github.event.pull_request.title'], [14, 'github.head_ref']], 'env: values are safe and not flagged');
  assert.deepEqual(r.unpinned.map((u) => u.uses), ['actions/checkout@v4'], 'local actions and SHA pins pass');
  assert.equal(r.prTarget, true);
  assert.equal(r.headCheckout, true);
  assert.equal(r.topPermissions, false);
  const safe = auditWorkflow('w.yml', 'permissions:\n  contents: read\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
  assert.deepEqual([safe.injections.length, safe.unpinned.length, safe.prTarget, safe.topPermissions], [0, 0, false, true]);
});

test('workflow findings carry the right severities, and every new finding has a sourced fix', () => {
  const dir = tmp();
  try {
    put(dir, '.github/workflows/ci.yml', RISKY);
    const w = auditWorkflows(dir);
    const s = { hygiene: { workflows: w }, remote: { isPublic: true }, files: { dependabotConfig: true, dependabotActions: false } };
    const f = Object.fromEntries(checkWorkflows(s).map((x) => [x.id, x.severity]));
    assert.deepEqual(f, { 'wf-injection': 'error', 'wf-pr-target': 'error', 'wf-permissions': 'warn', 'wf-unpinned': 'warn', 'dependabot-no-actions': 'info' });
    for (const id of Object.keys(f)) {
      const step = hygieneFix(id, { remote: { owner: 'o', name: 'r' } });
      assert.ok(step && step.why, id);
      if (id !== 'dependabot-no-actions') assert.match(step.ref, /^https:\/\//, id);
    }
  } finally { cleanup(dir); }
});

test('remote URLs: embedded credentials are an error, http a warning, normal URLs fine', () => {
  assert.equal(remoteIssue('https://user:secret@github.com/o/r.git'), 'credentials');
  assert.equal(remoteIssue('https://' + 'ghp_' + 'x'.repeat(36) + '@github.com/o/r.git'), 'credentials');
  assert.equal(remoteIssue('http://git.example.com/o/r.git'), 'http');
  assert.equal(remoteIssue('https://github.com/o/r.git'), null);
  assert.equal(remoteIssue('git@github.com:o/r.git'), null);
});

test('local git hygiene: stashes, gone upstreams, stale worktrees, project conventions', async () => {
  const dir = tmp();
  const wt = path.join(os.tmpdir(), 'gutcheck-wt-' + process.pid);
  try {
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.name', 'T'); sh(dir, 'config', 'user.email', 't@e.com');
    put(dir, 'package.json', '{"name":"x"}');
    put(dir, 'README.md', '# x\n');
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'one');
    sh(dir, 'tag', 'v1.0.0');
    put(dir, 'README.md', '# x\nchanged\n');
    sh(dir, 'stash', '-q');
    sh(dir, 'worktree', 'add', '-q', wt);
    cleanup(wt); // folder gone, git still tracks it
    const h = await collectHygiene(dir, { names: fs.readdirSync(dir), rawOrigin: '', deep: true, branch: 'main' });
    assert.equal(h.stashes, 1);
    assert.equal(h.prunableWorktrees, 1);
    assert.equal(h.tags, 1);
    assert.deepEqual(h.historyBlobs, []);
    const s = { hygiene: h, deps: { manifests: ['package.json'] }, remote: null };
    const ids = [...checkGitHygiene(s), ...checkProject(s)].map((f) => f.id);
    for (const id of ['git-stashes', 'git-worktrees', 'readme-thin', 'no-changelog', 'no-gitattributes', 'no-editorconfig', 'no-runtime-pin']) assert.ok(ids.includes(id), id);
    put(dir, '.nvmrc', '22\n'); put(dir, '.gitattributes', '* text=auto\n'); put(dir, 'CHANGELOG.md', '# Changelog\n');
    const h2 = await collectHygiene(dir, { names: fs.readdirSync(dir), rawOrigin: '', deep: false, branch: 'main' });
    const ids2 = checkProject({ hygiene: h2, deps: { manifests: ['package.json'] }, remote: null }).map((f) => f.id);
    for (const id of ['no-changelog', 'no-gitattributes', 'no-runtime-pin']) assert.ok(!ids2.includes(id), id);
  } finally { cleanup(dir); cleanup(wt); }
});

test('rulesets protect the default branch: ~ALL, ~DEFAULT_BRANCH or the exact ref, if active and not excluded', () => {
  const rs = (include, exclude = [], enforcement = 'ACTIVE', target = 'BRANCH') => ({ nodes: [{ enforcement, target, conditions: { refName: { include, exclude } } }] });
  assert.equal(rulesetCovers(rs(['~ALL']), 'main'), true);
  assert.equal(rulesetCovers(rs(['~DEFAULT_BRANCH']), 'main'), true);
  assert.equal(rulesetCovers(rs(['refs/heads/main']), 'main'), true);
  assert.equal(rulesetCovers(rs(['~ALL'], ['refs/heads/main']), 'main'), false);
  assert.equal(rulesetCovers(rs(['~ALL'], [], 'EVALUATE')), false, 'evaluate mode does not enforce');
  assert.equal(rulesetCovers(rs(['~ALL'], [], 'ACTIVE', 'TAG'), 'main'), false);
  assert.equal(rulesetCovers(null, 'main'), false);
});

test('ruleset ref patterns are fnmatch globs, so a pattern can cover the default branch', () => {
  const rs = (include, exclude = []) => ({ nodes: [{ enforcement: 'ACTIVE', target: 'BRANCH', conditions: { refName: { include, exclude } } }] });
  assert.equal(rulesetCovers(rs(['refs/heads/ma*']), 'main'), true);
  assert.equal(rulesetCovers(rs(['refs/heads/**']), 'release/1'), true);
  assert.equal(rulesetCovers(rs(['refs/heads/*']), 'release/1'), false, '* does not cross a slash');
  assert.equal(rulesetCovers(rs(['refs/heads/**'], ['refs/heads/m?in']), 'main'), false);
  assert.equal(refMatches('refs/heads/m.in', 'refs/heads/main'), false, 'dots are literal');
  assert.equal(rulesetCovers(rs(['refs/heads/*']), null), false);
});

test('workflow audit: write-all on a job counts; uses: and permissions: text inside a run script does not', () => {
  const wf = ['on: push', 'permissions:', '  contents: read', 'jobs:', '  a:', '    permissions: write-all', '    runs-on: ubuntu-latest', '    steps:', '      - run: |', '          cat <<X', '          uses: some/action@v1', '          permissions: write-all', '          X'].join('\n');
  const r = auditWorkflow('w.yml', wf);
  assert.equal(r.writeAll, true);
  assert.deepEqual(r.unpinned, []);
  const scriptOnly = auditWorkflow('w.yml', wf.replace('    permissions: write-all\n', ''));
  assert.equal(scriptOnly.writeAll, false);
});

test('security features: only flagged where GitHub offers them free, with fixes', () => {
  const sec = { secretScanning: 'disabled', pushProtection: 'disabled', securityUpdates: 'disabled', codeScanning: 'not-configured', privateReporting: false };
  const pub = checkSecurityFeatures({ security: sec, remote: { isPublic: true }, deps: { manifests: ['package.json'] }, hygiene: { workflows: null } }).map((f) => f.id);
  assert.deepEqual(pub, ['secret-scanning-off', 'push-protection-off', 'security-updates-off', 'code-scanning-off', 'private-reporting-off']);
  const priv = checkSecurityFeatures({ security: sec, remote: { isPublic: false }, deps: { manifests: ['package.json'] } }).map((f) => f.id);
  assert.deepEqual(priv, ['security-updates-off'], 'paid features are not demanded on private repos');
  assert.deepEqual(checkSecurityFeatures({ security: null, remote: { isPublic: true } }), [], 'unknown (not admin) is not "off"');
});

test('workspace: dependency folders are only reported for inactive projects', async () => {
  const dir = tmp();
  try {
    put(dir, 'old/package.json', '{}'); put(dir, 'old/node_modules/a/index.js', 'x'.repeat(5000));
    put(dir, 'new/package.json', '{}'); put(dir, 'new/node_modules/a/index.js', 'x');
    put(dir, 'orphan/node_modules/a.js', 'x'); // no package.json: not a dependency folder we recognise
    const a = await depFolderAdvice([
      { path: path.join(dir, 'old'), name: 'old', activeAt: '2020-01-01T00:00:00Z' },
      { path: path.join(dir, 'new'), name: 'new', activeAt: new Date().toISOString() },
      { path: path.join(dir, 'orphan'), name: 'orphan', activeAt: '2020-01-01T00:00:00Z' },
    ]);
    assert.equal(a.length, 1);
    assert.match(a[0].detail, /old\/node_modules/);
    assert.ok(!a[0].detail.includes('new/') && !a[0].detail.includes('orphan'));
    assert.ok(a[0].cmds.every((c) => !/\brm\b/.test(c)), 'only previews, never deletes');
  } finally { cleanup(dir); }
});
