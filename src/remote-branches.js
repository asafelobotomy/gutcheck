// Branches of a repo that is not cloned here, read from GitHub (a remote scan has no clone with
// refs), and the two findings built on them: merged branches still on GitHub, and branches with work
// that is not in the default branch and has no pull request. Their fixes are API actions
// (delete-remote and pr-create on a remote repo, actions-github.js).

const { run: execRun } = require('./exec');
const github = require('./github');
const { validBranch } = require('./git-safety');
const { COMMAND_TIMEOUT_MS } = require('./util');

const MAX_BRANCHES = 50; // per repo, newest first
const MAX_DELETE = 30; // branches one merged-branches fix deletes
const MAX_NO_PR = 5; // "no PR" findings per repo
const PUSH = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

// compare: the branch is the base and the default branch ($d) the head, so behindBy counts the
// branch's own commits that are not in the default branch. A merged PR whose head is the branch's
// current commit marks it merged too (squash and rebase merges leave its commits out of the default).
const QUERY = `query($o:String!,$n:String!,$d:String!){ repository(owner:$o, name:$n) {
  refs(refPrefix: "refs/heads/", first: ${MAX_BRANCHES}, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
    totalCount
    nodes { name target { ... on Commit { oid committedDate } } compare(headRef: $d) { behindBy }
      associatedPullRequests(first: 1, states: MERGED, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number headRefOid } } }
  } } }`;

const isMerged = (b) => b.unique === 0 || b.mergedPr != null;

// GraphQL payload -> [{ name, oid, date, unique, mergedPr }], without the default branch or names
// that could be read as an option.
function parseBranches(payload, defaultBranch) {
  const nodes = (payload && payload.data && payload.data.repository && payload.data.repository.refs && payload.data.repository.refs.nodes) || [];
  return nodes.filter((n) => n && n.name !== defaultBranch && validBranch(n.name) && n.target && /^[0-9a-f]{40}$/.test(n.target.oid || '')).map((n) => {
    const pr = ((n.associatedPullRequests && n.associatedPullRequests.nodes) || [])[0];
    const behind = n.compare && Number.isInteger(n.compare.behindBy) ? n.compare.behindBy : null;
    return { name: n.name, oid: n.target.oid, date: n.target.committedDate || null, unique: behind, mergedPr: pr && pr.headRefOid === n.target.oid ? pr.number : null };
  });
}

// -> branches, or null when they could not be read (unknown, never "none").
async function fetchBranches(ref, defaultBranch, { run = execRun } = {}) {
  if (!defaultBranch) return null;
  const r = await run('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `o=${ref.owner}`, '-f', `n=${ref.name}`, '-f', `d=${defaultBranch}`], { timeout: COMMAND_TIMEOUT_MS });
  if (run === execRun) github.noteCall('graphql');
  if (!r.ok) return null;
  try { return parseBranches(JSON.parse(r.stdout), defaultBranch); } catch { return null; }
}

// The remote stage's GitHub fetch: the batched repo data, plus each repo's branches.
async function fetchRemoteData(refs, { fetchRepos = github.fetchRepos, branches = fetchBranches, ...opts } = {}) {
  const m = await fetchRepos(refs, opts);
  for (const ref of refs) {
    const k = `${ref.owner}/${ref.name}`;
    const res = m.get(k);
    if (res && res.ok && res.snap && res.snap.remote) m.set(k, { ...res, branches: await branches(ref, res.snap.remote.defaultBranch) });
  }
  return m;
}

// branches: from fetchBranches (null: unknown); gh: { remote, prs } from the GitHub snapshot.
function branchFindings(branches, gh) {
  if (!Array.isArray(branches) || !gh || !gh.remote || gh.remote.archived) return [];
  const can = PUSH.has(gh.remote.viewerPermission);
  const open = new Set((gh.prs || []).map((p) => p.headRefName));
  const def = gh.remote.defaultBranch || 'the default branch';
  const free = branches.filter((b) => !open.has(b.name));
  const out = [];
  const merged = free.filter(isMerged);
  if (merged.length) {
    const names = merged.map((b) => b.name);
    out.push({ id: 'gh-merged-branches', category: 'Branches', severity: 'info', title: `${merged.length} merged branch${merged.length === 1 ? '' : 'es'} still on GitHub`, detail: `${names.slice(0, 10).join(', ')}${names.length > 10 ? `, and ${names.length - 10} more` : ''}. Their work is already in ${def}.`, ...(can ? { fix: { type: 'delete-remote', label: 'Delete them on GitHub…', branches: names.slice(0, MAX_DELETE) } } : {}) });
  }
  for (const b of free.filter((x) => !isMerged(x) && x.unique > 0).slice(0, MAX_NO_PR)) {
    out.push({ id: `gh-branch-no-pr-${b.name}`, category: 'Branches', severity: 'info', title: `Branch ${b.name} has work that is not in ${def} and no pull request`, detail: `${b.unique} commit${b.unique === 1 ? '' : 's'} not in ${def}, last on ${String(b.date || '').slice(0, 10)}. Open a pull request, or delete the branch if the work is not needed.`, ...(can ? { fix: { type: 'pr-create', label: 'Open a PR…', branch: b.name } } : {}) });
  }
  return out;
}

module.exports = { QUERY, parseBranches, isMerged, fetchBranches, fetchRemoteData, branchFindings };
