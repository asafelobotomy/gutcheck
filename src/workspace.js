// Developer-level advice for the whole workspace: global git settings and disk space held by
// dependency folders of inactive projects. Read-only: git config is only read, sizes come from du.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./exec');
const { agentAdvice } = require('./agents');
const { workspaceIdentity } = require('./checks-gitstate');
const { cacheAdvice } = require('./cache-sizes');
const { summarizeLocalOnly } = require('./local-only');
const { DAY, COMMAND_TIMEOUT_MS, plural, list, sq, printable } = require('./util');

const INACTIVE_DAYS = 90;
const MAX_DEP_DIRS = 25;
// Dependency/build folders that a single command recreates. Detected only next to their manifest.
const DEP_DIRS = [
  { dir: 'node_modules', when: 'package.json', restore: 'npm ci (or the project\'s package manager)' },
  { dir: 'target', when: 'Cargo.toml', restore: 'cargo build', clean: 'cargo clean --dry-run' },
  { dir: '.venv', when: null, restore: 'recreate the virtualenv' },
  { dir: 'venv', when: null, restore: 'recreate the virtualenv' },
];
const GIT_DOCS = 'https://git-scm.com/docs/git-config';

const getGlobal = async (key) => {
  const r = await run('git', ['config', '--global', '--get', key], { cwd: os.homedir() });
  return r.ok ? r.stdout.trim() : '';
};

async function gitConfigAdvice() {
  const out = [];
  const [email, helper, excludes] = await Promise.all([getGlobal('user.email'), getGlobal('credential.helper'), getGlobal('core.excludesFile')]);
  if (!email) out.push({ id: 'ws-git-email', severity: 'warn', title: 'No global git user.email', detail: 'Commits fall back to a guessed address, or fail. GitHub links commits to your account by this address.', cmds: ['git config --global user.email "<you>@users.noreply.github.com"   # keeps your real address private'], ref: 'https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/setting-your-commit-email-address' });
  if (helper === 'store') out.push({ id: 'ws-git-store', severity: 'warn', title: 'Git stores passwords in plain text', detail: 'credential.helper=store writes tokens unencrypted to ~/.git-credentials.', cmds: ['gh auth setup-git   # or: git config --global credential.helper libsecret'], note: 'After switching, delete ~/.git-credentials and revoke any token it held.', ref: 'https://git-scm.com/docs/gitcredentials' });
  const defaultIgnore = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore');
  if (!excludes && !fs.existsSync(defaultIgnore)) out.push({ id: 'ws-git-ignore', severity: 'info', title: 'No global gitignore', detail: 'OS and editor files (.DS_Store, .idea, *.swp) must then be ignored in every repo.', cmds: [`mkdir -p ${sq(path.dirname(defaultIgnore))}`, `printf '.DS_Store\\nThumbs.db\\n*.swp\\n.idea/\\n.vscode/\\n' >> ${sq(defaultIgnore)}`], ref: GIT_DOCS + '#Documentation/git-config.txt-coreexcludesFile' });
  return out;
}

const sizeKiB = async (p) => {
  const r = await run('du', ['-sk', p], { timeout: COMMAND_TIMEOUT_MS });
  return r.ok ? Number(r.stdout.split('\t')[0]) || 0 : 0;
};

// repos: [{ path, name, activeAt }] — activeAt is the newest commit or push date.
async function depFolderAdvice(repos, now = Date.now()) {
  const stale = repos.filter((r) => r.activeAt && now - new Date(r.activeAt).getTime() > INACTIVE_DAYS * DAY);
  const found = [];
  for (const r of stale) {
    for (const d of DEP_DIRS) {
      if (found.length >= MAX_DEP_DIRS) break;
      const abs = path.join(r.path, d.dir);
      try { if (!fs.lstatSync(abs).isDirectory()) continue; } catch { continue; }
      if (d.when && !fs.existsSync(path.join(r.path, d.when))) continue;
      found.push({ repo: r.name, path: abs, dir: d, kib: await sizeKiB(abs) });
    }
  }
  if (!found.length) return [];
  found.sort((a, b) => b.kib - a.kib);
  const total = found.reduce((n, f) => n + f.kib, 0);
  const gb = (k) => (k >= 1048576 ? `${(k / 1048576).toFixed(1)} GB` : `${Math.round(k / 1024)} MB`);
  return [{
    id: 'ws-dep-folders', severity: 'info', title: `${gb(total)} in dependency folders of inactive projects`,
    detail: `${list(found.map((f) => `${f.repo}/${f.dir.dir} (${gb(f.kib)})`), 6)}. ${plural(stale.length, 'project')} untouched for ${INACTIVE_DAYS}+ days; these folders are rebuilt by one install command.`,
    cmds: ['npx npkill --dry-run   # interactive finder for node_modules; preview first', ...found.filter((f) => f.dir.clean).slice(0, 5).map((f) => `cargo clean --dry-run --manifest-path ${sq(path.join(path.dirname(f.path), 'Cargo.toml'))}`)],
    note: `Ask before deleting anything. Each folder can be recreated with: ${[...new Set(found.map((f) => `${f.dir.dir} -> ${f.dir.restore}`))].join('; ')}. Never delete a folder an installed app runs from.`,
    ref: 'https://github.com/voidcosmos/npkill',
  }];
}

// repos: [{ name, localOnly }]. One line per repo that holds work no remote has.
function localOnlyAdvice(repos) {
  const held = repos.filter((r) => r.localOnly && r.localOnly.any);
  if (!held.length) return [];
  return [{
    id: 'ws-local-only', severity: 'info',
    title: `${plural(held.length, 'repo')} ${held.length === 1 ? 'holds' : 'hold'} work that exists only on this machine`,
    detail: held.map((r) => `${printable(r.name)}: ${summarizeLocalOnly(r.localOnly)}`).join('\n'),
    note: 'Push it, or save a rescue copy (gutcheck fix <repo> rescue-bundle) before deleting or moving a repo.',
  }];
}

// opts: { home, thresholdKiB } are injectable for tests.
async function devAdvice(repos, opts = {}) {
  const [cfg, deps, caches, agents] = await Promise.all([gitConfigAdvice(), depFolderAdvice(repos), cacheAdvice(opts).catch(() => []), agentAdvice(repos, opts.home ? { home: opts.home } : {}).catch(() => [])]);
  return [...cfg, ...workspaceIdentity(repos), ...localOnlyAdvice(repos), ...deps, ...caches, ...agents].map((a) => ({ category: 'Workspace', ...a }));
}

module.exports = { devAdvice, localOnlyAdvice, gitConfigAdvice, depFolderAdvice, INACTIVE_DAYS };
