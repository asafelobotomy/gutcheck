// One repo that is on GitHub but not cloned in the workspace, scanned from GutCheck's cache clone
// (remote-cache.js) with the same collectors and checks as a local repo. Checks that describe a
// working copy (uncommitted work, stashes, branches, local git state, the origin URL, installed
// dependencies, storage) are left out: the cache clone is GutCheck's, not the user's. With no clone
// (too large, or the clone failed) only the GitHub-side checks run.

const fs = require('node:fs');
const path = require('node:path');
const { run, SAFE_GIT_ENV } = require('./exec');
const scanner = require('./scanner');
const { defaultUrlFor } = require('./remote-cache');
const { branchFindings } = require('./remote-branches');

const WORKING_COPY_IDS = Object.freeze([
  'git-ahead', 'git-behind', 'git-detached', 'git-dirty', 'git-garbage', 'git-gone', 'git-identity', 'git-maintenance',
  'git-merged', 'git-no-upstream', 'git-op', 'git-stale', 'git-stashes', 'git-submodules', 'git-upstream-gone', 'git-worktrees',
  'git-unpushed-branches', 'git-no-commits', 'deps-not-installed', 'repo-size', 'no-remote', 'remote-credentials', 'remote-http',
]);
const WORKING = new Set(WORKING_COPY_IDS);
// File checks that only fire when GitHub data is present (public repo, issues on, a workflow): with
// no clone their files are unknown, so a "GitHub checks only" result leaves them out too.
const FILE_GATED_IDS = Object.freeze(['ci-none', 'no-pr-template', 'no-issue-templates', 'no-security', 'no-contributing', 'no-coc', 'no-codeowners', 'wf-self-hosted']);
const isWorkingCopy = (id) => WORKING.has(id) || /^local-only/.test(id);

const REASONS = {
  'too-large': (detail) => ({ id: 'uncloned-too-large', title: 'Too large to check its files', detail: `Only GitHub settings, CI, pull requests and alerts were checked. ${detail}` }),
  'clone-failed': (detail) => ({ id: 'uncloned-clone-failed', title: 'Could not download a copy to check its files', detail: `Only GitHub settings, CI, pull requests and alerts were checked. ${detail}` }),
};

// The folder for code that reads files: the cache clone for a remote repo (null when there is none).
const repoDir = (r) => (r && r.source === 'remote' ? r.cacheDir || null : r && r.path);

// An empty repo used as the file tree of a repo with no clone. ".empty" has no "__", so cache
// clean-up never treats it as a clone.
async function ensureEmptyRepo(root, runGit = run) {
  const dir = path.join(root, '.empty');
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const r = await runGit('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '--template='], { cwd: dir, env: { ...SAFE_GIT_ENV } });
  if (!r.ok) throw new Error('git init failed');
  return dir;
}

// Working-copy state shown as "nothing", so the detail view does not describe GutCheck's own clone.
function blankWorkingCopy(local) {
  const g = local.git;
  return {
    ...local,
    git: { ...g, ahead: 0, behind: 0, dirty: 0, untracked: 0, branches: [], remoteBranches: [], mergedBranches: [], worktreeBranches: [], detached: false },
    gitState: null,
    localOnly: null,
    hygiene: { ...local.hygiene, stashes: 0, currentGone: false, prunableWorktrees: 0, submodulesUninit: 0 },
    deps: { ...local.deps, needsInstall: false },
  };
}

const ids = (res) => new Set((res.findings || []).map((f) => f.id));

// listing: { owner, name, ... } from remote-list.js; opts: { cacheDir, emptyDir, ghRes, policy, reason }.
// Never a deep scan: that runs npm in the folder, and a cache copy's .npmrc is the repo's to choose.
async function scanRemote(listing, { cacheDir = null, emptyDir = null, ghRes = null, policy, reason = null } = {}) {
  const ref = { owner: listing.owner, name: listing.name };
  const origin = { ref, originUrl: defaultUrlFor(ref) };
  const dir = cacheDir || emptyDir;
  if (!dir) throw new Error('No folder to scan');
  const local = blankWorkingCopy(await scanner.collectLocal(dir, { deep: false, origin }));
  let omit = isWorkingCopy;
  const extra = [];
  if (!cacheDir) {
    // What an empty repo with no GitHub data reports is about missing files, not about GitHub: drop it.
    const fileOnly = ids(await scanner.finish({ ...structuredClone(local), ref: null }, null, {}));
    omit = (id) => isWorkingCopy(id) || fileOnly.has(id) || FILE_GATED_IDS.includes(id);
    const [kind, ...rest] = String(reason || 'clone-failed').split(':');
    const make = REASONS[kind] || REASONS['clone-failed'];
    const detail = kind === 'too-large' ? `It is ${Math.round((listing.diskKB || 0) / 1024)} MB on GitHub, over the size limit in Settings.` : rest.join(':').trim();
    extra.push({ category: 'Repo', severity: 'info', ...make(detail) });
  }
  // Branches come from GitHub (ghRes.branches, remote-branches.js): the copy has no refs of its own.
  const ghBranches = ghRes && ghRes.ok && Array.isArray(ghRes.branches) ? ghRes.branches : null;
  if (ghBranches) extra.push(...branchFindings(ghBranches, ghRes.snap));
  const res = await scanner.finish(local, ghRes, { policy, omit, extra });
  // ref: the ignore and "new since last scan" key stays owner/name even when GitHub is unreachable.
  return { ...res, ref, source: 'remote', path: `remote:${ref.owner}/${ref.name}`, name: `${ref.owner}/${ref.name}`, cacheDir: cacheDir || null, partial: !cacheDir, ghBranches };
}

module.exports = { scanRemote, repoDir, ensureEmptyRepo, blankWorkingCopy, WORKING_COPY_IDS, FILE_GATED_IDS, isWorkingCopy };
