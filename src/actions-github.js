// GitHub-side actions: pull requests, CI re-runs, branch protection, security features and repository
// settings. Built with actions.js's own step builders and plan errors, so plans read the same.
const { PROTECTION } = require('./protection');
const { tagProtection, releaseTag, RULESET_NAME } = require('./repo-rules');
const { isMerged } = require('./remote-branches');

const MAX_DELETE = 30;
// A branch name in an API path: each segment URL-encoded ("fix#1" -> "fix%231"), slashes kept.
const enc = (b) => b.split('/').map(encodeURIComponent).join('/');

module.exports = ({ fail, gh, needRemote, defaultBranch, localBranch, cleanText, readGh }) => {
  // Branches of a repo that is not cloned here come from GitHub (remote-branches.js), not from git.
  const ghBranch = (r, name) => {
    if (!Array.isArray(r.ghBranches)) fail('GutCheck could not read this repository\'s branches from GitHub. Rescan and try again.');
    return r.ghBranches.find((b) => b.name === name) || fail(`"${cleanText(String(name), 60)}" is not a branch on GitHub in the last scan.`);
  };
  // Delete through the API only if the branch still points at the commit the scan saw.
  const deleteSteps = (r, slug, b) => [
    { kind: 'check', cmd: 'gh', args: ['api', `repos/${slug}/git/ref/heads/${enc(b.name)}`, '--jq', '.object.sha'], cwd: r.path, expect: b.oid, changed: 'The branch changed since the scan. Rescan and review it again.', display: `check ${b.name} is still at ${b.oid.slice(0, 7)}` },
    gh(['api', '-X', 'DELETE', `repos/${slug}/git/refs/heads/${enc(b.name)}`], r.path),
  ];
  const restore = (slug, b) => `gh api -X POST repos/${slug}/git/refs -f ref=refs/heads/${b.name} -f sha=${b.oid}`;

  // delete-remote on a repo that is not cloned here (actions.js hands it over): one or more branches.
  function deleteOnGitHub(r, p) {
    const slug = needRemote(r);
    const want = [...new Set(Array.isArray(p.branches) ? p.branches : p.branch != null ? [p.branch] : [])];
    if (!want.length || want.length > MAX_DELETE) fail(`Choose 1 to ${MAX_DELETE} branches.`);
    const def = defaultBranch(r);
    const list = want.map((n) => {
      if (n === def) fail('Refusing to delete the default branch.');
      const b = ghBranch(r, n);
      const pr = (r.prs || []).find((x) => x.headRefName === n);
      if (pr) fail(`PR #${pr.number} is open from ${b.name}. Close or merge it first.`);
      return b;
    });
    const work = list.filter((b) => !isMerged(b));
    return {
      risk: work.length ? 'danger' : 'caution',
      title: list.length === 1 ? `Delete branch ${list[0].name} on GitHub` : `Delete ${list.length} branches on GitHub`,
      steps: list.flatMap((b) => deleteSteps(r, slug, b)),
      warnings: [list.map((b) => b.name).join(', '), ...(work.length ? [`Not merged into ${def}: ${work.map((b) => `${b.name} (${b.unique ?? '?'} commits)`).join(', ')}. Their commits are lost unless they exist elsewhere.`] : [])],
      undo: list.map((b) => restore(slug, b)).join('\n'),
    };
  }

  const actions = {
  'pr-merge': {
    plan(r, p) {
      const slug = needRemote(r);
      const pr = (r.prs || []).find((x) => x.number === p.number) || fail('That PR was not in the last scan.');
      if (pr.isDraft) fail('This PR is a draft. Mark it ready first.');
      if (pr.mergeable === 'CONFLICTING') fail('This PR has merge conflicts.');
      const flag = { squash: '--squash', merge: '--merge', rebase: '--rebase' }[p.method] || fail('Choose squash, merge or rebase.');
      const args = ['pr', 'merge', String(pr.number), flag, '-R', slug];
      if (p.deleteBranch) args.push('--delete-branch');
      // Merge only the commit that was scanned and previewed: GitHub refuses if more was pushed since.
      if (/^[0-9a-f]{40}$/.test(pr.headRefOid || '')) args.push('--match-head-commit', pr.headRefOid);
      const failing = pr.statusCheckRollup === 'FAILURE';
      const pending = pr.statusCheckRollup === 'PENDING';
      return { risk: failing ? 'danger' : 'caution', title: `Merge PR #${pr.number} (${p.method})${p.deleteBranch ? ' and delete its branch' : ''}`, steps: [gh(args, r.path)], warnings: failing ? ['This PR has FAILING checks.'] : pending ? ['Its checks are still running.'] : [], note: pr.title };
    },
  },

  'pr-close': {
    plan(r, p) {
      const slug = needRemote(r);
      const pr = (r.prs || []).find((x) => x.number === p.number) || fail('That PR was not in the last scan.');
      const close = { risk: 'caution', title: `Close PR #${pr.number} without merging`, steps: [gh(['pr', 'close', String(pr.number), '-R', slug], r.path)], undo: `gh pr reopen ${pr.number} -R ${slug}`, note: pr.title };
      if (!p.deleteBranch) return close;
      // Only on a repo that is not cloned here: on a clone gh would also delete the local branch.
      if (r.source !== 'remote') fail('Close the PR, then delete its branch on its own.');
      const b = (r.ghBranches || []).find((x) => x.name === pr.headRefName && x.oid === pr.headRefOid) || fail(`Its branch is not in this repository at the PR's commit (a fork, or pushed to since the scan), so GutCheck will not delete it.`);
      return { ...close, title: `Close PR #${pr.number} and delete its branch ${b.name}`, steps: [...close.steps, ...deleteSteps(r, slug, b)], undo: `${close.undo}\n${restore(slug, b)}` };
    },
  },

  'pr-ready': {
    plan(r, p) {
      const slug = needRemote(r);
      const pr = (r.prs || []).find((x) => x.number === p.number) || fail('That PR was not in the last scan.');
      if (!pr.isDraft) fail('This PR is not a draft.');
      return { risk: 'safe', title: `Mark PR #${pr.number} ready for review`, steps: [gh(['pr', 'ready', String(pr.number), '-R', slug], r.path)], note: pr.title };
    },
  },

  'pr-create': {
    plan(r, p) {
      const slug = needRemote(r);
      const base = defaultBranch(r) || fail('Unknown default branch.');
      if (p.branch === base) fail('The branch is the default branch.');
      const remote = r.source === 'remote';
      if (remote) {
        const b = ghBranch(r, p.branch);
        if (isMerged(b) || !(b.unique > 0)) fail(`${b.name} has no commits that are not in ${base}.`);
      } else {
        localBranch(r, p.branch);
        if (!(r.git.remoteBranches || []).some((x) => x.name === p.branch)) fail('Push the branch first: it does not exist on the remote.');
      }
      if ((r.prs || []).some((x) => x.headRefName === p.branch)) fail('A PR from this branch is already open.');
      // --fill reads the local commits, so a repo that is not cloned here gets the branch name as title.
      const title = cleanText(p.title, 200) || (remote ? p.branch : '');
      const args = ['pr', 'create', '-R', slug, '--head', p.branch, '--base', base, ...(title ? ['--title', title, '--body', ''] : ['--fill'])];
      return { risk: 'caution', title: `Open a PR from ${p.branch} into ${base}`, steps: [gh(args, r.path)] };
    },
  },

  'run-rerun': {
    plan(r, p) {
      const slug = needRemote(r);
      const run_ = ((r.ci && r.ci.failed) || []).find((x) => x.databaseId === p.runId) || fail('That run was not in the last scan.');
      const failedOnly = p.failedOnly !== false;
      return { risk: 'safe', title: `Re-run ${failedOnly ? 'failed jobs of' : ''} "${run_.workflowName}"`, steps: [gh(['run', 'rerun', String(run_.databaseId), ...(failedOnly ? ['--failed'] : []), '-R', slug], r.path)] };
    },
  },

  'protect-branch': {
    plan(r, p) {
      const slug = needRemote(r);
      const preset = PROTECTION[p.preset] || fail('Unknown protection preset.');
      const b = defaultBranch(r) || fail('Unknown default branch.');
      if (r.remote.archived) fail('Repository is archived.');
      if (r.remote.viewerPermission && r.remote.viewerPermission !== 'ADMIN') fail('Admin permission is required to change branch protection.');
      // GitHub's PUT replaces every rule, so existing protection would be weakened to the preset.
      if (r.remote.protection === true) fail(`${b} is already protected (or covered by a ruleset). GutCheck would replace those rules, so change them on GitHub instead.`);
      const body = JSON.stringify(preset.body);
      // Checked again just before the change: GitHub answers 404 only while the branch has no protection.
      const none = { kind: 'check', cmd: 'gh', args: ['api', `repos/${slug}/branches/${b}/protection`], cwd: r.path, expectFail: /HTTP 404|Branch not protected/, display: `check ${b} still has no protection` };
      return {
        risk: 'caution',
        title: `Protect ${b}`,
        steps: [none, gh(['api', '-X', 'PUT', `repos/${slug}/branches/${b}/protection`, '-H', 'Accept: application/vnd.github+json', '--input', '-'], r.path, body)],
        warnings: [preset.label, 'Private repositories on a free plan cannot use branch protection; GitHub will report an error.'],
        undo: `gh api -X DELETE repos/${slug}/branches/${b}/protection`,
        body: JSON.stringify(preset.body, null, 2),
      };
    },
  },

  'unprotect-branch': {
    plan(r) {
      const slug = needRemote(r);
      const b = defaultBranch(r) || fail('Unknown default branch.');
      if (r.remote.viewerPermission && r.remote.viewerPermission !== 'ADMIN') fail('Admin permission is required.');
      return { risk: 'danger', title: `Remove ALL branch protection from ${b}`, steps: [gh(['api', '-X', 'DELETE', `repos/${slug}/branches/${b}/protection`], r.path)] };
    },
  },

  // Additive: a new tag ruleset never replaces anything, and repository admins can still bypass it.
  'protect-tags': {
    plan(r) {
      const slug = needRemote(r);
      if (r.remote.archived) fail('Repository is archived.');
      if (r.remote.viewerPermission !== 'ADMIN') fail('Admin permission is required to create a ruleset.');
      const tag = releaseTag(r) || fail('This repository has no release tags.');
      if (!Array.isArray(r.tagRulesets)) fail('GutCheck could not read this repository\'s tag rulesets (plan or permissions), so it cannot tell what is missing.');
      if (tagProtection(r.tagRulesets, tag).state === 'covered') fail('Release tags are already protected by a ruleset.');
      // actor_id 5 is the built-in repository Admin role in a ruleset's bypass list.
      const body = { name: RULESET_NAME, target: 'tag', enforcement: 'active', bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update', parameters: { update_allows_fetch_and_merge: false } }] };
      return {
        risk: 'caution',
        title: 'Protect release tags (v*): block deleting, moving and force-pushing them',
        steps: [gh(['api', '-X', 'POST', `repos/${slug}/rulesets`, '-H', 'Accept: application/vnd.github+json', '--input', '-'], r.path, JSON.stringify(body))],
        warnings: ['Repository admins can still bypass the rules, so you can recover from a mistake.', 'Tags that are moved on purpose, such as a floating v1 or v2 tag for an action, can then only be moved by an admin; new v* tags can still be created.', 'Private repositories on a free plan cannot use rulesets; GitHub will report an error.'],
        undo: `Delete the ruleset "${RULESET_NAME}" under ${slug} > Settings > Rules > Rulesets`,
        body: JSON.stringify(body, null, 2),
      };
    },
  },

  'actions-settings': {
    plan(r, p) {
      const slug = needRemote(r);
      if (r.remote.archived) fail('Repository is archived.');
      if (r.remote.viewerPermission !== 'ADMIN') fail('Admin permission is required to change Actions settings.');
      const a = r.actionsSettings || {};
      let body; let title; let warnings; let undo;
      if (p.setting === 'read-token') {
        if (a.defaultPermissions === 'read') fail('The default token is already read-only.');
        body = { default_workflow_permissions: 'read' };
        title = 'Make the default GITHUB_TOKEN read-only';
        warnings = ['Workflows that relied on the write default (pushing commits, creating releases, commenting on PRs) will fail with 403 unless they declare permissions:. GutCheck only offers this when every workflow declares permissions:.'];
        undo = `gh api -X PUT repos/${slug}/actions/permissions/workflow -f default_workflow_permissions=write`;
      } else if (p.setting === 'no-approve') {
        if (a.canApprovePrs === false) fail('Actions already cannot approve pull requests.');
        body = { can_approve_pull_request_reviews: false };
        title = 'Stop GitHub Actions approving pull requests';
        warnings = ['A workflow that approves PRs itself (an auto-approve bot) will stop working.'];
        undo = `gh api -X PUT repos/${slug}/actions/permissions/workflow -F can_approve_pull_request_reviews=true`;
      } else fail('Unknown Actions setting.');
      warnings.push('An organization policy can block this change; GitHub then answers 409.');
      return { risk: 'caution', title, steps: [gh(['api', '-X', 'PUT', `repos/${slug}/actions/permissions/workflow`, '-H', 'Accept: application/vnd.github+json', '--input', '-'], r.path, JSON.stringify(body))], warnings, undo, body: JSON.stringify(body, null, 2) };
    },
  },

  'security-enable': {
    plan(r, p) {
      const slug = needRemote(r);
      if (r.remote.viewerPermission && r.remote.viewerPermission !== 'ADMIN') fail('Admin permission is required.');
      if (p.feature === 'alerts') return { risk: 'safe', title: 'Enable Dependabot alerts', steps: [gh(['api', '-X', 'PUT', `repos/${slug}/vulnerability-alerts`], r.path)], undo: `gh api -X DELETE repos/${slug}/vulnerability-alerts` };
      if (p.feature === 'security-fixes') return { risk: 'caution', title: 'Enable Dependabot security updates (opens PRs automatically)', steps: [gh(['api', '-X', 'PUT', `repos/${slug}/automated-security-fixes`], r.path)], undo: `gh api -X DELETE repos/${slug}/automated-security-fixes` };
      if (p.feature === 'secret-scanning') return { risk: 'caution', title: 'Enable secret scanning', steps: [gh(['api', '-X', 'PATCH', `repos/${slug}`, '--input', '-'], r.path, JSON.stringify({ security_and_analysis: { secret_scanning: { status: 'enabled' } } }))] };
      if (p.feature === 'push-protection') return { risk: 'caution', title: 'Enable secret scanning push protection', steps: [gh(['api', '-X', 'PATCH', `repos/${slug}`, '--input', '-'], r.path, JSON.stringify({ security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }))], note: 'Pushes that contain a recognised secret are blocked; whoever pushes can still bypass it with a reason.' };
      if (p.feature === 'code-scanning') return { risk: 'caution', title: 'Enable CodeQL default setup', steps: [gh(['api', '-X', 'PATCH', `repos/${slug}/code-scanning/default-setup`, '-f', 'state=configured'], r.path)], note: 'Runs CodeQL through GitHub Actions on pushes, pull requests and weekly.', undo: `gh api -X PATCH repos/${slug}/code-scanning/default-setup -f state=not-configured` };
      if (p.feature === 'private-reporting') return { risk: 'safe', title: 'Enable private vulnerability reporting', steps: [gh(['api', '-X', 'PUT', `repos/${slug}/private-vulnerability-reporting`], r.path)], undo: `gh api -X DELETE repos/${slug}/private-vulnerability-reporting` };
      return fail('Unknown security feature.');
    },
  },

  'repo-edit': {
    plan(r, p) {
      const slug = needRemote(r);
      const args = ['repo', 'edit', slug];
      const parts = [];
      if (p.description != null) { const d = cleanText(p.description, 350); args.push('--description', d); parts.push(`description "${d}"`); }
      if (typeof p.deleteBranchOnMerge === 'boolean') { args.push(`--delete-branch-on-merge=${p.deleteBranchOnMerge}`); parts.push(`auto-delete merged branches: ${p.deleteBranchOnMerge}`); }
      if (!parts.length) fail('Nothing to change.');
      return { risk: 'caution', title: `Edit repository settings: ${parts.join(', ')}`, steps: [gh(args, r.path)], note: r.remote.description ? `Previous description: ${r.remote.description}` : undefined };
    },
  },

  'repo-archive': {
    plan(r) {
      const slug = needRemote(r);
      if (r.remote.viewerPermission && r.remote.viewerPermission !== 'ADMIN') fail('Admin permission is required to archive a repository.');
      return { risk: 'danger', title: `Archive ${slug} (read-only until unarchived)`, steps: [gh(['repo', 'archive', slug, '--yes'], r.path)], warnings: ['Pushes, pull requests, issues and settings changes are refused until you unarchive it.'], undo: `gh repo unarchive ${slug} --yes` };
    },
  },
};
  return { actions, deleteOnGitHub };
};
