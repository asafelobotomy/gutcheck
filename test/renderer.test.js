const test = require('node:test');
const assert = require('node:assert');
const { boot, tick, snap } = require('./helpers/dom');

const press = (w, el, key) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true }));
const click = (el) => el.click();
const scan = async (t) => { click(t.$('#scan')); await tick(80); };

test('Startup & tray dialog loads the current options and saves the changed ones', async () => {
  const t = await boot();
  click(t.$('#background'));
  await tick();
  const boxes = t.$$('.modal input[type=checkbox]');
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes.map((b) => b.checked), [false, true, false]);
  boxes[0].checked = true;
  click(t.$$('.modal button').find((b) => b.textContent === 'Continue'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'background')[1], { launchOnStartup: true, minimizeToTray: true, closeToTray: false });
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
