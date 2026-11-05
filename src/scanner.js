const fs = require('node:fs');
const path = require('node:path');
const { run, git } = require('./exec');
const { evaluate } = require('./checks');
const gh = require('./github');

const SKIP = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', '.cache', '.local', '.npm']);

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

function parseGithubRemote(url) {
  const m = /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? { owner: m[1], name: m[2] } : null;
}

async function collectGit(dir) {
  const st = await git(['status', '--porcelain=v2', '--branch'], { cwd: dir });
  const g = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, dirty: 0, branches: [], mergedBranches: [] };
  for (const line of st.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      g.branch = line.slice(14);
      if (g.branch === '(detached)') g.detached = true;
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
  const any = (re) => has(re) || ghNames.some((n) => re.test(n));
  return {
    license: has(/^(licen[cs]e|copying|unlicense)(\.[a-z]+)?$/i),
    readme: has(/^readme(\.[a-z]+)?$/i),
    gitignore: names.includes('.gitignore'),
    security: any(/^security(\.[a-z]+)?$/i),
    contributing: any(/^contributing(\.[a-z]+)?$/i),
    codeOfConduct: any(/^code_of_conduct(\.[a-z]+)?$/i),
    prTemplate: ghNames.some((n) => /^pull_request_template/i.test(n)) || has(/^pull_request_template/i),
    names,
  };
}

async function collectDeps(dir, names, deep) {
  const d = { manifests: [], manifestsWithoutLock: [], needsInstall: false, outdated: null, outdatedNames: [] };
  const lockFor = {
    'package.json': ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'],
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
    const r = await run('npm', ['outdated', '--json'], { cwd: dir, timeout: 45000 });
    try {
      const o = JSON.parse(r.stdout || '{}'); // npm exits 1 when anything is outdated
      d.outdatedNames = Object.keys(o);
      d.outdated = d.outdatedNames.length;
    } catch {}
  }
  return d;
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
  const originUrl = (await git(['remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim();
  const ref = parseGithubRemote(originUrl);
  const files = collectFiles(dir);
  const wfDir = path.join(dir, '.github', 'workflows');
  const hasWorkflows = fs.existsSync(wfDir) && fs.readdirSync(wfDir).length > 0;
  const [g, deps] = await Promise.all([collectGit(dir), collectDeps(dir, files.names, opts.deep)]);
  delete files.names;
  return { dir, ref, originUrl, files, hasWorkflows, git: g, deps };
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
    } else {
      remote.remote = { owner: ref.owner, name: ref.name, url: `https://github.com/${ref.owner}/${ref.name}`, isPublic: false, unreachable: true, description: 'unknown', defaultBranch: null };
      remote.ci.error = ghRes ? ghRes.error : 'GitHub data unavailable';
    }
  }
  const g = local.git;
  const base = (remote.remote && remote.remote.defaultBranch) || (g.branches.some((b) => b.name === 'main') ? 'main' : g.branches.some((b) => b.name === 'master') ? 'master' : null);
  g.mergedBranches = await mergedInto(dir, base, g);
  const snapshot = { path: dir, name: path.basename(dir), originUrl: local.originUrl, git: g, files: local.files, deps: local.deps, hasWorkflows: local.hasWorkflows, scannedAt: new Date().toISOString(), ...remote };
  return { ...snapshot, ...evaluate(snapshot) };
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

module.exports = { discover, scanRepo, scanAll, parseGithubRemote };
