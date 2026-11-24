// Workspace overview (recommendations grouped across repos, "Fix all") and the action History.
// Loaded after app.js and modals.js; shares their globals ($, h, put, btn, state, runActions, plural...).

/* ---------------------------------------------------------------- overview + history */

const BULKABLE = new Set(['add-file', 'run-rerun', 'pull', 'push', 'delete-merged', 'security-enable', 'fetch', 'npm-install', 'worktree-prune']);

const ovView = { sev: 'all', q: '' };
const ovPick = new Set(); // group keys ticked for a bulk fix
const groupKey = (g) => g.cat + '|' + g.title;
const SEV_NAME = { error: 'Errors', warn: 'Warnings', info: 'Notes' };

// Repo names as chips that open the repo; long lists fold after six.
function repoChips(g) {
  const byName = new Map([...state.repos.values()].map((r) => [r.name, r.path]));
  const chips = g.repos.map((n) => { const c = h('span', { class: 'chip link' }, n); activate(c, () => { const p = byName.get(n); if (p) select(p); }); return c; });
  return h('div', { class: 'chips' }, chips.length > 6 ? [...chips.slice(0, 6), h('span', { class: 'chip more', title: g.repos.slice(6).join(', ') }, `+${chips.length - 6} more`)] : chips);
}

// Workspace-wide recommendations: identical findings grouped across repos, most severe first, in
// folding sections per severity. Groups GutCheck can fix everywhere at once can be ticked together.
function renderOverview() {
  state.view = 'overview'; state.selected = null;
  const d = $('detail');
  const top = d.scrollTop;
  const list = Metrics.groupFindings([...state.repos.values()].filter((r) => !r.error));
  const bulkOk = (g) => g.fixes.length > 1 && g.fixes.every((f) => f && BULKABLE.has(f.action.type) && RemoteView.canFix(f.repo, f.action));
  const q = ovView.q.toLowerCase();
  const shown = list.filter((g) => (ovView.sev === 'all' || g.sev === ovView.sev) && (!q || g.title.toLowerCase().includes(q) || g.cat.toLowerCase().includes(q) || g.repos.some((n) => n.toLowerCase().includes(q))));
  const bulkable = shown.filter(bulkOk);
  for (const k of [...ovPick]) if (!list.some((g) => groupKey(g) === k && bulkOk(g))) ovPick.delete(k);
  const chosen = list.filter((g) => ovPick.has(groupKey(g)));
  const fixes = chosen.flatMap((g) => g.fixes);
  const head = [h('div', { class: 'dhead' }, h('h2', {}, 'Workspace overview'), list.length ? h('span', { class: 'pill' }, plural(list.length, 'issue type')) : null),
    state.repos.size ? h('div', { class: 'toolbar' }, copyButton(null, 'the whole workspace')) : null];
  if (!list.length) return put(d, ...head, state.repos.size ? UI.empty('check', 'Nothing to recommend', 'No repo has an open issue.', null, 'good') : UI.empty('scan', 'No scan yet', 'Choose a workspace folder and press Scan.'));
  const c = { error: 0, warn: 0, info: 0 };
  for (const g of list) c[g.sev]++;
  const search = h('input', { type: 'search', placeholder: 'Filter issues or repos…', 'aria-label': 'Filter issues', value: ovView.q });
  search.addEventListener('input', () => { ovView.q = search.value; renderOverview(); const s = $('detail').querySelector('input[type=search]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
  const card = (g) => h('div', { class: 'rec sev-' + g.sev },
    bulkOk(g) ? UI.tick(ovPick, groupKey(g), renderOverview, `Select: ${g.title}`) : h('span', { class: 'pickgap', title: 'Fix these one repo at a time' }),
    h('span', { class: 'n ' + sevClass(g.sev), title: `${plural(g.repos.length, 'repo')} affected` }, g.repos.length),
    h('div', { class: 'grow' }, h('div', { class: 'rtitle' }, g.title, h('span', { class: 'pill' }, g.cat)), repoChips(g)),
    bulkOk(g) ? btn(`Fix all ${g.fixes.length}…`, () => runActions(g.fixes, { ask: false, hold: FixAll.automatic })) : null);
  put(d, ...head,
    h('div', { class: 'listhead' }, UI.tickAll(ovPick, bulkable.map(groupKey), renderOverview, 'Select every issue that can be fixed in bulk'),
      UI.segmented([{ value: 'all', label: 'All', count: list.length }, { value: 'error', label: 'Errors', count: c.error, dot: 'err' }, { value: 'warn', label: 'Warnings', count: c.warn, dot: 'warn' }, { value: 'info', label: 'Notes', count: c.info, dot: 'info' }],
        ovView.sev, (v) => { ovView.sev = v; renderOverview(); }, 'Show issues by severity'), search),
    UI.bulkBar(chosen.length, 'issue type', [btn(`Fix ${plural(fixes.length, 'repo')}…`, async () => { if (await runActions(fixes, { ask: false, hold: FixAll.automatic })) ovPick.clear(); }, 'primary')], () => { ovPick.clear(); renderOverview(); }),
    ...['error', 'warn', 'info'].map((sev) => {
      const gs = shown.filter((g) => g.sev === sev);
      return gs.length ? UI.fold('ov|' + sev, [h('span', { class: 'dot d-' + (sev === 'error' ? 'err' : sev) }), h('span', { class: 'ftitle' }, SEV_NAME[sev]), h('span', { class: 'cnt' }, String(gs.length))], UI.more('ov-more|' + sev, gs.map(card), 12, 'more issues'), { open: sev !== 'info' || ovView.sev === 'info', cls: 'cat' }) : null;
    }),
    shown.length ? null : h('p', { class: 'empty' }, 'No issues match the filter.'));
  d.scrollTop = top;
}

const histView = { status: 'all', q: '' };
async function renderHistory() {
  state.view = 'history'; state.selected = null;
  renderList();
  const entries = await window.api.audit();
  if (state.view !== 'history') return; // the user moved on while it loaded
  drawHistory(entries);
}

// Changes grouped by day, newest first; each shows its commands on demand.
function drawHistory(entries) {
  const failed = entries.filter((e) => !e.ok).length;
  const q = histView.q.toLowerCase();
  const shown = entries.filter((e) => (histView.status === 'all' || (histView.status === 'failed') === !e.ok) && (!q || `${e.repo} ${e.title}`.toLowerCase().includes(q)));
  const days = new Map();
  for (const e of shown) { const k = new Date(e.ts).toDateString(); if (!days.has(k)) days.set(k, []); days.get(k).push(e); }
  const today = new Date().toDateString();
  const search = h('input', { type: 'search', placeholder: 'Filter by repo or change…', 'aria-label': 'Filter history', value: histView.q });
  search.addEventListener('input', () => { histView.q = search.value; drawHistory(entries); const s = $('detail').querySelector('input[type=search]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
  const row = (e) => h('div', { class: 'finding hist ' + (e.ok ? 'done' : 'error') },
    UI.icon(e.ok ? 'check' : 'x', 'sev'),
    h('div', { class: 't' }, h('b', {}, `${e.ok ? '✓' : '✗'} ${e.repo}: ${e.title}`),
      h('span', {}, new Date(e.ts).toLocaleTimeString(), e.via && e.via !== 'app' ? ` · via ${e.via}` : ''),
      (e.steps || []).length ? h('details', { class: 'cmds' }, h('summary', {}, plural(e.steps.length, 'command')), ...e.steps.map((s) => h('code', {}, s.cmd))) : null));
  put($('detail'),
    h('div', { class: 'dhead' }, h('h2', {}, 'History'), entries.length ? h('span', { class: 'pill' }, plural(entries.length, 'change')) : null),
    h('p', { class: 'sub' }, 'Every change GutCheck has made on this machine, newest first.'),
    entries.length ? h('div', { class: 'listhead' }, UI.segmented([{ value: 'all', label: 'All', count: entries.length }, { value: 'done', label: 'Succeeded', count: entries.length - failed, dot: 'ok' }, { value: 'failed', label: 'Failed', count: failed, dot: 'err' }], histView.status, (v) => { histView.status = v; drawHistory(entries); }, 'Show changes'), search) : null,
    entries.length ? null : UI.empty('history', 'Nothing yet', 'Changes you make from GutCheck are listed here, with the exact commands that ran.'),
    ...[...days].map(([day, es], i) => UI.fold('hist|' + day, [h('span', { class: 'ftitle' }, day === today ? 'Today' : new Date(es[0].ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })), es.some((e) => !e.ok) ? UI.status('err', `${es.filter((e) => !e.ok).length} failed`) : null, h('span', { class: 'cnt' }, String(es.length))], es.map(row), { open: i < 3, cls: 'cat' })),
    entries.length && !shown.length ? h('p', { class: 'empty' }, 'No changes match the filter.') : null);
}
