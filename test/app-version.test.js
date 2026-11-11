// The unpacked copy agents run (mcp-app/<version>/) knows when the installed app is newer, an update
// trashes copies no agent uses any more, and agents get plans that outlast asking their user.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordAppVersion, outdatedNotice, staleCopies } = require('../src/app-version');
const { createAgentConnect } = require('../src/agent-connect');
const { createServer } = require('../src/mcp');
const { createService, AGENT_PLAN_TTL } = require('../src/service');
const { version } = require('../package.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-ver-'));
const put = (f, t = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

test('the MCP copy tells agents when the installed app is newer, and only then', async () => {
  const data = tmp();
  try {
    assert.equal(outdatedNotice(data, '0.17.1'), null, 'no record: no notice');
    recordAppVersion(data, '0.27.1');
    assert.match(outdatedNotice(data, '0.17.1'), /GutCheck 0\.17\.1, but GutCheck 0\.27\.1 is installed.*Settings > AI agents.*Update/);
    assert.equal(outdatedNotice(data, '0.27.1'), null);
    assert.equal(outdatedNotice(data, '0.28.0'), null, 'a newer copy than the app is not "outdated"');

    recordAppVersion(data, '999.0.0');
    const sent = [];
    const engine = { dataDir: data, allowActions: false, repos: async () => ({ ok: true, repos: [] }) };
    const server = createServer({ engine, send: (m) => sent.push(m) });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.match(sent[0].result.instructions, new RegExp(`GutCheck ${version.replace(/\./g, '\\.')}, but GutCheck 999\\.0\\.0 is installed`));
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gutcheck_overview', arguments: {} } });
    assert.match(sent[1].result.structuredContent.notice, /999\.0\.0 is installed/);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('connecting a new version trashes unpacked copies no other agent runs', async () => {
  const home = tmp();
  try {
    const data = path.join(home, 'data');
    const copy = (v) => path.join(data, 'mcp-app', v, 'squashfs-root', 'gutcheck');
    for (const v of ['0.17.0', '0.17.1', '0.20.0']) put(copy(v));
    // Cursor still runs 0.20.0; Gemini runs 0.17.1 and is the one being updated; nobody runs 0.17.0.
    put(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { gutcheck: { command: copy('0.20.0'), args: ['--mcp'] } } }));
    put(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { gutcheck: { command: copy('0.17.1'), args: ['--mcp'] } } }));
    assert.deepEqual(staleCopies(data, '0.27.1', [copy('0.20.0')]).map((x) => path.basename(x.path)).sort(), ['0.17.0', '0.17.1']);

    const trashed = [];
    const launch = { env: { APPIMAGE: '/apps/GutCheck.AppImage' }, execPath: '/tmp/.mount_x/gutcheck', dataDir: data, version: '0.27.1' };
    const runner = async (cmd, args, o) => { if (args[0] === '--appimage-extract') put(path.join(o.cwd, 'squashfs-root', 'gutcheck')); return { ok: true, stdout: '', stderr: '' }; };
    const ac = createAgentConnect({ home, platform: 'linux', env: { PATH: '' }, launch, runner, trash: async (p) => { trashed.push(path.basename(p)); fs.rmSync(p, { recursive: true }); } });
    const p = ac.plan('gemini', {});
    const shown = p.display.filter((d) => d.includes('to the trash'));
    assert.equal(shown.length, 2, p.display.join('\n'));
    assert.ok(shown.every((d) => /old unpacked copy ~\/data\/mcp-app\/0\.17\.[01] to the trash \(no agent uses it\)/.test(d)), shown.join('\n'));
    const r = await ac.apply(p.token);
    assert.equal(r.ok, true, JSON.stringify(r.results));
    assert.deepEqual(trashed.sort(), ['0.17.0', '0.17.1']);
    assert.ok(fs.existsSync(copy('0.20.0')), 'the copy another agent runs is kept');
    assert.ok(fs.existsSync(copy('0.27.1')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('plans made for an agent last 30 minutes; the app and CLI keep 5', async () => {
  assert.equal(AGENT_PLAN_TTL, 30 * 60 * 1000);
  const dir = tmp();
  try {
    put(path.join(dir, 'x.tmp'));
    const known = new Map([[dir, { path: dir, name: 'r', findings: [] }]]);
    const mk = (planTtl) => createService({ known, settings: () => ({ readOnly: false }), audit() {}, trash: async () => {}, planTtl });
    const svc = mk(-1);
    const [q] = await svc.planActions([{ dir, action: { type: 'clean-clutter', paths: ['x.tmp'] } }]);
    assert.equal(q.ok, true, JSON.stringify(q));
    const [r] = await svc.applyActions([q.token]);
    assert.match(r.error, /^Plan expired \(plans last 0 minutes\)\. Plan it again and review it\.$/);
    assert.ok(fs.existsSync(path.join(dir, 'x.tmp')), 'nothing ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
