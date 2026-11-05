const $ = (id) => document.getElementById(id);
const state = { repos: new Map(), selected: null, scanning: false };

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

let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

const counts = (r) => ({
  err: r.findings.filter((f) => f.severity === 'error').length,
  warn: r.findings.filter((f) => f.severity === 'warn').length,
});

function renderStats() {
  const rs = [...state.repos.values()];
  const tot = rs.reduce((a, r) => {
    const c = counts(r);
    a.err += c.err; a.warn += c.warn; a.prs += (r.prs || []).length; a.ci += (r.ci?.failed || []).length;
    return a;
  }, { err: 0, warn: 0, prs: 0, ci: 0 });
  const avg = rs.length ? Math.round(rs.reduce((n, r) => n + (r.score || 0), 0) / rs.length) : 0;
  const stat = (label, val, cls = '') => h('div', { class: 'stat ' + cls }, h('b', {}, val), h('span', {}, label));
  $('stats').replaceChildren(
    stat('Repositories', rs.length),
    stat('Avg health', rs.length ? avg : '–', avg >= 75 ? 'ok' : 'warn'),
    stat('Errors', tot.err, tot.err ? 'err' : 'ok'),
    stat('Warnings', tot.warn, tot.warn ? 'warn' : 'ok'),
    stat('Open PRs', tot.prs),
    stat('Failing CI', tot.ci, tot.ci ? 'err' : 'ok')
  );
}

function renderList() {
  const q = $('q').value.toLowerCase();
  const sort = $('sort').value;
  let rs = [...state.repos.values()].filter((r) => r.name.toLowerCase().includes(q));
  rs.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'prs' ? (b.prs?.length || 0) - (a.prs?.length || 0) : (a.score ?? 0) - (b.score ?? 0));
  $('repos').replaceChildren(...rs.map((r) => {
    const c = counts(r);
    return h('li', { class: r.path === state.selected ? 'sel' : '', onclick: () => select(r.path) },
      h('div', { class: 'grade g' + r.grade }, r.grade),
      h('div', { class: 'rinfo' },
        h('div', { class: 'rname' }, r.name),
        h('div', { class: 'rmeta' },
          c.err ? h('span', { class: 'b-err' }, `${c.err} err`) : null,
          c.warn ? h('span', { class: 'b-warn' }, `${c.warn} warn`) : null,
          r.prs?.length ? h('span', {}, `${r.prs.length} PR`) : null,
          !r.remote && !r.error ? h('span', {}, 'local only') : null)));
  }));
}

async function doAction(r, fix, btn) {
  btn.disabled = true;
  const res = await window.api.action(r.path, fix);
  if (res.cancelled) { btn.disabled = false; return; }
  toast(res.ok ? (res.stdout.trim() || 'Done') : 'Failed: ' + (res.stderr.trim() || 'unknown error'), res.ok ? 'good' : 'bad');
  await refreshOne(r.path);
}

async function refreshOne(dir) {
  const out = await window.api.rescan(dir, $('deep').checked);
  if (out.ok) state.repos.set(dir, out.res);
  renderStats(); renderList(); renderDetail();
}

function findingEl(r, f) {
  return h('div', { class: 'finding ' + f.severity },
    h('div', { class: 't' }, h('b', {}, f.title), h('span', {}, f.detail || '')),
    f.url ? h('a', { onclick: () => window.api.openUrl(f.url) }, 'Open ↗') : null,
    f.fix ? (() => { const b = h('button', {}, f.fix.label); b.addEventListener('click', () => doAction(r, f.fix, b)); return b; })() : null);
}

function renderDetail() {
  const d = $('detail');
  const r = state.repos.get(state.selected);
  if (!r) return renderOverview();
  if (r.error) return d.replaceChildren(h('h2', {}, r.name), h('p', { class: 'b-err' }, r.error));
  const toolbar = h('div', { class: 'toolbar' });
  const mk = (label, fn) => { const b = h('button', {}, label); b.addEventListener('click', () => fn(b)); toolbar.append(b); };
  mk('Rescan', async (b) => { b.disabled = true; await refreshOne(r.path); });
  mk('Fetch & prune', (b) => doAction(r, { type: 'fetch' }, b));
  mk('Open folder', () => window.api.openFolder(r.path));
  if (r.remote) mk('Open on GitHub ↗', () => window.api.openUrl(r.remote.url));
  const cats = [...new Set(r.findings.map((f) => f.category))];
  d.replaceChildren(
    h('div', { class: 'dhead' }, h('div', { class: 'grade g' + r.grade }, r.grade), h('h2', {}, r.name), h('span', { class: 'pill' }, `${r.score}/100`)),
    h('div', { class: 'sub' }, r.path, r.git?.branch ? `  ·  ${r.git.branch}` : ''),
    toolbar,
    r.findings.length ? null : h('p', { class: 'ok-msg' }, 'No issues found. Nice.'),
    ...cats.flatMap((c) => [h('h3', {}, c), ...r.findings.filter((f) => f.category === c).map((f) => findingEl(r, f))]),
    r.prs?.length ? [h('h3', {}, `Open pull requests (${r.prs.length})`), ...r.prs.map((p) => h('div', { class: 'finding' },
      h('div', { class: 't' }, h('b', {}, `#${p.number} ${p.title}`), h('span', {}, `${p.headRefName}${p.isDraft ? ' · draft' : ''} · checks: ${p.statusCheckRollup} · review: ${p.reviewDecision || 'none'}`)),
      h('a', { onclick: () => window.api.openUrl(p.url) }, 'Open ↗')))] : null);
}

// Workspace-wide recommendations: group identical finding kinds across repos, biggest impact first.
function renderOverview() {
  state.selected = null;
  const groups = new Map();
  for (const r of state.repos.values()) for (const f of r.findings || []) {
    const kind = f.id.replace(/-\d+$/, '').replace(/^(ci-failed|pr-\w+)-.*/, '$1');
    const g = groups.get(kind) || { title: f.title.replace(/#?\d+/g, 'N'), sev: f.severity, cat: f.category, repos: [] };
    g.repos.push(r.name); groups.set(kind, g);
  }
  const order = { error: 0, warn: 1, info: 2 };
  const list = [...groups.values()].sort((a, b) => order[a.sev] - order[b.sev] || b.repos.length - a.repos.length);
  $('detail').replaceChildren(
    h('h2', {}, 'Workspace overview'),
    list.length ? h('p', { class: 'sub' }, 'Recommendations grouped across all repositories, most severe first.') : h('p', { class: 'empty' }, state.repos.size ? 'Nothing to recommend.' : 'Choose a workspace folder and press Scan.'),
    ...list.map((g) => h('div', { class: 'rec' }, h('span', { class: 'n b-' + (g.sev === 'error' ? 'err' : g.sev === 'warn' ? 'warn' : '') }, g.repos.length),
      h('div', {}, h('div', {}, `${g.title}  `, h('span', { class: 'pill' }, g.cat)), h('div', { class: 'repos' }, g.repos.join(', '))))));
}

function select(dir) { state.selected = dir; renderList(); renderDetail(); }

async function startScan() {
  const root = $('root').value.trim();
  if (!root || state.scanning) return;
  state.scanning = true; state.repos.clear(); state.selected = null;
  $('scan').disabled = true; renderStats(); renderList(); renderOverview();
  const out = await window.api.scan(root, $('deep').checked);
  state.scanning = false; $('scan').disabled = false; $('progress').hidden = true;
  if (!out.ok) toast(out.error, 'bad');
  else if (!out.count) toast('No git repositories found under that folder.', 'bad');
  if (!state.selected) renderOverview();
}

window.api.onBegin(({ total }) => { $('progress').hidden = false; $('bar').style.width = '0'; $('ptext').textContent = `Found ${total} repositories…`; });
window.api.onRepo(({ res, done, total }) => {
  state.repos.set(res.path, res);
  $('bar').style.width = (done / total) * 100 + '%';
  $('ptext').textContent = `Scanned ${done}/${total}`;
  renderStats(); renderList();
});

$('scan').addEventListener('click', startScan);
$('root').addEventListener('keydown', (e) => e.key === 'Enter' && startScan());
$('browse').addEventListener('click', async () => { const d = await window.api.pickDir(); if (d) { $('root').value = d; startScan(); } });
$('q').addEventListener('input', renderList);
$('sort').addEventListener('change', renderList);
$('overview').addEventListener('click', () => { state.selected = null; renderList(); renderOverview(); });

(async () => {
  const s = await window.api.settings();
  if (s.root) $('root').value = s.root;
  $('deep').checked = !!s.deep;
  const a = await window.api.authStatus();
  const pill = $('auth');
  pill.textContent = a.ok ? 'gh: signed in' : 'gh: not signed in (run gh auth login)';
  pill.classList.add(a.ok ? 'ok' : 'bad');
  renderStats();
})();
