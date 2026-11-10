// Local git state that is not in `git status`: an unfinished operation, whether a detached HEAD holds
// commits nothing else points to, maintenance health, and the identity commits are made with.
// Read-only. Every git call goes through the runner it is given (exec.git for scans, ctx.safeGit
// for plans), so a repo's own config cannot make a scan run its code. Paths come from
// `git rev-parse --git-path`, which is right for linked worktrees (own HEAD, shared objects).

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./exec');

const lines = (s) => s.split('\n').filter(Boolean);

// The signals git's own prompt script (contrib/completion/git-prompt.sh) reads to show "|REBASE-i",
// "|MERGING", "|CHERRY-PICKING", "|REVERTING", "|BISECTING" and "|AM".
const MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'];

// kind -> what to say and the commands. abort is the full git argument list.
const OPS = {
  rebase: { label: 'rebase', cont: 'git rebase --continue', abort: ['rebase', '--abort'] },
  am: { label: 'git am (patch series)', cont: 'git am --continue', abort: ['am', '--abort'] },
  merge: { label: 'merge', cont: 'git commit   # once the conflicts are resolved and staged', abort: ['merge', '--abort'] },
  'cherry-pick': { label: 'cherry-pick', cont: 'git cherry-pick --continue', abort: ['cherry-pick', '--abort'] },
  revert: { label: 'revert', cont: 'git revert --continue', abort: ['revert', '--abort'] },
  bisect: { label: 'bisect', cont: 'git bisect good   # or: git bisect bad', abort: ['bisect', 'reset'] },
};

const first = (p) => { try { return fs.readFileSync(p, 'utf8').slice(0, 200).split('\n')[0].trim(); } catch { return ''; } };
const isDir = (io, p) => { try { return io.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (io, p) => { try { return io.statSync(p).isFile(); } catch { return false; } };

// runGit(args) -> { ok, stdout }. Returns the operations in progress, the main one first: [{ kind }].
async function detectOperations(runGit, dir, io = fs) {
  const r = await runGit(['rev-parse', ...MARKERS.flatMap((m) => ['--git-path', m])]);
  if (!r.ok) return [];
  const p = Object.fromEntries(MARKERS.map((m, i) => [m, path.resolve(dir, r.stdout.split('\n')[i] || '.')]));
  const there = (m) => { try { io.statSync(p[m]); return true; } catch { return false; } };
  const found = [];
  if (isDir(io, p['rebase-merge'])) found.push('rebase');
  else if (isDir(io, p['rebase-apply'])) found.push(isFile(io, path.join(p['rebase-apply'], 'rebasing')) ? 'rebase' : 'am');
  // A rebase picks commits itself, so its own MERGE_HEAD or CHERRY_PICK_HEAD is part of it.
  if (!found.length) {
    if (there('MERGE_HEAD')) found.push('merge');
    else if (there('CHERRY_PICK_HEAD')) found.push('cherry-pick');
    else if (there('REVERT_HEAD')) found.push('revert');
    else if (isDir(io, p.sequencer)) {
      // A multi-commit pick or revert stopped between commits has only sequencer/todo.
      const w = first(path.join(p.sequencer, 'todo')).split(/\s+/)[0];
      if (/^(pick|p)$/.test(w)) found.push('cherry-pick');
      else if (/^(revert|r)$/.test(w)) found.push('revert');
    }
  }
  if (there('BISECT_LOG')) found.push('bisect');
  return found.map((kind) => ({ kind }));
}

// Commits reachable from HEAD that no branch, tag or remote-tracking branch holds.
async function unreferencedCommits(runGit) {
  const r = await runGit(['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes']);
  return r.ok ? Number(r.stdout.trim()) || 0 : null;
}

// git-gc: `git gc --auto` prints gc.log and does nothing while it is newer than gc.logExpiry (default 1 day).
async function gcLogBlocking(runGit, dir) {
  const r = await runGit(['rev-parse', '--git-path', 'gc.log']);
  if (!r.ok) return false;
  let mtime;
  try { mtime = fs.statSync(path.resolve(dir, r.stdout.trim())).mtimeMs; } catch { return false; }
  const e = await runGit(['config', '--type=expiry-date', '--get', 'gc.logExpiry']);
  const cutoff = e.ok && /^\d+$/.test(e.stdout.trim()) ? Number(e.stdout.trim()) * 1000 : Date.now() - 864e5;
  return mtime > cutoff;
}

// GutCheck's own bar for "big enough that a commit-graph matters" (git's --auto threshold is only
// 100 commits missing from the graph, which says when to update one, not when to flag it).
const GRAPH_MIN_COMMITS = 10000;

async function commitGraph(runGit, dir) {
  const r = await runGit(['rev-parse', '--git-path', 'objects/info/commit-graph', '--git-path', 'objects/info/commit-graphs']);
  const [single, chain] = r.ok ? r.stdout.split('\n').map((x) => path.resolve(dir, x)) : [];
  const has = !!single && (fs.existsSync(single) || fs.existsSync(chain));
  let commits = null;
  if (!has) {
    const c = await runGit(['rev-list', '--count', `--max-count=${GRAPH_MIN_COMMITS}`, 'HEAD']);
    commits = c.ok ? Number(c.stdout.trim()) || 0 : null;
  }
  return { commitGraph: has, commits };
}

const real = (p) => { try { return fs.realpathSync(p.replace(/\/+$/, '') || '/'); } catch { return p; } };

// Is the repo in the user's global maintenance.repo (git maintenance register / start)?
async function registered(runGit, dir) {
  const r = await runGit(['config', '--global', '--get-all', 'maintenance.repo']);
  const me = real(dir);
  return r.ok && lines(r.stdout).some((x) => real(x) === me);
}

// Noreply addresses of one account: 123+name@users.noreply.github.com and name@users.noreply.github.com.
const norm = (e) => String(e).trim().toLowerCase().replace(/^\d+\+(?=.+@users\.noreply\.github\.com$)/, '');
const RECENT_COMMITS = 50;

async function identity(runGit) {
  const cfg = async (k) => { const r = await runGit(['config', '--get', k]); return r.ok ? r.stdout.trim() : ''; };
  const [email, name, authorEmail, only] = await Promise.all([cfg('user.email'), cfg('user.name'), cfg('author.email'), runGit(['config', '--type=bool', '--get', 'user.useConfigOnly'])]);
  const env = process.env;
  // git also takes the address from these (checked in the order git does: author-specific first).
  const set = !!(email || authorEmail || env.GIT_AUTHOR_EMAIL || env.EMAIL);
  const id = { email, name, autoGenerated: !set, useConfigOnly: only.ok && only.stdout.trim() === 'true', recent: 0, mine: 0, other: [] };
  if (!email || !name) return id;
  const log = await runGit(['log', `-n${RECENT_COMMITS}`, '--format=%aE%x09%aN', 'HEAD']); // %aE and %aN honour .mailmap
  if (!log.ok) return id;
  const counts = new Map();
  for (const l of lines(log.stdout)) {
    const [e, n] = l.split('\t');
    id.recent++;
    if ((n || '').toLowerCase() !== name.toLowerCase()) continue;
    id.mine++;
    if (norm(e) !== norm(email)) counts.set(e, (counts.get(e) || 0) + 1);
  }
  id.other = [...counts].map(([e, count]) => ({ email: e, count })).sort((a, b) => b.count - a.count);
  return id;
}

// g: { detached, storage } from the scan. Never throws: a failed read leaves that part out.
async function collectGitState(dir, g = {}) {
  const run = (args) => git(args, { cwd: dir });
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  const [ops, unref, gcLog, graph, reg, ident] = await Promise.all([
    safe(() => detectOperations(run, dir), []),
    g.detached ? safe(() => unreferencedCommits(run), null) : null,
    safe(() => gcLogBlocking(run, dir), false),
    safe(() => commitGraph(run, dir), { commitGraph: true, commits: null }),
    safe(() => registered(run, dir), false),
    safe(() => identity(run), null),
  ]);
  return {
    ops,
    detached: g.detached ? { unreferenced: unref } : null,
    maintenance: { gcLogBlocking: gcLog, ...graph, registered: reg },
    identity: ident,
  };
}

module.exports = { collectGitState, detectOperations, OPS, MARKERS, GRAPH_MIN_COMMITS, RECENT_COMMITS, norm };
