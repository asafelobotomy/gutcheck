// False-alarm regression tests for the runtime end-of-life check (split from accuracy.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-acc-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

// Runtime end-of-life: floors, minimums and mixed matrices are not versions in use.
const { collectRuntimes, checkRuntimeEol } = require('../src/runtime-eol');
const eolIds = (d) => checkRuntimeEol({ runtimes: collectRuntimes(d) }, new Date('2026-11-10T00:00:00Z')).map((f) => f.id);

test('eol: a lower-bound engines range is a floor, not the version in use', () => {
  const d = tmp();
  try {
    put(d, 'package.json', JSON.stringify({ engines: { node: '>=16' } }));
    assert.deepEqual(eolIds(d), []);
    put(d, 'package.json', JSON.stringify({ engines: { node: '>=14 <23' } }));
    assert.deepEqual(eolIds(d), [], 'admits supported Node 22');
  } finally { rm(d); }
});

test('eol: the go line in go.mod is a minimum, so only the toolchain line counts', () => {
  const d = tmp();
  try {
    put(d, 'go.mod', 'module x\n\ngo 1.21\n');
    assert.deepEqual(eolIds(d), []);
    put(d, 'go.mod', 'module x\n\ngo 1.21\n\ntoolchain go1.22.3\n');
    assert.deepEqual(eolIds(d), ['runtime-eol']);
  } finally { rm(d); }
});

test('eol: a CI matrix that also tests a supported version is not flagged, one with only ended versions is', () => {
  const d = tmp();
  try {
    put(d, '.github/workflows/ci.yml', 'jobs:\n  t:\n    strategy:\n      matrix:\n        node: [18, 22]\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n');
    assert.deepEqual(eolIds(d), []);
    put(d, '.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 18\n');
    assert.deepEqual(eolIds(d), ['runtime-eol']);
  } finally { rm(d); }
});

test('eol: aliases such as lts/* or a version file reference name no version and are not flagged', () => {
  const d = tmp();
  try {
    put(d, '.nvmrc', 'lts/*\n');
    put(d, '.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n      - uses: actions/setup-node@v4\n        with:\n          node-version: lts/*\n');
    assert.deepEqual(eolIds(d), []);
  } finally { rm(d); }
});

test('eol: a Node version newer than the bundled table is unknown, not flagged', () => {
  const d = tmp();
  try {
    put(d, '.nvmrc', '28\n');
    assert.deepEqual(eolIds(d), []);
  } finally { rm(d); }
});
