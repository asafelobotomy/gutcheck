// Workspace overview (recommendations grouped across repos, "Fix all") and the action History.
// Loaded after app.js and modals.js; shares their globals ($, h, put, btn, state, runActions, plural...).

/* ---------------------------------------------------------------- overview + history */

const BULKABLE = new Set(['add-file', 'run-rerun', 'pull', 'push', 'delete-merged', 'security-enable', 'fetch', 'npm-install', 'worktree-prune']);

// Workspace-wide recommendations: group identical findings across repos, biggest impact first.
function renderOverview() {
  state.view = 'overview'; state.selected = null;
  const list = Metrics.groupFindings([...state.repos.values()].filter((r) => !r.error));
  put($('detail'), 
    h('h2', {}, 'Workspace overview'),
    state.repos.size ? h('div', { class: 'toolbar' }, copyButton(null, 'the whole workspace')) : null,
    list.length ? h('p', { class: 'sub' }, 'Recommendations grouped across all repositories, most severe first. "Fix all" previews every command before anything runs.') : h('p', { class: 'empty' }, state.repos.size ? 'Nothing to recommend.' : 'Choose a workspace folder and press Scan.'),
    ...list.map((g) => {
      const bulk = g.fixes.every((f) => f && BULKABLE.has(f.action.type)) && g.fixes.length > 1;
      return h('div', { class: 'rec' }, h('span', { class: 'n ' + sevClass(g.sev) }, g.repos.length),
        h('div', { class: 'grow' }, h('div', {}, `${g.title}  `, h('span', { class: 'pill' }, g.cat)), h('div', { class: 'repos' }, g.repos.join(', '))),
        bulk ? btn(`Fix all ${g.fixes.length}…`, () => runActions(g.fixes, { ask: false })) : null);
    }));
}

async function renderHistory() {
  state.view = 'history'; state.selected = null;
  renderList();
  const entries = await window.api.audit();
  if (state.view !== 'history') return; // the user moved on while it loaded
  put($('detail'), 
    h('h2', {}, 'Action history'),
    h('p', { class: 'sub' }, 'Everything GutCheck has changed on this machine (newest first). Stored locally in the app data folder.'),
    entries.length ? null : h('p', { class: 'empty' }, 'Nothing yet.'),
    ...entries.map((e) => h('div', { class: 'finding ' + (e.ok ? '' : 'error') },
      h('div', { class: 't' }, h('b', {}, `${e.ok ? '✓' : '✗'} ${e.repo}: ${e.title}`),
        h('span', {}, new Date(e.ts).toLocaleString() + ' · ' + (e.steps || []).map((s) => s.cmd).join('  ;  '))))));
}
