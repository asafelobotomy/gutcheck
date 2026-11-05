const $ = (id) => document.getElementById(id);
const state = { repos: new Map(), selected: null, view: 'dashboard', scanning: false, readOnly: false, clutter: null, quality: null, picked: new Set(), trend: [] };

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
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 7000);
}

const counts = (r) => ({
  err: r.findings.filter((f) => f.severity === 'error').length,
  warn: r.findings.filter((f) => f.severity === 'warn').length,
});

/* ---------------------------------------------------------------- stats + list */

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
  document.body.classList.toggle('dash', state.view === 'dashboard'); // the dashboard shows these numbers itself
  const q = $('q').value.toLowerCase();
  const sort = $('sort').value;
  let rs = [...state.repos.values()].filter((r) => r.name.toLowerCase().includes(q));
  rs.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'prs' ? (b.prs?.length || 0) - (a.prs?.length || 0) : (a.score ?? 0) - (b.score ?? 0));
  $('repos').replaceChildren(...rs.map((r) => {
    const c = counts(r);
    return h('li', { class: state.view === 'repo' && r.path === state.selected ? 'sel' : '', onclick: () => select(r.path) },
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

/* ---------------------------------------------------------------- running actions */

// items: [{ repo, action }]. Asks for inputs (single action only), previews, confirms, applies, refreshes.
async function runActions(items, { ask = true } = {}) {
  if (state.readOnly) return toast('Read-only mode is on. Untick "Read-only" in the header to make changes.', 'bad');
  if (ask && items.length === 1) {
    const a = items[0].action;
    const spec = INPUTS[a.type];
    if (spec) {
      const prefill = { ...a };
      if (a.type === 'repo-edit' && prefill.description == null) prefill.description = items[0].repo.remote?.description || '';
      if (a.type === 'repo-edit') prefill.deleteBranchOnMerge = items[0].repo.remote?.deleteBranchOnMerge ?? false;
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
  if (bad.length && !good.length) return toast(bad.map((p) => (p.repoName ? p.repoName + ': ' : '') + p.error).join('\n'), 'bad');
  if (bad.length) toast(`Skipping ${bad.length} repo(s):\n` + bad.map((p) => `${p.repoName || '?'}: ${p.error}`).join('\n'));
  if (!(await confirmPlans(good))) return;
  const outs = await window.api.applyActions(good.map((p) => p.token));
  for (const o of outs) if (o.res) state.repos.set(o.res.path, o.res);
  const rate = outs.find((o) => o.rate)?.rate;
  if (rate) showRate(rate);
  renderStats(); renderList(); renderMain();
  await showResults(outs);
  return outs;
}

const stripUi = (a) => { const { label, ...rest } = a; return rest; };

/* ---------------------------------------------------------------- detail view */

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '');

function btn(label, onclick, cls = '') {
  const b = h('button', { class: 'sm ' + cls }, label);
  b.addEventListener('click', onclick);
  return b;
}

function findingEl(r, f) {
  return h('div', { class: 'finding ' + f.severity },
    h('div', { class: 't' }, h('b', {}, f.title), h('span', {}, f.detail || '')),
    f.url ? h('a', { onclick: () => window.api.openUrl(f.url) }, 'Open ↗') : null,
    f.fix ? btn(f.fix.label, () => runActions([{ repo: r, action: f.fix }])) : null);
}

function branchesPanel(r) {
  const g = r.git || {};
  const def = r.remote?.defaultBranch;
  const remoteSet = new Set((g.remoteBranches || []).map((b) => b.name));
  const prByBranch = new Map((r.prs || []).map((p) => [p.headRefName, p]));
  const act = (type, extra) => () => runActions([{ repo: r, action: { type, ...extra } }]);
  const rows = (g.branches || []).map((b) => {
    const merged = (g.mergedBranches || []).includes(b.name);
    return h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('b', {}, b.name), ' ',
        b.current ? h('span', { class: 'badge cur' }, 'current') : null,
        merged ? h('span', { class: 'badge ok' }, 'merged') : null,
        remoteSet.has(b.name) ? null : h('span', { class: 'badge' }, 'local only'),
        prByBranch.has(b.name) ? h('span', { class: 'badge' }, `PR #${prByBranch.get(b.name).number}`) : null,
        h('span', { class: 'muted' }, ' ' + fmtDate(b.date))),
      !b.current ? btn('Switch', act('checkout', { branch: b.name })) : null,
      !b.current ? btn('Merge into current…', act('merge-branch', { branch: b.name })) : null,
      r.remote && !r.remote.unreachable && b.name !== def && remoteSet.has(b.name) && !prByBranch.has(b.name) ? btn('Open PR…', act('pr-create', { branch: b.name })) : null,
      !b.current ? btn(merged ? 'Delete' : 'Force delete', act('delete-local', { branch: b.name, force: !merged }), merged ? '' : 'dng') : null);
  });
  const localNames = new Set((g.branches || []).map((b) => b.name));
  const remoteOnly = (g.remoteBranches || []).filter((b) => !localNames.has(b.name));
  const remoteRows = remoteOnly.map((b) => h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('b', {}, 'origin/' + b.name), ' ', h('span', { class: 'badge' }, 'remote only'), b.name === def ? h('span', { class: 'badge cur' }, 'default') : null, h('span', { class: 'muted' }, ' ' + fmtDate(b.date))),
    b.name !== def ? btn('Delete on GitHub', act('delete-remote', { branch: b.name }), 'dng') : null));
  return [h('h3', {}, `Branches (${rows.length} local, ${remoteOnly.length} remote-only)`),
    h('div', { class: 'toolbar' }, btn('New branch…', act('create-branch', {})), btn('Pull', act('pull', {})), btn('Push', act('push', {}))),
    ...rows, ...remoteRows];
}

function prsPanel(r) {
  if (!r.prs?.length) return [];
  const act = (type, p, extra) => () => runActions([{ repo: r, action: { type, number: p.number, ...extra } }]);
  return [h('h3', {}, `Open pull requests (${r.prs.length})`), ...r.prs.map((p) => h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('b', {}, `#${p.number} ${p.title}`), h('div', { class: 'muted' }, `${p.headRefName}${p.isDraft ? ' · draft' : ''} · checks: ${p.statusCheckRollup} · review: ${p.reviewDecision || 'none'}${p.mergeable === 'CONFLICTING' ? ' · conflicts' : ''}`)),
    p.isDraft ? btn('Ready for review', act('pr-ready', p)) : btn('Merge…', act('pr-merge', p, { method: 'squash', deleteBranch: true })),
    btn('Close', act('pr-close', p)),
    btn('Open ↗', () => window.api.openUrl(p.url))))];
}

function settingsPanel(r) {
  if (!r.remote || r.remote.unreachable) return [];
  const act = (type, extra) => () => runActions([{ repo: r, action: { type, ...extra } }]);
  const prot = r.protection === true ? 'on' : r.protection === false ? 'off' : 'unknown';
  return [h('h3', {}, 'Repository settings'),
    h('div', { class: 'muted' }, `Default branch protection: ${prot} · Dependabot alerts: ${r.remote.alertsEnabled === false ? 'off' : r.remote.alertsEnabled ? 'on' : 'unknown'} · Your permission: ${r.remote.viewerPermission || 'unknown'}`),
    h('div', { class: 'toolbar' },
      btn('Protect default branch…', act('protect-branch', { preset: 'basic' })),
      r.protection === true ? btn('Remove protection', act('unprotect-branch', {}), 'dng') : null,
      btn('Enable Dependabot alerts', act('security-enable', { feature: 'alerts' })),
      btn('Enable security updates', act('security-enable', { feature: 'security-fixes' })),
      btn('Enable secret scanning', act('security-enable', { feature: 'secret-scanning' })),
      btn('Edit description / merge options…', act('repo-edit', {})),
      r.remote.archived ? null : btn('Archive repo', act('repo-archive', {}), 'dng'))];
}

const FILE_TEMPLATES = [
  ['license', 'LICENSE', (r) => r.files.license], ['readme', 'README', (r) => r.files.readme], ['gitignore', '.gitignore', (r) => r.files.gitignore],
  ['security', 'SECURITY.md', (r) => r.files.security], ['contributing', 'CONTRIBUTING.md', (r) => r.files.contributing], ['conduct', 'CODE_OF_CONDUCT.md', (r) => r.files.codeOfConduct],
  ['pr-template', 'PR template', (r) => r.files.prTemplate], ['dependabot', 'dependabot.yml', (r) => r.files.dependabotConfig], ['ci-node', 'Node CI workflow', (r) => r.hasWorkflows],
];

function filesPanel(r) {
  const missing = FILE_TEMPLATES.filter(([, , has]) => !has(r));
  if (!missing.length) return [];
  return [h('h3', {}, 'Add missing files'), h('div', { class: 'toolbar' }, missing.map(([id, label]) => btn('+ ' + label, () => runActions([{ repo: r, action: { type: 'add-file', template: id } }]))))];
}

function renderRepo() {
  const d = $('detail');
  const r = state.repos.get(state.selected);
  if (!r) return renderOverview();
  if (r.error) return put(d, h('h2', {}, r.name), h('p', { class: 'b-err' }, r.error));
  const toolbar = h('div', { class: 'toolbar' });
  const mk = (label, fn) => { const b = h('button', {}, label); b.addEventListener('click', () => fn(b)); toolbar.append(b); };
  mk('Rescan', async (b) => { b.disabled = true; await refreshOne(r.path); });
  mk('Fetch & prune', () => runActions([{ repo: r, action: { type: 'fetch' } }]));
  mk('Copy for LLM', (b) => copyForLlm(b, r.path, r.name));
  mk('Open folder', () => window.api.openFolder(r.path));
  if (r.remote) mk('Open on GitHub ↗', () => window.api.openUrl(r.remote.url));
  const cats = [...new Set(r.findings.map((f) => f.category))];
  put(d, 
    h('div', { class: 'dhead' }, h('div', { class: 'grade g' + r.grade }, r.grade), h('h2', {}, r.name), h('span', { class: 'pill' }, `${r.score}/100`)),
    h('div', { class: 'sub' }, r.path, r.git?.branch ? `  ·  ${r.git.branch}` : ''),
    toolbar,
    r.findings.length ? null : h('p', { class: 'ok-msg' }, 'No issues found. Nice.'),
    ...cats.flatMap((c) => [h('h3', {}, c), ...r.findings.filter((f) => f.category === c).map((f) => findingEl(r, f))]),
    ...prsPanel(r), ...branchesPanel(r), ...settingsPanel(r), ...filesPanel(r));
}

async function copyForLlm(b, dir, label) {
  b.disabled = true;
  try {
    const out = await window.api.copyReport(dir);
    if (!out.ok) return toast(out.error, 'bad');
    toast(`Copied a ${Math.round(out.chars / 1000)}k-character report for ${label} to the clipboard. Paste it into your LLM. It includes repo paths, PR and branch titles and clutter file names, but no file contents.`);
  } finally { b.disabled = false; }
}

async function refreshOne(dir) {
  const out = await window.api.rescan(dir, $('deep').checked);
  if (out.ok) { state.repos.set(dir, out.res); showRate(out.rate); }
  renderStats(); renderList(); renderMain();
}

/* ---------------------------------------------------------------- overview + history */

const BULKABLE = new Set(['add-file', 'run-rerun', 'pull', 'push', 'delete-merged', 'security-enable', 'fetch', 'npm-install']);

// Workspace-wide recommendations: group identical findings across repos, biggest impact first.
function renderOverview() {
  state.view = 'overview'; state.selected = null;
  const list = Metrics.groupFindings([...state.repos.values()].filter((r) => !r.error));
  put($('detail'), 
    h('h2', {}, 'Workspace overview'),
    state.repos.size ? (() => { const b = h('button', {}, 'Copy for LLM'); b.title = 'Copy a full report with an ordered fix plan, to paste into any LLM'; b.addEventListener('click', () => copyForLlm(b, null, 'the whole workspace')); return h('div', { class: 'toolbar' }, b); })() : null,
    list.length ? h('p', { class: 'sub' }, 'Recommendations grouped across all repositories, most severe first. "Fix all" previews every command before anything runs.') : h('p', { class: 'empty' }, state.repos.size ? 'Nothing to recommend.' : 'Choose a workspace folder and press Scan.'),
    ...list.map((g) => {
      const bulk = g.fixes.every((f) => f && BULKABLE.has(f.action.type)) && g.fixes.length > 1;
      return h('div', { class: 'rec' }, h('span', { class: 'n b-' + (g.sev === 'error' ? 'err' : g.sev === 'warn' ? 'warn' : '') }, g.repos.length),
        h('div', { class: 'grow' }, h('div', {}, `${g.title}  `, h('span', { class: 'pill' }, g.cat)), h('div', { class: 'repos' }, g.repos.join(', '))),
        bulk ? btn(`Fix all ${g.fixes.length}…`, () => runActions(g.fixes, { ask: false })) : null);
    }));
}

async function renderHistory() {
  state.view = 'history'; state.selected = null;
  const entries = await window.api.audit();
  put($('detail'), 
    h('h2', {}, 'Action history'),
    h('p', { class: 'sub' }, 'Everything GutCheck has changed on this machine (newest first). Stored locally in the app data folder.'),
    entries.length ? null : h('p', { class: 'empty' }, 'Nothing yet.'),
    ...entries.map((e) => h('div', { class: 'finding ' + (e.ok ? '' : 'error') },
      h('div', { class: 't' }, h('b', {}, `${e.ok ? '✓' : '✗'} ${e.repo}: ${e.title}`),
        h('span', {}, new Date(e.ts).toLocaleString() + ' · ' + (e.steps || []).map((s) => s.cmd).join('  ;  '))))));
  renderList();
}

function renderMain() {
  if (state.view === 'clutter') renderClutterView();
  else if (state.view === 'quality') renderQualityView();
  else if (state.view === 'repo' && state.repos.has(state.selected)) renderRepo();
  else if (state.view === 'history') renderHistory();
  else if (state.view === 'overview') renderOverview();
  else renderDashboard();
}

function select(dir) { state.selected = dir; state.view = 'repo'; renderList(); renderRepo(); }

/* ---------------------------------------------------------------- scanning */

async function startScan() {
  const root = $('root').value.trim();
  if (!root || state.scanning) return;
  state.scanning = true; state.clutter = null; state.quality = null; state.picked.clear(); state.repos.clear(); state.selected = null; state.view = 'dashboard';
  $('ptext').textContent = 'Scanning…'; $('progress').hidden = false;
  $('scan').disabled = true; renderStats(); renderList(); renderMain();
  const out = await window.api.scan(root, $('deep').checked);
  showRate(out.rate);
  state.scanning = false; $('scan').disabled = false; $('progress').hidden = true;
  await loadTrend();
  if (!out.ok) toast(out.error, 'bad');
  else if (!out.count) toast('No git repositories found under that folder.', 'bad');
  renderMain();
}

window.api.onBegin(({ total }) => { $('progress').hidden = false; $('bar').style.width = '0'; $('ptext').textContent = `Found ${total} repositories…`; });

// Repo results can arrive faster than we can usefully paint; coalesce to one render per frame.
let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; renderStats(); renderList(); if (state.view === 'dashboard') renderDashboard(); });
}

function showRate(rate) {
  const pill = $('rate');
  if (!rate || !rate.core) { pill.textContent = ''; return; }
  const n = (x) => x.remaining.toLocaleString();
  pill.textContent = `API left: ${n(rate.core)} REST · ${n(rate.graphql)} GraphQL`;
  pill.classList.toggle('bad', !!rate.limited);
  pill.title = `Resets ${new Date(rate.core.reset).toLocaleTimeString()} (REST) / ${new Date(rate.graphql.reset).toLocaleTimeString()} (GraphQL)`;
}

window.api.onRepo(({ res, done, total }) => {
  state.repos.set(res.path, res);
  $('bar').style.width = (done / total) * 100 + '%';
  $('ptext').textContent = `Scanned ${done}/${total}`;
  schedulePaint();
});

$('scan').addEventListener('click', startScan);
$('root').addEventListener('keydown', (e) => e.key === 'Enter' && startScan());
$('browse').addEventListener('click', async () => { const d = await window.api.pickDir(); if (d) { $('root').value = d; startScan(); } });
$('q').addEventListener('input', renderList);
$('sort').addEventListener('change', renderList);
$('overview').addEventListener('click', () => { renderOverview(); renderList(); });
$('history').addEventListener('click', renderHistory);
$('readonly').addEventListener('change', async (e) => {
  state.readOnly = e.target.checked;
  await window.api.setSettings({ readOnly: state.readOnly });
  toast(state.readOnly ? 'Read-only mode on: no changes can be made.' : 'Read-only mode off: actions are enabled (each one still asks first).');
});

(async () => {
  const s = await window.api.settings();
  if (s.root) $('root').value = s.root;
  $('deep').checked = !!s.deep;
  state.readOnly = !!s.readOnly;
  $('readonly').checked = state.readOnly;
  const a = await window.api.authStatus();
  const pill = $('auth');
  pill.textContent = a.ok ? 'gh: signed in' : 'gh: not signed in (run gh auth login)';
  pill.classList.add(a.ok ? 'ok' : 'bad');
  renderStats();
  showRate(await window.api.rate());
})();
