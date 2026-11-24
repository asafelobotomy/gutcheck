// One repo's page: a header with the score gauge and live git state, then tabs (Issues, Pull
// requests, Branches, Settings, Files). Every list can be filtered, and rows can be ticked to act on
// many at once; each row keeps its own buttons too. Loaded after ui.js; shares app.js's globals
// ($, h, put, btn, state, runActions, actOn, fmtDate, select, refreshOne...) and UI.

const repoPick = { key: null, findings: new Set(), prs: new Set(), branches: new Set(), files: new Set() };
const repoView = { tab: 'issues', sev: 'all', branchFilter: 'all' };
const SEV_ICON = { error: 'error', warn: 'alert', info: 'dot' };

// Picks belong to one repo: opening another clears them.
function repoPicks(r) {
  if (repoPick.key !== r.path) { repoPick.key = r.path; for (const k of ['findings', 'prs', 'branches', 'files']) repoPick[k].clear(); }
  return repoPick;
}

function findingEl(r, f, pick) {
  const fix = RemoteView.canFix(r, f.fix) ? f.fix : null;
  return h('div', { class: 'finding ' + f.severity },
    pick && fix && fix.type !== 'permissions-prune' ? UI.tick(pick, f.id, renderRepo, `Select: ${f.title}`) : h('span', { class: 'pickgap' }),
    UI.icon(SEV_ICON[f.severity] || 'dot', 'sev'),
    h('div', { class: 't' }, h('b', {}, f.title), h('span', {}, f.detail || '')),
    h('div', { class: 'facts' },
      f.url ? UI.iconOnly('external', 'Open ↗', () => window.api.openUrl(f.url), 'ghost', 'Open on GitHub') : null,
      !fix ? null : fix.type === 'permissions-prune' ? btn('Review rules…', () => reviewRules(r, fix.hashes)) : btn(fix.label, () => runActions([{ repo: r, action: fix }]), 'fixb'),
      ignoreButton(r, f)));
}

function issuesTab(r) {
  const pick = repoPicks(r).findings;
  const c = UI.sevCounts(r.findings);
  const shown = r.findings.filter((f) => repoView.sev === 'all' || f.severity === repoView.sev);
  const cats = [...new Set(shown.map((f) => f.category))];
  const fixable = r.findings.filter((f) => f.fix && RemoteView.canFix(r, f.fix) && f.fix.type !== 'permissions-prune');
  const chosen = fixable.filter((f) => pick.has(f.id));
  const fixSel = () => runActions(chosen.map((f) => ({ repo: r, action: f.fix })), { ask: false, hold: FixAll.automatic });
  const ignoreSel = async () => {
    const v = await askInputs({ ...IGNORE_SPEC, title: `Ignore ${plural(chosen.length, 'finding')}` }, {});
    if (!v) return;
    for (const f of chosen) await applyIgnore(r, { id: f.id, reason: v.reason, allRepos: !!v.allRepos });
    pick.clear(); renderRepo();
  };
  const filter = UI.segmented([
    { value: 'all', label: 'All', count: r.findings.length },
    { value: 'error', label: 'Errors', count: c.error, dot: 'err' },
    { value: 'warn', label: 'Warnings', count: c.warn, dot: 'warn' },
    { value: 'info', label: 'Notes', count: c.info, dot: 'info' }], repoView.sev, (v) => { repoView.sev = v; renderRepo(); }, 'Show issues by severity');
  if (!r.findings.length) return [UI.empty('check', 'No issues found', 'Every check passed for this repo.', null, 'good'), ...ignoredFold(r)];
  return [
    h('div', { class: 'listhead' }, UI.tickAll(pick, fixable.map((f) => f.id), renderRepo, 'Select every fixable issue'), filter,
      h('span', { class: 'muted' }, `${plural(fixable.length, 'issue')} can be fixed here`)),
    UI.bulkBar(chosen.length, 'issue', [btn(`Fix selected (${chosen.length})…`, fixSel, 'primary'), btn('Ignore selected…', ignoreSel)], () => { pick.clear(); renderRepo(); }),
    ...cats.map((cat) => {
      const fs = shown.filter((f) => f.category === cat);
      const cc = UI.sevCounts(fs);
      return UI.fold(`${r.path}|cat|${cat}`, [h('span', { class: 'ftitle' }, cat), UI.vitals(cc, 6), h('span', { class: 'cnt' }, String(fs.length))],
        fs.map((f) => findingEl(r, f, pick)), { open: cc.error > 0 || cats.length <= 3, cls: 'cat' });
    }),
    shown.length ? null : h('p', { class: 'empty' }, 'No issues at this level.'),
    ...ignoredFold(r)];
}

function ignoredFold(r) {
  const p = ignoredPanel(r);
  return p.length ? [UI.fold(`${r.path}|ignored`, [h('span', { class: 'ftitle' }, 'Ignored'), h('span', { class: 'cnt' }, String(r.ignored.length))], p.slice(1), { cls: 'cat muted-fold' })] : [];
}

const CHECKS = { SUCCESS: ['ok', 'checks pass'], FAILURE: ['err', 'checks fail'], PENDING: ['warn', 'checks running'] };
const REVIEW = { APPROVED: ['ok', 'approved'], CHANGES_REQUESTED: ['err', 'changes requested'], REVIEW_REQUIRED: ['warn', 'review required'] };
function prsTab(r) {
  if (!r.prs?.length) return [UI.empty('pr', 'No open pull requests')];
  const pick = repoPicks(r).prs;
  const act = (type, p, extra) => actOn(r, type, { number: p.number, ...extra });
  const sel = r.prs.filter((p) => pick.has(p.number));
  const mergeable = sel.filter((p) => !p.isDraft);
  const bulk = (type, list, extra = {}) => () => runActions(list.map((p) => ({ repo: r, action: { type, number: p.number, ...extra } })), { ask: false });
  return [h('h3', {}, `Open pull requests (${r.prs.length})`),
    h('div', { class: 'listhead' }, UI.tickAll(pick, r.prs.map((p) => p.number), renderRepo, 'Select every pull request'), h('span', { class: 'muted' }, 'Tick pull requests to merge or close them together')),
    UI.bulkBar(sel.length, 'pull request', [mergeable.length ? btn(`Squash and merge ${mergeable.length}…`, bulk('pr-merge', mergeable, { method: 'squash', deleteBranch: true }), 'primary') : null, btn(`Close ${sel.length}…`, bulk('pr-close', sel))], () => { pick.clear(); renderRepo(); }),
    ...r.prs.map((p) => {
      const ck = CHECKS[p.statusCheckRollup] || ['muted', 'no checks'];
      const rv = REVIEW[p.reviewDecision] || ['muted', 'not reviewed'];
      return h('div', { class: 'row prrow' }, UI.tick(pick, p.number, renderRepo, `Select #${p.number}`), UI.icon('pr', p.isDraft ? 'draft' : 'open'),
        h('div', { class: 'grow' }, h('b', {}, `#${p.number} ${p.title}`),
          h('div', { class: 'chips' }, h('span', { class: 'chip mono' }, p.headRefName), p.isDraft ? UI.status('muted', 'draft') : null, UI.status(ck[0], ck[1]), UI.status(rv[0], rv[1]), p.mergeable === 'CONFLICTING' ? UI.status('err', 'conflicts') : null)),
        p.isDraft ? btn('Ready for review', act('pr-ready', p)) : btn('Merge…', act('pr-merge', p, { method: 'squash', deleteBranch: true })),
        UI.iconOnly('x', 'Close', act('pr-close', p), '', `Close #${p.number} without merging…`),
        UI.iconOnly('external', 'Open ↗', () => window.api.openUrl(p.url), 'ghost', 'Open on GitHub'));
    })];
}

function branchesTab(r) {
  if (RemoteView.isRemote(r)) return RemoteView.branches(r, () => []);
  const g = r.git || {};
  const def = r.remote?.defaultBranch;
  const remoteSet = new Set((g.remoteBranches || []).map((b) => b.name));
  const prByBranch = new Map((r.prs || []).map((p) => [p.headRefName, p]));
  const merged = new Set(g.mergedBranches || []);
  const act = (type, extra) => actOn(r, type, extra);
  const pick = repoPicks(r).branches;
  const stale = (b) => b.date && Date.now() - new Date(b.date).getTime() > Metrics.STALE_BRANCH_DAYS * 864e5 && !merged.has(b.name);
  const local = (g.branches || []).map((b) => ({ ...b, key: 'l:' + b.name, merged: merged.has(b.name), localOnly: !remoteSet.has(b.name), stale: !b.current && stale(b) }));
  const localNames = new Set(local.map((b) => b.name));
  const remoteOnly = (g.remoteBranches || []).filter((b) => !localNames.has(b.name)).map((b) => ({ ...b, key: 'r:' + b.name, remoteOnly: true }));
  const F = { all: () => true, merged: (b) => b.merged, stale: (b) => b.stale, local: (b) => b.localOnly, remote: (b) => b.remoteOnly };
  const every = [...local, ...remoteOnly];
  const deletable = every.filter((b) => (b.remoteOnly ? b.name !== def : !b.current));
  const sel = deletable.filter((b) => pick.has(b.key));
  const delAction = (b) => (b.remoteOnly ? { type: 'delete-remote', branch: b.name } : { type: 'delete-local', branch: b.name, force: !b.merged });
  const unmergedSel = sel.filter((b) => !b.remoteOnly && !b.merged).length;
  const rows = every.filter(F[repoView.branchFilter] || F.all).map((b) => h('div', { class: 'row brow' },
    deletable.includes(b) ? UI.tick(pick, b.key, renderRepo, `Select ${b.name}`) : h('span', { class: 'pickgap' }),
    UI.icon('branch', b.current ? 'cur' : ''),
    h('div', { class: 'grow' }, h('b', {}, b.remoteOnly ? 'origin/' + b.name : b.name), ' ',
      b.current ? UI.badge('star', 'current', 'cur') : null,
      b.merged ? UI.badge('merge', 'merged', 'ok') : null,
      b.stale ? UI.badge('clock', `stale: no commits for ${Metrics.STALE_BRANCH_DAYS}+ days`, 'warn') : null,
      b.remoteOnly ? UI.badge('cloud', 'remote only: not checked out here') : b.localOnly ? UI.badge('laptop', 'local only: not on GitHub') : null,
      b.remoteOnly && b.name === def ? h('span', { class: 'badge cur' }, 'default') : null,
      prByBranch.has(b.name) ? h('span', { class: 'badge', title: 'Has an open pull request' }, UI.icon('pr'), `#${prByBranch.get(b.name).number}`) : null,
      h('span', { class: 'muted' }, ' ' + fmtDate(b.date))),
    b.remoteOnly ? null : !b.current ? UI.iconOnly('switch', 'Switch', act('checkout', { branch: b.name }), '', `Switch to ${b.name}`) : null,
    b.remoteOnly ? null : !b.current ? UI.iconOnly('merge', 'Merge into current…', act('merge-branch', { branch: b.name }), '', `Merge ${b.name} into ${g.branch || 'the current branch'}…`) : null,
    !b.remoteOnly && r.remote && !r.remote.unreachable && b.name !== def && remoteSet.has(b.name) && !prByBranch.has(b.name) ? UI.iconOnly('pr', 'Open PR…', act('pr-create', { branch: b.name }), '', `Open a pull request from ${b.name}…`) : null,
    b.remoteOnly ? (b.name !== def ? UI.iconOnly('trash', 'Delete on GitHub', act('delete-remote', { branch: b.name }), 'dng', `Delete ${b.name} on GitHub…`) : null)
      : !b.current ? UI.iconOnly('trash', b.merged ? 'Delete' : 'Force delete', act('delete-local', { branch: b.name, force: !b.merged }), b.merged ? '' : 'dng', b.merged ? `Delete ${b.name} (merged, nothing is lost)…` : `Force delete ${b.name}: not merged, its commits may be lost…`) : null));
  const count = (k) => every.filter(F[k]).length;
  return [h('h3', {}, `Branches (${local.length} local, ${remoteOnly.length} remote-only)`),
    h('div', { class: 'toolbar' }, UI.ibtn('plus', 'New branch…', act('create-branch', {})), UI.ibtn('arrowdown', 'Pull', act('pull', {})), UI.ibtn('arrowup', 'Push', act('push', {})), UI.ibtn('rescue', 'Save a rescue copy…', act('rescue-bundle', {}))),
    h('div', { class: 'listhead' }, UI.tickAll(pick, deletable.map((b) => b.key), renderRepo, 'Select every branch that can be deleted'),
      UI.segmented([{ value: 'all', label: 'All', count: every.length }, { value: 'merged', label: 'Merged', count: count('merged'), dot: 'ok' }, { value: 'stale', label: 'Stale', count: count('stale'), dot: 'warn' },
        { value: 'local', label: 'Local only', count: count('local') }, { value: 'remote', label: 'Remote only', count: count('remote') }], repoView.branchFilter, (v) => { repoView.branchFilter = v; renderRepo(); }, 'Show branches')),
    UI.bulkBar(sel.length, 'branch', [btn(`Delete ${sel.length}…`, () => runActions(sel.map((b) => ({ repo: r, action: delAction(b) })), { ask: false, lead: unmergedSel ? [`${plural(unmergedSel, 'branch', 'branches')} not merged: their commits are lost unless they exist elsewhere.`] : [] }), 'danger')], () => { pick.clear(); renderRepo(); }),
    ...(rows.length ? rows : [h('p', { class: 'empty' }, 'No branches match.')])];
}

function settingsTab(r) {
  if (!r.remote || r.remote.unreachable) return [UI.empty('shield', 'No GitHub repository', 'Settings appear once this repo has a reachable GitHub remote.')];
  const act = (type, extra) => actOn(r, type, extra);
  const onOff = (v) => (v === true ? ['ok', 'On'] : v === false ? ['err', 'Off'] : ['muted', 'Unknown']);
  const line = (iconName, label, value, ...buttons) => { const [tone, text] = onOff(value); return h('div', { class: 'row setrow' }, UI.icon(iconName), h('div', { class: 'grow' }, h('b', {}, label)), UI.status(tone, text), ...buttons); };
  const finding = (id) => r.findings.some((f) => f.id === id);
  return [h('h3', {}, 'Repository settings'),
    h('div', { class: 'muted' }, `Your permission: ${r.remote.viewerPermission || 'unknown'}`),
    line('shield', 'Default branch protection', r.protection, r.protection === true && !RemoteView.isRemote(r) ? btn('Remove protection', act('unprotect-branch', {}), 'dng') : btn('Protect default branch…', act('protect-branch', { preset: 'minimal' }))),
    line('alert', 'Dependabot alerts', r.remote.alertsEnabled, r.remote.alertsEnabled === true ? null : btn('Enable Dependabot alerts', act('security-enable', { feature: 'alerts' }))),
    line('refresh', 'Dependabot security updates', finding('security-fixes-off') ? false : null, btn('Enable security updates', act('security-enable', { feature: 'security-fixes' }))),
    line('secrets', 'Secret scanning', finding('secret-scanning-off') ? false : null, btn('Enable secret scanning', act('security-enable', { feature: 'secret-scanning' }))),
    h('div', { class: 'row setrow' }, UI.icon('file'), h('div', { class: 'grow' }, h('b', {}, 'Description and merge options'), h('div', { class: 'muted' }, r.remote.description || 'No description')), btn('Edit description / merge options…', act('repo-edit', {}))),
    r.remote.archived ? h('div', { class: 'row setrow' }, UI.icon('lock'), h('div', { class: 'grow' }, h('b', {}, 'Archived')), UI.status('muted', 'Read-only on GitHub'))
      : h('div', { class: 'row setrow dzone' }, UI.icon('lock'), h('div', { class: 'grow' }, h('b', {}, 'Archive this repository'), h('div', { class: 'muted' }, 'Makes it read-only on GitHub until you unarchive it.')), btn('Archive repo', act('repo-archive', {}), 'dng'))];
}

const FILE_TEMPLATES = [
  ['license', 'LICENSE', (r) => r.files.license], ['readme', 'README', (r) => r.files.readme], ['gitignore', '.gitignore', (r) => r.files.gitignore],
  ['security', 'SECURITY.md', (r) => r.files.security], ['contributing', 'CONTRIBUTING.md', (r) => r.files.contributing], ['conduct', 'CODE_OF_CONDUCT.md', (r) => r.files.codeOfConduct],
  ['pr-template', 'PR template', (r) => r.files.prTemplate], ['dependabot', 'dependabot.yml', (r) => r.files.dependabotConfig], ['ci-node', 'Node CI workflow', (r) => r.hasWorkflows || !r.deps?.npmLock],
];

function filesTab(r) {
  if (!r.files) return [];
  const pick = repoPicks(r).files;
  const missing = FILE_TEMPLATES.filter(([, , has]) => !has(r));
  const sel = missing.filter(([id]) => pick.has(id));
  return [h('h3', {}, missing.length ? 'Add missing files' : 'Project files'),
    missing.length ? h('div', { class: 'listhead' }, UI.tickAll(pick, missing.map(([id]) => id), renderRepo, 'Select every missing file'), h('span', { class: 'muted' }, `${missing.length} of ${FILE_TEMPLATES.length} missing`)) : null,
    UI.bulkBar(sel.length, 'file', [btn(`Add ${sel.length} file${sel.length === 1 ? '' : 's'}…`, () => runActions(sel.map(([id]) => ({ repo: r, action: { type: 'add-file', template: id, commit: true } })), { ask: false }), 'primary')], () => { pick.clear(); renderRepo(); }),
    h('div', { class: 'tiles' }, FILE_TEMPLATES.map(([id, label, has]) => (has(r)
      ? h('div', { class: 'tile have' }, UI.icon('check'), h('span', {}, label))
      : h('div', { class: 'tile miss' }, UI.tick(pick, id, renderRepo, `Select ${label}`), UI.icon('file'), h('span', { class: 'grow' }, label), UI.iconOnly('plus', '+ ' + label, actOn(r, 'add-file', { template: id }), 'ghost', `Add ${label}…`)))))];
}

function repoStatus(r) {
  const g = r.git || {};
  const failing = (r.ci && r.ci.failed || []).length;
  return h('div', { class: 'chips vit' },
    g.branch ? h('span', { class: 'chip mono', title: 'Current branch' }, UI.icon('branch'), g.branch) : null,
    g.dirty ? UI.icount('pencil', g.dirty, 'uncommitted changes', 'b-warn') : g.branch ? UI.badge('check', 'clean: nothing uncommitted', 'ok') : null,
    g.ahead ? UI.icount('arrowup', g.ahead, 'commits to push', 'b-warn') : null, g.behind ? UI.icount('arrowdown', g.behind, 'commits to pull') : null,
    r.prs?.length ? UI.icount('pr', r.prs.length, r.prs.length === 1 ? 'open PR' : 'open PRs') : null,
    r.remote ? (failing ? UI.status('err', `CI failing`) : UI.status('ok', 'CI ok')) : UI.badge('cloudoff', 'no GitHub backup', 'warn'));
}

function renderRepo() {
  const d = $('detail');
  const r = state.repos.get(state.selected);
  if (!r) return renderOverview();
  if (r.error) return put(d, h('div', { class: 'dhead' }, h('h2', {}, r.name)), UI.empty('alert', 'This repo could not be scanned', r.error, btn('Rescan', () => refreshOne(r.path)), 'bad'));
  const top = d.scrollTop;
  const toolbar = h('div', { class: 'toolbar' });
  const all = FixAll.plan(r);
  const fixable = all.actions.length + all.decisions.length;
  if (fixable) toolbar.append(UI.ibtn('wrench', `Fix all issues (${fixable})…`, () => fixAllIssues(r, all), 'primary'));
  toolbar.append(UI.iconOnly('refresh', 'Rescan', async (e) => { e.currentTarget.disabled = true; await refreshOne(r.path); }, '', 'Rescan this repo'));
  if (!RemoteView.isRemote(r) && (!r.git || !Array.isArray(r.git.remotes) || r.git.remotes.length)) toolbar.append(UI.iconOnly('fetch', 'Fetch & prune', actOn(r, 'fetch'), '', 'Fetch & prune: download new commits and drop deleted remote branches…'));
  if (!RemoteView.isRemote(r)) toolbar.append(UI.iconOnly('folder', 'Open folder', () => window.api.openFolder(r.path), '', 'Open the folder'));
  else if (r.remote) toolbar.append(UI.ibtn('download', 'Clone here', () => GitHubView.get([{ owner: r.remote.owner, name: r.remote.name, kind: 'clone' }]), 'fixb'));
  if (r.remote) toolbar.append(UI.iconOnly('github', 'Open on GitHub ↗', () => window.api.openUrl(r.remote.url), '', 'Open on GitHub'));
  toolbar.append(copyButton(r.path, r.name));
  const c = UI.sevCounts(r.findings);
  const branches = branchesTab(r);
  const files = RemoteView.localPanel(r, filesTab);
  const missingFiles = r.files ? FILE_TEMPLATES.filter(([, , has]) => !has(r)).length : 0;
  const tabs = [
    { id: 'issues', label: 'Issues', icon: 'alert', count: r.findings.length, tone: c.error ? 'err' : c.warn ? 'warn' : '', body: issuesTab(r) },
    r.prs?.length ? { id: 'prs', label: 'Pull requests', icon: 'pr', count: r.prs.length, body: prsTab(r) } : null,
    branches.length ? { id: 'branches', label: 'Branches', icon: 'branch', count: RemoteView.isRemote(r) ? (r.ghBranches || []).length : (r.git?.branches || []).length, body: branches } : null,
    r.remote && !r.remote.unreachable ? { id: 'settings', label: 'Settings', icon: 'gear', body: settingsTab(r) } : null,
    files.length ? { id: 'files', label: 'Files', icon: 'file', count: missingFiles || null, tone: missingFiles ? 'warn' : '', body: files } : null,
  ].filter(Boolean);
  put(d,
    h('div', { class: 'rhead' }, UI.gauge(r.score, r.grade, 68),
      h('div', { class: 'grow' },
        h('div', { class: 'dhead' }, h('h2', {}, r.name), h('span', { class: 'pill score' }, `${r.score}/100`), UI.vitals(c)),
        h('div', { class: 'sub' }, RemoteView.where(r), r.git?.branch ? `  ·  ${r.git.branch}` : ''),
        repoStatus(r))),
    toolbar, RemoteView.note(r),
    ...UI.tabs(tabs, repoView.tab, (id) => { repoView.tab = id; renderRepo(); }));
  d.scrollTop = top;
}
