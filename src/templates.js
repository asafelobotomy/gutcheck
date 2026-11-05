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

const dependabot = (manifests) => {
  const eco = { 'package.json': 'npm', 'Cargo.toml': 'cargo', 'go.mod': 'gomod' };
  const blocks = manifests.filter((m) => eco[m]).map((m) => `  - package-ecosystem: ${eco[m]}\n    directory: /\n    schedule:\n      interval: weekly\n`);
  blocks.push('  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n');
  return `version: 2\nupdates:\n${blocks.join('')}`;
};

// id -> { file, label, build(ctx) }   ctx: { author, name, manifests }
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
    build: (c) => `# Contributing to ${c.name}\n\n1. Fork the repository and create a branch from \`main\`.\n2. Make your change and add or update tests.\n3. Run the test suite.\n4. Open a pull request describing what changed and why.\n`,
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
  dependabot: { file: '.github/dependabot.yml', label: 'Dependabot config', build: (c) => dependabot(c.manifests || []) },
  'ci-node': {
    file: '.github/workflows/ci.yml',
    label: 'Node CI workflow',
    build: () => `name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n      - run: npm ci\n      - run: npm test\n`,
  },
};

module.exports = { TEMPLATES };
