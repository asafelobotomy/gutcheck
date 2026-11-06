// Code quality view: file length (LOC), magic numbers and constants, secrets, markers, with
// user-defined limits. Loaded after app.js; shares its globals ($, h, put, btn, stat, plural, state,
// toast, onDemand, adviceEl from clutter-view.js, hbars from dashboard.js).

function scanQualityNow(dirs) {
  return onDemand('quality', () => window.api.qualityScan(dirs), (out) => {
    if (!state.quality) state.quality = { repos: new Map() };
    if (!dirs) state.quality.repos.clear();
    for (const r of out.repos) state.quality.repos.set(r.path, r);
    state.quality.settings = out.settings;
    state.quality.limits = out.limits;
  });
}

function openQuality() {
  state.view = 'quality'; state.selected = null;
  renderList(); renderQualityView();
  if (!state.quality && state.repos.size) scanQualityNow();
}

// Limits form: validated again in the main process, so the UI only needs to be convenient.
function qualityForm(cfg, lim = { min: 20, max: 20000 }) {
  const max = h('input', { type: 'text', value: String(cfg.maxLines), size: 6, spellcheck: 'false' });
  const mode = h('select', {}, h('option', { value: 'total' }, 'all lines'), h('option', { value: 'code' }, 'code lines (no blanks or comments)'));
  mode.value = cfg.locMode;
  const ignore = h('input', { type: 'text', value: cfg.ignore.join(', '), placeholder: 'legacy/, *.generated.ts, vendor-code', spellcheck: 'false' });
  const save = btn('Save & rescan', async (e) => {
    const n = Number(max.value);
    if (!Number.isInteger(n) || n < lim.min || n > lim.max) { max.focus(); return toast(`Max lines must be a whole number from ${lim.min} to ${lim.max}.`, 'bad'); }
    e.target.disabled = true;
    await window.api.setQualitySettings({ maxLines: n, locMode: mode.value, ignore: ignore.value.split(',').map((s) => s.trim()).filter(Boolean) });
    if (inflight.quality) await inflight.quality; // that scan started with the old limits
    await scanQualityNow(); // keeps the old results on screen until the new ones arrive
  });
  return h('div', { class: 'qform' },
    h('label', {}, h('span', {}, 'Max lines per file'), max), h('label', {}, h('span', {}, 'Count'), mode),
    h('label', { class: 'wide' }, h('span', {}, 'Ignore (comma separated: folder/, *.ext or part of a path)'), ignore), save);
}

const where = (x) => `${x.path}:${x.line}`;
const miniList = (rows) => h('div', { class: 'mini' }, rows.map((r) => h('div', {}, ...r)));

function qualityRepoEl(res) {
  if (res.error) return h('div', { class: 'cblock' }, h('h3', {}, res.name), h('p', { class: 'b-err' }, res.error));
  const q = res;
  const details = [];
  if (q.loc.over.length) details.push(h('details', {}, h('summary', {}, `Files over the limit (${q.loc.overCount})`),
    hbars(q.loc.over.slice(0, 15).map((f) => ({ label: f.path, value: f.measured, cls: f.measured > q.loc.max * 2 ? 'c-err' : 'c-warn', title: `${f.path}: ${f.measured} ${f.lang}${f.test ? ' (test)' : ''}` })), { max: Math.max(1, q.loc.over[0].measured) })));
  if (q.magic.files.length) details.push(h('details', {}, h('summary', {}, `Magic numbers (${q.magic.total}) in the worst files`),
    miniList(q.magic.files.slice(0, 10).map((f) => [h('b', {}, `${f.path} `), h('span', { class: 'pill' }, f.count), f.examples[0] ? h('code', {}, ` line ${f.examples[0].line}: ${f.examples[0].text}`) : null]))));
  if (q.magic.reuse.length) details.push(h('details', {}, h('summary', {}, `Numbers that may repeat an existing constant (${q.magic.reuse.length})`),
    miniList(q.magic.reuse.map((r) => [h('b', {}, `${r.value} `), `is `, h('code', {}, r.constant), ` (${r.definedIn}); raw at ${r.uses.slice(0, 3).map(where).join(', ')}`]))));
  if (q.magic.repeated.length) details.push(h('details', {}, h('summary', {}, `Repeated numbers without a name (${q.magic.repeated.length})`),
    miniList(q.magic.repeated.map((r) => [h('b', {}, `${r.value} `), `x${r.count} in ${plural(r.files, 'file')}: ${r.uses.slice(0, 3).map(where).join(', ')}`]))));
  if (q.secrets.length) details.push(h('details', { open: 'open' }, h('summary', {}, `Possible secrets (${q.secretCount}), locations only`), miniList(q.secrets.map((s) => [h('code', {}, where(s)), ` ${s.kind}`]))));
  if (q.markers.items.length) details.push(h('details', {}, h('summary', {}, `TODO / FIXME markers (${q.markers.total})`), miniList(q.markers.items.slice(0, 20).map((m) => [h('code', {}, where(m)), h('span', { class: 'badge' }, m.kind), ` ${m.text}`]))));
  if (q.languages.length) details.push(h('details', {}, h('summary', {}, 'Lines by language'),
    langBars(q.languages)));
  return h('div', { class: 'cblock' },
    h('h3', {}, q.name, h('span', { class: 'pill' }, `${plural(q.files, 'file')} · ${plural(q.lines, 'line')}`)),
    q.advice.length ? q.advice.map((f) => adviceEl(null, f)) : h('p', { class: 'ok-msg' }, 'Nothing to flag.'),
    ...details);
}

function renderQualityView() {
  if (state.view !== 'quality') return;
  const c = state.quality;
  const head = [h('h2', {}, 'Code quality'),
    h('p', { class: 'sub' }, 'File length against your limit, magic numbers and constants reuse, hardcoded secrets (locations only, values are never shown), debug leftovers and TODO markers. Read-only: it respects .gitignore and skips tests for the magic-number check.')];
  if (!c) {
    const err = state.scanError.quality;
    const msg = !state.repos.size ? 'Choose a workspace folder and press Scan first.' : err ? `Code-quality scan failed: ${err}` : 'Scanning…';
    return put($('detail'), ...head, h('p', { class: err ? 'b-err' : 'empty' }, msg), err ? btn('Try again', () => scanQualityNow()) : null);
  }
  const all = [...c.repos.values()];
  const t = Metrics.qualityTotals(all, c.settings.maxLines);
  const n = (x) => x.toLocaleString();
  const top = $('detail').scrollTop;
  put($('detail'), ...head, qualityForm(c.settings, c.limits),
    h('div', { class: 'toolbar' }, btn('Rescan', (e) => { e.target.disabled = true; scanQualityNow(); })),
    h('div', { class: 'qstats' }, stat('Files', n(t.files)), stat('Lines', n(t.lines)), stat(`Over ${t.max} lines`, n(t.over), t.over ? 'warn' : 'ok'),
      stat('Magic numbers', n(t.magic), t.magic ? 'warn' : 'ok'), stat('Possible secrets', n(t.secrets), t.secrets ? 'err' : 'ok'), stat('TODO markers', n(t.todos))),
    t.largest.length ? [h('h3', {}, 'Largest files across the workspace'), hbars(t.largest.map((f) => ({ label: `${f.repo}/${f.path}`, value: f.measured, cls: f.measured > t.max ? 'c-warn' : 'c-info', title: `${f.repo}/${f.path}` })), { max: Math.max(1, t.largest[0].measured) })] : null,
    all.sort((a, b) => b.advice.length - a.advice.length).map(qualityRepoEl));
  $('detail').scrollTop = top;
}

$('quality').addEventListener('click', openQuality);
