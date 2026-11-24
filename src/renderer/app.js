const $ = (id) => document.getElementById(id);
// gen counts workspace scans: an on-demand result from an older workspace is dropped. scanError: last failure per on-demand scan.
const state = { repos: new Map(), selected: null, view: 'dashboard', scanning: false, readOnly: false, clutter: null, quality: null, tests: null, picked: new Set(), trend: [], gen: 0, scanError: {} };

// DOM helper: all text goes through textContent, so repo/PR titles from GitHub can never inject markup.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'onclick') el.addEventListener('click', v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

// replaceChildren that skips null/undefined (the DOM would otherwise render the text "null").
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null));

let toastTimer;
// kind: '' (news), 'ok' (done) or 'bad' (failed). Failures stay until closed; the rest fade after 7s.
function toast(msg, kind = '') {
  const t = $('toast');
  const close = h('button', { class: 'tclose', 'aria-label': 'Dismiss' }, '×');
  close.addEventListener('click', () => (t.hidden = true));
  t.replaceChildren(h('span', { class: 'tmsg' }, msg), close);
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'bad' ? 15000 : 7000);
}

// Shared view helpers (the other renderer scripts use these too).
const plural = (n, w, pl = w + 's') => `${n.toLocaleString()} ${n === 1 ? w : pl}`;
const stat = (label, val, cls = '') => h('div', { class: 'stat ' + cls }, h('b', {}, val), h('span', {}, label));
const sevClass = (sev) => (sev === 'error' ? 'b-err' : sev === 'warn' ? 'b-warn' : '');
const healthClass = (avg) => (avg == null ? '' : avg >= 75 ? 'ok' : avg >= 55 ? 'warn' : 'err');

// Make any element keyboard-operable like a button (Tab to focus, Enter or Space to activate).
function activate(el, fn) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('click', fn);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  return el;
}

function copyButton(dir, label) {
  const b = h('button', { class: 'sm', title: 'Copy a full report with an ordered fix plan, to paste into any LLM' }, 'Copy for LLM');
  b.prepend(UI.icon('copy'));
  if (dir) UI.makeIconOnly(b, 'copy', 'Copy for LLM: a full report with an ordered fix plan, to paste into any LLM'); // on a repo page; the workspace pages keep the words
  b.addEventListener('click', () => copyForLlm(b, dir, label));
  return b;
}

// Clutter and code-quality scans run on demand. One request per kind at a time (every caller shares
// it); a result that lands after a new workspace scan started is dropped; afterwards the current view
// is redrawn, so no view is left saying "Scanning…".
const inflight = {};
function onDemand(kind, call, accept) {
  if (state.scanning) { toast('Wait for the workspace scan to finish.'); return Promise.resolve(); }
  if (inflight[kind]) return inflight[kind];
  const gen = state.gen;
  inflight[kind] = (async () => {
    try {
      const out = await call();
      if (gen !== state.gen) return;
      if (!out.ok) { state.scanError[kind] = out.error; toast(out.error, 'bad'); return; }
      delete state.scanError[kind];
      accept(out);
    } finally {
      inflight[kind] = null;
      if (gen === state.gen && state.view !== 'history') renderMain();
    }
  })();
  return inflight[kind];
}

const counts = (r) => ({
  err: r.findings.filter((f) => f.severity === 'error').length,
  warn: r.findings.filter((f) => f.severity === 'warn').length,
});

/* ---------------------------------------------------------------- stats + list */

// Same numbers as the dashboard: repos that failed to scan are not averaged in. Each one opens the
// view that explains it.
function renderStats() {
  const m = Metrics.compute([...state.repos.values()]);
  const t = m.totals;
  const go = (el, fn) => (state.repos.size ? activate(el, fn) : el);
  const toOverview = () => { renderOverview(); renderList(); };
  $('stats').replaceChildren(
    stat('Repositories', t.repos),
    stat('Avg health', m.avg == null ? '–' : m.avg, healthClass(m.avg)),
    go(stat('Errors', t.errors, t.errors ? 'err' : 'ok'), toOverview),
    go(stat('Warnings', t.warns, t.warns ? 'warn' : 'ok'), toOverview),
    stat('Open PRs', t.prs),
    stat('Failing CI', t.failingCI, t.failingCI ? 'err' : 'ok')
  );
}

// The repo list's quick filters: what kind of trouble, and which grade (the grade bar).
const REPO_FILTERS = {
  all: ['All', () => true],
  err: ['Errors', (r) => counts(r).err > 0],
  prs: ['PRs', (r) => (r.prs || []).length > 0],
  dirty: ['Changes', (r) => (r.git?.dirty || 0) + (r.git?.ahead || 0) > 0],
};
state.rfilter = 'all'; state.grade = null;
const NAV = { drift: 'baseline', dashboard: 'dashboard', overview: 'overview', quality: 'quality', tests: 'tests', secrets: 'secrets', clutter: 'clutter', history: 'history', github: 'github' };

function gradeBar(rs) {
  const bar = $('gradebar');
  const total = rs.length;
  bar.replaceChildren(...(total ? ['A', 'B', 'C', 'D'].map((g) => {
    const n = rs.filter((r) => r.grade === g).length;
    const seg = h('button', { class: `gseg g${g}${state.grade === g ? ' on' : ''}${n ? '' : ' none'}`, 'aria-pressed': state.grade === g ? 'true' : 'false', title: `Grade ${g}: ${plural(n, 'repo')}${state.grade === g ? ' (click to show all)' : ' (click to show only these)'}` }, h('b', {}, g), h('span', {}, String(n)));
    seg.style.flexGrow = String(Math.max(n, 0.35));
    seg.disabled = !n;
    seg.addEventListener('click', () => { state.grade = state.grade === g ? null : g; renderList(); });
    return seg;
  }) : []));
  const fx = Object.entries(REPO_FILTERS).map(([k, [label, f]]) => ({ value: k, label, count: k === 'all' ? null : rs.filter(f).length }));
  $('rfilter').replaceChildren(total ? UI.segmented(fx, state.rfilter, (v) => { state.rfilter = v; renderList(); }, 'Show repos') : '');
}

// Small numbers next to each view in the sidebar, once that view has something to say.
function navCounts() {
  const rs = [...state.repos.values()].filter((r) => !r.error);
  const set = (id, n, tone = '') => {
    const b = $(id);
    if (!b) return;
    let c = b.querySelector('.cnt');
    if (n == null || n === 0 || n === '') { if (c) c.remove(); return; }
    if (!c) { c = h('span', { class: 'cnt' }); b.append(c); }
    c.className = 'cnt ' + tone; c.textContent = String(n);
  };
  const groups = rs.length ? Metrics.groupFindings(rs) : [];
  set('overview', groups.length || null, groups.some((g) => g.sev === 'error') ? 'err' : 'warn');
  const s = state.secrets;
  const need = s ? s.items.filter((i) => ['unbacked', 'changed', 'missing', 'mismatch'].includes(i.status)).length : null;
  set('secrets', need, 'warn');
  const cl = state.clutter ? [...state.clutter.repos.values()].reduce((n, r) => n + r.count, 0) : null;
  set('clutter', cl, '');
}

function renderList() {
  document.body.classList.toggle('dash', state.view === 'dashboard'); // the dashboard shows these numbers itself
  for (const [view, id] of Object.entries(NAV)) { const b = $(id); if (b) { if (state.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); } }
  const q = $('q').value.toLowerCase();
  const sort = $('sort').value;
  const base = RemoteView.visible([...state.repos.values()]);
  gradeBar(base);
  navCounts();
  const pass = REPO_FILTERS[state.rfilter]?.[1] || (() => true);
  let rs = base.filter((r) => r.name.toLowerCase().includes(q) && pass(r) && (!state.grade || r.grade === state.grade));
  rs.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'prs' ? (b.prs?.length || 0) - (a.prs?.length || 0) : (a.score ?? 0) - (b.score ?? 0));
  const most = Math.max(1, ...rs.map((r) => (r.findings || []).length));
  const items = rs.map((r) => {
    const c = counts(r);
    const g = r.git || {};
    const sel = state.view === 'repo' && r.path === state.selected;
    return activate(h('li', { class: sel ? 'sel' : '', 'aria-current': sel ? 'true' : null, 'aria-label': `${r.name}, grade ${r.grade}${c.err ? `, ${c.err} errors` : ''}${c.warn ? `, ${c.warn} warnings` : ''}` },
      h('div', { class: 'grade g' + r.grade }, r.grade),
      h('div', { class: 'rinfo' },
        h('div', { class: 'rname' }, r.name),
        r.error ? h('div', { class: 'rmeta b-err' }, 'scan failed') : UI.vitals(UI.sevCounts(r.findings), most),
        h('div', { class: 'rmeta' },
          c.err ? UI.icount('error', c.err, c.err === 1 ? 'error' : 'errors', 'b-err') : null,
          c.warn ? UI.icount('alert', c.warn, c.warn === 1 ? 'warning' : 'warnings', 'b-warn') : null,
          r.prs?.length ? UI.icount('pr', r.prs.length, r.prs.length === 1 ? 'open PR' : 'open PRs') : null,
          g.dirty ? UI.icount('pencil', g.dirty, 'uncommitted changes', 'b-warn') : null,
          g.ahead ? UI.icount('arrowup', g.ahead, 'commits not pushed') : null,
          g.behind ? UI.icount('arrowdown', g.behind, 'commits to pull') : null,
          !r.remote && !r.error ? UI.badge('cloudoff', 'local only: no GitHub backup', 'b-warn') : null, RemoteView.chip(r)))), () => select(r.path));
  });
  const hidden = base.length - rs.length;
  if (hidden && base.length) {
    const clear = h('button', { class: 'sm ghost' }, 'Show all');
    clear.addEventListener('click', () => { state.rfilter = 'all'; state.grade = null; $('q').value = ''; renderList(); });
    $('rfilter').append(h('div', { class: 'lnote' }, `${plural(hidden, 'repo')} hidden by filters`, clear));
  }
  $('repos').replaceChildren(...items);
}

/* ---------------------------------------------------------------- running actions */

// items: [{ repo, action }]. Asks for inputs (single action only), previews, confirms, applies, refreshes.
// opts.ask: ask for inputs (one item only). opts.lead: lines shown at the top of the review dialog.
async function runActions(items, { ask = true, lead = [], hold = null } = {}) {
  if (state.readOnly) return toast('Read-only mode is on. Untick "Read-only" in the header to make changes.', 'bad');
  if (ask && items.length === 1) {
    const a = items[0].action;
    const spec = INPUTS[a.type];
    if (spec) {
      const prefill = { ...a };
      if (a.type === 'repo-edit' && prefill.description == null) prefill.description = items[0].repo.remote?.description || '';
      if (a.type === 'repo-edit') prefill.deleteBranchOnMerge = a.deleteBranchOnMerge ?? items[0].repo.remote?.deleteBranchOnMerge ?? false;
      const vals = await askInputs(spec, prefill);
      if (!vals) return;
      if (a.type === 'repo-edit') {
        // only send what the user actually changed
        const r = items[0].repo.remote || {};
        if (vals.description === (r.description || '')) delete vals.description;
        if (vals.deleteBranchOnMerge === (r.deleteBranchOnMerge ?? false)) delete vals.deleteBranchOnMerge;
      }
      items = [{ repo: items[0].repo, action: { ...a, ...vals } }];
    }
  }
  const plans = await window.api.planActions(items.map((i) => ({ dir: i.repo.path, action: stripUi(i.action) })));
  const bad = plans.filter((p) => !p.ok);
  const good = plans.filter((p) => p.ok);
  if (bad.length && !good.length) return toast(bad.map((p) => (p.repoName ? p.repoName + ': ' : '') + p.error).join('\n'), bad.every((p) => p.nothing) ? '' : 'bad');
  if (bad.length) toast(`Could not plan ${bad.length} change${bad.length === 1 ? '' : 's'}:\n` + bad.map((p) => `${p.repoName || '?'}: ${p.error}`).join('\n'));
  const chosen = await confirmPlans(good, { lead, hold });
  if (!chosen || !chosen.length) return;
  const gen = state.gen;
  const outs = await window.api.applyActions(chosen.map((p) => p.token), confirmOf(chosen));
  if (gen === state.gen) for (const o of outs) if (o.res) state.repos.set(o.res.path, o.res); // not into a newer workspace
  const rate = outs.find((o) => o.rate)?.rate;
  if (rate) showRate(rate);
  renderStats(); renderList(); renderMain();
  await showResults(outs);
  return outs;
}

const stripUi = (a) => { const { label, ...rest } = a; return rest; };
const actOn = (r, type, extra = {}) => () => runActions([{ repo: r, action: { type, ...extra } }]); // a button handler

/* ---------------------------------------------------------------- detail view */

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '');

function btn(label, onclick, cls = '') {
  const b = h('button', { class: 'sm ' + cls }, label);
  b.addEventListener('click', onclick);
  return b;
}

// The repo page itself (findingEl, the tabs, renderRepo) is in repo-view.js.

async function copyForLlm(b, dir, label) {
  b.disabled = true;
  try {
    const out = await window.api.copyReport(dir);
    if (!out.ok) return toast(out.error, 'bad');
    const size = out.chars < 1000 ? `${out.chars}-character` : `${Math.round(out.chars / 1000)}k-character`;
    toast(`Copied a ${size} report for ${label} to the clipboard. Paste it into your LLM. It includes repo paths, PR and branch titles and clutter file names, but no file contents.`);
  } finally { b.disabled = false; }
}

async function refreshOne(dir) {
  const gen = state.gen;
  const out = await window.api.rescan(dir, $('deep').checked);
  if (gen !== state.gen) return; // a workspace scan started meanwhile
  if (out.ok) { state.repos.set(dir, out.res); showRate(out.rate); } else toast(out.error || 'Rescan failed.', 'bad');
  renderStats(); renderList(); renderMain();
}

function renderMain() {
  if (state.view === 'clutter') renderClutterView();
  else if (state.view === 'quality') renderQualityView();
  else if (state.view === 'tests') renderTestsView();
  else if (state.view === 'secrets') renderSecrets();
  else if (state.view === 'repo' && state.repos.has(state.selected)) renderRepo();
  else if (state.view === 'history') renderHistory();
  else if (state.view === 'drift') renderDriftView();
  else if (state.view === 'overview') renderOverview();
  else if (state.view === 'github') GitHubView.render();
  else renderDashboard();
}

function select(dir) { state.selected = dir; state.view = 'repo'; renderList(); renderRepo(); }

/* ---------------------------------------------------------------- scanning */

async function startScan() {
  const root = $('root').value.trim();
  if (!root || state.scanning) return;
  // Kept so a refused scan (no such folder, one already running) leaves the results on screen.
  const prev = { repos: new Map(state.repos), clutter: state.clutter, secrets: state.secrets, quality: state.quality, tests: state.tests, selected: state.selected, view: state.view };
  state.gen++; state.scanError = {};
  state.scanning = true; state.clutter = null; state.secrets = null; state.quality = null; state.tests = null; state.picked.clear(); state.repos.clear(); state.selected = null; state.view = 'dashboard';
  $('ptext').textContent = 'Scanning…'; $('progress').hidden = false;
  $('scan').disabled = true; renderStats(); renderList(); renderMain();
  let out;
  try { out = await window.api.scan(root, $('deep').checked); } catch (e) { out = { ok: false, error: 'Scan failed: ' + ((e && e.message) || e) }; }
  finally { state.scanning = false; $('scan').disabled = false; $('progress').hidden = true; }
  showRate(out.rate);
  if (out.root) $('root').value = out.root; // "~/Projects" is shown as the folder it means
  if (!out.ok && !state.repos.size) { Object.assign(state, prev); renderStats(); renderList(); }
  await loadTrend();
  if (!out.ok) toast(out.error, 'bad');
  else if (!out.count) toast('No git repositories found under that folder.', 'bad');
  renderMain();
}

// A scan the app started on its own (scheduled) replaces the workspace too: drop the old results.
function beginBackgroundScan() {
  state.gen++; state.scanError = {};
  state.clutter = null; state.quality = null; state.tests = null; state.secrets = null; state.picked.clear(); state.repos.clear();
  renderStats(); renderList(); renderMain();
}
window.api.onBegin(({ total }) => { if (!state.scanning) beginBackgroundScan(); $('progress').hidden = false; $('bar').style.width = '0'; $('progress').setAttribute('aria-valuenow', '0'); $('ptext').textContent = `Found ${total} repositories…`; });

// Repo results can arrive faster than we can usefully paint; coalesce to one render per frame.
let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; renderStats(); renderList(); if (state.view === 'dashboard') renderDashboard(); });
}

// The API quota as a small gauge: the fuller, the more is left. Details in the tooltip.
function showRate(rate) {
  const pill = $('rate');
  if (!rate || !rate.core) { pill.replaceChildren(); pill.hidden = true; return; }
  pill.hidden = false;
  const n = (x) => x.remaining.toLocaleString();
  const left = Math.min(...[rate.core, rate.graphql].map((x) => (x.limit ? x.remaining / x.limit : x.remaining / 5000)));
  const tone = rate.limited || left < 0.1 ? 'err' : left < 0.3 ? 'warn' : 'ok';
  pill.replaceChildren(h('span', { class: 'rlabel' }, 'API'), UI.meter(Math.round(left * 100), tone), h('span', { class: 'sr' }, `API left: ${n(rate.core)} REST · ${n(rate.graphql)} GraphQL`));
  pill.classList.toggle('bad', !!rate.limited);
  pill.title = `GitHub API left: ${n(rate.core)} REST, ${n(rate.graphql)} GraphQL. Resets ${new Date(rate.core.reset).toLocaleTimeString()} (REST) / ${new Date(rate.graphql.reset).toLocaleTimeString()} (GraphQL)`;
}

// Read-only shows everywhere: the switch, a band under the header and every change button greyed.
function showReadOnly() {
  document.body.classList.toggle('ro', state.readOnly);
  $('rofence').hidden = !state.readOnly;
  const l = $('readonly').closest('label');
  l.classList.toggle('on', state.readOnly);
  const old = l.querySelector('.ic'); if (old) old.remove();
  l.prepend(UI.icon(state.readOnly ? 'lock' : 'unlock'));
}

window.api.onRepo(({ res, done, total, stage }) => {
  state.repos.set(res.path, res);
  $('bar').style.width = (done / total) * 100 + '%';
  $('progress').setAttribute('aria-valuenow', String(Math.round((done / total) * 100)));
  $('ptext').textContent = RemoteView.progress(res, done, total, stage);
  schedulePaint();
});

$('scan').addEventListener('click', startScan);
$('root').addEventListener('keydown', (e) => e.key === 'Enter' && startScan());
$('browse').addEventListener('click', async () => { const d = await window.api.pickDir(); if (d) { $('root').value = d; startScan(); } });
$('q').addEventListener('input', renderList);
$('sort').addEventListener('change', renderList);
$('overview').addEventListener('click', () => { renderOverview(); renderList(); });
$('history').addEventListener('click', () => renderHistory()); // defined in overview-view.js, loaded after this file
$('readonly').addEventListener('change', async (e) => {
  state.readOnly = e.target.checked;
  await window.api.setSettings({ readOnly: state.readOnly });
  showReadOnly();
  toast(state.readOnly ? 'Read-only mode on: no changes can be made.' : 'Read-only mode off: actions are enabled (each one still asks first).');
});

(async () => {
  state.version = await window.api.version();
  $('version').textContent = state.version ? 'v' + state.version : '';
  const s = await window.api.settings();
  if (s.root) $('root').value = s.root;
  $('deep').checked = !!s.deep;
  state.readOnly = !!s.readOnly;
  $('readonly').checked = state.readOnly;
  showReadOnly();
  const a = await window.api.authStatus();
  const pill = $('auth');
  pill.replaceChildren(UI.icon('github'), h('span', { class: 'sdot' }), h('span', { class: a.ok ? 'sr' : '' }, a.ok ? 'gh: signed in' : 'gh: not signed in (run gh auth login)'));
  pill.title = a.ok ? 'The gh command line is signed in to GitHub' : 'Run "gh auth login" in a terminal, then scan again';
  pill.classList.add(a.ok ? 'ok' : 'bad');
  renderStats();
  showRate(await window.api.rate());
})();
