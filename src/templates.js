// Files GutCheck can add to a repo. Each template has a fixed target path (never user-supplied).

const year = () => new Date().getFullYear();

const MIT = (author) => `MIT License

Copyright (c) ${year()} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// One block per ecosystem and folder (src-tauri/Cargo.toml, android/build.gradle...), plus GitHub Actions.
// ctx.ecosystems comes from findEcosystems(); a bare list of root manifests still works.
const ROOT_ECO = { 'package.json': 'npm', 'Cargo.toml': 'cargo', 'go.mod': 'gomod', 'pyproject.toml': 'pip', 'requirements.txt': 'pip' };
const dependabot = (manifests, ecosystems, hasWorkflows) => {
  const list = ecosystems && ecosystems.length ? ecosystems : [...new Set(manifests.map((m) => ROOT_ECO[m]).filter(Boolean))].map((eco) => ({ eco, dir: '/' }));
  // Minor and patch updates arrive as one PR per ecosystem (majors stay separate: they can break), and
  // a cooldown lets brand-new releases age a week first. Neither delays security updates.
  const COOL = '    cooldown:\n      default-days: 7\n';
  const GROUP = '    groups:\n      minor-and-patch:\n        update-types: [minor, patch]\n';
  const blocks = list.map((e) => `  - package-ecosystem: ${e.eco}\n    directory: ${e.dir}\n    schedule:\n      interval: weekly\n${COOL}${GROUP}`);
  // Only with workflows to update: Dependabot errors out on a github-actions entry with nothing to read.
  if (hasWorkflows !== false) blocks.push(`  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n${COOL}    groups:\n      actions:\n        patterns: ["*"]\n`);
  return `version: 2\nupdates:\n${blocks.join('')}`;
};

// Test commands for CONTRIBUTING, from the stacks the repo uses.
const TEST_CMD = { node: 'npm test', python: 'pytest', rust: 'cargo test', go: 'go test ./...', gradle: './gradlew test' };
const testLine = (c) => { const cmds = [...new Set((c.stacks || []).filter((s) => TEST_CMD[s.id]).map((s) => `\`${TEST_CMD[s.id]}\`${s.root && s.root !== '.' ? ` (in ${s.root}/)` : ''}`))]; return cmds.length ? `Run the tests: ${cmds.join(', ')}.` : 'Run the test suite.'; };

// id -> { file, label, build(ctx) }   ctx: { author, name, manifests, branch }
const branchOf = (c) => (c && typeof c.branch === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(c.branch) ? c.branch : 'main');
const TEMPLATES = {
  license: { file: 'LICENSE', label: 'MIT licence', build: (c) => MIT(c.author) },
  readme: { file: 'README.md', label: 'README', build: (c) => `# ${c.name}\n\nTODO: describe what this project does, how to install it and how to run it.\n` },
  gitignore: { file: '.gitignore', label: '.gitignore', build: () => 'node_modules/\ndist/\nbuild/\ntarget/\n.env\n.env.*\n*.log\n.DS_Store\n' },
  security: {
    file: 'SECURITY.md',
    label: 'Security policy',
    build: () => `# Security Policy\n\n## Reporting a vulnerability\n\nPlease do not open a public issue for security problems. Use GitHub's private vulnerability reporting (Security tab, "Report a vulnerability") or contact the maintainer directly.\n\nYou can expect an acknowledgement within a few days.\n`,
  },
  contributing: {
    file: 'CONTRIBUTING.md',
    label: 'Contributing guide',
    build: (c) => `# Contributing to ${c.name}\n\n1. Fork the repository and create a branch from \`${branchOf(c)}\`.\n2. Make your change and add or update tests.\n3. ${testLine(c)}\n4. Open a pull request describing what changed and why.\n`,
  },
  conduct: {
    file: 'CODE_OF_CONDUCT.md',
    label: 'Code of conduct',
    build: () => `# Code of Conduct\n\nBe respectful and constructive. Harassment, discrimination and personal attacks are not tolerated. Maintainers may remove comments, commits or contributors that violate this, and may ban repeat offenders.\n\nThis policy is deliberately short; swap in the full Contributor Covenant if you need more detail.\n`,
  },
  'pr-template': {
    file: '.github/pull_request_template.md',
    label: 'Pull request template',
    build: () => `## What changed\n\n## Why\n\n## How it was tested\n`,
  },
  codeowners: {
    file: '.github/CODEOWNERS',
    label: 'CODEOWNERS',
    build: (c) => `# Changes, and especially CI, are reviewed by the maintainer.\n* @${c.owner || 'OWNER'}\n/.github/workflows/ @${c.owner || 'OWNER'}\n`,
  },
  'issue-template': {
    file: '.github/ISSUE_TEMPLATE/bug_report.yml',
    label: 'bug report template',
    build: () => 'name: Bug report\ndescription: Something does not work as expected\nlabels: [bug]\nbody:\n  - type: textarea\n    id: what\n    attributes:\n      label: What happened\n      description: What you did, what you expected, and what happened instead.\n    validations:\n      required: true\n  - type: textarea\n    id: steps\n    attributes:\n      label: Steps to reproduce\n    validations:\n      required: true\n  - type: input\n    id: version\n    attributes:\n      label: Version\n  - type: textarea\n    id: env\n    attributes:\n      label: System\n      description: OS and anything else relevant. Do not paste secrets or tokens.\n',
  },
  // Only settings every project agrees on: no indentation rules, so it cannot contradict the code's style.
  editorconfig: {
    file: '.editorconfig',
    label: '.editorconfig',
    build: () => 'root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n\n[*.md]\n# Two trailing spaces are a line break in Markdown.\ntrim_trailing_whitespace = false\n',
  },
  gitattributes: {
    file: '.gitattributes',
    label: '.gitattributes',
    build: () => '# Normalise line endings in the repository; check out with the platform default.\n* text=auto\n# Windows scripts must keep CRLF.\n*.bat text eol=crlf\n*.cmd text eol=crlf\n',
  },
  dependabot: { file: '.github/dependabot.yml', label: 'Dependabot config', build: (c) => dependabot(c.manifests || [], c.ecosystems, c.hasWorkflows) },
  'ci-node': {
    file: '.github/workflows/ci.yml',
    label: 'Node CI workflow',
    build: (c) => `name: CI\n\non:\n  push:\n    branches: [${JSON.stringify(branchOf(c))}]\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      # Actions are pinned to full commit SHAs so a moved tag cannot change what runs; Dependabot keeps them current.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22\n          cache: npm\n      - run: npm ci\n      - run: npm test\n`,
  },
};

// Package ecosystems Dependabot can update, found at the root and one folder down (not inside
// dependency or build folders). Returns [{ eco, dir }].
function findEcosystems(dir, fs = require('node:fs'), path = require('node:path')) {
  const out = [];
  const SKIP = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', '.git', '.venv', 'venv']);
  const look = (rel) => {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, rel)); } catch { return; }
    const d = rel ? `/${rel}` : '/';
    if (names.includes('package.json') && names.some((n) => /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(n))) out.push({ eco: 'npm', dir: d });
    if (names.includes('Cargo.toml') && (names.includes('Cargo.lock') || !rel)) out.push({ eco: 'cargo', dir: d });
    if (names.includes('go.mod')) out.push({ eco: 'gomod', dir: d });
    if (names.includes('pyproject.toml') || names.includes('requirements.txt')) out.push({ eco: 'pip', dir: d });
    if (names.some((n) => /^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/.test(n))) out.push({ eco: 'gradle', dir: d });
    return names;
  };
  const top = look('') || [];
  for (const n of top) {
    if (n.startsWith('.') || SKIP.has(n)) continue;
    try { if (fs.statSync(path.join(dir, n)).isDirectory()) look(n); } catch {}
  }
  // A Cargo workspace member or a sub-package under a root that already covers it is updated from the root.
  return out.filter((e, i) => !(e.dir !== '/' && e.eco === 'cargo' && out.some((x) => x.eco === 'cargo' && x.dir === '/')) && out.findIndex((x) => x.eco === e.eco && x.dir === e.dir) === i);
}

module.exports = { TEMPLATES, branchOf, findEcosystems };
