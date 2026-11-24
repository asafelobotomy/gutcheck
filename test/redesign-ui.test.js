// The redesigned views: filters, folding sections and ticking many rows to act on them together.
const test = require('node:test');
const assert = require('node:assert');
const { boot, tick, REPOS } = require('./helpers/dom');

const click = (el) => el.click();
const scan = async (t) => { click(t.$('#scan')); await tick(80); };
const button = (t, re, root = '#detail') => t.$$(`${root} button`).find((b) => re.test(b.textContent));
const tickBox = (el) => { el.checked = !el.checked; el.dispatchEvent(new el.ownerDocument.defaultView.Event('change')); };

const fixF = (id, severity, title, template) => ({ id, severity, category: 'Docs & Licence', title, detail: '', fix: { type: 'add-file', label: `Add ${template}`, template } });
const fixable = (name, grade, findings, o = {}) => ({ ...REPOS[1], path: '/w/' + name, name, grade, score: 60, findings, ...o });

test('repo list: the grade bar and the trouble filter narrow the list, and Show all brings everything back', async () => {
  const t = await boot();
  await scan(t);
  assert.equal(t.$$('#repos li').length, 3);
  click(t.$$('#gradebar button').find((b) => b.textContent.startsWith('D')));
  assert.deepEqual(t.$$('#repos .rname').map((n) => n.textContent), ['gamma']);
  assert.match(t.$('#rfilter').textContent, /2 repos hidden by filters/);
  click(t.$$('#rfilter button').find((b) => b.textContent === 'Show all'));
  assert.equal(t.$$('#repos li').length, 3);
  click(t.$$('#rfilter .segb').find((b) => b.textContent.startsWith('Changes')));
  assert.deepEqual(t.$$('#repos .rname').map((n) => n.textContent), ['beta'], 'only the repo with uncommitted or unpushed work');
});

test('repo issues: filter by severity, tick several and fix them in one review', async () => {
  const r = fixable('delta', 'C', [fixF('l', 'error', 'Missing LICENSE', 'license'), fixF('s', 'warn', 'No security policy', 'security'), { id: 'n', severity: 'info', category: 'Repo', title: 'No topics', detail: '' }]);
  const t = await boot({ repos: [r] });
  await scan(t);
  click(t.$$('#repos li')[0]);
  const tabs = t.$$('[role=tab]').map((x) => x.textContent);
  assert.ok(tabs[0].startsWith('Issues'), tabs.join());
  click(t.$$('#detail .segb').find((b) => b.textContent.startsWith('Errors')));
  assert.deepEqual(t.$$('#detail .finding b').map((b) => b.textContent), ['Missing LICENSE']);
  click(t.$$('#detail .segb').find((b) => b.textContent.startsWith('All')));
  assert.equal(t.$$('#detail .finding').length, 3);
  assert.equal(t.$$('#detail .finding .pick').length, 2, 'only fixable issues can be ticked');
  assert.ok(!t.$('#detail .bulkbar'), 'no bulk bar until something is ticked');
  tickBox(t.$('#detail .listhead .pick'));
  assert.match(t.$('#detail .bulkbar').textContent, /2 issues selected/);
  click(button(t, /^Fix selected \(2\)/));
  await tick();
  const planned = t.calls.find((c) => c[0] === 'plan')[1];
  assert.deepEqual(planned.map((p) => p.action.template), ['license', 'security']);
  assert.match(t.$('.modal .mh').textContent, /Review 2 changes/);
  assert.match(t.$('.modal .risksum').textContent, /2 dangerous/, 'the review counts plans by risk');
  click(t.$$('.modal button').find((b) => b.textContent === 'Untick all'));
  assert.ok(t.$$('.modal button').find((b) => /^Apply/.test(b.textContent)).disabled, 'nothing ticked, nothing to apply');
  assert.equal(t.$$('.modal .plan.off').length, 2, 'unticked plans fade');
});

test('a single change\'s review has no risk summary and no stray text', async () => {
  const t = await boot({ repos: [fixable('zeta', 'C', [fixF('l', 'error', 'Missing LICENSE', 'license')])] });
  await scan(t);
  click(t.$$('#repos li')[0]);
  click(t.$$('#detail .finding button').find((b) => b.textContent === 'Add license'));
  await tick();
  const go = t.$$('.modal button').find((b) => b.textContent === 'Continue');
  if (go) { click(go); await tick(); }
  assert.match(t.$('.modal .mh').textContent, /Review change/);
  assert.ok(!t.$('.modal .risksum'));
  assert.ok(!/\bnull\b/.test(t.$('.modal').textContent), 'no stray "null" text');
});

test('branches: filter merged ones and delete the ticked branches together', async () => {
  const git = { branch: 'main', dirty: 0, ahead: 0, behind: 0, remotes: ['origin'], branches: [{ name: 'main', current: true, date: new Date().toISOString() }, { name: 'old', date: new Date().toISOString() }, { name: 'done', date: new Date().toISOString() }], remoteBranches: [], mergedBranches: ['done'] };
  const t = await boot({ repos: [fixable('eps', 'B', [], { git })] });
  await scan(t);
  click(t.$$('#repos li')[0]);
  click(t.$$('[role=tab]').find((x) => x.textContent.startsWith('Branches')));
  assert.equal(t.$$('[role=tabpanel]').filter((p) => !p.hidden).length, 1);
  click(t.$$('#detail .segb').find((b) => b.textContent.startsWith('Merged')));
  const rows = t.$$('#detail .brow');
  assert.deepEqual(rows.map((r) => r.querySelector('b').textContent), ['done']);
  tickBox(rows[0].querySelector('.pick'));
  click(button(t, /^Delete 1…/));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'plan')[1].map((p) => p.action), [{ type: 'delete-local', branch: 'done', force: false }]);
});

test('overview: issue types fold by severity and can be fixed in bulk across repos', async () => {
  const pull = { type: 'pull', label: 'Pull' };
  const f = { id: 'git-behind', severity: 'warn', category: 'Git', title: 'Behind upstream', detail: '', fix: pull };
  const t = await boot({ repos: [fixable('a', 'B', [f]), fixable('b', 'B', [f]), fixable('c', 'D', [{ id: 'x', severity: 'error', category: 'CI', title: 'Failed', detail: '' }])] });
  await scan(t);
  click(t.$('#overview'));
  assert.deepEqual(t.$$('#detail .fold > summary .ftitle').map((x) => x.textContent), ['Errors', 'Warnings']);
  assert.match(t.$('#overview .cnt').textContent, /2/, 'the sidebar counts issue types');
  tickBox(t.$$('#detail .rec .pick')[0]);
  assert.match(t.$('#detail .bulkbar').textContent, /1 issue type selected/);
  click(button(t, /^Fix 2 repos/));
  await tick();
  assert.equal(t.calls.find((c) => c[0] === 'plan')[1].length, 2);
});

test('history: grouped by day, filtered to failures', async () => {
  const t = await boot();
  const now = Date.now();
  t.w.api.audit = async () => [{ ts: new Date(now).toISOString(), ok: true, repo: 'a', title: 'Pull', steps: [{ cmd: 'git pull' }] }, { ts: new Date(now - 1000).toISOString(), ok: false, repo: 'b', title: 'Push', steps: [] }];
  click(t.$('#history'));
  await tick();
  assert.equal(t.$('#detail .fold .ftitle').textContent, 'Today');
  assert.equal(t.$$('#detail .finding').length, 2);
  click(t.$$('#detail .segb').find((b) => b.textContent.startsWith('Failed')));
  assert.deepEqual(t.$$('#detail .finding b').map((b) => b.textContent), ['✗ b: Push']);
});

test('read-only shows as a band under the header and a locked switch', async () => {
  const t = await boot({ settings: { root: '/w', readOnly: true } });
  assert.equal(t.$('#rofence').hidden, false);
  assert.ok(t.doc.body.classList.contains('ro'));
  assert.ok(t.$('#readonly').closest('label').classList.contains('on'));
});
