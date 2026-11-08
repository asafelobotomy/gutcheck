// Fix-all hardening: plans stay valid through a long batch, merges wait for passing checks, removals and
// rewrites in a repo are exact, and the "Copy for LLM" order matches Fix all's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { apply } = require('../src/apply');
const { createService } = require('../src/service');
const { scanRepo } = require('../src/scanner');
const { checkPRs } = require('../src/checks');
const { buildReport } = require('../src/report');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
function gitRepo() {
  const d = tmp('gutcheck-hard-');
  const sh = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  return { d, sh };
}

test('a plan fresh when the batch started stays valid however long the batch takes', async (t) => {
  const { d, sh } = gitRepo();
  try {
    sh('commit', '-q', '--allow-empty', '-m', 'init');
    const known = new Map([[d, await scanRepo(d)]]);
    const svc = createService({ known, settings: () => ({}), audit() {}, rescan: async () => known.get(d) });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const [a, b] = await svc.planActions([{ dir: d, action: { type: 'worktree-prune' } }, { dir: d, action: { type: 'worktree-prune' } }]);
    const startedAt = Date.now();
    t.mock.timers.tick(6 * 60 * 1000); // an install or a test run took six minutes
    assert.equal((await svc.applyActions([a.token], { startedAt }))[0].ok, true);
    assert.match((await svc.applyActions([b.token]))[0].error, /expired/, 'without a batch start the TTL still applies');
  } finally { rm(d); }
});

test('an approved PR is offered for merging only once its checks have passed', () => {
  const base = { title: 't', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', updatedAt: new Date().toISOString() };
  const ids = checkPRs({ prs: [{ ...base, number: 1, statusCheckRollup: 'PENDING' }, { ...base, number: 2, statusCheckRollup: 'SUCCESS' }, { ...base, number: 3, statusCheckRollup: 'NONE' }] }).map((f) => f.id);
  assert.deepEqual(ids.filter((x) => x.startsWith('pr-ready')).sort(), ['pr-ready-2', 'pr-ready-3']);
});

test('clutter removal reads a name literally: a pattern-like name is neither matched by nor mistaken for another file', async () => {
  const { d, sh } = gitRepo();
  const remove = (rel) => apply({ steps: [{ kind: 'remove', root: d, path: path.join(d, rel), rel, mode: 'delete', display: 'remove' }] });
  try {
    fs.writeFileSync(path.join(d, 'cache[1].tmp'), 'x');
    fs.writeFileSync(path.join(d, 'axb.tmp'), 'x');
    sh('add', '-A'); sh('commit', '-qm', 'tracked');
    const tracked = await remove('cache[1].tmp');
    assert.match(tracked.results[0].out, /Tracked by git/);
    assert.ok(fs.existsSync(path.join(d, 'cache[1].tmp')));
    fs.writeFileSync(path.join(d, 'a*b.tmp'), 'x'); // untracked; the glob a*b.tmp would match the tracked axb.tmp
    assert.equal((await remove('a*b.tmp')).ok, true);
    assert.ok(!fs.existsSync(path.join(d, 'a*b.tmp')) && fs.existsSync(path.join(d, 'axb.tmp')));
  } finally { rm(d); }
});

test('a rewrite keeps the file\'s permissions and leaves no temp file behind', async () => {
  const d = tmp('gutcheck-repl-');
  try {
    const f = path.join(d, 'run.sh');
    fs.writeFileSync(f, 'old\n'); fs.chmodSync(f, 0o755);
    const expect = require('node:crypto').createHash('sha256').update('old\n').digest('hex');
    const r = await apply({ steps: [{ kind: 'replace', root: d, path: f, expect, content: 'new\n', display: 'rewrite' }] });
    assert.equal(r.ok, true, JSON.stringify(r.results));
    assert.equal(fs.readFileSync(f, 'utf8'), 'new\n');
    assert.equal(fs.statSync(f).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(d), ['run.sh']);
  } finally { rm(d); }
});

test('Copy for LLM: pull before commit, a final push, and each failed run is its own step', () => {
  const F = (id, severity, title) => ({ id, severity, title, category: 'Git', detail: '' });
  const r = { name: 'app', path: '/w/app', score: 50, grade: 'C', remote: { owner: 'o', name: 'app', defaultBranch: 'main' }, git: { branch: 'main', upstream: 'origin/main', dirty: 1, behind: 1 },
    ci: { failed: [{ databaseId: 11, workflowName: 'CI', headBranch: 'main' }, { databaseId: 12, workflowName: 'CI', headBranch: 'main' }] }, prs: [], alerts: [], files: {},
    findings: [F('git-dirty', 'warn', '1 uncommitted change'), F('git-behind', 'warn', 'Behind upstream'), F('ci-failed-11', 'error', 'Failed: CI'), F('ci-failed-12', 'error', 'Failed: CI')] };
  const text = buildReport({ repos: [r] });
  assert.ok(text.indexOf('git pull --ff-only') < text.indexOf('git commit -m'), 'pull first, as Fix all does');
  assert.ok(text.includes('gh run view 11') && text.includes('gh run view 12'), 'two runs of one workflow are two steps');
  assert.ok(text.lastIndexOf('git push') > text.indexOf('git commit -m'), 'the commits are pushed at the end');
  assert.match(text, /Push the commits/);
});
