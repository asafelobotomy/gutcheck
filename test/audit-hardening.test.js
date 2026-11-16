// Hardening from the 2026-11-16 audit (T4-T6, E5, E6, S10, A10, B21').
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sh, repo, marker } = require('./helpers/git-lab');
const { isolatedEnv } = require('./helpers/env');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('T4: a repo\'s own .gutcheck.json cannot hide work at risk or a missing security fix', () => {
  const { canRepoIgnore } = require('../src/ignore-rules');
  for (const id of ['git-detached', 'git-stashes', 'git-no-commits', 'git-op', 'git-no-upstream', 'git-upstream-gone', 'tag-protection', 'runtime-eol', 'lockfile-drift']) assert.equal(canRepoIgnore({ id, severity: 'warn', category: 'Git hygiene' }), false, id);
  for (const id of ['no-remote', 'git-stale', 'git-merged', 'no-license']) assert.equal(canRepoIgnore({ id, severity: 'info', category: 'Git hygiene' }), true, id);
});

test('T5: a cut MCP result carries no full copy beside the text', async () => {
  const { createServer } = require('../src/mcp');
  const sent = [];
  const big = { ok: true, total: 4000, findings: Array.from({ length: 4000 }, (_, i) => ({ repo: 'r', id: `finding-${i}`, title: 'x'.repeat(40) })) };
  const engine = { allowActions: false, findings: async (a) => (a.limit === 1 ? { ok: true, total: 1, findings: big.findings.slice(0, 1) } : big) };
  const server = createServer({ engine, send: (m) => sent.push(m) });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gutcheck_findings', arguments: {} } });
  const cut = sent.find((m) => m.id === 2).result;
  assert.match(cut.content[0].text, /\[cut at 100000 characters/);
  assert.equal('structuredContent' in cut, false);
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gutcheck_findings', arguments: { limit: 1 } } });
  assert.equal(sent.find((m) => m.id === 3).result.structuredContent.total, 1, 'a small result keeps its structured form');
});

test('E6: git variables that point at another repo are not inherited', async () => {
  const exec = require('../src/exec');
  const a = repo({ 'a.txt': 'a\n' });
  const b = repo({ 'b.txt': 'b\n' });
  process.env.GIT_DIR = path.join(b, '.git'); process.env.GIT_WORK_TREE = b;
  try {
    const r = await exec.git(['ls-files'], { cwd: a });
    assert.equal(r.stdout.trim(), 'a.txt');
  } finally { delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE; }
});

test('E5: maintenance-register gets the checks a fetch gets', async () => {
  const { plan } = require('../src/actions');
  const { scanRepo } = require('../src/scanner');
  const d = repo({ 'a.txt': 'a\n' });
  sh(d, 'remote', 'add', 'origin', 'https://github.com/o/n.git');
  const scanned = await scanRepo(d, {});
  assert.equal((await plan(scanned, { type: 'maintenance-register' })).ok, true);
  const m = marker();
  sh(d, 'config', 'core.sshCommand', m.prog);
  const p = await plan(scanned, { type: 'maintenance-register' });
  assert.equal(p.ok, false);
  assert.match(p.error, /core\.sshCommand/);
  assert.equal(m.ran(), false);
});

test('S10: redact hides short credentials; a rule\'s first word is shown only for a known command', () => {
  const { redact } = require('../src/agent-usage');
  const out = redact('token=abc123def pass=hunter2 Bearer sk-live-9f8a7b failed for postgres://admin:hunter2pass@db');
  for (const leak of ['abc123def', 'hunter2', 'sk-live-9f8a7b']) assert.ok(!out.includes(leak), `${leak} in ${out}`);
  assert.match(out, /token=\[redacted\]/);
  const classify = require('../src/agent-context').classifyRule;
  assert.ok(!classify('Bash(hunter2secretpass --login)').shape.includes('hunter2secretpass'));
  assert.match(classify('Bash(npm test:*)').shape, /^Bash\(npm /);
});

test('A10: the data folder is private and its files are written 0600', async () => {
  const { createEngine } = require('../src/engine');
  const data = path.join(tmp('gutcheck-mode-'), 'data');
  const root = tmp('gutcheck-modews-');
  const d = path.join(root, 'r'); fs.mkdirSync(d); sh(d, 'init', '-q', '-b', 'main'); sh(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  const engine = createEngine({ env: isolatedEnv({ GUTCHECK_DATA_DIR: data }), allowActions: true, via: 'cli' });
  await engine.scan({ root, recordSeen: true });
  await engine.ignore({ repo: 'r', finding: 'no-remote', reason: 'scratch' });
  assert.equal(fs.statSync(data).mode & 0o777, 0o700);
  const files = fs.readdirSync(data).filter((f) => fs.statSync(path.join(data, f)).isFile());
  assert.ok(files.length >= 2, files.join(','));
  for (const f of files) assert.equal(fs.statSync(path.join(data, f)).mode & 0o077, 0, `${f} is readable by others`);
});
