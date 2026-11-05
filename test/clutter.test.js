const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanClutter, workspaceAdvice } = require('../src/clutter');
const { plan, apply } = require('../src/actions');

const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, rel, content = 'x') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-clutter-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'T');
  sh(dir, 'config', 'user.email', 't@e.com');
  put(dir, 'a.txt', 'one');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'first');
  return dir;
}
const byPath = (res) => Object.fromEntries(res.items.map((i) => [i.path, i]));

test('detects stale, duplicate and backup env files without touching live ones', async () => {
  const dir = repo();
  try {
    put(dir, '.env', 'KEY=1');
    put(dir, '.env.local', 'KEY=1'); // same contents as .env
    put(dir, '.env.bak', 'KEY=1'); // identical backup
    put(dir, '.env.old', 'KEY=999'); // diverged backup
    put(dir, '.env.example', 'KEY='); // template: never flagged
    put(dir, '.env.test', 'KEY=t'); // repo has no tests
    put(dir, '.envrc', 'export A=1'); // direnv, not an env file
    const m = byPath(await scanClutter(dir));
    assert.equal(m['.env'], undefined);
    assert.equal(m['.env.example'], undefined);
    assert.equal(m['.envrc'], undefined);
    assert.equal(m['.env.bak'].confidence, 'high');
    assert.equal(m['.env.bak'].keep, '.env');
    assert.equal(m['.env.old'].confidence, 'medium');
    assert.equal(m['.env.local'].category, 'env');
    assert.match(m['.env.local'].reason, /Same contents as \.env/);
    assert.match(m['.env.test'].reason, /no tests/);
    for (const i of Object.values(m)) assert.equal(JSON.stringify(i).includes('KEY=1'), false, 'contents must never leak');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keeps .env.test when the repo has tests', async () => {
  const dir = repo();
  try {
    put(dir, '.env.test', 'A=1');
    put(dir, 'tests/x.js', '');
    assert.equal(byPath(await scanClutter(dir))['.env.test'], undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('finds caches, junk, copies; never offers tracked files', async () => {
  const dir = repo();
  try {
    put(dir, '__pycache__/m.pyc', 'bytes');
    put(dir, 'coverage/index.html', '<html>');
    put(dir, '.DS_Store');
    put(dir, 'notes.txt~', 'n');
    put(dir, 'report.txt', 'same');
    put(dir, 'report (1).txt', 'same');
    put(dir, 'report copy.txt', 'different');
    put(dir, 'tracked.bak', 'keep me');
    put(dir, 'node_modules/pkg/__pycache__/z.pyc', 'z'); // must not be descended into
    sh(dir, 'add', 'tracked.bak');
    sh(dir, 'commit', '-qm', 'tracked backup');
    const res = await scanClutter(dir);
    const m = byPath(res);
    assert.equal(m['__pycache__'].kind, 'dir');
    assert.equal(m['__pycache__'].mode, 'delete');
    assert.equal(m['__pycache__'].confidence, 'high');
    assert.equal(m['coverage'].confidence, 'medium'); // ambiguous name, not ignored
    assert.equal(m['.DS_Store'].mode, 'trash');
    assert.equal(m['report (1).txt'].confidence, 'high');
    assert.equal(m['report (1).txt'].keep, 'report.txt');
    assert.equal(m['report copy.txt'].confidence, 'low');
    assert.equal(m['tracked.bak'], undefined);
    assert.ok(res.advice.some((a) => a.id === 'tracked-clutter'));
    assert.ok(!Object.keys(m).some((p) => p.startsWith('node_modules')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('advice: committed env, unignored env, ignore rules, split dirs, lockfiles', async () => {
  const dir = repo();
  try {
    put(dir, '.env.prod', 'S=1');
    sh(dir, 'add', '-f', '.env.prod');
    sh(dir, 'commit', '-qm', 'oops');
    put(dir, '.env', 'S=2');
    put(dir, '__pycache__/a.pyc', '');
    put(dir, 'test/a.js', '');
    put(dir, 'tests/b.js', '');
    put(dir, 'package-lock.json', '{}');
    put(dir, 'yarn.lock', '');
    const ids = (await scanClutter(dir)).advice.map((a) => a.id);
    for (const id of ['env-tracked', 'env-not-ignored', 'env-no-template', 'clutter-not-ignored', 'split-test', 'multiple-lockfiles']) assert.ok(ids.includes(id), id);
    put(dir, '.gitignore', '.env\n.env.*\n__pycache__/\n');
    const again = (await scanClutter(dir)).advice.map((a) => a.id);
    assert.ok(!again.includes('env-not-ignored'));
    assert.ok(!again.includes('clutter-not-ignored'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clean-clutter plans from a fresh scan and removes via trash/delete', async () => {
  const dir = repo();
  try {
    put(dir, '.env', 'K=1');
    put(dir, '.env.bak', 'K=1');
    put(dir, '__pycache__/m.pyc', 'b');
    put(dir, 'x.txt~', 'x');
    const r = { path: dir, name: 'proj', git: {}, files: {}, deps: {} };
    const trashed = [];
    const ctx = { trash: async (p) => { trashed.push(path.relative(dir, p)); fs.rmSync(p); } };

    // refused: not clutter, tracked, traversal
    for (const bad of ['.env', 'a.txt', '../outside', '/etc/passwd']) assert.equal((await plan(r, { type: 'clean-clutter', paths: [bad] })).ok, false, bad);
    assert.equal((await plan(r, { type: 'clean-clutter', paths: [] })).ok, false);

    const p = await plan(r, { type: 'clean-clutter', paths: ['.env.bak', '__pycache__', 'x.txt~'] });
    assert.ok(p.ok, p.error);
    assert.equal(p.risk, 'danger'); // an env file is involved
    assert.equal(p.confirmName, 'proj');
    assert.ok(p.display.some((d) => /move to trash: \.env\.bak/.test(d.text)));
    assert.ok(fs.existsSync(path.join(dir, '__pycache__')), 'planning must not change anything');

    const out = await apply(p, ctx);
    assert.ok(out.ok, JSON.stringify(out.results));
    assert.deepEqual(trashed.sort(), ['.env.bak', 'x.txt~']);
    assert.ok(!fs.existsSync(path.join(dir, '__pycache__')));
    assert.ok(fs.existsSync(path.join(dir, '.env')), 'the live env file is untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clean-clutter refuses to remove a file and the file it duplicates together', async () => {
  const dir = repo();
  try {
    put(dir, '.env', 'K=1');
    put(dir, '.env.bak', 'K=1');
    const r = { path: dir, name: 'p', git: {}, files: {}, deps: {} };
    // .env is not detected as clutter so cannot be picked at all
    assert.equal((await plan(r, { type: 'clean-clutter', paths: ['.env.bak', '.env'] })).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apply refuses a remove step whose parent escapes the repo', async () => {
  const dir = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-out-'));
  try {
    put(outside, 'victim.txt', 'v');
    const out = await apply({ steps: [{ kind: 'remove', root: dir, path: path.join(outside, 'victim.txt'), mode: 'delete', display: 'x' }] });
    assert.equal(out.ok, false);
    assert.ok(fs.existsSync(path.join(outside, 'victim.txt')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('gitignore-append only accepts allowlisted rules and skips existing ones', async () => {
  const dir = repo();
  try {
    const r = { path: dir, name: 'p', git: {}, files: {}, deps: {} };
    assert.equal((await plan(r, { type: 'gitignore-append', entries: ['*'] })).ok, false);
    assert.equal((await plan(r, { type: 'gitignore-append', entries: ['!important/'] })).ok, false);
    put(dir, '.gitignore', 'node_modules');
    const p = await plan(r, { type: 'gitignore-append', entries: ['.env', '.env.*', '__pycache__/'] });
    assert.ok(p.ok, p.error);
    assert.ok((await apply(p)).ok);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n.env\n.env.*\n__pycache__/\n');
    assert.equal((await plan(r, { type: 'gitignore-append', entries: ['.env'] })).ok, false); // nothing new
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workspace advice: copies, duplicate clones, projects without git, loose files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-ws-'));
  try {
    for (const n of ['app', 'app-old', 'tool', 'tool2']) fs.mkdirSync(path.join(root, n));
    fs.mkdirSync(path.join(root, 'scratch'));
    put(root, 'scratch/package.json', '{}');
    fs.mkdirSync(path.join(root, 'emptydir'));
    put(root, 'todo.txt');
    put(root, '.env', 'A=1');
    const repos = ['app', 'app-old', 'tool', 'tool2'].map((n) => ({ path: path.join(root, n), name: n, originUrl: n.startsWith('app') ? 'git@github.com:me/app.git' : 'https://github.com/me/' + n }));
    const ids = (await workspaceAdvice(root, repos)).map((a) => a.id);
    for (const id of ['ws-loose-files', 'ws-loose-env', 'ws-no-git', 'ws-empty-dirs', 'ws-variant-app-old', 'ws-dup-clone-github.com/me/app']) assert.ok(ids.includes(id), id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('apply refuses items changed or committed after the preview, and ambiguous dirs go to trash', async () => {
  const dir = repo();
  try {
    put(dir, 'coverage/index.html', 'x');
    put(dir, 'a.bak', 'v1');
    put(dir, 'b.bak', 'v1');
    const r = { path: dir, name: 'p', git: {}, files: {}, deps: {} };
    const p = await plan(r, { type: 'clean-clutter', paths: ['coverage', 'a.bak', 'b.bak'] });
    assert.ok(p.ok, p.error);
    assert.equal(p.steps.find((s) => s.rel === 'coverage').mode, 'trash');
    const trashed = [];
    const ctx = { trash: async (f) => { trashed.push(path.basename(f)); } };
    fs.writeFileSync(path.join(dir, 'a.bak'), 'edited after preview!');
    sh(dir, 'add', 'b.bak'); // committed/staged after preview
    const out = await apply(p, ctx);
    assert.equal(out.ok, false);
    assert.match(out.results.find((x) => !x.ok).out, /Changed since the preview|Tracked/);
    assert.ok(!trashed.includes('a.bak'));
    assert.ok(!trashed.includes('b.bak'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
