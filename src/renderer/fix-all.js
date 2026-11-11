// "Fix all issues" for one repo. Shared by the page (global `FixAll`), the CLI and the MCP server; no DOM.
//
// - Automatic fixes need no decision and go straight into the plan.
// - Decisions are fixes only the owner can choose (a commit message, merging a PR, running install
//   scripts...). The app asks them in a short wizard; each answer is an action or "leave it".
// - order() sorts the chosen actions by coding priority: sync, save work, dependencies, files, local
//   cleanup, push, then changes on GitHub, and test runs last. Severity breaks ties within a step.
(function (root) {
  const SEV = { error: 0, warn: 1, info: 2 };

  // Run order. Pull before anything commits (a fast-forward needs no local commits); the owner's own
  // work is committed before GutCheck adds files; push sends all of it; GitHub-side changes come after
  // the code is up there; test runs execute the project's code, so they go last.
  // .gitignore rules come before the owner's commit, so caches, build output and .env files they
  // cover are not committed with it.
  const STEP = {
    pull: 0, 'gitignore-append': 1, 'commit-all': 2, 'npm-install': 3, 'add-file': 4,
    'delete-merged': 5, 'worktree-prune': 5, push: 6,
    'split-instructions': 4, 'permissions-prune': 5,
    'run-rerun': 7, 'pr-close': 8, 'pr-merge': 8, 'pr-create': 8, 'delete-remote': 9, 'repo-edit': 9, 'security-enable': 9, 'protect-branch': 10,
    'lsp-setup': 11, 'tests-run': 12, 'rescue-bundle': -1,
    // An archived repo refuses every other change on GitHub, so archiving comes after all of them.
    'repo-archive': 13,
  };
  const step = (a) => (a.type === 'add-file' && a.template === 'gitignore' ? 1 : STEP[a.type] ?? 9);
  const AUTO = new Set(['add-file', 'run-rerun', 'pull', 'push', 'delete-merged', 'security-enable', 'protect-branch', 'gitignore-append', 'worktree-prune', 'repo-edit', 'permissions-prune']);
  const NOT_HERE = { 'claude-cleanup-days': 'a setting for this machine, not this repo' };
  // Files whose content is the owner's call (which licence, what the README says, who owns the code,
  // which CI): asked in the wizard, never added on their own. A licence starts on "leave it".
  const OWNER_FILES = { license: 1, readme: 0, codeowners: 0, 'ci-node': 0 };

  const leave = (label = 'Leave it for now') => ({ label, action: null });
  // A planned step that runs the repo's own code (its hooks or filter drivers: the plan's
  // runsRepoCode) never runs as part of Fix all on its own. The app shows it unticked; the CLI and
  // MCP return it under `held`, to run only when the owner asks for it.
  const automatic = (p) => !(p && p.runsRepoCode);

  // A finding whose fix needs the owner -> { id, title, detail, choices: [{ label, action, fields? }], pick }.
  // pick: the choice selected at first (code-running choices start on "leave it").
  // remote: the repo is not cloned here, so closing a PR can also delete its branch on GitHub.
  function decision(f, fix, remote = false) {
    const base = { id: f.id, title: f.title, detail: f.detail || '' };
    switch (fix.type) {
      case 'commit-all': return { ...base, pick: 0, choices: [{ label: 'Commit all of it', action: { type: 'commit-all' }, fields: [{ name: 'message', label: 'Commit message', required: true }] }, leave('Leave it uncommitted')] };
      case 'pr-merge': return { ...base, pick: 0, choices: [{ label: 'Squash and merge, then delete the branch', action: { ...fix, method: 'squash', deleteBranch: true } }, { label: 'Merge with a merge commit', action: { ...fix, method: 'merge', deleteBranch: true } }, leave('Leave it open')] };
      case 'pr-close': return { ...base, pick: 0, choices: [{ label: 'Close it', action: fix }, ...(remote ? [{ label: 'Close it and delete its branch on GitHub', action: { ...fix, deleteBranch: true } }] : []), leave('Leave it open')] };
      case 'delete-remote': return { ...base, pick: 0, choices: [{ label: `Delete ${fix.branches.length === 1 ? 'it' : `all ${fix.branches.length}`} on GitHub (each is checked first, and can be restored)`, action: fix }, leave()] };
      // Work not in the default branch: the owner decides whether it becomes a PR or goes.
      case 'pr-create': return { ...base, pick: 2, choices: [{ label: `Open a pull request from ${fix.branch}`, action: fix, fields: [{ name: 'title', label: 'Pull request title', required: true }] }, { label: `Delete ${fix.branch} on GitHub (its commits are lost unless they exist elsewhere)`, action: { type: 'delete-remote', branches: [fix.branch] } }, leave()] };
      case 'repo-edit': return { ...base, pick: 0, choices: [{ label: 'Set a description', action: { type: 'repo-edit' }, fields: [{ name: 'description', label: 'One sentence about the project', required: true }] }, leave('Skip')] };
      case 'npm-install': return { ...base, pick: 1, choices: [{ label: `Run ${fix.label || 'the install'} (runs the packages' install scripts)`, action: { type: 'npm-install' } }, leave('Skip')] };
      case 'split-instructions': return { ...base, pick: 0, choices: [{ label: `Split ${fix.file}: keep the core, move the largest sections to docs/agents/ (every line kept)`, action: fix }, leave()] };
      case 'lsp-setup': return { ...base, pick: 1, choices: [{ label: 'Set it up (installs software)', action: fix }, leave('Skip')] };
      case 'add-file': return { ...base, pick: OWNER_FILES[fix.template] ?? 0, choices: [{ label: `${fix.label || 'Add the file'} and commit it${fix.template === 'license' ? ' (check the licence is the one you want)' : ''}`, action: { ...fix, commit: true } }, leave('Skip')] };
      // Both stay on "leave it": an abort discards conflict resolutions, a register writes the user's global config.
      case 'git-op-abort': return { ...base, pick: 1, choices: [{ label: `${fix.label.replace('…', '')} (discards any conflict resolution done so far)`, action: fix }, leave('Leave it for me to finish')] };
      case 'maintenance-register': return { ...base, pick: 1, choices: [{ label: 'Register it (adds it to maintenance.repo in your global git config)', action: fix }, leave('Skip')] };
      // Pushing is the usual fix; a rescue copy is offered but never picked for the owner.
      case 'rescue-bundle': return { ...base, pick: 1, choices: [{ label: 'Save a rescue copy outside the workspace (the repo is not changed)', action: fix }, leave('Skip')] };
      case 'repo-archive': return { ...base, pick: 1, choices: [{ label: 'Archive it (read-only on GitHub until you unarchive it)', action: fix }, leave('Leave it')] };
      case 'tests-run': return { ...base, pick: 1, choices: [{ label: 'Run it (executes the project\'s code)', action: fix }, leave('Skip')] };
      default: return { ...base, pick: 0, choices: [{ label: fix.label || 'Do it', action: fix }, leave()] };
    }
  }

  // Repos that are on GitHub but not cloned here: only fixes made through the GitHub API run on them
  // (gh names the repo, so no folder is needed). Fixes that change files or local git need a clone.
  const API_ACTIONS = new Set(['pr-merge', 'pr-close', 'pr-ready', 'run-rerun', 'protect-branch', 'protect-tags', 'actions-settings', 'security-enable', 'repo-edit', 'repo-archive', 'pr-create', 'delete-remote']);
  const REMOTE_FILE_FIX = 'This fix changes files or local git, and the repo is not cloned in this workspace. Clone it to fix this; fixes as pull requests come in a later version.';
  const REMOTE_NOTE = 'Not cloned in this workspace: GitHub fixes (pull requests, CI, protection, security and repository settings) run here; fixes that change files need a clone for now.';
  const REMOTE_SKIP = 'changes files; the repo is not cloned here';

  // r: a scan result. -> { actions (automatic), decisions, skipped: [{ id, title, reason }] }
  function plan(r) {
    const remote = !!r && r.source === 'remote';
    const actions = [];
    const decisions = [];
    const skipped = [];
    const seen = new Set();
    const findings = [...((r && r.findings) || [])].sort((a, b) => SEV[a.severity] - SEV[b.severity]);
    for (const f of findings) {
      if (!f.fix) continue;
      const { label, ...fix } = f.fix;
      if (NOT_HERE[fix.type]) { skipped.push({ id: f.id, title: f.title, reason: NOT_HERE[fix.type] }); continue; }
      if (remote && !API_ACTIONS.has(fix.type)) { skipped.push({ id: f.id, title: f.title, reason: REMOTE_SKIP }); continue; }
      const auto = AUTO.has(fix.type) && !(fix.type === 'repo-edit' && fix.deleteBranchOnMerge !== true) && !(fix.type === 'add-file' && fix.template in OWNER_FILES);
      if (!auto) { decisions.push(decision(f, f.fix, remote)); continue; }
      const action = fix.type === 'add-file' ? { ...fix, commit: true } : fix; // each added file is its own commit
      const key = JSON.stringify(action);
      if (!seen.has(key)) { seen.add(key); actions.push({ ...action, sev: f.severity }); }
    }
    return { actions, decisions, skipped };
  }

  // Automatic actions plus the owner's answers -> one list in run order (and a final push when
  // anything was committed). answers: [{ action, sev }]. Returns { actions, note }.
  function order(r, auto, answers = []) {
    const all = [...auto, ...answers.filter((a) => a && a.action).map((a) => ({ ...a.action, sev: a.sev || 'info' }))];
    const g = (r && r.git) || {};
    const commits = all.some((a) => (a.type === 'add-file' && a.commit) || a.type === 'commit-all');
    if (commits && !all.some((a) => a.type === 'push') && r.remote && !r.remote.unreachable && g.branch && !g.detached) all.push({ type: 'push', sev: 'warn' });
    const sorted = all.map((a, i) => ({ a, i })).sort((x, y) => step(x.a) - step(y.a) || SEV[x.a.sev] - SEV[y.a.sev] || x.i - y.i).map(({ a }) => { const { sev, ...rest } = a; return rest; });
    // .gitignore rules appended just before the owner's commit change .gitignore itself.
    const gi = sorted.findIndex((a) => a.type === 'gitignore-append');
    const ci = sorted.findIndex((a) => a.type === 'commit-all');
    if (gi >= 0 && ci > gi) sorted[ci] = { ...sorted[ci], afterGitignore: true };
    const def = r && r.remote && r.remote.defaultBranch;
    const note = commits && def && g.branch && g.branch !== def ? `You are on ${g.branch}, not ${def}: commits go to ${g.branch}.` : null;
    return { actions: sorted, note };
  }

  const api = { plan, order, decision, automatic, STEP, AUTO, API_ACTIONS, REMOTE_FILE_FIX, REMOTE_NOTE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FixAll = api;
})(typeof window !== 'undefined' ? window : globalThis);
