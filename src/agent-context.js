// Agent context a repo costs, per repo and read-only:
//  - instruction size: CLAUDE.md, .claude/CLAUDE.md and AGENTS.md with their @-imports, in KB and
//    approximate tokens, and the largest sections by heading;
//  - LSP plugins: the repo's main languages against Claude Code's official LSP plugins and whether
//    the language server is on PATH (LSP plugins add almost nothing to a session's context);
//  - permission rules in .claude/settings.local.json that look like one-offs. Rule values are never
//    put in a finding: only a redacted shape (tool, first command word, length, flags) and a short hash.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { git } = require('./exec');
const { plural, list } = require('./util');
const R = require('./quality/rules');

const KB = 1024;
const INSTR_INFO = 12 * KB; // a core file of 4-12 KB, topic files read on demand
const INSTR_WARN = 40 * KB; // about 10k tokens in every session
const IMPORT_DEPTH = 5; // Claude Code follows @-imports up to five levels deep
const BYTES_PER_TOKEN = 4;
const LANG_MIN_FILES = 5;
const ONEOFF_LONG = 80;
const DOCS = 'https://code.claude.com/docs/en/';
const REFS = { memory: DOCS + 'memory#import-additional-files', lsp: DOCS + 'plugins-reference#lsp-servers', permissions: DOCS + 'settings#permission-settings' };

const readText = (p, max = 4 * 1048576) => { try { const st = fs.statSync(p); return st.isFile() && st.size <= max ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } };
const readJson = (p) => { const t = readText(p, 8 * 1048576); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const kb = (b) => (b >= 10 * KB ? `${Math.round(b / KB)} KB` : `${(b / KB).toFixed(1)} KB`);
const tokens = (b) => `${Math.round(b / BYTES_PER_TOKEN / 100) / 10}k tokens`;

// ---------------------------------------------------------------- 1. instruction size

// @path imports outside code spans and fenced blocks (Claude Code ignores those).
function importsOf(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const bare = line.replace(/`[^`]*`/g, '');
    for (const m of bare.matchAll(/(?:^|\s)@((?:~\/|\.{0,2}\/)?[\w.\-/]+\.[\w]+)/g)) out.push(m[1]);
  }
  return out;
}

// Sections by heading (# to ###), largest first: [{ heading, bytes }].
function sections(text) {
  const out = [];
  let cur = { heading: '(top of file)', bytes: 0 };
  for (const line of text.split('\n')) {
    const h = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { if (cur.bytes) out.push(cur); cur = { heading: h[1].slice(0, 60), bytes: 0 }; }
    cur.bytes += Buffer.byteLength(line) + 1;
  }
  if (cur.bytes) out.push(cur);
  return out.sort((a, b) => b.bytes - a.bytes);
}

// A root instruction file and everything it imports inside the repo. -> { file, bytes, own, imports: [{ rel, bytes }], outside, sections }
function measure(dir, rel, home) {
  const root = path.join(dir, rel);
  const text = readText(root);
  if (text == null) return null;
  const seen = new Set([path.resolve(root)]);
  const imports = [];
  let outside = 0;
  const walk = (file, body, depth) => {
    if (depth >= IMPORT_DEPTH) return;
    for (const ref of importsOf(body)) {
      const abs = path.resolve(ref.startsWith('~/') ? path.join(home, ref.slice(2)) : path.join(path.dirname(file), ref));
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) { if (fs.existsSync(abs)) outside++; continue; } // personal files: counted, not measured
      const t = readText(abs);
      if (t == null) continue;
      imports.push({ rel: path.relative(dir, abs), bytes: Buffer.byteLength(t) });
      walk(abs, t, depth + 1);
    }
  };
  walk(root, text, 0);
  const own = Buffer.byteLength(text);
  return { file: rel, own, bytes: own + imports.reduce((n, i) => n + i.bytes, 0), imports, outside, sections: sections(text).slice(0, 4) };
}

// ---------------------------------------------------------------- 2. LSP plugins

// Built-in copy of the official LSP plugins, used when the marketplace is not on disk.
const LSP_FALLBACK = {
  'rust-analyzer-lsp': { command: 'rust-analyzer', ext: ['.rs'] }, 'pyright-lsp': { command: 'pyright-langserver', ext: ['.py', '.pyi'] },
  'typescript-lsp': { command: 'typescript-language-server', ext: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] }, 'gopls-lsp': { command: 'gopls', ext: ['.go'] },
  'kotlin-lsp': { command: 'kotlin-lsp', ext: ['.kt', '.kts'] }, 'jdtls-lsp': { command: 'jdtls', ext: ['.java'] }, 'clangd-lsp': { command: 'clangd', ext: ['.c', '.h', '.cpp', '.cc', '.hpp'] },
  'csharp-lsp': { command: 'csharp-ls', ext: ['.cs'] }, 'php-lsp': { command: 'intelephense', ext: ['.php'] }, 'ruby-lsp': { command: 'ruby-lsp', ext: ['.rb'] },
  'swift-lsp': { command: 'sourcekit-lsp', ext: ['.swift'] }, 'lua-lsp': { command: 'lua-language-server', ext: ['.lua'] },
};

// name -> { command, ext } from the official marketplace on disk, else the built-in copy.
function lspCatalog(home) {
  const dir = path.join(home, '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'plugins');
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /-lsp$/.test(n)); } catch {}
  for (const n of names) {
    const m = readJson(path.join(dir, n, '.claude-plugin', 'plugin.json')) || readJson(path.join(dir, n, 'plugin.json'));
    const servers = m && m.lspServers && typeof m.lspServers === 'object' ? Object.values(m.lspServers) : [];
    const s = servers.find((x) => x && typeof x.command === 'string');
    if (s) out[n] = { command: s.command, ext: Object.keys(s.extensionToLanguage || {}) };
  }
  return Object.keys(out).length ? out : LSP_FALLBACK;
}

const onPath = (cmd, env = process.env) => (env.PATH || '').split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });

// Plugins Claude Code has installed and enabled (name without @marketplace).
function claudePlugins(home) {
  const inst = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const installed = new Set(Object.keys((inst && (inst.plugins || inst)) || {}).map((k) => k.split('@')[0]));
  const settings = readJson(path.join(home, '.claude', 'settings.json')) || {};
  const ep = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  const enabled = new Set(Object.entries(ep).filter(([, v]) => v === true).map(([k]) => k.split('@')[0]));
  return { installed, enabled };
}

async function languages(dir) {
  const r = await git(['ls-files', '-z'], { cwd: dir, maxBuffer: 64 * 1048576 });
  const count = new Map();
  for (const f of r.ok ? r.stdout.split('\0') : []) { const e = path.extname(f).toLowerCase(); if (e) count.set(e, (count.get(e) || 0) + 1); }
  return count;
}

// ---------------------------------------------------------------- 5. permission rules

const hashRule = (rule) => crypto.createHash('sha256').update(rule).digest('hex').slice(0, 8);

// A rule's shape with no value in it: Bash(printf … [142 chars, literal text]).
function classifyRule(rule) {
  const m = /^(\w+)(?:\((.*)\))?$/s.exec(rule) || [null, 'Rule', rule];
  const tool = m[1];
  const inner = m[2] || '';
  const flags = [];
  if (/\n|\\n/.test(inner)) flags.push('multi-line');
  if (/(["'])[^"']{20,}\1/.test(inner)) flags.push('literal text');
  if ((/(^|[\s'"=:])(~|\/)[\w.@-]+\//.test(inner) && !/^\/\//.test(inner))) flags.push('literal path');
  const tokenLike = R.secretKinds(inner, false).length > 0 || /[A-Za-z0-9_+/=-]{40,}/.test(inner);
  if (tokenLike) flags.push('token-like');
  if (inner.length > ONEOFF_LONG) flags.push('long');
  const wildcard = /(:\*|\*)\s*$/.test(inner) || /^[\w.-]+$/.test(inner);
  const word = /^([a-z][\w.-]{0,24})(\s|$)/.exec(inner);
  const first = word && !R.secretKinds(word[1], false).length ? word[1] : '';
  const shape = `${tool}(${first ? first + ' ' : ''}… [${inner.length} chars${flags.length ? ', ' + flags.join(', ') : ''}])`;
  const oneOff = tool === 'Bash' && !wildcard && flags.length > 0;
  return { hash: hashRule(rule), tool, shape, oneOff, tokenLike };
}

function permissionRules(dir) {
  const cfg = readJson(path.join(dir, '.claude', 'settings.local.json'));
  const allow = cfg && cfg.permissions && Array.isArray(cfg.permissions.allow) ? cfg.permissions.allow.filter((x) => typeof x === 'string') : [];
  return allow.map(classifyRule);
}

// ---------------------------------------------------------------- scan + checks

async function scanContext(dir, { home = os.homedir(), env = process.env } = {}) {
  const instructions = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md'].map((f) => measure(dir, f, home)).filter(Boolean);
  let lsp = null;
  if (fs.existsSync(path.join(home, '.claude'))) {
    const catalog = lspCatalog(home);
    const langs = await languages(dir);
    const total = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
    const { installed, enabled } = claudePlugins(home);
    lsp = Object.entries(catalog).map(([name, c]) => ({ name, command: c.command, files: c.ext.reduce((n, e) => n + (langs.get(e) || 0), 0) }))
      .filter((x) => x.files >= LANG_MIN_FILES || x.files / total >= 0.1)
      .map((x) => ({ ...x, installed: installed.has(x.name), enabled: enabled.has(x.name), binary: onPath(x.command, env) }));
  }
  return { instructions, lsp, permissions: permissionRules(dir) };
}

function checkContext(s) {
  const c = s.agents && s.agents.context;
  if (!c) return [];
  const out = [];
  const add = (id, severity, title, detail, extra = {}) => out.push({ id, category: 'AI agents', severity, title, detail, ...extra });
  for (const f of c.instructions) {
    if (f.bytes < INSTR_INFO) continue;
    const id = `agent-context-${f.file.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`;
    const parts = f.imports.length ? ` (${kb(f.own)} itself, ${kb(f.bytes - f.own)} from ${plural(f.imports.length, 'import')}: ${list(f.imports.sort((a, b) => b.bytes - a.bytes).map((i) => `${i.rel} ${kb(i.bytes)}`), 3)})` : '';
    add(id, f.bytes >= INSTR_WARN ? 'warn' : 'info', `${f.file} loads ${kb(f.bytes)} (about ${tokens(f.bytes)}) into every session`,
      `${kb(f.bytes)}${parts}. Largest sections: ${list(f.sections.map((x) => `${x.heading} ${kb(x.bytes)}`), 4)}. Keep a core file of 4 to 12 KB and move topics into files such as docs/agents/<topic>.md, each with a one-line pointer saying when to read it (a pointer, not an @-import, so it is read only when needed). Keep every original line somewhere.${f.outside ? ` It also imports ${plural(f.outside, 'file')} from outside the repo, not counted here.` : ''}`,
      { ref: REFS.memory, size: f.bytes, fix: f.own >= 3 * KB || f.imports.length ? { type: 'split-instructions', label: 'Split…', file: f.file } : undefined });
  }
  for (const l of c.lsp || []) {
    if (l.enabled && l.binary) continue;
    const plugin = !l.installed ? 'is not installed' : !l.enabled ? 'is installed but turned off' : null;
    const title = plugin ? `${l.name} ${plugin} (${l.files} source files here)` : `${l.name} is on, but ${l.command} is missing`;
    const does = [!l.installed ? 'installs the plugin' : !l.enabled ? 'turns the plugin on' : '', l.binary ? '' : `installs ${l.command}`].filter(Boolean).join(' and ');
    const why = plugin ? 'Claude Code\'s language server plugin gives the agent go-to-definition, references and type errors instead of reading whole files, at almost no context cost. ' : `The plugin cannot start without the ${l.command} language server. `;
    add(`agent-lsp-${l.name}`, 'info', title, `${why}Set up ${does}; you see the exact commands first.`, { ref: REFS.lsp, fix: { type: 'lsp-setup', label: 'Set up…', plugin: l.name } });
  }
  const one = c.permissions.filter((p) => p.oneOff);
  const secret = c.permissions.filter((p) => p.tokenLike);
  if (secret.length)
    add('agent-permissions-secret', 'warn', `${plural(secret.length, 'permission rule')} in .claude/settings.local.json ${secret.length === 1 ? 'holds' : 'hold'} a token-like value`, `${list(secret.map((p) => `${p.shape} #${p.hash}`), 4)}. Values are never shown. A rule like this was usually approved once with a credential in the command. Remove it, and rotate the credential if it was real.`, { ref: REFS.permissions, fix: { type: 'permissions-prune', label: 'Remove…', hashes: secret.map((p) => p.hash) } });
  const rest = one.filter((p) => !p.tokenLike);
  if (rest.length)
    add('agent-permissions-oneoff', 'info', `${plural(rest.length, 'one-off permission rule')} in .claude/settings.local.json`, `${list(rest.map((p) => `${p.shape} #${p.hash}`), 5)}. Rules approved for a single exact command (long, multi-line or with literal paths or text) rarely match again but stay in the file. Values are never shown.`, { ref: REFS.permissions, fix: { type: 'permissions-prune', label: 'Remove…', hashes: rest.map((p) => p.hash) } });
  return out;
}

module.exports = { scanContext, checkContext, importsOf, sections, measure, classifyRule, hashRule, lspCatalog, LSP_FALLBACK, INSTR_INFO, INSTR_WARN };
