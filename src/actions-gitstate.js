// Actions for the local git state findings, built with actions.js's own step builders:
//  - git-op-abort: `git <op> --abort` (or `git bisect reset`) for an unfinished operation. Only an
//    operation that is really in progress now, and only the kinds GutCheck names; never offered by Fix all.
//  - maintenance-register: `git maintenance register`, which adds the repo to maintenance.repo in the
//    user's GLOBAL git config. It runs no repo code (it only writes config) and schedules nothing:
//    `git maintenance start` would install the timers, and GutCheck does not run it.

const { detectOperations, OPS } = require('./git-state');

const ABORT_NOTES = {
  rebase: 'Aborting returns the branch to where it was before the rebase started. Commits already replayed, and any conflict resolution you have done, are discarded.',
  am: 'Aborting returns the branch to where it was before the patches were applied. Patches already applied, and any conflict resolution you have done, are discarded.',
  merge: 'Aborting returns to the state before the merge. Conflict resolution you have done is discarded, and changes you had not committed before the merge may not be restored.',
  'cherry-pick': 'Aborting returns to the state before the cherry-pick. Conflict resolution you have done is discarded.',
  revert: 'Aborting returns to the state before the revert. Conflict resolution you have done is discarded.',
  bisect: 'Ending the bisect checks out the branch you started from. Your good/bad marks are forgotten (git bisect log shows them first).',
};

module.exports = ({ fail, nothing, git, readGit }) => ({
  'git-op-abort': {
    async plan(r, p, ctx) {
      if (!Object.prototype.hasOwnProperty.call(OPS, p.op)) fail('Unknown operation.');
      const found = await detectOperations((a) => readGit(ctx, a, r.path), r.path, ctx.fs);
      if (!found.some((o) => o.kind === p.op)) nothing(`No ${OPS[p.op].label} is in progress any more.`);
      const o = OPS[p.op];
      return {
        risk: 'danger', uses: ['abort'], title: `${p.op === 'bisect' ? 'End' : 'Abort'} the unfinished ${o.label}`,
        steps: [git(o.abort, r.path)],
        warnings: [ABORT_NOTES[p.op], `To keep your work instead, finish it: ${o.cont.split('   #')[0]}.`],
        undo: p.op === 'bisect' ? 'git bisect start, then git bisect good/bad again (see the log above).' : 'Not undoable: the discarded resolution is not saved anywhere. git reflog shows the commit the branch was on.',
      };
    },
  },

  'maintenance-register': {
    async plan(r, p, ctx) {
      const reg = await readGit(ctx, ['config', '--global', '--get-all', 'maintenance.repo'], r.path);
      const real = (x) => { try { return ctx.fs.realpathSync(x); } catch { return x; } };
      if (reg.ok && reg.stdout.split('\n').some((x) => x && real(x.replace(/\/+$/, '')) === real(r.path))) nothing('This repo is already registered for maintenance.');
      return {
        risk: 'caution', title: 'Register this repo for git maintenance',
        steps: [git(['maintenance', 'register'], r.path)],
        warnings: [`This writes your global git config: it adds ${r.path} to maintenance.repo, sets maintenance.strategy=incremental if you have not set one, and sets maintenance.auto=false in this repo's own config (background maintenance replaces gc --auto).`],
        note: 'Nothing is scheduled by this step: git maintenance start would install the timers, and GutCheck does not run it.',
        undo: 'git maintenance unregister   (maintenance.auto=false stays in this repo\'s config)',
      };
    },
  },
});
