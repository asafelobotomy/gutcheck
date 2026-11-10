// All GitHub API access lives here so rate-limit handling and caching are in one place.
//
// Cost model: one GraphQL query covers up to BATCH repos (repo info, open PRs with check state,
// branch protection, Dependabot alerts). The only per-repo REST call left is the workflow run
// list, and only for repos that actually have workflows. Results are cached in memory (never on
// disk) so repeated scans don't re-spend quota.

const { run, json } = require('./exec');
const { COMMAND_TIMEOUT_MS } = require('./util');

const BATCH = 10;
const TTL_MS = 2 * 60 * 1000;
const MIN_CORE = 100; // stop making REST calls below this many remaining
const MIN_GRAPHQL = 50;

const cache = new Map(); // "owner/name" -> { at, snap }
const rate = { core: null, graphql: null, limited: false };

const { parseUpdates } = require('./dependabot-prs');
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const FRAGMENT = `
fragment F on Repository {
  url description isPrivate isArchived isFork pushedAt viewerPermission hasVulnerabilityAlertsEnabled deleteBranchOnMerge
  hasIssuesEnabled isSecurityPolicyEnabled
  contributingGuidelines { url } codeOfConduct { key }
  repositoryTopics(first: 1) { totalCount }
  languages(first: 12, orderBy: { field: SIZE, direction: DESC }) { nodes { name } }
  latestRelease { tagName }
  rulesets(first: 20, includeParents: true) { nodes { enforcement target conditions { refName { include exclude } } } }
  issues(states: OPEN) { totalCount }
  licenseInfo { key }
  defaultBranchRef { name branchProtectionRule { id } }
  vulnerabilityAlerts(first: 100, states: OPEN) { totalCount nodes { vulnerableManifestPath securityVulnerability { severity package { name ecosystem } firstPatchedVersion { identifier } } } }
  pullRequests(states: OPEN, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
    totalCount
    nodes {
      number title body url isDraft updatedAt mergeable reviewDecision headRefName headRefOid
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

// Ruleset ref patterns are fnmatch-style: `*` stops at "/", `**` crosses it, `?` is one character.
function refMatches(pattern, ref) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(ref);
}

// An active branch ruleset (repo or inherited from the org) that covers the default branch.
// Readers can see active rulesets, so this works without admin rights.
function rulesetCovers(rulesets, branch) {
  return ((rulesets && rulesets.nodes) || []).some((r) => {
    if (r.enforcement !== 'ACTIVE' || r.target !== 'BRANCH') return false;
    const inc = (r.conditions && r.conditions.refName && r.conditions.refName.include) || [];
    const exc = (r.conditions && r.conditions.refName && r.conditions.refName.exclude) || [];
    const hit = (pats) => pats.some((p) => p === '~ALL' || p === '~DEFAULT_BRANCH' || (typeof p === 'string' && !!branch && refMatches(p, `refs/heads/${branch}`)));
    return hit(inc) && !hit(exc);
  });
}

function toSnapshot(ref, n) {
  const isAdmin = n.viewerPermission === 'ADMIN';
  const branch = n.defaultBranchRef && n.defaultBranchRef.name;
  const ruleset = rulesetCovers(n.rulesets, branch);
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
      isFork: n.isFork,
      hasIssues: n.hasIssuesEnabled,
      topics: n.repositoryTopics ? n.repositoryTopics.totalCount : null,
      languages: ((n.languages && n.languages.nodes) || []).map((l) => l.name),
      latestRelease: n.latestRelease && n.latestRelease.tagName,
      // These include defaults inherited from the owner's .github repository.
      securityPolicy: n.isSecurityPolicyEnabled,
      contributing: !!n.contributingGuidelines,
      codeOfConduct: !!n.codeOfConduct,
      ruleset,
    },
    prs: ((n.pullRequests && n.pullRequests.nodes) || []).map((p) => ({
      number: p.number, title: p.title, url: p.url, isDraft: p.isDraft, updatedAt: p.updatedAt,
      mergeable: p.mergeable, reviewDecision: p.reviewDecision, headRefName: p.headRefName, headRefOid: p.headRefOid || null,
      // Only the packages a Dependabot PR bumps are kept from its body, never the body itself.
      updates: /^dependabot\//.test(p.headRefName || '') ? parseUpdates(p.title, p.body) : [],
      statusCheckRollup: rollup(p.commits && p.commits.nodes[0] && p.commits.nodes[0].commit.statusCheckRollup && p.commits.nodes[0].commit.statusCheckRollup.state),
    })),
    // Only admins can see protection rules; for everyone else "no rule visible" means unknown, not unprotected.
    // Rulesets count too (GitHub stacks them with classic protection).
    protection: (n.defaultBranchRef && n.defaultBranchRef.branchProtectionRule) || ruleset ? true : isAdmin ? false : null,
    // totalCount is the true number; the nodes (up to 100) give severity, package and the fixed version.
    alertsTotal: n.vulnerabilityAlerts ? n.vulnerabilityAlerts.totalCount : 0,
    alerts: ((n.vulnerabilityAlerts && n.vulnerabilityAlerts.nodes) || []).map((a) => {
      const v = a.securityVulnerability || {};
      return { severity: String(v.severity || '').toLowerCase(), manifest: a.vulnerableManifestPath || null, pkg: v.package && v.package.name, ecosystem: v.package && String(v.package.ecosystem || '').toLowerCase(), patched: v.firstPatchedVersion && v.firstPatchedVersion.identifier };
    }),
  };
}

async function queryBatch(refs) {
  const decl = refs.map((_, i) => `$o${i}:String!,$n${i}:String!`).join(',');
  const body = refs.map((_, i) => `r${i}: repository(owner:$o${i}, name:$n${i}) { ...F }`).join('\n');
  const query = `query(${decl}){ rateLimit { remaining resetAt } ${body} } ${FRAGMENT}`;
  const args = ['api', 'graphql', '-f', `query=${query}`];
  refs.forEach((r, i) => args.push('-f', `o${i}=${r.owner}`, '-f', `n${i}=${r.name}`)); // variables, never string-built
  const r = await run('gh', args, { timeout: COMMAND_TIMEOUT_MS });
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
  const pending = new Set(); // workflows with a newer run still queued or running (runs come newest first)
  for (const run_ of r.data) {
    if (run_.status !== 'completed') { if (!seen.has(run_.workflowName)) pending.add(run_.workflowName); continue; }
    if (seen.has(run_.workflowName)) continue;
    seen.add(run_.workflowName);
    if (run_.conclusion === 'failure' || run_.conclusion === 'timed_out') failed.push({ ...run_, newerPending: pending.has(run_.workflowName) });
  }
  return { failed, error: null };
}

// Security feature settings. Only admins can read them, so callers ask for repos they administer.
// security_and_analysis is null when not visible; 404/403 answers mean "not available", not "off".
const secCache = new Map();
async function fetchSecurity(ref, opts = {}) {
  const key = `${ref.owner}/${ref.name}`;
  const hit = secCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) return hit.val;
  if (rate.core && rate.core.remaining < MIN_CORE) return null;
  const slug = `repos/${ref.owner}/${ref.name}`;
  const [repo, cs, pvr] = await Promise.all([
    json('gh', ['api', slug, '--jq', '.security_and_analysis']),
    json('gh', ['api', `${slug}/code-scanning/default-setup`, '--jq', '{state: .state}']),
    json('gh', ['api', `${slug}/private-vulnerability-reporting`]),
  ]);
  noteCall('core', 3);
  const st = (o, k) => (o && o[k] && o[k].status) || null;
  const sa = repo.ok ? repo.data : null;
  const val = {
    secretScanning: st(sa, 'secret_scanning'),
    pushProtection: st(sa, 'secret_scanning_push_protection'),
    securityUpdates: st(sa, 'dependabot_security_updates'),
    codeScanning: cs.ok && cs.data ? cs.data.state : null,
    privateReporting: pvr.ok && pvr.data ? !!pvr.data.enabled : null,
  };
  secCache.set(key, { at: Date.now(), val });
  return val;
}

// Branch protection and rulesets on PRIVATE repos need a paid plan (GitHub answers 403 "Upgrade to GitHub
// Pro or make this repository public"). One read-only probe per owner tells whether they are available.
const protectionProbe = new Map();
async function protectionAvailable(ref) {
  if (protectionProbe.has(ref.owner)) return protectionProbe.get(ref.owner);
  const r = await run('gh', ['api', `repos/${ref.owner}/${ref.name}/rulesets`], { timeout: COMMAND_TIMEOUT_MS });
  noteCall('core');
  const ok = r.ok || !/upgrade to github pro|make this repository public/i.test(r.stderr + r.stdout);
  protectionProbe.set(ref.owner, ok);
  return ok;
}

// GitHub trims a nested connection inside a large query (we saw 25 of 95 alerts), so when the count is
// bigger than what came back, the full list comes from the REST endpoint (cursor-paginated by gh).
async function fetchAlerts(ref) {
  if (rate.core && rate.core.remaining < MIN_CORE) return null;
  const r = await json('gh', ['api', '--paginate', '--slurp', `repos/${ref.owner}/${ref.name}/dependabot/alerts?state=open&per_page=100`], { timeout: COMMAND_TIMEOUT_MS });
  noteCall('core', 2);
  if (!r.ok || !Array.isArray(r.data)) return null;
  return r.data.flat().slice(0, 500).map((a) => {
    const v = a.security_vulnerability || {};
    // REST says "medium", GraphQL says "moderate": one word for both.
    return { severity: String(v.severity || '').toLowerCase().replace('medium', 'moderate'), manifest: a.dependency && a.dependency.manifest_path, pkg: v.package && v.package.name, ecosystem: v.package && String(v.package.ecosystem || '').toLowerCase(), patched: v.first_patched_version && v.first_patched_version.identifier };
  });
}

// Active tag rulesets (repo and inherited) as [{ name, include, exclude, types }], or null when they cannot be
// read (403/404, no plan, rate limit): unknown, never "none". The list may omit rules, so each is read by id.
const tagCache = new Map();
async function fetchTagRulesets(ref, opts = {}) {
  const key = `${ref.owner}/${ref.name}`;
  const hit = tagCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) return hit.val;
  if (rate.core && rate.core.remaining < MIN_CORE) return null;
  const slug = `repos/${key}`;
  const list = await json('gh', ['api', `${slug}/rulesets?targets=tag&includes_parents=true&per_page=100`], { timeout: COMMAND_TIMEOUT_MS });
  noteCall('core');
  let val = null;
  if (list.ok && Array.isArray(list.data)) {
    val = [];
    for (const r of list.data.filter((x) => x.enforcement === 'active' && x.target === 'tag').slice(0, 10)) {
      let d = r;
      if (!Array.isArray(r.rules) || !r.conditions) {
        const x = await json('gh', ['api', `${slug}/rulesets/${Number(r.id)}`], { timeout: COMMAND_TIMEOUT_MS });
        noteCall('core');
        if (!x.ok) { val = null; break; }
        d = x.data;
      }
      const c = (d.conditions && d.conditions.ref_name) || {};
      val.push({ name: String(d.name || ''), include: c.include || [], exclude: c.exclude || [], types: (d.rules || []).map((x) => x.type) });
    }
  }
  tagCache.set(key, { at: Date.now(), val });
  return val;
}

// Repo-level GitHub Actions settings. Either call failing (403/404, org policy) leaves its fields null.
const actCache = new Map();
async function fetchActionsSettings(ref, opts = {}) {
  const key = `${ref.owner}/${ref.name}`;
  const hit = actCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) return hit.val;
  if (rate.core && rate.core.remaining < MIN_CORE) return null;
  const [perm, wf] = await Promise.all([
    json('gh', ['api', `repos/${key}/actions/permissions`], { timeout: COMMAND_TIMEOUT_MS }),
    json('gh', ['api', `repos/${key}/actions/permissions/workflow`], { timeout: COMMAND_TIMEOUT_MS }),
  ]);
  noteCall('core', 2);
  const p = perm.ok && perm.data ? perm.data : {};
  const w = wf.ok && wf.data ? wf.data : {};
  const val = perm.ok || wf.ok ? {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : null,
    shaPinningRequired: typeof p.sha_pinning_required === 'boolean' ? p.sha_pinning_required : null,
    defaultPermissions: w.default_workflow_permissions || null,
    canApprovePrs: typeof w.can_approve_pull_request_reviews === 'boolean' ? w.can_approve_pull_request_reviews : null,
  } : null;
  actCache.set(key, { at: Date.now(), val });
  return val;
}

module.exports = { fetchTagRulesets, fetchActionsSettings, fetchRepos, fetchFailedRuns, fetchSecurity, fetchAlerts, protectionAvailable, refreshRate, getRate, rulesetCovers, refMatches };
