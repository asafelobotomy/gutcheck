// Repository-settings checks that come from GitHub's REST API (read for repos you administer):
// tag protection (rulesets) and the repo-level GitHub Actions settings. Pure functions over a scan
// snapshot; github.js fetches the data. Sources are in docs/sources.md.

const { refMatches } = require('./github');

const TAG_RULES = ['deletion', 'non_fast_forward']; // required; `update` is added by the fix and is advisory
const RULESET_NAME = 'GutCheck: protect release tags';

// rulesets: [{ include, exclude, types }] (active tag rulesets, normalised by github.fetchTagRulesets).
// Rulesets stack, so the rule types of every ruleset that covers the tag are combined.
function tagProtection(rulesets, tag) {
  const ref = `refs/tags/${tag}`;
  const hit = (pats) => (pats || []).some((p) => p === '~ALL' || (typeof p === 'string' && refMatches(p, ref)));
  const covering = (rulesets || []).filter((r) => hit(r.include) && !hit(r.exclude));
  const types = new Set(covering.flatMap((r) => r.types || []));
  const missing = TAG_RULES.filter((t) => !types.has(t));
  return { state: !covering.length ? 'none' : missing.length ? 'partial' : 'covered', missing, hasUpdate: types.has('update') };
}

// The release tag to test: the newest version tag, else any v* tag, else GitHub's latest release.
const releaseTag = (s) => (s.release && (s.release.latest || s.release.vTag)) || (s.remote && s.remote.latestRelease) || null;

// Simple, documented heuristic: dropping the write default is safe to offer when every workflow file
// declares `permissions:` (top level, or on its jobs), so none of them relies on the repo default.
const workflowsDeclarePermissions = (w) => !!w && w.files > 0 && (w.noPermissions || []).every((p) => p.jobLevel);

function checkRepoRules(s) {
  const r = s.remote;
  if (!r || r.unreachable || r.archived || r.viewerPermission !== 'ADMIN') return [];
  const out = [];
  const add = (id, category, severity, title, detail, fix) => out.push({ id, category, severity, title, detail, fix });
  const tag = releaseTag(s);
  if (tag && Array.isArray(s.tagRulesets)) {
    const t = tagProtection(s.tagRulesets, tag);
    if (t.state !== 'covered') add('tag-protection', 'Repo', 'warn', 'Release tags are not protected', `${t.state === 'partial' ? `Tag rules exist but do not block ${t.missing.map((m) => (m === 'deletion' ? 'deletion' : 'force-pushes')).join(' or ')}. ` : 'No active tag ruleset covers your release tags. '}Anyone with write access can move or delete ${tag} and republish different code under it (a tag rewrite like the Trivy incident).`, { type: 'protect-tags', label: 'Protect release tags…' });
  }
  const a = s.actionsSettings;
  if (!a || a.enabled === false || !s.hasWorkflows) return out;
  const w = s.hygiene && s.hygiene.workflows;
  if (a.defaultPermissions === 'write') {
    const safe = workflowsDeclarePermissions(w);
    add('actions-token-write', 'Actions security', 'warn', 'Workflows get a read/write token by default', `Repository setting "Workflow permissions" is read and write, so any workflow without its own permissions: block can push code, edit releases and more.${safe ? '' : ' Add a permissions: block to every workflow first (see the workflow findings), then switch the default to read-only.'}`, safe ? { type: 'actions-settings', label: 'Make the default token read-only…', setting: 'read-token' } : undefined);
  }
  if (a.canApprovePrs === true) add('actions-approve-prs', 'Actions security', 'warn', 'GitHub Actions can approve pull requests', 'A workflow can then approve a PR and satisfy a required review, so a compromised workflow can merge its own changes.', { type: 'actions-settings', label: 'Stop Actions approving PRs…', setting: 'no-approve' });
  if (a.shaPinningRequired === false && w && w.files > 0 && !(w.unpinned || []).length)
    add('actions-sha-pinning-available', 'Actions security', 'info', 'Every action is pinned: GitHub can enforce it', 'All workflows already pin actions to full commit SHAs. Turning on "Require actions to be pinned to a full-length commit SHA" (Settings > Actions > General) makes GitHub refuse any run that uses an unpinned action.');
  return out;
}

module.exports = { tagProtection, checkRepoRules, workflowsDeclarePermissions, releaseTag, RULESET_NAME, TAG_RULES };
