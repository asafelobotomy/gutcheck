// Action engine: plan() turns a request into an exact, inspectable list of steps (no side
// effects); apply() runs a plan. The UI shows the plan, the user confirms, and main applies the
// stored plan, so what is previewed is exactly what runs.
//
// Deliberately NOT offered: deleting repos, changing visibility, force-push, history rewriting.

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./exec');
const { TEMPLATES } = require('./templates');

class PlanError extends Error {}
const fail = (msg) => { throw new PlanError(msg); };

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const validBranch = (b) => typeof b === 'string' && BRANCH_RE.test(b) && !b.includes('..') && !b.includes('//') && !/(\.lock|[./])$/.test(b);
const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// Read-only git for planning: same hardening as scans (no hooks, no fsmonitor, no index lock).
const RO = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const readGit = (ctx, args, cwd) => ctx.run('git', [...RO, ...args], { cwd });

const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a));
const show = (cmd, args) => `${cmd} ${args.filter((a, i, all) => !(a === '-c' || all[i - 1] === '-c')).map(quote).join(' ')}`;

// Step builders. `display` is what the user sees in the confirm dialog.
const git = (args, dir, note) => ({ kind: 'cmd', cmd: 'git', args: ['-c', 'core.fsmonitor=false', ...args], cwd: dir, display: show('git', args), note });
const gh = (args, dir, input) => ({ kind: 'cmd', cmd: 'gh', args, cwd: dir, input, display: show('gh', args) + (input ? '   # with JSON body' : '') });

const RISK = { safe: 0, caution: 1, danger: 2 };

function needRemote(repo) {
  if (!repo.remote || repo.remote.unreachable) fail('This repo has no reachable GitHub remote.');
  return `${repo.remote.owner}/${repo.remote.name}`;
}
const localBranch = (repo, b) => (repo.git.branches || []).find((x) => x.name === b) || fail(`No local branch "${b}" in the last scan.`);
const defaultBranch = (repo) => (repo.remote && repo.remote.defaultBranch) || null;

const PROTECTION = {
  basic: {
    label: 'Basic: require a pull request, block force-pushes and deletion (no approvals needed)',
    body: { required_status_checks: null, enforce_admins: false, required_pull_request_reviews: { required_approving_review_count: 0 }, restrictions: null, allow_force_pushes: false, allow_deletions: false },
  },
  strict: {
    label: 'Strict: 1 approval, dismiss stale reviews, resolve conversations, admins included, block force-pushes and deletion',
    body: { required_status_checks: null, enforce_admins: true, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }, restrictions: null, allow_force_pushes: false, allow_deletions: false, required_conversation_resolution: true },
  },
};

// Each action: plan(repo, params, ctx) -> { risk, title, steps, undo?, warnings? }
const ACTIONS = {
  fetch: { plan: (r) => ({ risk: 'safe', title: 'Fetch all remotes and prune deleted branches', steps: [git(['fetch', '--all', '--prune'], r.path)] }) },

  pull: {
    plan(r) {
      if (!r.git.upstream) fail('Current branch has no upstream to pull from.');
      return { risk: 'safe', title: `Fast-forward ${r.git.branch} from ${r.git.upstream}`, steps: [git(['pull', '--ff-only'], r.path)] };
    },
  },

  push: {
    plan(r) {
      if (r.git.detached || !r.git.branch) fail('Detached HEAD: nothing to push.');
      const steps = r.git.upstream ? [git(['push'], r.path)] : [git(['push', '-u', 'origin', r.git.branch], r.path)];
      return { risk: 'safe', title: `Push ${r.git.branch}`, steps };
    },
  },

  checkout: {
    plan(r, p) {
      localBranch(r, p.branch);
      if (r.git.dirty > 0) fail('Uncommitted changes: commit them first.');
      return { risk: 'safe', title: `Switch to ${p.branch}`, steps: [git(['switch', p.branch], r.path)] };
    },
  },

  'create-branch': {
    plan(r, p) {
      if (!validBranch(p.name)) fail('Invalid branch name.');
      if ((r.git.branches || []).some((b) => b.name === p.name)) fail(`Branch "${p.name}" already exists.`);
      const from = p.from ? localBranch(r, p.from).name : null;
      return { risk: 'safe', title: `Create and switch to ${p.name}${from ? ` from ${from}` : ''}`, steps: [git(['switch', '-c', p.name, ...(from ? [from] : [])], r.path)], undo: `git switch ${r.git.branch || '-'} && git branch -d ${p.name}` };
    },
  },

  'merge-branch': {
    plan(r, p) {
      if (r.git.detached) fail('Detached HEAD.');
      const b = localBranch(r, p.branch);
      if (b.current) fail('Cannot merge a branch into itself.');
      if (r.git.dirty > 0) fail('Uncommitted changes: commit them first.');
      const noff = p.mode === 'no-ff';
      return {
        risk: 'caution',
        title: `Merge ${b.name} into ${r.git.branch}${noff ? ' (merge commit)' : ' (fast-forward only)'}`,
        steps: [git(noff ? ['merge', '--no-ff', '--no-edit', b.name] : ['merge', '--ff-only', b.name], r.path)],
        undo: 'git reset --hard ORIG_HEAD   (only if you have not made further commits)',
      };
    },
  },

  'delete-local': {
    async plan(r, p, ctx) {
      const b = localBranch(r, p.branch);
      if (b.current) fail('Cannot delete the branch you are on.');
      const force = !!p.force;
      if (!force && !(r.git.mergedBranches || []).includes(b.name)) fail(`"${b.name}" is not merged into the default branch. Use force delete if you are sure.`);
      const sha = (await readGit(ctx, ['rev-parse', '--short', b.name], r.path)).stdout.trim();
      return { risk: force ? 'danger' : 'caution', title: `${force ? 'FORCE ' : ''}delete local branch ${b.name}`, steps: [git(['branch', force ? '-D' : '-d', '--', b.name], r.path)], undo: sha ? `git branch ${b.name} ${sha}` : undefined };
    },
  },

  'delete-merged': {
    plan(r, p) {
      const names = Array.isArray(p.branches) ? p.branches : [];
      const merged = r.git.mergedBranches || [];
      if (!names.length || !names.every((b) => merged.includes(b) && validBranch(b))) fail('Branch list does not match the merged branches found in the last scan.');
      return { risk: 'caution', title: `Delete ${names.length} merged local branch${names.length > 1 ? 'es' : ''}`, steps: [git(['branch', '-d', '--', ...names], r.path)], warnings: [names.join(', ')] };
    },
  },

  'delete-remote': {
    plan(r, p) {
      needRemote(r);
      const rb = (r.git.remoteBranches || []).find((x) => x.name === p.branch) || fail(`"${p.branch}" is not a known remote branch.`);
      if (rb.name === defaultBranch(r)) fail('Refusing to delete the default branch.');
      const pr = (r.prs || []).find((x) => x.headRefName === rb.name);
      if (pr) fail(`PR #${pr.number} is open from this branch. Close or merge it first.`);
      return { risk: 'danger', title: `Delete remote branch origin/${rb.name}`, steps: [git(['push', 'origin', '--delete', rb.name], r.path)], undo: `git push origin <sha>:refs/heads/${rb.name}   (find the sha with git reflog)` };
    },
  },

  'commit-all': {
    async plan(r, p, ctx) {
      const msg = cleanText(p.message, 300);
      if (!msg) fail('A commit message is required.');
      if (r.git.dirty === 0) fail('Nothing to commit.');
      if (r.git.detached) fail('Detached HEAD.');
      const st = (await readGit(ctx, ['status', '--short'], r.path)).stdout.trim();
      return { risk: 'caution', title: `Commit all changes on ${r.git.branch}`, steps: [git(['add', '-A'], r.path), git(['commit', '-m', msg], r.path)], warnings: ['Files to be committed:\n' + st.split('\n').slice(0, 40).join('\n')], undo: 'git reset --soft HEAD~1' };
    },
  },

  'pr-merge': {
    plan(r, p) {
      const slug = needRemote(r);
      const pr = (r.prs || []).find((x) => x.number === p.number) || fail('That PR was not in the last scan.');
      if (pr.isDraft) fail('This PR is a draft. Mark it ready first.');
      if (pr.mergeable === 'CONFLICTING') fail('This PR has merge conflicts.');
      const flag = { squash: '--squash', merge: '--merge', rebase: '--rebase' }[p.method] || fail('Choose squash, merge or rebase.');
      const args = ['pr', 'merge', String(pr.number), flag, '-R', slug];
      if (p.deleteBranch) args.push('--delete-branch');
      const failing = pr.statusCheckRollup === 'FAILURE';
      return { risk: failing ? 'danger' : 'caution', title: `Merge PR #${pr.number} (${p.method})${p.deleteBranch ? ' and delete its branch' : ''}`, steps: [gh(args, r.path)], warnings: failing ? ['This PR has FAILING checks.'] : [], note: pr.title };
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
      const body = JSON.stringify(preset.body);
      return {
        risk: 'caution',
        title: `Protect ${b}`,
        steps: [gh(['api', '-X', 'PUT', `repos/${slug}/branches/${b}/protection`, '-H', 'Accept: application/vnd.github+json', '--input', '-'], r.path, body)],
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

  'add-file': {
    async plan(r, p, ctx) {
      const t = TEMPLATES[p.template] || fail('Unknown template.');
      const target = path.join(r.path, t.file);
      if (!target.startsWith(r.path + path.sep)) fail('Bad path.');
      if (ctx.fs.existsSync(target)) fail(`${t.file} already exists.`);
      const author = (await readGit(ctx, ['config', 'user.name'], r.path)).stdout.trim() || 'Author';
      const manifests = (r.deps && r.deps.manifests) || [];
      const content = t.build({ author, name: path.basename(r.path), manifests });
      const steps = [{ kind: 'write', path: target, content, display: `write ${t.file} (${content.length} bytes)`, preview: content.split('\n').slice(0, 14).join('\n') }];
      if (p.commit) steps.push(git(['add', '--', t.file], r.path), git(['commit', '-m', `Add ${t.label}`, '--', t.file], r.path));
      return { risk: p.commit ? 'caution' : 'safe', title: `Add ${t.file}${p.commit ? ' and commit it' : ''}`, steps, undo: p.commit ? 'git reset --soft HEAD~1 && git rm --cached ' + t.file : `rm ${t.file}` };
    },
  },

  'npm-install': {
    plan: (r) => ({ risk: 'caution', title: 'Run npm install', steps: [{ kind: 'cmd', cmd: 'npm', args: ['install'], cwd: r.path, display: 'npm install', timeout: 300000 }], warnings: ["This executes the project's package install scripts."] }),
  },
};

// Names the UI may request, in addition to the type -> plan mapping.
const defaultCtx = (over = {}) => ({ run, fs, readOnly: false, ...over });

async function plan(repo, action, ctx = {}) {
  ctx = defaultCtx(ctx);
  try {
    if (!repo) fail('Unknown repo.');
    if (!action || typeof action.type !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, action.type)) fail('Unknown action.');
    if (ctx.readOnly) fail('Read-only mode is on. Turn it off in the header to make changes.');
    const out = await ACTIONS[action.type].plan(repo, action, ctx);
    const risk = out.risk;
    return {
      ok: true,
      type: action.type,
      repoPath: repo.path,
      repoName: repo.name,
      title: out.title,
      risk,
      steps: out.steps,
      display: out.steps.map((s) => ({ text: s.display, preview: s.preview, note: s.note })),
      warnings: out.warnings || [],
      undo: out.undo || null,
      body: out.body || null,
      note: out.note || null,
      confirmName: RISK[risk] >= RISK.danger ? repo.name : null,
    };
  } catch (e) {
    if (e instanceof PlanError) return { ok: false, error: e.message };
    return { ok: false, error: 'Could not plan action: ' + (e && e.message) };
  }
}

// Execute a plan produced by plan(). Stops at the first failing step.
async function apply(p, ctx = {}) {
  ctx = defaultCtx(ctx);
  const results = [];
  for (const s of p.steps) {
    if (s.kind === 'write') {
      try {
        fs.mkdirSync(path.dirname(s.path), { recursive: true });
        fs.writeFileSync(s.path, s.content, { flag: 'wx' });
        results.push({ text: s.display, ok: true, out: '' });
      } catch (e) {
        results.push({ text: s.display, ok: false, out: String(e.message) });
        return { ok: false, results };
      }
    } else {
      const r = await ctx.run(s.cmd, s.args, { cwd: s.cwd, input: s.input, timeout: s.timeout || 60000 });
      results.push({ text: s.display, ok: r.ok, out: (r.stdout + r.stderr).trim().slice(0, 2000) });
      if (!r.ok) return { ok: false, results };
    }
  }
  return { ok: true, results };
}

module.exports = { plan, apply, ACTIONS, PROTECTION, validBranch };
