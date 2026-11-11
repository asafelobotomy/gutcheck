// Regression tests for false alarms and noise found running GutCheck over a real workspace through
// its MCP server: committed config env files, worktrees, app data folders, broken builds, agent output.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanClutter, workspaceAdvice } = require('../src/clutter');
const { evaluate } = require('../src/checks');
const { scanRepo } = require('../src/scanner');
const { buildReport } = require('../src/report');
const { brief } = require('../src/engine');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-accws-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const init = (d) => { sh(d, 'init', '-q', '-b', 'main'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't'); return d; };
const repo = () => init(tmp());

test('a committed <name>.env that only pins versions is config, not a leaked secret', async () => {
  const d = repo();
  try {
    put(d, 'pins.env', '# release the scripts build from\nTOOL_TAG=v1.2.3\nTOOL_COMMIT=abc123\n');
    put(d, 'prod.env', 'API_TOKEN=x\n');
    put(d, 'db.env', 'URL=postgres://u:p@h/db\n');
    put(d, '.env', 'TOOL_TAG=v1\n');
    sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'x');
    const adv = (await scanClutter(d)).advice.find((a) => a.id === 'env-tracked');
    assert.ok(adv, 'env files with credentials are still reported');
    assert.ok(!adv.detail.includes('pins.env'), adv.detail);
    for (const f of ['prod.env', 'db.env', '.env']) assert.ok(adv.detail.includes(f), f);
    assert.ok(!/abc123|v1\.2\.3|u:p/.test(JSON.stringify(adv)), 'no values in the finding');
  } finally { rm(d); }
});

test('a linked worktree is not a second clone of its repo', async () => {
  const root = tmp();
  try {
    const main = path.join(root, 'app');
    fs.mkdirSync(main); init(main);
    sh(main, 'commit', '-q', '--allow-empty', '-m', 'x');
    sh(main, 'worktree', 'add', '-q', '-b', 'rel', path.join(root, 'app-wt'));
    const url = 'https://github.com/me/app.git';
    const repos = [{ name: 'app', path: main, originUrl: url }, { name: 'app-wt', path: path.join(root, 'app-wt'), originUrl: url }];
    let ids = (await workspaceAdvice(root, repos)).map((a) => a.id);
    assert.ok(!ids.includes('ws-dup-clone-github.com/me/app'), ids.join());
    const clone = path.join(root, 'app2');
    sh(root, 'clone', '-q', main, clone);
    ids = (await workspaceAdvice(root, [...repos, { name: 'app2', path: clone, originUrl: url }])).map((a) => a.id);
    assert.ok(ids.includes('ws-dup-clone-github.com/me/app'), 'a real second clone is still reported');
  } finally { rm(root); }
});

test('a linked worktree leaves the GitHub repo\'s findings to its main checkout', async () => {
  const root = tmp();
  try {
    const main = path.join(root, 'app');
    fs.mkdirSync(main); init(main);
    sh(main, 'commit', '-q', '--allow-empty', '-m', 'x');
    const wt = path.join(root, 'app-wt');
    sh(main, 'worktree', 'add', '-q', '-b', 'rel', wt);
    // No remote: 'no-remote' is a finding about the repository, so it is GitHub-scoped.
    const alone = await scanRepo(wt, {});
    assert.ok(alone.findings.some((f) => f.id === 'no-remote'), 'scanned on its own, the worktree reports it');
    const linked = await scanRepo(wt, { worktreeOf: new Map([[wt, main]]) });
    assert.ok(!linked.findings.some((f) => f.scope === 'github'), linked.findings.map((f) => f.id).join());
    assert.equal(linked.worktreeOf, main);
    assert.ok(linked.score >= alone.score, 'the worktree is not marked down twice');
  } finally { rm(root); }
});

test('clutter never looks inside a LevelDB database or a browser profile', async () => {
  const d = repo();
  try {
    put(d, '.gitignore', 'profile/\nstore/\n');
    for (const f of ['Local State', 'Default/LOG', 'Default/LOG.old', 'Default/Local Storage/leveldb/000003.log']) put(d, 'profile/' + f);
    for (const f of ['CURRENT', 'LOCK', 'MANIFEST-000001', '000005.log', 'LOG', 'LOG.old']) put(d, 'store/db/' + f);
    put(d, 'stray.log');
    const paths = (await scanClutter(d)).items.map((i) => i.path);
    assert.ok(!paths.some((p) => p.startsWith('profile/') || p.startsWith('store/')), paths.join());
    assert.ok(paths.includes('stray.log'), 'ordinary logs are still found');
  } finally { rm(d); }
});

test('a workflow that keeps failing is a broken build: no re-run button or re-run step', () => {
  const run = (streak) => ({ databaseId: 7, workflowName: 'CI', headBranch: 'main', displayTitle: 't', createdAt: new Date().toISOString(), url: 'https://github.com/o/r/actions/runs/7', streak });
  const snap = (streak) => ({
    remote: { owner: 'o', name: 'r', url: 'https://github.com/o/r', isPublic: true, description: 'x', defaultBranch: 'main', pushedAt: new Date().toISOString(), openIssues: 0, viewerPermission: 'ADMIN' },
    git: { branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, branches: [], mergedBranches: [] },
    files: { license: true, readme: true, gitignore: true, security: true, contributing: true, codeOfConduct: true, prTemplate: true },
    deps: { manifestsWithoutLock: [], needsInstall: false, outdated: null, outdatedNames: [] },
    ci: { failed: [run(streak)], error: null }, prs: [], alerts: [], hasWorkflows: true, protection: false,
  });
  const finding = (streak) => evaluate(snap(streak)).findings.find((f) => f.id === 'ci-failed-7');
  assert.equal(finding(1).fix.type, 'run-rerun', 'one failure may be flaky');
  const f = finding(4);
  assert.equal(f.fix, undefined);
  assert.match(f.detail, /failed 4 runs in a row/);
  assert.equal(f.scope, 'github');
  const md = buildReport({ repos: [{ ...snap(4), path: '/w/r', name: 'r', findings: [f] }] });
  assert.ok(!/gh run rerun 7/.test(md), 'the report does not suggest a re-run either');
});

test('agents get no GitHub API response body for a successful step, but keep failures', () => {
  assert.equal(brief({ text: 'gh api -X PATCH repos/o/r --input -', ok: true, out: '"labels_url":"…"}' }), '(GitHub API response not shown)');
  assert.equal(brief({ text: 'gh api -X PATCH repos/o/r --input -', ok: false, out: 'HTTP 403: Must have admin rights' }), 'HTTP 403: Must have admin rights');
  assert.equal(brief({ text: 'git push origin main', ok: true, out: 'To github.com:o/r\n  a..b  main -> main' }), 'To github.com:o/r\n  a..b  main -> main');
  assert.equal(brief({ text: 'git fetch', ok: true, out: '' }), undefined);
});
