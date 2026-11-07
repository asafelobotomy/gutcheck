// Clutter & tidy-up view. Loaded after app.js and shares its globals ($, h, put, btn, state, toast,
// runActions, renderList). app.js's renderMain() calls renderClutterView() at runtime.

/* ---------------------------------------------------------------- clutter + tidy-up */

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const CAT_LABEL = { env: 'env file', duplicate: 'duplicate', backup: 'backup', temp: 'temp', junk: 'junk', cache: 'cache', 'test-artifact': 'test output', log: 'log', build: 'build output' };
const CONF_TIP = { high: 'Safe to remove: regenerable or an exact copy', medium: 'Probably clutter: check first', low: 'Maybe clutter: review before removing' };
const pkey = (repoPath, rel) => repoPath + '\u0000' + rel;

// state.clutter: { repos: Map(path -> result), workspace: [advice] } ; state.picked: Set(pkey)
function preselect(res) {
  for (const it of res.items) {
    const k = pkey(res.path, it.path);
    if (it.confidence === 'high' && !it.costly) state.picked.add(k); else state.picked.delete(k); // build output is slow to rebuild: opt in
  }
}

// `dirs` limits the scan to those repos (after a removal), otherwise the whole workspace.
function scanClutterNow(dirs) {
  return onDemand('clutter', () => window.api.clutterScan(dirs), (out) => {
    if (!state.clutter) state.clutter = { repos: new Map(), workspace: [] };
    if (!dirs) { state.clutter.repos.clear(); state.picked.clear(); }
    for (const r of out.repos) { state.clutter.repos.set(r.path, r); preselect(r); }
    if (out.workspace) state.clutter.workspace = out.workspace;
  });
}

function openClutter() {
  state.view = 'clutter'; state.selected = null;
  renderList(); renderClutterView();
  if (!state.clutter && state.repos.size) scanClutterNow();
}

function adviceEl(r, f) {
  return h('div', { class: 'finding ' + f.severity },
    h('div', { class: 't' }, h('b', {}, f.title), h('span', {}, f.detail || '')),
    f.fix && r && f.fix.type === 'permissions-prune' ? btn('Review rules…', () => reviewRules(r, f.fix.hashes)) : null,
    f.fix && r && f.fix.type !== 'permissions-prune' ? btn(f.fix.label, async () => { if (await runActions([{ repo: r, action: f.fix }])) await scanClutterNow([r.path]); }) : null,
    f.fix && !r && f.fix.type === 'claude-cleanup-days' ? btn(f.fix.label, () => runCleanup(f.fix.days)) : null,
    f.fix && !r && f.fix.type !== 'claude-cleanup-days' ? btn(f.fix.label, async () => { if (await runMachineFix(f.fix) && state.clutter) await scanClutterNow(); }) : null);
}

async function removePicked(paths) {
  const items = [];
  for (const rp of paths) {
    const res = state.clutter.repos.get(rp);
    const sel = res.items.filter((i) => state.picked.has(pkey(rp, i.path))).map((i) => i.path);
    if (sel.length && state.repos.has(rp)) items.push({ repo: state.repos.get(rp), action: { type: 'clean-clutter', paths: sel } });
  }
  if (!items.length) return toast('Nothing selected.');
  const outs = await runActions(items, { ask: false });
  if (outs) await scanClutterNow(items.map((i) => i.repo.path));
}

function clutterRepoEl(res) {
  const r = state.repos.get(res.path);
  const sel = res.items.filter((i) => state.picked.has(pkey(res.path, i.path)));
  const selSize = sel.reduce((n, i) => n + i.size, 0);
  const removeBtn = btn(`Remove selected (${sel.length}, ${fmtSize(selSize)})…`, () => removePicked([res.path]), 'dng');
  removeBtn.disabled = !sel.length || state.readOnly;
  const setAll = (on) => { for (const i of res.items) on && i.confidence !== 'low' ? state.picked.add(pkey(res.path, i.path)) : state.picked.delete(pkey(res.path, i.path)); renderClutterView(); };
  const rows = res.items.map((i) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = state.picked.has(pkey(res.path, i.path));
    cb.addEventListener('change', () => { cb.checked ? state.picked.add(pkey(res.path, i.path)) : state.picked.delete(pkey(res.path, i.path)); renderClutterView(); });
    return h('label', { class: 'crow' }, cb,
      h('div', { class: 'grow' }, h('b', {}, i.path + (i.kind === 'dir' ? '/' : '')), ' ',
        h('span', { class: 'badge' }, CAT_LABEL[i.category] || i.category),
        h('span', { class: 'badge conf-' + i.confidence, title: CONF_TIP[i.confidence] }, i.confidence),
        i.ignored ? h('span', { class: 'badge' }, 'git-ignored') : null,
        h('div', { class: 'muted' }, `${i.reason} · ${fmtSize(i.size)} · ${i.ageDays ? `${i.ageDays}d old` : 'today'}${i.keep ? ` · keeps ${i.keep}` : ''}`)));
  });
  return h('div', { class: 'cblock' },
    h('h3', {}, `${res.name}`, h('span', { class: 'pill' }, `${plural(res.count, 'item')} · ${fmtSize(res.totalSize)}`)),
    res.error ? h('p', { class: 'b-err' }, res.error) : null,
    res.truncated ? h('p', { class: 'muted' }, 'Very large repo: only part of it was scanned.') : null,
    res.items.length ? h('div', { class: 'toolbar' }, removeBtn, btn('Select all likely', () => setAll(true)), btn('Select none', () => setAll(false))) : null,
    ...rows,
    ...res.advice.map((f) => adviceEl(r, f)));
}

function renderClutterView() {
  if (state.view !== 'clutter') return;
  const c = state.clutter;
  const head = [h('h2', {}, 'Clutter & tidy-up'),
    h('p', { class: 'sub' }, 'Caches, temp and backup files, stray env files (never opened) and tidy-up advice. Tracked files are never offered, every removal is previewed, and anything that cannot be rebuilt goes to your trash.')];
  if (!c) {
    const err = state.scanError.clutter;
    const msg = !state.repos.size ? 'Choose a workspace folder and press Scan first.' : err ? `Clutter scan failed: ${err}` : 'Scanning…';
    return put($('detail'), ...head, h('p', { class: err ? 'b-err' : 'empty' }, msg), err ? btn('Try again', () => scanClutterNow()) : null);
  }
  const repos = [...c.repos.values()].filter((r) => r.items.length || r.advice.length || r.error);
  const total = [...c.repos.values()].reduce((a, r) => ({ n: a.n + r.count, size: a.size + r.totalSize }), { n: 0, size: 0 });
  const picked = [...c.repos.values()].map((r) => ({ r, s: r.items.filter((i) => state.picked.has(pkey(r.path, i.path))) })).filter((x) => x.s.length);
  const pickedSize = picked.reduce((n, x) => n + x.s.reduce((m, i) => m + i.size, 0), 0);
  const pickedN = picked.reduce((n, x) => n + x.s.length, 0);
  const all = btn(`Remove all selected (${pickedN}, ${fmtSize(pickedSize)})…`, () => removePicked(picked.map((x) => x.r.path)), 'dng');
  all.disabled = !pickedN || state.readOnly;
  const top = $('detail').scrollTop;
  const rescan = btn('Rescan', (e) => { e.target.disabled = true; scanClutterNow(); });
  put($('detail'), ...head,
    h('div', { class: 'toolbar' }, rescan, all, h('span', { class: 'muted' }, `${plural(total.n, 'item')}, ${fmtSize(total.size)} found across ${plural(c.repos.size, 'repo')}`)),
    repos.length ? repos.map(clutterRepoEl) : h('p', { class: 'ok-msg' }, 'No clutter found. Tidy.'),
    c.workspace.length ? [h('h3', {}, 'Workspace and this machine'), ...c.workspace.map((f) => adviceEl(null, f))] : null);
  $('detail').scrollTop = top;
}

$('clutter').addEventListener('click', openClutter);
