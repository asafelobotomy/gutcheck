const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createService } = require('../src/service');
const { scanRepo } = require('../src/scanner');
const { normalizeSettings } = require('../src/quality');
const { qualityTotals } = require('../src/renderer/metrics');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
// Built at runtime so this repo's own source never contains a secret-looking literal.
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-qsvc-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'T'); sh(dir, 'config', 'user.email', 't@e.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'first');
  const known = new Map([[dir, await scanRepo(dir, {})]]);
  return { dir, known, s: { root: path.dirname(dir) } };
}
const make = (known, s, extra = {}) => createService({ known, settings: () => s, audit() {}, trash: async () => {}, clipboard: { writeText() {} }, ...extra });

test('quality settings are validated, stored through updateSettings, and used by the scan', async () => {
  const { dir, known, s } = await setup();
  try {
    fs.writeFileSync(path.join(dir, 'long.js'), 'x();\n'.repeat(60));
    const store = {};
    const svc = make(known, { ...s, get quality() { return store.quality; } }, { updateSettings: (p) => Object.assign(store, p) });
    assert.deepEqual(svc.qualitySettings(), normalizeSettings());
    assert.equal((await svc.qualityScan()).repos[0].loc.overCount, 0);
    assert.deepEqual(svc.setQualitySettings({ maxLines: 50, ignore: ['x/'], evil: 1 }), { maxLines: 50, locMode: 'total', ignore: ['x/'] });
    assert.equal(svc.setQualitySettings({ maxLines: 3 }).maxLines, 50); // an invalid value keeps the current one
    svc.setQualitySettings({ maxLines: 50 });
    const out = await svc.qualityScan();
    assert.ok(out.ok);
    assert.equal(out.repos[0].loc.overCount, 1);
    assert.equal(out.settings.maxLines, 50);
    assert.equal((await svc.qualityScan(['/etc'])).ok, false);
  } finally { cleanup(dir); }
});

test('a full quality scan stamps the trend; the Copy for LLM report includes code quality', async () => {
  const { dir, known, s } = await setup();
  try {
    fs.writeFileSync(path.join(dir, 'k.js'), `const k = "${AWS}";\nsetTimeout(f, 4242);\n`);
    let disk = [];
    const clip = [];
    const svc = make(known, s, { clipboard: { writeText: (t) => clip.push(t) }, trendStore: { read: () => disk, write: (a) => { disk = JSON.parse(JSON.stringify(a)); } } });
    svc.recordScan(s.root, [...known.values()]);
    const q = await svc.qualityScan();
    assert.deepEqual(Object.keys(disk[0].quality).sort(), ['magic', 'over', 'secrets', 'todos']);
    assert.equal(disk[0].quality.secrets, 1);
    assert.equal(qualityTotals(q.repos).secrets, 1);
    await svc.copyReport(dir);
    assert.match(clip[0], /\*\*Code quality\*\*/);
    assert.match(clip[0], /k\.js:1` AWS access key/);
    assert.match(clip[0], /Phase \d+: Protect secrets/);
    assert.ok(!clip[0].includes(AWS), 'secret values never reach the report');
  } finally { cleanup(dir); }
});

test('qualityTotals rolls repos up and ignores failed scans', () => {
  const q = (name, over, magic, lines) => ({ name, path: '/w/' + name, files: 2, lines, languages: [{ lang: 'JavaScript', files: 2, lines }], loc: { max: 400, overCount: over, largest: [{ path: name + '.js', lines, measured: lines }] }, magic: { total: magic }, secretCount: 1, markers: { total: 2 }, debugCount: 3 });
  const t = qualityTotals([q('a', 1, 10, 500), q('b', 0, 0, 900), { name: 'bad', error: 'x' }]);
  assert.deepEqual([t.repos, t.files, t.lines, t.over, t.magic, t.secrets, t.todos, t.debug, t.max], [2, 4, 1400, 1, 10, 2, 4, 6, 400]);
  assert.deepEqual(t.languages, [{ lang: 'JavaScript', files: 4, lines: 1400 }]);
  assert.equal(t.largest[0].repo, 'b');
  assert.deepEqual(t.magicByRepo.map((x) => x.name), ['a']);
});
