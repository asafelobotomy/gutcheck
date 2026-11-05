// Hygiene checks added from GitHub's docs, the OpenSSF Scorecard and community conventions.
// Each finding cites its source in report.js (REFS), so the advice can be checked by a human.

const { plural, list } = require('./util');

const MiB = 1024;           // storage figures are in KiB
const GiB = 1024 * MiB;
const REPO_WARN_KIB = GiB;  // GitHub: repositories ideally under 1 GB...
const REPO_ERR_KIB = 5 * GiB; // ...and strongly recommended under 5 GB
const LOOSE_MAX = 6700;     // git's gc.auto default: above this, git itself would repack
const STASH_WARN = 10;
const README_MIN_BYTES = 300;

// GitHub Actions: GitHub's secure-use guide and Scorecard (Dangerous-Workflow, Token-Permissions, Pinned-Dependencies).
function checkWorkflows(s) {
  const w = s.hygiene && s.hygiene.workflows;
  if (!w || !w.files) return [];
  const out = [];
  const add = (id, severity, title, detail, extra = {}) => out.push({ id, category: 'Actions security', severity, title, detail, ...extra });
  if (w.injections.length) add('wf-injection', 'error', `${plural(w.injections.length, 'possible script injection')} in workflows`, `${list(w.injections.map((x) => `${x.file}:${x.line} uses ${x.expr} inside run:`), 4)}. Attacker-controlled text is pasted into a shell script.`);
  const pwn = w.prTarget.filter((p) => p.headCheckout);
  if (pwn.length) add('wf-pr-target', 'error', 'Privileged workflow checks out pull request code', `${list(pwn.map((p) => p.file), 4)}: pull_request_target/workflow_run with a checkout of the PR head can hand repo secrets and write access to any contributor.`);
  else if (w.prTarget.length) add('wf-pr-target-review', 'info', 'Workflow uses pull_request_target or workflow_run', `${list(w.prTarget.map((p) => p.file), 4)}. These run with write access and secrets; keep them away from untrusted PR code.`);
  if (w.writeAll.length) add('wf-write-all', 'warn', 'Workflow grants write-all permissions', `${list(w.writeAll, 4)}. Grant only the scopes each job needs.`);
  const noPerm = w.noPermissions.filter((p) => !p.jobLevel);
  if (noPerm.length) add('wf-permissions', 'warn', `${plural(noPerm.length, 'workflow')} without a permissions block`, `${list(noPerm.map((p) => p.file), 4)}. The GITHUB_TOKEN then gets the repo default, which may be read/write.`);
  if (w.unpinned.length) add('wf-unpinned', 'warn', `${plural(w.unpinned.length, 'action')} not pinned to a commit SHA`, `${list([...new Set(w.unpinned.map((u) => u.uses))], 5)}. Tags can be moved to point at different code.`);
  if (w.selfHosted.length && s.remote && s.remote.isPublic) add('wf-self-hosted', 'warn', 'Self-hosted runner on a public repo', `${list(w.selfHosted, 4)}. Anyone who can open a PR may run code on that machine.`);
  if (s.files && s.files.dependabotConfig && s.files.dependabotActions === false) add('dependabot-no-actions', 'info', 'Dependabot does not update your GitHub Actions', 'Add a github-actions entry to .github/dependabot.yml so pinned SHAs get update PRs.');
  return out;
}

// Local git housekeeping and storage (git docs, GitHub's large-file guidance).
function checkGitHygiene(s) {
  const h = s.hygiene;
  if (!h) return [];
  const out = [];
  const add = (id, severity, title, detail, extra = {}) => out.push({ id, category: 'Git hygiene', severity, title, detail, ...extra });
  if (h.remote === 'credentials') add('remote-credentials', 'error', 'Credentials are stored in the origin URL', 'Anyone who can read .git/config (or a backup of it) has this token. Rotate it and use a credential helper or SSH.');
  else if (h.remote === 'http') add('remote-http', 'warn', 'Origin uses unencrypted http://', 'Code and credentials travel in clear text. Switch the remote to https:// or SSH.');
  if (h.noCommits) add('git-no-commits', 'warn', 'Repository has no commits', 'Nothing is recorded yet, so nothing can be pushed or recovered.');
  if (h.stashes) add('git-stashes', h.stashes >= STASH_WARN ? 'warn' : 'info', `${plural(h.stashes, 'stash entry', 'stash entries')}`, 'Stashed work is easy to forget and is lost if the stash is cleared. Turn what you need into commits or branches.');
  if (h.goneBranches.length) add('git-gone', 'info', `${plural(h.goneBranches.length, 'branch', 'branches')} whose upstream was deleted`, list(h.goneBranches, 8));
  if (h.prunableWorktrees) add('git-worktrees', 'info', `${plural(h.prunableWorktrees, 'stale worktree')}`, 'Their folders are gone but git still tracks them.', { fix: { type: 'worktree-prune', label: 'Prune worktrees' } });
  if (h.submodulesUninit) add('git-submodules', 'info', `${plural(h.submodulesUninit, 'submodule')} not initialised`, 'The code they point to is missing from this checkout.');
  const st = h.storage;
  if (st.packKiB >= REPO_ERR_KIB) add('repo-size', 'error', `Repository is ${(st.packKiB / GiB).toFixed(1)} GB`, 'GitHub strongly recommends staying under 5 GB. Move large files to Git LFS or release assets.');
  else if (st.packKiB >= REPO_WARN_KIB) add('repo-size', 'warn', `Repository is ${(st.packKiB / GiB).toFixed(1)} GB`, 'GitHub recommends keeping repositories under 1 GB.');
  if (st.loose > LOOSE_MAX) add('git-loose', 'info', `${st.loose.toLocaleString()} loose git objects`, 'More than git\'s own auto-gc threshold. Packing them saves space and speeds git up.');
  if (st.garbage) add('git-garbage', 'warn', `${plural(st.garbage, 'stray file')} in the object store`, 'Run git count-objects -vH to see them; usually left by an interrupted git command.');
  if (h.historyBlobs && h.historyBlobs.length) {
    const big = h.historyBlobs[0].size;
    add('history-large-blobs', big > 100 * 1024 * 1024 ? 'error' : 'warn', `${plural(h.historyBlobs.length, 'file')} of 50 MB+ in git history`, `Largest ${(big / 1048576).toFixed(0)} MB. GitHub warns at 50 MB and rejects files over 100 MB; every clone downloads them.`);
  }
  return out;
}

// Project conventions (GitHub community profile, Keep a Changelog, EditorConfig, runtime pinning).
function checkProject(s) {
  const p = s.hygiene && s.hygiene.project;
  if (!p || (s.hygiene && s.hygiene.noCommits)) return [];
  const out = [];
  const pub = !!(s.remote && s.remote.isPublic && !s.remote.isFork);
  const add = (id, severity, title, detail, extra = {}) => out.push({ id, category: 'Project setup', severity, title, detail, ...extra });
  if (p.readme && (p.readme.bytes < README_MIN_BYTES || (!p.readme.usage && s.deps && s.deps.manifests.length)))
    add('readme-thin', 'info', p.readme.bytes < README_MIN_BYTES ? 'README is nearly empty' : 'README has no install or usage section', 'Say what the project does, how to install it and how to use it (Standard Readme / makeareadme).');
  const released = (s.hygiene.tags > 0) && !(s.remote && s.remote.latestRelease);
  if (released && !p.changelog) add('no-changelog', 'info', 'Tags but no changelog or GitHub releases', 'Users cannot see what changed between versions. Keep a CHANGELOG.md or publish GitHub releases with notes.');
  if (!p.gitattributes) add('no-gitattributes', 'info', 'No .gitattributes', 'Line endings then depend on each contributor\'s settings. "* text=auto" normalises them for everyone.');
  if (!p.editorconfig) add('no-editorconfig', 'info', 'No .editorconfig', 'Editors will not agree on indentation, charset or final newlines.');
  if (p.runtime && !p.runtime.pinned) add('no-runtime-pin', 'info', `${p.runtime.kind} version not pinned`, p.runtime.kind === 'Node' ? 'Add .nvmrc (or "engines" in package.json) so everyone and CI use the same Node.' : 'Add .python-version or requires-python in pyproject.toml.');
  if (pub) {
    if (s.hasWorkflows && !p.codeowners) add('no-codeowners', 'info', 'No CODEOWNERS file', 'Nobody is automatically asked to review changes, including changes to workflows.');
    if (s.remote.hasIssues && !p.issueTemplates) add('no-issue-templates', 'info', 'No issue templates', 'Templates in .github/ISSUE_TEMPLATE get you the details you need in bug reports.');
    if (s.remote.topics === 0) add('no-topics', 'info', 'No repository topics', 'Topics make the project discoverable on GitHub.');
  }
  return out;
}

// Security features (GitHub docs). Only read for repos you administer; public repos get them free.
function checkSecurityFeatures(s) {
  const f = s.security;
  if (!f || !s.remote) return [];
  const out = [];
  const pub = s.remote.isPublic;
  const add = (id, severity, title, detail, fix) => out.push({ id, category: 'Security features', severity, title, detail, fix });
  if (pub && f.secretScanning === 'disabled') add('secret-scanning-off', 'warn', 'Secret scanning is off', 'GitHub would alert you to committed tokens and keys (free for public repos).', { type: 'security-enable', label: 'Enable secret scanning', feature: 'secret-scanning' });
  if (pub && f.pushProtection === 'disabled') add('push-protection-off', 'warn', 'Push protection is off', 'Pushes containing known secret formats would be blocked before they land.', { type: 'security-enable', label: 'Enable push protection', feature: 'push-protection' });
  if (f.securityUpdates === 'disabled' && s.deps && s.deps.manifests.length) add('security-updates-off', 'info', 'Dependabot security updates are off', 'Fix PRs for vulnerable dependencies will not be opened.', { type: 'security-enable', label: 'Enable security updates', feature: 'security-fixes' });
  if (pub && f.codeScanning === 'not-configured' && !(s.hygiene && s.hygiene.workflows && s.hygiene.workflows.codeql)) add('code-scanning-off', 'info', 'Code scanning (CodeQL) is not set up', 'Default setup finds common vulnerabilities on every push, free for public repos.', { type: 'security-enable', label: 'Enable CodeQL default setup', feature: 'code-scanning' });
  if (pub && f.privateReporting === false) add('private-reporting-off', 'info', 'Private vulnerability reporting is off', 'Researchers then have to report security issues in public.', { type: 'security-enable', label: 'Enable private reporting', feature: 'private-reporting' });
  return out;
}

module.exports = { checkWorkflows, checkGitHygiene, checkProject, checkSecurityFeatures, REPO_WARN_KIB, LOOSE_MAX };
