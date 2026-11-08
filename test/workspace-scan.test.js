// One workspace scan for the app, CLI and MCP: parallel callers, another folder, refreshes that race
// a new scan, "new since last scan" kept for `new`, and the app's view of background and refused scans.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEngine } = require('../src/engine');
const { createWorkspaceScanner } = require('../src/workspace-scan');
const sched = require('../src/schedule');
const { boot, tick } = require('./helpers/dom');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (...d) => d.forEach((x) => fs.rmSync(x, { recursive: true, force: true }));
function workspace(names) {
  const root = tmp('gutcheck-wsscan-');
  for (const n of names) {
    const d = path.join(root, n);
    fs.mkdirSync(d);
    const sh = (...a) => execFileSync('git', a, { cwd: d });
    sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
    sh('commit', '-q', '--allow-empty', '-m', 'init');
  }
  return root;
}
const engineFor = (data, o = {}) => createEngine({ env: { ...process.env, GUTCHECK_DATA_DIR: data }, via: 'mcp', ...o });

test('parallel calls during a scan wait for all of it; a scan of another folder runs after, not instead', async () => {
  const a = workspace(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  const b = workspace(['b1', 'b2']);
  const data = tmp('gutcheck-wsdata-');
  try {
    const e = engineFor(data);
    const first = e.scan({ root: a });
    const [list, again] = await Promise.all([e.repos(), e.findings()]);
    assert.equal(list.count, 6, 'no half-filled workspace');
    assert.ok(again.ok);
    await first;
    const [sa, sb] = await Promise.all([e.scan({ root: a }), e.scan({ root: b })]);
    assert.equal(sa.root, a);
    assert.equal(sb.root, b, 'the second folder is scanned, not the first one returned');
    assert.equal(sb.count, 2);
    assert.deepEqual((await e.repos()).repos.map((r) => r.name).sort(), ['b1', 'b2']);
  } finally { rm(a, b, data); }
});

test('only `new` uses up the "new since last scan" baseline; other commands leave it', async () => {
  const root = workspace(['alpha']);
  const data = tmp('gutcheck-wsdata-');
  const seenFile = path.join(data, 'seen.json');
  try {
    const e = engineFor(data);
    await e.scan({ root });
    await e.findings();
    await e.report();
    assert.ok(!fs.existsSync(seenFile), 'a plain scan, findings and report record nothing');
    assert.equal((await e.fresh({ rescan: true })).compared, false, 'the first `new` has nothing to compare with');
    fs.writeFileSync(path.join(root, 'alpha', 'x.txt'), 'x');
    await e.scan({ root }); // findings, report, overview... in between
    const r = await e.fresh({ rescan: true });
    assert.equal(r.compared, true);
    assert.deepEqual(r.findings.map((f) => f.id), ['git-dirty'], 'the scan in between did not swallow it');
  } finally { rm(root, data); }
});

test('ignoring a finding in every repo and creating a baseline refresh every repo, not leave them stale', async () => {
  const root = workspace(['alpha', 'beta']);
  const data = tmp('gutcheck-wsdata-');
  try {
    const e = engineFor(data, { allowActions: true });
    await e.scan({ root });
    const id = (await e.findings()).findings.find((f) => f.repo === 'alpha').id;
    assert.ok((await e.findings()).findings.some((f) => f.repo === 'beta' && f.id === id), 'both repos share the finding');
    assert.ok((await e.ignore({ allRepos: true, finding: id, reason: 'not here' })).ok);
    assert.ok(!(await e.findings()).findings.some((f) => f.id === id), 'gone from every repo without a rescan');
    await e.drift({ init: true });
    assert.equal((await e.repos()).count, 2, 'the workspace is still there after baseline init');
  } finally { rm(root, data); }
});

test('a repo refreshed while a new workspace is scanned is not put back into it', async () => {
  const a = workspace(['old']);
  const b = workspace(['new']);
  try {
    const known = new Map();
    const ws = createWorkspaceScanner({ known, service: { forgetPlans() {}, recordScan() {} }, policy: () => ({}) });
    await ws.scan({ root: a });
    const dir = path.join(a, 'old');
    const late = ws.refresh(dir);
    await ws.scan({ root: b });
    assert.equal(await late, null);
    assert.deepEqual([...known.keys()], [path.join(b, 'new')]);
    assert.match((await ws.scan({ root: path.join(a, 'missing') })).error, /does not exist/);
  } finally { rm(a, b); }
});

test('Read-only mode stops machine-level agent fixes at apply, even with --allow-actions', async () => {
  const data = tmp('gutcheck-wsdata-');
  try {
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ readOnly: true }));
    const r = await engineFor(data, { allowActions: true }).apply({ tokens: ['a:whatever'] });
    assert.equal(r.ok, false);
    assert.match(r.results[0].error, /Read-only/);
  } finally { rm(data); }
});

test('seen.json: a failed repo keeps its findings, and deep and normal scans are compared separately', () => {
  const d = tmp('gutcheck-seen-');
  const repo = (findings, o = {}) => ({ name: 'app', path: '/w/app', remote: { owner: 'o', name: 'app' }, findings, ...o });
  const f = (id, severity = 'warn') => ({ id, severity, title: id });
  try {
    const st = sched.createSeenStore(path.join(d, 'seen.json'));
    st.record('/w', [repo([f('a'), f('b')])]);
    assert.deepEqual(st.record('/w', [repo([], { error: 'boom' })]).fresh, []);
    assert.deepEqual(st.record('/w', [repo([], { remote: { owner: 'o', name: 'app', unreachable: true } })]).fresh, [], 'GitHub unreachable counts as failed');
    assert.deepEqual(st.record('/w', [repo([f('a'), f('b')])]).fresh, [], 'nothing comes back as new after the failure');
    assert.equal(st.record('/w', [repo([f('a'), f('b'), f('deep-only')])], { deep: true }).compared, false, 'a deep scan has its own set');
    assert.deepEqual(st.record('/w', [repo([f('a'), f('b')])]).fresh, []);
    fs.writeFileSync(path.join(d, 'old.json'), JSON.stringify({ root: '/w', ts: 1, keys: ['o/app|a'] }));
    assert.deepEqual(sched.createSeenStore(path.join(d, 'old.json')).record('/w', [repo([f('a'), f('c')])]).fresh.map((x) => x.id), ['c'], 'the older file format is still read');
  } finally { rm(d); }
  assert.equal(sched.notification([{ repo: 'app', id: 'x', severity: 'info', title: 'x' }]), null, 'info findings never notify, from the app or `new --notify`');
});

test('app: a refused scan keeps the results; a background scan replaces them', async () => {
  const t = await boot();
  t.$('#scan').click(); await tick(80);
  const before = t.$$('#repos li').length;
  assert.ok(before > 0);
  t.w.api.scan = async () => ({ ok: false, error: 'A scan is already running' });
  t.$('#scan').click(); await tick(80);
  assert.equal(t.$$('#repos li').length, before, 'nothing was scanned, so nothing was wiped');
  t.emit.begin({ total: 1 });
  t.emit.repo({ res: { path: '/w/solo', name: 'solo', score: 90, grade: 'A', findings: [], git: {}, prs: [], ci: { failed: [] }, alerts: [], files: {} }, done: 1, total: 1 });
  await tick(80);
  assert.deepEqual(t.$$('#repos li').map((li) => li.textContent).filter((x) => /solo/.test(x)).length, 1);
  assert.equal(t.$$('#repos li').length, 1, 'repos from before the background scan are gone');
  t.emit.done({ ok: false, error: 'Scheduled scan failed' });
  await tick();
  assert.equal(t.$('#progress').hidden, true, 'a failed scheduled scan still hides the progress bar');
});
