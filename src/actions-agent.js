// Repo actions for the AI agent findings (planned, previewed and applied like every other action):
//  - permissions-prune: remove chosen rules from .claude/settings.local.json. Only redacted shapes are
//    shown; the original file is backed up in GutCheck's data folder, never inside the repo.
//  - split-instructions: move the largest sections of an instruction file into docs/agents/<topic>.md
//    with a pointer left under each heading, and turn in-repo @-imports into plain pointers, so they are
//    read when needed instead of loaded into every session. Every original line is kept.
//  - lsp-setup: install or turn on Claude Code's LSP plugin for a language, and the language server.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataDir } = require('./paths');
const { classifyRule, lspCatalog, LSP_FALLBACK, INSTR_INFO } = require('./agent-context');
const { claudeBin } = require('./agent-connect');

class PlanError extends Error {}
const fail = (msg) => { throw new PlanError(msg); };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const KB = 1024;
const SECTION_MIN = 1.5 * KB; // smaller sections stay in the core file
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const cmd = (c, args, cwd, extra = {}) => ({ kind: 'cmd', cmd: c, args, cwd, display: `${path.basename(c)} ${args.map(quote).join(' ')}`, ...extra });
const onPath = (bin, env = process.env) => (env.PATH || '').split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });

// ---------------------------------------------------------------- permissions-prune

function planPrune(r, p) {
  const file = path.join(r.path, '.claude', 'settings.local.json');
  const want = new Set((Array.isArray(p.hashes) ? p.hashes : []).filter((h) => /^[0-9a-f]{8}$/.test(h)));
  if (!want.size) fail('Choose the rules to remove.');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { fail('.claude/settings.local.json is gone.'); }
  let cfg;
  try { cfg = JSON.parse(text); } catch { fail('.claude/settings.local.json is not valid JSON; GutCheck will not rewrite it.'); }
  const allow = cfg && cfg.permissions && Array.isArray(cfg.permissions.allow) ? cfg.permissions.allow : [];
  const gone = allow.filter((x) => typeof x === 'string' && want.has(classifyRule(x).hash));
  if (!gone.length) fail('Those rules are no longer in the file. Rescan.');
  const next = { ...cfg, permissions: { ...cfg.permissions, allow: allow.filter((x) => !gone.includes(x)) } };
  const backup = path.join(dataDir(), 'backups', `${path.basename(r.path)}-settings.local-${Date.now()}.json`);
  return {
    risk: 'caution',
    title: `Remove ${gone.length} permission rule${gone.length === 1 ? '' : 's'} from .claude/settings.local.json`,
    steps: [{ kind: 'replace', root: r.path, path: file, expect: sha(text), content: JSON.stringify(next, null, 2) + '\n', backup, display: `remove from .claude/settings.local.json: ${gone.map((x) => { const c = classifyRule(x); return `${c.shape} #${c.hash}`; }).join('; ')}` }],
    undo: `copy the backup back: ${backup.replace(os.homedir(), '~')}`,
    note: 'Rule values are never shown. The original file is backed up in GutCheck\'s data folder, not in the repo.',
  };
}

// ---------------------------------------------------------------- split-instructions

const slug = (s) => s.toLowerCase().replace(/[`*_[\]()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';

// Sections at the file's main heading level, ignoring headings inside fenced code.
function split(text) {
  const lines = text.split('\n');
  let fenced = false;
  const heads = [];
  lines.forEach((l, i) => { if (/^\s*(```|~~~)/.test(l)) fenced = !fenced; else if (!fenced) { const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(l); if (m) heads.push({ i, level: m[1].length, title: m[2] }); } });
  const levels = heads.map((h) => h.level).filter((l) => l > 1);
  const level = levels.length ? Math.min(...levels) : 1;
  const top = heads.filter((h) => h.level === level);
  return top.map((h, k) => {
    const end = k + 1 < top.length ? top[k + 1].i : lines.length;
    const body = lines.slice(h.i, end).join('\n');
    return { start: h.i, end, title: h.title, level, body, bytes: Buffer.byteLength(body) };
  });
}

// Imports of the other instruction files (CLAUDE.md -> @AGENTS.md) are how one agent reads the other
// agent's rules: those stay imports.
const INSTRUCTION_FILE = /^(?:CLAUDE|AGENTS|GEMINI)\.md$/i;

async function planSplit(r, p, ctx = {}) {
  const rel = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md'].find((f) => f === p.file) || fail('Choose CLAUDE.md, .claude/CLAUDE.md or AGENTS.md.');
  const file = path.join(r.path, rel);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { fail(`${rel} is gone.`); }
  const lines = text.split('\n');
  const steps = [];
  const moved = [];
  const used = new Set();
  // Largest sections first, until the core is under the size target.
  let size = Buffer.byteLength(text);
  for (const s of split(text).filter((x) => x.bytes >= SECTION_MIN).sort((a, b) => b.bytes - a.bytes)) {
    if (size <= INSTR_INFO) break;
    const topic = s.title.replace(/\s*\([^)]*\)\s*$/, '').replace(/[`*_]/g, '').trim() || s.title; // "Rules (set 4 Oct)" -> "Rules"
    let name = slug(topic);
    for (let n = 2; used.has(name) || fs.existsSync(path.join(r.path, 'docs', 'agents', name + '.md')); n++) name = `${slug(topic)}-${n}`;
    used.add(name);
    const target = `docs/agents/${name}.md`;
    const pointer = `${'#'.repeat(s.level)} ${s.title}\n\nMoved to [${target}](${target}). Read it before any task that involves ${topic.charAt(0).toLowerCase() + topic.slice(1)}.\n`;
    moved.push({ ...s, target, pointer });
    size -= s.bytes - Buffer.byteLength(pointer);
  }
  // In-repo @-imports load the whole file every session: a plain pointer lets the agent read it on demand.
  let fenced = false;
  const imports = [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = moved.find((s) => s.start === i);
    if (m) { out.push(m.pointer); i = m.end - 1; continue; }
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const im = !fenced && /^(\s*(?:[-*]\s+)?)@((?:\.{0,2}\/)?[\w.\-/]+\.\w+)\s*$/.exec(l);
    const abs = im && path.resolve(path.dirname(file), im[2]);
    if (im && !INSTRUCTION_FILE.test(path.basename(im[2])) && abs.startsWith(path.resolve(r.path) + path.sep) && fs.existsSync(abs) && fs.statSync(abs).size >= SECTION_MIN) { imports.push(im[2]); out.push(`${im[1]}Read \`${im[2]}\` when the task needs it.`); continue; }
    out.push(l);
  }
  if (!moved.length && !imports.length) fail(`${rel} has no section or import large enough to move.`);
  for (const s of moved) {
    const target = path.join(r.path, s.target);
    steps.push({ kind: 'write', root: r.path, path: target, content: `<!-- Moved from ${rel} by GutCheck. -->\n\n${s.body.replace(/\n*$/, '\n')}`, display: `write ${s.target} (${s.title}, ${Math.round(s.bytes / KB)} KB)`, preview: s.body.split('\n').slice(0, 6).join('\n') });
  }
  const content = out.join('\n');
  // `git checkout` would also throw away edits not yet committed: offer it only when the file is clean.
  const st = ctx.safeGit ? await ctx.safeGit(['status', '--porcelain', '--ignore-submodules=dirty', '--', rel], r.path) : null;
  const clean = !!(st && st.ok && !st.stdout.trim());
  const rmMoved = moved.length ? `rm ${moved.map((s) => quote(s.target)).join(' ')}` : '';
  steps.push({ kind: 'replace', root: r.path, path: file, expect: sha(text), content, display: `rewrite ${rel}: ${Math.round(Buffer.byteLength(text) / KB)} KB to ${Math.round(Buffer.byteLength(content) / KB)} KB${moved.length ? `, ${moved.length} section${moved.length === 1 ? '' : 's'} replaced by pointers` : ''}${imports.length ? `, ${imports.length} @-import${imports.length === 1 ? '' : 's'} turned into pointers` : ''}` });
  return {
    risk: 'caution',
    title: `Split ${rel}: keep the core, move ${moved.length ? moved.map((s) => s.title).join(', ') : 'imports'} out of every session`,
    steps,
    undo: clean ? [`git checkout -- ${quote(rel)}`, rmMoved].filter(Boolean).join(' && ') : `${rel} has edits that are not committed, so git has no copy to go back to: commit it before applying if you want an easy undo.${rmMoved ? ` The new files can be removed with: ${rmMoved}` : ''}`,
    warnings: moved.some((m) => /binding|must|never|always|required|rules/i.test(m.title)) ? ['A moved section looks like rules that must always apply. Moved sections are read only when the pointer sends the agent there: untick this change, or move such rules back into the core file afterwards.'] : [],
    note: 'Every original line is kept: moved sections are copied word for word into their new files. Review the result, then commit it.',
  };
}

// ---------------------------------------------------------------- lsp-setup

// How to install each language server when it is missing, with the tool that must already be there.
const SERVER_INSTALL = {
  'rust-analyzer': { needs: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
  'pyright-langserver': { needs: 'npm', global: true, args: ['install', '-g', 'pyright'] },
  'typescript-language-server': { needs: 'npm', global: true, args: ['install', '-g', 'typescript-language-server', 'typescript'] },
  intelephense: { needs: 'npm', global: true, args: ['install', '-g', 'intelephense'] },
  gopls: { needs: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
  'csharp-ls': { needs: 'dotnet', global: true, args: ['tool', 'install', '--global', 'csharp-ls'] },
  'ruby-lsp': { needs: 'gem', args: ['install', 'ruby-lsp'] },
  clangd: { needs: 'pacman', root: true, args: ['-S', '--needed', '--noconfirm', 'clang'] },
  'lua-language-server': { needs: 'pacman', root: true, args: ['-S', '--needed', '--noconfirm', 'lua-language-server'] },
};

function planLsp(r, p, ctx) {
  const env = (ctx && ctx.env) || process.env;
  const home = os.homedir();
  const catalog = { ...LSP_FALLBACK, ...lspCatalog(home) };
  const name = String(p.plugin || '');
  const entry = catalog[name] || fail('Unknown LSP plugin.');
  const l = ((r.agents && r.agents.context && r.agents.context.lsp) || []).find((x) => x.name === name) || fail('That plugin was not suggested for this repo. Rescan.');
  const steps = [];
  const bin = claudeBin(env, home);
  // Installs run from the home folder: a repo's .npmrc, nuget.config or Gemfile must not pick the registry.
  if (!l.installed || !l.enabled) {
    if (!bin) fail('Claude Code was not found (not on PATH, nor bundled with Claude Desktop).');
    steps.push(!l.installed ? cmd(bin, ['plugin', 'install', `${name}@claude-plugins-official`, '--scope', 'user'], home) : cmd(bin, ['plugin', 'enable', `${name}@claude-plugins-official`, '--scope', 'user'], home));
  }
  const notes = [];
  if (!l.binary) {
    const how = SERVER_INSTALL[entry.command];
    if (how && onPath(how.needs, env)) steps.push(how.root ? cmd('run0', [how.needs, ...how.args], home, { timeout: 15 * 60 * 1000, system: true }) : cmd(how.needs, how.args, home, { timeout: 15 * 60 * 1000, system: how.global }));
    else notes.push(`${entry.command} is not on PATH and GutCheck has no installer for it here${how ? ` (it needs ${how.needs})` : ''}: install it from your package manager.`);
  }
  if (!steps.length) fail(notes[0] || 'Nothing to set up.');
  // Installing as root, or for every user, changes the machine, not just this repo: type the repo name.
  return { risk: steps.some((s) => s.system) ? 'danger' : 'caution', title: `Set up ${name} for Claude Code`, steps, note: [...notes, 'Installing runs the package manager\'s own scripts. Claude Code picks the plugin up in new sessions.', steps.some((s) => s.cmd === 'run0') ? 'run0 asks for your password in a system dialog.' : ''].filter(Boolean).join(' ') };
}

module.exports = {
  'permissions-prune': { plan: planPrune },
  'split-instructions': { plan: planSplit },
  'lsp-setup': { plan: planLsp },
  split, SERVER_INSTALL, PlanError,
};
