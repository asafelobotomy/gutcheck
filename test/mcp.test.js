const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isolatedEnv } = require('./helpers/env');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { createServer, start, TOOLS, PROTOCOLS } = require('../src/mcp');
const { createEngine, dataDir, ACTION_CATALOG } = require('../src/engine');
const { main, parseArgs, parseValue } = require('../src/cli');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cleanup = (...d) => d.forEach((x) => fs.rmSync(x, { recursive: true, force: true }));

// A workspace with two local repos (no GitHub remote, so no network beyond gh's rate check).
function workspace() {
  const root = tmp('gutcheck-mcpws-');
  for (const n of ['alpha', 'beta']) {
    const d = path.join(root, n);
    fs.mkdirSync(d);
    sh(d, 'init', '-q', '-b', 'main');
    sh(d, 'config', 'user.email', 't@t'); // CI runners have no global identity, and commit-all commits
    sh(d, 'config', 'user.name', 't');
    sh(d, 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  fs.writeFileSync(path.join(root, 'beta', 'new.txt'), 'x'); // one uncommitted change
  return root;
}
const envFor = (data) => isolatedEnv({ GUTCHECK_DATA_DIR: data }); // a temp HOME: reports scan home secrets

// Drive the protocol with plain objects.
function client(engine) {
  const sent = [];
  const server = createServer({ engine, send: (m) => sent.push(m) });
  let id = 0;
  const req = async (method, params) => { const my = ++id; await server.handle({ jsonrpc: '2.0', id: my, method, params }); return sent.find((m) => m.id === my); };
  const call = async (name, args, meta) => (await req('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result;
  return { req, call, sent, server };
}
const data = (r) => JSON.parse(r.content[0].text);

test('dataDir matches Electron userData for GutCheck on each platform', () => {
  assert.equal(dataDir({}, 'linux', '/h'), '/h/.config/GutCheck');
  assert.equal(dataDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h'), '/x/GutCheck');
  assert.equal(dataDir({}, 'darwin', '/h'), '/h/Library/Application Support/GutCheck');
  assert.equal(dataDir({ APPDATA: 'C:\\A' }, 'win32', '/h'), path.join('C:\\A', 'GutCheck'));
  assert.equal(dataDir({ GUTCHECK_DATA_DIR: '/d' }, 'linux', '/h'), '/d');
});

test('protocol: version negotiation, init gate, tool list, unknown tool and method', async () => {
  const c = client(createEngine({ env: envFor(tmp('gutcheck-data-')) }));
  assert.equal((await c.req('tools/list')).error.code, -32002, 'tools are refused before initialize');
  const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18', 'a supported version is echoed');
  assert.equal(init.result.serverInfo.name, 'gutcheck');
  assert.match(init.result.instructions, /read-only/);
  assert.equal((await c.req('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, PROTOCOLS[0], 'an unknown version gets our newest');
  await c.server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(c.sent.filter((m) => m.method === undefined && m.id === undefined).length, 0, 'notifications get no reply');
  const list = (await c.req('tools/list')).result.tools;
  assert.deepEqual(list.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of list) { assert.ok(!('run' in t)); assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 30, t.name); assert.ok(t.annotations, t.name); }
  assert.equal(list.find((t) => t.name === 'gutcheck_apply').annotations.destructiveHint, true);
  assert.ok(list.filter((t) => !['gutcheck_apply', 'gutcheck_ignore', 'gutcheck_agent_usage'].includes(t.name)).every((t) => t.annotations.readOnlyHint), 'only apply (and ignore, in GutCheck\'s own settings) change anything');
  assert.equal(list.find((t) => t.name === 'gutcheck_ignore').annotations.destructiveHint, false);
  assert.equal((await c.req('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await c.req('resources/list')).error.code, -32601);
  assert.deepEqual((await c.req('ping')).result, {});
  await c.server.handle({ jsonrpc: '2.0', id: 99, result: {} }); // a stray response is ignored
  assert.ok(!c.sent.some((m) => m.id === 99));
});

test('read-only server: scans, findings, report and catalogue work; plan and apply refuse', async () => {
  const root = workspace();
  const dataD = tmp('gutcheck-data-');
  try {
    const c = client(createEngine({ env: envFor(dataD) }));
    await c.req('initialize', {});
    const ov = await c.call('gutcheck_overview', { root }, { progressToken: 'p1' });
    assert.equal(ov.isError, false);
    assert.equal(ov.structuredContent.count, 2);
    assert.deepEqual(ov.structuredContent.repos.map((r) => r.name).sort(), ['alpha', 'beta']);
    const prog = c.sent.filter((m) => m.method === 'notifications/progress');
    assert.equal(prog.length, 2);
    assert.deepEqual([prog[1].params.progressToken, prog[1].params.progress, prog[1].params.total], ['p1', 2, 2]);

    const f = data(await c.call('gutcheck_findings', { repo: 'beta', severity: 'warn' }));
    assert.ok(f.findings.some((x) => x.id === 'git-dirty' && x.fix && x.fix.type === 'commit-all'));
    assert.ok(f.findings.every((x) => x.severity !== 'info'));
    assert.match((await c.call('gutcheck_repo', { repo: 'nope' })).content[0].text, /No repo "nope".*alpha, beta/);
    const rep = await c.call('gutcheck_report', { repo: path.join(root, 'beta') });
    assert.match(rep.content[0].text, /^# GutCheck report: beta/);
    assert.equal(rep.structuredContent, undefined, 'Markdown comes back as text');
    assert.deepEqual(Object.keys(data(await c.call('gutcheck_actions', {})).actions), Object.keys(ACTION_CATALOG));

    for (const [tool, args] of [['gutcheck_plan', { items: [{ repo: 'alpha', action: { type: 'fetch' } }] }], ['gutcheck_apply', { tokens: ['x'] }]]) {
      const r = await c.call(tool, args);
      assert.equal(r.isError, true, tool);
      assert.match(r.content[0].text, /--allow-actions/);
    }
  } finally { cleanup(root, dataD); }
});

test('with --allow-actions: plan from a finding or an action, apply exactly once, danger needs the repo name, history records it', async () => {
  const root = workspace();
  const dataD = tmp('gutcheck-data-');
  try {
    const c = client(createEngine({ env: envFor(dataD), allowActions: true, via: 'mcp' }));
    await c.req('initialize', {});
    await c.call('gutcheck_overview', { root });

    // A finding's own fix, with the parameter it needs.
    const p1 = data(await c.call('gutcheck_plan', { items: [{ repo: 'beta', finding: 'git-dirty', params: { message: 'Add new.txt' } }, { repo: 'beta', finding: 'no-such' }] }));
    assert.equal(p1.plans[0].ok, true);
    assert.ok(p1.plans[0].commands.some((x) => /git commit -m 'Add new\.txt'/.test(x)));
    assert.match(p1.plans[1].error, /No finding "no-such"/);
    const a1 = data(await c.call('gutcheck_apply', { tokens: [p1.plans[0].token] }));
    assert.equal(a1.ok, true);
    assert.equal(sh(path.join(root, 'beta'), 'log', '-1', '--format=%s'), 'Add new.txt');
    const again = await c.call('gutcheck_apply', { tokens: [p1.plans[0].token] });
    assert.equal(again.isError, true);
    assert.match(again.structuredContent.results[0].error, /expired/, 'a token runs once');

    // A dangerous plan is refused without the repo name, and runs with it.
    sh(path.join(root, 'alpha'), 'branch', 'scratch');
    await c.call('gutcheck_overview', { root, rescan: true });
    const p2 = data(await c.call('gutcheck_plan', { items: [{ repo: 'alpha', action: { type: 'delete-local', branch: 'scratch', force: true } }] }));
    const plan = p2.plans[0];
    assert.equal(plan.risk, 'danger');
    assert.equal(plan.confirmName, 'alpha');
    const refused = data(await c.call('gutcheck_apply', { tokens: [plan.token], confirm: { [plan.token]: 'beta' } }));
    assert.match(refused.results[0].error, /confirm it by passing the repo name "alpha"/);
    assert.match(sh(path.join(root, 'alpha'), 'branch'), /scratch/, 'nothing ran');
    const p3 = data(await c.call('gutcheck_plan', { items: [{ repo: 'alpha', action: { type: 'delete-local', branch: 'scratch', force: true } }] })).plans[0];
    assert.equal(data(await c.call('gutcheck_apply', { tokens: [p3.token], confirm: { [p3.token]: 'alpha' } })).ok, true);
    assert.doesNotMatch(sh(path.join(root, 'alpha'), 'branch'), /scratch/);

    const h = data(await c.call('gutcheck_history', { limit: 5 }));
    assert.equal(h.entries.length, 2);
    assert.ok(h.entries.every((e) => e.via === 'mcp'));
  } finally { cleanup(root, dataD); }
});

test('the app\'s Read-only switch also stops a server started with --allow-actions', async () => {
  const root = workspace();
  const dataD = tmp('gutcheck-data-');
  try {
    fs.writeFileSync(path.join(dataD, 'settings.json'), JSON.stringify({ readOnly: true, root }));
    const c = client(createEngine({ env: envFor(dataD), allowActions: true }));
    await c.req('initialize', {});
    const r = await c.call('gutcheck_plan', { items: [{ repo: 'alpha', action: { type: 'fetch' } }] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Read-only mode is on/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataD, 'settings.json'), 'utf8')).readOnly, true, 'the server never changes it');
  } finally { cleanup(root, dataD); }
});

test('stdio transport: line-delimited JSON, parse errors answered, in-flight work finishes after stdin closes', async () => {
  const dataD = tmp('gutcheck-data-');
  const prev = process.env.GUTCHECK_DATA_DIR;
  process.env.GUTCHECK_DATA_DIR = dataD;
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const logStream = new PassThrough();
    let out = '';
    output.on('data', (c) => { out += c; });
    const done = start({ input, output, logStream });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    input.write('not json\n\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gutcheck_actions","arguments":{}}}\n');
    await done;
    const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(msgs.map((m) => m.id), [1, null, 2]);
    assert.equal(msgs[1].error.code, -32700);
    assert.equal(msgs[2].result.isError, false);
    assert.ok(!out.includes('[gutcheck-mcp]'), 'logs never go to stdout');
  } finally {
    if (prev === undefined) delete process.env.GUTCHECK_DATA_DIR; else process.env.GUTCHECK_DATA_DIR = prev;
    cleanup(dataD);
  }
});

test('cli: argument parsing, help, version, unknown command, fix previews without running', async () => {
  assert.deepEqual(parseArgs(['fix', 'r', 'x', '--root', '/w', '--yes', '--confirm=r', 'a=1']), { _: ['fix', 'r', 'x', 'a=1'], flags: { root: '/w', yes: true, confirm: 'r' } });
  assert.deepEqual([parseValue('branches', 'a, b'), parseValue('force', 'true'), parseValue('number', '12'), parseValue('message', 'hi=there')], [['a', 'b'], true, 12, 'hi=there']);
  const run = async (argv, env) => { const o = []; const e = []; const code = await main(argv, { out: (s) => o.push(s), err: (s) => e.push(s), env }); return { code, out: o.join('\n'), err: e.join('\n') }; };
  assert.match((await run(['--help'])).out, /gutcheck <command>/);
  assert.equal((await run([])).code, 1);
  assert.match((await run(['--version'])).out, /^\d+\.\d+\.\d+/);

  const root = workspace();
  const dataD = tmp('gutcheck-data-');
  try {
    const env = envFor(dataD);
    assert.match((await run(['bogus', '--root', root], env)).err, /unknown command "bogus"/);
    const prev = await run(['fix', 'alpha', 'create-branch', 'name=feat', '--root', root], env);
    assert.equal(prev.code, 0);
    assert.match(prev.out, /\$ git switch -c feat/);
    assert.match(prev.out, /Nothing was run/);
    assert.doesNotMatch(sh(path.join(root, 'alpha'), 'branch'), /feat/);
    const ran = await run(['fix', 'alpha', 'create-branch', 'name=feat', '--root', root, '--yes'], env);
    assert.equal(ran.code, 0, ran.err);
    assert.match(sh(path.join(root, 'alpha'), 'branch'), /feat/);
    const list = await run(['scan', root], env);
    assert.match(list.out, /2 repos/);
    assert.match((await run(['history'], env)).out, /alpha: Create and switch to feat.*\(cli\)/);
  } finally { cleanup(root, dataD); }
});

test('secrets over MCP: read-only list with titles and statuses only; backing up is refused even with --allow-actions', async () => {
  const root = workspace();
  const home = tmp('gutcheck-mcphome-');
  const dataD = tmp('gutcheck-data-');
  try {
    fs.writeFileSync(path.join(root, 'alpha', '.env'), 'API_TOKEN=mcp-hunter2\n');
    fs.mkdirSync(path.join(home, '.aws'));
    fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key=mcp-hunter3\n');
    const c = client(createEngine({ env: { ...envFor(dataD), HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, allowActions: true, via: 'mcp' }));
    await c.req('initialize', { protocolVersion: PROTOCOLS[0] });
    const tool = (await c.req('tools/list')).result.tools.find((t) => t.name === 'gutcheck_secrets');
    assert.ok(tool, 'gutcheck_secrets is listed');
    assert.equal(tool.annotations.readOnlyHint, true);
    await c.call('gutcheck_overview', { root });
    const r = await c.call('gutcheck_secrets', {});
    assert.equal(r.isError, false, r.content[0].text);
    const d = data(r);
    assert.equal(d.linked, false);
    const titles = d.items.map((x) => x.title).sort();
    assert.deepEqual(titles, ['gutcheck: home ~/.aws/credentials', 'gutcheck: repo alpha/.env']);
    for (const x of d.items) assert.deepEqual(Object.keys(x).sort(), ['confidence', 'kind', 'status', 'title']);
    const txt = r.content[0].text;
    for (const bad of [root, home, 'sha256', 'hunter']) assert.ok(!txt.includes(bad), bad);
    assert.ok(d.advice.length >= 2);

    const p = await c.call('gutcheck_plan', { items: [{ secretBackup: ['/x'] }] });
    assert.equal(p.isError, true);
    assert.match(p.content[0].text, /only from the GutCheck app or CLI/);
    const a = await c.call('gutcheck_apply', { tokens: ['s:0123456789abcdef0123456789abcdef'] });
    assert.match(a.content[0].text, /only from the GutCheck app or CLI/);
  } finally { cleanup(root, home, dataD); }
});
