// Remote repos in the app: list chip and filter, the detail view of a repo with no folder here,
// the settings dialog, and the scan progress label for the remote stage.
const test = require('node:test');
const assert = require('node:assert');
const { boot, tick, REPOS } = require('./helpers/dom');

const click = (el) => el.click();
const scan = async (t) => { click(t.$('#scan')); await tick(80); };
const remote = (name, o = {}) => ({
  path: `remote:octo/${name}`, name: `octo/${name}`, source: 'remote', cacheDir: o.partial ? null : `/c/octo__${name}`, partial: !!o.partial,
  score: 90, grade: 'A', findings: [{ id: 'no-description', severity: 'info', category: 'Repo', title: 'Repo has no GitHub description', detail: '', fix: { type: 'repo-edit', label: 'Set description…' } }],
  prs: [], ci: { failed: [] }, alerts: [], files: {}, remote: { owner: 'octo', name, url: `https://github.com/octo/${name}`, defaultBranch: 'main' },
  git: { branch: 'main', dirty: 0, ahead: 0, behind: 0, branches: [], remoteBranches: [], mergedBranches: [] }, gitState: null, localOnly: null,
});
const repos = [...REPOS, remote('app'), remote('huge', { partial: true })];
const names = (t) => t.$$('#repos .rname').map((e) => e.textContent);

test('remote repos get a Remote chip, partial ones also "GitHub checks only"', async () => {
  const t = await boot({ repos });
  await scan(t);
  const li = (n) => t.$$('#repos li').find((x) => x.querySelector('.rname').textContent === n);
  assert.match(li('octo/app').textContent, /Remote/);
  assert.ok(!/GitHub checks only/.test(li('octo/app').textContent));
  assert.match(li('octo/huge').textContent, /GitHub checks only/);
  assert.ok(!/Remote/.test(li('alpha').textContent));
});

test('the All / Local / Remote filter shows only that kind, and is hidden with no remote repos', async () => {
  const t = await boot({ repos });
  await scan(t);
  const sel = t.$('#source');
  assert.equal(sel.hidden, false);
  sel.value = 'remote'; sel.dispatchEvent(new t.w.Event('change'));
  assert.deepEqual(names(t).sort(), ['octo/app', 'octo/huge']);
  sel.value = 'local'; sel.dispatchEvent(new t.w.Event('change'));
  assert.deepEqual(names(t).sort(), ['alpha', 'beta', 'gamma']);
  const plain = await boot();
  await scan(plain);
  assert.equal(plain.$('#source').hidden, true);
});

test('a remote repo\'s detail: not cloned here, no folder buttons, no Fix all, a link to GitHub', async () => {
  const t = await boot({ repos });
  await scan(t);
  click(t.$$('#repos li').find((x) => x.querySelector('.rname').textContent === 'octo/app'));
  await tick();
  const d = t.$('#detail');
  assert.match(d.querySelector('.sub').textContent, /Not cloned in this workspace/);
  const buttons = [...d.querySelectorAll('.toolbar button')].map((b) => b.textContent);
  assert.ok(!buttons.includes('Open folder'));
  assert.ok(!buttons.includes('Fetch & prune'));
  assert.ok(!buttons.some((b) => /Fix all/.test(b)));
  assert.ok(buttons.includes('Open on GitHub ↗'));
  assert.ok(buttons.includes('Rescan'));
  assert.match(d.textContent, /Fixes for uncloned repos come in a later version/);
  assert.ok(![...d.querySelectorAll('.finding button')].some((b) => b.textContent === 'Set description…'), 'no fix buttons on findings');
});

test('Settings > Remote repos loads, saves and clears the cache', async () => {
  const t = await boot({ repos, remote: { settings: { enabled: false, orgs: [], forks: false, archived: false, skip: [], maxSizeMB: 500, cacheMaxGB: 5 }, status: null, cacheBytes: 3 * 1024 * 1024, orgs: ['acme'] } });
  click(t.$('#background'));
  await tick();
  click(t.$$('.modal button').find((b) => /GitHub repos not cloned here/.test(b.textContent)));
  await tick(60);
  const m = t.$('.modal');
  assert.match(m.textContent, /acme/, 'your orgs are listed');
  assert.match(m.textContent, /3 MB/, 'current cache size');
  const box = (label) => [...m.querySelectorAll('label.chk')].find((l) => l.textContent.includes(label)).querySelector('input');
  const text = (label) => [...m.querySelectorAll('label.frow')].find((l) => l.textContent.includes(label)).querySelector('input');
  box('Check my GitHub repos').checked = true;
  text('Organisations').value = 'acme, other';
  text('Leave out').value = 'octo/old';
  text('Largest repo').value = '200';
  box('Delete the downloaded copies').checked = true;
  click([...m.querySelectorAll('button')].find((b) => b.textContent === 'Save'));
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'remoteSet')[1], { enabled: true, orgs: ['acme', 'other'], forks: false, archived: false, skip: ['octo/old'], maxSizeMB: 200, cacheMaxGB: 5 });
  assert.ok(t.calls.some((c) => c[0] === 'remoteClear'));
});

test('scan progress names the remote stage', async () => {
  const t = await boot({ repos });
  t.emit.begin({ total: 3 });
  t.emit.repo({ res: REPOS[0], done: 1, total: 3, stage: 'local' });
  assert.match(t.$('#ptext').textContent, /Scanned 1\/3/);
  t.emit.repo({ res: remote('app'), done: 2, total: 3, stage: 'remote' });
  assert.equal(t.$('#ptext').textContent, 'Checking remote repos: 2/3 (octo/app)');
});
