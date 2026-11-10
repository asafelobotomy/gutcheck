// The rescue copy: save everything a repo holds that exists only on this machine into a folder
// outside the workspace, without changing the repo. A full bundle (every ref, restorable with no
// remote), a patch of uncommitted changes, one patch per stash, a copy of untracked files that are
// not ignored and not secrets, and MANIFEST.txt (names and sizes, never contents).
// Every git step runs with the repo's hooks, filters and config-defined commands switched off.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandHome, printable, plural } = require('./util');
const { findRepoSecrets } = require('./secrets');
const { summarizeLocalOnly } = require('./local-only');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const BUNDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MiB = 1024 * 1024;

// The real path of p, even when its last parts do not exist yet.
function realOf(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...rest.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    rest.push(path.basename(head));
    head = up;
  }
}
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mb = (n) => (n >= 1024 * MiB ? `${(n / (1024 * MiB)).toFixed(1)} GB` : `${Math.max(1, Math.round(n / MiB))} MB`);

module.exports = ({ fail, nothing }) => ({
  'rescue-bundle': {
    async plan(r, p, ctx) {
      const home = ctx.home || os.homedir();
      if (p.dest != null && typeof p.dest !== 'string') fail('dest must be a folder path.');
      const base = expandHome(p.dest || ctx.rescueDir || path.join(home, 'GutCheck-rescue'), home);
      const name = path.basename(r.path);
      const dest = path.join(base, today(), name);
      const real = realOf(dest);
      const guarded = [ctx.workspaceRoot, ...(ctx.repoPaths || []), r.path].filter(Boolean).map(realOf);
      if (guarded.some((g) => within(real, g))) fail('Choose a folder outside the workspace and its repos.');
      let existing = [];
      try { existing = fs.readdirSync(dest); } catch { /* not there yet */ }
      if (existing.length) fail(`${printable(dest)} already has files. Choose another folder.`);

      const git = (args) => ctx.safeGit(args, r.path);
      const lo = r.localOnly || { branches: [], stashes: 0, uncommitted: 0, untracked: 0, any: false };
      const hasCommits = !(r.hygiene && r.hygiene.noCommits) && (await git(['rev-parse', '-q', '--verify', 'HEAD'])).ok;
      const ls = await git(['ls-files', '-o', '--exclude-standard', '-z']);
      const others = ls.ok ? ls.stdout.split('\0').filter(Boolean) : [];
      if (!hasCommits && !others.length) nothing('Nothing to save: the repo has no commits and no untracked files.');

      // Untracked files: keep regular files that are not secrets and not too large.
      const secrets = new Set((await findRepoSecrets(r.path).catch(() => [])).map((c) => c.real));
      const max = ctx.maxFileBytes || MAX_FILE_BYTES;
      const keep = [];
      const skipped = [];
      for (const rel of others) {
        const abs = path.join(r.path, rel);
        let st;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (!st.isFile()) { skipped.push(`skipped ${printable(rel)}: not a regular file`); continue; }
        let rp = abs;
        try { rp = fs.realpathSync(abs); } catch { /* keep abs */ }
        if (secrets.has(rp)) { skipped.push(`skipped ${printable(rel)}: secret (back it up with GutCheck's Secrets backup)`); continue; }
        if (st.size > max) { skipped.push(`skipped ${printable(rel)}: too large (${mb(st.size)})`); continue; }
        keep.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      }

      const step = (args, extra = {}) => ({ safeGit: true, cmd: 'git', args, cwd: r.path, display: `git ${args.map(printable).join(' ')}`, ...extra });
      const out = (f) => path.join(dest, f);
      const steps = [{ kind: 'mkdir', path: dest, display: `create ${printable(dest)} (private)` }];
      const written = [];
      const warnings = [];
      if (hasCommits) {
        steps.push(step(['bundle', 'create', out('repo.bundle'), '--all'], { timeout: BUNDLE_TIMEOUT_MS }));
        steps.push(step(['bundle', 'verify', out('repo.bundle')]));
        written.push('repo.bundle: every branch, tag and the latest stash (git clone repo.bundle <folder>)');
        if (lo.uncommitted > 0) {
          steps.push(step(['diff', 'HEAD', '--binary', `--output=${out('uncommitted.patch')}`]));
          written.push('uncommitted.patch: changes to tracked files (git apply uncommitted.patch)');
        }
        if (lo.stashes > 0) {
          // Feature check on the real git rather than a version number.
          const withUntracked = (await git(['stash', 'show', '--include-untracked', '--stat', 'stash@{0}'])).ok;
          if (!withUntracked) warnings.push('This git cannot include untracked files in stash patches; they stay only in the bundle\'s stash commits.');
          for (let n = 0; n < lo.stashes; n++) {
            steps.push(step(['stash', 'show', '-p', '--binary', ...(withUntracked ? ['--include-untracked'] : []), `--output=${out(`stash-${n}.patch`)}`, `stash@{${n}}`]));
            written.push(`stash-${n}.patch: stash@{${n}} (git apply stash-${n}.patch)`);
          }
        }
      }
      if (keep.length) {
        steps.push({ kind: 'copy', root: r.path, dest: out('untracked'), files: keep, display: `copy ${plural(keep.length, 'untracked file')} to untracked/`, preview: keep.slice(0, 50).map((f) => printable(f.rel)).join('\n') });
        written.push(`untracked/: ${plural(keep.length, 'file')} not committed and not ignored`);
      }

      const version = (await git(['--version'])).stdout.trim();
      const head = hasCommits ? (await git(['rev-parse', 'HEAD'])).stdout.trim() : '(no commits)';
      const manifest = [
        `GutCheck rescue copy of ${printable(name)}`,
        `Folder: ${printable(r.path)}`,
        `Date: ${new Date().toISOString()}`,
        `HEAD: ${head}`,
        version,
        '',
        `Local-only work: ${summarizeLocalOnly(lo) || 'none found (saved anyway)'}`,
        ...lo.branches.map((b) => `  branch ${printable(b.name)}: ${plural(b.ahead, 'commit')} on no remote`),
        '',
        'Files:',
        ...written.map((w) => `  ${w}`),
        '',
        ...(skipped.length ? ['Not copied:', ...skipped.map((s) => `  ${s}`), ''] : []),
        'Not included: local work inside submodules and linked worktrees.',
        '',
        'Restore:',
        '  git clone repo.bundle <name>',
        '  cd <name> && git apply ../uncommitted.patch',
        '  git apply ../stash-0.patch   # or keep it as a branch',
        '  cp -r ../untracked/. .',
        '',
      ].join('\n');
      steps.push({ kind: 'write', root: dest, path: out('MANIFEST.txt'), content: manifest, display: 'write MANIFEST.txt (names and sizes only)' });

      const kib = (r.hygiene && r.hygiene.storage && r.hygiene.storage.packKiB) || 0;
      const size = kib * 1024 + keep.reduce((n, f) => n + f.size, 0);
      return {
        risk: 'safe',
        title: `Save a rescue copy of ${printable(name)}`,
        steps,
        warnings,
        note: `Writes only to ${printable(dest)} (about ${mb(size)}); the repo is not changed. If a step fails, what was written so far stays there.${lo.any ? '' : ' Nothing in this repo is local-only; this saves it anyway.'}`,
      };
    },
  },
});
