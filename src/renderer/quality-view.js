// Code quality view: file length (LOC), magic numbers and constants, secrets, markers, with
// user-defined limits. Loaded after app.js; shares its globals ($, h, put, btn, state, toast,
// renderList, fmtSize, hbars from dashboard.js).

async function scanQualityNow(dirs) {
  const out = await window.api.qualityScan(dirs);
  if (!out.ok) return toast(out.error, 'bad');
  if (!state.quality) state.quality = { repos: new Map(), settings: out.settings };
  if (!dirs) state.quality.repos.clear();
  for (const r of out.repos) state.quality.repos.set(r.path, r);
  state.quality.settings = out.settings;
}

async function openQuality() {
  state.view = 'quality'; state.selected = null;
  renderList(); renderQualityView();
  if (!state.quality && state.repos.size) {
    put($('detail'), h('h2', {}, 'Code quality'), h('p', { class: 'sub' }, 'Scanning code…'));
    await scanQualityNow();
    if (state.view === 'quality') renderQualityView();
  }
}

// Limits form: validated again in the main process, so the UI only needs to be convenient.
function qualityForm(cfg) {
  const max = h('input', { type: 'text', value: String(cfg.maxLines), size: 6, spellcheck: 'false' });
  const mode = h('select', {}, h('option', { value: 'total' }, 'all lines'), h('option', { value: 'code' }, 'code lines (no blanks or comments)'));
  mode.value = cfg.locMode;
  const ignore = h('input', { type: 'text', value: cfg.ignore.join(', '), placeholder: 'legacy/, *.generated.ts, vendor-code', spellcheck: 'false' });
  const save = btn('Save & rescan', async (e) => {
    const n = Number(max.value);
    if (!Number.isInteger(n) || n < 20 || n > 20000) { max.focus(); return toast('Max lines must be a whole number from 20 to 20000.', 'bad'); }
    e.target.disabled = true;
    await window.api.setQualitySettings({ maxLines: n, locMode: mode.value, ignore: ignore.value.split(',').map((s) => s.trim()).filter(Boolean) });
    state.quality = null;
    await scanQualityNow();
    renderQualityView();
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
    hbars(q.loc.over.slice(0, 15).map((f) => ({ label: f.path, value: f.measured, cls: f.measured > q.loc.max * 2 ? 'c-err' : 'c-warn', title: `${f.path}: ${f.measured} ${f.lang}${f.test ? ' (test)' : ''}` })), { max: q.loc.over[0].measured })));
  if (q.magic.files.length) details.push(h('details', {}, h('summary', {}, `Magic numbers (${q.magic.total}) in the worst files`),
    miniList(q.magic.files.slice(0, 10).map((f) => [h('b', {}, `${f.path} `), h('span', { class: 'pill' }, f.count), f.examples[0] ? h('code', {}, ` line ${f.examples[0].line}: ${f.examples[0].text}`) : null]))));
  if (q.magic.reuse.length) details.push(h('details', {}, h('summary', {}, `Numbers that may repeat an existing constant (${q.magic.reuse.length})`),
    miniList(q.magic.reuse.map((r) => [h('b', {}, `${r.value} `), `is `, h('code', {}, r.constant), ` (${r.definedIn}); raw at ${r.uses.slice(0, 3).map(where).join(', ')}`]))));
  if (q.magic.repeated.length) details.push(h('details', {}, h('summary', {}, `Repeated numbers without a name (${q.magic.repeated.length})`),
    miniList(q.magic.repeated.map((r) => [h('b', {}, `${r.value} `), `x${r.count} in ${r.files} file${r.files === 1 ? '' : 's'}: ${r.uses.slice(0, 3).map(where).join(', ')}`]))));
  if (q.secrets.length) details.push(h('details', { open: 'open' }, h('summary', {}, `Possible secrets (${q.secretCount}), locations only`), miniList(q.secrets.map((s) => [h('code', {}, where(s)), ` ${s.kind}`]))));
  if (q.markers.items.length) details.push(h('details', {}, h('summary', {}, `TODO / FIXME markers (${q.markers.total})`), miniList(q.markers.items.slice(0, 20).map((m) => [h('code', {}, where(m)), h('span', { class: 'badge' }, m.kind), ` ${m.text}`]))));
  if (q.languages.length) details.push(h('details', {}, h('summary', {}, 'Lines by language'),
    hbars(q.languages.slice(0, 8).map((l) => ({ label: l.lang, value: l.lines, cls: 'c-info', title: `${l.files} files` })), { fmt: (n) => n.toLocaleString() })));
  return h('div', { class: 'cblock' },
    h('h3', {}, q.name, h('span', { class: 'pill' }, `${q.files} files · ${q.lines.toLocaleString()} lines`)),
    q.advice.length ? q.advice.map((f) => adviceEl(null, f)) : h('p', { class: 'ok-msg' }, 'Nothing to flag.'),
    ...details);
}

function renderQualityView() {
  if (state.view !== 'quality') return;
  const c = state.quality;
  const head = [h('h2', {}, 'Code quality'),
    h('p', { class: 'sub' }, 'File length against your limit, magic numbers and constants reuse, hardcoded secrets (locations only, values are never shown), debug leftovers and TODO markers. Read-only: it respects .gitignore and skips tests for the magic-number check.')];
  if (!c) return put($('detail'), ...head, h('p', { class: 'empty' }, state.repos.size ? 'Scanning…' : 'Choose a workspace folder and press Scan first.'));
  const all = [...c.repos.values()];
  const t = Metrics.qualityTotals(all);
  const stat = (label, val, cls = '') => h('div', { class: 'stat ' + cls }, h('b', {}, val), h('span', {}, label));
  const top = $('detail').scrollTop;
  put($('detail'), ...head, qualityForm(c.settings),
    h('div', { class: 'toolbar' }, btn('Rescan', async (e) => { e.target.disabled = true; await scanQualityNow(); renderQualityView(); })),
    h('div', { class: 'qstats' }, stat('Files', t.files.toLocaleString()), stat('Lines', t.lines.toLocaleString()), stat(`Over ${t.max} lines`, t.over, t.over ? 'warn' : 'ok'),
      stat('Magic numbers', t.magic.toLocaleString(), t.magic ? 'warn' : 'ok'), stat('Possible secrets', t.secrets, t.secrets ? 'err' : 'ok'), stat('TODO markers', t.todos)),
    t.largest.length ? [h('h3', {}, 'Largest files across the workspace'), hbars(t.largest.map((f) => ({ label: `${f.repo}/${f.path}`, value: f.measured, cls: f.measured > t.max ? 'c-warn' : 'c-info', title: `${f.repo}/${f.path}` })), { max: t.largest[0].measured })] : null,
    all.sort((a, b) => b.advice.length - a.advice.length).map(qualityRepoEl));
  $('detail').scrollTop = top;
}

$('quality').addEventListener('click', openQuality);
