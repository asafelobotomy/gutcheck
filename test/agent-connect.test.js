const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentConnect, serverCommand, clients } = require('../src/agent-connect');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-ac-'));
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const LAUNCH = { env: { APPIMAGE: '/apps/GutCheck.AppImage' } };

function setup({ bins = [] } = {}) {
  const home = tmp();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const b of bins) { fs.writeFileSync(path.join(bin, b), '#!/bin/sh\n'); fs.chmodSync(path.join(bin, b), 0o755); }
  const ran = [];
  const audits = [];
  const ac = createAgentConnect({ home, platform: 'linux', env: { PATH: bin }, launch: LAUNCH, runner: async (cmd, args) => { ran.push([cmd, ...args]); return { ok: !(args[1] === 'remove' && cmd === 'claude' && ran.length === 1), stdout: '', stderr: '' }; }, audit: (e) => audits.push(e) });
  return { home, ac, ran, audits };
}

test('serverCommand: the AppImage, the installed app, or Electron with the app folder', () => {
  assert.deepEqual(serverCommand(LAUNCH), { command: '/apps/GutCheck.AppImage', args: ['--mcp'] });
  assert.deepEqual(serverCommand({ env: {}, execPath: '/opt/gc/gutcheck', isPackaged: true }, true), { command: '/opt/gc/gutcheck', args: ['--mcp', '--allow-actions'] });
  assert.deepEqual(serverCommand({ env: {}, execPath: '/n/electron', isPackaged: false, appPath: '/src/gutcheck' }), { command: '/n/electron', args: ['/src/gutcheck', '--mcp'] });
});

test('client formats follow each tool\'s docs', () => {
  const by = Object.fromEntries(clients('/h', 'linux', {}).map((c) => [c.id, c]));
  const cmd = { command: '/a', args: ['--mcp'] };
  assert.deepEqual(by['claude-code'].add(cmd), ['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'gutcheck', '--', '/a', '--mcp']);
  assert.deepEqual(by.codex.add(cmd), ['codex', 'mcp', 'add', 'gutcheck', '--', '/a', '--mcp']);
  assert.equal(by['claude-desktop'].file, '/h/.config/Claude/claude_desktop_config.json');
  assert.deepEqual([by.vscode.key, by.vscode.entry(cmd).type], ['servers', 'stdio']);
  assert.deepEqual(by.cursor.entry(cmd), { type: 'stdio', command: '/a', args: ['--mcp'] });
  assert.equal(by.gemini.file, '/h/.gemini/settings.json');
  assert.equal(clients('/h', 'darwin', {}).find((c) => c.id === 'claude-desktop').file, '/h/Library/Application Support/Claude/claude_desktop_config.json');
  assert.equal(clients('/h', 'win32', { APPDATA: 'C:/R' }).find((c) => c.id === 'vscode').file, path.join('C:/R', 'Code', 'User', 'mcp.json'));
});

test('a JSON client: planning changes nothing; apply merges, keeps other servers and keys, backs up once; disconnect removes only ours', async () => {
  const { home, ac, audits } = setup();
  const file = path.join(home, '.cursor', 'mcp.json');
  put(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  const before = fs.readFileSync(file, 'utf8');
  let st = ac.status();
  const cur = st.clients.find((c) => c.id === 'cursor');
  assert.deepEqual([cur.installed, cur.configured], [true, false]);
  assert.match(st.command, /GutCheck\.AppImage --mcp$/);

  const p = ac.plan('cursor', { allowActions: true });
  assert.equal(p.ok, true);
  assert.match(p.preview, /--allow-actions/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'planning writes nothing');
  const r = await ac.apply(p.token);
  assert.equal(r.ok, true);
  const now = read(file);
  assert.deepEqual(now.mcpServers.other, { command: 'x' });
  assert.equal(now.theme, 'dark');
  assert.deepEqual(now.mcpServers.gutcheck, { type: 'stdio', command: '/apps/GutCheck.AppImage', args: ['--mcp', '--allow-actions'] });
  assert.equal(fs.readFileSync(file + '.gutcheck.bak', 'utf8'), before);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.equal((await ac.apply(p.token)).ok, false, 'a plan runs once');
  assert.equal(ac.status().clients.find((c) => c.id === 'cursor').configured, true);

  await ac.apply(ac.plan('cursor', {}).token); // update: read-only now
  assert.deepEqual(read(file).mcpServers.gutcheck.args, ['--mcp']);
  assert.equal(fs.readFileSync(file + '.gutcheck.bak', 'utf8'), before, 'the first backup is kept');
  await ac.apply(ac.plan('cursor', { remove: true }).token);
  assert.deepEqual(read(file), { mcpServers: { other: { command: 'x' } }, theme: 'dark' });
  assert.equal(ac.plan('cursor', { remove: true }).ok, false);
  assert.equal(audits.length, 3);
  assert.ok(audits.every((a) => a.action === 'agent-connect'));
});

test('a JSON client with comments is never rewritten; a missing file is created; unknown ids are refused', async () => {
  const { home, ac } = setup();
  const vs = path.join(home, '.config', 'Code', 'User', 'mcp.json');
  put(vs, '// my servers\n{ "servers": {} }');
  const p = ac.plan('vscode', {});
  assert.equal(p.ok, false);
  assert.match(p.error, /not plain JSON/);
  assert.match(p.snippet, /"servers"/);
  const gem = path.join(home, '.gemini', 'settings.json');
  const g = ac.plan('gemini', {});
  assert.equal(g.ok, true);
  assert.match(g.display[0], /^create /);
  await ac.apply(g.token);
  assert.deepEqual(read(gem), { mcpServers: { gutcheck: { command: '/apps/GutCheck.AppImage', args: ['--mcp'] } } });
  assert.equal(ac.plan('nope', {}).ok, false);
});

test('a CLI client: refused when not installed (with the command to run), otherwise remove-then-add', async () => {
  const none = setup();
  const p0 = none.ac.plan('claude-code', {});
  assert.equal(p0.ok, false);
  assert.match(p0.error, /not found on your PATH.*\nclaude mcp add --transport stdio --scope user gutcheck -- \/apps\/GutCheck\.AppImage --mcp/s);

  const { ac, ran } = setup({ bins: ['claude'] });
  const p = ac.plan('claude-code', { allowActions: true });
  assert.deepEqual(p.display, ['claude mcp remove gutcheck --scope user   # only if already added', 'claude mcp add --transport stdio --scope user gutcheck -- /apps/GutCheck.AppImage --mcp --allow-actions']);
  assert.equal(ran.length, 0);
  const r = await ac.apply(p.token);
  assert.equal(r.ok, true, 'a failed optional remove (nothing to remove) does not fail the connect');
  assert.deepEqual(ran.map((a) => a.slice(0, 3)), [['claude', 'mcp', 'remove'], ['claude', 'mcp', 'add']]);
});

test('Claude Code bundled with Claude Desktop is used when claude is not on PATH (newest version)', () => {
  const { home } = setup();
  for (const v of ['2.1.9', '2.1.317']) {
    const f = path.join(home, '.config', 'Claude', 'claude-code', v, 'b1', 'claude');
    put(f, '#!/bin/sh\n');
    fs.chmodSync(f, 0o755);
  }
  const ac = createAgentConnect({ home, platform: 'linux', env: { PATH: '' }, launch: LAUNCH, runner: async () => ({ ok: true, stdout: '', stderr: '' }) });
  assert.equal(ac.status().clients.find((c) => c.id === 'claude-code').installed, true);
  const p = ac.plan('claude-code', {});
  assert.match(p.display[1], new RegExp(`^${path.join(home, '.config', 'Claude', 'claude-code', '2.1.317', 'b1', 'claude').replace(/[.]/g, '\\.')} mcp add `));
});

test('from an AppImage, agents get an unpacked copy (no FUSE under NoNewPrivs): unpacked once, then registered; an old registration shows as outdated', async () => {
  const home = tmp();
  const data = path.join(home, 'data');
  const launch = { env: { APPIMAGE: '/apps/GutCheck.AppImage' }, execPath: '/tmp/.mount_x/gutcheck', dataDir: data, version: '9.9.9' };
  const unpacked = path.join(data, 'mcp-app', '9.9.9', 'squashfs-root', 'gutcheck');
  assert.deepEqual(serverCommand(launch, true), { command: unpacked, args: ['--mcp', '--allow-actions'], unpack: { appimage: '/apps/GutCheck.AppImage', dir: path.join(data, 'mcp-app', '9.9.9') } });

  const ran = [];
  const runner = async (cmd, args, o) => {
    ran.push([cmd, ...args]);
    if (args[0] === '--appimage-extract') put(path.join(o.cwd, 'squashfs-root', 'gutcheck'), '#!/bin/sh\n'); // what the AppImage runtime does
    return { ok: true, stdout: 'squashfs-root/a\nsquashfs-root/b\n', stderr: '' };
  };
  const cursor = path.join(home, '.cursor', 'mcp.json');
  put(cursor, JSON.stringify({ mcpServers: { gutcheck: { command: '/apps/GutCheck.AppImage', args: ['--mcp'] } } }));
  const ac = createAgentConnect({ home, platform: 'linux', env: { PATH: '' }, launch, runner });
  let c = ac.status().clients.find((x) => x.id === 'cursor');
  assert.deepEqual([c.configured, c.outdated], [true, true], 'registered with the AppImage, which agents cannot mount');
  assert.match(c.snippet, /"command": "\/apps\/GutCheck\.AppImage"/, 'until unpacked, Copy gives the AppImage (fine in a terminal)');

  const p = ac.plan('cursor', {});
  assert.match(p.display[0], /^unpack GutCheck once into .*mcp-app\/9\.9\.9 \(agents cannot mount AppImages: NoNewPrivs blocks FUSE\)$/);
  assert.equal(ran.length, 0, 'planning runs nothing');
  const r = await ac.apply(p.token);
  assert.equal(r.ok, true);
  assert.deepEqual(ran, [['/apps/GutCheck.AppImage', '--appimage-extract']]);
  assert.deepEqual(read(cursor).mcpServers.gutcheck, { type: 'stdio', command: unpacked, args: ['--mcp'] });
  c = ac.status().clients.find((x) => x.id === 'cursor');
  assert.deepEqual([c.configured, c.outdated], [true, false]);
  assert.ok(!r.results[0].out, 'the long list of unpacked files is not shown');

  const again = ac.plan('cursor', {});
  assert.ok(!again.display.some((d) => d.startsWith('unpack')), 'already unpacked: not done twice');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a JSON client file changed after the preview is not overwritten; a symlinked config stays a symlink', async () => {
  const { home, ac } = setup();
  const real = path.join(home, 'dotfiles', 'mcp.json');
  put(real, JSON.stringify({ mcpServers: {} }));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const file = path.join(home, '.cursor', 'mcp.json');
  fs.symlinkSync(real, file);
  const p = ac.plan('cursor', {});
  fs.writeFileSync(real, JSON.stringify({ mcpServers: { added: { command: 'y' } } })); // the agent rewrote it meanwhile
  const r = await ac.apply(p.token);
  assert.equal(r.ok, false);
  assert.match(r.results.at(-1).out, /changed since the preview/);
  assert.deepEqual(read(real).mcpServers, { added: { command: 'y' } }, 'the newer content is kept');
  assert.equal((await ac.apply(ac.plan('cursor', {}).token)).ok, true);
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'written through the link');
  assert.ok(read(real).mcpServers.gutcheck && read(real).mcpServers.added);
});
