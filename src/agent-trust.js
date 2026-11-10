// Trust flags in COMMITTED agent config: things that make everyone who clones the repo run code or
// send data elsewhere once they open it in Claude Code. Read-only, per repo.
//  - .claude/settings.json: enableAllProjectMcpServers / enabledMcpjsonServers (auto-approve the repo's
//    MCP servers), env base-URL overrides, hooks that run commands, apiKeyHelper, extraKnownMarketplaces;
//  - .mcp.json: stdio servers run through a shell or curl|sh, unpinned npx -y / uvx, plain http:// URLs
//    (not localhost), headersHelper commands;
//  - CODEOWNERS that leaves .mcp.json and .claude/ without a review owner.
// Output is shape only: key names, server names, "sh -c", and URLs as scheme + host. Never a value.

const fs = require('node:fs');
const path = require('node:path');
const { flat } = require('./text-safe');
const { plural, list } = require('./util');

const DOCS = 'https://code.claude.com/docs/en/';
const REFS = {
  settings: DOCS + 'settings#share-settings-with-your-team',
  env: DOCS + 'settings-reference#env',
  hooks: DOCS + 'settings-reference#hooks',
  marketplace: DOCS + 'settings-reference#extraknownmarketplaces',
  mcp: DOCS + 'mcp#project-server-approvals-and-workspace-trust',
  mcpHeaders: DOCS + 'mcp#use-dynamic-headers-for-custom-authentication',
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);
const BASE_URL_KEY = /^[A-Z][A-Z0-9_]*_BASE_URL$|^(ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]*URL$/;
const MAX_NAMES = 6;

const readJson = (p) => { try { const st = fs.statSync(p); if (!st.isFile() || st.size > 4 * 1048576) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const name = (s) => flat(s, 40);
const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);

// ---------------------------------------------------------------- .claude/settings.json

function settingsShape(cfg) {
  const hookEvents = [];
  for (const [ev, groups] of Object.entries(obj(cfg.hooks))) {
    const runs = (Array.isArray(groups) ? groups : []).some((g) => (Array.isArray(obj(g).hooks) ? obj(g).hooks : []).some((h) => obj(h).type === 'command' && typeof h.command === 'string'));
    if (runs) hookEvents.push(name(ev));
  }
  return {
    autoAll: cfg.enableAllProjectMcpServers === true,
    autoNames: strs(cfg.enabledMcpjsonServers).map(name),
    urlKeys: Object.keys(obj(cfg.env)).filter((k) => BASE_URL_KEY.test(k)),
    apiKeyHelper: typeof cfg.apiKeyHelper === 'string' && cfg.apiKeyHelper.trim() !== '',
    hookEvents,
    marketplaces: Object.keys(obj(cfg.extraKnownMarketplaces)).map(name),
  };
}

// ---------------------------------------------------------------- .mcp.json

// Is the package an npx/uvx run names pinned to a version? `pkg@1.2.3`, `@scope/pkg@1`, `tool==1.0`.
function pinned(pkg) {
  if (/^(\.|\/|~|git\+|https?:|file:)/.test(pkg)) return true; // a local path or URL: not a registry lookup
  if (/==|~=/.test(pkg)) return true;
  const at = pkg.lastIndexOf('@');
  return at > 0 && !/^(latest|next)$/i.test(pkg.slice(at + 1)) && pkg.slice(at + 1) !== '';
}

function packageOf(command, args) {
  let rest = args;
  if (command === 'pnpm' && args[0] === 'dlx') rest = args.slice(1);
  else if (command === 'pnpm') return null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--from' && rest[i + 1]) return rest[i + 1];
    if (!rest[i].startsWith('-')) return rest[i];
  }
  return null;
}

function serverShape(srv) {
  const out = { shell: null, unpinned: false, http: null, helper: false };
  const s = obj(srv);
  if (typeof s.headersHelper === 'string') out.helper = true;
  if (typeof s.url === 'string' && /^http:\/\//i.test(s.url)) {
    try {
      const u = new URL(s.url);
      const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!(h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h))) out.http = `http://${h}`;
    } catch {}
  }
  if (typeof s.command === 'string') {
    const args = strs(s.args);
    const base = path.basename(s.command.trim().split(/\s+/)[0] || '');
    if (SHELLS.has(base) && args.some((a) => /^-[a-z]*c[a-z]*$/.test(a))) out.shell = `${base} -c`;
    else if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/.test([s.command, ...args].join(' '))) out.shell = 'curl | sh';
    const runner = RUNNERS.has(base) ? base : base === 'pnpm' ? 'pnpm' : null;
    if (runner) {
      const needsYes = base === 'npx';
      if (!needsYes || args.some((a) => a === '-y' || a === '--yes')) {
        const pkg = packageOf(runner, args);
        if (pkg && !pinned(pkg)) out.unpinned = true;
      }
    }
  }
  return out;
}

function mcpShape(cfg) {
  const by = { shell: [], http: [], unpinned: [], helper: [] };
  for (const [n, srv] of Object.entries(obj(cfg.mcpServers))) {
    const s = serverShape(srv);
    const label = name(n);
    if (s.shell) by.shell.push(`${label} (${s.shell})`);
    if (s.http) by.http.push(`${label} (${s.http})`);
    if (s.unpinned) by.unpinned.push(label);
    if (s.helper) by.helper.push(label);
  }
  return by;
}

// ---------------------------------------------------------------- CODEOWNERS

function globRe(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\//, '');
  const body = p.split('/').map((seg) => (seg === '**' ? '\u0000' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/').replace(/\u0000\/?/g, (m) => (m.endsWith('/') ? '(?:.*/)?' : '.*')).replace(/\/\.\*$/, '/.*');
  return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${body}${dirOnly ? '/.*$' : '(?:/.*)?$'}`);
}

// Last matching line wins; a line with no owners removes the owner. -> true when a team owns `rel`.
function codeownersCovers(text, rel) {
  let owned = false;
  for (const line of String(text).split('\n')) {
    const parts = line.replace(/(^|\s)#.*$/, '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    let re;
    try { re = globRe(parts[0]); } catch { continue; }
    if (re.test(rel)) owned = parts.length > 1;
  }
  return owned;
}

function readCodeowners(dir) {
  for (const f of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    try { const st = fs.statSync(path.join(dir, f)); if (st.isFile() && st.size < 1048576) return fs.readFileSync(path.join(dir, f), 'utf8'); } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- scan + checks

// isTracked(dir, rel) -> Promise<boolean>. Only committed files count: an untracked one is the owner's own.
async function scanTrust(dir, isTracked) {
  const out = { settings: null, mcp: null, codeownersMissing: [] };
  const trackedSettings = fs.existsSync(path.join(dir, '.claude', 'settings.json')) && await isTracked(dir, '.claude/settings.json');
  const trackedMcp = fs.existsSync(path.join(dir, '.mcp.json')) && await isTracked(dir, '.mcp.json');
  if (trackedSettings) { const c = readJson(path.join(dir, '.claude', 'settings.json')); if (c) out.settings = settingsShape(c); }
  if (trackedMcp) { const c = readJson(path.join(dir, '.mcp.json')); if (c) out.mcp = mcpShape(c); }
  const co = readCodeowners(dir);
  if (co != null) {
    if (trackedMcp && !codeownersCovers(co, '.mcp.json')) out.codeownersMissing.push('.mcp.json');
    if (trackedSettings && !codeownersCovers(co, '.claude/settings.json')) out.codeownersMissing.push('.claude/');
  }
  return out;
}

function checkTrust(trust) {
  if (!trust) return [];
  const out = [];
  const add = (id, severity, title, detail, ref) => out.push({ id, category: 'AI agents', severity, title, detail, ref });
  const s = trust.settings;
  if (s && (s.autoAll || s.autoNames.length))
    add('agent-trust-autoenable', 'warn', 'Committed settings approve the repo\'s MCP servers without asking',
      `.claude/settings.json sets ${[s.autoAll ? 'enableAllProjectMcpServers' : '', s.autoNames.length ? `enabledMcpjsonServers (${list(s.autoNames, MAX_NAMES)})` : ''].filter(Boolean).join(' and ')}. Once someone trusts the folder, every server in .mcp.json starts for them, and each one is a program run on their machine. Values are never shown. Remove the key and let each person approve the servers they want, or keep approvals in .claude/settings.local.json.`, REFS.mcp);
  if (s && s.urlKeys.length)
    add('agent-trust-endpoint', 'warn', `Committed settings override ${plural(s.urlKeys.length, 'API endpoint')}`,
      `.claude/settings.json sets env ${list(s.urlKeys, MAX_NAMES)}. Anyone who clones the repo and trusts it sends their prompts, code and credentials to that address instead of the default. Values are never shown. Keep endpoint overrides in your own user settings or the environment.`, REFS.env);
  const cmds = [];
  if (s && s.hookEvents.length) cmds.push(`hooks that run commands (${list(s.hookEvents, MAX_NAMES)})`);
  if (s && s.apiKeyHelper) cmds.push('apiKeyHelper');
  if (trust.mcp && trust.mcp.helper.length) cmds.push(`headersHelper (${list(trust.mcp.helper, MAX_NAMES)})`);
  if (cmds.length)
    add('agent-trust-hooks', 'warn', 'Committed agent config runs commands on open', `${cmds.join(', ')}. These run on the machine of everyone who trusts the folder, with their permissions. Command text is never shown here: read each one in the file and make sure the repo's owners review changes to it. Move anything personal to your user settings.`, REFS.hooks);
  if (s && s.marketplaces.length)
    add('agent-trust-marketplace', 'warn', `Committed settings add ${plural(s.marketplaces.length, 'plugin marketplace')}`, `extraKnownMarketplaces names ${list(s.marketplaces, MAX_NAMES)}. Plugins from a marketplace can bring skills, hooks and MCP servers, so everyone who trusts the folder is offered code the repo's author chose. Confirm each marketplace is one the team controls.`, REFS.marketplace);
  const m = trust.mcp;
  if (m && m.shell.length)
    add('agent-trust-mcp-shell', 'warn', `.mcp.json starts ${plural(m.shell.length, 'server')} through a shell`, `${list(m.shell, MAX_NAMES)}. A shell command line or a download piped into a shell is hard to review and runs with the user's full access. Run the server's program directly with command and args instead. The command text is never shown.`, REFS.mcp);
  if (m && m.http.length)
    add('agent-trust-mcp-http', 'warn', `.mcp.json uses ${plural(m.http.length, 'server')} over plain http://`, `${list(m.http, MAX_NAMES)} (scheme and host only). Traffic, including headers and tool results, is readable and changeable on the network. Use https://. Plain http to localhost is fine and is not listed.`, REFS.mcp);
  if (m && m.unpinned.length)
    add('agent-trust-mcp-unpinned', 'info', `.mcp.json runs ${plural(m.unpinned.length, 'package')} without a pinned version`, `${list(m.unpinned, MAX_NAMES)} start through npx -y, bunx, pnpm dlx or uvx with no version, so each start fetches whatever is newest, and a hijacked release runs on everyone's machine. Pin it: npx -y pkg@1.2.3, or uvx pkg==1.2.3.`, REFS.mcp);
  if (trust.codeownersMissing.length)
    add('agent-trust-codeowners', 'info', 'CODEOWNERS does not cover the agent config', `${list(trust.codeownersMissing, 3)} ${trust.codeownersMissing.length === 1 ? 'is' : 'are'} committed but no team in CODEOWNERS reviews changes to ${trust.codeownersMissing.length === 1 ? 'it' : 'them'}. These files decide which programs run on a contributor's machine, so add lines such as "/.mcp.json @your-org/maintainers" and "/.claude/ @your-org/maintainers".`, 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners');
  return out;
}

// Report steps (phases as in report.js: 3 project files).
const STEPS = {
  'agent-trust-autoenable': { why: 'Opening the repo would start every MCP server it lists, each a program on the user\'s machine.', note: 'In .claude/settings.json remove enableAllProjectMcpServers and enabledMcpjsonServers (ask the owner first: the team may rely on them). Each person then approves servers in the Claude Code prompt. Never print setting values.', ref: REFS.mcp },
  'agent-trust-endpoint': { why: 'Everyone who trusts the repo would send prompts and code to the address it names.', note: 'Remove the base-URL keys named above from the env block of .claude/settings.json and put them in user settings or the environment. Never print their values.', ref: REFS.env },
  'agent-trust-hooks': { why: 'Commands in committed agent config run on every contributor\'s machine.', note: 'Read each hook, apiKeyHelper and headersHelper command in the files named above (do not paste them into reports), ask the owner whether each is needed, and move personal ones to user settings.', ref: REFS.hooks },
  'agent-trust-marketplace': { why: 'A marketplace can deliver skills, hooks and MCP servers to every contributor.', note: 'Confirm with the owner that each marketplace named above is controlled by the team; remove any that is not.', ref: REFS.marketplace },
  'agent-trust-mcp-shell': { why: 'A shell command line in .mcp.json is hard to review and runs with the user\'s full access.', note: 'Replace each shell or curl-pipe command with the server\'s program in command and its flags in args. Ask the owner first. Never print the command text.', ref: REFS.mcp },
  'agent-trust-mcp-http': { why: 'MCP traffic over plain http can be read or changed on the network.', note: 'Switch each URL named above to https:// (ask the server\'s owner if it does not offer it). Never print URLs with query strings or headers.', ref: REFS.mcp },
  'agent-trust-mcp-unpinned': { why: 'An unpinned package runs whatever version is newest at each start.', note: 'Pin each server to a reviewed version: npx -y pkg@1.2.3 or uvx pkg==1.2.3, and update it on purpose.', ref: REFS.mcp },
  'agent-trust-codeowners': { why: 'Nobody is asked to review changes to the files that decide which programs agents run.', note: 'Add owner lines for /.mcp.json and /.claude/ to CODEOWNERS, using a team that exists (ask the owner which).', ref: 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners' },
};
const trustFix = (id) => (STEPS[id] ? { phase: id === 'agent-trust-codeowners' || id === 'agent-trust-mcp-unpinned' ? 7 : 3, rank: 2, cmds: [], ...STEPS[id] } : null);

module.exports = { scanTrust, checkTrust, trustFix, codeownersCovers, settingsShape, mcpShape };
