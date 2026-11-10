// Report steps for the local git state findings (git-op, git-maintenance, git-identity).
const { OPS } = require('./git-state');

const REFS = {
  prompt: 'https://raw.githubusercontent.com/git/git/master/contrib/completion/git-prompt.sh',
  maintenance: 'https://git-scm.com/docs/git-maintenance',
  gc: 'https://git-scm.com/docs/git-gc',
  config: 'https://git-scm.com/docs/git-config#_conditional_includes',
  commits: 'https://docs.github.com/en/pull-requests/how-tos/commit-changes/troubleshooting-commits',
};

function gitStateFix(id, r) {
  const gs = r.gitState || {};
  if (id === 'git-op') {
    const op = OPS[(gs.ops && gs.ops[0] && gs.ops[0].kind) || ''];
    if (!op) return { phase: 1, rank: -1, why: 'Git stopped part way through an operation.', cmds: ['git status'], note: 'Ask the owner whether to finish or abort it.', ref: REFS.prompt };
    return {
      phase: 1, rank: -1, why: `A ${op.label} is unfinished, so the branch is in a half-changed state and other git commands may refuse or add to the mess.`,
      cmds: ['git status   # shows the files left to resolve', op.cont],
      note: `Finish it: resolve the conflicts, stage the files, then continue. Aborting (git ${op.abort.join(' ')}) discards any conflict resolution done so far, so ask the owner first and never abort on your own. Do not run other steps in this repo until it is finished or aborted. Detected from the marker files git's own prompt script reads.`,
      ref: REFS.prompt,
    };
  }
  if (id === 'git-maintenance') {
    const m = gs.maintenance || {};
    const cmds = ['git count-objects -vH'];
    if (m.gcLogBlocking) cmds.push('cat .git/gc.log   # why the last automatic gc failed');
    if (!m.registered) cmds.push('git maintenance register   # writes the user\'s GLOBAL git config');
    cmds.push('git maintenance run   # one pass of the enabled tasks, safe to repeat');
    return { phase: 7, rank: 9, why: 'Git\'s own automatic housekeeping is behind or blocked, which slows git down and wastes space.', cmds, note: 'Register adds this repo to maintenance.repo in the global config and sets maintenance.auto=false here; ask before running it. It schedules nothing: git maintenance start does that. Do not delete .git/gc.log or run git gc --prune=now without reading the log and asking the owner.', ref: `${REFS.maintenance} and ${REFS.gc}` };
  }
  if (id === 'git-identity') {
    const id_ = gs.identity || {};
    return { phase: 7, rank: 9, why: 'GitHub links commits to an account by their email address.', cmds: ['git config --show-origin --get user.email   # where the address comes from', 'git config --global user.useConfigOnly true   # git asks instead of guessing'], note: `Configured here: ${id_.email ? String(id_.email).replace(/[`\s]/g, '') : 'none'}. Ask the owner which address belongs to this repo. Per-folder identities go in ~/.gitconfig as [includeIf "gitdir:~/work/"] path = ~/.gitconfig-work, or [includeIf "hasconfig:remote.*.url:git@github.com:ORG/**"]. Do not rewrite existing commits to change their email.`, ref: `${REFS.config} and ${REFS.commits}` };
  }
  return null;
}

module.exports = { gitStateFix };
