// Builds a made-up demo workspace (six small git repos in a temp folder), scans it with GutCheck's
// real local scanner, and adds invented GitHub data (PRs, CI runs, settings) so every view has
// something to show. Used only for the README screenshots: no real repo names or data appear.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectLocal } = require('../../src/scanner');
const { evaluate, score } = require('../../src/checks');
const { applyPolicy, normalizeBaseline, DEFAULT_BASELINE } = require('../../src/policy');

const DAY = 86400e3;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: ago(200), GIT_COMMITTER_DATE: ago(200) } });

const MIT = 'MIT License\n\nCopyright (c) 2026 Demo\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n';
const README = (n) => `# ${n}\n\nA demo project.\n\n## Install\n\nnpm install\n\n## Usage\n\nRun it.\n${'More words to make this README long enough. '.repeat(8)}\n`;
const UNPINNED = 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n';
const AUTOMERGE = 'name: auto-merge\non: pull_request\npermissions:\n  contents: write\njobs:\n  merge:\n    if: github.actor == \'dependabot[bot]\'\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh pr merge --auto --squash "$PR_URL"\n';
const PINNED = 'name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - run: cargo test\n';

// name -> { files, after(dir), gh }
const REPOS = {
  'weather-cli': {
    files: { 'Cargo.toml': '[package]\nname = "weather-cli"\nversion = "1.4.0"\n', 'Cargo.lock': '# lock\n', LICENSE: MIT, 'README.md': README('weather-cli'), '.gitignore': 'target/\n', 'CHANGELOG.md': '# Changelog\n\n## 1.4.0\n- Hourly forecast\n', '.github/workflows/ci.yml': PINNED, '.editorconfig': 'root = true\n', '.gitattributes': '* text=auto\n', 'SECURITY.md': '# Security\n', 'AGENTS.md': '# AGENTS.md\n\nRun cargo test.\n' },
    tag: 'v1.4.0',
    gh: { prs: [{ number: 41, title: 'Add a --units flag', approved: true }] },
  },
  'recipe-api': {
    files: { 'package.json': '{"name":"recipe-api","version":"2.1.0"}', 'package-lock.json': '{"lockfileVersion":3,"packages":{}}', 'README.md': README('recipe-api'), '.gitignore': 'node_modules/\n', '.github/workflows/ci.yml': UNPINNED, '.github/workflows/auto-merge.yml': AUTOMERGE, '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n' },
    tag: 'v2.0.0',
    extra: { 'src/server.js': 'const http = require("http");\nfunction retry(n) { if (n > 7) return false; return setTimeout(() => retry(n + 1), 2500); }\nhttp.createServer((q, r) => r.end("ok")).listen(8080);\n// TODO: rate limiting\n', 'test/api.test.js': 'const test = require("node:test");\ntest.only("lists recipes", () => {});\n' },
    gh: { failed: true, dependabot: ['express 4.21.2', 'zod 3.25.1', 'pino 9.6.0', 'undici 6.21.1', 'helmet 8.1.0', 'dotenv 16.5.0'], alerts: 3 },
  },
  'photo-sorter': {
    files: { 'pyproject.toml': '[project]\nname = "photo-sorter"\nversion = "0.3.0"\n', 'README.md': '# photo-sorter\n', 'sorter.py': 'print("hi")\n' },
    dirty: ['notes.txt', 'sorter.py'],
    untracked: { '__pycache__/sorter.cpython-312.pyc': 'x', '.pytest_cache/README.md': 'cache', 'sorter.py.bak': 'old', 'tests/test_sorter.py': 'import pytest\n\n@pytest.mark.skip\ndef test_sort():\n    pass\n' },
    gh: { conflict: true, prs: [{ number: 7, title: 'Sort by EXIF date', stale: true }] },
  },
  'garden-planner': {
    files: { 'package.json': '{"name":"garden-planner","version":"0.9.0"}', 'package-lock.json': '{"lockfileVersion":3,"packages":{}}', LICENSE: MIT, 'README.md': README('garden-planner'), '.gitignore': 'node_modules/\n', '.github/workflows/ci.yml': UNPINNED },
    ahead: 3,
    gh: { failed: true, prs: [{ number: 12, title: 'Plant spacing calculator', failing: true }] },
  },
  'notes-sync': {
    files: { 'go.mod': 'module example.com/notes-sync\n', 'go.sum': '', LICENSE: MIT, 'README.md': README('notes-sync'), '.gitignore': 'bin/\n', '.github/workflows/ci.yml': PINNED },
    gh: { private: true },
    ignore: { 'no-dependabot-config': 'updates are pulled in by hand every release' },
  },
  dotfiles: { files: { 'README.md': '# dotfiles\n', '.zshrc': '# zsh\n' }, local: true },
};

function makeRepo(root, name, spec) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'demo@example.com');
  git(dir, 'config', 'user.name', 'Demo');
  for (const [f, t] of Object.entries({ ...spec.files, ...(spec.extra || {}) })) put(dir, f, t);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Initial commit');
  if (spec.tag) git(dir, 'tag', spec.tag);
  for (let i = 0; i < 6; i++) { put(dir, `src/change-${i}.txt`, String(i)); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', `Change ${i}`); }
  if (!spec.local) git(dir, 'remote', 'add', 'origin', `https://github.com/example/${name}.git`);
  for (const f of spec.dirty || []) put(dir, f, 'edited\n');
  for (const [f, t] of Object.entries(spec.untracked || {})) put(dir, f, t);
  git(dir, 'branch', 'old-experiment');
  if (spec.ahead) git(dir, 'branch', 'feature/merged-already');
  return dir;
}

function ghData(name, spec, local) {
  if (spec.local) return { remote: null, prs: [], ci: { failed: [], error: null }, protection: null, alerts: [] };
  const g = spec.gh || {};
  const pr = (p, i) => ({ number: p.number, title: p.title, url: `https://github.com/example/${name}/pull/${p.number}`, isDraft: false, updatedAt: ago(p.stale ? 45 : 2), mergeable: g.conflict && i === 0 ? 'CONFLICTING' : 'MERGEABLE', reviewDecision: p.approved ? 'APPROVED' : null, headRefName: `feature/${p.number}`, updates: [], statusCheckRollup: p.failing ? 'FAILURE' : 'SUCCESS' });
  const bots = (g.dependabot || []).map((u, i) => { const [pkg, to] = u.split(' '); return { number: 60 + i, title: `Bump ${pkg} to ${to}`, url: `https://github.com/example/${name}/pull/${60 + i}`, isDraft: false, updatedAt: ago(3), mergeable: 'MERGEABLE', reviewDecision: null, headRefName: `dependabot/npm_and_yarn/${pkg}-${to}`, updates: [{ name: pkg, to }], statusCheckRollup: 'SUCCESS' }; });
  return {
    remote: { owner: 'example', name, url: `https://github.com/example/${name}`, description: name === 'photo-sorter' ? '' : `The ${name} project`, isPublic: !g.private, archived: false, defaultBranch: 'main', pushedAt: ago(2), openIssues: 4, viewerPermission: 'ADMIN', alertsEnabled: true, deleteBranchOnMerge: name !== 'garden-planner', isFork: false, hasIssues: true, topics: name === 'weather-cli' ? 3 : 0, languages: [], latestRelease: local.release && local.release.latest, securityPolicy: name === 'weather-cli', contributing: false, codeOfConduct: false },
    prs: [...(g.prs || []).map(pr), ...bots],
    ci: { failed: g.failed ? [{ databaseId: 900000 + name.length, workflowName: 'CI', headBranch: 'main', displayTitle: 'Fix the parser', createdAt: ago(1), url: `https://github.com/example/${name}/actions/runs/1` }] : [], error: null },
    protection: name === 'weather-cli',
    alerts: Array.from({ length: g.alerts || 0 }, (_, i) => ({ severity: ['high', 'moderate', 'low'][i % 3], pkg: ['cookie', 'path-to-regexp', 'braces'][i % 3], manifest: 'package-lock.json', ecosystem: 'npm', patched: '1.0.1' })),
    security: { secretScanning: g.private ? null : name === 'weather-cli' ? 'enabled' : 'disabled', pushProtection: 'enabled', securityUpdates: 'enabled', codeScanning: 'configured', privateReporting: true },
  };
}

async function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-demo-'));
  const baseline = normalizeBaseline(DEFAULT_BASELINE);
  const results = [];
  for (const [name, spec] of Object.entries(REPOS)) {
    const dir = makeRepo(root, name, spec);
    const local = await collectLocal(dir, { deep: false });
    local.git.mergedBranches = spec.ahead ? ['feature/merged-already'] : [];
    if (spec.ahead) local.git.ahead = spec.ahead;
    if (!spec.local) local.git.upstream = 'origin/main';
    const snap = { path: dir, name, originUrl: local.originUrl, git: local.git, files: local.files, deps: local.deps, hasWorkflows: local.hasWorkflows, hygiene: local.hygiene, agents: local.agents, release: local.release, depAutomation: local.depAutomation, repoPolicy: null, scannedAt: new Date().toISOString(), ...ghData(name, spec, local) };
    const ignores = spec.ignore ? { [`example/${name}`]: spec.ignore } : {};
    results.push(applyPolicy({ ...snap, ...evaluate(snap) }, { ignores, baseline }, score));
  }
  return { root, results, baseline };
}

module.exports = { build };
