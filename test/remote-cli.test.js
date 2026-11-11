// Remote repos from the command line and MCP: --remote / --no-remote, `gutcheck remote`, names as
// owner/name, and the tools that leave remote repos out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isolatedEnv } = require('./helpers/env');
const gh = require('../src/github');
const { main } = require('../src/cli');
const { createEngine } = require('../src/engine');
const { TOOLS } = require('../src/mcp');

gh.fetchFailedRuns = async () => ({ failed: [], error: null });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const gitRepo = (d) => {
  if (fs.existsSync(path.join(d, '.git'))) return d;
  fs.mkdirSync(d, { recursive: true });
  const sh = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'README.md'), '# x\n'); sh('add', '-A'); sh('commit', '-q', '-m', 'init');
  return d;
};
const L = (name, o = {}) => ({ owner: 'octo', name, isFork: false, isArchived: false, diskKB: 10, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z', ...o });
const snap = (name) => ({ ok: true, snap: { remote: { owner: 'octo', name, url: `https://github.com/octo/${name}`, description: 'd', isPublic: false, archived: false, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z', openIssues: 0, viewerPermission: 'READ', alertsEnabled: true, isFork: false, hasIssues: false, topics: 1, languages: [], latestRelease: null, ruleset: false }, prs: [], protection: null, alertsTotal: 0, alerts: [] } });

// Data folder with remote repos on (or off), a workspace with one local repo, and stubbed GitHub.
function setup({ enabled = true } = {}) {
  const data = tmp('gc-rcli-data-');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ remote: { enabled } }));
  const root = tmp('gc-rcli-ws-');
  gitRepo(path.join(root, 'local1'));
  const cacheRoot = path.join(data, 'remote-cache');
  const cache = {
    root: cacheRoot,
    sync: async (l) => ({ ok: true, dir: gitRepo(path.join(cacheRoot, `octo__${l.name}`)), fetched: true }),
    evictFor: () => [], cleanup: () => [], clear: () => fs.rmSync(cacheRoot, { recursive: true, force: true }), sizeBytes: () => 2048,
  };
  fs.mkdirSync(cacheRoot, { recursive: true });
  const remoteDeps = {
    cache,
    list: async () => ({ ok: true, repos: [L('app'), L('forked', { isFork: true })] }),
    fetch: async (refs) => new Map(refs.map((r) => [`${r.owner}/${r.name}`, snap(r.name)])),
  };
  const env = isolatedEnv({ GUTCHECK_DATA_DIR: data });
  const run = async (argv) => {
    const out = [];
    const err = [];
    const code = await main([...argv, '--root', root], { out: (s) => out.push(s), err: (s) => err.push(s), env, engineOpts: { remoteDeps } });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { data, root, run, env, remoteDeps };
}

test('scan tags remote repos; --no-remote leaves them out for one run; --remote turns them on', async () => {
  const on = setup();
  const a = await on.run(['scan']);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /octo\/app.*\[remote\]/);
  assert.match(a.out, /local1/);
  const b = await on.run(['scan', '--no-remote']);
  assert.ok(!/octo\/app/.test(b.out));
  const off = setup({ enabled: false });
  assert.ok(!/octo\/app/.test((await off.run(['scan'])).out));
  assert.match((await off.run(['scan', '--remote'])).out, /octo\/app.*\[remote\]/);
});

test('gutcheck remote lists what was included and left out, and the cache size', async () => {
  const s = setup();
  const r = await s.run(['remote']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1 remote repo checked/);
  assert.match(r.out, /octo\/forked: fork/);
  assert.match(r.out, /Cache: 2 KB/);
  const off = setup({ enabled: false });
  assert.match((await off.run(['remote'])).out, /Remote repos are off/);
});

test('gutcheck remote --clear-cache empties the cache folder without scanning', async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.data, 'remote-cache', 'octo__x'), { recursive: true });
  const r = await s.run(['remote', '--clear-cache']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Cleared the remote repo cache/);
  assert.ok(!fs.existsSync(path.join(s.data, 'remote-cache', 'octo__x')));
});

const FILE_FIX = /This fix changes files or local git, and the repo is not cloned in this workspace/;

test('repo accepts owner/name for a remote repo; fix plans API fixes and refuses file fixes', async () => {
  const s = setup();
  const r = await s.run(['repo', 'octo/app', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.source, 'remote');
  const f = await s.run(['fix', 'octo/app', 'repo-edit', 'description=x']);
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /\$ gh repo edit octo\/app --description x/);
  assert.match(f.out, /Nothing was run/);
  const file = await s.run(['fix', 'octo/app', 'add-file', 'template=license']);
  assert.notEqual(file.code, 0);
  assert.match(file.err, FILE_FIX);
  const all = await s.run(['fix', 'octo/app', 'all']);
  assert.equal(all.code, 0, all.err);
  assert.ok(!/write |git /.test(all.out), 'Fix all plans no file or git step on a remote repo');
});

test('MCP: overview rows carry source; tests and local-only leave remote repos out; plan takes API fixes only', async () => {
  const s = setup();
  const e = createEngine({ env: s.env, via: 'mcp', allowActions: true, remoteDeps: s.remoteDeps });
  const tool = (n) => TOOLS.find((t) => t.name === n);
  const ov = await tool('gutcheck_overview').run(e, { root: s.root });
  const app = ov.repos.find((x) => x.name === 'octo/app');
  assert.equal(app.source, 'remote');
  assert.equal(ov.repos.find((x) => x.name === 'local1').source, 'local');
  const t = await tool('gutcheck_tests').run(e, {});
  assert.ok(t.ok);
  assert.ok(!t.repos.some((x) => x.path.startsWith('remote:')));
  const lo = await tool('gutcheck_local_only').run(e, {});
  assert.ok(!lo.repos.some((x) => x.repo === 'octo/app'));
  const p = await tool('gutcheck_plan').run(e, { items: [{ repo: 'octo/app', action: { type: 'repo-edit', description: 'x' } }, { repo: 'octo/app', action: { type: 'add-file', template: 'license' } }] });
  assert.ok(p.ok, p.error);
  const [api, file] = p.plans;
  assert.ok(api.ok && api.token, JSON.stringify(api));
  assert.deepEqual(api.commands, ['gh repo edit octo/app --description x']);
  assert.equal(file.ok, false);
  assert.match(file.error, FILE_FIX);
});

test('--help lists the remote command and flags', async () => {
  const out = [];
  await main(['--help'], { out: (s) => out.push(s), err() {} });
  const h = out.join('\n');
  assert.match(h, /remote \[--clear-cache\]/);
  assert.match(h, /--remote/);
  assert.match(h, /--no-remote/);
});
