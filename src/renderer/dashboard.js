// Dashboard view: one-screen overview of the whole workspace. Loaded after app.js; shares its
// globals ($, h, put, btn, state, select, renderOverview, ...). Numbers come from Metrics.compute().
// Charts are plain DOM/SVG built from CSS classes (the page's CSP forbids inline style attributes;
// widths and heights are set through the CSSOM instead).

const GRADE_COLOR = { A: 'ok', B: 'info', C: 'warn', D: 'err' };

function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k != null) el.append(k);
  return el;
}

// Short "up/down since the last scan" note. `better` says which direction is good.
function dlt(now, then, better = 'down') {
  const d = Metrics.delta(now, then, better);
  if (!d || !d.dir) return null;
  return { text: `${d.dir > 0 ? '▲' : '▼'} ${Math.abs(d.d)} since last scan`, cls: d.good ? 'good' : 'bad' };
}

// Make any element keyboard-operable like a button (Tab to focus, Enter or Space to activate).
function activate(el, fn) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('click', fn);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  return el;
}

function card(label, value, { cls = '', sub = '', go = null, delta = null } = {}) {
  const el = h('div', { class: 'kpi ' + cls + (go ? ' link' : '') }, h('b', {}, value), h('span', {}, label), sub ? h('i', {}, sub) : null, delta ? h('i', { class: 'd ' + delta.cls }, delta.text) : null);
  if (go) activate(el, go);
  return el;
}

const wide = (el) => { el.classList.add('wide'); return el; };

function panel(title, sub, ...kids) {
  return h('section', { class: 'panel' }, h('h3', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, ...kids);
}

// Ring chart of grades with the average score in the middle.
function donut(grades, avg) {
  const total = Object.values(grades).reduce((a, b) => a + b, 0);
  const C = 2 * Math.PI * 50;
  let offset = 0;
  const arcs = Object.entries(grades).filter(([, n]) => n).map(([g, n]) => {
    const len = (n / total) * C;
    const c = svgEl('circle', { cx: 70, cy: 70, r: 50, class: 'arc c-' + GRADE_COLOR[g], 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 70 70)' });
    offset += len;
    return c;
  });
  const t1 = svgEl('text', { x: 70, y: 70, class: 'big', 'text-anchor': 'middle' }); t1.textContent = avg == null ? '–' : String(avg);
  const t2 = svgEl('text', { x: 70, y: 90, class: 'small', 'text-anchor': 'middle' }); t2.textContent = 'avg health';
  const svg = svgEl('svg', { viewBox: '0 0 140 140', width: 150, height: 150, role: 'img', 'aria-label': 'Repositories by grade' }, svgEl('circle', { cx: 70, cy: 70, r: 50, class: 'track' }), ...arcs, t1, t2);
  const legend = h('div', { class: 'legend' }, Object.entries(grades).map(([g, n]) => h('div', {}, h('span', { class: 'dot d-' + GRADE_COLOR[g] }), `Grade ${g}: `, h('b', {}, n))));
  return h('div', { class: 'donut' }, svg, legend);
}

// Horizontal bars. rows: [{label, value, cls, title, go}]
function hbars(rows, { max = Math.max(1, ...rows.map((r) => r.value)), fmt = String } = {}) {
  return h('div', { class: 'hbars' }, rows.map((r) => {
    const fill = h('div', { class: 'fill ' + (r.cls || '') });
    fill.style.width = Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100) + '%';
    const row = h('div', { class: 'hb' + (r.go ? ' link' : ''), title: r.title || r.label }, h('span', { class: 'lbl' }, r.label), h('div', { class: 'track' }, fill), h('span', { class: 'val' }, fmt(r.value)));
    if (r.go) activate(row, r.go);
    return row;
  }));
}

function columns(rows, cls = 'info') {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return h('div', { class: 'cols' }, rows.map((r) => {
    const bar = h('div', { class: 'bar ' + cls });
    bar.style.height = (r.count ? Math.max(4, (r.count / max) * 100) : 0) + '%';
    return h('div', { class: 'col' }, h('span', { class: 'val' }, r.count), h('div', { class: 'barwrap' }, bar), h('span', { class: 'lbl' }, r.label));
  }));
}

function stacked(rows) {
  const max = Math.max(1, ...rows.map((r) => r.error + r.warn + r.info));
  return h('div', { class: 'hbars' }, rows.map((r) => {
    const track = h('div', { class: 'track stack' });
    for (const k of ['error', 'warn', 'info']) {
      if (!r[k]) continue;
      const seg = h('div', { class: 'fill s-' + k, title: `${r[k]} ${k}` });
      seg.style.width = (r[k] / max) * 100 + '%';
      track.append(seg);
    }
    return h('div', { class: 'hb' }, h('span', { class: 'lbl' }, r.cat), track, h('span', { class: 'val' }, r.error + r.warn + r.info));
  }));
}

// Line chart over snapshots. series: [{ key, cls, label }]; values read from each entry via get(entry, key).
function lineChart(entries, series, { fmt = String, get = (e, k) => e[k] } = {}) {
  const W = 300, H = 110, PX = 8, PT = 8, PB = 8;
  const pts = entries.slice(-30);
  const vals = pts.flatMap((e) => series.map((s) => get(e, s.key))).filter((v) => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => PX + (pts.length === 1 ? (W - 2 * PX) / 2 : (i / (pts.length - 1)) * (W - 2 * PX));
  const y = (v) => PT + (1 - (v - lo) / span) * (H - PT - PB);
  const layers = series.map((s) => {
    const xy = pts.map((e, i) => [x(i), get(e, s.key), e]).filter(([, v]) => v != null);
    const line = svgEl('polyline', { class: 'ln ' + s.cls, points: xy.map(([px, v]) => `${px.toFixed(1)},${y(v).toFixed(1)}`).join(' ') });
    const dots = xy.map(([px, v, e]) => { const c = svgEl('circle', { class: 'pt ' + s.cls, cx: px.toFixed(1), cy: y(v).toFixed(1), r: 3 }); const tt = svgEl('title'); tt.textContent = `${new Date(e.ts).toLocaleString()}: ${s.label} ${fmt(v)}`; c.append(tt); return c; });
    return [line, ...dots];
  });
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend', role: 'img', 'aria-label': series.map((s) => s.label).join(', ') + ' over time' },
    svgEl('line', { class: 'grid', x1: PX, x2: W - PX, y1: y(lo), y2: y(lo) }), svgEl('line', { class: 'grid', x1: PX, x2: W - PX, y1: y(hi), y2: y(hi) }), ...layers.flat());
  const last = pts[pts.length - 1], first = pts[0];
  return h('div', { class: 'tchart' }, svg,
    h('div', { class: 'taxis' }, h('span', {}, new Date(first.ts).toLocaleDateString()), h('span', {}, `range ${fmt(lo)} to ${fmt(hi)}`), h('span', {}, new Date(last.ts).toLocaleDateString())),
    series.length > 1 ? h('div', { class: 'legend row2' }, series.map((s) => h('span', {}, h('span', { class: 'dot d-' + s.cls }), s.label))) : null);
}

// Heatmap: one row per repo, one column per issue category.
function heatmapEl(hm, open) {
  const grid = h('div', { class: 'heat' });
  grid.style.gridTemplateColumns = `150px repeat(${hm.cols.length}, minmax(56px, 1fr))`;
  grid.append(h('div', { class: 'hh' }), ...hm.cols.map((c) => h('div', { class: 'hh', title: c }, c)));
  for (const r of hm.rows) {
    const name = h('div', { class: 'hn link', title: r.name }, r.name);
    activate(name, open(r.path));
    grid.append(name, ...r.cells.map((c, i) => {
      const n = c.error + c.warn + c.info;
      const cell = h('div', { class: 'hm' + (c.worst ? ` hm-${c.worst}-${c.level}` : ''), title: `${r.name} / ${hm.cols[i]}: ` + (n ? [c.error && `${c.error} error`, c.warn && `${c.warn} warning`, c.info && `${c.info} note`].filter(Boolean).join(', ') : 'clean') }, n || '');
      activate(cell, open(r.path));
      return cell;
    }));
  }
  return h('div', {}, h('div', { class: 'heatwrap' }, grid),
    h('div', { class: 'legend row2' }, h('span', {}, h('span', { class: 'dot hm-error-2' }), 'errors'), h('span', {}, h('span', { class: 'dot hm-warn-2' }), 'warnings'), h('span', {}, h('span', { class: 'dot hm-info-2' }), 'notes'), h('span', { class: 'muted' }, 'darker = more issues')));
}

async function loadTrend() {
  try { state.trend = await window.api.trend(); } catch { state.trend = []; }
  if (state.view === 'dashboard') renderDashboard();
}

function moversEl(mv, open) {
  if (!mv) return h('p', { class: 'muted' }, 'Nothing to compare yet.');
  const row = (m, good) => activate(h('div', { class: 'row link' },
    h('div', { class: 'grow' }, m.name), h('span', { class: 'muted' }, `${m.from} → ${m.to}`), h('span', { class: good ? 'b-ok' : 'b-err' }, `${m.delta > 0 ? '+' : ''}${m.delta}`)), open([...state.repos.values()].find((r) => r.name === m.name)?.path));
  const rows = [...mv.down.slice(0, 4).map((m) => row(m, false)), ...mv.up.slice(0, 4).map((m) => row(m, true))];
  const notes = [mv.added.length && `New: ${mv.added.join(', ')}`, mv.removed.length && `No longer scanned: ${mv.removed.join(', ')}`].filter(Boolean);
  return rows.length || notes.length ? h('div', { class: 'attn' }, rows, notes.map((n) => h('p', { class: 'muted' }, n))) : h('p', { class: 'ok-msg' }, 'No repo changed score.');
}

const chip = (n, label, cls) => (n ? h('span', { class: 'chip ' + cls }, `${n} ${label}`) : null);
const kind = (n, bad = 'warn') => (n > 0 ? bad : 'ok');

function renderDashboard() {
  state.view = 'dashboard'; state.selected = null;
  document.body.classList.add('dash');
  const d = $('detail');
  if (!state.repos.size) return put(d, h('h2', {}, 'Dashboard'), h('p', { class: 'empty' }, 'Choose a workspace folder and press Scan.'));
  const top = d.scrollTop;
  const m = Metrics.compute([...state.repos.values()], state.clutter ? state.clutter.repos : null);
  const t = m.totals;
  const hist = state.trend || [];
  // The newest snapshot is the scan on screen, so compare with the one before it (not while a scan is running).
  const prev = !state.scanning && hist.length >= 2 ? hist[hist.length - 2] : null;
  const mv = prev ? Metrics.movers(prev, hist[hist.length - 1]) : null;
  const open = (dir) => () => { if (dir) select(dir); };
  const toOverview = () => { renderOverview(); renderList(); };

  const copy = h('button', {}, 'Copy for LLM');
  copy.title = 'Copy a full report with an ordered fix plan, to paste into any LLM';
  copy.addEventListener('click', () => copyForLlm(copy, null, 'the whole workspace'));

  const cl = m.clutter;
  const clutterCard = cl
    ? card('Clutter found', fmtSize(cl.totalSize), { cls: kind(cl.items), sub: `${cl.items} items, ${fmtSize(cl.safeSize)} safe to remove`, go: () => openClutter() })
    : card('Clutter', 'Scan', { cls: '', sub: 'find stale env files, caches, copies', go: async () => { await scanClutterNow(); if (state.view === 'dashboard') renderDashboard(); } });

  const cards = [
    card('Repositories', t.repos, { sub: t.failedScans ? `${t.failedScans} failed to scan` : '', cls: t.failedScans ? 'warn' : '' }),
    card('Average health', m.avg == null ? '–' : m.avg, { cls: m.avg >= 75 ? 'ok' : m.avg >= 55 ? 'warn' : 'err', delta: prev && dlt(m.avg, prev.avg, 'up') }),
    card('Errors', t.errors, { cls: kind(t.errors, 'err'), go: toOverview, delta: prev && dlt(t.errors, prev.errors) }),
    card('Warnings', t.warns, { cls: kind(t.warns), go: toOverview, delta: prev && dlt(t.warns, prev.warns) }),
    card('Open PRs', t.prs, { sub: [t.readyPRs && `${t.readyPRs} ready`, t.conflictPRs && `${t.conflictPRs} conflicts`].filter(Boolean).join(' · ') }),
    card('Failing CI', t.failingCI, { cls: kind(t.failingCI, 'err'), delta: prev && dlt(t.failingCI, prev.failingCI) }),
    card('Uncommitted work', t.dirty, { sub: 'repos with changes', cls: kind(t.dirty) }),
    card('Unpushed commits', t.ahead, { sub: t.behind ? `${t.behind} behind upstream` : '', cls: kind(t.ahead), delta: prev && dlt(t.ahead, prev.ahead) }),
    card('High/critical alerts', t.alertsHigh, { sub: `${t.alertsTotal} open in total`, cls: kind(t.alertsHigh, 'err') }),
    card('Merged branches', t.mergedBranches, { sub: 'safe to delete', cls: kind(t.mergedBranches, 'info') }),
    card('Stale branches', t.staleBranches, { sub: '60+ days, unmerged' }),
    card('Local-only repos', t.localOnly, { sub: 'no GitHub backup', cls: kind(t.localOnly) }),
    card('No LICENSE', t.noLicense, { sub: t.noReadme ? `${t.noReadme} also lack a README` : '', cls: kind(t.noLicense, 'err') }),
    clutterCard,
  ];

  const attention = m.attention.length
    ? h('div', { class: 'attn' }, m.attention.map((a) => activate(h('div', { class: 'row link' },
      h('div', { class: 'grade g' + a.grade }, a.grade),
      h('div', { class: 'grow' }, h('b', {}, a.name), h('div', { class: 'muted' }, a.top ? a.top.title : ''), ),
      h('span', { class: 'muted' }, [a.errors && `${a.errors} err`, a.warns && `${a.warns} warn`].filter(Boolean).join(' · '))), open(a.path))))
    : h('p', { class: 'ok-msg' }, 'Nothing needs attention.');

  const hm = Metrics.heatmap([...state.repos.values()]);
  const prTotal = m.prAges.reduce((n, x) => n + x.count, 0);

  const clutterHist = hist.filter((e) => e.clutter != null);
  const trendPanels = hist.length >= 2
    ? [
      panel('Health over time', `${hist.length} scans since ${new Date(hist[0].ts).toLocaleDateString()}`, lineChart(hist, [{ key: 'avg', cls: 'ok', label: 'Average health' }])),
      panel('Errors and warnings over time', 'Fewer is better', lineChart(hist, [{ key: 'errors', cls: 'err', label: 'Errors' }, { key: 'warns', cls: 'warn', label: 'Warnings' }])),
      clutterHist.length >= 2 ? panel('Clutter over time', 'Total size found by clutter scans', lineChart(clutterHist, [{ key: 'clutter', cls: 'warn', label: 'Clutter' }], { fmt: fmtSize })) : null,
      panel('Changes since last scan', prev ? `Compared with ${new Date(prev.ts).toLocaleString()}` : '', moversEl(mv, open)),
    ]
    : [panel('Trends', 'Not enough history yet', h('p', { class: 'muted' }, 'Health, error and clutter trends appear after your second scan. GutCheck keeps a small local history (scores and totals only, no paths) in its app data folder.'))];

  put(d,
    h('div', { class: 'dhead' }, h('h2', {}, 'Dashboard'), h('span', { class: 'pill' }, `${t.repos} repos`)),
    h('div', { class: 'toolbar' }, copy, btn('Workspace overview', toOverview)),
    h('div', { class: 'kpis' }, cards),
    h('div', { class: 'panels' },
      panel('Health grades', 'Repositories by grade', donut(m.grades, m.avg)),
      panel('Needs attention', 'Lowest-scoring repos and their worst issue', attention),
      panel('Issues by category', 'Errors, warnings and notes', m.categories.length ? stacked(m.categories) : h('p', { class: 'ok-msg' }, 'No issues.')),
      panel('Top recommendations', 'Same problem across the most repos (click for fixes)', m.recommendations.length
        ? h('div', { class: 'attn' }, m.recommendations.map((g) => activate(h('div', { class: 'row link' },
          h('span', { class: 'n b-' + (g.sev === 'error' ? 'err' : g.sev === 'warn' ? 'warn' : '') }, g.repos.length),
          h('div', { class: 'grow' }, g.title, h('span', { class: 'pill' }, g.cat)), ), toOverview)))
        : h('p', { class: 'ok-msg' }, 'Nothing to recommend.')),
      panel('Repo activity', 'Time since the last push', columns(m.activity, 'info')),
      panel('Open PRs by age', prTotal ? 'Since last update' : 'No open pull requests', prTotal ? columns(m.prAges, 'warn') : null,
        h('div', { class: 'chips' }, chip(t.failingPRs, 'failing checks', 'err'), chip(t.conflictPRs, 'conflicts', 'err'), chip(t.readyPRs, 'ready to merge', 'ok'), chip(t.draftPRs, 'drafts', ''))),
      ...trendPanels,
      wide(panel('Issue heatmap', 'Where the problems are: repos down, categories across. Click a row to open it.', hm.cols.length ? heatmapEl(hm, open) : h('p', { class: 'ok-msg' }, 'No issues anywhere.'))),
      panel('Health by repo', 'Click a bar to open the repo', hbars(m.perRepo.map((p) => ({ label: p.name, value: p.score, cls: 'c-' + GRADE_COLOR[p.grade], title: `${p.name}: ${p.score}/100`, go: open(p.path) })), { max: 100 })),
      panel('Clutter by repo', cl ? `${fmtSize(cl.totalSize)} across ${cl.items} items` : 'Not scanned yet',
        cl ? (cl.byRepo.length ? hbars(cl.byRepo.slice(0, 10).map((r) => ({ label: r.name, value: r.size, cls: 'c-warn', title: `${r.count} items`, go: () => openClutter() })), { fmt: fmtSize }) : h('p', { class: 'ok-msg' }, 'No clutter. Tidy.'))
          : btn('Scan for clutter', async () => { await scanClutterNow(); if (state.view === 'dashboard') renderDashboard(); }))));
  d.scrollTop = top;
}

$('dashboard').addEventListener('click', () => { renderDashboard(); renderList(); });
