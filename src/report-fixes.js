// Fix steps for the hygiene findings (checks-hygiene.js and the updated settings/file checks).
// Every step names its source in `ref`, so the person or LLM can check the advice before acting.
// Phases are the report's PHASES indexes: 0 protect secrets and access, 1 save work, 2 CI/PRs,
// 3 project files, 4 dependencies, 5 branches, 6 clutter, 7 settings and housekeeping.

const { sq } = require('./util');
const { historyVerdict } = require('./history');

const GH = 'https://docs.github.com/en/';
const REFS = {
  injection: GH + 'actions/reference/security/secure-use#good-practices-for-mitigating-script-injection-attacks',
  prTarget: GH + 'actions/reference/security/secure-use#mitigating-the-risks-of-untrusted-code-checkout',
  pinning: GH + 'actions/reference/security/secure-use#using-third-party-actions',
  permissions: 'https://github.com/ossf/scorecard/blob/main/docs/checks.md#token-permissions',
  selfHosted: GH + 'actions/reference/security/secure-use#hardening-for-self-hosted-runners',
  dependabot: GH + 'code-security/dependabot/working-with-dependabot/dependabot-options-reference',
  largeFiles: GH + 'repositories/working-with-files/managing-large-files/about-large-files-on-github',
  sensitive: GH + 'authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository',
  stash: 'https://git-scm.com/docs/git-stash',
  worktree: 'https://git-scm.com/docs/git-worktree',
  branch: 'https://git-scm.com/docs/git-branch',
  gc: 'https://git-scm.com/docs/git-gc',
  maintenance: 'https://git-scm.com/docs/git-maintenance',
  submodule: 'https://git-scm.com/docs/git-submodule',
  lineEndings: GH + 'get-started/git-basics/configuring-git-to-handle-line-endings',
  editorconfig: 'https://editorconfig.org/',
  changelog: 'https://keepachangelog.com/en/1.1.0/',
  readme: 'https://github.com/RichardLitt/standard-readme/blob/main/spec.md',
  engines: 'https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines',
  codeowners: GH + 'repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners',
  issueTemplates: GH + 'communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository',
  topics: GH + 'repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics',
  security: GH + 'code-security/getting-started/adding-a-security-policy-to-your-repository',
  secretScanning: GH + 'code-security/secret-scanning/introduction/about-secret-scanning',
  pushProtection: GH + 'code-security/secret-scanning/introduction/about-push-protection',
  codeScanning: GH + 'code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning',
  pvr: GH + 'code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository',
  securityUpdates: GH + 'code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates',
  autoDelete: GH + 'repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches',
  rulesets: GH + 'repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets',
  license: GH + 'repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository',
  healthFiles: GH + 'communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file',
};

function hygieneFix(id, r) {
  const slug = r.remote && !r.remote.unreachable ? `${r.remote.owner}/${r.remote.name}` : null;
  const api = (p) => (slug ? sq(`repos/${slug}${p}`) : `repos/OWNER/REPO${p}`);
  const h = r.hygiene || {};
  const steps = {
    'remote-credentials': { phase: 0, rank: 3, why: 'A token in .git/config is readable by anything that can read the repo folder.', cmds: ['git remote get-url origin   # shows the token: do NOT paste the output anywhere', `git remote set-url origin ${sq(r.originUrl || 'https://github.com/OWNER/REPO.git')}`, 'gh auth setup-git   # let gh supply credentials instead'], note: 'Revoke the token at its provider first (GitHub: Settings > Developer settings). Never print or copy the old URL.', ref: REFS.sensitive },
    'wf-injection': { phase: 0, rank: 4, why: 'Untrusted text (PR titles, branch names, issue bodies) is expanded inside a shell script, so an attacker can run commands with the workflow\'s token and secrets.', cmds: [], note: 'In each listed run: step, move the expression into env: (for example `env: TITLE: ${{ github.event.pull_request.title }}`) and use "$TITLE" in the script, quoted. Do not change what the step does.', ref: REFS.injection },
    'wf-pr-target': { phase: 0, rank: 5, why: 'pull_request_target and workflow_run run with write access and secrets; checking out the PR head runs an outsider\'s code with them.', cmds: [], note: 'Prefer the plain pull_request trigger. If privileges are really needed, split the workflow: an unprivileged pull_request job builds/tests, and a workflow_run job that never checks out PR code does the privileged part. Ask the owner before changing triggers.', ref: REFS.prTarget },
    'wf-pr-target-review': { phase: 7, rank: 9, why: 'A privileged trigger is in use.', cmds: [], note: 'Confirm none of these workflows check out or run code from the pull request.', ref: REFS.prTarget },
    'wf-write-all': { phase: 0, rank: 6, why: 'Every job gets every write scope, so one compromised step can do anything.', cmds: [], note: 'Replace write-all with `permissions: contents: read` at the top and grant specific write scopes only on the jobs that need them.', ref: REFS.permissions },
    'wf-permissions': { phase: 0, rank: 7, why: 'Without a permissions block the token gets the repository default, which may include write access.', cmds: [], note: 'Add `permissions:\\n  contents: read` at the top of each listed workflow; add job-level permissions where a job must write (releases, comments, packages).', ref: REFS.permissions },
    'wf-unpinned': { phase: 0, rank: 8, why: 'A tag can be moved to different code, so the workflow may run something you never reviewed.', cmds: ['gh api repos/OWNER/ACTION/commits/TAG --jq .sha   # the SHA a tag points at now'], note: 'Replace each `uses: owner/action@tag` with `uses: owner/action@<full 40-char SHA> # tag`, taking the SHA from the action\'s own repository. Keep Dependabot (github-actions) enabled so the pins get update PRs.', ref: REFS.pinning },
    'wf-self-hosted': { phase: 0, rank: 9, why: 'On a public repo anyone can open a PR that runs on that machine.', cmds: [], note: 'Use GitHub-hosted runners for public repos, or restrict the self-hosted runner to trusted events. Ask the owner.', ref: REFS.selfHosted },
    'dependabot-no-actions': { phase: 4, rank: 6, why: 'Pinned actions never get updates without it.', cmds: [], note: 'Add to .github/dependabot.yml under updates:\\n  - package-ecosystem: "github-actions"\\n    directory: "/"\\n    schedule:\\n      interval: "weekly"', ref: REFS.dependabot },
    'git-no-commits': { phase: 1, rank: 5, why: 'Nothing is recorded yet.', cmds: ['git status', 'git add <files>', 'git commit -m "Initial commit"'], note: 'Check for secrets and clutter before the first commit.' },
    'git-stashes': { phase: 1, rank: 6, why: 'Stashes are easy to forget and cannot be recovered once dropped.', cmds: ['git stash list', 'git stash show -p stash@{0}   # review each one', 'git stash branch <new-branch> stash@{0}   # keep it as a branch'], note: 'Ask the owner per stash: keep as a branch, or drop with git stash drop. Never run git stash clear.', ref: REFS.stash },
    'git-gone': { phase: 5, rank: 2, why: 'Their remote branches were deleted (usually after a merged PR).', cmds: [...(h.goneBranches || []).slice(0, 20).map((b) => `git branch -d ${sq(b)}`)], note: '-d refuses to delete unmerged work; if it refuses, show the owner `git log origin/HEAD..<branch>` and ask before using -D.', ref: REFS.branch },
    'git-worktrees': { phase: 7, rank: 6, why: 'Git still tracks worktrees whose folders are gone.', cmds: ['git worktree prune -n -v   # preview', 'git worktree prune -v'], note: 'If a folder was moved rather than deleted, use git worktree repair instead.', ref: REFS.worktree },
    'git-submodules': { phase: 7, rank: 7, why: 'Code the project depends on is missing from this checkout.', cmds: ['git submodule status', 'git submodule update --init --recursive'], ref: REFS.submodule },
    'remote-http': { phase: 0, rank: 10, why: 'http:// sends code and credentials unencrypted.', cmds: [`git remote set-url origin ${sq((r.originUrl || '').replace(/^http:/i, 'https:') || 'https://github.com/OWNER/REPO.git')}`] },
    'repo-size': sizeStep(h.history),
    'history-large-blobs': { phase: 7, rank: 8, why: 'Every clone downloads these, and GitHub rejects pushes with files over 100 MB.', cmds: [...((h.historyBlobs || []).slice(0, 5).map((b) => `git log --all --oneline --find-object=${b.id}   # ${(b.size / 1048576).toFixed(0)} MB`))], note: 'Find which file each object is, then ask the owner: keep, move to Git LFS (git lfs migrate import), or remove with git filter-repo. Both rewrite history; back up first and coordinate before any force-push.', ref: REFS.largeFiles },
    'git-loose': { phase: 7, rank: 9, why: 'Unpacked objects waste space and slow git down.', cmds: ['git count-objects -vH', 'git gc   # safe default; do not use --prune=now', 'git maintenance start   # optional: keep it tidy automatically'], ref: REFS.gc },
    'git-garbage': { phase: 7, rank: 9, why: 'Stray files in .git/objects are left by interrupted commands.', cmds: ['git count-objects -vH', 'git fsck --connectivity-only --no-dangling'], note: 'Report what fsck says to the owner before deleting anything inside .git.', ref: REFS.gc },
    'readme-thin': { phase: 3, rank: 2, why: 'People cannot tell what the project does or how to run it.', cmds: [], note: 'Add: a one-line description, Install, Usage (with a runnable example), Contributing and License sections, using facts from the code and manifest only.', ref: REFS.readme },
    'no-changelog': { phase: 3, rank: 7, why: 'Users cannot see what changed between versions.', cmds: ['git tag --sort=-creatordate | head', `gh release create <tag>${slug ? ` -R ${slug}` : ''} --generate-notes   # or keep CHANGELOG.md`], note: 'Either publish GitHub releases with notes for each tag, or add CHANGELOG.md in Keep a Changelog format (newest first, ## [x.y.z] - YYYY-MM-DD). Do not paste raw git logs.', ref: REFS.changelog },
    'no-gitattributes': { phase: 3, rank: 8, why: 'Line endings depend on each contributor\'s settings.', cmds: ["printf '* text=auto\\n' > .gitattributes", 'git add --renormalize .', 'git status   # review what changed before committing'], note: 'Commit pending work first. Add explicit rules (e.g. *.sh text eol=lf, *.png binary) if the project needs them.', ref: REFS.lineEndings },
    'no-editorconfig': { phase: 3, rank: 9, why: 'Editors disagree on indentation and whitespace.', cmds: [], note: 'Add .editorconfig with root = true and the indentation the code already uses (check a few files first; do not reformat the project).', ref: REFS.editorconfig },
    'no-runtime-pin': { phase: 4, rank: 7, why: 'Developers and CI may run different language versions.', cmds: [], note: 'Pin the version the project is tested with: .nvmrc or "engines" in package.json for Node, .python-version or requires-python for Python. Match the version used in CI.', ref: REFS.engines },
    'no-codeowners': { phase: 3, rank: 10, why: 'Nobody is requested automatically to review changes, including workflow changes.', cmds: [], note: 'Add .github/CODEOWNERS, e.g. `* @owner` and `/.github/workflows/ @owner`. Ask the owner who should own what.', ref: REFS.codeowners },
    'no-issue-templates': { phase: 3, rank: 11, why: 'Bug reports arrive without the details you need.', cmds: [], note: 'Add .github/ISSUE_TEMPLATE/bug_report.yml (name, description, body fields) and optionally config.yml with contact_links.', ref: REFS.issueTemplates },
    'no-topics': { phase: 7, rank: 10, why: 'Topics make the project discoverable.', cmds: slug ? [`gh repo edit ${slug} --add-topic <topic>`] : [], note: 'Up to 20 lowercase topics, letters, numbers and hyphens. Topics are always public.', ref: REFS.topics },
    'no-auto-delete': { phase: 7, rank: 2, why: 'Merged PR branches pile up on GitHub.', cmds: slug ? [`gh repo edit ${slug} --delete-branch-on-merge`] : [], ref: REFS.autoDelete },
    'secret-scanning-off': { phase: 0, rank: 11, why: 'GitHub would alert you to committed credentials.', cmds: [`echo '{"security_and_analysis":{"secret_scanning":{"status":"enabled"}}}' | gh api -X PATCH ${api('')} --input -`], ref: REFS.secretScanning },
    'push-protection-off': { phase: 0, rank: 12, why: 'Known secret formats would be blocked before they are pushed.', cmds: [`echo '{"security_and_analysis":{"secret_scanning_push_protection":{"status":"enabled"}}}' | gh api -X PATCH ${api('')} --input -`], ref: REFS.pushProtection },
    'security-updates-off': { phase: 4, rank: 3, why: 'Vulnerable dependencies will not get fix PRs automatically.', cmds: [`gh api -X PUT ${api('/automated-security-fixes')}`], ref: REFS.securityUpdates },
    'code-scanning-off': { phase: 7, rank: 3, why: 'Common vulnerabilities in the code go unnoticed.', cmds: [`gh api -X PATCH ${api('/code-scanning/default-setup')} -f state=configured`], note: 'Needs GitHub Actions enabled. Results appear under Security > Code scanning.', ref: REFS.codeScanning },
    'private-reporting-off': { phase: 7, rank: 4, why: 'Researchers otherwise have to report vulnerabilities in public.', cmds: [`gh api -X PUT ${api('/private-vulnerability-reporting')}`], ref: REFS.pvr },
  };
  return steps[id] || null;
}

// The repo-size step depends on where the space is (history.js, deep scans). History rewrites are
// listed as options for the owner with a backup first; they are never part of an automatic plan.
function sizeStep(hist) {
  const base = { phase: 7, rank: 8, why: 'Large repositories are slow to clone and GitHub may ask you to reduce them.', ref: REFS.largeFiles };
  if (!hist) return { ...base, cmds: ['git count-objects -vH', 'git lfs migrate info --everything --above=10MB   # what is taking the space (needs git-lfs)'], note: 'Run a GutCheck Deep scan first: it shows whether the space is current files or old history. Moving history to LFS or stripping blobs rewrites history: never do it without the owner, and never force-push a shared branch without coordinating.' };
  const big = hist.folders.slice(0, 3).map((f) => f.name);
  const bin = hist.extensions.slice(0, 4).map((e) => `"*.${e.name}"`).join(' ');
  const cmds = [
    '# 1. Stop it growing (no rewrite): track big binaries with Git LFS from now on',
    `git lfs track ${bin}`,
    'git add .gitattributes && git commit -m "Track binaries with Git LFS"',
    '# 2. Keep generated or archived files out of git (no rewrite; history keeps old copies)',
    ...big.filter((f) => /archive|_out|cache|build|dist|shots/i.test(f)).map((f) => `git rm -r --cached -- ${sq(f.replace(/\/$/, ''))}   # then add it to .gitignore`),
  ];
  if (hist.rewriteWorthIt || hist.historyOnly >= 200 * 1024 * 1024) cmds.push(
    '# 3. Only with the owner: shrink history (rewrites every commit id, needs a force-push)',
    'git clone --mirror . ../backup-before-rewrite.git   # full backup first',
    'git filter-repo --analyze   # needs git-filter-repo; review .git/filter-repo/analysis',
    ...hist.deletedFolders.filter((f) => f.bytes >= 10 * 1024 * 1024).slice(0, 3).map((f) => `git filter-repo --invert-paths --path ${sq(f.name)}   # folder no longer in the tree: removes only old files`),
    'git lfs migrate import --everything --include=' + sq(hist.extensions.slice(0, 4).map((e) => `*.${e.name}`).join(',')) + '   # or move old binaries into LFS',
  );
  return { ...base, why: historyVerdict(hist), cmds, note: 'Steps 1 and 2 are safe and stop the growth. Step 3 rewrites history: do it only if the owner asks, after the backup, then force-push every branch and tag and tell everyone with a clone to re-clone. GitHub LFS storage has quotas. Encrypted files (git-crypt, if used) must stay listed in .gitattributes after any rewrite.' };
}

module.exports = { hygieneFix, sizeStep, REFS };
