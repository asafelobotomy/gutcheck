// GitHub-side actions: pull requests, CI re-runs, branch protection, security features and repository
// settings. Built with actions.js's own step builders and plan errors, so plans read the same.
const { PROTECTION } = require('./protection');

module.exports = ({ fail, gh, needRemote, defaultBranch, localBranch, cleanText, readGh }) => ({
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
      return { risk: 'caution', title: `Close PR #${pr.number} without merging`, steps: [gh(['pr', 'close', String(pr.number), '-R', slug], r.path)], undo: `gh pr reopen ${pr.number} -R ${slug}`, note: pr.title };
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
      localBranch(r, p.branch);
      if (!(r.git.remoteBranches || []).some((x) => x.name === p.branch)) fail('Push the branch first: it does not exist on the remote.');
      if ((r.prs || []).some((x) => x.headRefName === p.branch)) fail('A PR from this branch is already open.');
      const title = cleanText(p.title, 200);
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
      return { risk: 'danger', title: `Archive ${slug} (read-only until unarchived)`, steps: [gh(['repo', 'archive', slug, '--yes'], r.path)], undo: `gh repo unarchive ${slug} --yes` };
    },
  },
});
