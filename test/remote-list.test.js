// Remote repos: listing your GitHub repos (paginated, orgs as variables) and picking the uncloned ones.
const test = require('node:test');
const assert = require('node:assert');
const { listRemote, selectUncloned } = require('../src/remote-list');
const { normalizeRemoteSettings } = require('../src/remote-settings');

const node = (owner, name, o = {}) => ({ owner: { login: owner }, name, isFork: !!o.fork, isArchived: !!o.archived, diskUsage: o.kb ?? 10, pushedAt: o.pushedAt || '2026-11-01T00:00:00Z', defaultBranchRef: o.branch === null ? null : { name: o.branch || 'main' } });
const page = (root, nodes, next) => JSON.stringify({ data: { [root]: { repositories: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next || null } } } } });

function stubRun(pages) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    const vars = {};
    for (let i = 0; i < args.length; i++) if (args[i] === '-f' || args[i] === '-F') { const [k, ...v] = args[i + 1].split('='); vars[k] = v.join('='); }
    const key = `${vars.login || 'viewer'}:${vars.endCursor || ''}`;
    const out = pages[key];
    if (out instanceof Error) return { ok: false, code: 1, stdout: '', stderr: out.message };
    return { ok: true, code: 0, stdout: out, stderr: '' };
  };
  return { run, calls };
}

test('pages are merged and org logins go in as variables, never into the query text', async () => {
  const { run, calls } = stubRun({
    'viewer:': page('viewer', [node('me', 'a')], 'c1'),
    'viewer:c1': page('viewer', [node('me', 'b')]),
    'org1:': page('organization', [node('org1', 'x', { kb: 2048 })]),
  });
  const r = await listRemote({ run, orgs: ['org1'] });
  assert.ok(r.ok);
  assert.deepEqual(r.repos.map((x) => `${x.owner}/${x.name}`), ['me/a', 'me/b', 'org1/x']);
  assert.deepEqual(r.repos[2], { owner: 'org1', name: 'x', isFork: false, isArchived: false, diskKB: 2048, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z' });
  for (const c of calls) {
    assert.equal(c.cmd, 'gh');
    const q = c.args[c.args.indexOf('-f') + 1];
    assert.ok(q.startsWith('query='), 'query is the first variable');
    assert.ok(!q.includes('org1'), 'org login not built into the query');
  }
});

test('names GitHub would not allow are dropped', async () => {
  const { run } = stubRun({ 'viewer:': page('viewer', [node('me', 'ok'), node('me', '../evil'), node('b_ad', 'x')]) });
  const r = await listRemote({ run, orgs: [] });
  assert.deepEqual(r.repos.map((x) => x.name), ['ok']);
});

test('a repo seen under you and under an org is listed once', async () => {
  const { run } = stubRun({ 'viewer:': page('viewer', [node('org1', 'x')]), 'org1:': page('organization', [node('org1', 'x')]) });
  const r = await listRemote({ run, orgs: ['org1'] });
  assert.equal(r.repos.length, 1);
});

test('gh signed out: an error with the first line of its message', async () => {
  const { run } = stubRun({ 'viewer:': new Error('To get started with GitHub CLI, please run:  gh auth login\nmore') });
  const r = await listRemote({ run, orgs: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'To get started with GitHub CLI, please run:  gh auth login');
});

test('an org that cannot be read fails the listing rather than hiding its repos', async () => {
  const { run } = stubRun({ 'viewer:': page('viewer', [node('me', 'a')]), 'nope:': JSON.stringify({ data: { organization: null }, errors: [{ message: 'Could not resolve to an Organization' }] }) });
  const r = await listRemote({ run, orgs: ['nope'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /nope/);
});

test('selectUncloned: case-insensitive match with local clones, filters, empty repos', () => {
  const L = (owner, name, o = {}) => ({ owner, name, isFork: !!o.fork, isArchived: !!o.archived, diskKB: 1, defaultBranch: o.branch === null ? null : 'main', pushedAt: null });
  const listing = [L('octo', 'app'), L('me', 'fork', { fork: true }), L('me', 'old', { archived: true }), L('me', 'skipme'), L('me', 'empty', { branch: null }), L('me', 'keep')];
  const s = normalizeRemoteSettings({ skip: ['me/skipme'] });
  const r = selectUncloned(listing, [{ owner: 'Octo', name: 'App' }], s);
  assert.deepEqual(r.include.map((x) => x.name), ['keep']);
  assert.deepEqual(r.excluded.map((x) => `${x.name}:${x.why}`), ['app:cloned', 'fork:fork', 'old:archived', 'skipme:skipped', 'empty:empty']);
  const all = selectUncloned(listing, [], normalizeRemoteSettings({ forks: true, archived: true }));
  assert.deepEqual(all.include.map((x) => x.name), ['app', 'fork', 'old', 'skipme', 'keep']);
});
