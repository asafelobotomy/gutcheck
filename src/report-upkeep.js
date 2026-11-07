// Report steps for dependency automation, release health and baseline drift findings.
const { sq } = require('./util');

const GH = 'https://docs.github.com/en/';
const REFS = {
  dependabotOptions: GH + 'code-security/dependabot/working-with-dependabot/dependabot-options-reference',
  autoMerge: GH + 'code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions',
  semver: 'https://semver.org/',
  changelog: 'https://keepachangelog.com/',
};

const GROUP_SNIPPET = '# under each "- package-ecosystem:" entry in .github/dependabot.yml:\n    groups:\n      minor-and-patch:\n        update-types: [minor, patch]\n    cooldown:\n      default-days: 7';

function upkeepFix(id, r) {
  const rel = r.release || {};
  const m = rel.manifest;
  if (id === 'automerge-ungated') return { phase: 4, rank: 1, why: 'Major updates and brand-new releases merge with nobody looking.', cmds: [], note: 'In the auto-merge workflow, read the update type with dependabot/fetch-metadata and only merge when steps.metadata.outputs.update-type is "version-update:semver-patch" or "version-update:semver-minor". Keep "Require status checks to pass" on the default branch so a failing update never merges.', ref: REFS.autoMerge };
  if (id === 'dependabot-ungrouped') return { phase: 4, rank: 6, why: 'One PR per package is noise you end up ignoring.', cmds: [GROUP_SNIPPET], note: 'Groups bundle routine updates into one PR; majors stay separate. Cooldown waits a week before proposing a new release (security updates are never delayed). Afterwards Dependabot closes the single-package PRs it replaces.', ref: REFS.dependabotOptions };
  if (id === 'release-version-behind') return { phase: 7, rank: 2, why: 'The manifest version is older than a released version.', cmds: m ? [`grep -n version ${sq(m.file)}`, `git tag --list --sort=-v:refname | head -3`] : [], note: 'Bump the manifest past the newest released version before the next release (and the lockfile, if it records the version).', ref: REFS.semver };
  if (id === 'release-untagged') return { phase: 7, rank: 3, why: 'The version was bumped but never tagged.', cmds: ['git fetch --tags', `git tag --list --sort=-v:refname | head -3`, 'gh run list --limit 5   # did the release workflow run?'], note: 'If CI tags releases, fix or re-run that workflow. Otherwise ask the owner before tagging or publishing anything.' };
  if (id === 'release-unreleased') return { phase: 7, rank: 6, why: 'Users of the released version are missing a lot of work.', cmds: rel.latest ? [`git log --oneline ${sq('refs/tags/' + rel.latest)}..HEAD`] : [], note: 'Ask the owner whether to cut a release. GutCheck never tags or publishes.' };
  if (id === 'changelog-stale') return { phase: 7, rank: 7, why: 'The changelog skips the newest release.', cmds: rel.latest ? [`git log --oneline -30 ${sq("refs/tags/" + rel.latest)}   # the changes up to the release`] : [], note: `Add a section for ${rel.version || 'the latest version'} from those commits.`, ref: REFS.changelog };
  if (id === 'baseline-drift') return { phase: 3, rank: 8, why: 'The owner\'s baseline says every repo should have these.', cmds: [], note: `Missing: ${((r.drift && r.drift.failed) || []).map((f) => f.label).join(', ')}. The other steps for this repo cover most of them; anything left needs the owner's decision.` };
  return null;
}

// One line for the repo snapshot: what the owner has accepted, so nobody re-suggests it.
function ignoredLine(r, t) {
  const list = r.ignored || [];
  if (!list.length) return null;
  return `- Ignored by the owner (do not suggest fixing these): ${list.slice(0, 12).map((f) => `${t(f.id, 60)} (${t(f.ignoredBecause, 120)})`).join('; ')}${list.length > 12 ? `; and ${list.length - 12} more` : ''}`;
}

module.exports = { upkeepFix, ignoredLine, REFS };
