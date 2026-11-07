const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { TEMPLATES } = require('../src/templates');

const SHA_USE = /uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\b/;

test('generated CI workflow pins every action to a full commit SHA', () => {
  const yml = TEMPLATES['ci-node'].build({ name: 'x', author: 'a', manifests: [] });
  const uses = yml.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(uses.length >= 2);
  for (const l of uses) assert.match(l, SHA_USE, l);
  assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /permissions:\n {2}contents: read/);
});

test('the template pins the same SHAs as this repo\'s own workflow', () => {
  const own = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'build.yml'), 'utf8');
  const yml = TEMPLATES['ci-node'].build({ name: 'x', author: 'a', manifests: [] });
  for (const m of yml.matchAll(/uses:\s*(\S+@[0-9a-f]{40})/g)) assert.ok(own.includes(m[1]), `${m[1]} is not used by build.yml, so it may be stale`);
});

test('dependabot template always keeps GitHub Actions pins fresh', () => {
  assert.match(TEMPLATES.dependabot.build({ manifests: ['package.json'] }), /package-ecosystem: github-actions/);
});

test('the .gitignore template adds caches for the languages the repo uses', () => {
  const py = TEMPLATES.gitignore.build({ stacks: [{ id: 'python' }] });
  assert.match(py, /^__pycache__\/$/m);
  assert.match(py, /^\.pytest_cache\/$/m);
  assert.doesNotMatch(TEMPLATES.gitignore.build({ stacks: [{ id: 'rust' }] }), /pycache/);
  assert.match(TEMPLATES.gitignore.build(), /^\.env$/m, 'secrets are always ignored');
});
