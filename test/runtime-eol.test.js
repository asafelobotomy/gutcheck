// End-of-life runtimes read from version pins: ranges, the bundled table, collection and findings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { allowedLines } = require('../src/runtime-ranges');
const { collectRuntimes, checkRuntimeEol, eolStatus, suggestion } = require('../src/runtime-eol');
const { AS_OF, PRODUCTS } = require('../src/eol-data');
const { buildReport } = require('../src/report');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-eol-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const NOW = new Date('2026-11-10T12:00:00Z');
const scan = (dir) => collectRuntimes(dir);
const findings = (dir, now = NOW) => checkRuntimeEol({ runtimes: scan(dir) }, now);

test('allowedLines: the lines a node or python range admits; null when it has no upper bound', () => {
  assert.equal(allowedLines('node', '>=16'), null);
  assert.equal(allowedLines('node', '*'), null);
  assert.deepEqual(allowedLines('node', '^16.3.0'), ['16']);
  assert.deepEqual(allowedLines('node', '16.x'), ['16']);
  assert.deepEqual(allowedLines('node', '>=14 <17'), ['14', '15', '16']);
  assert.deepEqual(allowedLines('node', '^14 || ^16 || ^18'), ['14', '16', '18']);
  assert.deepEqual(allowedLines('node', '14.17.0 - 16'), ['14', '15', '16']);
  assert.deepEqual(allowedLines('node', '~18.2'), ['18']);
  assert.equal(allowedLines('node', 'garbage'), null);
  assert.deepEqual(allowedLines('python', '>=3.8,<3.11'), ['3.8', '3.9', '3.10']);
  assert.deepEqual(allowedLines('python', '==3.10.*'), ['3.10']);
  assert.deepEqual(allowedLines('python', '~=3.9.2'), ['3.9']);
  assert.equal(allowedLines('python', '>=3.9'), null);
  assert.equal(allowedLines('python', '~=3.9'), null, '~=3.9 means >=3.9,<4: open-ended within 3.x');
});

test('the bundled table says when it was written and every cycle has a date or an explicit null', () => {
  assert.match(AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  for (const [name, p] of Object.entries(PRODUCTS)) {
    assert.ok(p.source.startsWith('https://'), name);
    for (const [cycle, c] of Object.entries(p.cycles)) {
      assert.ok(c.eol === null || /^\d{4}-\d{2}-\d{2}$/.test(c.eol), `${name} ${cycle}`);
      assert.match(c.released, /^\d{4}-\d{2}-\d{2}$/, `${name} ${cycle}`);
    }
  }
});

test('eolStatus: ended, ending soon, supported, and older than the table', () => {
  assert.deepEqual(eolStatus('node', '25', NOW), { state: 'eol', eol: '2026-06-01' });
  assert.deepEqual(eolStatus('node', '20', NOW), { state: 'eol', eol: '2026-04-30' });
  assert.equal(eolStatus('node', '22', NOW).state, 'ok');
  assert.deepEqual(eolStatus('node', '22', new Date('2027-02-15T00:00:00Z')), { state: 'soon', eol: '2027-04-30', days: 74 });
  assert.equal(eolStatus('node', '14', NOW).state, 'eol', 'older than the table');
  assert.equal(eolStatus('node', '99', NOW).state, 'ok', 'newer than the table: unknown, never flagged');
  assert.equal(eolStatus('python', '3.10', NOW).state, 'eol');
  assert.equal(eolStatus('python', '3.11', NOW).state, 'ok');
  assert.equal(eolStatus('go', '1.25', NOW).state, 'eol');
  assert.equal(eolStatus('go', '1.26', NOW).state, 'ok');
  assert.equal(eolStatus('go', '1.9', NOW).state, 'eol');
  assert.equal(eolStatus('go', '1.25', new Date('2026-08-10T00:00:00Z')).state, 'soon', '1.25 ends the day 1.27 ships');
});

test('suggestion names supported lines from the table, preferring the longest-supported one that is not brand new', () => {
  const s = suggestion('node', NOW);
  assert.deepEqual(s.supported, ['22', '24', '26']);
  assert.equal(s.pick, '26');
  const g = suggestion('go', NOW);
  assert.deepEqual(g.supported, ['1.26', '1.27']);
  assert.equal(g.pick, '1.26', 'Go 1.27 is under 90 days old on this date');
  assert.equal(suggestion('python', NOW).pick, '3.14', 'Python 3.15 is a month old');
});

test('collects pins from version files, manifests, go.mod toolchain and tool-versions', () => {
  const d = tmp();
  try {
    put(d, '.nvmrc', 'v18.20.1\n');
    put(d, '.python-version', '3.9.18\n');
    put(d, 'package.json', JSON.stringify({ engines: { node: '^16' } }));
    put(d, 'pyproject.toml', '[project]\nrequires-python = ">=3.8,<3.10"\n');
    put(d, 'go.mod', 'module x\n\ngo 1.22\n\ntoolchain go1.24.1\n');
    put(d, '.tool-versions', 'nodejs 20.11.0\npython 3.12.1\n');
    const uses = scan(d).uses.map((u) => `${u.product} ${u.cycles.join('/')} ${u.file} ${u.kind}`).sort();
    assert.deepEqual(uses, [
      'go 1.24 go.mod pin', 'node 16 package.json range', 'node 18 .nvmrc pin', 'node 20 .tool-versions pin',
      'python 3.12 .tool-versions pin', 'python 3.8/3.9 pyproject.toml range', 'python 3.9 .python-version pin',
    ]);
  } finally { rm(d); }
});

test('collects workflow versions, resolving matrix references in the same file', () => {
  const d = tmp();
  try {
    put(d, '.github/workflows/ci.yml', `name: CI
on: push
jobs:
  test:
    strategy:
      matrix:
        node: [16, 18]
        py:
          - "3.9"
          - '3.12'
        include:
          - go: 1.23.x
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.py }}
      - uses: actions/setup-go@v5
        with:
          go-version: \${{ matrix.go }}
  lint:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20.x
      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
`);
    const got = scan(d).uses.map((u) => `${u.product} ${u.cycles.join('/')} ${u.kind}`).sort();
    assert.deepEqual(got, ['go 1.23 ci', 'node 16/18/20 ci', 'python 3.9/3.12 ci']);
  } finally { rm(d); }
});

test('an exact pin and a CI version that have ended get a warning that names the file and the supported lines', () => {
  const d = tmp();
  try {
    put(d, '.nvmrc', '20\n');
    put(d, 'pyproject.toml', '[project]\nrequires-python = "==3.10.*"\n');
    const f = findings(d);
    assert.equal(f.length, 1);
    assert.equal(f[0].id, 'runtime-eol');
    assert.equal(f[0].severity, 'warn');
    assert.equal(f[0].category, 'Project setup');
    assert.match(f[0].detail, /Node\.js 20 \(\.nvmrc\).*2026-04-30/);
    assert.match(f[0].detail, /Python 3\.10 \(pyproject\.toml\).*2026-10-01/);
    assert.match(f[0].detail, /supported: 22, 24, 26/);
    assert.match(f[0].detail, /table as of 2026-11-09/);
  } finally { rm(d); }
});

test('a pin ending within 90 days is info; one ending later is quiet', () => {
  const d = tmp();
  try {
    put(d, '.nvmrc', '22\n');
    assert.deepEqual(findings(d), []);
    const f = findings(d, new Date('2027-03-01T00:00:00Z'));
    assert.deepEqual(f.map((x) => [x.id, x.severity]), [['runtime-eol-soon', 'info']]);
    assert.match(f[0].detail, /Node\.js 22 \(\.nvmrc\).*2027-04-30/);
  } finally { rm(d); }
});

test('the Copy for LLM report has a step for each runtime finding, naming the files and supported lines', () => {
  const d = tmp();
  try {
    put(d, '.nvmrc', '25\n');
    const fs_ = findings(d);
    const text = buildReport({ repos: [{ path: d, name: 'app', score: 80, grade: 'B', findings: fs_, git: {}, remote: { owner: 'o', name: 'app' }, scannedAt: 'now' }] });
    assert.match(text, /Node\.js 25 is past end of life/);
    assert.match(text, /\.nvmrc/);
    assert.match(text, /do not change a pin without the owner/);
  } finally { rm(d); }
});
