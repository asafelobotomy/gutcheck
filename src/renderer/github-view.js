// "From GitHub": get a repo into the workspace folder. Two ways in: a live search of all of GitHub,
// and your own repos with whether each is here already (tick several to clone them together). Clone
// and fork go through the same review and results dialogs as every other change (modals.js), and a
// new clone joins the repo list straight away. A repo page for a repo not cloned here gets a "Clone
// here" button too (repo-view.js). Loaded after app.js, ui.js and modals.js; shares their globals.

const GitHubView = (() => {
  const gv = { tab: 'search', query: '', search: null, searching: false, error: null, mine: null, loadingMine: false, mineFilter: 'away', mineQ: '', picked: new Set() };
  let timer = null;
  let seq = 0; // only the newest search may draw
  const key = (r) => `${r.owner}/${r.name}`;
  const ago = (d) => {
    if (!d) return null;
    const days = Math.floor((Date.now() - new Date(d)) / 86400000);
    return days < 1 ? 'today' : days < 30 ? `${days}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`;
  };
  const stars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const root = () => $('root').value.trim();
  const scanned = () => state.repos.size > 0;

  // One repo: name, what it is, and either where it is here or the buttons that get it.
  function row(r, pick) {
    const away = !r.here;
    const open = r.here && state.repos.has(r.here) ? btn('Open', () => select(r.here), 'ghost') : null;
    return h('div', { class: 'row ghrow' + (away ? '' : ' here') },
      pick && away ? UI.tick(pick, key(r), () => render(), `Select ${key(r)}`) : pick ? h('span', { class: 'pickgap' }) : null,
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, key(r)), r.description ? h('span', { class: 'muted' }, '  ' + r.description) : null),
        h('div', { class: 'chips' },
          r.stars ? h('span', { class: 'chip', title: 'Stars' }, UI.icon('star'), stars(r.stars)) : null,
          r.language ? h('span', { class: 'chip' }, r.language) : null,
          r.isPrivate ? h('span', { class: 'chip' }, UI.icon('lock'), 'private') : null,
          r.isFork ? h('span', { class: 'chip' }, UI.icon('branch'), 'fork') : null,
          r.isArchived ? h('span', { class: 'chip' }, 'archived') : null,
          r.empty ? h('span', { class: 'chip' }, 'empty') : null,
          r.pushedAt ? h('span', { class: 'chip', title: new Date(r.pushedAt).toLocaleString() }, 'updated ' + ago(r.pushedAt)) : null)),
      away ? null : UI.status('ok', 'Here', r.here),
      open,
      away && !r.empty ? UI.ibtn('download', 'Clone', () => get([{ owner: r.owner, name: r.name, kind: 'clone' }]), 'fixb') : null,
      away && !r.mine ? UI.ibtn('branch', 'Fork', () => get([{ owner: r.owner, name: r.name, kind: 'fork' }])) : null,
      UI.iconOnly('github', 'Open on GitHub ↗', () => window.api.openUrl(`https://github.com/${key(r)}`), 'ghost', `Open ${key(r)} on GitHub`));
  }

  // Plan, review, run, then put the new clones in the list. items: [{ owner, name, kind }]
  async function get(items) {
    if (state.readOnly) return toast('Read-only mode is on. Turn it off in the header to clone or fork.', 'bad');
    const plans = await window.api.get.plan(items);
    const bad = plans.filter((p) => !p.ok);
    const good = plans.filter((p) => p.ok);
    if (bad.length) toast(bad.map((p) => (p.repoName ? p.repoName + ': ' : '') + p.error).join('\n'), bad.every((p) => p.nothing) || good.length ? '' : 'bad');
    if (!good.length) return;
    const chosen = await confirmPlans(good, { lead: [`Into ${root()}`] });
    if (!chosen || !chosen.length) return;
    const outs = await window.api.get.apply(chosen.map((p) => p.token));
    for (const o of outs) {
      if (!o.ok || !o.dir) continue;
      if (o.res) { state.repos.delete(o.replaced); state.repos.set(o.res.path, o.res); if (state.selected === o.replaced) state.selected = o.res.path; }
      for (const list of [gv.search && gv.search.repos, gv.mine && gv.mine.repos]) for (const r of list || []) if (o.repoName && key(r).toLowerCase() === o.repoName.toLowerCase()) r.here = o.dir;
      gv.picked.delete(o.repoName);
    }
    if (outs.some((o) => o.ok && o.dir && !o.res)) outs.push({ ok: true, repoName: 'Workspace', results: [{ text: 'Scan the workspace again to see the new clone in the list.', ok: true, out: '' }] });
    renderStats(); renderList(); renderMain();
    await showResults(outs);
  }

  async function runSearch() {
    const q = gv.query.trim();
    const mySeq = ++seq;
    if (q.length < 2) { gv.search = null; gv.error = null; gv.searching = false; return drawResults(); }
    gv.searching = true; drawResults();
    const out = await window.api.get.search(q);
    if (mySeq !== seq) return;
    gv.searching = false;
    if (out.ok) { gv.search = out; gv.error = null; } else { gv.search = null; gv.error = out.error; }
    drawResults();
  }

  function results() {
    if (gv.error) return UI.empty('alert', 'Search failed', gv.error, null, 'bad');
    if (!gv.search) return gv.searching ? h('p', { class: 'muted' }, 'Searching…') : UI.empty('scan', 'Search all of GitHub', 'Type a name, a topic or owner/name. Results show as you type.');
    if (!gv.search.repos.length) return UI.empty('scan', `Nothing found for “${gv.query.trim()}”`);
    const more = gv.search.total > gv.search.repos.length ? h('p', { class: 'muted' }, `Best ${gv.search.repos.length} of ${gv.search.total.toLocaleString()} matches. Type more to narrow it down.`) : null;
    return h('div', { class: gv.searching ? 'busy' : '' }, gv.search.repos.map((r) => row(r)), more);
  }
  // Only the results redraw while typing, so the search box keeps its focus and caret.
  function drawResults() { const el = $('ghresults'); if (el) put(el, results()); }

  function searchTab() {
    const input = h('input', { type: 'search', id: 'ghq', placeholder: 'Search GitHub, e.g. ripgrep or cli/cli', 'aria-label': 'Search GitHub', spellcheck: 'false', autocomplete: 'off' });
    input.value = gv.query;
    input.addEventListener('input', () => { gv.query = input.value; clearTimeout(timer); timer = setTimeout(runSearch, 350); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); runSearch(); } });
    return [h('div', { class: 'listhead' }, input), h('div', { id: 'ghresults' }, results())];
  }

  const MINE_FILTERS = { away: ['Not here', (r) => !r.here], here: ['Here', (r) => !!r.here], all: ['All', () => true] };
  async function loadMine() {
    if (gv.loadingMine) return;
    gv.loadingMine = true; render();
    const out = await window.api.get.mine();
    gv.loadingMine = false;
    gv.mine = out.ok ? out : { error: out.error, repos: [] };
    render();
  }
  function mineTab() {
    if (gv.loadingMine && !gv.mine) return [h('p', { class: 'muted' }, 'Listing your repos…')];
    if (!gv.mine) return [UI.empty('folder', 'Your repos on GitHub', 'See which of them are in this folder, and clone the rest.', btn('List my repos', loadMine, 'primary'))];
    if (gv.mine.error) return [UI.empty('alert', 'Could not list your repos', gv.mine.error, btn('Try again', loadMine), 'bad')];
    const all = gv.mine.repos;
    const q = gv.mineQ.toLowerCase();
    const shown = all.filter((r) => MINE_FILTERS[gv.mineFilter][1](r) && key(r).toLowerCase().includes(q));
    const cloneable = shown.filter((r) => !r.here && !r.empty);
    const sel = all.filter((r) => gv.picked.has(key(r)) && !r.here);
    const filter = h('input', { type: 'search', placeholder: 'Filter your repos…', 'aria-label': 'Filter your repos' });
    filter.value = gv.mineQ;
    filter.addEventListener('input', () => { gv.mineQ = filter.value; render(); $('ghmineq')?.focus(); });
    filter.id = 'ghmineq';
    return [
      h('div', { class: 'listhead' }, UI.tickAll(gv.picked, cloneable.map(key), render, 'Select every repo shown that is not here'),
        UI.segmented(Object.entries(MINE_FILTERS).map(([v, [label, f]]) => ({ value: v, label, count: all.filter(f).length })), gv.mineFilter, (v) => { gv.mineFilter = v; render(); }, 'Show repos'),
        filter, UI.ibtn('refresh', 'Refresh', loadMine, 'ghost')),
      UI.bulkBar(sel.length, 'repo', [btn(`Clone ${sel.length}…`, () => get(sel.map((r) => ({ owner: r.owner, name: r.name, kind: 'clone' }))), 'primary')], () => { gv.picked.clear(); render(); }),
      ...(shown.length ? [UI.more('gh-mine-' + gv.mineFilter, shown.map((r) => row(r, gv.picked)), 12, 'more repos')].flat()
        : [UI.empty('check', gv.mineFilter === 'away' && !q ? 'Every repo of yours is here' : 'No repos match', '', null, gv.mineFilter === 'away' && !q ? 'good' : '')]),
    ];
  }

  function render() {
    state.view = 'github'; state.selected = null;
    if (gv.gen !== state.gen) { gv.gen = state.gen; gv.mine = null; gv.search = null; gv.picked.clear(); if (gv.query.trim().length >= 2) runSearch(); } // "here" belongs to the scan it came from
    const d = $('detail');
    const top = d.scrollTop;
    const head = h('div', { class: 'dhead' }, h('h2', {}, 'From GitHub'));
    if (!scanned() || !root()) {
      put(d, head, UI.empty('folder', 'Scan a workspace first', 'Clones and forks go into the folder you scan, and show up in the repo list straight away.'));
      return;
    }
    const away = gv.mine ? gv.mine.repos.filter((r) => !r.here).length : null;
    put(d, head,
      h('div', { class: 'sub' }, 'New clones go into ', h('span', { class: 'chip mono' }, UI.icon('folder'), root())),
      ...UI.tabs([
        { id: 'search', label: 'Search GitHub', icon: 'scan', body: searchTab() },
        { id: 'mine', label: 'Your repos', icon: 'folder', count: away || null, tone: away ? 'warn' : '', body: mineTab() },
      ], gv.tab, (id) => { gv.tab = id; render(); if (id === 'mine' && !gv.mine) loadMine(); else if (id === 'search') $('ghq')?.focus(); }));
    d.scrollTop = top;
  }

  function open() { state.view = 'github'; state.selected = null; renderList(); render(); if (gv.tab === 'search') $('ghq')?.focus(); }
  $('github').addEventListener('click', open);
  return { render, get, open, state: gv };
})();
