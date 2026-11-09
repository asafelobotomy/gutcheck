// Headless GutCheck: the same scans, report and actions as the app, for the command line and the
// MCP server. It shares the app's data folder, so Read-only mode, quality settings, the action
// history and trend snapshots are the same ones the app shows.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('./service');
const { createSettingsStore } = require('./settings');
const { appendAudit, readAudit } = require('./audit');
const { expandHome } = require('./util');
const { createWorkspaceScanner } = require('./workspace-scan');
const { createPolicyStore, driftReport, repoKey } = require('./policy');
const { createSeenStore } = require('./schedule');
const FixAll = require('./renderer/fix-all');
const { createSecretsCtl } = require('./secrets-ctl');
const { engineSecrets, SECRET_TYPES, MCP_REFUSAL } = require('./secrets-glue');

const OFF = 'Actions are turned off: start GutCheck with --allow-actions to plan and apply changes. Everything else works read-only.';

const { dataDir } = require('./paths');

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
  'protect-branch': { about: 'Protect the default branch', params: { preset: '"minimal" (no force-push or deletion, direct pushes allowed), "basic" (PR required) or "strict"' } },
  'unprotect-branch': { about: 'Remove protection from the default branch', params: {} },
  'security-enable': { about: 'Turn on a GitHub security feature', params: { feature: '"alerts", "security-fixes", "secret-scanning", "push-protection", "code-scanning" or "private-reporting"' } },
  'worktree-prune': { about: 'Prune worktrees whose folders are gone', params: {} },
  'repo-edit': { about: 'Edit repository settings', params: { description: 'new description', deleteBranchOnMerge: 'true to auto-delete merged branches' } },
  'repo-archive': { about: 'Archive the repository on GitHub (danger)', params: {} },
  'add-file': { about: 'Add a standard file on the default branch', params: { template: '"license", "readme", "gitignore", "security", "contributing", "conduct", "pr-template", "dependabot" or "ci-node"', commit: 'true to commit it' } },
  'npm-install': { about: 'Install dependencies with the project\'s package manager', params: {} },
  'clean-clutter': { about: 'Move detected clutter to the trash (caches are deleted)', params: { paths: 'array of clutter paths from gutcheck_clutter' } },
  'tests-run': { about: 'Run the tests with coverage, or mutation testing (runs the project\'s own code; dangerous, needs the repo name)', params: { kind: '"coverage" or "mutation"', stack: 'optional: "rust", "python", "node" or "go" (from gutcheck_tests runnable)', root: 'optional: the stack\'s folder, e.g. "wizard"' } },
  'gitignore-append': { about: 'Append known-safe rules to .gitignore', params: { entries: 'array of rules from a clutter finding' } },
  'permissions-prune': { about: 'Remove permission rules from .claude/settings.local.json (shown redacted, backed up outside the repo)', params: { hashes: 'array of rule hashes from an AI agents finding' } },
  'split-instructions': { about: 'Move the largest sections of an instruction file into docs/agents/ with pointers (every line kept)', params: { file: '"CLAUDE.md", ".claude/CLAUDE.md" or "AGENTS.md"' } },
  'lsp-setup': { about: 'Install or turn on a Claude Code LSP plugin and its language server', params: { plugin: 'plugin name from an AI agents finding, e.g. "rust-analyzer-lsp"' } },
};

// opts: { allowActions: bool, env } . Without allowActions every plan is refused, whatever the app's switch says.
function createEngine(opts = {}) {
  const env = opts.env || process.env;
  const dir = dataDir(env);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const store = createSettingsStore(path.join(dir, 'settings.json'));
  const known = new Map();
  const allowActions = !!opts.allowActions;
  let ws = null; // the shared workspace scanner, made once the service exists
  const settings = () => {
    const s = store.load();
    return { ...s, root: (ws && ws.root()) || s.root, readOnly: !allowActions || !!s.readOnly };
  };
  const trendFile = path.join(dir, 'trend.json');
  const trendStore = {
    read: () => JSON.parse(fs.readFileSync(trendFile, 'utf8')),
    write: (a) => { fs.writeFileSync(trendFile + '.tmp', JSON.stringify(a)); fs.renameSync(trendFile + '.tmp', trendFile); },
  };
  const auditFile = path.join(dir, 'audit.log');
  const policy = createPolicyStore(dir);
  const seen = createSeenStore(path.join(dir, 'seen.json'));
  // Machine-level agent fixes (plugins, MCP servers, skills, stale config) plan and apply through
  // agent-connect.js; their tokens carry an "a:" prefix so apply() can route them.
  let agc = null;
  const agentsCtl = () => (agc = agc || require('./agent-connect').createAgentConnect({ env, launch: { dataDir: dir }, audit: (e) => appendAudit(auditFile, { ...e, via: opts.via || 'cli' }) }));
  const service = createService({
    known, settings, audit: (e) => appendAudit(auditFile, { ...e, via: opts.via || 'cli' }),
    rescan: async (d) => (await ws.refresh(d)) || known.get(d), trendStore,
    updateSettings: (p) => store.update(p && p.quality ? { quality: p.quality } : {}), // headless callers may only change quality settings
    // The secrets controller links nothing from here (the app does); it reads the vault setting, backs up and verifies.
    secretsCtl: createSecretsCtl({ dataDir: dir, settings: store, env, home: env.HOME || os.homedir(), audit: (e) => appendAudit(auditFile, { ...e, via: opts.via || 'cli' }) }),
  });

  ws = createWorkspaceScanner({ known, service, policy: policy.load, seen });
  const root = () => ws.root();
  const via = opts.via || 'cli';
  // Secret files: a read for everyone; backup, verify and skip for the CLI only (MCP is refused).
  const secrets = engineSecrets({ service, via, readOnly: () => !!store.load().readOnly, ensure: (o) => ensure(o) });

  // Scan a workspace (default: the folder last scanned from the command line or MCP, else the app's).
  // Concurrent calls for the same folder share one scan; another folder waits for it, then scans.
  // recordSeen: compare with the stored findings and store these (only `new` does; other commands
  // must not use up the "new since last scan" baseline).
  async function scan({ root: r, deep = false, recordSeen = false, onProgress } = {}) {
    const s = store.load();
    const out = await ws.scan({ root: r || s.cliRoot || s.root || '', deep, recordSeen, onProgress });
    if (out.ok && out.root !== s.cliRoot) store.update({ cliRoot: out.root }); // never replaces the app's own folder
    return out;
  }

  // Scan on first use, so a caller never has to know the order of calls. A scan in flight is waited
  // for, so parallel calls never read a half-filled workspace.
  const ensure = async ({ onProgress } = {}) => {
    await ws.settled();
    return known.size ? { ok: true, root: root() } : scan({ onProgress });
  };

  // A repo by name, folder name or path. Ambiguous names list the candidates.
  function resolve(ref) {
    if (typeof ref !== 'string' || !ref.trim()) return { error: 'Name a repo (its name or path).' };
    const abs = path.resolve(expandHome(ref.trim(), os.homedir()));
    if (known.has(abs)) return { repo: known.get(abs) };
    const hits = [...known.values()].filter((r) => r.name.toLowerCase() === ref.trim().toLowerCase() || (r.remote && `${r.remote.owner}/${r.remote.name}`.toLowerCase() === ref.trim().toLowerCase()));
    if (hits.length === 1) return { repo: hits[0] };
    if (hits.length > 1) return { error: `"${ref}" matches several repos: ${hits.map((r) => r.path).join(', ')}. Use the path.` };
    return { error: `No repo "${ref}" in the scanned workspace (${root()}). Known: ${[...known.values()].map((r) => r.name).sort().join(', ')}.` };
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
    return { ok: true, root: root(), count: list.length, averageScore: ok.length ? Math.round(ok.reduce((n, r) => n + r.score, 0) / ok.length) : null, repos: list };
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
    return { ok: true, ...summary(r), git: r.git, prs: r.prs, failedRuns: r.ci && r.ci.failed, findings: (r.findings || []).map((f) => finding(r, f)), ignored: (r.ignored || []).map((f) => ({ id: f.id, title: f.title, reason: f.ignoredBecause, from: f.ignoredIn })), drift: r.drift || undefined };
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
  async function tests({ repos: names, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    const d = dirsOf(names);
    return d.error ? { ok: false, error: d.error } : service.testsScan(d.dirs);
  }
  async function workspace({ onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    return { ok: true, root: root(), advice: (await service.wsAdvice(root())) || [] };
  }

  // items: [{ repo, action: { type, ...params } } | { repo, finding: '<finding id>', params? }]. A finding id
  // uses that finding's own suggested fix, so a caller can go straight from a finding to its plan.
  async function plan({ items, onProgress } = {}) {
    if (!allowActions) return { ok: false, error: OFF };
    if (store.load().readOnly) return { ok: false, error: 'Read-only mode is on in the GutCheck app. The user can turn it off in the app header.' };
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Pass items: [{ repo, action: { type, ... } } or { repo, finding }].' };
    if (via === 'mcp' && items.some((it) => it && (it.secretBackup !== undefined || SECRET_TYPES.has(it.action && it.action.type)))) return { ok: false, error: MCP_REFUSAL };
    const resolved = [];
    const errors = [];
    const decisions = [];
    for (const it of items.slice(0, 200)) {
      // { agentFix }: a machine-level fix from gutcheck_agent_usage or the workspace advice.
      if (it && it.agentFix && typeof it.agentFix === 'object') {
        const p = agentsCtl().planFix(it.agentFix, [...known.values()].filter((r) => !r.error));
        errors.push(p.ok ? { ok: true, token: 'a:' + p.token, repo: 'Agent setup', title: p.title, risk: p.risk || 'caution', commands: p.display, note: p.note } : { ok: false, repoName: 'Agent setup', error: p.error });
        continue;
      }
      if (it && it.secretBackup !== undefined) { // { secretBackup: [paths] }: the CLI's own backup preview
        const p = await secrets.plan(it.secretBackup);
        errors.push(p.ok ? { ok: true, token: p.token, repo: 'Secrets', title: p.title, risk: p.risk, commands: p.display.map((d) => d.text), note: p.note } : { ok: false, repoName: 'Secrets', error: p.error });
        continue;
      }
      const x = resolve(it && it.repo);
      if (x.error) { errors.push({ ok: false, error: x.error }); continue; }
      // { repo, all: true, answers? }: every automatic fix in run order, plus the owner's answers to the
      // decisions (answers: { "<finding id>": { choice: n, values: { message: "..." } } }). Unanswered
      // decisions come back in `decisions` for the agent to ask the user.
      if (it.all) {
        const fa = FixAll.plan(x.repo);
        const given = it.answers && typeof it.answers === 'object' ? it.answers : {};
        const answers = fa.decisions.map((d) => {
          const a = given[d.id];
          const c = a && d.choices[a.choice];
          return c && c.action ? { action: { ...c.action, ...(a.values && typeof a.values === 'object' ? a.values : {}) }, sev: (x.repo.findings.find((f) => f.id === d.id) || {}).severity } : null;
        });
        for (const action of FixAll.order(x.repo, fa.actions, answers).actions) resolved.push({ dir: x.repo.path, action, all: true });
        const open = fa.decisions.filter((_, k) => !answers[k]);
        if (open.length) decisions.push({ repo: x.repo.name, decisions: open.map((d) => ({ finding: d.id, title: d.title, choices: d.choices.map((c, k) => ({ choice: k, label: c.label, fields: c.fields && c.fields.map((f) => f.name) })) })) });
        continue;
      }
      let action = it.action;
      if (!action && it.finding) {
        const f = (x.repo.findings || []).find((y) => y.id === it.finding);
        if (!f) { errors.push({ ok: false, repoName: x.repo.name, error: `No finding "${it.finding}" in ${x.repo.name}.` }); continue; }
        if (f.fix && SECRET_TYPES.has(f.fix.type)) { errors.push({ ok: false, repoName: x.repo.name, error: via === 'mcp' ? MCP_REFUSAL : 'Back up secret files with gutcheck secrets --backup.' }); continue; }
        if (!f.fix) { errors.push({ ok: false, repoName: x.repo.name, error: `Finding "${it.finding}" has no automatic fix. Follow its detail or the report's steps.` }); continue; }
        const { label, ...fix } = f.fix;
        action = { ...fix, ...(it.params && typeof it.params === 'object' ? it.params : {}), type: fix.type }; // params fill in what the fix needs (a commit message...)
      }
      resolved.push({ dir: x.repo.path, action });
    }
    const plans = resolved.length ? await service.planActions(resolved.map(({ dir, action }) => ({ dir, action }))) : [];
    const pub = (p) => (p.ok ? { ok: true, token: p.token, repo: p.repoName, title: p.title, risk: p.risk, commands: p.display.map((d) => d.text), warnings: p.warnings, undo: p.undo, note: p.note, confirmName: p.confirmName, ...(p.runsRepoCode ? { runsRepoCode: true } : {}) } : p);
    // Fix all never runs the repo's own hooks or drivers on its own: those plans come back in `held`,
    // without a token, so a caller cannot apply them from this answer. Planning the one action
    // explicitly ({ repo, action }) still returns a token, with the warning.
    const isHeld = (p, k) => resolved[k].all && p.ok && !FixAll.automatic(p);
    const held = plans.filter(isHeld).map((p) => { const { token, ...rest } = pub(p); return { ...rest, note: 'This runs the repo\'s own code: ask the user to run this in the GutCheck app or CLI.' }; });
    return { ok: true, plans: [...plans.filter((p, k) => !isHeld(p, k)).map(pub), ...errors], ...(held.length ? { held } : {}), ...(decisions.length ? { decisions } : {}) };
  }

  // Only plans returned by plan() can run. Danger plans need confirm: { <token>: '<repo name>' }.
  async function apply({ tokens, confirm = {} } = {}) {
    if (!allowActions) return { ok: false, error: OFF };
    if (!Array.isArray(tokens) || !tokens.length) return { ok: false, error: 'Pass tokens from gutcheck_plan.' };
    const res = [];
    const failed = new Set(); // a failed plan stops the later ones for the same repo
    const startedAt = Date.now(); // plans fresh now stay valid for the whole batch
    for (const t of tokens) {
      if (typeof t === 'string' && t.startsWith('s:')) res.push({ title: 'Back up secret files', ...(await secrets.apply(t)), repoName: 'Secrets' });
      else if (typeof t === 'string' && t.startsWith('a:')) { const r = store.load().readOnly ? { ok: false, error: 'Read-only mode is on in the GutCheck app.' } : await agentsCtl().apply(t.slice(2)); res.push({ ...r, repoName: 'Agent setup' }); } else res.push(...(await service.applyActions([t], { confirm, failed, startedAt })));
    }
    return { ok: res.every((r) => r.ok), results: res.map((r) => ({ ok: r.ok, ...(r.skipped ? { skipped: true } : {}), repo: r.repoName, title: r.title, error: r.error, steps: (r.results || []).map((x) => ({ cmd: x.text, ok: x.ok, output: x.out || undefined })) })) };
  }

  // Findings that were not there at the previous scan of this workspace (stored ids only).
  async function fresh({ rescan = false, onProgress } = {}) {
    const s = rescan ? await scan({ root: root() || undefined, deep: ws.deep(), recordSeen: true, onProgress }) : await ensure({ onProgress });
    if (!s.ok) return s;
    const f = ws.lastFresh();
    return { ok: true, root: root(), compared: f != null, findings: f || [] };
  }

  // Ignore a finding with a reason (or stop ignoring it). Stored in GutCheck's data folder, logged.
  async function ignore({ repo, finding, reason, remove = false, allRepos = false, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    let key = '*';
    let r = null;
    if (!allRepos) { const x = resolve(repo); if (x.error) return { ok: false, error: x.error }; r = x.repo; key = repoKey(r); }
    const res = remove ? policy.removeIgnore(key, String(finding || '')) : policy.setIgnore(key, String(finding || ''), reason);
    if (!res.ok) return res;
    appendAudit(auditFile, { ok: true, repo: r ? r.name : 'all repos', title: `${remove ? 'Stopped ignoring' : 'Ignored'} ${finding}${remove ? '' : `: ${res.reason}`}`, via: opts.via || 'cli' });
    if (r) await ws.refresh(r.path); else await ws.refreshAll(); // an ignore for every repo changes them all
    return { ...res, file: policy.ignoreFile };
  }

  async function ignored({ onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    return { ok: true, file: policy.ignoreFile, findings: [...known.values()].flatMap((r) => (r.ignored || []).map((f) => ({ repo: r.name, id: f.id, title: f.title, reason: f.ignoredBecause, from: f.ignoredIn, rule: f.ignoreRule }))) };
  }

  // Baseline drift: per rule, the repos that do not meet it. init writes a starting baseline.json.
  async function drift({ init = false, onProgress } = {}) {
    if (init) { const i = policy.initBaseline(); await ws.refreshAll(); return { ok: true, file: i.file, created: i.created }; }
    const b = policy.load().baseline;
    if (!b) return { ok: true, file: policy.baselineFile, baseline: null, note: `No baseline yet. Run "gutcheck baseline init" (or pass init: true) to create ${policy.baselineFile}, then edit it.` };
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    const results = [...known.values()];
    return { ok: true, file: policy.baselineFile, rules: driftReport(results, b), repos: results.filter((r) => r.drift).map((r) => ({ name: r.name, missing: r.drift.failed.map((f) => f.id), passed: r.drift.passed, checked: r.drift.checked })).sort((a, b2) => b2.missing.length - a.missing.length) };
  }

  // Opt-in agent usage check: reads transcript tool names; live (the caller's explicit consent) also
  // runs `claude mcp list`, which starts every configured MCP server once. Recorded in History.
  async function agentUsage({ live = false, onProgress } = {}) {
    const s = await ensure({ onProgress });
    if (!s.ok) return s;
    const { scanUsage } = require('./agent-usage');
    const bin = require('./agent-connect').claudeBin();
    const ro = live && !!store.load().readOnly; // Read-only mode turns the live check off, as in the app
    live = live && !ro;
    const r = await scanUsage({ repos: [...known.values()].filter((x) => !x.error).map((x) => ({ path: x.path, name: x.name })), live: live && !!bin, bin, runner: require('./exec').run });
    if (live && bin) appendAudit(auditFile, { ok: true, repo: 'Agent setup', title: `Started ${(r.servers || []).length} MCP servers to check them (claude mcp list)`, via: opts.via || 'cli' });
    return { ok: true, ...r, note: ro ? 'Read-only mode is on in the GutCheck app, so servers were not started.' : live && !bin ? 'Claude Code was not found, so servers were not checked.' : undefined };
  }

  const history = ({ limit = 50 } = {}) => ({ ok: true, entries: readAudit(auditFile, Math.max(1, Math.min(500, limit))) });

  return { scan, repos, findings, repoDetail, report, clutter, quality, tests, workspace, plan, apply, history, fresh, ignore, ignored, drift, agentUsage, secrets: secrets.list, secretsPlan: secrets.plan, secretsApply: secrets.apply, secretsVerify: secrets.verify, secretsSkip: secrets.skip, actions: () => ({ ok: true, actions: ACTION_CATALOG }), dataDir: dir, allowActions };
}

module.exports = { createEngine, dataDir, ACTION_CATALOG };
