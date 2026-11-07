// Machine-level fixes for AI agent setup, planned and previewed like every other change and applied by
// agent-connect.js: stale backup and temp files in agent config folders, and the fixes the usage check
// offers (turn a plugin off, remove an MCP server, sign in to one, remove an unused skill).
// Every target is re-derived at plan time from the user's own config, never taken on trust from the caller.

const fs = require('node:fs');
const path = require('node:path');
const { inventory } = require('./agent-usage');

const DAY = 86400000;
const BAK_DAYS = 7; // GutCheck keeps the user's original config this long after changing it
const TMP_DAYS = 1; // a temp file older than a day is left over from an interrupted write
const OWN_BACKUP_DAYS = 30;
const NAME_RE = /^[\w .:@/-]{1,120}$/;

const age = (p, now) => { try { return (now - fs.statSync(p).mtimeMs) / DAY; } catch { return -1; } };
const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// Leftovers: GutCheck's own .gutcheck.bak copies and backups, and temp files from interrupted writes.
// Claude Code's own rotated ~/.claude/backups/ are left alone.
function staleConfig(home, dataDir, now = Date.now()) {
  const out = [];
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const places = [home, path.join(home, '.claude'), path.join(cfg, 'Claude'), path.join(home, '.cursor'), path.join(home, '.gemini'), path.join(home, '.codex'), path.join(home, '.vscode'), path.join(cfg, 'Code', 'User')];
  for (const d of places) {
    for (const n of list(d)) {
      const p = path.join(d, n);
      if (n.endsWith('.gutcheck.bak') && age(p, now) > BAK_DAYS) out.push({ path: p, bytes: size(p), why: 'GutCheck\'s backup of a config it changed' });
      else if (/^(\.claude\.json|config\.json|settings\.json|claude_desktop_config\.json)\.tmp[.-]/.test(n) && age(p, now) > TMP_DAYS) out.push({ path: p, bytes: size(p), why: 'left over from an interrupted write' });
    }
  }
  const own = path.join(dataDir, 'backups');
  for (const n of list(own)) { const p = path.join(own, n); if (age(p, now) > OWN_BACKUP_DAYS) out.push({ path: p, bytes: size(p), why: 'GutCheck\'s own backup' }); }
  return out;
}

function configAdvice(home, dataDir, now) {
  const s = staleConfig(home, dataDir, now);
  if (!s.length) return [];
  const short = (p) => p.replace(home, '~');
  return [{ id: 'agent-config-leftovers', category: 'AI agents', severity: 'info', title: `${s.length} stale backup or temp file${s.length === 1 ? '' : 's'} in agent config folders`, detail: `${s.slice(0, 5).map((x) => `${short(x.path)} (${x.why})`).join('; ')}${s.length > 5 ? `; and ${s.length - 5} more` : ''}. Moving them to the trash changes no setting.`, fix: { type: 'agent-config-cleanup', label: 'Move to trash…' } }];
}

// fix -> { title, risk, steps, display, note } or { error }. ctx: { home, dataDir, bin, repos, now }.
function planMachineFix(fix, ctx) {
  const { home, bin } = ctx;
  const need = () => (bin ? null : { error: 'Claude Code was not found (not on PATH, nor bundled with Claude Desktop).' });
  const cmd = (args, cwd, label) => ({ kind: 'cmd', argv: [bin, ...args], cwd: cwd || home, label: label || `claude ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}` });
  switch (fix && fix.type) {
    case 'agent-config-cleanup': {
      const files = staleConfig(home, ctx.dataDir, ctx.now);
      if (!files.length) return { error: 'Nothing left to clean up.' };
      return { title: `Move ${files.length} stale config file${files.length === 1 ? '' : 's'} to the trash`, risk: 'safe', steps: files.map((f) => ({ kind: 'trash', path: f.path, mtime: fs.statSync(f.path).mtimeMs })), display: files.map((f) => `trash ${f.path.replace(home, '~')}`), note: 'Recoverable from the trash. No setting changes.' };
    }
    case 'plugin-disable': {
      if (need()) return need();
      const inv = inventory(home, []);
      const p = inv.plugins.find((x) => x.id === fix.plugin || x.name === fix.plugin);
      if (!p) return { error: 'That plugin is not installed.' };
      if (!p.enabled) return { error: `${p.name} is already off.` };
      return { title: `Turn off the ${p.name} plugin`, risk: 'safe', steps: [cmd(['plugin', 'disable', p.id, '--scope', 'user'])], display: [`claude plugin disable ${p.id} --scope user`], note: `It stays installed: claude plugin enable ${p.id} turns it back on. New sessions stop loading it.` };
    }
    case 'mcp-remove': case 'mcp-login': {
      if (need()) return need();
      if (!NAME_RE.test(String(fix.name || ''))) return { error: 'Bad server name.' };
      const repos = (ctx.repos || []).filter((r) => path.resolve(r.path) === path.resolve(fix.cwd || ''));
      const s = inventory(home, repos).servers.find((x) => x.name === fix.name && path.resolve(x.cwd) === path.resolve(fix.cwd || home));
      if (!s) return { error: `MCP server ${fix.name} is no longer configured there.` };
      if (fix.type === 'mcp-login') return { title: `Sign in to MCP server ${s.name}`, risk: 'safe', steps: [{ ...cmd(['mcp', 'login', s.name], s.cwd), timeout: 5 * 60 * 1000 }], display: [`claude mcp login '${s.name}'   # opens your browser`], note: 'Finish signing in in the browser window that opens; GutCheck waits up to 5 minutes.' };
      return { title: `Remove MCP server ${s.name} (${s.scope} scope)`, risk: s.scope === 'project' ? 'caution' : 'safe', steps: [cmd(['mcp', 'remove', s.name, '--scope', s.scope], s.cwd)], display: [`claude mcp remove '${s.name}' --scope ${s.scope}${s.scope === 'user' ? '' : `   # in ${s.cwd.replace(home, '~')}`}`], note: s.scope === 'project' ? 'This edits the repo\'s .mcp.json, which is shared with everyone who clones it: commit the change if you mean it.' : 'Add it again with claude mcp add if you need it later.' };
    }
    case 'skill-remove': {
      const repos = ctx.repos || [];
      const s = inventory(home, repos).skills.find((x) => x.path === fix.path);
      if (!s) return { error: 'That skill is no longer there.' };
      return { title: `Remove the ${s.name} skill${s.repo ? ` from ${s.repo}` : ''}`, risk: s.repo ? 'caution' : 'safe', steps: [{ kind: 'trash', path: s.path, mtime: fs.statSync(s.path).mtimeMs }], display: [`trash ${s.path.replace(home, '~')}`], note: s.repo ? 'The folder goes to the trash. If the repo tracks it, commit the removal.' : 'The folder goes to the trash.' };
    }
    default: return { error: 'Unknown fix.' };
  }
}

module.exports = { staleConfig, configAdvice, planMachineFix, BAK_DAYS };
