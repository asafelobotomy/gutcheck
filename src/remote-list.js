// Repos on GitHub that are not cloned in the workspace: your own repos plus the orgs you chose,
// listed through `gh api graphql` (orgs and cursors are variables, never built into the query),
// then filtered against the workspace's clones and the user's settings.

const { run: execRun } = require('./exec');
const { COMMAND_TIMEOUT_MS } = require('./util');
const { validRef } = require('./remote-settings');

const FIELDS = 'nodes { owner { login } name isFork isArchived diskUsage pushedAt defaultBranchRef { name } } pageInfo { hasNextPage endCursor }';
const VIEWER_Q = `query($endCursor: String) { viewer { repositories(first: 100, after: $endCursor, ownerAffiliations: [OWNER]) { ${FIELDS} } } }`;
const ORG_Q = `query($login: String!, $endCursor: String) { organization(login: $login) { repositories(first: 100, after: $endCursor) { ${FIELDS} } } }`;
const MAX_PAGES = 50; // 5,000 repos per owner is far past anything a personal workspace needs

const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 300) || 'GitHub request failed';

// One owner's repos, page by page. Resolves { ok, nodes } or { ok: false, error }.
async function pages(run, { query, root, login, onCall }) {
  const nodes = [];
  let cursor = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    if (login) args.push('-f', `login=${login}`);
    if (cursor) args.push('-f', `endCursor=${cursor}`);
    const r = await run('gh', args, { timeout: COMMAND_TIMEOUT_MS });
    if (onCall) onCall();
    let payload = null;
    try { payload = JSON.parse(r.stdout); } catch {}
    const conn = payload && payload.data && payload.data[root] && payload.data[root].repositories;
    if (!conn) {
      const msg = payload && payload.errors && payload.errors[0] && payload.errors[0].message;
      return { ok: false, error: login ? `${login}: ${firstLine(msg || r.stderr)}` : firstLine(msg || r.stderr) };
    }
    nodes.push(...(conn.nodes || []));
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { ok: true, nodes };
}

const toListing = (n) => ({
  owner: n.owner && n.owner.login, name: n.name, isFork: !!n.isFork, isArchived: !!n.isArchived,
  diskKB: Number(n.diskUsage) || 0, defaultBranch: (n.defaultBranchRef && n.defaultBranchRef.name) || null, pushedAt: n.pushedAt || null,
});

// opts: { run = exec.run, orgs: string[] (already validated), onCall?() }
async function listRemote({ run = execRun, orgs = [], onCall } = {}) {
  const owners = [{ query: VIEWER_Q, root: 'viewer' }, ...orgs.map((login) => ({ query: ORG_Q, root: 'organization', login }))];
  const seen = new Set();
  const repos = [];
  for (const o of owners) {
    const r = await pages(run, { ...o, onCall });
    if (!r.ok) return r;
    for (const n of r.nodes) {
      const l = toListing(n);
      const key = `${l.owner}/${l.name}`.toLowerCase();
      if (!validRef(l) || seen.has(key)) continue;
      seen.add(key);
      repos.push(l);
    }
  }
  return { ok: true, repos };
}

// listing: Listing[]; localRefs: [{owner,name}] from the workspace's clones; settings: normalized.
function selectUncloned(listing, localRefs, settings) {
  const cloned = new Set((localRefs || []).filter(Boolean).map((r) => `${r.owner}/${r.name}`.toLowerCase()));
  const skip = new Set((settings.skip || []).map((s) => s.toLowerCase()));
  const include = [];
  const excluded = [];
  for (const l of listing) {
    const key = `${l.owner}/${l.name}`.toLowerCase();
    const why = cloned.has(key) ? 'cloned'
      : l.isFork && !settings.forks ? 'fork'
        : l.isArchived && !settings.archived ? 'archived'
          : skip.has(key) ? 'skipped'
            : !l.defaultBranch ? 'empty' : null;
    if (why) excluded.push({ owner: l.owner, name: l.name, why });
    else include.push(l);
  }
  return { include, excluded };
}

module.exports = { listRemote, selectUncloned };
