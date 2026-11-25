// The footer progress bar while reviewed changes are applied: the service reports each plan, step
// and rescan; the app shows them until the results dialog opens.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createService } = require('../src/service');
const { scanRepo } = require('../src/scanner');
const { boot, tick } = require('./helpers/dom');

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

test('service: applyActions reports start, each step, the rescan and done for every plan, in order', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-prog-'));
  const sh = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  try {
    sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 'T');
    fs.writeFileSync(path.join(d, 'a.js'), '1\n'); sh('add', '-A'); sh('commit', '-qm', 'init');
    const known = new Map([[d, await scanRepo(d)]]);
    const svc = createService({ known, settings: () => ({}), audit() {} });
    const plans = await svc.planActions([{ dir: d, action: { type: 'gitignore-append', entries: ['*.log'] } }, { dir: d, action: { type: 'add-file', template: 'security', commit: true } }]);
    assert.ok(plans.every((p) => p.ok), JSON.stringify(plans));
    const seen = [];
    const out = await svc.applyActions([...plans.map((p) => p.token), 'gone'], { onProgress: (p) => seen.push(p) });
    assert.deepEqual(out.map((o) => o.ok), [true, true, false]);
    assert.ok(seen.every((p) => p.total === 3));
    for (const i of [0, 1]) {
      const mine = seen.filter((p) => p.index === i).map((p) => p.phase);
      assert.equal(mine[0], 'start');
      assert.ok(mine.includes('step'), `plan ${i} reports its steps`);
      assert.deepEqual(mine.slice(-2), ['rescan', 'done']);
    }
    const steps = seen.filter((p) => p.phase === 'step' && p.index === 1);
    assert.deepEqual(steps.map((p) => p.step), steps.map((_, k) => k), 'steps count up from 0');
    assert.ok(steps.every((p) => p.steps === steps.length && typeof p.text === 'string' && p.repoName));
    assert.deepEqual(seen.filter((p) => p.index === 2).map((p) => [p.phase, p.ok]), [['start', undefined], ['done', false]], 'an expired token still ends its slice');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('service: a progress listener that throws does not stop the batch', async () => {
  const svc = createService({ known: new Map(), settings: () => ({}), audit() {} });
  const out = await svc.applyActions(['x'], { onProgress: () => { throw new Error('boom'); } });
  assert.match(out[0].error, /expired/);
});

test('app: the footer bar shows while changes apply, follows the progress, and hides before the results', async () => {
  const t = await boot();
  let finish;
  t.w.api.planActions = async (items) => items.map((i, k) => ({ ok: true, token: 't' + k, repoName: 'gamma', title: 'Add SECURITY.md', risk: 'safe', display: [{ text: 'write SECURITY.md' }], warnings: [], undo: null }));
  t.w.api.applyActions = () => new Promise((r) => { finish = r; });
  click(t.$('#scan')); await tick(80);
  const bar = t.$('#applybar');
  assert.equal(bar.hidden, true, 'hidden until something is applied');
  t.run("runActions([{ repo: state.repos.get('/w/gamma'), action: { type: 'add-file', template: 'security' } }], { ask: false })");
  await tick();
  click(t.$$('.modal button').find((b) => b.textContent === 'Apply')); await tick();
  assert.equal(bar.hidden, false, 'shown as soon as the review is accepted');
  assert.match(t.$('#atext').textContent, /Applying 1 change/);
  t.emit.applyProgress({ index: 0, total: 1, repoName: 'gamma', title: 'Add SECURITY.md', phase: 'step', step: 1, steps: 2, text: 'git commit -m "Add SECURITY.md"' });
  assert.match(t.$('#atext').textContent, /Change 1 of 1 · gamma: Add SECURITY\.md — step 2 of 2: git commit/);
  assert.equal(bar.getAttribute('aria-valuenow'), '45');
  t.emit.applyProgress({ index: 0, total: 1, repoName: 'gamma', phase: 'rescan' });
  assert.match(t.$('#atext').textContent, /rescanning/);
  assert.equal(t.$('.modal'), null, 'no dialog while it runs');
  finish([{ ok: true, repoName: 'gamma', results: [{ text: 'write SECURITY.md', ok: true, out: '' }] }]); await tick();
  assert.equal(bar.hidden, true, 'hidden once the results are in');
  assert.match(t.$('.modal .mh').textContent, /Done/);
  t.emit.applyProgress({ index: 0, total: 1, phase: 'done', ok: true });
  assert.equal(bar.hidden, true, 'a late event does not bring it back');
});

test('app: the footer bar hides when applying throws', async () => {
  const t = await boot();
  t.w.api.planActions = async () => [{ ok: true, token: 't', repoName: 'gamma', title: 'x', risk: 'safe', display: [{ text: 'x' }], warnings: [], undo: null }];
  t.w.api.applyActions = async () => { throw new Error('ipc gone'); };
  click(t.$('#scan')); await tick(80);
  t.run("window.__run = runActions([{ repo: state.repos.get('/w/gamma'), action: { type: 'add-file', template: 'security' } }], { ask: false }).catch(() => 'threw')");
  await tick();
  click(t.$$('.modal button').find((b) => b.textContent === 'Apply')); await tick();
  assert.equal(await t.w.__run, 'threw');
  assert.equal(t.$('#applybar').hidden, true);
});
