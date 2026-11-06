// Settings > AI agents: register GutCheck's MCP server with the coding agents installed here.
// Like every other change, a connection is planned first (the exact command, or the exact JSON
// written into the client's config file), shown to the user, and only then applied. Config files
// are merged (other servers and keys are kept), written atomically, and backed up once first.
// Files that do not parse as plain JSON (VS Code allows comments) are never rewritten: the user
// gets the snippet to paste instead.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./exec');

const NAME = 'gutcheck';
const PLAN_TTL = 5 * 60 * 1000;

// How to start GutCheck's MCP server from outside: the AppImage, the installed app, or (from a
// source checkout) Electron with the app folder. `entry` is the app's own launch info.
function serverCommand({ env = process.env, execPath = process.execPath, isPackaged = false, appPath = '' } = {}, allowActions = false) {
  const flags = ['--mcp', ...(allowActions ? ['--allow-actions'] : [])];
  if (env.APPIMAGE) return { command: env.APPIMAGE, args: flags };
  if (isPackaged) return { command: execPath, args: flags };
  return { command: execPath, args: [appPath, ...flags] };
}

const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
const show = (argv) => argv.map(quote).join(' ');

// Per-platform config folders (Electron-style app data on each OS).
function dirs(home, platform, env) {
  const appData = platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming')) : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return { appData };
}

// Each client: how it is found (formats checked against each tool's docs; Windsurf and Zed are left
// out until their config locations are documented), and either a CLI (add/remove/check) or a JSON config file.
// `entry(cmd)` is the server object in that client's format; `key` its top-level map.
function clients(home = os.homedir(), platform = process.platform, env = process.env) {
  const { appData } = dirs(home, platform, env);
  const stdio = (c) => ({ command: c.command, args: c.args });
  return [
    { id: 'claude-code', name: 'Claude Code', kind: 'cli', bin: 'claude',
      add: (c) => ['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'user', NAME, '--', c.command, ...c.args],
      remove: () => ['claude', 'mcp', 'remove', NAME, '--scope', 'user'],
      configured: () => hasKey(path.join(home, '.claude.json'), 'mcpServers'),
      docs: 'https://code.claude.com/docs/en/mcp' },
    { id: 'codex', name: 'Codex CLI', kind: 'cli', bin: 'codex',
      add: (c) => ['codex', 'mcp', 'add', NAME, '--', c.command, ...c.args],
      remove: () => ['codex', 'mcp', 'remove', NAME],
      configured: () => { try { return /^\s*\[mcp_servers\.gutcheck\]/m.test(fs.readFileSync(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), 'utf8')); } catch { return false; } },
      docs: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli' },
    { id: 'claude-desktop', name: 'Claude Desktop', kind: 'json', file: path.join(appData, 'Claude', 'claude_desktop_config.json'), present: path.join(appData, 'Claude'), key: 'mcpServers', entry: stdio, restart: true,
      docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers' },
    { id: 'cursor', name: 'Cursor', kind: 'json', file: path.join(home, '.cursor', 'mcp.json'), present: path.join(home, '.cursor'), key: 'mcpServers', entry: (c) => ({ type: 'stdio', ...stdio(c) }),
      docs: 'https://cursor.com/docs/context/mcp' },
    { id: 'vscode', name: 'VS Code (Copilot)', kind: 'json', file: path.join(appData, 'Code', 'User', 'mcp.json'), present: path.join(appData, 'Code', 'User'), key: 'servers', entry: (c) => ({ type: 'stdio', ...stdio(c) }),
      docs: 'https://code.visualstudio.com/docs/copilot/reference/mcp-configuration' },
    { id: 'gemini', name: 'Gemini CLI', kind: 'json', file: path.join(home, '.gemini', 'settings.json'), present: path.join(home, '.gemini'), key: 'mcpServers', entry: stdio,
      docs: 'https://geminicli.com/docs/tools/mcp-server/' },
  ];
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { missing: true, data: {} } : { error: `Cannot read ${file}: ${e.message}` }; }
  if (!text.trim()) return { data: {} };
  try { const d = JSON.parse(text); return isObj(d) ? { data: d } : { error: `${file} is not a JSON object.` }; } catch { return { error: `${file} is not plain JSON (it may contain comments), so GutCheck will not rewrite it. Paste the snippet instead.` }; }
}
function hasKey(file, key) { const r = readJson(file); return !!(r.data && isObj(r.data[key]) && r.data[key][NAME]); }

const executable = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
const onPath = (bin, env = process.env) => (env.PATH || '').split(path.delimiter).some((d) => d && executable(path.join(d, bin)));
const verKey = (v) => v.split('.').map((n) => String(parseInt(n, 10) || 0).padStart(6, '0')).join('.');

// The program to run for a CLI client: on PATH, or (Claude Code) the copy bundled with Claude Desktop,
// newest version first: <appData>/Claude/claude-code/<version>/<build>/claude.
function findBin(c, env, appData) {
  if (onPath(c.bin, env)) return c.bin;
  if (c.id !== 'claude-code') return null;
  const root = path.join(appData, 'Claude', 'claude-code');
  let versions = [];
  try { versions = fs.readdirSync(root).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => (verKey(a) < verKey(b) ? 1 : -1)); } catch {}
  for (const v of versions) {
    let builds = [];
    try { builds = fs.readdirSync(path.join(root, v)); } catch {}
    for (const b of builds) { const f = path.join(root, v, b, platformExe('claude')); if (executable(f)) return f; }
  }
  return null;
}
const platformExe = (n) => (process.platform === 'win32' ? n + '.exe' : n);

// The snippet a user can paste by hand, for any client.
function snippet(client, cmd) {
  if (client.kind === 'cli') return show(client.add(cmd));
  return JSON.stringify({ [client.key]: { [NAME]: client.entry(cmd) } }, null, 2);
}

// opts: { home, platform, env, launch: { env, execPath, isPackaged, appPath }, runner, audit }
function createAgentConnect(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const runner = opts.runner || run;
  const audit = opts.audit || (() => {});
  const plans = new Map();
  const list = () => clients(home, platform, env);
  const { appData } = dirs(home, platform, env);
  const cmdFor = (allow) => serverCommand(opts.launch || {}, !!allow);

  function status(allowActions = false) {
    const cmd = cmdFor(allowActions);
    const claudeSettings = fs.existsSync(path.join(home, '.claude')) ? (readJson(path.join(home, '.claude', 'settings.json')).data || {}) : null;
    return {
      // null when not set (the default, 30), undefined when Claude Code is not set up here.
      cleanupPeriodDays: claudeSettings ? (Number.isInteger(claudeSettings.cleanupPeriodDays) ? claudeSettings.cleanupPeriodDays : null) : undefined,
      command: show([cmd.command, ...cmd.args]),
      clients: list().map((c) => {
        const installed = c.kind === 'cli' ? !!findBin(c, env, appData) : fs.existsSync(c.present);
        let configured = false;
        try { configured = c.kind === 'cli' ? !!c.configured() : hasKey(c.file, c.key); } catch {}
        return { id: c.id, name: c.name, kind: c.kind, installed, configured, file: c.file || null, docs: c.docs, snippet: snippet(c, cmd) };
      }),
    };
  }

  // Plan connecting (or disconnecting) one client. Nothing is changed here.
  function plan(id, { allowActions = false, remove = false } = {}) {
    const c = list().find((x) => x.id === id);
    if (!c) return { ok: false, error: 'Unknown agent.' };
    const cmd = cmdFor(allowActions);
    let p;
    if (c.kind === 'cli') {
      const bin = findBin(c, env, appData);
      if (!bin) return { ok: false, error: `${c.name} (${c.bin}) was not found on your PATH. Run this yourself once it is installed:\n${snippet(c, cmd)}` };
      const withBin = (argv) => [bin, ...argv.slice(1)];
      const argv = withBin(remove ? c.remove() : c.add(cmd));
      // Re-adding replaces the old entry: remove first (a missing entry is fine).
      const steps = remove ? [{ kind: 'cmd', argv }] : [{ kind: 'cmd', argv: withBin(c.remove()), optional: true }, { kind: 'cmd', argv }];
      p = { title: `${remove ? 'Disconnect GutCheck from' : 'Connect GutCheck to'} ${c.name}`, steps, display: steps.map((s) => show(s.argv) + (s.optional ? '   # only if already added' : '')) };
    } else {
      const r = readJson(c.file);
      if (r.error) return { ok: false, error: r.error, snippet: snippet(c, cmd) };
      const next = { ...r.data, [c.key]: { ...(isObj(r.data[c.key]) ? r.data[c.key] : {}) } };
      if (remove) { if (!next[c.key][NAME]) return { ok: false, error: `GutCheck is not in ${c.file}.` }; delete next[c.key][NAME]; }
      else next[c.key][NAME] = c.entry(cmd);
      const content = JSON.stringify(next, null, 2) + '\n';
      const steps = [{ kind: 'json', file: c.file, content, backup: !r.missing }];
      p = { title: `${remove ? 'Remove GutCheck from' : 'Add GutCheck to'} ${c.name}`, steps, display: [`${r.missing ? 'create' : 'update'} ${c.file}${r.missing ? '' : ` (backup: ${path.basename(c.file)}.gutcheck.bak)`}`], preview: remove ? null : JSON.stringify({ [c.key]: { [NAME]: c.entry(cmd) } }, null, 2), note: c.restart ? `Restart ${c.name} to pick it up.` : null };
    }
    const token = crypto.randomBytes(16).toString('hex');
    plans.set(token, { ...p, client: c, expires: Date.now() + PLAN_TTL });
    for (const [t, v] of plans) if (v.expires < Date.now()) plans.delete(t);
    return { ok: true, token, title: p.title, display: p.display, preview: p.preview || null, note: p.note || null, allowActions: !!allowActions };
  }

  // Claude Code's cleanupPeriodDays (how long session history is kept), merged into ~/.claude/settings.json.
  function planCleanup(days) {
    if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, error: 'Choose a number of days from 1 to 365.' };
    const file = path.join(home, '.claude', 'settings.json');
    if (!fs.existsSync(path.join(home, '.claude'))) return { ok: false, error: 'Claude Code is not set up for this user.' };
    const r = readJson(file);
    if (r.error) return { ok: false, error: r.error };
    const content = JSON.stringify({ ...r.data, cleanupPeriodDays: days }, null, 2) + '\n';
    const p = { title: `Keep Claude Code session history for ${days} days`, steps: [{ kind: 'json', file, content, backup: !r.missing }], display: [`${r.missing ? 'create' : 'update'} ${file}: "cleanupPeriodDays": ${days}${r.data.cleanupPeriodDays != null ? ` (was ${r.data.cleanupPeriodDays})` : ' (default was 30)'}`], note: 'Claude Code removes older sessions the next time it starts. Sessions older than this can no longer be resumed.', client: { name: 'Claude Code', file } };
    const token = crypto.randomBytes(16).toString('hex');
    plans.set(token, { ...p, expires: Date.now() + PLAN_TTL });
    return { ok: true, token, title: p.title, display: p.display, preview: null, note: p.note, allowActions: false };
  }

  async function apply(token) {
    const p = plans.get(token);
    plans.delete(token); // single use
    if (!p || p.expires < Date.now()) return { ok: false, error: 'Plan expired. Please review it again.' };
    const results = [];
    let ok = true;
    for (const s of p.steps) {
      if (s.kind === 'cmd') {
        const r = await runner(s.argv[0], s.argv.slice(1), { cwd: home });
        results.push({ text: show(s.argv), ok: r.ok || !!s.optional, out: (r.stdout + r.stderr).trim().slice(0, 2000) });
        if (!r.ok && !s.optional) { ok = false; break; }
      } else {
        try {
          fs.mkdirSync(path.dirname(s.file), { recursive: true });
          const bak = s.file + '.gutcheck.bak';
          if (s.backup && !fs.existsSync(bak)) fs.copyFileSync(s.file, bak); // the user's original, kept once
          fs.writeFileSync(s.file + '.tmp', s.content, { mode: 0o600 });
          fs.renameSync(s.file + '.tmp', s.file);
          results.push({ text: `wrote ${s.file}`, ok: true, out: '' });
        } catch (e) { results.push({ text: `write ${s.file}`, ok: false, out: String(e.message) }); ok = false; }
      }
    }
    audit({ repo: p.client.name, path: p.client.file || p.client.bin, action: 'agent-connect', risk: 'caution', title: p.title, ok, steps: results.map((x) => ({ cmd: x.text, ok: x.ok })) });
    return { ok, title: p.title, results, note: p.note || null };
  }

  return { status, plan, planCleanup, apply };
}

module.exports = { createAgentConnect, serverCommand, clients, snippet, NAME };
