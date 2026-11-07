// Opt-in: which Claude Code skills, plugins and MCP servers are actually used, and (with a second,
// separate permission) whether each MCP server works. Two consents, asked each time:
//  1. usage: reads Claude Code's session transcripts, but only structured fields: tool names
//     (mcp__<server>__*), the skill a Skill tool call names, typed /commands, and Bash commands (only
//     to test permission rules against, in memory). No text is stored, shown or logged.
//  2. live: runs `claude mcp list`, which starts or connects every configured MCP server once to
//     health-check it. Only each server's name, status and a redacted reason are kept: never its
//     command line, URL or arguments, which can hold credentials.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const R = require('./quality/rules');
const projectKey = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-'); // as in agents.js (not imported: agents.js loads this file)
const { classifyRule } = require('./agent-context');

const DAY = 86400000;
const WINDOW_DAYS = 28;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

// ---------------------------------------------------------------- what is configured

function inventory(home, repos = []) {
  const settings = readJson(path.join(home, '.claude', 'settings.json')) || {};
  const ep = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  const inst = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')) || {};
  const plugins = Object.entries(inst.plugins || inst).filter(([, v]) => Array.isArray(v)).map(([id, v]) => {
    const dir = (v[0] && v[0].installPath) || '';
    const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || {};
    const mcp = { ...(manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {}), ...((readJson(path.join(dir, '.mcp.json')) || {}).mcpServers || {}) };
    return { id, name: id.split('@')[0], enabled: ep[id] === true, servers: Object.keys(mcp), skills: dirs(path.join(dir, 'skills')), lsp: !!manifest.lspServers };
  });
  const claude = readJson(path.join(home, '.claude.json')) || {};
  const servers = Object.keys(claude.mcpServers || {}).map((name) => ({ name, scope: 'user', cwd: home }));
  const skills = dirs(path.join(home, '.claude', 'skills')).map((name) => ({ name, scope: 'user', path: path.join(home, '.claude', 'skills', name) }));
  for (const r of repos) {
    const local = ((claude.projects || {})[path.resolve(r.path)] || {}).mcpServers || {};
    for (const name of Object.keys(local)) servers.push({ name, scope: 'local', cwd: r.path, repo: r.name });
    for (const name of Object.keys((readJson(path.join(r.path, '.mcp.json')) || {}).mcpServers || {})) servers.push({ name, scope: 'project', cwd: r.path, repo: r.name });
    for (const name of dirs(path.join(r.path, '.claude', 'skills'))) skills.push({ name, scope: 'project', repo: r.name, repoPath: r.path, path: path.join(r.path, '.claude', 'skills', name) });
  }
  return { plugins, servers, skills };
}

// ---------------------------------------------------------------- what was used (consent 1)

// Bash permission rules match an exact command, or a prefix when they end in :* (or *).
const ruleMatches = (inner, cmd) => (/(:\*|\*)$/.test(inner) ? cmd.startsWith(inner.replace(/:?\*$/, '')) : cmd === inner);

// Streams the last WINDOW_DAYS of transcripts. permRules: { [repoPath]: ['Bash(...)', ...] } to test.
async function usage(home, repos = [], { now = Date.now(), days = WINDOW_DAYS, permRules = {}, onProgress } = {}) {
  const root = path.join(home, '.claude', 'projects');
  const keyToRepo = new Map(repos.map((r) => [projectKey(r.path), r]));
  const out = { sessions: 0, tools: new Map(), servers: new Map(), skills: new Map(), commands: new Map(), perRepo: new Map(), ruleHits: new Map() };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const files = [];
  for (const key of dirs(root)) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, key)).filter((n) => n.endsWith('.jsonl')); } catch {}
    for (const n of names) { const f = path.join(root, key, n); try { if (now - fs.statSync(f).mtimeMs <= days * DAY) files.push({ key, f }); } catch {} }
  }
  let done = 0;
  for (const { key, f } of files) {
    out.sessions++;
    const repo = keyToRepo.get(key);
    const rules = repo ? (permRules[repo.path] || []).map((r) => ({ r, inner: (/^Bash\((.*)\)$/s.exec(r) || [])[1] })).filter((x) => x.inner != null) : [];
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"tool_use"') && !line.includes('command-name')) continue; // cheap filter before parsing
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const content = m && m.message && m.message.content;
      if (typeof content === 'string') { for (const c of content.matchAll(/<command-name>\/?([\w:.-]{1,80})<\/command-name>/g)) bump(out.commands, c[1]); continue; }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b && b.type === 'text' && typeof b.text === 'string') for (const c of b.text.matchAll(/<command-name>\/?([\w:.-]{1,80})<\/command-name>/g)) bump(out.commands, c[1]);
        if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        bump(out.tools, b.name);
        const mm = /^mcp__(.+?)__/.exec(b.name);
        if (mm) bump(out.servers, mm[1]);
        if (b.name === 'Skill' && b.input && typeof b.input.skill === 'string') bump(out.skills, b.input.skill);
        if (repo) bump(out.perRepo, repo.path);
        if (b.name === 'Bash' && rules.length && b.input && typeof b.input.command === 'string') for (const x of rules) if (ruleMatches(x.inner, b.input.command)) bump(out.ruleHits, `${repo.path}|${classifyRule(x.r).hash}`);
      }
    }
    if (onProgress) onProgress(++done, files.length);
  }
  return out;
}

// ---------------------------------------------------------------- does it work (consent 2)

const redact = (s) => { let t = String(s || '').slice(0, 160); for (const w of t.split(/\s+/)) if (w.length >= 16 && (R.secretKinds(w, false).length || /[A-Za-z0-9_+/=-]{32,}/.test(w))) t = t.replace(w, '[redacted]'); return t.replace(/https?:\/\/\S+/g, '[url]'); };

// `claude mcp list` lines: "<name>: <target> - ✔ Connected" / "✘ Failed to connect — why" / needs auth.
function parseMcpList(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const i = Math.max(line.lastIndexOf(' - ✔'), line.lastIndexOf(' - ✘'), line.lastIndexOf(' - ⚠'), line.lastIndexOf(' - !'), line.lastIndexOf(' - ⏸'));
    const c = line.indexOf(': ');
    if (i < 0 || c < 0 || c > i) continue;
    const name = line.slice(0, c).trim();
    const tail = line.slice(i + 3).trim();
    const status = /Connected/i.test(tail) ? 'working' : /auth/i.test(tail) && !/Failed/i.test(tail) ? 'needs-auth' : /Pending approval/i.test(tail) ? 'pending' : /Failed/i.test(tail) && /auth|401|403|unauthori[sz]ed|client registration/i.test(tail) ? 'needs-auth' : 'failed';
    const why = tail.split(/[—-]\s/).slice(1).join(' ').trim();
    out.push({ name, status, reason: why ? redact(why) : '' });
  }
  return out;
}

// runner: (cmd, args, opts) => { ok, stdout, stderr }. cwds: folders to run in (home for user and
// plugin servers, each repo with project or local servers). Returns [{ name, status, reason, cwd }].
async function liveCheck(bin, cwds, runner) {
  const seen = new Map();
  for (const cwd of cwds) {
    const r = await runner(bin, ['mcp', 'list'], { cwd, timeout: 3 * 60 * 1000 });
    for (const s of parseMcpList(r.stdout)) if (!seen.has(`${cwd}|${s.name}`)) seen.set(`${cwd}|${s.name}`, { ...s, cwd });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- what to do about it

// A server's name as it appears in tool names: mcp__<this>__tool ("plugin:github:github" -> plugin_github_github).
const tooled = (name) => name.replace(/[^\w-]/g, '_');

// -> advice items (category "AI agents") with fixes the app can plan and apply.
function verdicts(inv, used, live = null, { home = os.homedir() } = {}) {
  const out = [];
  const add = (id, severity, title, detail, fix) => out.push({ id, category: 'AI agents', severity, title, detail, fix });
  const n = (m, k) => (m && m.get(k)) || 0;
  for (const p of inv.plugins.filter((x) => x.enabled && !x.lsp)) {
    const calls = p.servers.reduce((t, s) => t + n(used.servers, tooled(`plugin:${p.name}:${s}`)) + n(used.servers, tooled(s)), 0) + p.skills.reduce((t, s) => t + n(used.skills, `${p.name}:${s}`) + n(used.skills, s), 0) + n(used.commands, p.name);
    if (!calls) add(`usage-plugin-${p.name}`, 'info', `Plugin ${p.name} was not used in ${WINDOW_DAYS} days`, `${used.sessions} sessions checked: none called its ${[p.servers.length ? `${p.servers.length} MCP server${p.servers.length === 1 ? '' : 's'}` : '', p.skills.length ? `${p.skills.length} skill${p.skills.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' or ') || 'tools'}. Each enabled plugin loads into every session.`, { type: 'plugin-disable', label: 'Turn off…', plugin: p.id });
  }
  for (const s of inv.skills) {
    if (n(used.skills, s.name) || n(used.commands, s.name)) continue;
    add(`usage-skill-${s.scope}-${s.repo || 'user'}-${s.name}`, 'info', `Skill ${s.name}${s.repo ? ` in ${s.repo}` : ''} was not used in ${WINDOW_DAYS} days`, `${used.sessions} sessions checked. Its description is listed in every session${s.repo ? ' in this repo' : ''}, so unused skills cost context. Removing moves its folder to the trash.`, { type: 'skill-remove', label: 'Remove…', path: s.path, repo: s.repo || null });
  }
  for (const s of live || []) {
    const where = !s.cwd || s.cwd === home ? '' : ` (${path.basename(s.cwd)})`;
    const usedCalls = n(used.servers, tooled(s.name));
    if (s.status === 'failed') add(`usage-mcp-failed-${s.name}`, 'warn', `MCP server ${s.name}${where} fails to start`, `${s.reason || 'It did not connect.'} Every session tries it again.${usedCalls ? '' : ` Not used in ${WINDOW_DAYS} days.`}`, s.name.startsWith('plugin:') ? { type: 'plugin-disable', label: 'Turn off its plugin…', plugin: s.name.split(':')[1] } : { type: 'mcp-remove', label: 'Remove…', name: s.name, cwd: s.cwd });
    else if (s.status === 'needs-auth') add(`usage-mcp-auth-${s.name}`, 'info', `MCP server ${s.name}${where} needs you to sign in`, `${s.reason ? s.reason + '. ' : ''}${usedCalls ? '' : `Not used in ${WINDOW_DAYS} days: removing it may be simpler. `}Sign in opens your browser.`, s.name.startsWith('plugin:') ? { type: 'plugin-disable', label: 'Turn off its plugin…', plugin: s.name.split(':')[1] } : { type: 'mcp-login', label: 'Sign in…', name: s.name, cwd: s.cwd });
    else if (s.status === 'working' && !usedCalls && !s.name.startsWith('plugin:')) add(`usage-mcp-unused-${s.name}`, 'info', `MCP server ${s.name}${where} works but was not used in ${WINDOW_DAYS} days`, 'Its tools are listed in every session.', { type: 'mcp-remove', label: 'Remove…', name: s.name, cwd: s.cwd });
  }
  return out;
}

// Bash permission rules never matched by a command in the window, per repo (only repos with sessions).
function ruleVerdicts(repos, permRules, used) {
  const out = [];
  for (const r of repos) {
    const rules = (permRules[r.path] || []).filter((x) => /^Bash\(/.test(x));
    if (!rules.length || !(used.perRepo.get(r.path) > 0)) continue;
    const idle = rules.map(classifyRule).filter((c) => !used.ruleHits.get(`${r.path}|${c.hash}`));
    if (idle.length) out.push({ id: 'usage-permissions-idle', repoPath: r.path, repo: r.name, category: 'AI agents', severity: 'info', title: `${idle.length} of ${rules.length} Bash permission rule${rules.length === 1 ? '' : 's'} in ${r.name} never matched a command in ${WINDOW_DAYS} days`, detail: `${idle.slice(0, 5).map((c) => `${c.shape} #${c.hash}`).join('; ')}${idle.length > 5 ? `; and ${idle.length - 5} more` : ''}. Values are never shown.`, fix: { type: 'permissions-prune', label: 'Remove…', hashes: idle.map((c) => c.hash) } });
  }
  return out;
}

// The whole check. live: also run `claude mcp list` (starts each server) — only after the user agreed.
// repos: scan results ({ path, name }). runner: exec.run. -> { sessions, items, servers, ran }
async function scanUsage({ home = os.homedir(), repos = [], live = false, bin = null, runner, onProgress } = {}) {
  const inv = inventory(home, repos);
  const permRules = {};
  for (const r of repos) {
    const cfg = readJson(path.join(r.path, '.claude', 'settings.local.json'));
    const allow = cfg && cfg.permissions && Array.isArray(cfg.permissions.allow) ? cfg.permissions.allow.filter((x) => typeof x === 'string') : [];
    if (allow.length) permRules[r.path] = allow;
  }
  const used = await usage(home, repos, { permRules, onProgress });
  let servers = null;
  if (live && bin && runner) {
    const cwds = [home, ...new Set(inv.servers.filter((s) => s.scope !== 'user').map((s) => s.cwd))];
    servers = await liveCheck(bin, cwds, runner);
  }
  return { sessions: used.sessions, servers, items: [...verdicts(inv, used, servers, { home }), ...ruleVerdicts(repos, permRules, used)], inventory: { plugins: inv.plugins.length, servers: inv.servers.length, skills: inv.skills.length } };
}

module.exports = { scanUsage, ruleVerdicts, inventory, usage, liveCheck, parseMcpList, verdicts, ruleMatches, redact, WINDOW_DAYS };
