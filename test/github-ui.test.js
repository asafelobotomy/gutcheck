// "From GitHub" in the app (github-view.js): live search, your repos with tick-to-clone, and the
// Clone here button on a repo that is only on GitHub.
const test = require('node:test');
const assert = require('node:assert');
const { boot, tick, REPOS } = require('./helpers/dom');

const scan = async (t) => { t.$('#scan').click(); await tick(80); };
const buttons = (el) => [...el.querySelectorAll('button')].map((b) => b.textContent);

test('before a scan the view asks for a workspace, since clones go there', async () => {
  const t = await boot();
  t.$('#github').click();
  await tick();
  assert.match(t.$('#detail').textContent, /Scan a workspace first/);
});

test('typing searches GitHub live and each result offers Clone and Fork', async () => {
  const t = await boot();
  await scan(t);
  t.$('#github').click();
  await tick();
  assert.match(t.$('#detail .sub').textContent, /New clones go into/);
  const q = t.$('#ghq');
  assert.equal(t.doc.activeElement, q, 'the search box has focus');
  q.value = 'cli';
  q.dispatchEvent(new t.w.Event('input'));
  await tick(450);
  assert.deepEqual(t.calls.filter((c) => c[0] === 'getSearch').map((c) => c[1]), ['cli']);
  assert.equal(t.doc.activeElement, t.$('#ghq'), 'redrawing results keeps the focus in the search box');
  const row = t.$('#ghresults .ghrow');
  assert.match(row.textContent, /cli\/cli/);
  assert.ok(buttons(row).includes('Clone') && buttons(row).includes('Fork'));
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Fork').click();
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'getPlan')[1], [{ owner: 'cli', name: 'cli', kind: 'fork' }]);
  assert.match(t.$('.modal').textContent, /gh repo fork cli\/cli/);
});

test('your repos: filter to the ones not here, tick several and clone them together', async () => {
  const t = await boot();
  await scan(t);
  t.$('#github').click();
  await tick();
  t.$$('.tab').find((b) => /Your repos/.test(b.textContent)).click();
  await tick(60);
  assert.ok(t.calls.some((c) => c[0] === 'getMine'));
  const rows = () => t.$$('.tabpanel:not([hidden]) .ghrow');
  assert.deepEqual(rows().map((r) => r.querySelector('b').textContent), ['me/tool', 'me/site'], 'starts on the repos that are not here');
  t.$$('.tabpanel:not([hidden]) .segb').find((b) => /^Here/.test(b.textContent)).click();
  await tick();
  assert.deepEqual(rows().map((r) => r.querySelector('b').textContent), ['me/alpha']);
  assert.match(rows()[0].textContent, /Here/);
  assert.ok(!buttons(rows()[0]).includes('Clone'));
  t.$$('.tabpanel:not([hidden]) .segb').find((b) => /^Not here/.test(b.textContent)).click();
  await tick();
  const all = t.$('.tabpanel:not([hidden]) .listhead input[type=checkbox]');
  all.checked = true; all.dispatchEvent(new t.w.Event('change'));
  await tick();
  const bulk = t.$$('.bulkbar button').find((b) => /^Clone 2/.test(b.textContent));
  assert.ok(bulk, 'a bulk bar offers to clone both');
  bulk.click();
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'getPlan')[1].map((i) => `${i.owner}/${i.name}:${i.kind}`), ['me/tool:clone', 'me/site:clone']);
  assert.match(t.$('.modal h3').textContent, /Review 2 changes/);
});

test('a repo only on GitHub gets Clone here, and the new clone replaces it in the list', async () => {
  const remote = { ...REPOS[0], path: 'remote:octo/app', name: 'octo/app', source: 'remote', remote: { owner: 'octo', name: 'app', url: 'https://github.com/octo/app', defaultBranch: 'main' } };
  const cloned = { ...REPOS[0], path: '/w/app', name: 'app' };
  const t = await boot({ repos: [...REPOS, remote], getApi: { apply: async () => [{ ok: true, repoName: 'octo/app', title: 'Clone', results: [], dir: '/w/app', res: cloned, replaced: 'remote:octo/app' }] } });
  await scan(t);
  t.$$('#repos li').find((x) => x.querySelector('.rname').textContent === 'octo/app').click();
  await tick();
  const b = [...t.$$('#detail .toolbar button')].find((x) => x.textContent === 'Clone here');
  assert.ok(b);
  b.click();
  await tick();
  t.$$('.modal button').find((x) => x.textContent === 'Apply').click();
  await tick(60);
  const names = t.$$('#repos .rname').map((e) => e.textContent);
  assert.ok(names.includes('app') && !names.includes('octo/app'));
  assert.match(t.$('#detail h2').textContent, /^app$/, 'the page now shows the clone');
});
