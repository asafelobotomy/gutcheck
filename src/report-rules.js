// Report steps for the repository-settings findings (repo-rules.js).
const GH = 'https://docs.github.com/en/';
const REFS = {
  rules: GH + 'rest/repos/rules',
  actionsPerms: GH + 'rest/actions/permissions',
};

function rulesFix(id, r) {
  const slug = r.remote && !r.remote.unreachable ? `${r.remote.owner}/${r.remote.name}` : 'OWNER/REPO';
  const api = (p) => `repos/${slug}${p}`;
  const body = '{"name":"GutCheck: protect release tags","target":"tag","enforcement":"active","bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],"conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"update","parameters":{"update_allows_fetch_and_merge":false}}]}';
  if (id === 'tag-protection') return { phase: 7, rank: 1, why: 'A moved or deleted release tag lets someone republish different code under a version people trust.', cmds: [`gh api '${api('/rulesets?targets=tag&includes_parents=true')}' --jq '.[] | {id, name, enforcement}'   # what exists now`, `echo '${body}' | gh api -X POST ${api('/rulesets')} --input -`], note: 'Additive: existing rules are untouched, and repository admins (role id 5) can still bypass. Tags that are moved on purpose (a floating v1) will then need an admin. Private repos on a free plan cannot use rulesets.', ref: REFS.rules };
  if (id === 'actions-token-write') return { phase: 0, rank: 13, why: 'Workflows without their own permissions: block get a read/write token.', cmds: [`gh api -X PUT ${api('/actions/permissions/workflow')} -f default_workflow_permissions=read`], note: 'Make sure every workflow has a permissions: block first (add job-level write scopes only where a job must push, release or comment); otherwise workflows that relied on the write default fail with 403. An organization policy may block the change (409).', ref: REFS.actionsPerms };
  if (id === 'actions-approve-prs') return { phase: 0, rank: 14, why: 'A workflow that can approve pull requests can satisfy a required review for its own changes.', cmds: [`gh api -X PUT ${api('/actions/permissions/workflow')} -F can_approve_pull_request_reviews=false`], note: 'Skip only if a workflow deliberately auto-approves PRs.', ref: REFS.actionsPerms };
  if (id === 'actions-sha-pinning-available') return { phase: 7, rank: 11, why: 'All actions are already pinned, so GitHub can enforce it for every future workflow change.', cmds: [`gh api ${api('/actions/permissions')}   # read enabled and allowed_actions first`, `gh api -X PUT ${api('/actions/permissions')} -F enabled=true -F sha_pinning_required=true   # add -f allowed_actions=<current value> if the repo restricts actions`], note: 'Any workflow that still uses an unpinned action (including reusable workflows) fails once this is on, so re-check the workflows first.', ref: REFS.actionsPerms };
  return null;
}

module.exports = { rulesFix, REFS };
