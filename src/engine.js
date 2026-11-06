// Headless GutCheck: the same scans, report and actions as the app, for the command line and the
// MCP server. It shares the app's data folder, so Read-only mode, quality settings, the action
// history and trend snapshots are the same ones the app shows.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover, scanRepo, scanAll } = require('./scanner');
const github = require('./github');
const { createService } = require('./service');
const { createSettingsStore } = require('./settings');
const { appendAudit, readAudit } = require('./audit');
const { expandHome } = require('./util');

const OFF = 'Actions are turned off: start GutCheck with --allow-actions to plan and apply changes. Everything else works read-only.';
const APP_NAME = 'GutCheck'; // Electron names the data folder after productName

// Where Electron's app.getPath('userData') points for this app, so CLI and app share settings.
function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.GUTCHECK_DATA_DIR) return env.GUTCHECK_DATA_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

// Catalogue of every action an agent can plan: parameters and allowed values. Planning still
// validates everything; this only saves the caller from guessing.
const ACTION_CATALOG = {
  fetch: { about: 'Fetch all remotes and prune deleted branches', params: {} },
  pull: { about: 'Fast-forward the current branch from its upstream', params: {} },
  push: { about: 'Push the current branch (sets the upstream if missing)', params: {} },
  checkout: { about: 'Switch to a local branch', params: { branch: 'local branch name' } },
  'create-branch': { about: 'Create a branch and switch to it', params: { name: 'new branch name', from: 'optional start point (branch)' } },
  'merge-branch': { about: 'Merge a local branch into the current one', params: { branch: 'local branch', mode: '"ff-only" (default) or "no-ff"' } },
  'delete-local': { about: 'Delete a local branch', params: { branch: 'local branch', force: 'true to delete unmerged work (danger)' } },
  'delete-merged': { about: 'Delete local branches already merged', params: { branches: 'array of branch names from the scan' } },
  'delete-remote': { about: 'Delete a branch on GitHub', params: { branch: 'remote branch' } },
  'commit-all': { about: 'Stage and commit every change', params: { message: 'commit message' } },
  'pr-create': { about: 'Open a pull request', params: { branch: 'head branch', title: 'PR title' } },
  'pr-merge': { about: 'Merge a pull request', params: { number: 'PR number', method: '"squash", "merge" or "rebase"', deleteBranch: 'true to delete the head branch' } },
  'pr-close': { about: 'Close a pull request', params: { number: 'PR number' } },
  'pr-ready': { about: 'Mark a draft pull request ready for review', params: { number: 'PR number' } },
  'run-rerun': { about: 'Re-run a failed CI run', params: { runId: 'run id from the scan', failedOnly: 'true to re-run only failed jobs' } },
  'protect-branch': { about: 'Protect the default branch', params: { preset: '"basic" or "strict"' } },
  'unprotect-branch': { about: 'Remove protection from the default branch', params: {} },
  'security-enable': { about: 'Turn on a GitHub security feature', params: { feature: '"alerts", "security-fixes", "secret-scanning", "push-protection", "code-scanning" or "private-reporting"' } },
  'worktree-prune': { about: 'Prune worktrees whose folders are gone', params: {} },
  'repo-edit': { about: 'Edit repository settings', params: { description: 'new description', deleteBranchOnMerge: 'true to auto-delete merged branches' } },
  'repo-archive': { about: 'Archive the repository on GitHub (danger)', params: {} },
  'add-file': { about: 'Add a standard file on the default branch', params: { template: '"license", "readme", "gitignore", "security", "contributing", "conduct", "pr-template", "dependabot" or "ci-node"', commit: 'true to commit it' } },
  'npm-install': { about: 'Install dependencies with the project\'s package manager', params: {} },
  'clean-clutter': { about: 'Move detected clutter to the trash (caches are deleted)', params: { paths: 'array of clutter paths from gutcheck_clutter' } },
  'gitignore-append': { about: 'Append known-safe rules to .gitignore', params: { entries: 'array of rules from a clutter finding' } },
};

// opts: { allowActions: bool, env } . Without allowActions every plan is refused, whatever the app's switch says.
function createEngine(opts = {}) {
  const env = opts.env || process.env;
  const dir = dataDir(env);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const store = createSettingsStore(path.join(dir, 'settings.json'));
  const known = new Map();
  let root = null;
  let scanning = null;
  const allowActions = !!opts.allowActions;
  const settings = () => {
    const s = store.load();
    return { ...s, root: root || s.root, readOnly: !allowActions || !!s.readOnly };
  };
  const trendFile = path.join(dir, 'trend.json');
  const trendStore = {
    read: () => JSON.parse(fs.readFileSync(trendFile, 'utf8')),
    write: (a) => { fs.writeFileSync(trendFile + '.tmp', JSON.stringify(a)); fs.renameSync(trendFile + '.tmp', trendFile); },
  };
  const auditFile = path.join(dir, 'audit.log');
  const service = createService({
    known, settings, audit: (e) => appendAudit(auditFile, { ...e, via: opts.via || 'cli' }),
    rescan: (d) => scanRepo(d, { deep: !!store.load().deep }), trendStore,
    updateSettings: (p) => store.update(p && p.quality ? { quality: p.quality } : {}), // headless callers may only change quality settings
  });

  // Scan a workspace (default: the folder the app last scanned). Concurrent calls share one scan.
  async function scan({ root: r, deep = false, onProgress } = {}) {
    if (scanning) return scanning;
    const want = r || store.load().root;
    if (!want) return { ok: false, error: 'No workspace folder: pass root (for example ~/Projects).' };
    const abs = expandHome(String(want).trim(), os.homedir());
    try { if (!fs.statSync(abs).isDirectory()) throw new Error(); } catch { return { ok: false, error: `Folder does not exist: ${abs}` }; }
    scanning = (async () => {
      const dirs = discover(abs);
      known.clear();
      service.forgetPlans();
      root = abs;
      const results = await scanAll(dirs, { deep: !!deep }, (res, done, total) => { known.set(res.path, res); if (onProgress) onProgress(done, total, res.name); });
      service.recordScan(abs, results);
      if (!store.load().root) store.update({ root: abs }); // remembered for later calls; never replaces the app's own choice
      return { ok: true, root: abs, count: results.length, rate: github.getRate() };
    })();
    try { return await scanning; } finally { scanning = null; }
  }

  // Scan on first use, so a caller never has to know the order of calls.
  const ensure = async ({ onProgress } = {}) => (known.size ? { ok: true, root } : scan({ onProgress }));

  // A repo by name, folder name or path. Ambiguous names list the candidates.
  function resolve(ref) {
    if (typeof ref !== 'string' || !ref.trim()) return { error: 'Name a repo (its name or path).' };
    const abs = path.resolve(expandHome(ref.trim(), os.homedir()));
    if (known.has(abs)) return { repo: known.get(abs) };
    const hits = [...known.values()].filter((r) => r.name.toLowerCase() === ref.trim().toLowerCase() || (r.remote && `${r.remote.owner}/${r.remote.name}`.toLowerCase() === ref.trim().toLowerCase()));
    if (hits.length === 1) return { repo: hits[0] };
    if (hits.length > 1) return { error: `"${ref}" matches several repos: ${hits.map((r) => r.path).join(', ')}. Use the path.` };
    return { error: `No repo "${ref}" in the scanned workspace (${root}). Known: ${[...known.values()].map((r) => r.name).sort().join(', ')}.` };
  }

  const summary = (r) => r.error ? { name: r.name, path: r.path, error: String(r.error) } : {
    name: r.name, path: r.path, grade: r.grade, score: r.score,
    errors: r.findings.filter((f) => f.severity === 'error').length, warnings: r.findings.filter((f) => f.severity === 'warn').length, info: r.findings.filter((f) => f.severity === 'info').length,
    branch: r.git && r.git.branch, dirty: r.git && r.git.dirty, ahead: r.git && r.git.ahead, behind: r.git && r.git.behind,
    remote: r.remote && !r.remote.unreachable ? `${r.remote.owner}/${r.remote.name}` : null,
  };
  const finding = (r, f) => ({ repo: r.name, id: f.id, severity: f.severity, category: f.category, title: f.title, detail: f.detail, url: f.url || undefined, fix: f.fix ? { ...f.fix, label: undefined } : undefined, fixLabel: f.fix ? f.fix.label : undefined });

  async function repos(o = {}) {
    const s = await ensure({ onProgress: o.onProgress });
    if (!s.ok) return s;
    const list = [...known.values()].map(summary).sort((a, b) => (a.score ?? -1) - (b.score ?? -1));
    const ok = list.filter((r) => !r.error);
    return { ok: true, root, count: list.length, averageScore: ok.length ? Math.round(ok.reduce((n, r) => n + r.score, 0) / ok.length) : null, repos: list };
  }

  async function findings({ repo, severity, category, limit = 200, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    let pool = [...known.values()].filter((r) => !r.error);
    if (repo) { const x = resolve(repo); if (x.error) return { ok: false, error: x.error }; pool = [x.repo]; }
    const order = { error: 0, warn: 1, info: 2 };
    let out = pool.flatMap((r) => r.findings.map((f) => finding(r, f)));
    if (severity) out = out.filter((f) => order[f.severity] <= (order[severity] ?? 2)); // "warn" means warn and worse
    if (category) out = out.filter((f) => f.category.toLowerCase() === String(category).toLowerCase());
    out.sort((a, b) => order[a.severity] - order[b.severity]);
    return { ok: true, total: out.length, findings: out.slice(0, Math.max(1, Math.min(1000, limit))), categories: [...new Set(pool.flatMap((r) => r.findings.map((f) => f.category)))].sort() };
  }

  async function repoDetail({ repo, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    const x = resolve(repo);
    if (x.error) return { ok: false, error: x.error };
    const r = x.repo;
    return { ok: true, ...summary(r), git: r.git, prs: r.prs, failedRuns: r.ci && r.ci.failed, findings: (r.findings || []).map((f) => finding(r, f)) };
  }

  async function report({ repo, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    let d;
    if (repo) { const x = resolve(repo); if (x.error) return { ok: false, error: x.error }; d = x.repo.path; }
    return service.reportText(d);
  }

  const dirsOf = (names) => {
    if (!Array.isArray(names) || !names.length) return { dirs: undefined };
    const dirs = [];
    for (const n of names) { const x = resolve(n); if (x.error) return { error: x.error }; dirs.push(x.repo.path); }
    return { dirs };
  };
  async function clutter({ repos: names, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    const d = dirsOf(names);
    return d.error ? { ok: false, error: d.error } : service.clutterScan(d.dirs);
  }
  async function quality({ repos: names, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    const d = dirsOf(names);
    return d.error ? { ok: false, error: d.error } : service.qualityScan(d.dirs);
  }
  async function workspace({ onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    return { ok: true, root, advice: (await service.wsAdvice(root)) || [] };
  }

  // items: [{ repo, action: { type, ...params } } | { repo, finding: '<finding id>', params? }]. A finding id
  // uses that finding's own suggested fix, so a caller can go straight from a finding to its plan.
  async function plan({ items, onProgress } = {}) {
    if (!allowActions) return { ok: false, error: OFF };
    if (store.load().readOnly) return { ok: false, error: 'Read-only mode is on in the GutCheck app. The user can turn it off in the app header.' };
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Pass items: [{ repo, action: { type, ... } } or { repo, finding }].' };
    const resolved = [];
    const errors = [];
    for (const it of items.slice(0, 200)) {
      const x = resolve(it && it.repo);
      if (x.error) { errors.push({ ok: false, error: x.error }); continue; }
      let action = it.action;
      if (!action && it.finding) {
        const f = (x.repo.findings || []).find((y) => y.id === it.finding);
        if (!f) { errors.push({ ok: false, repoName: x.repo.name, error: `No finding "${it.finding}" in ${x.repo.name}.` }); continue; }
        if (!f.fix) { errors.push({ ok: false, repoName: x.repo.name, error: `Finding "${it.finding}" has no automatic fix. Follow its detail or the report's steps.` }); continue; }
        const { label, ...fix } = f.fix;
        action = { ...fix, ...(it.params && typeof it.params === 'object' ? it.params : {}), type: fix.type }; // params fill in what the fix needs (a commit message...)
      }
      resolved.push({ dir: x.repo.path, action });
    }
    const plans = resolved.length ? await service.planActions(resolved) : [];
    return { ok: true, plans: [...plans.map((p) => (p.ok ? { ok: true, token: p.token, repo: p.repoName, title: p.title, risk: p.risk, commands: p.display.map((d) => d.text), warnings: p.warnings, undo: p.undo, note: p.note, confirmName: p.confirmName } : p)), ...errors] };
  }

  // Only plans returned by plan() can run. Danger plans need confirm: { <token>: '<repo name>' }.
  async function apply({ tokens, confirm = {} } = {}) {
    if (!allowActions) return { ok: false, error: OFF };
    if (!Array.isArray(tokens) || !tokens.length) return { ok: false, error: 'Pass tokens from gutcheck_plan.' };
    const res = await service.applyActions(tokens, { confirm });
    return { ok: res.every((r) => r.ok), results: res.map((r) => ({ ok: r.ok, repo: r.repoName, title: r.title, error: r.error, steps: (r.results || []).map((x) => ({ cmd: x.text, ok: x.ok, output: x.out || undefined })) })) };
  }

  const history = ({ limit = 50 } = {}) => ({ ok: true, entries: readAudit(auditFile, Math.max(1, Math.min(500, limit))) });

  return { scan, repos, findings, repoDetail, report, clutter, quality, workspace, plan, apply, history, actions: () => ({ ok: true, actions: ACTION_CATALOG }), dataDir: dir, allowActions };
}

module.exports = { createEngine, dataDir, ACTION_CATALOG };
