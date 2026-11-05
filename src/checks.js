// Pure health-check functions: take a collected repo snapshot, return findings.
// Finding: { id, category, severity: 'error'|'warn'|'info', title, detail, fix? }
// `fix` is an optional action descriptor the UI can offer as a button.

const { daysAgo, DAYS_PER_YEAR } = require('./util');
const { checkWorkflows, checkGitHygiene, checkProject, checkSecurityFeatures } = require('./checks-hygiene');

const { STALE_BRANCH_DAYS } = require('./renderer/metrics'); // one value for findings and the dashboard

const STALE_PR_DAYS = 30;
// Local branches that are not current, not merged and untouched for STALE_BRANCH_DAYS (shared with report.js).
const staleBranches = (g) => (g.branches || []).filter((b) => !b.current && daysAgo(b.date) >= STALE_BRANCH_DAYS && !(g.mergedBranches || []).includes(b.name));

function checkCI(s) {
  const out = [];
  if (!s.remote) return out;
  if (s.ci.error) return [{ id: 'ci-unavailable', category: 'CI', severity: 'info', title: 'CI status unavailable', detail: s.ci.error }];
  if (!s.hasWorkflows) {
    out.push({ id: 'ci-none', category: 'CI', severity: 'info', title: 'No GitHub Actions workflows', detail: 'Add a workflow in .github/workflows to run tests on every push.', fix: s.deps && s.deps.manifests && s.deps.manifests.includes('package.json') ? { type: 'add-file', label: 'Add Node CI workflow', template: 'ci-node' } : undefined });
    return out;
  }
  for (const r of s.ci.failed) {
    out.push({
      id: 'ci-failed-' + r.databaseId,
      category: 'CI',
      severity: 'error',
      title: `Failed: ${r.workflowName} on ${r.headBranch}`,
      detail: `${r.displayTitle} (${daysAgo(r.createdAt)}d ago)`,
      url: r.url,
      fix: { type: 'run-rerun', label: 'Re-run failed jobs', runId: r.databaseId, failedOnly: true },
    });
  }
  return out;
}

function checkPRs(s) {
  const out = [];
  for (const pr of s.prs) {
    const age = daysAgo(pr.updatedAt);
    if (pr.mergeable === 'CONFLICTING')
      out.push({ id: 'pr-conflict-' + pr.number, category: 'PRs', severity: 'error', title: `PR #${pr.number} has merge conflicts`, detail: pr.title, url: pr.url });
    if (pr.statusCheckRollup === 'FAILURE')
      out.push({ id: 'pr-ci-' + pr.number, category: 'PRs', severity: 'error', title: `PR #${pr.number} has failing checks`, detail: pr.title, url: pr.url });
    if (age >= STALE_PR_DAYS && !pr.isDraft)
      out.push({ id: 'pr-stale-' + pr.number, category: 'PRs', severity: 'warn', title: `PR #${pr.number} stale for ${age} days`, detail: pr.title, url: pr.url });
    if (pr.reviewDecision === 'APPROVED' && pr.mergeable === 'MERGEABLE' && pr.statusCheckRollup !== 'FAILURE')
      out.push({ id: 'pr-ready-' + pr.number, category: 'PRs', severity: 'info', title: `PR #${pr.number} approved and mergeable`, detail: pr.title, url: pr.url, fix: { type: 'pr-merge', label: 'Merge…', number: pr.number, method: 'squash', deleteBranch: true } });
  }
  return out;
}

function checkBranches(s) {
  const out = [];
  const g = s.git;
  if (g.dirty > 0)
    out.push({ id: 'git-dirty', category: 'Branches', severity: 'warn', title: `${g.dirty} uncommitted change${g.dirty > 1 ? 's' : ''}`, detail: `On branch ${g.branch}`, fix: { type: 'commit-all', label: 'Commit all…' } });
  if (g.ahead > 0)
    out.push({ id: 'git-ahead', category: 'Branches', severity: 'warn', title: `${g.ahead} unpushed commit${g.ahead > 1 ? 's' : ''} on ${g.branch}`, detail: 'Push to back up your work.', fix: { type: 'push', label: 'Push' } });
  if (g.behind > 0)
    out.push({ id: 'git-behind', category: 'Branches', severity: 'info', title: `${g.behind} commit${g.behind > 1 ? 's' : ''} behind upstream`, detail: `${g.branch} can be fast-forwarded.`, fix: { type: 'pull', label: 'Pull (ff-only)' } });
  if (g.branch && !g.upstream && s.remote)
    out.push({ id: 'git-no-upstream', category: 'Branches', severity: 'info', title: `Branch ${g.branch} has no upstream`, detail: 'Not tracking a remote branch.', fix: { type: 'push', label: 'Push & set upstream' } });
  if (g.mergedBranches.length)
    out.push({ id: 'git-merged', category: 'Branches', severity: 'info', title: `${g.mergedBranches.length} local branch${g.mergedBranches.length > 1 ? 'es' : ''} already merged`, detail: g.mergedBranches.join(', '), fix: { type: 'delete-merged', label: 'Delete merged', branches: g.mergedBranches } });
  const stale = staleBranches(g);
  if (stale.length)
    out.push({ id: 'git-stale', category: 'Branches', severity: 'info', title: `${stale.length} stale branch${stale.length > 1 ? 'es' : ''} (${STALE_BRANCH_DAYS}+ days)`, detail: stale.map((b) => b.name).join(', ') });
  if (g.detached) out.push({ id: 'git-detached', category: 'Branches', severity: 'warn', title: 'Detached HEAD', detail: 'Commits here may be lost.' });
  return out;
}

function checkFiles(s) {
  const out = [];
  const f = s.files;
  const add = (id, sev, title, detail, fix) => out.push({ id, category: 'Docs & Licence', severity: sev, title, detail, fix });
  const pub = !!(s.remote && s.remote.isPublic);
  const r = s.remote || {};
  // Public code without a licence cannot legally be reused; for private or local repos it only matters if that changes.
  if (!f.license) add('no-license', pub ? 'error' : 'info', 'Missing LICENSE', pub ? 'Without a licence nobody may legally use, copy or contribute to the code.' : 'Not needed while private, but add one before you share it.', { type: 'add-file', label: 'Add MIT licence', template: 'license' });
  if (!f.readme) add('no-readme', 'error', 'Missing README', 'Describe what the project is and how to run it.', { type: 'add-file', label: 'Create README', template: 'readme' });
  if (!f.gitignore) add('no-gitignore', 'warn', 'Missing .gitignore', 'Build output and secrets may get committed.', { type: 'add-file', label: 'Create .gitignore', template: 'gitignore' });
  // GitHub also counts defaults from the owner's .github repository (the remote.* flags include those).
  if (pub && !r.isFork) {
    if (!f.security && !r.securityPolicy) add('no-security', 'warn', 'No security policy', 'Tell people how to report vulnerabilities privately (SECURITY.md).', { type: 'add-file', label: 'Add SECURITY.md', template: 'security' });
    if (!f.contributing && !r.contributing) add('no-contributing', 'info', 'Missing CONTRIBUTING.md', 'Explain how to contribute.', { type: 'add-file', label: 'Add CONTRIBUTING.md', template: 'contributing' });
    if (!f.codeOfConduct && !r.codeOfConduct) add('no-coc', 'info', 'Missing CODE_OF_CONDUCT.md', 'Set community expectations.', { type: 'add-file', label: 'Add code of conduct', template: 'conduct' });
  }
  if (s.remote && !f.prTemplate && s.remote.isPublic) add('no-pr-template', 'info', 'No pull request template', 'Add .github/pull_request_template.md.', { type: 'add-file', label: 'Add PR template', template: 'pr-template' });
  if (s.remote && !s.remote.description) add('no-description', 'info', 'Repo has no GitHub description', 'Helps discovery and sets context.', { type: 'repo-edit', label: 'Set description…' });
  return out;
}

function checkDeps(s) {
  const out = [];
  const d = s.deps;
  for (const m of d.manifestsWithoutLock)
    out.push({ id: 'no-lock-' + m, category: 'Dependencies', severity: 'warn', title: `${m}: no lockfile`, detail: 'Builds are not reproducible without a lockfile.' });
  if (d.needsInstall)
    out.push({ id: 'deps-not-installed', category: 'Dependencies', severity: 'warn', title: 'Dependencies not installed', detail: 'node_modules is missing.', fix: { type: 'npm-install', label: (d.installer || ['npm', 'install']).join(' ') } });
  if (d.outdated != null && d.outdated > 0)
    out.push({ id: 'deps-outdated', category: 'Dependencies', severity: 'warn', title: `${d.outdated} outdated npm package${d.outdated > 1 ? 's' : ''}`, detail: d.outdatedNames.slice(0, 8).join(', ') });
  if (s.remote && s.remote.alertsEnabled === false)
    out.push({ id: 'alerts-off', category: 'Dependencies', severity: 'warn', title: 'Dependabot alerts are disabled', detail: 'You will not be told about vulnerable dependencies.', fix: { type: 'security-enable', label: 'Enable alerts', feature: 'alerts' } });
  if (d.manifests && d.manifests.length && !s.files.dependabotConfig)
    out.push({ id: 'no-dependabot-config', category: 'Dependencies', severity: 'info', title: 'No Dependabot update config', detail: 'Automatic dependency update PRs are not set up.', fix: { type: 'add-file', label: 'Add dependabot.yml', template: 'dependabot' } });
  if (s.alerts && s.alerts.length) {
    const crit = s.alerts.filter((a) => ['critical', 'high'].includes(a.severity)).length;
    out.push({ id: 'dependabot', category: 'Dependencies', severity: crit ? 'error' : 'warn', title: `${s.alerts.length} open Dependabot alert${s.alerts.length > 1 ? 's' : ''}`, detail: `${crit} high/critical`, url: s.remote.url + '/security/dependabot' });
  }
  return out;
}

function checkRepoSettings(s) {
  const out = [];
  if (!s.remote) {
    out.push({ id: 'no-remote', category: 'Repo', severity: 'warn', title: 'No GitHub remote', detail: 'Local only. Not backed up.' });
    return out;
  }
  if (s.remote.archived) out.push({ id: 'archived', category: 'Repo', severity: 'info', title: 'Repository is archived', detail: 'Read-only on GitHub.' });
  if (s.protection === false && !s.remote.archived)
    out.push({ id: 'no-protection', category: 'Repo', severity: s.remote.isPublic ? 'warn' : 'info', title: `Default branch ${s.remote.defaultBranch} is unprotected`, detail: 'No branch protection rule or active ruleset. At minimum block force-pushes and deletion; ideally require PRs and status checks.', fix: { type: 'protect-branch', label: 'Protect…', preset: 'basic' } });
  if (s.remote.deleteBranchOnMerge === false && !s.remote.archived && s.remote.viewerPermission === 'ADMIN')
    out.push({ id: 'no-auto-delete', category: 'Repo', severity: 'info', title: 'Merged branches are not deleted automatically', detail: 'Head branches pile up after every merged PR.', fix: { type: 'repo-edit', label: 'Turn on auto-delete…', deleteBranchOnMerge: true } });
  if (s.remote.openIssues > 25) out.push({ id: 'many-issues', category: 'Repo', severity: 'info', title: `${s.remote.openIssues} open issues/PRs`, detail: 'Consider triaging.' });
  const pushed = daysAgo(s.remote.pushedAt);
  if (pushed != null && pushed > DAYS_PER_YEAR && !s.remote.archived) out.push({ id: 'inactive', category: 'Repo', severity: 'info', title: `No pushes in ${pushed} days`, detail: 'Archive it if it is finished.' });
  return out;
}

const WEIGHT = { error: 15, warn: 5, info: 1 };

function evaluate(snapshot) {
  const findings = [...checkCI(snapshot), ...checkPRs(snapshot), ...checkBranches(snapshot), ...checkFiles(snapshot), ...checkDeps(snapshot), ...checkRepoSettings(snapshot),
    ...checkWorkflows(snapshot), ...checkGitHygiene(snapshot), ...checkProject(snapshot), ...checkSecurityFeatures(snapshot)];
  const penalty = findings.reduce((n, f) => n + WEIGHT[f.severity], 0);
  const score = Math.max(0, 100 - penalty);
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, score, grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : 'D' };
}

module.exports = { STALE_PR_DAYS, STALE_BRANCH_DAYS, staleBranches, evaluate, checkPRs, checkFiles, checkDeps, checkRepoSettings };
