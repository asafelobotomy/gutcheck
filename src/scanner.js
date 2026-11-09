const fs = require('node:fs');
const path = require('node:path');
const exec = require('./exec');
const { run, git } = exec;
const { HEAVY_DIRS, NODE_LOCKFILES, installCommand, cmpVersion } = require('./util');
const { evaluate, score } = require('./checks');
const { auditDepAutomation } = require('./dep-automation');
const { collectRelease } = require('./release');
const { applyPolicy, repoPolicy } = require('./policy');
const { collectHygiene } = require('./hygiene');
const gh = require('./github');
const { scanAgents } = require('./agents');
const { lockVersions, superseded } = require('./dependabot-prs');

const SKIP = new Set(HEAVY_DIRS); // dot-folders are skipped separately

// Find git repos under root (root itself, or children up to maxDepth levels deep).
function discover(root, maxDepth = 2) {
  const found = [];
  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      found.push(dir);
      return; // do not descend into repos (submodules/nested are out of scope)
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

// Only GitHub itself (audit B13): the host must be github.com or www.github.com (any case), after
// an https, http, git, ssh, git+ssh or ssh+git scheme with optional user info and port, or in the
// scp form [user@]github.com:o/r. Not "github.com" elsewhere in an address, a lookalike host, a
// <helper>:: address or a local folder, so those are never treated as GitHub.
const GITHUB_RE = /^(?:(?:https?|git|ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]*@)?(?:www\.)?github\.com(?::\d+)?\/|(?:[A-Za-z0-9._-]+@)?(?:www\.)?github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;
function parseGithubRemote(url) {
  const m = GITHUB_RE.exec(url || '');
  return m ? { owner: m[1], name: m[2] } : null;
}

async function collectGit(dir) {
  // --ignore-submodules=dirty: a submodule's own config (its filters) is never read, so git must
  // not look inside it. New commits in a submodule still show; edits inside one no longer do.
  const st = await git(['status', '--porcelain=v2', '--branch', '--ignore-submodules=dirty'], { cwd: dir });
  // A failed status (refused, or a filter that would not run) must not look like a clean repo.
  if (!st.ok) throw new Error(`git status failed: ${(st.stderr || '').trim().split('\n').pop().slice(0, 200)}`);
  const g = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, dirty: 0, branches: [], remoteBranches: [], mergedBranches: [] };
  for (const line of st.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14);
      if (head === '(detached)') g.detached = true; // no branch name: nothing to push, track or report
      else g.branch = head;
    } else if (line.startsWith('# branch.upstream ')) g.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        g.ahead = +m[1];
        g.behind = +m[2];
      }
    } else if (line && !line.startsWith('#')) g.dirty++;
  }
  const refs = await git(['for-each-ref', '--format=%(refname:short)\t%(committerdate:iso-strict)', 'refs/heads'], { cwd: dir });
  g.branches = refs.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, date] = l.split('\t');
      return { name, date, current: name === g.branch };
    });
  // Branches checked out in another worktree cannot be deleted or switched to from here.
  const wt = await git(['worktree', 'list', '--porcelain'], { cwd: dir });
  g.worktreeBranches = wt.stdout.split('\n').filter((l) => l.startsWith('branch refs/heads/')).map((l) => l.slice(18)).filter((b) => b !== g.branch);
  // Remote names (Fetch is offered only when there is one).
  g.remotes = (await git(['remote'], { cwd: dir })).stdout.split('\n').filter(Boolean);
  const rrefs = await git(['for-each-ref', '--format=%(refname:short)\t%(committerdate:iso-strict)', 'refs/remotes/origin'], { cwd: dir });
  g.remoteBranches = rrefs.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [full, date] = l.split('\t');
      return { name: full.replace(/^origin\//, ''), date };
    })
    .filter((b) => b.name !== 'HEAD' && b.name !== 'origin');
  return g;
}

async function mergedInto(dir, base, g) {
  if (!base || !g.branches.some((b) => b.name === base)) return [];
  const r = await git(['branch', '--merged', base, '--format=%(refname:short)'], { cwd: dir });
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .filter((b) => b !== base && b !== g.branch);
}

function collectFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  const has = (re) => names.some((n) => re.test(n));
  const gh_ = path.join(dir, '.github');
  let ghNames = [];
  try {
    ghNames = fs.readdirSync(gh_);
  } catch {}
  let docsNames = [];
  try { docsNames = fs.readdirSync(path.join(dir, 'docs')); } catch {}
  // GitHub looks for community health files in .github/, the root, then docs/.
  const any = (re) => has(re) || ghNames.some((n) => re.test(n)) || docsNames.some((n) => re.test(n));
  return {
    // A licence must sit at the top level (it ships with clones); LICENSES/ is the REUSE layout.
    license: has(/^(licen[cs]e|copying|copyright|unlicense)([.-][\w.-]+)?$/i) || names.includes('LICENSES'),
    readme: any(/^readme(\.[a-z]+)?$/i),
    gitignore: names.includes('.gitignore'),
    security: any(/^security(\.[a-z]+)?$/i),
    contributing: any(/^contributing(\.[a-z]+)?$/i),
    codeOfConduct: any(/^code_of_conduct(\.[a-z]+)?$/i),
    dependabotConfig: ghNames.some((n) => /^dependabot\.ya?ml$/i.test(n)),
    dependabotActions: (() => { const n = ghNames.find((x) => /^dependabot\.ya?ml$/i.test(x)); return n ? /package-ecosystem:\s*['"]?github-actions\b/.test(safeRead(path.join(gh_, n))) : null; })(),
    prTemplate: any(/^pull_request_template(\.[a-z]+)?$/i) || ghNames.includes('PULL_REQUEST_TEMPLATE'),
    aurPackage: names.includes('PKGBUILD') && names.includes('.SRCINFO'), // an AUR package repo: a build recipe, not a project
    names,
  };
}

async function collectDeps(dir, names, deep) {
  // npmLock: the generated Node CI workflow runs `npm ci` with the npm cache, which both need this.
  const d = { manifests: [], manifestsWithoutLock: [], needsInstall: false, installer: installCommand(names), npmLock: names.includes('package.json') && installCommand(names)[0] === 'npm' && (names.includes('package-lock.json') || names.includes('npm-shrinkwrap.json')), outdated: null, outdatedNames: [] };
  const lockFor = {
    'package.json': NODE_LOCKFILES,
    'Cargo.toml': ['Cargo.lock'],
    'go.mod': ['go.sum'],
  };
  for (const [manifest, locks] of Object.entries(lockFor)) {
    if (!names.includes(manifest)) continue;
    d.manifests.push(manifest);
    if (manifest === 'go.mod') {
      // go.sum only exists when there are dependencies
      const txt = safeRead(path.join(dir, manifest));
      if (!/^\s*(require|[a-z0-9.\-/]+\.[a-z]+\/)/m.test(txt.replace(/^module .*$/m, ''))) continue;
    }
    if (manifest === 'package.json') {
      const pkg = safeJSON(path.join(dir, manifest));
      const nDeps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).length;
      if (nDeps === 0) continue;
      if (!names.includes('node_modules')) d.needsInstall = true;
    }
    if (!locks.some((l) => names.includes(l))) d.manifestsWithoutLock.push(manifest);
  }
  if (deep && d.manifests.includes('package.json') && names.includes('node_modules')) {
    const r = await run('npm', ['outdated', '--json'], { cwd: dir, timeout: 45000, cleanEnv: true, env: npmEnv() });
    try {
      const o = JSON.parse(r.stdout || '{}'); // npm exits 1 when anything is outdated
      // Only packages that are really behind: npm also lists ones AHEAD of a retracted "latest".
      const behind = (i) => !i || !i.current || cmpVersion(i.current, i.latest || i.wanted || i.current) < 0 || cmpVersion(i.current, i.wanted || i.current) < 0;
      d.outdatedNames = Object.keys(o).filter((k) => behind(o[k]));
      d.outdated = d.outdatedNames.length;
    } catch {}
  }
  return d;
}

// npm reads the repo's .npmrc, where `registry=http://host/${GH_TOKEN}/` would send an env secret
// to a host the repo picks (audit B4). So npm gets only PATH, HOME, locale, TMPDIR and
// NODE_EXTRA_CA_CERTS, and env settings, which outrank a project .npmrc, pin the registry and turn
// off scripts and logs. The proxies are the user's own (HTTPS_PROXY and friends, never the
// project's .npmrc), else `false`, not empty: npm skips an empty env value and uses the .npmrc.
function npmEnv() {
  const e = process.env;
  const env = {};
  for (const [k, v] of Object.entries(e)) if (['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_EXTRA_CA_CERTS'].includes(k) || k.startsWith('LC_')) env[k] = v;
  const user = (name) => e[name] || e[name.toLowerCase()] || '';
  const https = user('HTTPS_PROXY');
  const http = user('HTTP_PROXY');
  const no = user('NO_PROXY');
  return {
    ...env,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_https_proxy: https || 'false', npm_config_proxy: http || 'false', ...(no ? { npm_config_noproxy: no } : {}),
    npm_config_ignore_scripts: 'true', npm_config_logs_max: '0',
    npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
  };
}

const safeRead = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const safeJSON = (p) => {
  try {
    return JSON.parse(safeRead(p));
  } catch {
    return {};
  }
};

// Everything that needs no network: git state, files, manifests.
async function collectLocal(dir, opts) {
  exec.forgetGitDrivers(dir); // read the repo's drivers afresh: an action may have changed them
  // Strip any user:token@ from the URL so credentials never reach the UI, logs or reports.
  const rawOrigin = (await git(['remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim();
  const originUrl = rawOrigin.replace(/^([a-z+]+:\/\/)[^/@]*@/i, '$1');
  const ref = parseGithubRemote(originUrl);
  const files = collectFiles(dir);
  const wfDir = path.join(dir, '.github', 'workflows');
  let hasWorkflows = false;
  try { hasWorkflows = fs.readdirSync(wfDir).length > 0; } catch {} // missing, or not a folder
  const [g, deps] = await Promise.all([collectGit(dir), collectDeps(dir, files.names, opts.deep)]);
  const [hygiene, agents, release] = await Promise.all([collectHygiene(dir, { names: files.names, rawOrigin, deep: opts.deep, branch: g.branch }), scanAgents(dir), collectRelease(dir)]);
  delete files.names;
  return { dir, ref, originUrl, files, hasWorkflows, git: g, deps, hygiene, agents, release, depAutomation: auditDepAutomation(dir), repoPolicy: repoPolicy(dir) };
}

const EMPTY_GH = () => ({ remote: null, prs: [], ci: { failed: [], error: null }, protection: null, alerts: [] });

// Join local data with the GitHub result (if any) and score it.
async function finish(local, ghRes, opts) {
  const { dir, ref } = local;
  let remote = EMPTY_GH();
  if (ref) {
    if (ghRes && ghRes.ok) {
      remote = { ...ghRes.snap, ci: { failed: [], error: null } };
      if (local.hasWorkflows && !remote.remote.archived) remote.ci = await gh.fetchFailedRuns(ref, remote.remote.defaultBranch, dir, { force: opts.force });
      if (remote.remote.viewerPermission === 'ADMIN' && !remote.remote.archived) remote.security = await gh.fetchSecurity(ref, { force: opts.force });
      if ((remote.alertsTotal || 0) > (remote.alerts || []).length) { const all = await gh.fetchAlerts(ref); if (all && all.length) remote.alerts = all; }
      // A private repo on a free plan cannot have branch protection at all: do not ask for what cannot be done.
      if (remote.protection === false && !remote.remote.isPublic) remote.remote.protectionUnavailable = !(await gh.protectionAvailable(ref));
    } else {
      remote.remote = { owner: ref.owner, name: ref.name, url: `https://github.com/${ref.owner}/${ref.name}`, isPublic: false, unreachable: true, description: 'unknown', defaultBranch: null };
      remote.ci.error = ghRes ? ghRes.error : 'GitHub data unavailable';
    }
  }
  // Dependabot PRs the default branch has already overtaken (checked against the local lockfiles).
  if ((remote.prs || []).some((p) => p.updates && p.updates.length)) {
    const versions = lockVersions(dir);
    for (const p of remote.prs) p.superseded = superseded(p, versions);
  }
  const g = local.git;
  const base = (remote.remote && remote.remote.defaultBranch) || (g.branches.some((b) => b.name === 'main') ? 'main' : g.branches.some((b) => b.name === 'master') ? 'master' : null);
  g.mergedBranches = (await mergedInto(dir, base, g)).filter((b) => !(g.worktreeBranches || []).includes(b));
  const snapshot = { path: dir, name: path.basename(dir), originUrl: local.originUrl, git: g, files: local.files, deps: local.deps, hasWorkflows: local.hasWorkflows, hygiene: local.hygiene, agents: local.agents, release: local.release, depAutomation: local.depAutomation, repoPolicy: local.repoPolicy, scannedAt: new Date().toISOString(), ...remote };
  // opts.policy: () => { ignores, baseline } from the data folder (the user's ignores and baseline).
  return applyPolicy({ ...snapshot, ...evaluate(snapshot) }, typeof opts.policy === 'function' ? opts.policy() : null, score);
}

const failed = (dir, e) => ({ path: dir, name: path.basename(dir), error: String(e && e.message ? e.message : e), findings: [], score: 0, grade: '?' });

// Bounded-concurrency map.
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// Scan one repo, bypassing the GitHub cache (used after an action or an explicit rescan).
async function scanRepo(dir, opts = {}) {
  const local = await collectLocal(dir, opts);
  const res = local.ref ? (await gh.fetchRepos([local.ref], { force: true })).get(`${local.ref.owner}/${local.ref.name}`) : null;
  return finish(local, res, { ...opts, force: true });
}

// Scan many repos: local data first, then ONE batched GitHub query for all of them, then per-repo CI.
async function scanAll(dirs, opts = {}, onResult = () => {}) {
  await gh.refreshRate();
  const locals = [];
  await pool(dirs, 4, async (d) => {
    try { locals.push(await collectLocal(d, opts)); } catch (e) { locals.push({ dir: d, error: e }); }
  });
  const ok = locals.filter((l) => !l.error);
  const ghMap = await gh.fetchRepos(ok.filter((l) => l.ref).map((l) => l.ref));
  const results = [];
  let done = 0;
  const emit = (res) => { results.push(res); onResult(res, ++done, dirs.length); };
  for (const l of locals.filter((l) => l.error)) emit(failed(l.dir, l.error));
  await pool(ok, 3, async (l) => {
    try {
      emit(await finish(l, l.ref ? ghMap.get(`${l.ref.owner}/${l.ref.name}`) : null, opts));
    } catch (e) {
      emit(failed(l.dir, e));
    }
  });
  return results;
}

module.exports = { discover, scanRepo, scanAll, parseGithubRemote, collectLocal };
