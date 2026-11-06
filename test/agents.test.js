const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanAgents, checkAgents, agentAdvice, agentFix, mcpLiteralSecrets, projectKey, balooState, INSTRUCTION_MAX_LINES } = require('../src/agents');
const { buildReport } = require('../src/report');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const tmp = (p = 'gutcheck-ag-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cleanup = (...d) => d.forEach((x) => fs.rmSync(x, { recursive: true, force: true }));
const put = (dir, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const repo = () => { const d = tmp(); sh(d, 'init', '-q'); return d; };
const ids = (s) => checkAgents({ agents: s }).map((f) => f.id);
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
// Assembled at runtime so this file holds no key-shaped literal of its own.
const FAKE_KEY = ['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('-');

test('projectKey matches how Claude Code names a project folder', () => {
  assert.equal(projectKey('/home/user/work/my-repo'), '-home-user-work-my-repo');
  assert.equal(projectKey('/home/a/b_c.d'), '-home-a-b-c-d');
});

test('MCP config: literal credentials are named by key only, ${VAR} references pass', () => {
  const cfg = { mcpServers: {
    api: { command: 'x', env: { API_KEY: FAKE_KEY, MODE: 'production-mode-x', REF: '${API_KEY}' } },
    web: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' } },
    ok: { command: 'y', env: { DEBUG: 'true', TOKEN: '${TOKEN:-}' } },
  } };
  const found = mcpLiteralSecrets(cfg);
  assert.deepEqual(found.sort(), ['api.env.API_KEY', 'web.headers.Authorization']);
  assert.ok(!JSON.stringify(found).includes(FAKE_KEY));
  assert.deepEqual(mcpLiteralSecrets(null), []);
  assert.deepEqual(mcpLiteralSecrets({ mcpServers: 'nope' }), []);
});

test('scanAgents: committed local settings, a committed MCP secret, split and long instruction files', async () => {
  const d = repo();
  const home = tmp('gutcheck-home-');
  try {
    put(d, '.claude/settings.local.json', '{}');
    put(d, '.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'x', env: { SECRET_TOKEN: FAKE_KEY } } } }));
    put(d, 'CLAUDE.md', lines(INSTRUCTION_MAX_LINES + 5));
    put(d, 'AGENTS.md', '# Agents\n');
    sh(d, 'add', '-A');
    const a = await scanAgents(d, { home });
    assert.equal(a.localSettings, 'tracked');
    assert.deepEqual(a.mcp, { parsed: true, tracked: true, literal: ['s.env.SECRET_TOKEN'] });
    assert.equal(a.claudeMd.lines, INSTRUCTION_MAX_LINES + 5);
    assert.equal(a.history, false);
    const f = checkAgents({ agents: a });
    assert.deepEqual(f.map((x) => x.id), ['agent-mcp-secret', 'agent-local-settings-tracked', 'agent-claude-md-long', 'agent-instructions-split']);
    assert.equal(f[0].severity, 'error');
    assert.ok(f.every((x) => x.category === 'AI agents' && x.ref && x.ref.startsWith('https://')));
    assert.ok(!JSON.stringify(f).includes(FAKE_KEY), 'the value never reaches a finding');
  } finally { cleanup(d, home); }
});

test('scanAgents: ignored vs unignored local settings, @AGENTS.md import, other-tool rules, history without instructions', async () => {
  const d = repo();
  const home = tmp('gutcheck-home-');
  try {
    put(d, '.claude/settings.local.json', '{}');
    let a = await scanAgents(d, { home });
    assert.equal(a.localSettings, 'unignored');
    put(d, '.gitignore', '.claude/settings.local.json\n');
    a = await scanAgents(d, { home });
    assert.equal(a.localSettings, 'ignored');
    assert.deepEqual(ids(a), []);

    put(d, '.cursorrules', 'be nice');
    fs.mkdirSync(path.join(home, '.claude', 'projects', projectKey(d)), { recursive: true });
    a = await scanAgents(d, { home });
    assert.equal(a.history, true);
    assert.deepEqual(ids(a), ['agent-instructions-other-tool', 'agent-no-instructions']);

    put(d, 'AGENTS.md', '# Agents\n');
    put(d, 'CLAUDE.md', '@AGENTS.md\n\nClaude notes\n');
    a = await scanAgents(d, { home });
    assert.equal(a.claudeMd.importsAgents, true);
    assert.deepEqual(ids(a), [], 'CLAUDE.md importing AGENTS.md is the recommended layout');
  } finally { cleanup(d, home); }
});

test('every per-repo agent finding has a report step', () => {
  for (const id of ['agent-mcp-secret', 'agent-local-settings-tracked', 'agent-local-settings-unignored', 'agent-claude-md-long', 'agent-agents-md-long', 'agent-instructions-split', 'agent-instructions-other-tool', 'agent-no-instructions']) {
    const s = agentFix(id);
    assert.ok(s && Number.isInteger(s.phase) && s.why && s.ref, id);
  }
  assert.equal(agentFix('agent-mcp-secret').phase, 0, 'credentials come first in the plan');
});

test('balooState: excluded folders, $HOME expansion, content indexing, disabled indexer', () => {
  const home = tmp('gutcheck-home-');
  const old = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    put(home, '.config/baloofilerc', '[General]\nexclude folders[$e]=$HOME/.claude/,$HOME/Projects/\nonly basic indexing=true\n');
    let b = balooState(home);
    assert.equal(b.enabled, true);
    assert.equal(b.contents, false);
    assert.equal(b.covered(path.join(home, '.claude')), false);
    assert.equal(b.covered(path.join(home, '.claude', 'projects')), false);
    assert.equal(b.covered(path.join(home, '.cursor')), true);
    put(home, '.config/baloofilerc', '[Basic Settings]\nIndexing-Enabled=false\n');
    assert.deepEqual(balooState(home), { enabled: false });
    fs.rmSync(path.join(home, '.config', 'baloofilerc'));
    assert.equal(balooState(home), null);
  } finally {
    if (old !== undefined) process.env.XDG_CONFIG_HOME = old;
    cleanup(home);
  }
});

test('agentAdvice: nothing without an agent app; transcripts, indexer, parallelism, subagent model and plugins with one', async () => {
  const home = tmp('gutcheck-home-');
  const old = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.deepEqual(await agentAdvice([], { home, env: {} }), [], 'no agent installed: no agent advice');

    const plugins = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}@market`, true]));
    put(home, '.claude/settings.json', JSON.stringify({ enabledPlugins: { ...plugins, off: false }, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'some-model' } }));
    const proj = path.join(home, '.claude', 'projects', projectKey('/w/big'));
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 's.jsonl'), Buffer.alloc(600 * 1024 * 1024 / 1024)); // 600 KiB
    put(home, '.config/baloofilerc', '[General]\nonly basic indexing=false\n');

    const small = await agentAdvice([{ path: '/w/big', name: 'big' }], { home, cpus: 4, memBytes: 8 * 1073741824, env: {} });
    const byId = Object.fromEntries(small.map((a) => [a.id, a]));
    assert.deepEqual(Object.keys(byId).sort(), ['agent-indexer', 'agent-parallel', 'agent-plugins', 'agent-subagent-model']);
    assert.equal(byId['agent-indexer'].severity, 'warn');
    assert.match(byId['agent-indexer'].detail, /~\/\.claude/);
    assert.match(byId['agent-plugins'].title, /^9 Claude Code plugins/);
    assert.ok(!JSON.stringify(small).includes('some-model'), 'settings values never reach advice');
    assert.ok(small.every((a) => a.category === 'AI agents' && a.ref));

    // Transcripts only above the threshold; capped size reported; a big machine with a cap set gets no parallel advice.
    fs.writeFileSync(path.join(proj, 's.jsonl'), Buffer.alloc(0));
    fs.truncateSync(path.join(proj, 's.jsonl'), 600 * 1024 * 1024);
    put(home, '.claude/settings.json', JSON.stringify({ cleanupPeriodDays: 7, env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3' } }));
    const big = await agentAdvice([{ path: '/w/big', name: 'big' }], { home, cpus: 32, memBytes: 64 * 1073741824, env: {} });
    const t = big.find((a) => a.id === 'agent-transcripts');
    assert.ok(t, 'large history is reported');
    assert.match(t.detail, /big \(600 MB\)/);
    assert.match(t.detail, /cleanupPeriodDays is 7/);
    assert.ok(!big.some((a) => a.id === 'agent-parallel'));
  } finally {
    if (old !== undefined) process.env.XDG_CONFIG_HOME = old;
    cleanup(home);
  }
});

test('agent findings reach the LLM report with their steps and sources', () => {
  const r = { name: 'r', path: '/w/r', score: 90, grade: 'A', git: {}, findings: [{ id: 'agent-local-settings-tracked', category: 'AI agents', severity: 'warn', title: '.claude/settings.local.json is committed', detail: 'x' }] };
  const text = buildReport({ repos: [r] });
  assert.match(text, /git rm --cached \.claude\/settings\.local\.json/);
  assert.match(text, /code\.claude\.com\/docs\/en\/settings#keep-personal-settings-out-of-a-repository/);
});
