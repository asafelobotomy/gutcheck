// Action engine: plan() turns a request into an exact, inspectable list of steps (no side
// effects); apply() runs a plan. The UI shows the plan, the user confirms, and main applies the
// stored plan, so what is previewed is exactly what runs. Deliberately NOT offered: deleting repos, changing visibility, force-push, history rewriting.

const path = require('node:path');
const { READONLY_GIT } = require('./exec');
const { apply, defaultCtx } = require('./apply');
const { MAX_PLAN_ITEMS, sq } = require('./util');
const INSTALLERS = ['npm install', 'yarn install', 'pnpm install', 'bun install'];
const { TEMPLATES, findEcosystems } = require('./templates');
const { detectStacks } = require('./tests/stack');
const { IGNORE_OK } = require('./clutter');
const { PROTECTION } = require('./protection');
const { planTestRun } = require('./tests/runs');

class PlanError extends Error {}
const fail = (msg) => { throw new PlanError(msg); };

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const validBranch = (b) => typeof b === 'string' && BRANCH_RE.test(b) && !b.includes('..') && !b.includes('//') && !/(\.lock|[./])$/.test(b);
const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// Read-only git for planning: same hardening as scans (no hooks, no fsmonitor, no index lock).
const readGit = (ctx, args, cwd) => ctx.run('git', [...READONLY_GIT, ...args], { cwd });

// The preview shows every argument that runs (the git builder adds its hardening -c option after
// building this), single-quoted so a pasted copy cannot expand $(...) or backticks.
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : sq(a));
const show = (cmd, args) => `${cmd} ${args.map(quote).join(' ')}`;

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
      // `git add -A` must stage exactly what was previewed: the check step refuses if anything changed since.
      const check = { kind: 'check', cmd: 'git', args: [...READONLY_GIT, 'status', '--short'], cwd: r.path, expect: st, display: 'check the changed files are still the ones listed below' };
      return { risk: 'caution', title: `Commit all changes on ${r.git.branch}`, steps: [check, git(['add', '-A'], r.path), git(['commit', '-m', msg], r.path)], warnings: ['Files to be committed:\n' + st.split('\n').slice(0, 40).join('\n')], undo: 'git reset --soft HEAD~1' };
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
      if (p.feature === 'push-protection') return { risk: 'caution', title: 'Enable secret scanning push protection', steps: [gh(['api', '-X', 'PATCH', `repos/${slug}`, '--input', '-'], r.path, JSON.stringify({ security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }))], note: 'Pushes that contain a recognised secret are blocked; whoever pushes can still bypass it with a reason.' };
      if (p.feature === 'code-scanning') return { risk: 'caution', title: 'Enable CodeQL default setup', steps: [gh(['api', '-X', 'PATCH', `repos/${slug}/code-scanning/default-setup`, '-f', 'state=configured'], r.path)], note: 'Runs CodeQL through GitHub Actions on pushes, pull requests and weekly.', undo: `gh api -X PATCH repos/${slug}/code-scanning/default-setup -f state=not-configured` };
      if (p.feature === 'private-reporting') return { risk: 'safe', title: 'Enable private vulnerability reporting', steps: [gh(['api', '-X', 'PUT', `repos/${slug}/private-vulnerability-reporting`], r.path)], undo: `gh api -X DELETE repos/${slug}/private-vulnerability-reporting` };
      return fail('Unknown security feature.');
    },
  },

  // Forget worktrees whose folders no longer exist. Never touches a worktree that is still on disk.
  'worktree-prune': {
    plan: (r) => ({ risk: 'safe', title: 'Prune stale worktrees', steps: [git(['worktree', 'prune', '-v'], r.path)], note: 'Only removes git\'s records of worktrees whose folders are already gone.' }),
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
      const content = t.build({ author, name: path.basename(r.path), manifests, ecosystems: findEcosystems(r.path), stacks: detectStacks(r.path), owner: r.remote && r.remote.owner, hasWorkflows: !!r.hasWorkflows, branch: (r.remote && r.remote.defaultBranch) || r.git.branch || 'main' });
      const steps = [{ kind: 'write', root: r.path, path: target, content, display: `write ${t.file} (${content.length} bytes)`, preview: content.split('\n').slice(0, 14).join('\n') }];
      if (p.commit) steps.push(git(['add', '--', t.file], r.path), git(['commit', '-m', `Add ${t.label}`, '--', t.file], r.path));
      return { risk: p.commit ? 'caution' : 'safe', title: `Add ${t.file}${p.commit ? ' and commit it' : ''}`, steps, undo: p.commit ? 'git reset --soft HEAD~1 && git rm --cached ' + t.file : `rm ${t.file}` };
    },
  },

  // Uses the package manager the lockfile belongs to (npm on a yarn repo would add a second lockfile).
  'npm-install': {
    plan(r) {
      const want = ((r.deps && r.deps.installer) || []).join(' ');
      const [cmd, ...args] = (INSTALLERS.includes(want) ? want : 'npm install').split(' ');
      return { risk: 'caution', title: `Run ${cmd} install`, steps: [{ kind: 'cmd', cmd, args, cwd: r.path, display: `${cmd} ${args.join(' ')}`, timeout: 300000 }], warnings: ["This executes the project's package install scripts."] };
    },
  },
  // Remove detected clutter. Paths from the UI are only looked up in a FRESH scan, so anything
  // tracked by git, not detected as clutter, or outside the repo is refused.
  'clean-clutter': {
    async plan(r, p, ctx) {
      const want = [...new Set(Array.isArray(p.paths) ? p.paths : [])];
      if (!want.length || want.length > MAX_PLAN_ITEMS || want.some((x) => typeof x !== 'string')) fail('Choose at least one item.');
      const found = new Map((await ctx.clutter(r.path)).items.map((i) => [i.path, i]));
      const picked = want.map((x) => found.get(x) || fail(`"${x}" is no longer detected as clutter. Rescan and try again.`));
      const chosen = new Set(want);
      for (const it of picked) if (it.keep && chosen.has(it.keep)) fail(`"${it.path}" and the file it duplicates, "${it.keep}", are both selected. Keep one.`);
      const steps = picked.map((it) => ({
        kind: 'remove', root: r.path, rel: it.path, path: path.join(r.path, ...it.path.split('/')), mode: it.mode, fileStat: it.kind === 'file' ? { size: it.size, mtime: it.mtime } : null,
        display: it.mode === 'trash' ? `move to trash: ${it.path}${it.kind === 'dir' ? '/' : ''}` : `delete (regenerable): ${it.path}${it.kind === 'dir' ? '/' : ''}`,
        note: it.reason,
      }));
      const env = picked.filter((it) => it.category === 'env');
      const trashed = picked.filter((it) => it.mode === 'trash').length;
      const warnings = [];
      if (env.length) warnings.push(`Env files can hold secrets that exist nowhere else:\n${env.map((e) => e.path).join('\n')}\nThey go to your trash, so you can restore them.`);
      return {
        risk: env.length ? 'danger' : 'caution',
        title: `Remove ${picked.length} clutter item${picked.length > 1 ? 's' : ''}`,
        steps, warnings,
        undo: trashed ? 'Restore from your trash. Regenerable caches are rebuilt by your tools.' : 'Regenerable caches are rebuilt by your tools.',
      };
    },
  },

  // Layer-3 test runs (coverage or mutation testing). Executes the project's own code: dangerous risk.
  'tests-run': {
    async plan(r, p, ctx) {
      try { return await planTestRun(r, p, ctx); } catch (e) { fail(e.message); }
    },
  },

  // Append known-safe ignore rules (from a fixed allowlist) to .gitignore.
  'gitignore-append': {
    plan(r, p, ctx) {
      const entries = [...new Set(Array.isArray(p.entries) ? p.entries : [])];
      if (!entries.length || !entries.every((e) => IGNORE_OK.has(e))) fail('Those rules are not on the list of rules GutCheck can add.');
      const target = path.join(r.path, '.gitignore');
      let cur = '';
      try { cur = ctx.fs.readFileSync(target, 'utf8'); } catch {}
      const have = new Set(cur.split('\n').map((l) => l.trim()));
      const add = entries.filter((e) => !have.has(e));
      if (!add.length) fail('.gitignore already has those rules.');
      const content = add.join('\n') + '\n';
      return { risk: 'safe', title: `Add ${add.length} rule${add.length > 1 ? 's' : ''} to .gitignore`, steps: [{ kind: 'append', root: r.path, path: target, content, display: `append to .gitignore: ${add.join('  ')}`, preview: content }], undo: 'Delete the added lines from .gitignore.' };
    },
  },
};


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
module.exports = { plan, apply };
