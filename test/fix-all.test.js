// "Fix all issues" for a repo: what runs by itself, what the owner decides, and the run order.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const FixAll = require('../src/renderer/fix-all');
const { boot, tick } = require('./helpers/dom');
const { main } = require('../src/cli');

const F = (id, severity, fix, title = id) => ({ id, severity, category: 'X', title, detail: '', fix });
const repoOf = (findings, o = {}) => ({ name: 'app', path: '/w/app', findings, remote: { owner: 'o', name: 'app', defaultBranch: 'main' }, git: { branch: 'main' }, ...o });

test('plan: automatic fixes run as they are, owner choices become decisions, machine settings are left out', () => {
  const r = repoOf([
    F('no-license', 'error', { type: 'add-file', label: 'Add MIT licence', template: 'license' }),
    F('git-dirty', 'warn', { type: 'commit-all', label: 'Commit all…' }),
    F('git-ahead', 'warn', { type: 'push', label: 'Push' }),
    F('git-no-upstream', 'info', { type: 'push', label: 'Push & set upstream' }),
    F('no-description', 'info', { type: 'repo-edit', label: 'Set description…' }),
    F('no-auto-delete', 'info', { type: 'repo-edit', label: 'Turn on auto-delete…', deleteBranchOnMerge: true }),
    F('pr-ready-4', 'info', { type: 'pr-merge', label: 'Merge…', number: 4, method: 'squash', deleteBranch: true }),
    F('agent-history', 'warn', { type: 'claude-cleanup-days', label: 'Keep 7 days', days: 7 }),
    F('no-tests', 'info'),
  ]);
  const p = FixAll.plan(r);
  assert.deepEqual(p.actions.map((a) => a.type), ['add-file', 'push', 'repo-edit'], 'two findings with the same push fix become one push');
  assert.equal(p.actions[0].commit, true, 'each added file is committed on its own');
  assert.deepEqual(p.decisions.map((d) => d.id), ['git-dirty', 'no-description', 'pr-ready-4']);
  assert.deepEqual(p.skipped.map((s) => s.id), ['agent-history']);
  const install = FixAll.decision(F('deps', 'warn', {}), { type: 'npm-install', label: 'npm ci' });
  assert.equal(install.choices[install.pick].action, null, 'choices that run project code start on "leave it"');
});

test('order: sync, save work, dependencies, files, cleanup, push, GitHub, test runs; push added after commits', () => {
  const r = repoOf([]);
  const auto = [
    { type: 'security-enable', feature: 'secret-scanning', sev: 'warn' },
    { type: 'add-file', template: 'readme', commit: true, sev: 'error' },
    { type: 'add-file', template: 'license', commit: true, sev: 'info' },
    { type: 'delete-merged', branches: ['x'], sev: 'info' },
    { type: 'pull', sev: 'info' },
    { type: 'protect-branch', preset: 'minimal', sev: 'warn' },
    { type: 'add-file', template: 'gitignore', commit: true, sev: 'warn' },
  ];
  const answers = [{ action: { type: 'tests-run', kind: 'coverage' }, sev: 'info' }, null, { action: { type: 'commit-all', message: 'Save work' }, sev: 'warn' }, { action: { type: 'pr-merge', number: 4 }, sev: 'info' }];
  const { actions, note } = FixAll.order(r, auto, answers);
  assert.deepEqual(actions.map((a) => a.type + (a.template ? ':' + a.template : '')), ['pull', 'add-file:gitignore', 'commit-all', 'add-file:readme', 'add-file:license', 'delete-merged', 'push', 'pr-merge', 'security-enable', 'protect-branch', 'tests-run']);
  assert.ok(actions.every((a) => !('sev' in a)), 'internal fields do not reach the planner');
  assert.equal(note, null);
  assert.match(FixAll.order(repoOf([], { git: { branch: 'feature/x' } }), auto).note, /on feature\/x, not main/);
  assert.ok(!FixAll.order(repoOf([], { remote: null }), auto).actions.some((a) => a.type === 'push'), 'no push without a remote');
});

test('app: Fix all asks the owner\'s choices, then one review in run order where any step can be unticked', async () => {
  const r = { path: '/w/app', name: 'app', score: 40, grade: 'C', prs: [], ci: { failed: [] }, alerts: [], files: { license: false, readme: true }, remote: { owner: 'o', name: 'app', url: 'https://github.com/o/app', defaultBranch: 'main', pushedAt: new Date().toISOString() },
    git: { branch: 'main', dirty: 2, ahead: 0, behind: 0, branches: [{ name: 'main', current: true, date: new Date().toISOString() }], remoteBranches: [], mergedBranches: [] },
    findings: [F('no-license', 'error', { type: 'add-file', label: 'Add MIT licence', template: 'license' }, 'Missing LICENSE'), F('git-dirty', 'warn', { type: 'commit-all', label: 'Commit all…' }, '2 uncommitted changes'), F('pr-ready-4', 'info', { type: 'pr-merge', label: 'Merge…', number: 4 }, 'PR #4 approved')] };
  const t = await boot({ repos: [r] });
  const applied = [];
  let plannedItems = [];
  t.w.api.planActions = async (items) => { plannedItems = items; return items.map((i, k) => ({ ok: true, token: 't' + k, repoName: 'app', title: i.action.type, risk: 'safe', display: [{ text: i.action.type }], warnings: [], undo: null })); };
  t.w.api.applyActions = async (tokens) => { applied.push(...tokens); return []; };
  click(t.$('#scan')); await tick(80);
  click(t.$$('#repos li')[0]); await tick();
  const fixAll = t.$$('.toolbar button').find((b) => b.textContent.startsWith('Fix all issues'));
  assert.equal(fixAll.textContent, 'Fix all issues (3)…');
  click(fixAll); await tick();
  assert.match(t.$('.modal .mh').textContent, /Your call 1 of 2/);
  const next = () => t.$$('.modal button').find((b) => b.textContent === 'Next' || b.textContent === 'Add to the plan');
  assert.equal(next().disabled, true, 'a commit needs a message');
  const msg = t.$('.modal .wfields input');
  msg.value = 'Save work'; msg.dispatchEvent(new t.w.Event('input'));
  assert.equal(next().disabled, false);
  click(next()); await tick();
  assert.match(t.$('.modal .mh').textContent, /Your call 2 of 2/);
  click(t.$$('.modal input[type=radio]')[2]); // leave the PR open
  t.$$('.modal input[type=radio]')[2].dispatchEvent(new t.w.Event('change'));
  click(next()); await tick();
  const planned = plannedItems.map((i) => i.action);
  assert.deepEqual(planned.map((a) => a.type), ['commit-all', 'add-file', 'push']);
  assert.equal(planned[0].message, 'Save work');
  assert.match(t.$('.modal').textContent, /Left for later: PR #4 approved/);
  const boxes = t.$$('.modal .phead input[type=checkbox]');
  assert.equal(boxes.length, 3);
  boxes[2].checked = false; boxes[2].dispatchEvent(new t.w.Event('change'));
  const apply = t.$$('.modal button').find((b) => /^Apply/.test(b.textContent));
  assert.equal(apply.textContent, 'Apply 2 changes');
  click(apply); await tick();
  assert.deepEqual(applied, ['t0', 't1'], 'the unticked push did not run');
});

function click(el) { el.click(); }

test('cli: fix <repo> all lists every step in order and the choices, and runs them with --yes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-fa-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-fad-'));
  const d = path.join(root, 'alpha');
  fs.mkdirSync(d);
  const sh = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'README.md'), '# alpha\n'); sh('add', '-A'); sh('commit', '-qm', 'init');
  fs.writeFileSync(path.join(d, 'wip.txt'), 'x');
  const env = { ...process.env, GUTCHECK_DATA_DIR: data };
  const run = async (argv) => { const o = []; const e = []; const code = await main(argv, { out: (s) => o.push(s), err: (s) => e.push(s), env }); return { code, out: o.join('\n'), err: e.join('\n') }; };
  try {
    const dry = await run(['fix', 'alpha', 'all', '--root', root]);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /^1\. Add \.gitignore and commit it/m);
    assert.match(dry.out, /Your call: 1 uncommitted change[\s\S]*Run it yourself: gutcheck fix alpha git-dirty message="\.\.\."/);
    assert.match(dry.out, /Nothing was run/);
    const yes = await run(['fix', 'alpha', 'all', '--yes', '--root', root]);
    assert.equal(yes.code, 0, yes.err + yes.out);
    assert.ok(fs.existsSync(path.join(d, '.gitignore')) && fs.existsSync(path.join(d, 'LICENSE')));
    assert.match(sh('log', '--format=%s'), /Add \.gitignore/);
    assert.ok(fs.existsSync(path.join(d, 'wip.txt')) && /wip\.txt/.test(sh('status', '--porcelain')), 'the owner\'s own uncommitted work is left alone');
  } finally { for (const x of [root, data]) fs.rmSync(x, { recursive: true, force: true }); }
});
