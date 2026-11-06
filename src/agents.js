// AI coding agent checks. Two parts, both read-only:
//  - per repo (scanAgents + checkAgents): agent instruction files, personal agent settings in git,
//    secrets written into a committed MCP config;
//  - per machine (agentAdvice): only when an agent app is installed. Transcript storage, file
//    indexers that index agent folders, parallel subagents on small machines, plugin load.
// Privacy: transcripts are only measured (sizes), never opened. Settings files are read for key names
// and flags; no value from them (models, tokens, env values) is ever put in a finding.

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { git } = require('./exec');
const { plural, list } = require('./util');
const R = require('./quality/rules');

const DOCS = 'https://code.claude.com/docs/en/';
const REFS = {
  memory: DOCS + 'memory',
  agentsMd: DOCS + 'memory#agents-md',
  localSettings: DOCS + 'settings#keep-personal-settings-out-of-a-repository',
  mcpEnv: DOCS + 'mcp#environment-variable-expansion-in-mcp-json',
  cleanup: DOCS + 'claude-directory#cleaned-up-automatically',
  concurrency: DOCS + 'sub-agents#concurrent-subagent-limit',
  subagentModel: DOCS + 'sub-agents#run-every-subagent-on-one-model',
  plugins: DOCS + 'plugins/install#choose-an-install-scope',
  agentsSpec: 'https://agents.md/',
  baloo: 'https://community.kde.org/Baloo/Configuration',
};

const INSTRUCTION_MAX_LINES = 200; // Claude Code's docs: keep each CLAUDE.md under about 200 lines
const TRANSCRIPTS_WARN_KIB = 2 * 1048576; // 2 GB of local agent history is worth a cleanup setting
const TRANSCRIPTS_INFO_KIB = 512 * 1024;
const SMALL_MACHINE = { cpus: 8, memGiB: 16 }; // at or below either, many parallel agents compete for the machine
const PARALLEL_SUGGESTED = 3;
const PLUGINS_MANY = 8;
const SIZE_BUDGET = 200000;
const CLEANUP_CHOICES = [7, 14]; // cleanupPeriodDays values worth suggesting (default 30, minimum 1)
const DAY_MS = 86400000; // files measured under the transcripts folder before giving up (sizes only)

// Instruction files other tools read. Claude Code reads CLAUDE.md, and AGENTS.md when there is no CLAUDE.md.
const OTHER_RULES = [
  ['.cursorrules', 'Cursor'], ['.cursor/rules', 'Cursor'], ['.github/copilot-instructions.md', 'GitHub Copilot'],
  ['.windsurfrules', 'Windsurf'], ['.windsurf/rules', 'Windsurf'], ['.clinerules', 'Cline'], ['GEMINI.md', 'Gemini CLI'],
];

const exists = (...p) => { try { fs.accessSync(path.join(...p)); return true; } catch { return false; } };
const readSmall = (p, max = 512 * 1024) => { try { const st = fs.statSync(p); return st.isFile() && st.size <= max ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } };
const readJson = (p) => { const t = readSmall(p, 8 * 1048576); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const lineCount = (t) => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);

// Claude Code keeps a project's transcripts in ~/.claude/projects/<path with every non-alphanumeric as ->.
const projectKey = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');

// Literal secrets in an MCP config: env/headers values that are not ${VAR} references. Key names only.
function mcpLiteralSecrets(cfg) {
  const found = [];
  const servers = cfg && typeof cfg === 'object' && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv || typeof srv !== 'object') continue;
    const bags = [['env', srv.env], ['headers', srv.headers]];
    for (const [bag, obj] of bags) {
      if (!obj || typeof obj !== 'object') continue;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string' || v.includes('${') || v.length < 12) continue;
        const keyLooksSecret = /token|secret|key|password|passwd|auth|bearer|credential/i.test(k);
        if (R.secretKinds(v, false).length || R.secretKinds(`${k}="${v}"`, false).length || (keyLooksSecret && !/^(true|false|\d+)$/i.test(v))) found.push(`${name}.${bag}.${k}`);
      }
    }
    if (Array.isArray(srv.args)) srv.args.forEach((a, i) => { if (typeof a === 'string' && !a.includes('${') && R.secretKinds(a, false).length) found.push(`${name}.args[${i}]`); });
  }
  return found;
}

const isTracked = async (dir, rel) => (await git(['ls-files', '--error-unmatch', '--', rel], { cwd: dir })).ok;
const isIgnored = async (dir, rel) => (await git(['check-ignore', '-q', '--', rel], { cwd: dir })).ok;

// Per-repo snapshot. `home` is injectable for tests.
async function scanAgents(dir, { home = os.homedir() } = {}) {
  const claudeMd = readSmall(path.join(dir, 'CLAUDE.md'));
  const agentsMd = readSmall(path.join(dir, 'AGENTS.md'));
  let claudeIsLink = false;
  try { claudeIsLink = fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(); } catch {}
  const other = OTHER_RULES.filter(([p]) => exists(dir, p)).map(([p, tool]) => ({ path: p, tool }));
  const localRel = '.claude/settings.local.json';
  let localSettings = null;
  if (exists(dir, localRel)) localSettings = (await isTracked(dir, localRel)) ? 'tracked' : (await isIgnored(dir, localRel)) ? 'ignored' : 'unignored';
  let mcp = null;
  if (exists(dir, '.mcp.json')) {
    const cfg = readJson(path.join(dir, '.mcp.json'));
    mcp = { parsed: !!cfg, tracked: await isTracked(dir, '.mcp.json'), literal: cfg ? mcpLiteralSecrets(cfg).slice(0, 10) : [] };
  }
  const history = exists(home, '.claude', 'projects', projectKey(dir));
  return {
    claudeMd: claudeMd == null ? null : { lines: lineCount(claudeMd), importsAgents: /^\s*@\.?\/?AGENTS\.md\b/m.test(claudeMd), link: claudeIsLink },
    agentsMd: agentsMd == null ? null : { lines: lineCount(agentsMd) },
    other, localSettings, mcp, history,
  };
}

function checkAgents(s) {
  const a = s.agents;
  if (!a) return [];
  const out = [];
  const add = (id, severity, title, detail, extra = {}) => out.push({ id, category: 'AI agents', severity, title, detail, ...extra });
  if (a.mcp && a.mcp.literal.length)
    add('agent-mcp-secret', a.mcp.tracked ? 'error' : 'warn', `.mcp.json holds ${plural(a.mcp.literal.length, 'literal credential')}`, `${list(a.mcp.literal, 5)}. Values are never shown. ${a.mcp.tracked ? 'The file is committed, so anyone with the repo has them: rotate them, then' : 'Before this file is committed,'} replace each with a \${VAR} reference read from the environment.`, { ref: REFS.mcpEnv });
  if (a.localSettings === 'tracked')
    add('agent-local-settings-tracked', 'warn', '.claude/settings.local.json is committed', 'It holds personal permissions and preferences (sometimes paths or tokens) and is meant to stay on your machine. Remove it from git (git rm --cached) and ignore it.', { ref: REFS.localSettings });
  else if (a.localSettings === 'unignored')
    add('agent-local-settings-unignored', 'info', '.claude/settings.local.json is not ignored', 'Personal agent settings could be committed by accident. Add .claude/settings.local.json to .gitignore.', { ref: REFS.localSettings });
  for (const [key, label] of [['claudeMd', 'CLAUDE.md'], ['agentsMd', 'AGENTS.md']]) {
    const f = a[key];
    if (f && !f.link && f.lines > INSTRUCTION_MAX_LINES)
      add(`agent-${key === 'claudeMd' ? 'claude' : 'agents'}-md-long`, 'info', `${label} is ${f.lines} lines`, `It is loaded into every agent session. Keep it under about ${INSTRUCTION_MAX_LINES} lines: longer files cost context and are followed less reliably. Move topic- or path-specific parts into separate rule files.`, { ref: REFS.memory });
  }
  if (a.claudeMd && a.agentsMd && !a.claudeMd.link && !a.claudeMd.importsAgents)
    add('agent-instructions-split', 'info', 'CLAUDE.md and AGENTS.md are separate', 'Two instruction files drift apart. Make @AGENTS.md the first line of CLAUDE.md and keep only Claude-specific notes below it.', { ref: REFS.agentsMd });
  if (a.other.length && !a.agentsMd && !a.claudeMd)
    add('agent-instructions-other-tool', 'info', `Agent rules only for ${[...new Set(a.other.map((o) => o.tool))].join(', ')}`, `${list(a.other.map((o) => o.path), 4)}. Other agents (Claude Code, Codex and others) do not read these. Move the shared rules into AGENTS.md, which most agents read.`, { ref: REFS.agentsSpec });
  if (a.history && !a.claudeMd && !a.agentsMd)
    add('agent-no-instructions', 'info', 'Agents work here without project instructions', 'Claude Code has sessions for this repo but there is no CLAUDE.md or AGENTS.md, so each session rediscovers how to build, test and lint it. Run /init in Claude Code, or write an AGENTS.md.', { ref: REFS.memory });
  return out;
}

// Report steps for the per-repo findings (phases as in report.js: 0 secrets, 3 project files, 7 housekeeping).
function agentFix(id) {
  const steps = {
    'agent-mcp-secret': { phase: 0, rank: 3, why: 'API keys written into .mcp.json are readable by anyone with the repo.', cmds: [], note: 'For each key named above: rotate it at its provider if the file was ever committed, then replace the value with a ${VAR} reference and set VAR in the environment. NEVER print or copy the values.', ref: REFS.mcpEnv },
    'agent-local-settings-tracked': { phase: 0, rank: 4, why: 'Personal agent settings are shared with everyone who clones the repo.', cmds: ['git rm --cached .claude/settings.local.json', "printf '.claude/settings.local.json\\n' >> .gitignore"], note: 'Keeps the file on disk. Check it for tokens; if it held any, rotate them.', ref: REFS.localSettings },
    'agent-local-settings-unignored': { phase: 3, rank: 12, why: 'Personal agent settings could be committed by accident.', cmds: ["printf '.claude/settings.local.json\\n' >> .gitignore"], ref: REFS.localSettings },
    'agent-claude-md-long': { phase: 3, rank: 13, why: 'A long CLAUDE.md costs context in every session and is followed less reliably.', cmds: [], note: 'Shorten it to the essentials (build, test, conventions). Move path-specific parts into .claude/rules/ files. Ask the owner before deleting guidance.', ref: REFS.memory },
    'agent-agents-md-long': { phase: 3, rank: 13, why: 'A long AGENTS.md costs context in every session.', cmds: [], note: 'Shorten it to the essentials (build, test, conventions). Ask the owner before deleting guidance.', ref: REFS.memory },
    'agent-instructions-split': { phase: 3, rank: 14, why: 'Two instruction files drift apart.', cmds: [], note: 'Merge shared guidance into AGENTS.md, make @AGENTS.md the first line of CLAUDE.md, and keep only Claude-specific notes in CLAUDE.md.', ref: REFS.agentsMd },
    'agent-instructions-other-tool': { phase: 3, rank: 14, why: 'Only one agent reads these rules.', cmds: [], note: 'Copy the shared rules into AGENTS.md. Keep the tool-specific file only for tool-specific settings.', ref: REFS.agentsSpec },
    'agent-no-instructions': { phase: 3, rank: 15, why: 'Every agent session has to rediscover how to build and test the project.', cmds: [], note: 'Write a short AGENTS.md (or run /init in Claude Code): how to install, build, test and lint, and the project conventions. Use only facts from the repo.', ref: REFS.memory },
  };
  return steps[id] || null;
}

// ---- Machine level ----

// Agent apps installed for this user. Paths only; nothing inside them is read here.
function detectApps(home) {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const apps = [];
  if (exists(home, '.claude')) apps.push({ id: 'claude-code', name: 'Claude Code', dir: path.join(home, '.claude') });
  if (exists(cfg, 'Claude')) apps.push({ id: 'claude-desktop', name: 'Claude Desktop', dir: path.join(cfg, 'Claude') });
  if (exists(home, '.cursor')) apps.push({ id: 'cursor', name: 'Cursor', dir: path.join(home, '.cursor') });
  if (exists(home, '.codex')) apps.push({ id: 'codex', name: 'Codex CLI', dir: path.join(home, '.codex') });
  if (exists(home, '.gemini')) apps.push({ id: 'gemini', name: 'Gemini CLI', dir: path.join(home, '.gemini') });
  if (exists(cfg, 'github-copilot')) apps.push({ id: 'copilot', name: 'GitHub Copilot', dir: path.join(cfg, 'github-copilot') });
  return apps;
}

// Sizes only, with a file budget so a huge folder cannot stall the scan. Returns KiB.
// Sizes only (and file dates, to see what a shorter cleanup period would clear), with a file
// budget so a huge folder cannot stall the scan. Returns KiB: total and by age.
async function folderKiB(dir, budget, now = Date.now()) {
  const out = { kib: 0, older: Object.fromEntries(CLEANUP_CHOICES.map((d) => [d, 0])) };
  let bytes = 0;
  const older = Object.fromEntries(CLEANUP_CHOICES.map((d) => [d, 0]));
  const walk = async (d) => {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (budget.n-- <= 0) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          const st = await fsp.stat(p);
          bytes += st.size;
          for (const days of CLEANUP_CHOICES) if (now - st.mtimeMs > days * DAY_MS) older[days] += st.size;
        } catch {}
      }
    }
  };
  await walk(dir);
  out.kib = Math.round(bytes / 1024);
  for (const d of CLEANUP_CHOICES) out.older[d] = Math.round(older[d] / 1024);
  return out;
}

const gb = (k) => (k >= 1048576 ? `${(k / 1048576).toFixed(1)} GB` : `${Math.round(k / 1024)} MB`);
// '-home-me-Projects-foo' -> 'foo' when it matches a scanned repo, else the encoded name.
const projectLabel = (key, repos, home = os.homedir()) => (repos.find((r) => projectKey(r.path) === key) || {}).name || (key.startsWith(projectKey(home) + '-') ? '~/' + key.slice(projectKey(home).length + 1) : key);

// KDE Baloo: does the indexer cover agent folders, and does it read file contents?
function balooState(home) {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const text = readSmall(path.join(cfg, 'baloofilerc'));
  if (text == null) return null;
  const get = (k) => { const m = new RegExp(`^${k}(?:\\[\\$e\\])?=(.*)$`, 'mi').exec(text); return m ? m[1].trim() : null; };
  if (/^false$/i.test(get('Indexing-Enabled') || '')) return { enabled: false };
  const expand = (p) => p.replace(/^\$HOME/, home).replace(/^~/, home).replace(/\/+$/, '');
  const excluded = (get('exclude folders') || '').split(',').map((p) => p.trim()).filter(Boolean).map(expand);
  const included = (get('folders') || '$HOME').split(',').map((p) => p.trim()).filter(Boolean).map(expand);
  const covered = (p) => included.some((i) => p === i || p.startsWith(i + '/')) && !excluded.some((x) => p === x || p.startsWith(x + '/'));
  return { enabled: true, contents: !/^true$/i.test(get('only basic indexing') || ''), covered };
}

// opts: { home, cpus, memBytes, env } are injectable for tests.
async function agentAdvice(repos = [], opts = {}) {
  const home = opts.home || os.homedir();
  const apps = detectApps(home);
  if (!apps.length) return [];
  const out = [];
  const add = (id, severity, title, detail, extra = {}) => out.push({ id, category: 'AI agents', severity, title, detail, ...extra });
  const claude = apps.some((a) => a.id === 'claude-code');
  const settings = claude ? readJson(path.join(home, '.claude', 'settings.json')) || {} : {};
  const env = { ...(opts.env || process.env), ...(settings.env && typeof settings.env === 'object' ? settings.env : {}) };

  // 1. Local transcript history (Claude Code keeps it 30 days by default).
  if (claude) {
    const root = path.join(home, '.claude', 'projects');
    let ents = [];
    try { ents = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()); } catch {}
    const budget = { n: SIZE_BUDGET };
    const sizes = [];
    for (const e of ents) sizes.push({ key: e.name, ...(await folderKiB(path.join(root, e.name), budget, opts.now)) });
    const total = sizes.reduce((n, s) => n + s.kib, 0);
    if (total >= TRANSCRIPTS_INFO_KIB) {
      sizes.sort((x, y) => y.kib - x.kib);
      const current = Number.isFinite(settings.cleanupPeriodDays) ? settings.cleanupPeriodDays : 30;
      const older = Object.fromEntries(CLEANUP_CHOICES.map((d) => [d, sizes.reduce((n, s) => n + s.older[d], 0)]));
      // Suggest the longest period that clears at least a fifth of the history; 7 days otherwise.
      const days = CLEANUP_CHOICES.slice().reverse().find((d) => d < current && older[d] >= total / 5) || (current > 7 ? 7 : null);
      const ages = CLEANUP_CHOICES.filter((d) => d < current).map((d) => `${gb(older[d])} is older than ${d} days`).join(', ');
      add('agent-transcripts', total >= TRANSCRIPTS_WARN_KIB ? 'warn' : 'info', `${gb(total)} of local agent session history`,
        `${list(sizes.slice(0, 4).map((s) => `${projectLabel(s.key, repos)} (${gb(s.kib)})`), 4)}${budget.n <= 0 ? ' (measurement capped, real total is larger)' : ''}. Claude Code keeps sessions for ${current} days${Number.isFinite(settings.cleanupPeriodDays) ? ' (cleanupPeriodDays)' : ' (the default)'}${ages ? `; ${ages}` : ''}.${days ? ` Setting cleanupPeriodDays to ${days} clears about ${gb(older[days])} the next time Claude Code starts, and you can still resume anything newer.` : ' It is already short: the space is recent work.'} Claude Desktop's own sessions use desktopSessionCleanupPeriodDays.`,
        { ref: REFS.cleanup, note: 'Prefer the setting to deleting transcripts by hand: deletion cannot be undone and those sessions can no longer be resumed. Change ~/.claude/settings.json only with the user\'s approval, keeping its other keys.', fix: days ? { type: 'claude-cleanup-days', label: `Keep ${days} days`, days } : undefined, cmds: days ? [`# in ~/.claude/settings.json: "cleanupPeriodDays": ${days}`] : [] });
    }
  }

  // 2. File indexers that index agent folders (they churn on every transcript write).
  const baloo = balooState(home);
  if (baloo && baloo.enabled) {
    const watched = apps.filter((a) => baloo.covered(a.dir));
    const agentDirs = watched.map((a) => a.dir);
    if (agentDirs.length || baloo.contents)
      add('agent-indexer', agentDirs.length ? 'warn' : 'info', agentDirs.length ? 'The KDE file indexer watches agent folders' : 'The KDE file indexer reads file contents',
        `${agentDirs.length ? `Baloo indexes ${list(agentDirs.map((d) => d.replace(home, '~')), 4)}, which ${watched.map((a) => a.name).join(', ')} ${watched.length === 1 ? 'rewrites' : 'rewrite'} constantly while agents run, so it competes with them for CPU and memory. ` : ''}${baloo.contents ? 'Content indexing is on, which reads every changed file. ' : ''}Exclude the agent and project folders in System Settings > Search > File Search${baloo.contents ? ', and choose to index file names only' : ''}.`,
        { ref: REFS.baloo, cmds: ['balooctl6 status   # read-only: shows what the indexer is doing'] });
  }

  // 3. Many agents at once on a small machine.
  if (claude) {
    const cpus = opts.cpus || os.cpus().length;
    const memGiB = (opts.memBytes || os.totalmem()) / 1073741824;
    const small = cpus <= SMALL_MACHINE.cpus || memGiB <= SMALL_MACHINE.memGiB;
    const capSet = !!env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS;
    if (small && !capSet)
      add('agent-parallel', 'info', 'No limit on parallel subagents for this machine', `${cpus} CPU threads and ${Math.round(memGiB)} GB of memory. Claude Code allows up to 20 subagents at once, and each runs its own process and tools, so a wide fan-out can slow the machine or crash the app. Set CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS to about ${PARALLEL_SUGGESTED} in the env block of ~/.claude/settings.json.${env.CLAUDE_CODE_SUBAGENT_MODEL ? '' : ' A lighter subagent model (CLAUDE_CODE_SUBAGENT_MODEL) also shortens how long agents overlap.'}`,
        { ref: REFS.concurrency, note: 'Edit ~/.claude/settings.json only with the user\'s approval, and keep its other keys unchanged.' });
    if (env.CLAUDE_CODE_SUBAGENT_MODEL && !env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)
      add('agent-subagent-model', 'info', 'The subagent model is only a default', 'CLAUDE_CODE_SUBAGENT_MODEL is set, but a subagent\'s own model, or one chosen when it is started, still wins. Add CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 to the same env block to apply it to every subagent.', { ref: REFS.subagentModel });
  }

  // 4. Plugin load: every enabled plugin adds skills, agents and MCP servers to each session.
  const plugins = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? Object.entries(settings.enabledPlugins).filter(([, v]) => v === true).map(([k]) => k.split('@')[0]) : [];
  if (plugins.length >= PLUGINS_MANY)
    add('agent-plugins', 'info', `${plural(plugins.length, 'Claude Code plugin')} enabled`, `${list(plugins, 8)}. Each adds skills, agents and MCP servers to every session, which costs context and memory. Turn off the ones you do not use (set them to false under enabledPlugins).`, { ref: REFS.plugins });

  return out;
}

module.exports = { scanAgents, checkAgents, agentFix, agentAdvice, detectApps, mcpLiteralSecrets, projectKey, balooState, INSTRUCTION_MAX_LINES };
