const fs = require('node:fs');
const path = require('node:path');
const { run, json } = require('./exec');
const { evaluate } = require('./checks');

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
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url || '');
  return m ? { owner: m[1], name: m[2] } : null;
}

async function collectGit(dir) {
  const st = await run('git', ['status', '--porcelain=v2', '--branch'], { cwd: dir });
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
  const refs = await run('git', ['for-each-ref', '--format=%(refname:short)\t%(committerdate:iso-strict)', 'refs/heads'], { cwd: dir });
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
  const r = await run('git', ['branch', '--merged', base, '--format=%(refname:short)'], { cwd: dir });
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
  const gh = path.join(dir, '.github');
  let ghNames = [];
  try {
    ghNames = fs.readdirSync(gh);
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

function rollup(checks) {
  if (!Array.isArray(checks) || !checks.length) return 'NONE';
  const bad = checks.some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion) || c.state === 'FAILURE' || c.state === 'ERROR');
  if (bad) return 'FAILURE';
  const pending = checks.some((c) => c.status && c.status !== 'COMPLETED');
  return pending ? 'PENDING' : 'SUCCESS';
}

async function collectGitHub(dir, ref, hasWorkflows, g) {
  const snap = { remote: null, prs: [], ci: { failed: [], error: null }, protection: null, alerts: [] };
  const view = await json('gh', ['repo', 'view', `${ref.owner}/${ref.name}`, '--json', 'description,isPrivate,isArchived,defaultBranchRef,pushedAt,url,issues,licenseInfo'], { cwd: dir });
  if (!view.ok) {
    snap.ci.error = view.error;
    snap.remote = { owner: ref.owner, name: ref.name, url: `https://github.com/${ref.owner}/${ref.name}`, isPublic: false, unreachable: true, description: 'unknown', defaultBranch: null };
    return snap;
  }
  const v = view.data;
  snap.remote = {
    owner: ref.owner,
    name: ref.name,
    url: v.url,
    description: v.description,
    isPublic: !v.isPrivate,
    archived: v.isArchived,
    defaultBranch: v.defaultBranchRef && v.defaultBranchRef.name,
    pushedAt: v.pushedAt,
    openIssues: v.issues ? v.issues.totalCount : 0,
    licenseOnGitHub: v.licenseInfo && v.licenseInfo.key,
  };
  const slug = `${ref.owner}/${ref.name}`;
  const [prs, runs, prot, alerts] = await Promise.all([
    json('gh', ['pr', 'list', '-R', slug, '--state', 'open', '--limit', '50', '--json', 'number,title,url,isDraft,updatedAt,mergeable,reviewDecision,statusCheckRollup,headRefName,author'], { cwd: dir }),
    hasWorkflows ? json('gh', ['run', 'list', '-R', slug, '--limit', '40', '--json', 'databaseId,workflowName,conclusion,status,headBranch,displayTitle,createdAt,url'], { cwd: dir }) : Promise.resolve({ ok: true, data: [] }),
    snap.remote.defaultBranch && !v.isArchived ? run('gh', ['api', `repos/${slug}/branches/${snap.remote.defaultBranch}/protection`], { cwd: dir }) : Promise.resolve({ ok: true }),
    json('gh', ['api', `repos/${slug}/dependabot/alerts?state=open&per_page=50`], { cwd: dir }),
  ]);
  if (prs.ok) snap.prs = prs.data.map((p) => ({ ...p, statusCheckRollup: rollup(p.statusCheckRollup) }));
  if (runs.ok) {
    // Latest completed run per workflow+branch; only report ones that are currently failing.
    const seen = new Set();
    for (const r of runs.data) {
      const key = r.workflowName + '|' + r.headBranch;
      // Only the default branch: failures on tags/dependabot/feature branches are noise here (PR checks are reported separately).
      if (r.status !== 'completed' || seen.has(key) || r.headBranch !== snap.remote.defaultBranch) continue;
      seen.add(key);
      if (r.conclusion === 'failure' || r.conclusion === 'timed_out') snap.ci.failed.push(r);
    }
  } else snap.ci.error = runs.error;
  snap.protection = prot.ok ? true : /Not Found|not protected/i.test(prot.stderr || '') ? false : null;
  if (alerts.ok && Array.isArray(alerts.data)) snap.alerts = alerts.data.map((a) => ({ severity: a.security_vulnerability && a.security_vulnerability.severity, pkg: a.dependency && a.dependency.package && a.dependency.package.name }));
  return snap;
}

async function scanRepo(dir, opts = {}) {
  const originUrl = (await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim();
  const ref = parseGithubRemote(originUrl);
  const files = collectFiles(dir);
  const hasWorkflows = fs.existsSync(path.join(dir, '.github', 'workflows')) && fs.readdirSync(path.join(dir, '.github', 'workflows')).length > 0;
  const git = await collectGit(dir);
  const [deps, gh] = await Promise.all([collectDeps(dir, files.names, opts.deep), ref ? collectGitHub(dir, ref, hasWorkflows, git) : Promise.resolve({ remote: null, prs: [], ci: { failed: [], error: null }, protection: null, alerts: [] })]);
  const base = (gh.remote && gh.remote.defaultBranch) || (git.branches.some((b) => b.name === 'main') ? 'main' : git.branches.some((b) => b.name === 'master') ? 'master' : null);
  git.mergedBranches = await mergedInto(dir, base, git);
  delete files.names;
  const snapshot = { path: dir, name: path.basename(dir), originUrl, git, files, deps, hasWorkflows, scannedAt: new Date().toISOString(), ...gh };
  return { ...snapshot, ...evaluate(snapshot) };
}

// Scan many repos with bounded concurrency; onResult is called as each finishes.
async function scanAll(dirs, opts = {}, onResult = () => {}) {
  const queue = [...dirs];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift();
      let res;
      try {
        res = await scanRepo(d, opts);
      } catch (e) {
        res = { path: d, name: path.basename(d), error: String(e && e.message ? e.message : e), findings: [], score: 0, grade: '?' };
      }
      results.push(res);
      onResult(res, results.length, dirs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency || 4, dirs.length) }, worker));
  return results;
}

module.exports = { discover, scanRepo, scanAll, parseGithubRemote };
