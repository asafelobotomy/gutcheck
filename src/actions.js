// Action engine: plan() turns a request into an exact, inspectable list of steps (no side
// effects); apply() runs a plan. The UI shows the plan, the user confirms, and main applies the
// stored plan, so what is previewed is exactly what runs. Deliberately NOT offered: deleting repos, changing visibility, force-push, history rewriting.

const path = require('node:path');
const { apply, defaultCtx } = require('./apply');
const { MAX_PLAN_ITEMS, sq } = require('./util');
const INSTALLERS = ['npm install', 'yarn install', 'pnpm install', 'bun install'];
const { TEMPLATES, findEcosystems } = require('./templates');
const { detectStacks } = require('./tests/stack');
const { IGNORE_OK } = require('./clutter');
const { looksSecret } = require('./secret-patterns');
const { planTestRun } = require('./tests/runs');
const { validBranch, validRemote, inspect } = require('./git-safety');

class PlanError extends Error {}
const fail = (msg) => { throw new PlanError(msg); };
// Not an error: there is nothing for the action to do (the app shows it as a note, not a failure).
const nothing = (msg) => { const e = new PlanError(msg); e.nothing = true; throw e; };

const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// Read-only git for planning: the scans' guards (no hooks, fsmonitor, repo drivers or lazy fetch).
const readGit = (ctx, args, cwd) => ctx.safeGit(args, cwd);

// The preview shows every argument that runs (the git builder adds its hardening -c option after
// building this), single-quoted so a pasted copy cannot expand $(...) or backticks.
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : sq(a));
const show = (cmd, args) => `${cmd} ${args.map(quote).join(' ')}`;

// Step builders. `display` is what the user sees in the confirm dialog. Every git step runs with
// fixed options a repo's config cannot undo: no fsmonitor, no ext:: or fd:: transport, no
// signature checks or signing (gpg programs, the ssh signing-key command), no alternate-refs
// command, no recursion into submodules (their own config runs their filters and hooks), and no
// auto gc (gc.recentObjectsHook and the pre-auto-gc hook). `pre` adds per-step -c options, also
// left out of `display`.
const GIT_STEP = [
  '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never',
  '-c', 'log.showSignature=false', '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false',
  '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'gpg.ssh.defaultKeyCommand=',
  '-c', 'core.alternateRefsCommand=true', '-c', 'core.alternateRefsPrefixes=', // true: lists no refs (an empty command makes git print "cannot run")
  '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
];
const git = (args, dir, note, pre = []) => ({ kind: 'cmd', cmd: 'git', args: [...GIT_STEP, ...pre, ...args], cwd: dir, display: show('git', args), note });
const gh = (args, dir, input) => ({ kind: 'cmd', cmd: 'gh', args, cwd: dir, input, display: show('gh', args) + (input ? '   # with JSON body' : '') });

const RISK = { safe: 0, caution: 1, danger: 2 };

function needRemote(repo) {
  if (!repo.remote || repo.remote.unreachable) fail('This repo has no reachable GitHub remote.');
  return `${repo.remote.owner}/${repo.remote.name}`;
}
const localBranch = (repo, b) => (repo.git.branches || []).find((x) => x.name === b) || fail(`No local branch "${cleanText(String(b), 60)}" in the last scan.`);
// A name from a scan goes on a git command line only if it cannot be read as an option (B6, B7).
const safeName = (b, verb = 'Refusing') => (validBranch(b) ? b : fail(`${verb}: "${cleanText(String(b), 60)}" is not a safe branch name.`));
// The current branch's upstream as git has it now: the remote and the branch there (B5, B8).
async function upstreamOf(r, b, ctx, verb) {
  const u = await readGit(ctx, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${b}`], r.path);
  const [remote, ref] = u.ok ? u.stdout.replace(/\n$/, '').split('\0') : [];
  if (!remote || !ref || !ref.startsWith('refs/heads/')) fail(`Could not read where this branch ${verb}s. Rescan and try again.`);
  const dest = ref.slice('refs/heads/'.length);
  if (`${remote}/${dest}` !== r.git.upstream) fail('The upstream changed since the scan. Rescan and try again.');
  if (!validRemote(remote)) fail(`Refusing to ${verb}: "${cleanText(remote, 60)}" is not a safe remote name.`);
  return { remote, dest: safeName(dest, `Refusing to ${verb}`) };
}
const defaultBranch = (repo) => (repo.remote && repo.remote.defaultBranch) || null;

// Each action: plan(repo, params, ctx) -> { risk, title, steps, undo?, warnings? }
// The path in a `git status --short` line ("XY path", "R  old -> new", "\"quoted path\"").
const statusPath = (l) => { const p = l.slice(3).split(' -> ').pop(); return p.startsWith('"') ? p.slice(1, -1) : p; };

// `uses` names the kinds of git step a plan runs (git-safety.js): plan() refuses network steps
// whose programs the repo's config names, and rates steps that run its hooks or drivers caution.
const ACTIONS = {
  // Each remote fetched into refs/remotes/<r>/ only, by an explicit refspec: a repo's
  // remote.<r>.fetch could map remote branches onto local ones, and --prune would then delete
  // every local branch (B8). --refmap= stops the configured refspecs being applied as well.
  fetch: {
    async plan(r, p, ctx) {
      const l = await readGit(ctx, ['remote'], r.path);
      if (!l.ok) fail('Could not list this repo\'s remotes.');
      const names = l.stdout.split('\n').filter(Boolean);
      const ok = names.filter(validRemote);
      if (!names.length) nothing('Nothing to fetch: this repo has no remotes.');
      if (!ok.length) fail('None of this repo\'s remotes has a name GutCheck can use safely.');
      const steps = ok.map((rn) => git(['fetch', '--prune', '--no-prune-tags', '--no-recurse-submodules', '--refmap=', '--', rn, `+refs/heads/*:refs/remotes/${rn}/*`], r.path));
      const skipped = names.length - ok.length;
      return { risk: 'safe', title: 'Fetch all remotes and prune deleted branches', steps, uses: ['fetch'], remotes: ok, warnings: skipped ? [`Skipped ${skipped} remote${skipped > 1 ? 's' : ''} whose name could be read as an option.`] : [] };
    },
  },

  // `git pull` fetches with the configured refspecs (B8): fetch just the upstream into its
  // remote-tracking branch, then fast-forward to that. branch.<b>.mergeOptions is the repo's too.
  pull: {
    async plan(r, p, ctx) {
      if (!r.git.upstream) fail('Current branch has no upstream to pull from.');
      if (r.git.detached || !r.git.branch) fail('Detached HEAD: nothing to pull into.');
      const b = safeName(r.git.branch, 'Refusing to pull');
      const { remote, dest } = await upstreamOf(r, b, ctx, 'pull');
      const track = `refs/remotes/${remote}/${dest}`;
      return {
        risk: 'safe', title: `Fast-forward ${b} from ${r.git.upstream}`, uses: ['pull'], remotes: [remote],
        steps: [git(['fetch', '--no-prune', '--no-recurse-submodules', '--refmap=', '--', remote, `+refs/heads/${dest}:${track}`], r.path), git(['merge', '--ff-only', '--end-of-options', track], r.path, undefined, ['-c', `branch.${b}.mergeOptions=`])],
      };
    },
  },

  // One explicit refspec, so repo config cannot widen the push: remote.<r>.mirror (deletes the
  // remote's other branches) and remote.<r>.push (+refspecs force-push) only apply to a bare `git
  // push`. Names are checked before they reach the command line, where `--mirror` is an option.
  push: {
    async plan(r, p, ctx) {
      if (r.git.detached || !r.git.branch) fail('Detached HEAD: nothing to push.');
      const b = safeName(r.git.branch, 'Refusing to push');
      const { remote, dest } = r.git.upstream ? await upstreamOf(r, b, ctx, 'push') : { remote: 'origin', dest: b };
      // No tags or submodules either: push.followTags and push.recurseSubmodules would add them.
      const args = ['push', '--no-follow-tags', '--recurse-submodules=no', ...(r.git.upstream ? [] : ['-u']), '--', remote, `refs/heads/${b}:refs/heads/${dest}`];
      return { risk: 'safe', title: `Push ${b}`, uses: ['push'], remotes: [remote], pushes: true, steps: [git(args, r.path, undefined, ['-c', `remote.${remote}.mirror=false`, '-c', 'push.default=simple'])] };
    },
  },

  checkout: {
    plan(r, p) {
      const b = safeName(localBranch(r, p.branch).name);
      if (r.git.dirty > 0) fail('Uncommitted changes: commit them first.');
      return { risk: 'safe', title: `Switch to ${b}`, uses: ['switch'], target: `refs/heads/${b}`, steps: [git(['switch', '--no-recurse-submodules', '--end-of-options', b], r.path)] };
    },
  },

  'create-branch': {
    plan(r, p) {
      if (!validBranch(p.name)) fail('Invalid branch name.');
      if ((r.git.branches || []).some((b) => b.name === p.name)) fail(`Branch "${p.name}" already exists.`);
      const from = p.from ? safeName(localBranch(r, p.from).name) : null;
      return { risk: 'safe', title: `Create and switch to ${p.name}${from ? ` from ${from}` : ''}`, uses: ['switch'], target: from ? `refs/heads/${from}` : null, steps: [git(['switch', '--no-recurse-submodules', '-c', p.name, ...(from ? ['--end-of-options', from] : [])], r.path)], undo: `git switch ${r.git.branch || '-'} && git branch -d ${p.name}` };
    },
  },

  'merge-branch': {
    plan(r, p) {
      if (r.git.detached) fail('Detached HEAD.');
      const b = localBranch(r, p.branch);
      if (b.current) fail('Cannot merge a branch into itself.');
      const name = safeName(b.name);
      const cur = safeName(r.git.branch, 'Refusing to merge into it');
      if (r.git.dirty > 0) fail('Uncommitted changes: commit them first.');
      const noff = p.mode === 'no-ff';
      return {
        risk: 'caution', uses: ['merge'], target: `refs/heads/${name}`,
        title: `Merge ${name} into ${cur}${noff ? ' (merge commit)' : ' (fast-forward only)'}`,
        steps: [git([...(noff ? ['merge', '--no-ff', '--no-edit'] : ['merge', '--ff-only']), '--end-of-options', name], r.path, undefined, ['-c', `branch.${cur}.mergeOptions=`])],
        undo: 'git reset --hard ORIG_HEAD   (only if you have not made further commits)',
      };
    },
  },

  'delete-local': {
    async plan(r, p, ctx) {
      const b = localBranch(r, p.branch);
      if (b.current) fail('Cannot delete the branch you are on.');
      const name = safeName(b.name);
      const force = !!p.force;
      if (!force && !(r.git.mergedBranches || []).includes(name)) fail(`"${name}" is not merged into the default branch. Use force delete if you are sure.`);
      const sha = (await readGit(ctx, ['rev-parse', '--verify', '--quiet', '--short', `refs/heads/${name}`], r.path)).stdout.trim();
      return { risk: force ? 'danger' : 'caution', title: `${force ? 'FORCE ' : ''}delete local branch ${name}`, uses: ['ref-update'], steps: [git(['branch', force ? '-D' : '-d', '--', name], r.path)], undo: sha ? `git branch ${name} ${sha}` : undefined };
    },
  },

  'delete-merged': {
    plan(r, p) {
      const names = Array.isArray(p.branches) ? p.branches : [];
      const merged = r.git.mergedBranches || [];
      if (!names.length || !names.every((b) => merged.includes(b) && validBranch(b))) fail('Branch list does not match the merged branches found in the last scan.');
      return { risk: 'caution', title: `Delete ${names.length} merged local branch${names.length > 1 ? 'es' : ''}`, uses: ['ref-update'], steps: [git(['branch', '-d', '--', ...names], r.path)], warnings: [names.join(', ')] };
    },
  },

  'delete-remote': {
    plan(r, p) {
      needRemote(r);
      const rb = (r.git.remoteBranches || []).find((x) => x.name === p.branch) || fail(`"${cleanText(String(p.branch), 60)}" is not a known remote branch.`);
      const name = safeName(rb.name);
      if (name === defaultBranch(r)) fail('Refusing to delete the default branch.');
      const pr = (r.prs || []).find((x) => x.headRefName === name);
      if (pr) fail(`PR #${pr.number} is open from this branch. Close or merge it first.`);
      // An explicit delete refspec, and nothing else: no mirror, tags or submodules from config.
      const args = ['push', '--no-follow-tags', '--recurse-submodules=no', '--', 'origin', `:refs/heads/${name}`];
      return { risk: 'danger', title: `Delete remote branch origin/${name}`, uses: ['push'], remotes: ['origin'], pushes: true, steps: [git(args, r.path, undefined, ['-c', 'remote.origin.mirror=false'])], undo: `git push origin <sha>:refs/heads/${rb.name}   (find the sha with git reflog)` };
    },
  },

  'commit-all': {
    async plan(r, p, ctx) {
      const msg = cleanText(p.message, 300);
      if (!msg) fail('A commit message is required.');
      if (r.git.dirty === 0) fail('Nothing to commit.');
      if (r.git.detached) fail('Detached HEAD.');
      // -uall lists each file inside an untracked folder, so one added there after the preview is caught.
      // trimEnd, not trim: the first line's leading space is part of its status (" M a").
      // --ignore-submodules=dirty: never look inside a submodule, whose own config runs its filters.
      const st = (await readGit(ctx, ['status', '--short', '-uall', '--ignore-submodules=dirty'], r.path)).stdout.trimEnd();
      // `git add -A` would commit a key or an env file as readily as code: refuse, and say how to fix it.
      const secrets = st.split('\n').filter((l) => l && l[1] !== 'D' && l[0] !== 'D').map(statusPath).filter(looksSecret);
      if (secrets.length) fail(`These files look like secrets or keys and would be committed:\n${secrets.slice(0, 10).join('\n')}${secrets.length > 10 ? `\n...and ${secrets.length - 10} more` : ''}\nAdd them to .gitignore (or move them out of the repo), then plan the commit again.`);
      // `git add -A` must stage exactly what was previewed: the check step refuses if anything changed since.
      // Fewer files is fine (a .gitignore added just before can hide some); any file not listed stops it.
      // afterGitignore: Fix all adds .gitignore rules just before this commit, so .gitignore itself may
      // show up as changed or new; it is committed with the rest.
      const also = p.afterGitignore === true && !st.split('\n').some((l) => statusPath(l) === '.gitignore') ? [' M .gitignore', '?? .gitignore'] : [];
      const check = { kind: 'check', cmd: 'git', safeGit: true, args: ['status', '--short', '-uall', '--ignore-submodules=dirty'], cwd: r.path, expect: [st, ...also].join('\n'), subset: true, display: 'check no file outside the list below has changed' };
      const list = st.split('\n').slice(0, 40).join('\n') + (also.length ? '\n.gitignore (the rules added just before)' : '');
      return { risk: 'caution', title: `Commit all changes on ${r.git.branch}`, uses: ['commit'], steps: [check, git(['add', '-A'], r.path), git(['commit', '-m', msg], r.path)], warnings: ['Files to be committed:\n' + list], undo: 'git reset --soft HEAD~1' };
    },
  },

  // Forget worktrees whose folders no longer exist. Never touches a worktree that is still on disk.
  'worktree-prune': {
    plan: (r) => ({ risk: 'safe', title: 'Prune stale worktrees', steps: [git(['worktree', 'prune', '-v'], r.path)], note: 'Only removes git\'s records of worktrees whose folders are already gone.' }),
  },

  'add-file': {
    async plan(r, p, ctx) {
      const t = TEMPLATES[p.template] || fail('Unknown template.');
      const target = path.join(r.path, t.file);
      if (!target.startsWith(r.path + path.sep)) fail('Bad path.');
      if (ctx.fs.existsSync(target)) fail(`${t.file} already exists.`);
      const author = (await readGit(ctx, ['config', 'user.name'], r.path)).stdout.trim();
      if (!author && p.template === 'license') fail('Set your name first (git config user.name "Your Name"): the licence names the copyright holder.');
      const manifests = (r.deps && r.deps.manifests) || [];
      const content = t.build({ author: author || 'Author', name: path.basename(r.path), manifests, ecosystems: findEcosystems(r.path), stacks: detectStacks(r.path), owner: r.remote && r.remote.owner, hasWorkflows: !!r.hasWorkflows, branch: (r.remote && r.remote.defaultBranch) || r.git.branch || 'main' });
      const steps = [{ kind: 'write', root: r.path, path: target, content, display: `write ${t.file} (${content.length} bytes)`, preview: content.split('\n').slice(0, 14).join('\n') }];
      if (p.commit) steps.push(git(['add', '--', t.file], r.path), git(['commit', '-m', `Add ${t.label}`, '--', t.file], r.path));
      return { risk: p.commit ? 'caution' : 'safe', title: `Add ${t.file}${p.commit ? ' and commit it' : ''}`, uses: p.commit ? ['commit'] : [], steps, undo: p.commit ? 'git reset --soft HEAD~1 && git rm --cached ' + t.file : `rm ${t.file}` };
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
      // A new ".env.*" would re-ignore an earlier "!.env.example": the last matching rule wins, so the
      // template's exception goes after it again.
      if (add.includes('.env.*') && !add.includes('!.env.example')) add.push('!.env.example');
      if (!add.length) fail('.gitignore already has those rules.');
      const content = add.join('\n') + '\n';
      return { risk: 'safe', title: `Add ${add.length} rule${add.length > 1 ? 's' : ''} to .gitignore`, steps: [{ kind: 'append', root: r.path, path: target, content, display: `append to .gitignore: ${add.join('  ')}`, preview: content }], undo: 'Delete the added lines from .gitignore.' };
    },
  },
};


// GitHub-side actions live in actions-github.js, built with this file's step builders.
Object.assign(ACTIONS, require('./actions-github')({ fail, gh, needRemote, defaultBranch, localBranch, cleanText, readGh: (ctx, args, cwd) => ctx.run('gh', args, { cwd }) }));

// AI agent actions live in actions-agent.js; their plan errors read like this file's.
const AGENT = require('./actions-agent');
for (const t of ['permissions-prune', 'split-instructions', 'lsp-setup']) ACTIONS[t] = AGENT[t];

async function plan(repo, action, ctx = {}) {
  ctx = defaultCtx(ctx);
  try {
    if (!repo) fail('Unknown repo.');
    if (!action || typeof action.type !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, action.type)) fail('Unknown action.');
    if (ctx.readOnly) fail('Read-only mode is on. Turn it off in the header to make changes.');
    const out = await ACTIONS[action.type].plan(repo, action, ctx);
    // The repo's own network programs and non-network remotes refuse the plan; its hooks and
    // drivers make it caution (B9, B10).
    const code = await inspect(ctx, repo.path, out, fail);
    const risk = code.runsRepoCode && RISK[out.risk] < RISK.caution ? 'caution' : out.risk;
    return {
      ok: true,
      type: action.type,
      repoPath: repo.path,
      repoName: repo.name,
      title: out.title,
      risk,
      steps: out.steps,
      display: out.steps.map((s) => ({ text: s.display, preview: s.preview, note: s.note })),
      warnings: [...(out.warnings || []), ...code.warnings],
      // Fix all leaves these out of what it runs on its own (renderer/fix-all.js).
      runsRepoCode: code.runsRepoCode,
      // What recheck() inspects again just before the plan runs.
      inspected: { uses: out.uses || [], remotes: out.remotes || [], pushes: !!out.pushes, target: out.target || null },
      undo: out.undo || null,
      body: out.body || null,
      note: [out.note, code.note].filter(Boolean).join(' ') || null,
      confirmName: RISK[risk] >= RISK.danger ? repo.name : null,
    };
  } catch (e) {
    if (e instanceof PlanError || e instanceof AGENT.PlanError) return { ok: false, error: e.message, ...(e.nothing ? { nothing: true } : {}) };
    return { ok: false, error: 'Could not plan action: ' + (e && e.message) };
  }
}

// Just before a stored plan runs: inspect the repo again, since an earlier plan in the same batch
// (a pull) can bring files that add hooks, filters or settings. Returns why the plan is held, or null.
async function recheck(p, ctx = {}) {
  if (!p || !p.inspected) return null;
  const held = (why) => `Held: the repo changed after the preview. ${why} Review it again.`;
  try {
    const code = await inspect(defaultCtx(ctx), p.repoPath, p.inspected, fail);
    const fresh = code.warnings.filter((w) => !(p.warnings || []).includes(w));
    if ((code.runsRepoCode && !p.runsRepoCode) || fresh.length) return held(fresh.join(' '));
  } catch (e) { return held(e.message); }
  return null;
}

// Execute a plan produced by plan(). Stops at the first failing step.
module.exports = { plan, apply, recheck };
