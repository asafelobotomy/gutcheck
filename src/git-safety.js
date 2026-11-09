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

// Keys (git's lower-cased names) whose value is a program git runs when it talks to a remote.
const NETWORK_KEYS = '^(core\\.(sshcommand|askpass|gitproxy)|remote\\..+\\.(uploadpack|receivepack)|credential\\.(.+\\.)?helper|url\\..+\\.(insteadof|pushinsteadof))$';
// url.<base>.insteadOf may point a remote at another transport; these schemes run no repo program.
const PLAIN_URL = /^((https?|ssh|git|git\+ssh|ssh\+git):\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!:))/;
const PRETTY = { sshcommand: 'sshCommand', askpass: 'askPass', gitproxy: 'gitProxy' };

// The names to show for the repo's own network programs. A credential or url subsection is a URL,
// which can hold a token, so it is never shown.
function networkPrograms(untrusted) {
  const out = new Set();
  for (const e of untrusted) {
    if (!e.value) continue; // an empty value switches the program off (credential.helper= resets the list)
    let m = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(e.key);
    if (m) { if (!PLAIN_URL.test(m[1])) out.add(`url.<address>.${m[2] === 'insteadof' ? 'insteadOf' : 'pushInsteadOf'}`); continue; }
    if ((m = /^core\.(.+)$/.exec(e.key))) out.add(`core.${PRETTY[m[1]] || m[1]}`);
    else if ((m = /^remote\.(.+)\.(uploadpack|receivepack)$/.exec(e.key))) out.add(`remote.${validRemote(m[1]) ? m[1] : '<name>'}.${m[2]}`);
    else if (e.key === 'credential.helper') out.add('credential.helper');
    else out.add('credential.<url>.helper');
  }
  return [...out];
}

// What each kind of git step runs. Hooks: githooks(5); reference-transaction runs on every ref
// update, post-index-change whenever the index is written, pre-auto-gc after commits, merges and
// fetches. filters: the step checks files in or out (clean, smudge and process drivers, and git-lfs
// programs named in the repo's config). mergeDrivers: a real merge can run merge.<driver>.driver.
const USES = {
  fetch: { hooks: ['reference-transaction', 'pre-auto-gc'], network: true },
  pull: { hooks: ['reference-transaction', 'pre-auto-gc', 'post-merge', 'post-index-change'], filters: true, network: true },
  push: { hooks: ['pre-push', 'reference-transaction'], network: true },
  switch: { hooks: ['post-checkout', 'reference-transaction', 'post-index-change'], filters: true },
  merge: { hooks: ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge', 'reference-transaction', 'post-index-change', 'pre-auto-gc'], filters: true, mergeDrivers: true },
  commit: { hooks: ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'pre-auto-gc'], filters: true },
  'ref-update': { hooks: ['reference-transaction'] },
};

const CODE_KEYS = '^(core\\.hookspath|hook\\..+\\.(command|event)|filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|lfs\\.(extension\\..+\\.(clean|smudge)|customtransfer\\..+\\.path|standalonetransferagent))$';

const expand = (v) => (v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v);
const shown = (dir, f) => { const rel = path.relative(dir, f); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : f; };
const runnable = (f) => { try { return fs.statSync(f).isFile() && (fs.accessSync(f, fs.constants.X_OK), true); } catch { return false; } };

// The hooks folder whose files are the repo's code, or null when it is the user's own: a
// core.hooksPath from the user's config that is absolute. A relative one points into the repo.
async function repoHooksDir(ctx, dir, all, untrusted) {
  // Not the command line's: the config read itself runs with core.hooksPath=/dev/null.
  const hp = all.filter((e) => e.key === 'core.hookspath' && e.origin !== 'command line:').pop();
  if (hp && hp.value) {
    const v = expand(hp.value);
    return !untrusted.includes(hp) && path.isAbsolute(v) ? null : path.resolve(dir, v);
  }
  // No core.hooksPath: the hooks folder of the repo's common dir (a linked worktree shares it).
  // Same as `git rev-parse --git-path hooks`, which reads the core.hooksPath safeGit blanks.
  const c = await ctx.safeGit(['rev-parse', '--git-common-dir'], dir);
  const common = c.ok && c.stdout.trim();
  if (!common) throw new Error('Could not find this repo\'s hooks folder.');
  return path.join(path.resolve(dir, common), 'hooks');
}

// Hook and driver names the repo's own config or .git adds to these kinds of step.
async function repoCode(ctx, dir, kinds) {
  const uses = kinds.map((k) => USES[k]);
  const hooks = [...new Set(uses.flatMap((u) => u.hooks || []))];
  const { all, untrusted } = await ctx.gitConfig(dir, CODE_KEYS);
  const found = [];
  const hooksDir = await repoHooksDir(ctx, dir, all, untrusted);
  if (hooksDir) for (const h of hooks) { const f = path.join(hooksDir, h); if (runnable(f)) found.push(`${h} hook (${shown(dir, f)})`); }
  // Config-based hooks (git 2.54+): hook.<name>.command on hook.<name>.event.
  const events = new Map();
  for (const e of all) {
    const m = /^hook\.(.+)\.event$/.exec(e.key);
    if (m) events.set(m[1], e.value ? [...(events.get(m[1]) || []), e.value] : []);
  }
  for (const e of untrusted) {
    const m = /^hook\.(.+)\.command$/.exec(e.key);
    if (m && e.value) for (const ev of (events.get(m[1]) || []).filter((x) => hooks.includes(x))) found.push(`${ev} hook (hook.${m[1].slice(0, 60)}.command in its git config)`);
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
  return { hooks: found, drivers: [...drivers] };
}

// Checks a planned action against the kinds of git step it runs (out.uses). Throws the refusal
// for network programs; otherwise returns what to add to the plan.
async function inspect(ctx, dir, uses, refuse) {
  if (!uses || !uses.length) return null;
  if (uses.some((k) => USES[k].network)) {
    const progs = networkPrograms((await ctx.gitConfig(dir, NETWORK_KEYS)).untrusted);
    if (progs.length) refuse(`This repo's own git config names programs to run for network commands (${progs.join(', ')}). GutCheck won't run them; remove them or run git yourself.`);
  }
  const code = await repoCode(ctx, dir, uses);
  const warnings = [];
  if (code.hooks.length) warnings.push(`This runs the repo's own ${code.hooks.join(', ')}. That is the repo's code, not GutCheck's.`);
  if (code.drivers.length) warnings.push(`This runs programs the repo's own git config names for its files (${code.drivers.join(', ')}). That is the repo's code, not GutCheck's.`);
  return warnings.length ? { warnings } : null;
}

module.exports = { validBranch, validRemote, networkPrograms, inspect, USES, NETWORK_KEYS, CODE_KEYS };
