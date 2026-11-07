const test = require('node:test');
const assert = require('node:assert');
const { boot, tick, snap } = require('./helpers/dom');

const press = (w, el, key) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true }));
const click = (el) => el.click();
const scan = async (t) => { click(t.$('#scan')); await tick(80); };

test('Startup, tray and schedule dialog loads the current options and saves the changed ones', async () => {
  const t = await boot();
  click(t.$('#background'));
  await tick();
  const boxes = t.$$('.modal input[type=checkbox]');
  assert.equal(boxes.length, 4);
  assert.deepEqual(boxes.map((b) => b.checked), [false, true, false, false]);
  assert.equal(t.$('.modal select').value, '24');
  boxes[0].checked = true;
  click(t.$$('.modal button').find((b) => b.textContent === 'Continue'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'background')[1], { launchOnStartup: true, minimizeToTray: true, closeToTray: false, scheduleEnabled: false, scheduleHours: '24' });
  assert.match(t.$('#toast').textContent, /saved/i);
});

test('dashboard shows KPI cards, panels and a heatmap after a scan', async () => {
  const t = await boot();
  await scan(t);
  const kpis = Object.fromEntries(t.$$('.kpi').map((k) => [k.querySelector('span').textContent, k.querySelector('b').textContent]));
  assert.equal(kpis.Repositories, '3');
  assert.equal(kpis['Average health'], '78');
  assert.equal(kpis.Errors, '2');
  assert.equal(kpis['No LICENSE'], '1');
  assert.deepEqual(t.$$('.panel h3').map((h) => h.textContent).slice(0, 2), ['Health grades', 'Needs attention']);
  assert.ok(t.$$('.panel h3').some((h) => h.textContent === 'Issue heatmap'));
  assert.equal(t.$$('.hm').length, 3 * 3); // 3 repos x 3 categories
  assert.ok(t.$$('.hm').some((c) => /hm-error-\d/.test(c.className)));
  assert.ok(t.doc.body.classList.contains('dash'), 'duplicate header stats are hidden on the dashboard');
});

test('trends: placeholder with one scan, charts and deltas with history', async () => {
  const one = await boot({ trend: [snap(Date.now(), 78, 2)] });
  await scan(one);
  assert.equal(one.$$('svg.trend').length, 0);
  assert.match(one.$('#detail').textContent, /appear after your second scan/);

  const t = await boot({ trend: [snap(Date.now() - 864e5, 70, 5, { gamma: 40, beta: 80 }), snap(Date.now(), 78, 2, { gamma: 52, beta: 82, fresh: 90 })] });
  await scan(t);
  assert.ok(t.$$('svg.trend').length >= 2);
  const deltas = t.$$('.kpi i.d').map((i) => i.textContent);
  assert.ok(deltas.some((d) => d.startsWith('▲ 8')), deltas.join('|')); // health 70 -> 78
  assert.ok(t.$$('.kpi i.d.good').length >= 2);
  assert.match(t.$('#detail').textContent, /gamma/);
  assert.match(t.$('#detail').textContent, /New: fresh/);
});

test('dashboard drill-downs work with mouse and keyboard', async () => {
  const t = await boot();
  await scan(t);
  const row = t.$('.attn .row');
  assert.equal(row.getAttribute('role'), 'button');
  assert.equal(row.tabIndex, 0);
  press(t.w, row, 'Enter');
  assert.equal(t.$('#detail h2').textContent, 'gamma'); // worst repo first
  click(t.$('#dashboard'));
  press(t.w, t.$$('.heat .hn').find((n) => n.textContent === 'beta'), ' ');
  assert.equal(t.$('#detail h2').textContent, 'beta');
  click(t.$('#dashboard'));
  click(t.$$('.kpi').find((k) => k.textContent.includes('Errors')));
  assert.equal(t.$('#detail h2').textContent, 'Workspace overview');
});

test('Copy for LLM from the dashboard and a repo view', async () => {
  const t = await boot();
  await scan(t);
  click(t.$$('#detail button').find((b) => b.textContent === 'Copy for LLM'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'copy'), ['copy', null]);
  assert.match(t.$('#toast').textContent, /Copied/);
  assert.match(t.$('#toast').textContent, /no file contents/);
  click(t.$('#repos li'));
  click(t.$$('#detail button').find((b) => b.textContent === 'Copy for LLM'));
  await tick();
  assert.deepEqual(t.calls.filter((c) => c[0] === 'copy')[1], ['copy', '/w/gamma']);
});

test('clutter view pre-selects only high-confidence items and plans exactly those paths', async () => {
  const t = await boot();
  await scan(t);
  click(t.$('#clutter'));
  await tick(80);
  const boxes = t.$$('.crow input');
  assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
  assert.match(t.$('#detail').textContent, /Remove selected \(1, 20 B\)/);
  click(t.$$('#detail button').find((b) => b.textContent.startsWith('Remove selected')));
  await tick(50);
  assert.deepEqual(t.calls.find((c) => c[0] === 'plan')[1], [{ dir: '/w/gamma', action: { type: 'clean-clutter', paths: ['.env.bak'] } }]);
  const apply = t.$$('.modal button').find((b) => b.textContent === 'Apply');
  assert.ok(apply.disabled, 'danger plan needs the repo name typed first');
  const input = t.$('.modal input[type=text]');
  input.value = 'gamma';
  input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  assert.equal(apply.disabled, false);
});

test('clutter view: select none disables removal; read-only blocks it; advice fix is offered', async () => {
  const t = await boot({ settings: { root: '/w', readOnly: true } });
  await scan(t);
  click(t.$('#clutter'));
  await tick(80);
  const remove = t.$$('#detail button').find((b) => b.textContent.startsWith('Remove selected'));
  assert.ok(remove.disabled, 'read-only disables removal');
  assert.ok(t.$$('#detail button').some((b) => b.textContent === 'Add env rules to .gitignore'));

  const t2 = await boot();
  await scan(t2);
  click(t2.$('#clutter'));
  await tick(80);
  click(t2.$$('#detail button').find((b) => b.textContent === 'Select none'));
  assert.ok(t2.$$('#detail button').find((b) => b.textContent.startsWith('Remove selected')).disabled);
});

test('page text goes through textContent: hostile repo data cannot inject markup', async () => {
  const evil = [{ path: '/w/x', name: '<img src=x onerror=alert(1)>', score: 10, grade: 'D', findings: [{ id: 'q', severity: 'error', category: '<b>CI</b>', title: '<script>boom</script>', detail: '' }], prs: [], ci: { failed: [] }, alerts: [], files: {}, remote: null, git: { branches: [], remoteBranches: [], mergedBranches: [] } }];
  const t = await boot({ repos: evil });
  await scan(t);
  assert.equal(t.$$('img, script').length, 0);
  assert.ok(t.$('#repos').textContent.includes('<img src=x onerror=alert(1)>'), 'shown as text, not parsed as markup');
});

test('a failed clutter scan shows the error and a retry, not an endless "Scanning…"', async () => {
  const t = await boot({ clutter: { ok: false, error: 'disk on fire' } });
  await scan(t);
  click(t.$('#clutter'));
  await tick(80);
  assert.match(t.$('#detail').textContent, /Clutter scan failed: disk on fire/);
  assert.ok(t.$$('#detail button').some((b) => b.textContent === 'Try again'));
});

test('a clutter result from before a new workspace scan is dropped', async () => {
  const t = await boot();
  await scan(t);
  let release;
  t.w.api.clutterScan = () => new Promise((r) => { release = () => r({ ok: true, repos: [], workspace: [] }); });
  click(t.$('#clutter'));
  await tick();
  click(t.$('#scan'));
  release();
  await tick(80);
  assert.equal(t.run('state.clutter'), null);
});

test('History loaded late does not draw over the view the user switched to', async () => {
  const t = await boot();
  await scan(t);
  let release;
  t.w.api.audit = () => new Promise((r) => { release = () => r([{ ts: Date.now(), ok: true, repo: 'x', title: 'late', steps: [] }]); });
  click(t.$('#history'));
  click(t.$('#dashboard'));
  release();
  await tick();
  assert.ok(!t.$('#detail').textContent.includes('Action history'));
  assert.match(t.$('#detail h2').textContent, /Dashboard/);
});

test('the stats bar agrees with the dashboard: repos that failed to scan are not averaged in', async () => {
  const { REPOS } = require('./helpers/dom');
  const t = await boot({ repos: [...REPOS, { path: '/w/broken', name: 'broken', error: 'scan failed', score: 0, grade: 'D', findings: [] }] });
  await scan(t);
  const stats = Object.fromEntries(t.$$('#stats .stat').map((s) => [s.querySelector('span').textContent, s.querySelector('b').textContent]));
  assert.equal(stats.Repositories, '3');
  assert.equal(stats['Avg health'], String(Math.round((100 + 82 + 52) / 3)));
});

test('dialogs close on Escape and give focus back; repo rows work from the keyboard', async () => {
  const t = await boot();
  await scan(t);
  const opener = t.$('#background');
  opener.focus();
  click(opener);
  await tick();
  const dlg = t.$('.modal');
  assert.equal(dlg.getAttribute('role'), 'dialog');
  press(t.w, dlg, 'Escape');
  await tick();
  assert.equal(t.$('.modal'), null);
  assert.equal(t.doc.activeElement, opener);
  assert.equal(t.calls.filter((c) => c[0] === 'background').length, 0, 'Escape saves nothing');
  const row = t.$('#repos li');
  assert.equal(row.tabIndex, 0);
  press(t.w, row, 'Enter');
  assert.ok(t.$('#detail .dhead'), 'Enter opens the repo');
});

test('a scan call that fails does not leave the app stuck scanning', async () => {
  const t = await boot();
  t.w.api.scan = async () => { throw new Error('boom'); };
  await scan(t);
  assert.equal(t.$('#scan').disabled, false);
  assert.equal(t.$('#progress').hidden, true);
  assert.match(t.$('#toast').textContent, /boom/);
});

test('the current view and repo are announced to screen readers; scan progress is a progressbar', async () => {
  const t = await boot();
  await scan(t);
  assert.equal(t.$('#dashboard').getAttribute('aria-current'), 'page');
  click(t.$('#overview'));
  assert.equal(t.$('#overview').getAttribute('aria-current'), 'page');
  assert.equal(t.$('#dashboard').getAttribute('aria-current'), null);
  const gamma = t.$$('#repos li').find((li) => li.textContent.includes('gamma'));
  click(gamma);
  assert.equal(t.$$('#repos li[aria-current="true"]').length, 1);
  assert.match(t.$$('#repos li[aria-current="true"]')[0].getAttribute('aria-label'), /gamma, grade D, 2 errors/);
  assert.equal(t.$('#progress').getAttribute('role'), 'progressbar');
  assert.equal(t.$('#progress').getAttribute('aria-valuenow'), '100');
});

test('saving the Startup & tray options shows an error the main process reports', async () => {
  const t = await boot();
  t.w.api.setBackground = async () => ({ error: 'Could not change the login item: EACCES', trayAvailable: true });
  click(t.$('#background'));
  await tick();
  click(t.$$('.modal button').find((b) => b.textContent === 'Continue'));
  await tick();
  assert.match(t.$('#toast').textContent, /EACCES/);
});

test('Settings > AI agents: connect shows the exact command first, follows the actions switch, and copies', async () => {
  const t = await boot();
  click(t.$('#background'));
  await tick();
  assert.equal(t.$('.modal .mh').textContent, 'Settings');
  click(t.$$('.modal button').find((b) => b.textContent === 'Connect an AI agent…'));
  await tick();
  assert.equal(t.$('.modal .mh').textContent, 'AI agents');
  assert.equal(t.$$('.overlay').length, 1, 'the settings dialog closed first');
  const cards = t.$$('.agent');
  assert.deepEqual(cards.map((c) => c.dataset.agent), ['claude-code', 'cursor']);
  const btn = (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label);
  assert.equal(btn(cards[1], 'Connect').disabled, true, 'an agent that is not installed cannot be connected, only copied');

  const allow = t.$('.modal input[type=checkbox]');
  allow.checked = true;
  allow.dispatchEvent(new t.w.Event('change'));
  await tick();
  assert.match(t.$('.modal code').textContent, /--allow-actions$/);

  click(btn(t.$$('.agent')[0], 'Connect'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'planAgent'), ['planAgent', 'claude-code', true, false]);
  assert.equal(t.$$('.overlay').length, 2, 'review opens on top');
  assert.match(t.$$('.modal').pop().textContent, /claude mcp add --transport stdio --scope user gutcheck -- \/x --mcp/);
  assert.ok(!t.calls.some((c) => c[0] === 'applyAgent'), 'nothing runs before Apply');
  click(t.$$('.modal').pop().querySelector('button.primary'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'applyAgent'), ['applyAgent', 'tk']);

  click(t.$$('.modal').pop().querySelector('button.primary')); // close the results
  await tick();
  click(btn(t.$$('.agent')[1], 'Copy'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'copyAgent'), ['copyAgent', 'cursor', true]);
});

test('Tests view: totals, coverage pill, advice, and a run asks for the repo name before anything runs', async () => {
  const t = await boot();
  await scan(t);
  click(t.$('#tests'));
  await tick();
  assert.equal(t.$('#detail h2').textContent, 'Tests');
  const stats = Object.fromEntries(t.$$('.qstats .stat').map((s) => [s.querySelector('span').textContent, s.querySelector('b').textContent]));
  assert.equal(stats['Test cases'], '12');
  assert.equal(stats['Repos without tests'], '1');
  assert.equal(stats['With coverage'], '1/2');
  assert.match(t.$('.cblock').textContent, /coverage 41%/);
  click(t.$$('.cblock button').find((b) => b.textContent.startsWith('Run coverage (Python)')));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'plan')[1], [{ dir: '/w/gamma', action: { type: 'tests-run', kind: 'coverage', stack: 'python', root: '.' } }]);
  assert.ok(t.$('.modal input[type=text]'), 'the review asks for the repo name');
});

test('a finding can be ignored with a reason, and the Baseline view offers to create one', async () => {
  const t = await boot();
  await scan(t);
  click(t.$$('#repos li').find((li) => li.textContent.includes('beta')));
  click(t.$$('.finding button').find((x) => x.textContent === 'Ignore…'));
  await tick();
  const [reason, all] = t.$$('.modal input');
  reason.value = 'parked on purpose';
  assert.equal(all.type, 'checkbox');
  click(t.$$('.modal button').find((x) => x.textContent === 'Continue'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'ignore')[1], { dir: '/w/beta', id: 'a', reason: 'parked on purpose', allRepos: false });
  click(t.$('#baseline'));
  await tick();
  assert.equal(t.$('#baseline').getAttribute('aria-current'), 'page');
  assert.match(t.$('#detail').textContent, /No baseline yet/);
  assert.ok(t.$$('#detail button').some((x) => x.textContent === 'Create a starting baseline'));
});
