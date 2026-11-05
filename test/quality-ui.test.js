const test = require('node:test');
const assert = require('node:assert');
const { boot, tick } = require('./helpers/dom');

const click = (el) => el.click();
const scan = async (t) => { click(t.$('#scan')); await tick(80); };

test('code quality view: totals, limits form, details, secrets shown as locations', async () => {
  const t = await boot();
  await scan(t);
  click(t.$('#quality'));
  await tick(80);
  const text = t.$('#detail').textContent;
  assert.match(text, /Over 400 lines/);
  assert.match(text, /1 possible hardcoded secret/);
  assert.match(text, /src\/cfg\.js:3 AWS access key/);
  assert.match(text, /86400000 is DAY_MS/);
  assert.match(text, /Largest files across the workspace/);
  assert.equal(t.$$('.qstats .stat').length, 6);
  assert.equal(t.$('.qform input').value, '400');
});

test('code quality form validates and saves limits, then rescans', async () => {
  const t = await boot();
  await scan(t);
  click(t.$('#quality'));
  await tick(80);
  const [max, ignore] = t.$$('.qform input');
  max.value = '12';
  click(t.$$('.qform button')[0]);
  await tick();
  assert.equal(t.calls.filter((c) => c[0] === 'qualitySet').length, 0, 'invalid limits are rejected in the form');
  assert.match(t.$('#toast').textContent, /20 to 20000/);
  max.value = '250';
  t.$('.qform select').value = 'code';
  ignore.value = 'legacy/, *.generated.ts';
  click(t.$$('.qform button')[0]);
  await tick(80);
  assert.deepEqual(t.calls.find((c) => c[0] === 'qualitySet')[1], { maxLines: 250, locMode: 'code', ignore: ['legacy/', '*.generated.ts'] });
  assert.equal(t.calls.filter((c) => c[0] === 'qualityScan').length, 2);
});

test('dashboard: quality cards appear after a quality scan, and offer a scan before', async () => {
  const t = await boot();
  await scan(t);
  const card = (label) => t.$$('.kpi').find((k) => k.textContent.includes(label));
  assert.ok(card('Code quality'), 'prompt card before scanning');
  click(card('Code quality'));
  await tick(80);
  assert.equal(card('Files over 400 lines').querySelector('b').textContent, '1');
  assert.equal(card('Possible secrets').querySelector('b').textContent, '1');
  assert.ok(t.$$('.panel h3').some((h) => h.textContent === 'Largest files'));
  assert.ok(t.$$('.panel h3').some((h) => h.textContent === 'Lines by language'));
});
