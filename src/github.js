// All GitHub API access lives here so rate-limit handling and caching are in one place.
//
// Cost model: one GraphQL query covers up to BATCH repos (repo info, open PRs with check state,
// branch protection, Dependabot alerts). The only per-repo REST call left is the workflow run
// list, and only for repos that actually have workflows. Results are cached in memory (never on
// disk) so repeated scans don't re-spend quota.

const { run, json } = require('./exec');

const BATCH = 10;
const TTL_MS = 2 * 60 * 1000;
const MIN_CORE = 100; // stop making REST calls below this many remaining
const MIN_GRAPHQL = 50;

const cache = new Map(); // "owner/name" -> { at, snap }
const rate = { core: null, graphql: null, limited: false };

const NAME_RE = /^[A-Za-z0-9._-]+$/;

const FRAGMENT = `
fragment F on Repository {
  url description isPrivate isArchived pushedAt viewerPermission hasVulnerabilityAlertsEnabled deleteBranchOnMerge
  issues(states: OPEN) { totalCount }
  licenseInfo { key }
  defaultBranchRef { name branchProtectionRule { id } }
  vulnerabilityAlerts(first: 50, states: OPEN) { nodes { securityVulnerability { severity } } }
  pullRequests(states: OPEN, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
    totalCount
    nodes {
      number title url isDraft updatedAt mergeable reviewDecision headRefName
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

// `gh api rate_limit` does not count against any limit.
async function refreshRate() {
  const r = await json('gh', ['api', 'rate_limit']);
  if (r.ok && r.data && r.data.resources) {
    rate.core = { ...r.data.resources.core };
    rate.graphql = { ...r.data.resources.graphql };
    rate.limited = rate.core.remaining < MIN_CORE || rate.graphql.remaining < MIN_GRAPHQL;
  }
  return getRate();
}

function getRate() {
  const fmt = (b) => (b ? { remaining: b.remaining, limit: b.limit, reset: new Date(b.reset * 1000).toISOString() } : null);
  return { core: fmt(rate.core), graphql: fmt(rate.graphql), limited: rate.limited };
}

const noteCall = (bucket, n = 1) => {
  if (rate[bucket]) rate[bucket].remaining = Math.max(0, rate[bucket].remaining - n);
};
const looksRateLimited = (text) => /rate limit|abuse detection|secondary rate/i.test(text || '');

function rollup(state) {
  if (!state) return 'NONE';
  if (state === 'FAILURE' || state === 'ERROR') return 'FAILURE';
  if (state === 'SUCCESS') return 'SUCCESS';
  return 'PENDING';
}

function toSnapshot(ref, n) {
  const isAdmin = n.viewerPermission === 'ADMIN';
  return {
    remote: {
      owner: ref.owner,
      name: ref.name,
      url: n.url,
      description: n.description,
      isPublic: !n.isPrivate,
      archived: n.isArchived,
      defaultBranch: n.defaultBranchRef && n.defaultBranchRef.name,
      pushedAt: n.pushedAt,
      openIssues: n.issues ? n.issues.totalCount : 0,
      licenseOnGitHub: n.licenseInfo && n.licenseInfo.key,
      viewerPermission: n.viewerPermission,
      alertsEnabled: n.hasVulnerabilityAlertsEnabled,
      deleteBranchOnMerge: n.deleteBranchOnMerge,
    },
    prs: ((n.pullRequests && n.pullRequests.nodes) || []).map((p) => ({
      number: p.number, title: p.title, url: p.url, isDraft: p.isDraft, updatedAt: p.updatedAt,
      mergeable: p.mergeable, reviewDecision: p.reviewDecision, headRefName: p.headRefName,
      statusCheckRollup: rollup(p.commits && p.commits.nodes[0] && p.commits.nodes[0].commit.statusCheckRollup && p.commits.nodes[0].commit.statusCheckRollup.state),
    })),
    // Only admins can see protection rules; for everyone else "no rule visible" means unknown, not unprotected.
    protection: n.defaultBranchRef && n.defaultBranchRef.branchProtectionRule ? true : isAdmin ? false : null,
    alerts: ((n.vulnerabilityAlerts && n.vulnerabilityAlerts.nodes) || []).map((a) => ({ severity: a.securityVulnerability && String(a.securityVulnerability.severity || '').toLowerCase() })),
  };
}

async function queryBatch(refs) {
  const decl = refs.map((_, i) => `$o${i}:String!,$n${i}:String!`).join(',');
  const body = refs.map((_, i) => `r${i}: repository(owner:$o${i}, name:$n${i}) { ...F }`).join('\n');
  const query = `query(${decl}){ rateLimit { remaining resetAt } ${body} } ${FRAGMENT}`;
  const args = ['api', 'graphql', '-f', `query=${query}`];
  refs.forEach((r, i) => args.push('-f', `o${i}=${r.owner}`, '-f', `n${i}=${r.name}`)); // variables, never string-built
  const r = await run('gh', args, { timeout: 60000 });
  noteCall('graphql');
  let payload = null;
  try { payload = JSON.parse(r.stdout); } catch {}
  // GraphQL returns partial data plus an errors[] (e.g. no permission to read alerts); gh exits non-zero then.
  if (!payload || !payload.data) {
    if (looksRateLimited(r.stderr + r.stdout)) rate.limited = true;
    return refs.map(() => ({ ok: false, error: (r.stderr || 'GraphQL request failed').trim().slice(0, 300) }));
  }
  if (payload.data.rateLimit && rate.graphql) rate.graphql.remaining = payload.data.rateLimit.remaining;
  const errByAlias = new Map();
  for (const e of payload.errors || []) {
    const a = e.path && e.path[0];
    if (typeof a === 'string' && /^r\d+$/.test(a) && !errByAlias.has(a)) errByAlias.set(a, e.message);
  }
  return refs.map((ref, i) => {
    const node = payload.data['r' + i];
    return node ? { ok: true, snap: toSnapshot(ref, node) } : { ok: false, error: errByAlias.get('r' + i) || 'Repository not found or no access' };
  });
}

// refs: [{owner,name}] -> Map("owner/name" -> {ok, snap|error}). Cached unless opts.force.
async function fetchRepos(refs, opts = {}) {
  const out = new Map();
  const todo = [];
  const seen = new Set();
  for (const ref of refs) {
    const key = `${ref.owner}/${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!NAME_RE.test(ref.owner) || !NAME_RE.test(ref.name)) { out.set(key, { ok: false, error: 'Unsupported repository name' }); continue; }
    const hit = cache.get(key);
    if (!opts.force && hit && Date.now() - hit.at < TTL_MS) out.set(key, { ok: true, snap: hit.snap, cached: true });
    else todo.push(ref);
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    if (rate.graphql && rate.graphql.remaining < MIN_GRAPHQL) {
      for (const ref of batch) out.set(`${ref.owner}/${ref.name}`, { ok: false, error: 'Skipped: GitHub GraphQL rate limit nearly exhausted' });
      continue;
    }
    const res = await queryBatch(batch);
    batch.forEach((ref, j) => {
      const key = `${ref.owner}/${ref.name}`;
      if (res[j].ok) cache.set(key, { at: Date.now(), snap: res[j].snap });
      out.set(key, res[j]);
    });
  }
  return out;
}

// Latest completed run per workflow on the default branch that is currently failing.
const runCache = new Map();
async function fetchFailedRuns(ref, defaultBranch, cwd, opts = {}) {
  const key = `${ref.owner}/${ref.name}`;
  const hit = runCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) return hit.val;
  const val = await fetchFailedRunsUncached(ref, defaultBranch, cwd);
  if (!val.error) runCache.set(key, { at: Date.now(), val });
  return val;
}

async function fetchFailedRunsUncached(ref, defaultBranch, cwd) {
  if (rate.core && rate.core.remaining < MIN_CORE) return { failed: [], error: 'Skipped: GitHub REST rate limit nearly exhausted' };
  const args = ['run', 'list', '-R', `${ref.owner}/${ref.name}`, '--limit', '20', '--json', 'databaseId,workflowName,conclusion,status,headBranch,displayTitle,createdAt,url'];
  if (defaultBranch) args.push('--branch', defaultBranch);
  const r = await json('gh', args, { cwd });
  noteCall('core');
  if (!r.ok) {
    if (looksRateLimited(r.error)) { rate.limited = true; if (rate.core) rate.core.remaining = 0; }
    return { failed: [], error: r.error.slice(0, 300) };
  }
  const seen = new Set();
  const failed = [];
  for (const run_ of r.data) {
    if (run_.status !== 'completed' || seen.has(run_.workflowName)) continue;
    seen.add(run_.workflowName);
    if (run_.conclusion === 'failure' || run_.conclusion === 'timed_out') failed.push(run_);
  }
  return { failed, error: null };
}

module.exports = { fetchRepos, fetchFailedRuns, refreshRate, getRate };
