// Dated GitHub Actions facts the workflow checks use. Each one names its source and when it was checked;
// delete an entry (or the whole check) once its date is long past. Nothing here calls the network.

// pull_request_target on public repos (GitHub changelog 2026-11-02, checked 2026-11-10): blocked by
// default from 2 December 2026 unless an Actions event policy allows it; brownouts (blocked runs fail)
// on 9 and 16 November 2026, 16:00-18:00 UTC. Public repos on Free, Team and Enterprise Cloud only.
// https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2
const PR_TARGET_BLOCK = {
  from: '2026-12-02',
  brownouts: ['2026-11-09', '2026-11-16'],
  retireAfter: '2027-03-01', // the check stops after this date: by then it is old news or a normal setting
};

// Runner labels GitHub has retired (jobs on them never start). Only labels checked against GitHub's own
// announcements: macos-13 (+ -large, -xlarge) retired 4 December 2025, ubuntu-20.04 retired 15 April 2025.
// https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/
// https://github.blog/changelog/2025-01-15-github-actions-ubuntu-20-runner-image-brownout-dates-and-other-breaking-changes/
const RETIRED_RUNNERS = [
  { re: /^macos-13(-large|-xlarge)?$/, retired: '2025-12-04', use: 'macos-14 or macos-15' },
  { re: /^ubuntu-20\.04$/, retired: '2025-04-15', use: 'ubuntu-22.04 or ubuntu-24.04' },
];

// Node 20 left GitHub Actions on 23 September 2026: JavaScript actions run on Node 24, and the
// ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION opt-out is gone.
// https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions
// Highest major of each first-party action whose action.yml says runs.using node20 or older, read from
// the action.yml at each major tag on 2026-11-10. Tags move within a major, so the major decides.
const NODE20_UNTIL = '2026-09-23';
const NODE20_MAJORS = {
  'actions/checkout': 4, 'actions/setup-node': 4, 'actions/cache': 4, 'actions/setup-java': 4,
  'actions/upload-artifact': 5, 'actions/download-artifact': 6, 'actions/setup-python': 5,
  'actions/setup-go': 5, 'actions/github-script': 7,
};

// actions/checkout v6 and later keep the token outside .git/config, which lowers the artipacked risk.
const CHECKOUT_SAFE_MAJOR = 6;

module.exports = { PR_TARGET_BLOCK, RETIRED_RUNNERS, NODE20_UNTIL, NODE20_MAJORS, CHECKOUT_SAFE_MAJOR };
