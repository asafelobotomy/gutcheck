// Last review round: names with invisible characters are left out of commands (not altered), prose keeps
// ZWJ/ZWNJ, an unknown `via` counts as an agent's, and the app labels agent-written ignores.
const test = require('node:test');
const assert = require('node:assert');
const { applyPolicy } = require('../src/policy');
const { ignoreView } = require('../src/ignore-rules');
const { score } = require('../src/checks');
const { buildReport } = require('../src/report');
const { sizeStep, hygieneFix } = require('../src/report-fixes');

const F = (id, severity = 'warn') => ({ id, severity, category: 'Branches', title: id, detail: 'd' });
const ZW = '\u200b';
const ZWJ = '\u200d';
const ZWNJ = '\u200c';
const result = (findings, extra = {}) => ({ path: '/w/app', name: 'app', remote: { owner: 'o', name: 'app', isPublic: true, defaultBranch: 'main' }, files: { license: true, readme: true }, git: {}, scannedAt: 'now', ...score(findings), ...extra });
const fences = (text) => (text.match(/```bash\n[\s\S]*?\n```/g) || []).join('\n');

test('a branch or folder name with an invisible character is left out of the commands, not altered', () => {
  const bad = 'feat' + ZW + 'x';
  const r = result([F('git-merged'), F('git-stale'), F('git-gone')], { git: { branch: 'main', mergedBranches: ['ok-branch', bad], branches: [{ name: bad, date: '2000-01-01T00:00:00Z' }] }, hygiene: { storage: { packKiB: 1 }, stashes: 0, tags: 0, goneBranches: ['gone-ok', bad] } });
  const cmds = fences(buildReport({ repos: [r] }));
  assert.match(cmds, /git branch -d 'ok-branch'/);
  assert.match(cmds, /git branch -d 'gone-ok'/);
  assert.ok(!cmds.includes('featx') && !cmds.includes('feat x') && !cmds.includes(bad), cmds);
  assert.deepEqual(hygieneFix('git-gone', { hygiene: { goneBranches: [bad] } }).cmds, []);
  const h = { total: 1, current: 0, oldVersions: 0, deleted: 0, unreachable: 0, historyOnly: 0, binaryCurrent: 0, rewriteWorthIt: true, extensions: [],
    folders: [{ name: 'cache' + ZW + '/', bytes: 1 }, { name: 'build/', bytes: 1 }], deletedFolders: [{ name: 'old' + ZW + '/', bytes: 2e7 }, { name: 'gone/', bytes: 2e7 }] };
  const s = sizeStep(h).cmds.join('\n');
  assert.match(s, /git rm -r --cached -- 'build'/);
  assert.match(s, /--path 'gone\/'/);
  assert.ok(!/'cache|'old/.test(s), s);
});

test('prose keeps ZWJ and ZWNJ (emoji, Persian); commands and names do not', () => {
  const emoji = 'fix 👩' + ZWJ + '💻 and می' + ZWNJ + 'خواهم';
  const r = result([F('git-merged')], { prs: [{ number: 3, title: emoji, headRefName: 'b', updatedAt: new Date().toISOString() }], git: { branch: 'main', mergedBranches: ['a' + ZWJ + 'b', 'plain'] } });
  const text = buildReport({ repos: [r] });
  assert.ok(text.includes(emoji), 'the PR title is intact');
  const cmds = fences(text);
  assert.match(cmds, /git branch -d 'plain'/);
  assert.ok(!cmds.includes(ZWJ) && !/'a ?b'/.test(cmds), cmds);
});

test('a via other than cli, app or mcp counts as an agent\'s; a plain string stays the user\'s', () => {
  for (const via of ['MCP', 'Mcp', 'cursor', 'CLI', 'App']) {
    const r = applyPolicy(result([F('no-topics', 'info'), F('git-dirty')]), { ignores: { 'o/app': { 'no-topics': 'r', 'git-dirty': 'r' } }, ignoreVia: { 'o/app': { 'no-topics': via, 'git-dirty': via } } }, score);
    assert.equal(ignoreView(r.ignored.find((f) => f.id === 'no-topics')).from, 'Ignored through an AI agent (MCP)', via);
    assert.ok(r.findings.some((f) => f.id === 'git-dirty'), `${via} cannot hide a protected finding`);
  }
  const old = applyPolicy(result([F('git-dirty')]), { ignores: { 'o/app': { 'git-dirty': 'old style' } } }, score);
  assert.equal(ignoreView(old.ignored[0]).from, 'Ignored by you (GutCheck settings)');
});
