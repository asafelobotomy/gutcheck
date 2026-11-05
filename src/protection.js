// Branch-protection presets offered by the 'protect-branch' action (and quoted in reports).

const PROTECTION = {
  basic: {
    label: 'Basic: require a pull request, block force-pushes and deletion (no approvals needed)',
    body: { required_status_checks: null, enforce_admins: false, required_pull_request_reviews: { required_approving_review_count: 0 }, restrictions: null, allow_force_pushes: false, allow_deletions: false },
  },
  strict: {
    label: 'Strict: 1 approval, dismiss stale reviews, resolve conversations, admins included, block force-pushes and deletion',
    body: { required_status_checks: null, enforce_admins: true, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }, restrictions: null, allow_force_pushes: false, allow_deletions: false, required_conversation_resolution: true },
  },
};

module.exports = { PROTECTION };
