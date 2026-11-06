// Settings > AI agents: connect GutCheck's MCP server to the coding agents installed here.
// Every connection is planned in the main process and shown (exact command or JSON) before it runs.
// Loaded after modals.js and shares its globals (h, modal, toast).

/* ---------------------------------------------------------------- AI agents */

async function openAgents() {
  let st = await window.api.agents();
  await modal((box, close) => {
    box.classList.add('wide');
    const allow = h('input', { type: 'checkbox' });
    allow.checked = !!st.allowActions;
    const list = h('div', { class: 'plans' });
    const cmd = h('code', {});

    // Claude Code session history: how many days it keeps (only when Claude Code is set up here).
    const cleanupRow = () => {
      const sel = h('select', { 'aria-label': 'Days of Claude Code session history to keep' }, [1, 3, 7, 14, 30, 60, 90].map((d) => h('option', { value: d }, `${d} days`)));
      sel.value = String(st.cleanupPeriodDays || 30);
      return h('div', { class: 'plan safe' }, h('div', { class: 'phead' }, h('b', {}, 'Claude Code session history')),
        h('div', { class: 'muted' }, `Kept for ${st.cleanupPeriodDays || 30} days${st.cleanupPeriodDays ? '' : ' (default)'}. Shorter keeps ~/.claude/projects small; older sessions can no longer be resumed.`),
        h('div', { class: 'mbtns left' }, sel, h('button', { onclick: async () => { if (await runCleanup(Number(sel.value))) { st = await window.api.agents(allow.checked); box.querySelector('.cleanup-row')?.replaceWith(Object.assign(cleanupRow(), { className: 'plan safe cleanup-row' })); } } }, 'Apply')));
    };
    const render = () => {
      cmd.textContent = st.command;
      list.replaceChildren(...st.clients.map((c) => {
        const state = c.configured ? h('span', { class: 'risk r-safe' }, 'Connected') : c.installed ? h('span', { class: 'risk' }, 'Installed') : h('span', { class: 'muted' }, 'Not found');
        const act = async (remove) => {
          const p = await window.api.planAgent(c.id, allow.checked, remove);
          if (!p.ok) { toast(p.error, 'bad'); return; }
          if (!(await reviewAgentPlan(p))) return;
          const r = await window.api.applyAgent(p.token);
          await showResults([{ ok: r.ok, repoName: c.name, error: r.error, results: r.results }]);
          if (r.ok && r.note) toast(r.note);
          st = await window.api.agents();
          render();
        };
        return h('div', { class: 'plan safe agent', 'data-agent': c.id },
          h('div', { class: 'phead' }, h('b', {}, c.name), state),
          h('div', { class: 'muted' }, c.kind === 'cli' ? 'Added with its own command line.' : `Config file: ${c.file}`),
          h('details', {}, h('summary', {}, c.kind === 'cli' ? 'Command' : 'Config snippet'), h('pre', { class: 'prev' }, c.snippet)),
          h('div', { class: 'mbtns left' },
            h('button', { class: 'primary', disabled: !c.installed || undefined, title: c.installed ? '' : `${c.name} was not found on this computer`, onclick: () => act(false) }, c.configured ? 'Update' : 'Connect'),
            c.configured ? h('button', { onclick: () => act(true) }, 'Disconnect') : null,
            h('button', { onclick: async () => { const r = await window.api.copyAgent(c.id, allow.checked); toast(r.ok ? 'Copied to the clipboard.' : 'Could not copy.', r.ok ? undefined : 'bad'); } }, 'Copy'),
            h('button', { onclick: () => window.api.openUrl(c.docs) }, 'Docs')));
      }));
    };
    // The command shown (and copied) follows the checkbox; nothing is saved until Connect.
    allow.addEventListener('change', async () => { st = await window.api.agents(allow.checked); render(); });

    box.append(
      h('h3', { class: 'mh' }, 'AI agents'),
      h('p', { class: 'sub' }, 'Connect an agent and it can use GutCheck\'s scans, findings, report and fixes as MCP tools (gutcheck_overview, gutcheck_findings, gutcheck_plan…), without looking up git or gh commands. It runs this command:'),
      h('div', {}, cmd),
      h('label', { class: 'frow chk' }, allow, ' Let agents plan and apply fixes (--allow-actions). Each change is still a single-use plan, the Read-only switch still stops it, and everything is recorded in History. Off: agents can only read.'),
      list,
      st.cleanupPeriodDays !== undefined ? Object.assign(cleanupRow(), { className: 'plan safe cleanup-row' }) : null,
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => close() }, 'Close')));
    render();
  });
}

// Claude Code's cleanupPeriodDays: plan, review, apply (also used by the workspace advice button).
async function runCleanup(days) {
  const p = await window.api.planCleanup(days);
  if (!p.ok) { toast(p.error, 'bad'); return false; }
  if (!(await reviewAgentPlan(p))) return false;
  const r = await window.api.applyAgent(p.token);
  await showResults([{ ok: r.ok, repoName: 'Claude Code', error: r.error, results: r.results }]);
  return r.ok;
}

// The exact change, before it runs.
function reviewAgentPlan(p) {
  return modal((box, close) => {
    box.classList.add('wide');
    box.append(h('h3', { class: 'mh' }, p.title),
      h('p', { class: 'sub' }, 'This exact change will be made, and nothing else.'),
      ...p.display.map((d) => h('div', {}, h('code', {}, d))),
      p.preview ? h('pre', { class: 'prev' }, p.preview) : null,
      p.allowActions ? h('div', { class: 'warnbox' }, 'Agents will be able to plan and apply fixes (--allow-actions).') : h('div', { class: 'muted' }, 'Read-only: agents can scan and read, not change anything.'),
      p.note ? h('div', { class: 'muted' }, p.note) : null,
      h('div', { class: 'mbtns' }, h('button', { onclick: () => close(false) }, 'Cancel'), h('button', { class: 'primary', onclick: () => close(true) }, 'Apply')));
  });
}
