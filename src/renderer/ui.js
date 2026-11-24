// Shared building blocks for every view: icons, filters, folding sections, selection with a bulk
// action bar, the severity strip, the score gauge and "show more" lists. Loaded right after app.js;
// uses its globals (h, btn, plural). Everything is built from DOM nodes and CSS classes: the page's
// CSP forbids inline style attributes, so sizes go through the CSSOM.

const UI = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  // 16x16 line icons (stroke = currentColor). One path string per icon; "M…" segments only.
  const ICONS = {
    dashboard: 'M2 9a6 6 0 0 1 12 0M8 9l3-3M2 13h12',
    overview: 'M2 4h12M2 8h12M2 12h7',
    baseline: 'M3 2v12M3 3h9l-2 3 2 3H3',
    quality: 'M5 4 1 8l4 4M11 4l4 4-4 4M9 2 7 14',
    tests: 'M6 1h4M7 1v5L3 13a1 1 0 0 0 1 2h8a1 1 0 0 0 1-2L9 6V1M5 10h6',
    secrets: 'M10 2a4 4 0 1 1-3 6.7L2 14H1v-2l1-1h1v-1h1l1.3-1.3A4 4 0 0 1 10 2zM11 5h0',
    clutter: 'M2 5h12M5 5V3h6v2M4 5l1 9h6l1-9M7 8v4M9 8v4',
    history: 'M8 4v4l3 2M2 8a6 6 0 1 0 2-4.5M2 2v3h3',
    folder: 'M1 4v9h14V5H7L5 3H1z',
    scan: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM11 11l4 4',
    gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5 13 13M3 13l1.5-1.5M11.5 4.5 13 3',
    lock: 'M4 7V5a4 4 0 0 1 8 0v2M3 7h10v8H3zM8 10v2',
    unlock: 'M4 7V5a4 4 0 0 1 7.5-2M3 7h10v8H3zM8 10v2',
    check: 'M3 8.5 6.5 12 13 4',
    x: 'M4 4l8 8M12 4l-8 8',
    alert: 'M8 2 1 14h14L8 2zM8 6v4M8 12h0',
    branch: 'M5 2v8M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 6c0 3-6 2-6 4',
    pr: 'M4 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4 6v8M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 10V5H8M10 3 8 5l2 2',
    shield: 'M8 1 2 3v5c0 4 3 6 6 7 3-1 6-3 6-7V3L8 1z',
    file: 'M3 1h7l3 3v11H3zM10 1v3h3',
    wrench: 'M10 1a4 4 0 0 0-3.8 5.2L1 11.5V15h3.5l5.3-5.2A4 4 0 0 0 15 6l-2.5 2.5L10 8 9.5 5.5 12 3a4 4 0 0 0-2-2z',
    eyeoff: 'M2 2l12 12M6.5 4.2A7 7 0 0 1 15 8a8 8 0 0 1-2 2.6M4 5.5A8 8 0 0 0 1 8a7 7 0 0 0 9 3.6',
    external: 'M9 2h5v5M14 2 7 9M12 10v4H2V4h4',
    copy: 'M5 5h9v9H5zM2 11V2h9',
    refresh: 'M13 3v4H9M3 13V9h4M3.5 6A5 5 0 0 1 13 7M12.5 10A5 5 0 0 1 3 9',
    chevron: 'M6 4l4 4-4 4',
    arrowup: 'M8 13V3M4 7l4-4 4 4',
    arrowdown: 'M8 3v10M4 9l4 4 4-4',
    dot: 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    trash: 'M2 4h12M6 4V2h4v2M3.5 4l1 10h7l1-10',
    plus: 'M8 3v10M3 8h10',
    play: 'M4 2v12l10-6z',
    download: 'M8 2v8M4.5 6.5 8 10l3.5-3.5M2 13h12',
  };
  function icon(name, cls = '') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'ic ' + cls);
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.dot);
    svg.append(p);
    return svg;
  }

  // A button with an icon. The label stays the button's whole textContent (tests and screen readers).
  function ibtn(name, label, onclick, cls = '') {
    const b = btn(label, onclick, cls);
    b.prepend(icon(name));
    return b;
  }

  // One-of-many filter. options: [{ value, label, count?, cls? }]. Options with count 0 are dimmed.
  function segmented(options, value, onChange, label) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map((o) => {
      const b = h('button', { class: 'segb' + (o.value === value ? ' on' : '') + (o.count === 0 ? ' zero' : ''), 'aria-pressed': o.value === value ? 'true' : 'false', title: o.title || null },
        o.dot ? h('span', { class: 'dot d-' + o.dot }) : null, o.label, o.count != null ? h('span', { class: 'cnt' }, String(o.count)) : null);
      b.addEventListener('click', () => onChange(o.value));
      return b;
    }));
  }

  // A section that folds. Its open state is remembered per key for the session, so redraws keep it.
  const folds = new Map();
  function fold(key, head, body, { open = false, cls = '' } = {}) {
    const d = h('details', { class: 'fold ' + cls });
    d.open = folds.has(key) ? folds.get(key) : open;
    d.addEventListener('toggle', () => folds.set(key, d.open));
    d.append(h('summary', {}, icon('chevron', 'chev'), ...[head].flat(Infinity).filter((k) => k != null)), ...[body].flat(Infinity).filter((k) => k != null));
    return d;
  }

  // A tick box bound to a Set of keys. onChange runs after every change (redraw there).
  function tick(set, key, onChange, label) {
    const c = h('input', { type: 'checkbox', class: 'pick', 'aria-label': label });
    c.checked = set.has(key);
    c.addEventListener('click', (e) => e.stopPropagation());
    c.addEventListener('change', () => { if (c.checked) set.add(key); else set.delete(key); onChange(); });
    return c;
  }

  // "Select all" for a group: ticked when all are, mixed when some are.
  function tickAll(set, keys, onChange, label = 'Select all') {
    const c = h('input', { type: 'checkbox', class: 'pick', 'aria-label': label });
    const n = keys.filter((k) => set.has(k)).length;
    c.checked = !!keys.length && n === keys.length;
    c.indeterminate = n > 0 && n < keys.length;
    c.disabled = !keys.length;
    c.addEventListener('click', (e) => e.stopPropagation());
    c.addEventListener('change', () => { for (const k of keys) if (c.checked) set.add(k); else set.delete(k); onChange(); });
    return c;
  }

  // The bar that appears when something is ticked: how many, what can be done to them, and Clear.
  function bulkBar(count, noun, actions, onClear) {
    if (!count) return null;
    return h('div', { class: 'bulkbar', role: 'region', 'aria-label': 'Bulk actions' },
      h('span', { class: 'bcount' }, h('b', {}, String(count)), ` ${count === 1 ? noun : noun + 's'} selected`),
      h('div', { class: 'bacts' }, actions.filter(Boolean)), btn('Clear', onClear, 'ghost'));
  }

  // The severity strip: errors, warnings and notes as one stacked bar (the app's "vital sign").
  function vitals(c, max) {
    const total = (c.error || 0) + (c.warn || 0) + (c.info || 0);
    const strip = h('div', { class: 'vitals', role: 'img', 'aria-label': total ? [c.error && `${c.error} errors`, c.warn && `${c.warn} warnings`, c.info && `${c.info} notes`].filter(Boolean).join(', ') : 'no issues' });
    if (!total) { strip.classList.add('clean'); return strip; }
    for (const k of ['error', 'warn', 'info']) {
      if (!c[k]) continue;
      const seg = h('span', { class: 'vs s-' + k });
      seg.style.width = (c[k] / Math.max(total, max || total)) * 100 + '%';
      strip.append(seg);
    }
    return strip;
  }
  const sevCounts = (findings) => {
    const c = { error: 0, warn: 0, info: 0 };
    for (const f of findings || []) c[f.severity] = (c[f.severity] || 0) + 1;
    return c;
  };

  // Ring gauge of a 0–100 score, coloured by grade, the grade letter inside.
  const GRADE_TONE = { A: 'ok', B: 'info', C: 'warn', D: 'err' };
  function gauge(score, grade, size = 64) {
    const R = 26, C = 2 * Math.PI * R, v = Math.max(0, Math.min(100, score || 0));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('class', 'gauge t-' + (GRADE_TONE[grade] || 'err'));
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Grade ${grade}, ${v} out of 100`);
    const ring = (cls, dash) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', 32); c.setAttribute('cy', 32); c.setAttribute('r', R); c.setAttribute('class', cls); if (dash) { c.setAttribute('stroke-dasharray', `${dash} ${C}`); c.setAttribute('transform', 'rotate(-90 32 32)'); } return c; };
    const t = document.createElementNS(NS, 'text'); t.setAttribute('x', 32); t.setAttribute('y', 38); t.setAttribute('text-anchor', 'middle'); t.textContent = grade || '?';
    svg.append(ring('gtrack'), ring('garc', (v / 100) * C), t);
    return svg;
  }

  // A thin percentage bar with its value.
  function meter(pct, cls = 'info', label = null) {
    const fill = h('span', { class: 'mfill c-' + cls });
    fill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
    return h('span', { class: 'meter', title: label || `${pct}%` }, h('span', { class: 'mtrack' }, fill), label != null ? h('span', { class: 'mval' }, label) : null);
  }

  // The first n rows, then "Show N more" (remembered per key).
  const shown = new Map();
  function more(key, rows, n = 8, noun = 'more') {
    if (rows.length <= n) return rows;
    const all = shown.get(key);
    const wrap = h('div', { class: 'more' });
    const draw = (open) => {
      wrap.replaceChildren(...(open ? rows : rows.slice(0, n)),
        btn(open ? 'Show fewer' : `Show ${rows.length - n} ${noun}`, () => { shown.set(key, !open); draw(!open); }, 'ghost moreb'));
    };
    draw(!!all);
    return wrap;
  }

  // An empty or waiting state: a picture of the state, one line, and the next step.
  function empty(iconName, title, sub = '', action = null, cls = '') {
    return h('div', { class: 'emptybox ' + cls }, icon(iconName, 'big'), h('b', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, action);
  }

  // Tabs over panels that all stay in the page (hidden when not current), so search and tests find them.
  function tabs(defs, current, onChange) {
    const cur = defs.some((d) => d.id === current) ? current : defs[0].id;
    const bar = h('div', { class: 'tabs', role: 'tablist' }, defs.map((d) => {
      const t = h('button', { class: 'tab' + (d.id === cur ? ' on' : ''), role: 'tab', 'aria-selected': d.id === cur ? 'true' : 'false', id: 'tab-' + d.id },
        d.icon ? icon(d.icon) : null, d.label, d.count != null ? h('span', { class: 'cnt' + (d.tone ? ' ' + d.tone : '') }, String(d.count)) : null);
      t.addEventListener('click', () => onChange(d.id));
      return t;
    }));
    const panels = defs.map((d) => { const p = h('div', { class: 'tabpanel', role: 'tabpanel', 'aria-labelledby': 'tab-' + d.id }, d.body); p.hidden = d.id !== cur; return p; });
    return [bar, ...panels];
  }

  // A small status chip: a coloured dot and a word, so state reads before the text does.
  const status = (tone, text, title) => h('span', { class: 'status s-' + tone, title: title || null }, h('span', { class: 'sdot' }), text);

  return { icon, ibtn, segmented, fold, tick, tickAll, bulkBar, vitals, sevCounts, gauge, meter, more, empty, tabs, status, GRADE_TONE };
})();

// Icons on the page's fixed controls (index.html). Labels stay as they are.
for (const [id, name] of [['dashboard', 'dashboard'], ['overview', 'overview'], ['baseline', 'baseline'], ['quality', 'quality'], ['tests', 'tests'], ['secrets', 'secrets'], ['clutter', 'clutter'], ['history', 'history'], ['github', 'download'], ['browse', 'folder'], ['scan', 'scan'], ['background', 'gear']]) {
  const el = document.getElementById(id);
  if (el) el.prepend(UI.icon(name));
}
