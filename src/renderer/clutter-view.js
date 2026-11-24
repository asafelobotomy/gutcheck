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
  if (f.fix && /^secret-/.test(f.fix.type)) return secretAdviceEl(f); // secrets-view.js: picks the files, or opens the password manager panel
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

const clView = { conf: 'all' };
const CONF_NAME = { high: 'Safe', medium: 'Probably', low: 'Maybe' };

function clutterRepoEl(res, biggest) {
  const r = state.repos.get(res.path);
  const sel = res.items.filter((i) => state.picked.has(pkey(res.path, i.path)));
  const selSize = sel.reduce((n, i) => n + i.size, 0);
  const removeBtn = btn(`Remove selected (${sel.length}, ${fmtSize(selSize)})…`, () => removePicked([res.path]), 'dng');
  removeBtn.disabled = !sel.length || state.readOnly;
  const setAll = (on) => { for (const i of res.items) on && i.confidence !== 'low' ? state.picked.add(pkey(res.path, i.path)) : state.picked.delete(pkey(res.path, i.path)); renderClutterView(); };
  const rows = res.items.filter((i) => clView.conf === 'all' || i.confidence === clView.conf).map((i) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = state.picked.has(pkey(res.path, i.path));
    cb.addEventListener('change', () => { cb.checked ? state.picked.add(pkey(res.path, i.path)) : state.picked.delete(pkey(res.path, i.path)); renderClutterView(); });
    return h('label', { class: 'crow' }, cb,
      h('div', { class: 'grow' }, h('b', {}, i.path + (i.kind === 'dir' ? '/' : '')), ' ',
        h('span', { class: 'badge' }, CAT_LABEL[i.category] || i.category),
        h('span', { class: 'badge conf-' + i.confidence, title: CONF_TIP[i.confidence] }, i.confidence),
        i.ignored ? h('span', { class: 'badge' }, 'git-ignored') : null,
        h('div', { class: 'muted' }, `${i.reason} · ${i.ageDays ? `${i.ageDays}d old` : 'today'}${i.keep ? ` · keeps ${i.keep}` : ''}`)),
      UI.meter(biggest ? Math.round((i.size / biggest) * 100) : 0, i.confidence === 'high' ? 'ok' : i.confidence === 'medium' ? 'warn' : 'info', fmtSize(i.size)));
  });
  const size = h('span', { class: 'pill', title: res.compressed ? `This disk compresses files (${res.compressed}): these sizes are before compression, so removing them frees less. The result shows what was really freed.` : '' }, `${plural(res.count, 'item')} · ${fmtSize(res.totalSize)}${res.compressed ? ' before compression' : ''}`);
  return UI.fold('clutter|' + res.path, [h('span', { class: 'ftitle' }, res.name), size, sel.length ? UI.status('info', `${sel.length} selected`) : null, res.advice.length ? UI.status('warn', plural(res.advice.length, 'tip')) : null],
    [res.error ? h('p', { class: 'b-err' }, res.error) : null,
      res.truncated ? h('p', { class: 'muted' }, 'Very large repo: only part of it was scanned.') : null,
      res.items.length ? h('div', { class: 'toolbar' }, removeBtn, btn('Select all likely', () => setAll(true)), btn('Select none', () => setAll(false))) : null,
      ...rows, ...res.advice.map((f) => adviceEl(r, f))], { open: true, cls: 'cat cblock' });
}

function renderClutterView() {
  if (state.view !== 'clutter') return;
  const c = state.clutter;
  const head = [h('div', { class: 'dhead' }, h('h2', {}, 'Clutter & tidy-up')),
    h('p', { class: 'sub' }, 'Caches, temp and backup files, stray env files (never opened) and tidy-up advice. Tracked files are never offered, every removal is previewed, and anything that cannot be rebuilt goes to your trash.')];
  if (!c) {
    const err = state.scanError.clutter;
    const msg = !state.repos.size ? 'Choose a workspace folder and press Scan first.' : err ? `Clutter scan failed: ${err}` : 'Scanning…';
    return put($('detail'), ...head, h('p', { class: err ? 'b-err' : 'empty' }, msg), err ? btn('Try again', () => scanClutterNow()) : null);
  }
  const repos = [...c.repos.values()].filter((r) => r.items.length || r.advice.length || r.error).sort((a, b) => b.totalSize - a.totalSize);
  const items = [...c.repos.values()].flatMap((r) => r.items);
  const total = [...c.repos.values()].reduce((a, r) => ({ n: a.n + r.count, size: a.size + r.totalSize }), { n: 0, size: 0 });
  const picked = [...c.repos.values()].map((r) => ({ r, s: r.items.filter((i) => state.picked.has(pkey(r.path, i.path))) })).filter((x) => x.s.length);
  const pickedSize = picked.reduce((n, x) => n + x.s.reduce((m, i) => m + i.size, 0), 0);
  const pickedN = picked.reduce((n, x) => n + x.s.length, 0);
  const safeSize = items.filter((i) => i.confidence === 'high').reduce((n, i) => n + i.size, 0);
  const all = btn(`Remove all selected (${pickedN}, ${fmtSize(pickedSize)})…`, () => removePicked(picked.map((x) => x.r.path)), 'danger');
  all.disabled = !pickedN || state.readOnly;
  const selectSafe = () => { for (const r of c.repos.values()) preselect(r); renderClutterView(); };
  const selectNone = () => { state.picked.clear(); renderClutterView(); };
  const top = $('detail').scrollTop;
  const rescan = UI.ibtn('refresh', 'Rescan', (e) => { e.currentTarget.disabled = true; scanClutterNow(); });
  const biggest = Math.max(0, ...items.map((i) => i.size));
  const conf = { high: 0, medium: 0, low: 0 };
  for (const i of items) conf[i.confidence]++;
  put($('detail'), ...head,
    h('div', { class: 'qstats' }, stat('Found', fmtSize(total.size)), stat('Safe to remove', fmtSize(safeSize), safeSize ? 'ok' : ''), stat('Selected', fmtSize(pickedSize), pickedN ? 'warn' : ''), stat('Items', total.n.toLocaleString())),
    h('div', { class: 'toolbar' }, rescan, btn('Select every safe item', selectSafe), h('span', { class: 'muted' }, `${plural(total.n, 'item')}, ${fmtSize(total.size)} found across ${plural(c.repos.size, 'repo')}`)),
    items.length ? h('div', { class: 'listhead' }, UI.segmented([{ value: 'all', label: 'All', count: items.length }, ...['high', 'medium', 'low'].map((k) => ({ value: k, label: CONF_NAME[k], count: conf[k], dot: k === 'high' ? 'ok' : k === 'medium' ? 'warn' : 'info', title: CONF_TIP[k] }))], clView.conf, (v) => { clView.conf = v; renderClutterView(); }, 'Show items by confidence')) : null,
    pickedN ? h('div', { class: 'bulkbar' }, h('span', { class: 'bcount' }, h('b', {}, String(pickedN)), ` selected in ${plural(picked.length, 'repo')}`), h('div', { class: 'bacts' }, all), btn('Clear', selectNone, 'ghost')) : h('div', { class: 'toolbar' }, all),
    repos.length ? repos.map((r) => clutterRepoEl(r, biggest)) : UI.empty('check', 'No clutter found', 'Nothing to tidy in this workspace.', null, 'good'),
    c.workspace.length ? UI.fold('clutter|ws', [h('span', { class: 'ftitle' }, 'Workspace and this machine'), h('span', { class: 'cnt' }, String(c.workspace.length))], c.workspace.map((f) => adviceEl(null, f)), { open: true, cls: 'cat' }) : null);
  $('detail').scrollTop = top;
}

$('clutter').addEventListener('click', openClutter);
