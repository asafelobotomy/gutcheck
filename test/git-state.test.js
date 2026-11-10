// Unfinished git operations, detached HEAD, maintenance health and commit identity: collection,
// findings, actions and report steps, against real throwaway repos (private HOME and global config).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const lab = require('./helpers/git-lab');
const { sh, put, repo, fresh } = lab;
const { git } = require('../src/exec');
const { detectOperations, collectGitState, GRAPH_MIN_COMMITS } = require('../src/git-state');
const { checkGitState, workspaceIdentity, PACKS_MAX, LOOSE_MAX } = require('../src/checks-gitstate');
const { evaluate } = require('../src/checks');
const { plan, apply } = require('../src/actions');
const { scanRepo } = require('../src/scanner');

const ops = (d) => detectOperations((a) => git(a, { cwd: d }), d);
const tryGit = (d, ...a) => { try { sh(d, ...a); } catch {} };
const state = (d, o = {}) => collectGitState(d, { storage: {}, ...o });
// Two branches that change the same line.
function conflicted() {
  const d = repo({ 'a.txt': 'base\n' });
  sh(d, 'switch', '-q', '-c', 'side');
  put(d, 'a.txt', 'side\n'); sh(d, 'commit', '-qam', 'side');
  sh(d, 'switch', '-q', 'main');
  put(d, 'a.txt', 'main\n'); sh(d, 'commit', '-qam', 'main');
  return d;
}

test('merge, rebase, cherry-pick, revert, am and bisect are told apart', async () => {
  let d = conflicted();
  assert.deepEqual(await ops(d), []);
  tryGit(d, 'merge', 'side');
  assert.deepEqual((await ops(d)).map((o) => o.kind), ['merge']);

  d = conflicted(); sh(d, 'switch', '-q', 'side');
  tryGit(d, 'rebase', 'main');
  assert.deepEqual((await ops(d)).map((o) => o.kind), ['rebase']); // its CHERRY_PICK_HEAD is part of the rebase

  d = conflicted(); tryGit(d, 'cherry-pick', 'side');
  assert.deepEqual((await ops(d)).map((o) => o.kind), ['cherry-pick']);

  d = conflicted(); tryGit(d, 'revert', 'HEAD~1', '--no-edit');
  assert.deepEqual((await ops(d)).map((o) => o.kind), ['revert']);

  d = conflicted(); sh(d, 'switch', '-q', 'side');
  const patch = path.join(d, '..', `p${Date.now()}.patch`);
  fs.writeFileSync(patch, sh(d, 'format-patch', '-1', '--stdout') + '\n');
  sh(d, 'switch', '-q', 'main'); tryGit(d, 'am', '-3', patch);
  assert.deepEqual((await ops(d)).map((o) => o.kind), ['am']);

  d = conflicted(); sh(d, 'bisect', 'start'); sh(d, 'bisect', 'bad', 'HEAD'); sh(d, 'bisect', 'good', 'HEAD~1');
  assert.ok((await ops(d)).some((o) => o.kind === 'bisect'));
});

test('an operation in a linked worktree is found with that worktree\'s own paths', async () => {
  const d = conflicted();
  const wt = fresh('wt');
  sh(d, 'worktree', 'add', '-q', '-b', 'wtb', wt, 'side');
  tryGit(wt, 'merge', 'main');
  assert.deepEqual((await ops(wt)).map((o) => o.kind), ['merge']);
  assert.deepEqual(await ops(d), []); // the main checkout has nothing in progress
});

test('detached HEAD: counts commits that no branch, tag or remote holds', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'switch', '-q', '--detach');
  assert.equal((await state(d, { detached: true })).detached.unreferenced, 0);
  put(d, 'a.txt', '2\n'); sh(d, 'commit', '-qam', 'lonely');
  assert.equal((await state(d, { detached: true })).detached.unreferenced, 1);
  sh(d, 'tag', 'keep');
  assert.equal((await state(d, { detached: true })).detached.unreferenced, 0);
  assert.equal((await state(d, { detached: false })).detached, null);
});

const snap = (o = {}) => ({ git: { branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, branches: [], remoteBranches: [], mergedBranches: [] }, hygiene: { storage: {} }, ...o });
const GS = (o = {}) => ({ ops: [], detached: null, maintenance: { registered: false, gcLogBlocking: false, commitGraph: true, commits: null }, identity: null, ...o });
const ids = (s) => checkGitState(s).map((f) => f.id);

test('unfinished operation: one warn finding with an abort fix', () => {
  const f = checkGitState(snap({ gitState: GS({ ops: [{ kind: 'rebase' }] }) }));
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'git-op'); assert.equal(f[0].severity, 'warn');
  assert.deepEqual(f[0].fix, { type: 'git-op-abort', label: 'Abort the rebase…', op: 'rebase' });
  assert.match(f[0].detail, /--continue/);
});

test('detached HEAD: info when nothing is lost, warn when commits are unreferenced, quiet during a rebase', () => {
  const det = { branch: null, detached: true, upstream: null, ahead: 0, behind: 0, dirty: 0, branches: [], remoteBranches: [], mergedBranches: [] };
  const base = { remote: { owner: 'o', name: 'n' }, files: {}, deps: { manifestsWithoutLock: [] }, prs: [], ci: { failed: [] }, alerts: [] };
  const sev = (gs) => (evaluate({ ...base, git: det, gitState: gs }).findings.find((f) => f.id === 'git-detached') || {}).severity;
  assert.equal(sev(GS({ detached: { unreferenced: 0 } })), 'info');
  assert.equal(sev(GS({ detached: { unreferenced: 3 } })), 'warn');
  assert.equal(sev(undefined), 'warn'); // unknown: as before
  assert.equal(sev(GS({ ops: [{ kind: 'rebase' }], detached: { unreferenced: 2 } })), undefined); // a rebase detaches HEAD by design
});

test('maintenance: nothing under the thresholds, one info finding over them', () => {
  assert.deepEqual(ids(snap({ gitState: GS(), hygiene: { storage: { packs: PACKS_MAX, loose: LOOSE_MAX } } })), []);
  const f = checkGitState(snap({ gitState: GS({ maintenance: { registered: false, gcLogBlocking: true, commitGraph: false, commits: GRAPH_MIN_COMMITS } }), hygiene: { storage: { packs: PACKS_MAX + 1, loose: LOOSE_MAX + 1, prunePackable: 50 } } }));
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'git-maintenance'); assert.equal(f[0].severity, 'info');
  for (const re of [/packs/, /loose/, /gc\.log/, /commit-graph/]) assert.match(f[0].detail, re);
  assert.deepEqual(f[0].fix, { type: 'maintenance-register', label: 'Register for maintenance…' });
});

test('maintenance: a registered repo gets no register fix; a small repo needs no commit-graph', () => {
  const f = checkGitState(snap({ gitState: GS({ maintenance: { registered: true, gcLogBlocking: false, commitGraph: false, commits: 40 } }), hygiene: { storage: { packs: 51 } } }));
  assert.equal(f.length, 1);
  assert.equal(f[0].fix, undefined);
  assert.ok(!/commit-graph/.test(f[0].detail));
});

test('maintenance: collected from a real repo (gc.log age, registration)', async () => {
  const d = repo({ 'a.txt': '1\n' });
  let m = (await state(d)).maintenance;
  assert.equal(m.gcLogBlocking, false); assert.equal(m.registered, false);
  fs.writeFileSync(path.join(d, '.git', 'gc.log'), 'warning: There are too many unreachable loose objects\n');
  assert.equal((await state(d)).maintenance.gcLogBlocking, true);
  const old = new Date(Date.now() - 3 * 864e5); fs.utimesSync(path.join(d, '.git', 'gc.log'), old, old);
  assert.equal((await state(d)).maintenance.gcLogBlocking, false); // older than gc.logExpiry: git ignores it
  sh(d, 'config', '--global', '--add', 'maintenance.repo', d);
  assert.equal((await state(d)).maintenance.registered, true);
  sh(d, 'config', '--global', '--unset-all', 'maintenance.repo');
  m = (await state(d)).maintenance;
  assert.equal(typeof m.commitGraph, 'boolean');
});

test('identity: configured, then commits under another email', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'config', 'user.name', 'Ann'); sh(d, 'config', 'user.email', 'ann@home.example');
  let id = (await state(d)).identity;
  assert.equal(id.email, 'ann@home.example'); assert.equal(id.autoGenerated, false);
  for (let i = 0; i < 2; i++) { put(d, 'a.txt', `w${i}\n`); sh(d, '-c', 'user.email=ann@work.example', 'commit', '-qam', `w${i}`); }
  id = (await state(d)).identity;
  assert.equal(id.other.length, 1); assert.equal(id.other[0].email, 'ann@work.example'); assert.equal(id.other[0].count, 2);
  const f = checkGitState(snap({ gitState: GS({ identity: id }) }));
  assert.equal(f.length, 1); assert.equal(f[0].id, 'git-identity'); assert.equal(f[0].severity, 'info');
  assert.match(f[0].title, /ann@home\.example/); assert.ok(!f[0].title.includes('work.example')); // the other address is only in the detail
  assert.match(f[0].detail, /ann@work\.example/); assert.match(f[0].detail, /includeIf/);
});

test('identity: no email anywhere is auto-generated (EMAIL and GIT_AUTHOR_EMAIL count)', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'config', '--unset', 'user.email');
  const saved = { EMAIL: process.env.EMAIL, GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL };
  delete process.env.EMAIL; delete process.env.GIT_AUTHOR_EMAIL;
  try {
    assert.equal((await state(d)).identity.autoGenerated, true);
    process.env.EMAIL = 'me@x.example';
    assert.equal((await state(d)).identity.autoGenerated, false);
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('identity false alarms: a single odd commit is not enough', () => {
  const mk = (o) => checkGitState(snap({ gitState: GS({ identity: { email: 'a@x', name: 'Ann', autoGenerated: false, useConfigOnly: false, recent: 50, mine: 50, other: [], ...o } }) }));
  assert.equal(mk({}).length, 0);
  assert.equal(mk({ other: [{ email: 'b@y', count: 1 }] }).length, 0);
  assert.equal(mk({ other: [{ email: 'b@y', count: 2 }] }).length, 1);
});

test('identity false alarm: noreply addresses of the same account are not a mismatch', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'config', 'user.name', 'Ann'); sh(d, 'config', 'user.email', '123+ann@users.noreply.github.com');
  for (let i = 0; i < 3; i++) { put(d, 'a.txt', `n${i}\n`); sh(d, '-c', 'user.email=ann@users.noreply.github.com', 'commit', '-qam', `n${i}`); }
  assert.deepEqual((await state(d)).identity.other, []);
});

test('identity false alarm: commits by other people with other names are ignored', async () => {
  const d = repo({ 'a.txt': '1\n' });
  sh(d, 'config', 'user.name', 'Ann'); sh(d, 'config', 'user.email', 'ann@home.example');
  for (let i = 0; i < 3; i++) { put(d, 'a.txt', `o${i}\n`); sh(d, '-c', 'user.name=Bob', '-c', 'user.email=bob@x.example', 'commit', '-qam', `o${i}`); }
  assert.deepEqual((await state(d)).identity.other, []);
});

test('workspace summary only when several repos commit under another email', () => {
  const r = (n, other) => ({ name: n, identity: { email: 'a@x', other: other ? [{ email: other, count: 3 }] : [] } });
  assert.deepEqual(workspaceIdentity([r('a', 'w@y'), r('b')]), []);
  const w = workspaceIdentity([r('a', 'w@y'), r('b', 'w@y'), r('c')]);
  assert.equal(w.length, 1); assert.equal(w[0].id, 'ws-git-identity');
  assert.match(w[0].detail, /a, b/);
  assert.match(w[0].note, /includeIf/);
});

// ---- actions

test('abort plan: previews the exact command, warns that resolutions are discarded, needs the repo name', async () => {
  const d = conflicted(); tryGit(d, 'merge', 'side');
  const r = await scanRepo(d, {});
  assert.ok(r.findings.some((f) => f.id === 'git-op'));
  const p = await plan(r, { type: 'git-op-abort', op: 'merge' });
  assert.ok(p.ok, p.error);
  assert.equal(p.risk, 'danger'); assert.equal(p.confirmName, r.name);
  assert.match(p.display[0].text, /^git merge --abort$/);
  assert.match(p.warnings.join('\n'), /discard/i);
  const res = await apply(p);
  assert.ok(res.ok, JSON.stringify(res.results));
  assert.deepEqual(await ops(d), []);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'main\n');
  const again = await plan(await scanRepo(d, {}), { type: 'git-op-abort', op: 'merge' });
  assert.equal(again.ok, false); assert.ok(again.nothing);
});

test('abort plan: refuses an operation that is not in progress or an unknown kind', async () => {
  const d = conflicted(); tryGit(d, 'merge', 'side');
  const r = await scanRepo(d, {});
  assert.equal((await plan(r, { type: 'git-op-abort', op: 'rebase' })).ok, false);
  assert.equal((await plan(r, { type: 'git-op-abort', op: '--hard' })).ok, false);
});

test('maintenance register plan: says it writes global config, never starts a scheduler, and applies', async () => {
  const d = repo({ 'a.txt': '1\n' });
  const r = await scanRepo(d, {});
  const p = await plan(r, { type: 'maintenance-register' });
  assert.ok(p.ok, p.error);
  assert.match(p.warnings.join('\n'), /global git config/);
  assert.match(p.display[0].text, /^git maintenance register$/);
  assert.ok(!p.display.some((x) => /start/.test(x.text)));
  const res = await apply(p);
  assert.ok(res.ok, JSON.stringify(res.results));
  assert.ok(sh(d, 'config', '--global', '--get-all', 'maintenance.repo').split('\n').some((x) => fs.realpathSync(x) === fs.realpathSync(d)));
  assert.equal((await state(d)).maintenance.registered, true);
  const again = await plan(await scanRepo(d, {}), { type: 'maintenance-register' });
  assert.ok(again.nothing);
  sh(d, 'config', '--global', '--unset-all', 'maintenance.repo');
});

test('Fix all never runs an abort or a register on its own', () => {
  const FixAll = require('../src/renderer/fix-all');
  const r = { findings: [
    { id: 'git-op', severity: 'warn', title: 't', fix: { type: 'git-op-abort', label: 'x', op: 'merge' } },
    { id: 'git-maintenance', severity: 'info', title: 't', fix: { type: 'maintenance-register', label: 'y' } }] };
  const p = FixAll.plan(r);
  assert.deepEqual(p.actions, []);
  assert.equal(p.decisions.length, 2);
  for (const dcs of p.decisions) assert.equal(dcs.choices[dcs.pick].action, null); // starts on "leave it"
});

test('report steps for the new findings', () => {
  const { buildReport } = require('../src/report');
  const s = { path: '/w/x', name: 'x', score: 90, grade: 'A', prs: [], ci: { failed: [] }, alerts: [], files: {}, git: { branch: 'main', branches: [] }, remote: null, originUrl: '',
    findings: [
      { id: 'git-op', category: 'Branches', severity: 'warn', title: 'A rebase is unfinished', detail: 'd' },
      { id: 'git-maintenance', category: 'Git hygiene', severity: 'info', title: 'Git maintenance', detail: 'd' },
      { id: 'git-identity', category: 'Git hygiene', severity: 'info', title: 'id', detail: 'd' }],
    gitState: GS({ ops: [{ kind: 'rebase' }], identity: { email: 'a@x', other: [{ email: 'b@y', count: 3 }] } }) };
  const out = buildReport({ repos: [s], root: "/w" });
  assert.match(out, /git rebase --continue/); assert.match(out, /git rebase --abort/); assert.match(out, /discards/);
  assert.match(out, /git maintenance register/); assert.match(out, /includeIf/); assert.match(out, /useConfigOnly/);
  assert.match(out, /git-prompt\.sh/);
});
