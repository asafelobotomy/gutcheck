// Work that exists only on this machine: branches with commits on no remote, stashes, uncommitted
// and untracked changes, and missing or deleted remotes. Read-only: every git call goes through
// exec.git, and refs are passed in full (refs/heads/<name>) so no branch name reads as an option.

const { git } = require('./exec');
const { plural, printable, list } = require('./util');

const MAX_BRANCHES = 50;
const lines = (s) => String(s || '').split('\n').filter(Boolean);

// facts: what the scan already knows. { branch, noRemote, upstreamGone, stashes, uncommitted, untracked, detachedOnly }
async function collectLocalOnly(dir, facts = {}) {
  const run = (args) => git(args, { cwd: dir });
  const [heads, remotes] = await Promise.all([
    run(['for-each-ref', '--format=%(refname)', 'refs/heads']),
    run(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes']),
  ]);
  const refs = lines(heads.stdout);
  const neverPushed = remotes.ok && !lines(remotes.stdout).length;
  const counted = await Promise.all(refs.slice(0, MAX_BRANCHES).map(async (ref) => {
    const r = await run(['rev-list', '--count', ref, '--not', '--remotes']);
    return { name: ref.replace(/^refs\/heads\//, ''), ahead: r.ok ? Number(r.stdout.trim()) || 0 : 0 };
  }));
  const lo = {
    branches: counted.filter((b) => b.ahead > 0),
    truncated: refs.length > MAX_BRANCHES,
    neverPushed,
    stashes: facts.stashes || 0,
    uncommitted: facts.uncommitted || 0,
    untracked: facts.untracked || 0,
    noRemote: !!facts.noRemote,
    upstreamGone: !!facts.upstreamGone,
    detachedOnly: facts.detachedOnly || 0,
  };
  lo.any = lo.branches.length > 0 || lo.stashes > 0 || lo.uncommitted > 0 || lo.untracked > 0 || lo.noRemote || lo.upstreamGone || lo.detachedOnly > 0;
  return lo;
}

// "2 branches, 1 stash, 3 uncommitted, 1 untracked", or '' when nothing is local-only.
function summarizeLocalOnly(lo) {
  if (!lo || !lo.any) return '';
  return [
    lo.noRemote ? 'no remote' : '',
    lo.branches.length ? plural(lo.branches.length, 'branch', 'branches') : '',
    lo.stashes ? plural(lo.stashes, 'stash', 'stashes') : '',
    lo.uncommitted ? `${lo.uncommitted} uncommitted` : '',
    lo.untracked ? `${lo.untracked} untracked` : '',
    lo.upstreamGone ? 'upstream deleted' : '',
    lo.detachedOnly ? `${plural(lo.detachedOnly, 'commit')} on a detached HEAD only` : '',
  ].filter(Boolean).join(', ');
}

// Commits on branches other than the current one (git-ahead covers that) that exist on no remote.
// Only with a remote: without one, no-remote already says nothing is backed up.
function checkLocalOnly(s) {
  const lo = s.localOnly;
  if (!lo || !s.originUrl) return [];
  const cur = s.git && s.git.branch;
  const others = lo.branches.filter((b) => b.name !== cur);
  if (!others.length) return [];
  const n = others.length;
  return [{
    id: 'git-unpushed-branches', category: 'Branches', severity: 'warn',
    title: `${plural(n, 'other branch', 'other branches')} ${n === 1 ? 'has' : 'have'} commits on no remote`,
    detail: `${list(others.map((b) => `${printable(b.name)} (${b.ahead})`), 8)}${lo.truncated ? ' (only the first 50 branches were checked)' : ''}. These commits exist only on this machine.`,
    fix: { type: 'rescue-bundle', label: 'Save a rescue copy' },
  }];
}

module.exports = { collectLocalOnly, summarizeLocalOnly, checkLocalOnly, MAX_BRANCHES };
