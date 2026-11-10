// Plan-time guards for action git steps (audit 2026-11-09, B6-B10). A scanned repo's ref names and
// .git/config may have been written by someone else, so:
// - names from a scan only reach a git command line if they are plain names (never an option);
// - a step that talks to a remote is refused when the repo's own config names a program for it;
// - a step that would run the repo's own hooks or filter drivers says so, and is rated caution.
// Trust is the same as git-drivers.js: a repo key whose value equals the user's global or system
// value is the user's own. Reading config runs nothing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// The first character is a letter or digit, so a valid name never starts with "-".
const validBranch = (b) => typeof b === 'string' && BRANCH_RE.test(b) && !b.includes('..') && !b.includes('//') && !/(\.lock|[./])$/.test(b);
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const validRemote = (r) => typeof r === 'string' && REMOTE_RE.test(r);

// Keys (git's lower-cased names) whose value is a program git runs when it talks to a remote,
// and remote.<r>.vcs, which names a remote helper (git-remote-<vcs>) to run instead of a transport.
const NETWORK_KEYS = '^(core\\.(sshcommand|askpass|gitproxy)|remote\\..+\\.(uploadpack|receivepack|vcs)|credential\\.(.+\\.)?helper|url\\..+\\.(insteadof|pushinsteadof))$';
// The only remote addresses actions talk to: https, ssh and git, or scp-style [user@]host:path.
// Not a local folder or file:// (that runs the other repo's own hooks, or this one's: url = .), and
// not <helper>::address, which runs git-remote-<helper>.
const PLAIN_URL = /^((https?|ssh|git|git\+ssh|ssh\+git):\/\/|([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:(?!:|\/\/))/;
const PRETTY = { sshcommand: 'sshCommand', askpass: 'askPass', gitproxy: 'gitProxy' };

// The names to show for the repo's own network programs. A credential or url subsection is a URL,
// which can hold a token, so it is never shown.
function networkPrograms(untrusted) {
  const out = new Set();
  for (const e of untrusted) {
    if (!e.value || /^remote\..+\.vcs$/.test(e.key)) continue; // empty: switched off (credential.helper= resets the list); vcs: see remoteProblem
    let m = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(e.key);
    if (m) { if (!PLAIN_URL.test(m[1])) out.add(`url.<address>.${m[2] === 'insteadof' ? 'insteadOf' : 'pushInsteadOf'}`); continue; }
    if ((m = /^core\.(.+)$/.exec(e.key))) out.add(`core.${PRETTY[m[1]] || m[1]}`);
    else if ((m = /^remote\.(.+)\.(uploadpack|receivepack)$/.exec(e.key))) out.add(`remote.${validRemote(m[1]) ? m[1] : '<name>'}.${m[2]}`);
    else if (e.key === 'credential.helper') out.add('credential.helper');
    else out.add('credential.<url>.helper');
  }
  return [...out];
}

// The first remote (of those a step talks to) whose address, after url.<base>.insteadOf and
// pushInsteadOf, is not a plain network one, or that names a remote helper.
async function remoteProblem(ctx, dir, all, remotes, push) {
  for (const r of remotes) {
    if (all.some((e) => e.key === `remote.${r}.vcs` && e.value && e.origin !== 'command line:')) return r;
    const urls = [];
    for (const args of [['remote', 'get-url', '--all', r], ...(push ? [['remote', 'get-url', '--push', '--all', r]] : [])]) {
      const g = await ctx.safeGit(args, dir);
      if (!g.ok) throw new Error(`Could not read where the remote "${r}" points.`);
      urls.push(...g.stdout.split('\n').filter(Boolean));
    }
    if (urls.some((u) => !PLAIN_URL.test(u))) return r;
  }
  return null;
}

// What each kind of git step runs. Hooks: githooks(5); reference-transaction runs on every ref
// update, post-index-change whenever the index is written (pre-auto-gc cannot: steps run with
// gc.auto=0). filters: the step checks files in or out (clean, smudge and process drivers, and
// git-lfs programs named in the repo's config). mergeDrivers: a real merge can run
// merge.<driver>.driver. tree: the step changes or commits the work tree, so a hooks folder inside
// it can gain hooks, or decide which run, through the files themselves.
const USES = {
  fetch: { hooks: ['reference-transaction'], network: true },
  pull: { hooks: ['reference-transaction', 'post-merge', 'post-index-change'], filters: true, network: true, tree: true },
  push: { hooks: ['pre-push', 'reference-transaction'], network: true },
  switch: { hooks: ['post-checkout', 'reference-transaction', 'post-index-change'], filters: true, tree: true },
  merge: { hooks: ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge', 'reference-transaction', 'post-index-change'], filters: true, mergeDrivers: true, tree: true },
  commit: { hooks: ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change'], filters: true, tree: true },
  'ref-update': { hooks: ['reference-transaction'] },
  // rebase/am/merge/cherry-pick/revert --abort and bisect reset: reset the index and work tree.
  abort: { hooks: ['post-checkout', 'reference-transaction', 'post-index-change'], filters: true, tree: true },
};

const CODE_KEYS = '^(core\\.hookspath|hook\\..+\\.(command|event|enabled)|filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|lfs\\.(extension\\..+\\.(clean|smudge)|customtransfer\\..+\\.path|standalonetransferagent)|commit\\.gpgsign|include\\.path|includeif\\..+\\.path)$';

const expand = (v) => (v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v);
const inside = (dir, f) => { const rel = path.relative(dir, f); return !rel.startsWith('..') && !path.isAbsolute(rel); };
const shown = (dir, f) => (f !== dir && inside(dir, f) ? path.relative(dir, f) : f);
const runnable = (f) => { try { return fs.statSync(f).isFile() && (fs.accessSync(f, fs.constants.X_OK), true); } catch { return false; } };
const label = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
// A path with its symlinks resolved, as far as it exists (the rest may arrive later).
function real(p) {
  const rest = [];
  for (let cur = p; ;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return p;
    rest.unshift(path.basename(cur));
    cur = up;
  }
}
// Inside the work tree after symlinks, or anywhere under /proc (/proc/self/cwd is git's own cwd when
// it runs, not ours when we look): such a path can name the repo's own files.
const inTree = (dir, p) => p.startsWith('/proc/') || real(p).startsWith('/proc/') || inside(real(dir), real(p));

// The hooks folder whose files are the repo's code (dir; null when it is the user's own: their
// config's core.hooksPath, outside the work tree), why the repo's files can add or change hooks
// (tree: a core.hooksPath from the repo's own config, whatever its value, or any inside the work
// tree), and the folder relative to the work tree for listing a branch's hooks (rel).
async function repoHooks(ctx, dir, all, untrusted) {
  // Not the command line's: the config read itself runs with core.hooksPath=/dev/null.
  const hp = all.filter((e) => e.key === 'core.hookspath' && e.origin !== 'command line:').pop();
  if (hp && hp.value) {
    const abs = path.resolve(dir, expand(hp.value));
    const own = !untrusted.includes(hp);
    const there = inTree(dir, abs);
    const rel = there && inside(dir, abs) && abs !== dir ? path.relative(dir, abs) : null;
    const tree = !own ? `This repo's own git config chooses its hooks folder (${label(hp.value)}), so this step can run hooks that come with its files.`
      : there ? `Your git config keeps hooks in each repo's files (${label(hp.value)}), so this step can run hooks that come with this repo's files.` : null;
    return { dir: own && !there && path.isAbsolute(expand(hp.value)) ? null : abs, tree, rel };
  }
  // No core.hooksPath: the hooks folder of the repo's common dir (a linked worktree shares it).
  // Same as `git rev-parse --git-path hooks`, which reads the core.hooksPath safeGit blanks.
  const c = await ctx.safeGit(['rev-parse', '--git-common-dir'], dir);
  const common = c.ok && c.stdout.trim();
  if (!common) throw new Error('Could not find this repo\'s hooks folder.');
  return { dir: path.join(path.resolve(dir, common), 'hooks'), tree: null, rel: null };
}

// A config file the repo's own config includes from its work tree (it may not exist yet): a pull
// or checkout can then bring new hooks, filters or a hooks folder with the files.
function includedFromTree(dir, untrusted) {
  for (const e of untrusted) {
    if (!/^include(if\..+)?\.path$/.test(e.key) || !e.value) continue;
    const from = e.origin.startsWith('file:') ? path.dirname(path.resolve(dir, e.origin.slice(5))) : dir;
    if (inTree(dir, path.resolve(from, expand(e.value)))) return `This repo's git config reads settings from its own files (${label(e.value)}), so this step can run hooks or filters that come with them.`;
  }
  return null;
}

// Executable hooks for these names in the files of `target` (a ref) under the in-tree hooks folder.
async function hooksInTarget(ctx, dir, rel, target, hooks) {
  if (!target || !rel) return [];
  const t = await ctx.safeGit(['ls-tree', '-r', target, '--', `${rel}/`], dir);
  if (!t.ok) throw new Error('Could not read the hooks in the files it checks out.');
  const name = target.replace(/^refs\/heads\//, '');
  return t.stdout.split('\n').map((l) => /^(100755|120000) blob \S+\t(.+)$/.exec(l)).filter(Boolean).map((m) => m[2])
    .filter((f) => path.posix.dirname(f) === rel.split(path.sep).join('/') && hooks.includes(path.posix.basename(f)))
    .map((f) => `${path.posix.basename(f)} hook (${f}, in the files of ${name})`);
}

// Hook and driver names the repo's own config, .git or files add to these kinds of step.
async function repoCode(ctx, dir, kinds, target) {
  const uses = kinds.map((k) => USES[k]);
  const hooks = [...new Set(uses.flatMap((u) => u.hooks || []))];
  const { all, untrusted } = await ctx.gitConfig(dir, CODE_KEYS);
  const found = [];
  const h = await repoHooks(ctx, dir, all, untrusted);
  if (h.dir) for (const n of hooks) { const f = path.join(h.dir, n); if (runnable(f)) found.push(`${n} hook (${shown(dir, f)})`); }
  const treeStep = uses.some((u) => u.tree);
  const tree = treeStep ? [h.tree, includedFromTree(dir, untrusted)].filter(Boolean) : [];
  if (treeStep && h.rel) found.push(...(await hooksInTarget(ctx, dir, h.rel, target, hooks)));
  // Config-based hooks (git 2.54+): hook.<name>.command on hook.<name>.event.
  // The repo's own config decides a hook when it sets its command or any of its events (the other
  // half may be the user's: a repo can give the user's command an event). The command is never
  // shown. An empty value resets: a last empty command, or enabled=false, means it does not run.
  const named = new Map(); // friendly name -> { events, command, enabled, via }
  const hook = (n) => named.get(n) || (named.set(n, { events: [], command: false, enabled: true, via: null }), named.get(n));
  for (const e of all) {
    const m = /^hook\.(.+)\.(command|event|enabled)$/.exec(e.key);
    if (!m || e.origin === 'command line:') continue;
    const h = hook(m[1]);
    if (m[2] === 'event') h.events = e.value ? [...h.events, e.value] : [];
    else if (m[2] === 'command') h.command = !!e.value;
    else h.enabled = !/^(false|no|off|0)$/i.test(e.value || 'true');
    if (m[2] !== 'enabled' && untrusted.includes(e) && !h.via) h.via = m[2];
  }
  for (const [n, h] of named) {
    if (!h.via || !h.command || !h.enabled) continue;
    for (const ev of h.events.filter((x) => hooks.includes(x))) found.push(`${ev} hook (hook.${label(n).slice(0, 60)}.${h.via} in its git config)`);
  }
  const drivers = new Set();
  const filters = uses.some((u) => u.filters);
  const merges = uses.some((u) => u.mergeDrivers);
  for (const e of untrusted) {
    if (!e.value) continue;
    let m;
    if (filters && (m = /^filter\.(.+)\.(clean|smudge|process)$/.exec(e.key))) drivers.add(`filter.${m[1].slice(0, 60)}`);
    else if (filters && /^lfs\./.test(e.key)) drivers.add(e.key.replace(/^(lfs\.(extension|customtransfer))\..+\.(\w+)$/, '$1.<name>.$3'));
    else if (merges && (m = /^merge\.(.+)\.driver$/.exec(e.key))) drivers.add(`merge.${m[1].slice(0, 60)}`);
  }
  // The user's own config signs commits (steps run with commit.gpgSign=false).
  const sign = all.filter((e) => e.key === 'commit.gpgsign' && e.origin !== 'command line:').pop();
  const signs = !!sign && !untrusted.includes(sign) && /^(true|yes|on|1)$/i.test(sign.value || '');
  return { hooks: found, drivers: [...drivers], tree, signs };
}

// Checks a planned action (out.uses: the kinds of git step it runs; out.remotes and out.pushes:
// the remotes its network steps talk to). Throws the refusal for network programs and non-network
// remotes; otherwise returns { warnings, note, runsRepoCode } to add to the plan.
async function inspect(ctx, dir, out, refuse) {
  const uses = out.uses || [];
  if (!uses.length) return { warnings: [], note: null, runsRepoCode: false };
  if (uses.some((k) => USES[k].network)) {
    const { all, untrusted } = await ctx.gitConfig(dir, NETWORK_KEYS);
    const progs = networkPrograms(untrusted);
    if (progs.length) refuse(`This repo's own git config names programs to run for network commands (${progs.join(', ')}). GutCheck won't run them; remove them or run git yourself.`);
    const bad = await remoteProblem(ctx, dir, all, out.remotes || [], !!out.pushes);
    if (bad) refuse(`This repo's remote "${bad}" is a local folder, a file:// URL or a remote helper. GutCheck only talks to https, ssh and git remotes (a local remote runs that repo's own hooks); run git yourself.`);
  }
  const code = await repoCode(ctx, dir, uses, out.target);
  const warnings = [];
  for (const t of code.tree) warnings.push(`${t} That is the repo's code, not GutCheck's.`);
  if (code.hooks.length) warnings.push(`This runs the repo's own ${code.hooks.join(', ')}. That is the repo's code, not GutCheck's.`);
  if (code.drivers.length) warnings.push(`This runs programs the repo's own git config names for its files (${code.drivers.join(', ')}). That is the repo's code, not GutCheck's.`);
  const commits = uses.includes('commit') || uses.includes('merge');
  const note = commits && code.signs ? 'Your git config signs commits (commit.gpgSign), but GutCheck\'s commits are not signed: signing runs programs a repo\'s config can change.' : null;
  return { warnings, note, runsRepoCode: warnings.length > 0 };
}

module.exports = { validBranch, validRemote, networkPrograms, inspect, PLAIN_URL, USES, NETWORK_KEYS, CODE_KEYS };
