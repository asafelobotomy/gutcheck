// Local repo hygiene: git housekeeping state, storage, project conventions and workflow security.
// Every git call goes through exec.git (hooks and fsmonitor disabled, no index lock), so scanning
// an untrusted repo never runs its code. Nothing here writes.

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./exec');
const { auditWorkflows } = require('./workflows');

const MiB = 1024 * 1024;
const HISTORY_BLOB_MIN = 50 * MiB;
const HISTORY_TIMEOUT_MS = 2 * 60 * 1000; // listing every object of a very large repo can take a while // GitHub warns at 50 MiB and rejects pushes over 100 MiB
const lines = (s) => s.split('\n').filter(Boolean);
const exists = (dir, ...p) => { try { fs.accessSync(path.join(dir, ...p)); return true; } catch { return false; } };
const listDir = (dir, ...p) => { try { return fs.readdirSync(path.join(dir, ...p)); } catch { return []; } };

// Remote URL problems, judged on the raw URL (before credentials are stripped for display).
function remoteIssue(raw) {
  if (/^[a-z+]+:\/\/[^/@\s]+:[^/@\s]+@/i.test(raw) || /^https?:\/\/[^/@\s]*(gh[pousr]_|github_pat_)[^/@\s]*@/i.test(raw)) return 'credentials';
  if (/^http:\/\//i.test(raw)) return 'http';
  return null;
}

// Conventions from GitHub docs, Keep a Changelog, EditorConfig, npm and Python packaging.
function collectProject(dir, names) {
  const has = (re) => names.some((n) => re.test(n));
  const gh = listDir(dir, '.github');
  const docs = listDir(dir, 'docs');
  const anyLoc = (re) => has(re) || gh.some((n) => re.test(n)) || docs.some((n) => re.test(n));
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } })();
  const pyproject = (() => { try { return fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'); } catch { return null; } })();
  const isNode = !!pkg;
  const isPython = pyproject != null || names.includes('requirements.txt') || names.includes('setup.py');
  const pinned = has(/^(\.tool-versions|\.mise\.toml|mise\.toml)$/)
    || (isNode && (has(/^\.(nvmrc|node-version)$/) || !!(pkg.engines && pkg.engines.node) || !!(pkg.volta && pkg.volta.node)))
    || (isPython && (has(/^\.python-version$/) || /requires-python\s*=/.test(pyproject || '')));
  let readme = null;
  const readmeName = [...gh.map((n) => ['.github', n]), ...names.map((n) => ['', n]), ...docs.map((n) => ['docs', n])].find(([, n]) => /^readme(\.[a-z]+)?$/i.test(n));
  if (readmeName) {
    try {
      const text = fs.readFileSync(path.join(dir, ...readmeName.filter(Boolean)), 'utf8').slice(0, 200000);
      readme = { bytes: Buffer.byteLength(text), usage: /^#{1,4}\s*(install|usage|use|using|getting started|quick ?start|set ?up|how to|run|build|develop|development|commands|examples?)/im.test(text) };
    } catch {}
  }
  return {
    changelog: anyLoc(/^(changelog|changes|history|news|releases)(\.[a-z]+)?$/i),
    gitattributes: names.includes('.gitattributes'),
    editorconfig: names.includes('.editorconfig'),
    codeowners: anyLoc(/^CODEOWNERS$/),
    issueTemplates: listDir(dir, '.github', 'ISSUE_TEMPLATE').some((n) => /\.(md|ya?ml)$/i.test(n)),
    support: anyLoc(/^support(\.[a-z]+)?$/i),
    runtime: isNode || isPython ? { pinned, kind: isNode ? 'Node' : 'Python' } : null,
    readme,
  };
}

async function collectHygiene(dir, { names, rawOrigin, deep, branch }) {
  const run = (args) => git(args, { cwd: dir });
  const [stash, track, wt, head, objects, tags] = await Promise.all([
    run(['stash', 'list', '--format=%gd']),
    run(['for-each-ref', '--format=%(refname:short)\t%(upstream:track)', 'refs/heads']),
    run(['worktree', 'list', '--porcelain']),
    run(['rev-parse', '-q', '--verify', 'HEAD']),
    run(['count-objects', '-v']),
    run(['tag', '-l']),
  ]);
  const co = Object.fromEntries(lines(objects.stdout).map((l) => l.split(': ')).map(([k, v]) => [k, Number(v)]));
  const h = {
    stashes: lines(stash.stdout).length,
    goneBranches: lines(track.stdout).map((l) => l.split('\t')).filter(([n, t]) => t === '[gone]' && n !== branch).map(([n]) => n),
    prunableWorktrees: lines(wt.stdout).filter((l) => l.startsWith('prunable')).length,
    remote: remoteIssue(rawOrigin),
    noCommits: !head.ok,
    tags: lines(tags.stdout).length,
    // KiB, from `git count-objects -v`: packed size, loose objects, and stray files git cannot use.
    storage: { packKiB: (co['size-pack'] || 0) + (co.size || 0), loose: co.count || 0, garbage: co.garbage || 0 },
    submodulesUninit: 0,
    historyBlobs: null,
    project: collectProject(dir, names),
    workflows: auditWorkflows(dir),
  };
  if (exists(dir, '.gitmodules')) {
    const sm = await run(['submodule', 'status']);
    h.submodulesUninit = lines(sm.stdout).filter((l) => l.startsWith('-')).length;
  }
  if (deep && !h.noCommits) {
    // Every object in the object store, including history: blobs at or over GitHub's 50 MiB warning size.
    const all = await git(['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize) %(objectname)'], { cwd: dir, timeout: HISTORY_TIMEOUT_MS });
    if (all.ok) h.historyBlobs = lines(all.stdout).map((l) => l.split(' ')).filter(([t, s]) => t === 'blob' && Number(s) >= HISTORY_BLOB_MIN).map(([, s, id]) => ({ id, size: Number(s) })).sort((a, b) => b.size - a.size).slice(0, 10);
  }
  return h;
}

module.exports = { collectHygiene, remoteIssue, collectProject, HISTORY_BLOB_MIN };
