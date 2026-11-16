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

test('B12: gh steps never run inside the repo, and a local PR takes its title from the last commit, not --fill', async () => {
  const { plan } = require('../src/actions');
  const { scanRepo } = require('../src/scanner');
  const d = repo({ 'a.txt': 'a\n' });
  sh(d, 'switch', '-q', '-c', 'feat');
  fs.writeFileSync(path.join(d, 'b.txt'), 'b\n'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'Add the b file');
  sh(d, 'switch', '-q', 'main');
  const scanned = await scanRepo(d, {});
  const r = { ...scanned, remote: { owner: 'o', name: 'n', defaultBranch: 'main', viewerPermission: 'ADMIN' }, prs: [], git: { ...scanned.git, remoteBranches: [{ name: 'feat' }] } };
  const p = await plan(r, { type: 'pr-create', branch: 'feat' });
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.steps[0].args, ['pr', 'create', '-R', 'o/n', '--head', 'feat', '--base', 'main', '--title', 'Add the b file', '--body', '']);
  assert.equal(p.steps[0].cwd, os.homedir());
  assert.notEqual(p.steps[0].cwd, d);
});

test('B14: planning refuses an instruction or settings file that is a link out of the repo', async () => {
  const { plan } = require('../src/actions');
  const d = repo({ 'a.txt': 'a\n' });
  const outside = path.join(tmp('gutcheck-out-'), 'private.md');
  fs.writeFileSync(outside, '# Private notes\n\nsecret plans\n'.repeat(200));
  fs.symlinkSync(outside, path.join(d, 'CLAUDE.md'));
  const stub = { checkRepo: async () => {}, gitConfig: async () => ({ all: [], untrusted: [] }) };
  const p = await plan({ path: d, name: 'r', git: { branch: 'main', branches: [] } }, { type: 'split-instructions', file: 'CLAUDE.md' }, stub);
  assert.equal(p.ok, false);
  assert.match(p.error, /link or leads outside the repo/);
  assert.ok(!JSON.stringify(p).includes('secret plans'));
});

test('B11: tool probes run in a private folder, not the shared temp folder', async () => {
  const { planTestRun } = require('../src/tests/runs');
  const seen = [];
  const ctx = { run: async (cmd, args, o) => { seen.push(o.cwd); return { ok: false, code: 1, stdout: '', stderr: '' }; }, fs };
  const d = repo({ 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n', 'src/lib.rs': '#[test]\nfn t() {}\n' });
  try { await planTestRun({ path: d, name: 'r' }, { kind: 'coverage' }, ctx); } catch { /* a refusal is fine: only the probe folder matters */ }
  assert.ok(seen.length > 0, 'a probe ran');
  for (const c of seen) { assert.notEqual(c, os.tmpdir()); assert.equal(fs.statSync(c).mode & 0o077, 0, 'private'); assert.deepEqual(fs.readdirSync(c), []); }
});

test('C6: over MCP an agent can only scan the workspace the user chose, or a folder inside it, and never changes it', async () => {
  const { createEngine } = require('../src/engine');
  const { chooseWorkspace } = require('./helpers/env');
  const mk = (root, n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); sh(d, 'init', '-q', '-b', 'main'); sh(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'); };
  const ws = tmp('gutcheck-c6ws-'); mk(ws, 'in1'); mk(path.join(ws, 'team'), 'in2');
  const other = tmp('gutcheck-c6other-'); mk(other, 'out1');
  const data = tmp('gutcheck-c6data-');
  const env = isolatedEnv({ GUTCHECK_DATA_DIR: data });
  const agent = () => createEngine({ env, via: 'mcp' });
  assert.match((await agent().scan({ root: ws })).error, /No workspace folder is set/);
  chooseWorkspace(data, ws);
  for (const bad of [other, '/', os.homedir(), path.dirname(ws), `${ws}-evil`]) assert.match((await agent().scan({ root: bad })).error, /outside the workspace/, bad);
  assert.equal((await agent().scan({})).ok, true);
  const sub = await agent().scan({ root: path.join(ws, 'team') });
  assert.equal(sub.ok, true, sub.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')), { root: ws }, 'an agent\'s scan is not remembered');
  // The CLI is the user: it may scan anywhere, and its folder is remembered.
  assert.equal((await createEngine({ env, via: 'cli' }).scan({ root: other })).ok, true);
});

test('C7: MCP output writes the home folder as ~ and masks the addresses of the identity findings only', () => {
  const { outbound } = require('../src/mcp');
  const home = '/home/ann';
  const o = outbound({ root: '/home/ann/Projects', repos: [{ path: '/home/ann/Projects/app', name: 'app', findings: [
    { id: 'git-identity', title: '2 recent commits by you used another email than ann@home.example', detail: 'Of your last 5 commits here: ann.work@corp.example (2).' },
    { id: 'pr-stale-3', title: 'PR by bob@other.example in /home/annex is stale' }] }] }, home);
  assert.equal(o.root, '~/Projects');
  assert.equal(o.repos[0].path, '~/Projects/app');
  assert.equal(o.repos[0].findings[0].title, '2 recent commits by you used another email than a***@home.example');
  assert.equal(o.repos[0].findings[0].detail, 'Of your last 5 commits here: a***@corp.example (2).');
  assert.equal(o.repos[0].findings[1].title, 'PR by bob@other.example in ~ex is stale'.replace('~ex', '/home/annex'), 'other text and look-alike paths are left alone');
  const md = outbound('- Path: `/home/ann/Projects/app`\n- 2 recent commits by you used another email than ann@home.example\n- Author bob@other.example', home);
  assert.equal(md, '- Path: `~/Projects/app`\n- 2 recent commits by you used another email than a***@home.example\n- Author bob@other.example');
});
