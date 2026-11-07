// Regression tests for false alarms found by checking every GutCheck finding against reality
// (the real state of ~/Projects and GitHub), one test per wrong or unhelpful report.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluate } = require('../src/checks');
const { checkSecurityFeatures } = require('../src/checks-hygiene');
const { scanClutter } = require('../src/clutter');
const { scanQuality } = require('../src/quality');
const { reviewTests } = require('../src/tests/review');
const { runnable } = require('../src/tests/runs');
const { buildTestAdvice } = require('../src/tests');
const { buildReport } = require('../src/report');
const { collectHygiene } = require('../src/hygiene');
const { scanRepo } = require('../src/scanner');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-acc-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const repo = () => { const d = tmp(); sh(d, 'init', '-q', '-b', 'main'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't'); return d; };
const base = (o = {}) => ({
  remote: { owner: 'o', name: 'r', url: 'https://github.com/o/r', isPublic: true, description: 'x', defaultBranch: 'main', pushedAt: new Date().toISOString(), openIssues: 0, viewerPermission: 'ADMIN', ...(o.remote || {}) },
  git: { branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, branches: [], mergedBranches: [] },
  files: { license: true, readme: true, gitignore: true, security: true, contributing: true, codeOfConduct: true, prTemplate: true },
  deps: { manifestsWithoutLock: [], needsInstall: false, outdated: null, outdatedNames: [] },
  ci: { failed: [], error: null }, prs: [], alerts: [], hasWorkflows: true, protection: false, ...o, remote: { owner: 'o', name: 'r', url: 'https://github.com/o/r', isPublic: true, description: 'x', defaultBranch: 'main', pushedAt: new Date().toISOString(), openIssues: 0, viewerPermission: 'ADMIN', ...(o.remote || {}) },
});

test('a private repo on a plan without branch protection is not told to protect its branch', () => {
  const ids = (s) => evaluate(s).findings.map((f) => f.id);
  assert.ok(ids(base({ remote: { isPublic: false } })).includes('no-protection'));
  assert.ok(!ids(base({ remote: { isPublic: false, protectionUnavailable: true } })).includes('no-protection'));
  assert.ok(ids(base()).includes('no-protection'), 'public repos can always be protected');
});

test("GitHub's Dependabot Updates run failing is a warning, a broken build is an error", () => {
  const run = (workflowName) => ({ databaseId: 1, workflowName, headBranch: 'main', displayTitle: 't', createdAt: new Date().toISOString() });
  const sev = (w) => evaluate(base({ ci: { failed: [run(w)], error: null }, protection: true })).findings.find((f) => f.id === 'ci-failed-1').severity;
  assert.equal(sev('Dependabot Updates'), 'warn');
  assert.equal(sev('Build Android'), 'error');
});

test('code scanning is only suggested where CodeQL has something to analyse', () => {
  const sec = { secretScanning: 'enabled', pushProtection: 'enabled', securityUpdates: 'enabled', codeScanning: 'not-configured', privateReporting: true };
  const ids = (languages, hasWorkflows) => checkSecurityFeatures({ security: sec, remote: { isPublic: true, languages }, hasWorkflows, deps: { manifests: [] }, hygiene: { workflows: null } }).map((f) => f.id);
  assert.ok(!ids(['Shell'], false).includes('code-scanning-off'), 'shell scripts only: CodeQL has nothing to scan');
  assert.ok(!ids(['HTML', 'CSS'], false).includes('code-scanning-off'));
  assert.ok(ids(['Shell', 'Python'], false).includes('code-scanning-off'));
  assert.ok(ids(['Shell'], true).includes('code-scanning-off'), 'workflow files are analysed too');
  assert.ok(ids([], false).includes('code-scanning-off'), 'unknown languages: keep the suggestion');
});

test('git: a branch held by another worktree is not offered for deletion; "upstream gone" needs a fetched remote', async () => {
  const d = repo();
  const wt = path.join(tmp(), 'wt');
  try {
    put(d, 'a.txt'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'one');
    sh(d, 'branch', 'merged-free'); sh(d, 'worktree', 'add', '-q', '-b', 'in-worktree', wt);
    const r = await scanRepo(d, { deep: false });
    assert.deepEqual(r.git.worktreeBranches, ['in-worktree']);
    assert.deepEqual(r.git.mergedBranches.sort(), ['merged-free'], 'in-worktree is merged too, but git would refuse to delete it');
    // An upstream configured for a remote that was never fetched is not "gone".
    sh(d, 'config', 'branch.main.remote', 'origin'); sh(d, 'config', 'branch.main.merge', 'refs/heads/main');
    sh(d, 'remote', 'add', 'origin', 'ssh://example.invalid/x.git');
    const h = await collectHygiene(d, { names: [], rawOrigin: 'ssh://example.invalid/x.git', deep: false, branch: 'main' });
    assert.equal(h.currentGone, false);
    assert.deepEqual(h.goneBranches, []);
    // After a fetch has created remote-tracking refs, a deleted upstream is real.
    sh(d, 'update-ref', 'refs/remotes/origin/other', 'HEAD');
    const h2 = await collectHygiene(d, { names: [], rawOrigin: 'ssh://example.invalid/x.git', deep: false, branch: 'main' });
    assert.equal(h2.currentGone, true);
  } finally { rm(d); rm(path.dirname(wt)); }
});

test('env: a template in a subfolder counts; a repo with live env files and no template anywhere is still told', async () => {
  const d = repo();
  try {
    put(d, 'deploy/gateway.env', 'A=1'); put(d, 'deploy/gateway.env.example', 'A=');
    put(d, '.gitignore', '*.env\n');
    assert.ok(!(await scanClutter(d)).advice.some((a) => a.id === 'env-no-template'));
    fs.rmSync(path.join(d, 'deploy', 'gateway.env.example'));
    assert.ok((await scanClutter(d)).advice.some((a) => a.id === 'env-no-template'));
  } finally { rm(d); }
});

test('file length: stylesheets and third-party addons are not flagged', async () => {
  const d = repo();
  try {
    put(d, 'gui/app.css', Array.from({ length: 500 }, (_, i) => `.a${i} { color: red; }`).join('\n'));
    put(d, 'addons/dialogue/Big.cs', Array.from({ length: 500 }, () => 'int x;').join('\n'));
    put(d, 'src/real.js', Array.from({ length: 500 }, () => 'let x;').join('\n'));
    const q = await scanQuality(d);
    assert.deepEqual(q.loc.over.map((f) => f.path), ['src/real.js']);
  } finally { rm(d); }
});

test('tests: a guard that throws, or a test that captures output, is not assertion-free; tools missing and Stryker absent are reported', async () => {
  const d = repo();
  try {
    put(d, 'package.json', JSON.stringify({ scripts: { test: 'vitest' }, devDependencies: { vitest: '1' } }));
    put(d, 'web/guard.test.ts', "it('guards', () => { if (!ok) throw new Error('unmocked fetch') });\n");
    put(d, 'e2e/audit.spec.ts', "test('capture', async ({ page }) => { await page.screenshot({ path: 'a.png' }) });\n");
    put(d, 'web/empty.test.ts', "it('nothing', () => { run() });\n");
    assert.deepEqual((await reviewTests(d)).noAssert.map((x) => x.path), ['web/empty.test.ts']);
  } finally { rm(d); }
  const r = runnable([{ id: 'node', root: '.', name: 'Node' }, { id: 'node', root: 'x', name: 'Node', stryker: true }, { id: 'rust', root: '.', name: 'Rust' }]);
  assert.deepEqual(r.map((x) => x.mutation), [false, true, true], 'Node mutation testing needs Stryker in the project');
  const old = process.env.PATH; process.env.PATH = '/nonexistent';
  try {
    const m = runnable([{ id: 'rust', root: '.', name: 'Rust' }])[0].missing;
    assert.deepEqual(m.map((x) => x.bin), ['cargo-llvm-cov', 'cargo-mutants']);
    const t = { testCases: 5, testFiles: 1, sourceFiles: 6, sourceLines: 500, testLines: 100, stacks: [{ id: 'rust', name: 'Rust' }], byLangFor: () => 5, focused: [], skipped: [], noAssert: [], sleeps: [], network: [], untested: [], untestedCount: 0, ruff: null, ci: { workflows: true, runs: { rust: true } }, runnable: runnable([{ id: 'rust', root: '.', name: 'Rust' }]), results: { coverage: null, junit: null, mutation: null } };
    assert.match(buildTestAdvice(t).find((a) => a.id === 't-coverage-none').detail, /Needs cargo-llvm-cov \(not installed\): cargo install cargo-llvm-cov/);
  } finally { process.env.PATH = old; }
});

test('the report drops the code-quality "no tests" step when the tests review covers it', () => {
  const r = { name: 'r', path: '/w/r', score: 90, grade: 'A', git: {}, findings: [] };
  const q = { error: null, files: 6, lines: 100, loc: { max: 400, mode: 'total', over: [] }, secrets: [], magic: { total: 0, files: [], reuse: [], repeated: [] }, debug: [], markers: { items: [] }, advice: [{ id: 'q-no-tests', category: 'Code quality', severity: 'info', title: 'No test files found', detail: 'x' }] };
  const tt = { testCases: 0, testFiles: 0, inlineTests: 0, stacks: [], results: {}, untested: [], advice: [{ id: 't-none', category: 'Tests', severity: 'warn', title: 'No tests', detail: 'y' }] };
  const text = buildReport({ repos: [r], quality: new Map([['/w/r', q]]), tests: new Map([['/w/r', tt]]) });
  assert.match(text, /No tests/);
  assert.doesNotMatch(text, /No test files found/);
  assert.match(buildReport({ repos: [r], quality: new Map([['/w/r', q]]) }), /No test files found/, 'still shown when the tests review did not run');
});

test('Dependabot alerts: the real total, severity breakdown and the packages to fix first', () => {
  const alerts = [
    ...Array.from({ length: 3 }, () => ({ severity: 'high', pkg: 'openssl', manifest: 'Cargo.lock', ecosystem: 'rust', patched: '0.10.72' })),
    { severity: 'moderate', pkg: 'axios', manifest: 'package-lock.json', ecosystem: 'npm', patched: '1.7.0' },
  ];
  const f = evaluate(base({ alerts, alertsTotal: 95 })).findings.find((x) => x.id === 'dependabot');
  assert.equal(f.title, '95 open Dependabot alerts', 'the GitHub total, not the 25 nodes that came back');
  assert.equal(f.severity, 'error');
  assert.match(f.detail, /3 high, 1 moderate \(severity counted for 4 of them\)\. Most alerts: openssl \(Cargo\.lock\) x3, axios \(package-lock\.json\)/);
  const low = evaluate(base({ alerts: [{ severity: 'low', pkg: 'x' }], alertsTotal: 1 })).findings.find((x) => x.id === 'dependabot');
  assert.equal(low.severity, 'warn');
  const text = buildReport({ repos: [{ name: 'r', path: '/w/r', score: 50, grade: 'C', git: {}, remote: { url: 'https://github.com/o/r' }, deps: { manifests: ['Cargo.toml'] }, alerts, findings: [f] }] });
  assert.match(text, /cargo update -p <crate>/);
  assert.match(text, /Fixed versions, worst first: openssl -> 0\.10\.72 \(high, Cargo\.lock\); axios -> 1\.7\.0 \(moderate, package-lock\.json\)/);
  assert.match(text, /npm audit/, 'an npm alert gets npm advice too');
  const rust = buildReport({ repos: [{ name: 'r', path: '/w/r', score: 50, grade: 'C', git: {}, remote: { url: 'https://github.com/o/r' }, deps: { manifests: ['Cargo.toml'] }, alerts: alerts.slice(0, 3), alertsTotal: 3, findings: [f] }] });
  assert.doesNotMatch(rust, /npm audit/, 'no npm advice for a Rust-only repo');
  assert.match(rust, /Dependabot alerts: 3/);
});

test('unpinned actions: the report gives the exact command to resolve each action\'s SHA', () => {
  const { hygieneFix } = require('../src/report-fixes');
  const step = hygieneFix('wf-unpinned', { hygiene: { workflows: { unpinned: [{ uses: 'actions/checkout@v4' }, { uses: 'actions/checkout@v4' }, { uses: 'github/codeql-action/analyze@v3' }, { uses: 'dtolnay/rust-toolchain@stable' }] } }, remote: null });
  assert.deepEqual(step.cmds, [
    'gh api repos/actions/checkout/commits/v4 --jq .sha   # actions/checkout@v4',
    'gh api repos/github/codeql-action/commits/v3 --jq .sha   # github/codeql-action/analyze@v3',
    'gh api repos/dtolnay/rust-toolchain/commits/stable --jq .sha   # dtolnay/rust-toolchain@stable',
  ]);
});

test('magic numbers: named declarations of any case, unit factors, and round-number coincidences', () => {
  const R = require('../src/quality/rules');
  const vals = (l) => R.magicNumbers(l).map((m) => m.value);
  assert.deepEqual(vals('const MiB = 1024;'), [], 'a declaration names its value, whatever the case');
  assert.deepEqual(vals('const BIG_FILE = 5 * 1024 * 1024;'), []);
  assert.deepEqual(vals('const kb = bytes / 1024'), [], 'a unit conversion');
  assert.deepEqual(vals('setTimeout(retry, 30 * 1000)'), [30], 'the unit is fine, the 30 still needs a name');
  assert.deepEqual(vals('const x = compute(37)'), [37]);
});

test('reports: Dependabot conflicts ask Dependabot to rebase; protection keeps direct pushes', () => {
  const { PROTECTION } = require('../src/protection');
  assert.equal(PROTECTION.minimal.body.required_pull_request_reviews, null);
  assert.deepEqual([PROTECTION.minimal.body.allow_force_pushes, PROTECTION.minimal.body.allow_deletions, PROTECTION.minimal.body.enforce_admins], [false, false, true]);
  const r = { name: 'r', path: '/w/r', score: 80, grade: 'B', git: {}, remote: { owner: 'o', name: 'r', url: 'https://github.com/o/r', defaultBranch: 'main' }, prs: [{ number: 1, title: 'Bump x', headRefName: 'dependabot/npm_and_yarn/x', mergeable: 'CONFLICTING' }],
    findings: [{ id: 'pr-conflict-1', category: 'PRs', severity: 'error', title: 'PR #1 has merge conflicts', detail: '' }, { id: 'no-protection', category: 'Repo', severity: 'warn', title: 'Default branch main is unprotected', detail: '' }] };
  const text = buildReport({ repos: [r] });
  assert.match(text, /gh pr comment 1 -R o\/r --body '@dependabot rebase'/);
  assert.doesNotMatch(text, /gh pr checkout 1/);
  assert.match(text, /"required_pull_request_reviews":null/);
  const human = { ...r, prs: [{ ...r.prs[0], headRefName: 'feature/x' }] };
  assert.match(buildReport({ repos: [human] }), /gh pr checkout 1/);
});
