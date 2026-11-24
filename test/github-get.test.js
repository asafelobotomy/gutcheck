// Clone and fork from GitHub (github-get.js): search, your repos, and the plan, preview, apply flow.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGitHubGet } = require('../src/github-get');

const SEARCH = { total_count: 120, items: [
  { owner: { login: 'cli' }, name: 'cli', description: 'GitHub’s CLI\u202e', stargazers_count: 38000, language: 'Go', fork: false, archived: false, private: false, pushed_at: '2026-11-20T00:00:00Z' },
  { owner: { login: 'me' }, name: 'tool', description: null, stargazers_count: 1 },
  { owner: { login: '-bad' }, name: 'x' },
] };
const VIEWER = { data: { viewer: { repositories: { nodes: [
  { owner: { login: 'me' }, name: 'tool', isFork: false, isArchived: false, diskUsage: 10, pushedAt: '2026-11-01T00:00:00Z', defaultBranchRef: { name: 'main' } },
  { owner: { login: 'me' }, name: 'alpha', isFork: false, isArchived: false, diskUsage: 10, pushedAt: '2026-11-10T00:00:00Z', defaultBranchRef: { name: 'main' } },
  { owner: { login: 'me' }, name: 'blank', isFork: false, isArchived: false, diskUsage: 0, pushedAt: null, defaultBranchRef: null },
], pageInfo: { hasNextPage: false } } } } };

function setup(over = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-get-'));
  fs.mkdirSync(path.join(ws, 'alpha'));
  const calls = [];
  const audits = [];
  const adopted = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (args[0] === 'api' && args[1] === 'user') return { ok: true, stdout: 'me\n', stderr: '' };
    if (args.includes('search/repositories')) return { ok: true, stdout: JSON.stringify(SEARCH), stderr: '' };
    if (args[1] === 'graphql') return { ok: true, stdout: JSON.stringify(VIEWER), stderr: '' };
    if (args[0] === 'repo' && args[1] === 'clone') { fs.mkdirSync(args[3]); return { ok: true, stdout: '', stderr: 'Cloning…' }; }
    if (args[0] === 'repo' && args[1] === 'fork') { fs.mkdirSync(path.join(opts.cwd, args[2].split('/')[1])); return { ok: true, stdout: '', stderr: '' }; }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  const g = createGitHubGet({
    run: over.run || run, root: () => ws, readOnly: over.readOnly || (() => false), audit: (e) => audits.push(e),
    local: () => [{ path: path.join(ws, 'alpha'), owner: 'me', name: 'alpha' }],
    adopt: async (dir, key) => { adopted.push([dir, key]); return { path: dir, name: path.basename(dir) }; },
  });
  return { g, ws, calls, audits, adopted };
}

test('search sends the text as one -f value and returns clean, checked results with "here" and "mine"', async () => {
  const { g, calls } = setup();
  const out = await g.search('  cli $(rm -rf ~)  ');
  assert.equal(out.ok, true);
  const c = calls.find((x) => x.args.includes('search/repositories'));
  assert.ok(c.args.includes('q=cli $(rm -rf ~)'), 'the query is one argument, never a shell string');
  assert.deepEqual(out.repos.map((r) => `${r.owner}/${r.name}`), ['cli/cli', 'me/tool'], 'invalid owners are dropped');
  assert.ok(!/\u202e/.test(out.repos[0].description), 'bidi controls are stripped');
  assert.equal(out.repos[0].mine, false);
  assert.equal(out.repos[1].mine, true);
  assert.equal(out.total, 120);
  assert.deepEqual(await g.search('a'), { ok: true, repos: [], total: 0 }, 'one character does not search');
});

test('your repos say which are here already, newest first', async () => {
  const { g, ws } = setup();
  const out = await g.mine();
  assert.equal(out.ok, true);
  assert.deepEqual(out.repos.map((r) => r.name), ['alpha', 'tool', 'blank']);
  assert.equal(out.repos[0].here, path.join(ws, 'alpha'));
  assert.equal(out.repos[1].here, null);
  assert.equal(out.repos[2].empty, true);
});

test('a clone plan names the exact command and folder, and apply runs it and adds the repo', async () => {
  const { g, ws, calls, audits, adopted } = setup();
  const [p] = await g.plan([{ owner: 'cli', name: 'cli', kind: 'clone' }]);
  assert.equal(p.ok, true);
  assert.equal(p.risk, 'safe');
  assert.equal(p.display[0].text, `gh repo clone cli/cli ${path.join(ws, 'cli')} -- --no-recurse-submodules`);
  assert.equal(calls.filter((c) => c.args[0] === 'repo').length, 0, 'planning runs nothing');
  const [o] = await g.apply([p.token]);
  assert.equal(o.ok, true);
  assert.equal(o.dir, path.join(ws, 'cli'));
  assert.deepEqual(adopted, [[path.join(ws, 'cli'), 'remote:cli/cli']]);
  assert.equal(audits[0].action, 'gh-clone');
  const again = await g.apply([p.token]);
  assert.equal(again[0].ok, false, 'a plan runs once');
});

test('a fork plan is caution, runs in the workspace folder and is refused for your own repo', async () => {
  const { g, ws, calls } = setup();
  const [p] = await g.plan([{ owner: 'cli', name: 'cli', kind: 'fork' }]);
  assert.equal(p.risk, 'caution');
  assert.equal(p.display[0].text, 'gh repo fork cli/cli --clone -- --no-recurse-submodules');
  const [o] = await g.apply([p.token]);
  assert.equal(o.ok, true);
  assert.equal(calls.find((c) => c.args[1] === 'fork').opts.cwd, ws);
  const [own] = await g.plan([{ owner: 'me', name: 'tool', kind: 'fork' }]);
  assert.equal(own.ok, false);
  assert.match(own.error, /your own repo/);
});

test('plans refuse bad names, repos already here, taken folders, duplicates and read-only mode', async () => {
  const { g, ws } = setup();
  const out = await g.plan([
    { owner: 'x', name: '..', kind: 'clone' },
    { owner: '--upload-pack=evil', name: 'r', kind: 'clone' },
    { owner: 'me', name: 'alpha', kind: 'clone' },
    { owner: 'other', name: 'alpha', kind: 'clone' },
    { owner: 'a', name: 'dup', kind: 'clone' },
    { owner: 'b', name: 'dup', kind: 'clone' },
  ]);
  assert.deepEqual(out.map((p) => p.ok), [false, false, false, false, true, false]);
  assert.equal(out[2].nothing, true);
  assert.match(out[3].error, new RegExp(`${path.join(ws, 'alpha').replace(/[\\/]/g, '.')} already exists`));
  assert.match(out[5].error, /Another pick/);
  const ro = setup({ readOnly: () => true });
  assert.match((await ro.g.plan([{ owner: 'cli', name: 'cli' }]))[0].error, /Read-only/);
});

test('apply refuses when the folder appeared after the preview, and reports a failed clone', async () => {
  const { g, ws } = setup();
  const [p] = await g.plan([{ owner: 'cli', name: 'cli', kind: 'clone' }]);
  fs.mkdirSync(path.join(ws, 'cli'));
  const [o] = await g.apply([p.token]);
  assert.equal(o.ok, false);
  assert.match(o.error, /appeared since the preview/);
  const failing = setup({ run: async (cmd, args) => (args[0] === 'repo' ? { ok: false, stdout: '', stderr: 'repository not found' } : { ok: true, stdout: 'me', stderr: '' }) });
  const [fp] = await failing.g.plan([{ owner: 'cli', name: 'gone', kind: 'clone' }]);
  const [fo] = await failing.g.apply([fp.token]);
  assert.equal(fo.ok, false);
  assert.match(fo.results[0].out, /not found/);
  assert.equal(failing.adopted.length, 0);
});
