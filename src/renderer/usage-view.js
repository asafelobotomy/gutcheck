// AI agent setup beyond one repo: the opt-in usage and health check (which skills, plugins and MCP
// servers are used, and whether each server works), and machine-level fixes planned in the main
// process (stale config files, turning plugins off, removing or signing in to MCP servers, removing
// skills). Loaded after modals.js, clutter-view.js and agents-view.js; shares their globals.

// Plan a machine-level fix, show it, apply it.
async function runMachineFix(fix) {
  if (state.readOnly) return toast('Read-only mode is on. Untick "Read-only" in the header to make changes.', 'bad');
  const p = await window.api.planAgentFix(fix);
  if (!p.ok) { toast(p.error, 'bad'); return false; }
  if (!(await reviewAgentPlan(p))) return false;
  const r = await window.api.applyAgent(p.token);
  await showResults([{ ok: r.ok, repoName: 'Agent setup', error: r.error, results: r.results }]);
  return r.ok;
}

// A repo's permission rules: redacted shapes, the flagged ones ticked. "Show" fetches one value from the
// file for this dialog only (never saved, logged or reported); "Remove" plans removing the ticked rules.
async function reviewRules(r, flagged = []) {
  const res = await window.api.agentRules(r.path);
  if (!res.ok) return toast(res.error, 'bad');
  const picked = new Set(flagged);
  const out = await modal((box, close) => {
    box.classList.add('wide');
    const go = h('button', { class: 'primary' });
    const label = () => { go.textContent = `Remove ${picked.size} rule${picked.size === 1 ? '' : 's'}…`; go.disabled = !picked.size || state.readOnly; };
    go.addEventListener('click', () => close([...picked]));
    const rows = res.rules.map((x) => {
      const tick = h('input', { type: 'checkbox', 'aria-label': `Remove rule #${x.hash}` });
      tick.checked = picked.has(x.hash);
      tick.addEventListener('change', () => { if (tick.checked) picked.add(x.hash); else picked.delete(x.hash); label(); });
      const value = h('code', { class: 'rule-value' });
      value.hidden = true;
      const show = h('button', { class: 'sm' }, 'Show');
      show.addEventListener('click', async () => {
        if (!value.hidden) { value.hidden = true; value.textContent = ''; show.textContent = 'Show'; return; }
        const v = await window.api.revealRule(r.path, x.hash);
        if (!v.ok) return toast(v.error, 'bad');
        value.textContent = v.value; value.hidden = false; show.textContent = 'Hide';
      });
      return h('div', { class: 'row' }, tick, h('div', { class: 'grow' }, h('b', {}, x.shape), ' ', h('span', { class: 'muted' }, `#${x.hash}${x.tokenLike ? ' · token-like' : x.oneOff ? ' · one-off' : ''}`), value), show);
    });
    label();
    box.append(h('h3', { class: 'mh' }, `Permission rules in ${r.name}`),
      h('p', { class: 'sub' }, '.claude/settings.local.json. Values stay hidden: Show reads one from the file for this window only; it is never saved, logged or put in a report.'),
      rows.length ? h('div', { class: 'plans' }, rows) : h('p', { class: 'ok-msg' }, 'No rules.'),
      h('div', { class: 'mbtns' }, h('button', { onclick: () => close(null) }, 'Cancel'), go));
  });
  if (out && out.length) return runActions([{ repo: r, action: { type: 'permissions-prune', hashes: out } }]);
}

// Two separate consents: reading transcripts (always, for this check), and starting MCP servers.
function askUsageConsent() {
  return modal((box, close) => {
    const live = h('input', { type: 'checkbox' });
    live.disabled = state.readOnly;
    box.classList.add('wide');
    box.append(h('h3', { class: 'mh' }, 'Check what your agents use'),
      h('p', { class: 'sub' }, 'GutCheck reads the last 28 days of Claude Code session transcripts, but only tool names, the skills and /commands used, and Bash commands to test permission rules against. No text is stored or shown, and nothing leaves this computer.'),
      h('label', { class: 'frow chk' }, live, ' Also start each MCP server once to see whether it works (runs `claude mcp list`, which runs each server\'s own code; recorded in History)'),
      state.readOnly ? h('p', { class: 'muted' }, 'Read-only mode is on, so servers are not started.') : null,
      h('div', { class: 'mbtns' }, h('button', { onclick: () => close(null) }, 'Cancel'), h('button', { class: 'primary', onclick: () => close({ live: live.checked }) }, 'Check')));
  });
}

async function openUsage() {
  const c = await askUsageConsent();
  if (!c) return;
  toast(c.live ? 'Reading transcripts and checking MCP servers…' : 'Reading transcripts…');
  const r = await window.api.agentUsage(c.live);
  if (!r.ok) return toast(r.error, 'bad');
  const items = r.items || [];
  await modal((box, close) => {
    box.classList.add('wide');
    const row = (f) => {
      const el = adviceEl(f.repoPath ? state.repos.get(f.repoPath) || null : null, f);
      el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => close(), { capture: true }));
      return el;
    };
    box.append(h('h3', { class: 'mh' }, 'Agent usage and health'),
      h('p', { class: 'sub' }, `${r.sessions} sessions in the last 28 days; ${r.inventory.plugins} plugins, ${r.inventory.servers} MCP servers in your config and ${r.inventory.skills} skills.${r.servers ? ` ${r.servers.filter((s) => s.status === 'working').length} of ${r.servers.length} servers work.` : ''}`),
      items.length ? h('div', { class: 'plans' }, items.map(row)) : h('p', { class: 'ok-msg' }, 'Everything you have set up was used, and nothing is broken.'),
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => close() }, 'Close')));
  });
}
