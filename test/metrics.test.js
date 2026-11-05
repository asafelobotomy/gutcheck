const test = require('node:test');
const assert = require('node:assert');
const { compute, groupFindings } = require('../src/renderer/metrics');

const NOW = Date.parse('2026-06-01T00:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const repo = (name, o = {}) => ({ name, path: '/w/' + name, score: 100, grade: 'A', findings: [], prs: [], ci: { failed: [] }, alerts: [], files: { license: true, readme: true }, remote: { pushedAt: ago(2) }, git: { dirty: 0, ahead: 0, behind: 0, branches: [], mergedBranches: [] }, ...o });
const f = (id, severity, category = 'Branches', title = id) => ({ id, severity, category, title });

test('empty workspace gives zeroes without NaN', () => {
  const m = compute([], null, NOW);
  assert.equal(m.avg, null);
  assert.equal(m.totals.repos, 0);
  assert.deepEqual(m.attention, []);
  assert.equal(m.clutter, null);
});

test('totals, grades, activity and PR buckets', () => {
  const repos = [
    repo('a'),
    repo('b', { score: 60, grade: 'C', findings: [f('x', 'error'), f('y', 'warn'), f('z', 'info', 'Docs')], remote: null,
      git: { dirty: 3, ahead: 2, behind: 1, branches: [{ name: 'main', current: true, date: ago(1) }, { name: 'old', date: ago(90) }, { name: 'done', date: ago(90) }], mergedBranches: ['done'] },
      files: { license: false, readme: false }, alerts: [{ severity: 'high' }, { severity: 'low' }],
      prs: [{ number: 1, updatedAt: ago(1), mergeable: 'CONFLICTING', statusCheckRollup: 'FAILURE' }, { number: 2, updatedAt: ago(40), reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', isDraft: true }],
      ci: { failed: [{}] } }),
    { name: 'broken', path: '/w/broken', error: 'boom', findings: [] },
  ];
  const m = compute(repos, null, NOW);
  const t = m.totals;
  assert.equal(t.repos, 2);
  assert.equal(t.failedScans, 1);
  assert.equal(m.avg, 80);
  assert.deepEqual(m.grades, { A: 1, B: 0, C: 1, D: 0 });
  assert.deepEqual([t.errors, t.warns, t.infos], [1, 1, 1]);
  assert.deepEqual([t.dirty, t.ahead, t.behind, t.mergedBranches, t.staleBranches], [1, 2, 1, 1, 1]);
  assert.deepEqual([t.alertsTotal, t.alertsHigh, t.localOnly, t.noLicense, t.noReadme], [2, 1, 1, 1, 1]);
  assert.deepEqual([t.prs, t.conflictPRs, t.failingPRs, t.readyPRs, t.draftPRs, t.failingCI], [2, 1, 1, 1, 1, 1]);
  const pr = Object.fromEntries(m.prAges.map((x) => [x.label, x.count]));
  assert.equal(pr['Under 3 days'], 1);
  assert.equal(pr['Over 30 days'], 1);
  const act = Object.fromEntries(m.activity.map((x) => [x.label, x.count]));
  assert.equal(act['Last 7 days'], 2); // a by pushedAt, b by newest local branch
  assert.equal(m.perRepo[0].name, 'b');
  assert.equal(m.attention.length, 1);
  assert.equal(m.attention[0].top.id, 'x');
  assert.equal(m.categories[0].cat, 'Branches');
});

test('clutter metrics only appear once scanned', () => {
  const c = new Map([['/w/a', { name: 'a', path: '/w/a', count: 2, totalSize: 1000, items: [{ confidence: 'high', size: 600 }, { confidence: 'low', size: 400 }] }], ['/w/b', { name: 'b', path: '/w/b', count: 0, totalSize: 0, items: [] }]]);
  const m = compute([repo('a'), repo('b')], c, NOW);
  assert.equal(m.clutter.totalSize, 1000);
  assert.equal(m.clutter.safeSize, 600);
  assert.equal(m.clutter.byRepo.length, 1);
  assert.equal(m.clutter.scannedRepos, 2);
});

test('groupFindings collapses numbered titles across repos, most severe first', () => {
  const g = groupFindings([
    repo('a', { findings: [f('p1', 'warn', 'PRs', 'PR #12 stale for 40 days'), f('e', 'error', 'CI', 'Failed')] }),
    repo('b', { findings: [f('p2', 'warn', 'PRs', 'PR #7 stale for 33 days')] }),
  ]);
  assert.equal(g[0].sev, 'error');
  assert.equal(g[1].repos.length, 2);
});

const { heatmap, snapshot, movers, delta } = require('../src/renderer/metrics');

test('heatmap: categories ordered by weight, rows by heat, cells carry worst severity and level', () => {
  const h = heatmap([
    repo('calm'),
    repo('hot', { findings: [f('a', 'error', 'CI'), f('b', 'warn', 'CI'), f('c', 'info', 'Docs')] }),
    repo('mild', { findings: [f('d', 'info', 'Docs')] }),
    { name: 'broken', error: 'x', findings: [] },
  ]);
  assert.deepEqual(h.cols, ['CI', 'Docs']);
  assert.deepEqual(h.rows.map((r) => r.name), ['hot', 'mild', 'calm']);
  const ci = h.rows[0].cells[0];
  assert.equal(ci.worst, 'error');
  assert.equal(ci.level, 2); // 3 + 2 = 5
  assert.equal(h.rows[2].cells[0].level, 0);
  assert.equal(h.rows[2].cells[0].worst, null);
});

test('snapshot is small, local and per-repo scores keyed by name', () => {
  const s = snapshot([repo('a'), repo('b', { score: 60, grade: 'C', findings: [f('x', 'error')] })], '/w', NOW);
  assert.equal(s.ts, NOW);
  assert.equal(s.avg, 80);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.scores, { b: 60, a: 100 });
  assert.equal(s.clutter, null);
});

test('movers and delta', () => {
  const prev = { scores: { a: 90, b: 50, c: 70, gone: 10 } };
  const cur = { scores: { a: 70, b: 80, c: 70, fresh: 100 } };
  const m = movers(prev, cur);
  assert.deepEqual(m.up.map((x) => [x.name, x.delta]), [['b', 30]]);
  assert.deepEqual(m.down.map((x) => [x.name, x.delta]), [['a', -20]]);
  assert.deepEqual(m.added, ['fresh']);
  assert.deepEqual(m.removed, ['gone']);
  assert.equal(movers(null, cur), null);
  assert.deepEqual(delta(3, 5, 'down'), { d: -2, dir: -1, good: true });
  assert.deepEqual(delta(80, 70, 'up'), { d: 10, dir: 1, good: true });
  assert.equal(delta(5, 5).good, null);
  assert.equal(delta(5, null), null);
});
