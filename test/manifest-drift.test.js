// Lockfile and manifest drift: package-lock.json vs package.json, version fields across a project's
// manifests, and a Rust binary crate whose Cargo.lock is not tracked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectDrift, checkDrift } = require('../src/manifest-drift');
const { buildReport } = require('../src/report');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-drift-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof text === 'string' ? text : JSON.stringify(text)); };
const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const repo = () => { const d = tmp(); sh(d, 'init', '-q', '-b', 'main'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't'); return d; };
const lockOf = (root) => ({ name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages: { '': root } });
const run = async (d) => checkDrift({ drift: await collectDrift(d) });

test('package-lock.json that matches package.json is quiet', async () => {
  const d = repo();
  try {
    const pkg = { name: 'a', version: '1.2.0', dependencies: { x: '^1.0.0' }, devDependencies: { y: '~2.1.0' } };
    put(d, 'package.json', pkg);
    put(d, 'package-lock.json', lockOf(pkg));
    assert.deepEqual(await run(d), []);
  } finally { rm(d); }
});

test('a lock root whose version or dependencies disagree with package.json is lockfile-drift, with names and no specifier values', async () => {
  const d = repo();
  try {
    put(d, 'package.json', { name: 'a', version: '1.3.0', dependencies: { x: '^2.0.0', added: '^1.0.0', tok: 'git+https://user:SECRET@example.com/r.git' }, devDependencies: {} });
    put(d, 'package-lock.json', lockOf({ name: 'a', version: '1.2.0', dependencies: { x: '^1.0.0', gone: '^1.0.0' }, devDependencies: {} }));
    const f = await run(d);
    assert.equal(f.length, 1);
    assert.equal(f[0].id, 'lockfile-drift');
    assert.equal(f[0].severity, 'warn');
    assert.match(f[0].detail, /version 1\.3\.0 vs 1\.2\.0/);
    for (const n of ['x', 'added', 'gone', 'tok']) assert.match(f[0].detail, new RegExp(`\\b${n}\\b`));
    assert.ok(!/SECRET/.test(JSON.stringify(f)));
  } finally { rm(d); }
});

test('only the version differing in the lock is info, since npm ci still works', async () => {
  const d = repo();
  try {
    put(d, 'package.json', { name: 'a', version: '1.3.0', dependencies: { x: '^1.0.0' } });
    put(d, 'package-lock.json', lockOf({ name: 'a', version: '1.2.0', dependencies: { x: '^1.0.0' } }));
    const f = await run(d);
    assert.deepEqual(f.map((x) => [x.id, x.severity]), [['lockfile-drift', 'info']]);
  } finally { rm(d); }
});

test('version fields that differ across package.json, tauri.conf.json and src-tauri/Cargo.toml are version-drift', async () => {
  const d = repo();
  try {
    put(d, 'package.json', { name: 'app', version: '1.4.0', private: true });
    put(d, 'src-tauri/tauri.conf.json', { productName: 'app', version: '1.3.0' });
    put(d, 'src-tauri/Cargo.toml', '[package]\nname = "app"\nversion = "1.4.0"\n');
    const f = await run(d);
    const v = f.find((x) => x.id === 'version-drift');
    assert.ok(v);
    assert.equal(v.severity, 'warn');
    assert.match(v.detail, /package\.json 1\.4\.0/);
    assert.match(v.detail, /src-tauri\/tauri\.conf\.json 1\.3\.0/);
  } finally { rm(d); }
});

test('Tauri v1 reads package.version; a version that points at package.json, or a workspace-inherited or dynamic one, is skipped', async () => {
  const d = repo();
  try {
    put(d, 'package.json', { name: 'app', version: '2.0.0' });
    put(d, 'src-tauri/tauri.conf.json', { package: { productName: 'app', version: '1.0.0' } });
    assert.ok((await run(d)).some((x) => x.id === 'version-drift'));
    put(d, 'src-tauri/tauri.conf.json', { version: '../package.json' });
    put(d, 'src-tauri/Cargo.toml', '[package]\nname = "app"\nversion.workspace = true\n');
    put(d, 'pyproject.toml', '[project]\nname = "app"\ndynamic = ["version"]\n');
    assert.deepEqual((await run(d)).filter((x) => x.id === 'version-drift'), []);
    put(d, 'src-tauri/tauri.conf.json', { productName: 'app' });
    assert.deepEqual((await run(d)).filter((x) => x.id === 'version-drift'), []);
  } finally { rm(d); }
});

test('a private package.json outside a Tauri app is not compared with another manifest', async () => {
  const d = repo();
  try {
    put(d, 'package.json', { name: 'tools', version: '0.0.0', private: true });
    put(d, 'pyproject.toml', '[project]\nname = "lib"\nversion = "3.2.1"\n');
    assert.deepEqual((await run(d)).filter((x) => x.id === 'version-drift'), []);
    put(d, 'package.json', { name: 'lib', version: '3.2.0' });
    assert.ok((await run(d)).some((x) => x.id === 'version-drift'));
    put(d, 'package.json', { name: 'lib', version: '3.2.1' });
    assert.deepEqual((await run(d)).filter((x) => x.id === 'version-drift'), []);
  } finally { rm(d); }
});

test('a binary crate with an untracked Cargo.lock gets advice; tracked, library or missing-lock cases do not', async () => {
  const d = repo();
  try {
    put(d, 'Cargo.toml', '[package]\nname = "tool"\nversion = "0.1.0"\n');
    put(d, 'src/main.rs', 'fn main() {}\n');
    put(d, 'Cargo.lock', '# lock\n');
    put(d, '.gitignore', 'Cargo.lock\n');
    sh(d, 'add', '-A');
    const f = await run(d);
    assert.deepEqual(f.map((x) => [x.id, x.severity]), [['cargo-lock-untracked', 'info']]);
    assert.match(f[0].detail, /cargo install/);
    assert.match(f[0].detail, /--locked/);
    put(d, '.gitignore', '');
    sh(d, 'add', '-A');
    assert.deepEqual(await run(d), [], 'tracked');
    const lib = repo();
    try {
      put(lib, 'Cargo.toml', '[package]\nname = "lib"\nversion = "0.1.0"\n');
      put(lib, 'src/lib.rs', '');
      put(lib, 'Cargo.lock', '#');
      put(lib, '.gitignore', 'Cargo.lock\n');
      assert.deepEqual(await run(lib), [], 'a library crate: Cargo leaves the lock to the author');
    } finally { rm(lib); }
    const none = repo();
    try {
      put(none, 'Cargo.toml', '[package]\nname = "t"\nversion = "0.1.0"\n[[bin]]\nname = "t"\npath = "src/t.rs"\n');
      assert.deepEqual(await run(none), [], 'no Cargo.lock at all is the existing no-lock-Cargo.toml finding');
    } finally { rm(none); }
  } finally { rm(d); }
});

test('a Tauri app with src-tauri/Cargo.lock ignored is flagged', async () => {
  const d = repo();
  try {
    put(d, 'src-tauri/Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\n');
    put(d, 'src-tauri/src/main.rs', 'fn main() {}\n');
    put(d, 'src-tauri/Cargo.lock', '#');
    put(d, '.gitignore', 'Cargo.lock\n');
    const f = await run(d);
    assert.equal(f[0].id, 'cargo-lock-untracked');
    assert.match(f[0].detail, /src-tauri\/Cargo\.lock/);
  } finally { rm(d); }
});

test('the Copy for LLM report gives a step for each drift finding', async () => {
  const d = repo();
  try {
    put(d, 'package.json', { name: 'a', version: '1.3.0', dependencies: { x: '^2.0.0' } });
    put(d, 'package-lock.json', lockOf({ name: 'a', version: '1.2.0', dependencies: { x: '^1.0.0' } }));
    const findings = await run(d);
    const text = buildReport({ repos: [{ path: d, name: 'a', score: 80, grade: 'B', findings, git: {}, remote: { owner: 'o', name: 'a' }, scannedAt: 'now' }] });
    assert.match(text, /npm install --package-lock-only --ignore-scripts/);
  } finally { rm(d); }
});
