// Agent context checks and fixes: instruction size, LSP plugins, permission rules (never their values),
// the usage check, and stale agent config files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const C = require('../src/agent-context');
const U = require('../src/agent-usage');
const T = require('../src/agent-tidy');
const { plan, apply } = require('../src/actions');
const { createAgentConnect } = require('../src/agent-connect');

const tmp = (p = 'gutcheck-ctx-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (...d) => d.forEach((x) => fs.rmSync(x, { recursive: true, force: true }));
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const repo = () => { const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); return d; };
const big = (title, kb) => `## ${title}\n\n${'Rule text for this section that agents read. '.repeat(Math.ceil((kb * 1024) / 46))}\n`;
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

test('instruction size: follows @-imports in the repo, ignores ones in code, names the largest sections', () => {
  const d = repo();
  try {
    put(d, 'CLAUDE.md', `# Project\n\n@AGENTS.md\n\n\`@not-an-import.md\`\n\n\`\`\`\n@docs/also-not.md\n\`\`\`\n${big('Build', 2)}${big('Style', 9)}`);
    put(d, 'AGENTS.md', big('Agents', 6));
    put(d, 'docs/also-not.md', big('X', 30));
    assert.deepEqual(C.importsOf(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8')), ['AGENTS.md']);
    const m = C.measure(d, 'CLAUDE.md', os.homedir());
    assert.deepEqual(m.imports.map((i) => i.rel), ['AGENTS.md']);
    assert.equal(m.sections[0].heading, 'Style');
    const f = C.checkContext({ agents: { context: { instructions: [m], lsp: [], permissions: [] } } });
    assert.equal(f[0].id, 'agent-context-claude-md');
    assert.equal(f[0].severity, 'info');
    assert.match(f[0].title, /loads 1\d KB \(about \d\.\dk tokens\)/);
    assert.match(f[0].detail, /Largest sections: Style \d\.\d KB/);
    assert.deepEqual(f[0].fix, { type: 'split-instructions', label: 'Split…', file: 'CLAUDE.md' });
  } finally { rm(d); }
});

test('split-instructions keeps every line, turns big @-imports into pointers, and refuses a file changed since the preview', async () => {
  const d = repo();
  try {
    const text = `# Project\n\nIntro line.\n\n@docs/big.md\n\n${big('Build and test', 2)}${big('Style rules (set 1 Oct)', 9)}${big('Release', 6)}\`\`\`\n## not a heading\n\`\`\`\n`;
    put(d, 'CLAUDE.md', text);
    put(d, 'docs/big.md', big('Big', 4));
    const r = { path: d, name: 'x', git: {}, agents: {} };
    const p = await plan(r, { type: 'split-instructions', file: 'CLAUDE.md' });
    assert.equal(p.ok, true, p.error);
    assert.ok(p.display.some((x) => x.text.startsWith('write docs/agents/style-rules.md')), 'parentheses do not reach the file name');
    assert.ok(p.warnings.length, 'a section that reads like rules gets a warning');
    const res = await apply(p, {});
    assert.equal(res.ok, true, JSON.stringify(res.results));
    const after = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
    assert.match(after, /Read `docs\/big\.md` when the task needs it\./);
    assert.match(after, /## Style rules \(set 1 Oct\)\n\nMoved to \[docs\/agents\/style-rules\.md\]/);
    assert.ok(Buffer.byteLength(after) <= C.INSTR_INFO);
    const everything = [after, ...fs.readdirSync(path.join(d, 'docs', 'agents')).map((n) => fs.readFileSync(path.join(d, 'docs', 'agents', n), 'utf8'))].join('\n');
    assert.deepEqual(text.split('\n').filter((l) => l.trim() && !/^@/.test(l) && !everything.includes(l)), [], 'no line is lost');
    put(d, 'CLAUDE.md', text);
    const p2 = await plan(r, { type: 'split-instructions', file: 'CLAUDE.md' });
    fs.appendFileSync(path.join(d, 'CLAUDE.md'), 'edited\n');
    assert.match((await apply(p2, {})).results.at(-1).out, /Changed since the preview/);
  } finally { rm(d); }
});

test('permission rules: one-offs and token-like rules are found, and no value reaches a finding', () => {
  const rules = ['Bash(npm test:*)', 'Bash(git status)', `Bash(curl -H "Authorization: Bearer ${SECRET}" https://api.github.com/user)`, 'Bash(printf \'a long literal message for the commit body\' > /home/me/notes/x.txt)', 'WebFetch(domain:github.com)'];
  const c = rules.map(C.classifyRule);
  assert.deepEqual(c.map((x) => x.oneOff), [false, false, true, true, false]);
  assert.deepEqual(c.map((x) => x.tokenLike), [false, false, true, false, false]);
  const f = C.checkContext({ agents: { context: { instructions: [], lsp: [], permissions: c } } });
  assert.deepEqual(f.map((x) => x.id), ['agent-permissions-secret', 'agent-permissions-oneoff']);
  const text = JSON.stringify(f);
  for (const leak of [SECRET, 'Authorization', 'api.github.com', 'long literal message', '/home/me']) assert.ok(!text.includes(leak), `"${leak}" must not appear`);
  assert.match(f[0].detail, /Bash\(curl … \[\d+ chars, .*token-like.*\]\) #[0-9a-f]{8}/);
});

test('permissions-prune removes the chosen rules, backs up outside the repo, and never shows a value', async () => {
  const d = repo();
  const data = tmp('gutcheck-ctxdata-');
  const old = process.env.GUTCHECK_DATA_DIR;
  process.env.GUTCHECK_DATA_DIR = data;
  try {
    const rules = ['Bash(npm test:*)', `Bash(curl -H "Authorization: Bearer ${SECRET}" https://api.github.com/user)`];
    put(d, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: rules, deny: [] }, model: 'x' }, null, 2));
    const p = await plan({ path: d, name: 'x', git: {} }, { type: 'permissions-prune', hashes: [C.hashRule(rules[1])] });
    assert.equal(p.ok, true, p.error);
    assert.ok(!JSON.stringify({ ...p, steps: undefined }).includes(SECRET), 'the preview holds no value');
    assert.equal((await apply(p, {})).ok, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepEqual(cfg, { permissions: { allow: ['Bash(npm test:*)'], deny: [] }, model: 'x' });
    const backups = fs.readdirSync(path.join(data, 'backups'));
    assert.equal(backups.length, 1);
    assert.ok(fs.readFileSync(path.join(data, 'backups', backups[0]), 'utf8').includes(SECRET), 'the original is recoverable');
    assert.ok(!fs.readdirSync(path.join(d, '.claude')).some((n) => n !== 'settings.local.json'), 'no backup inside the repo');
    assert.equal((await plan({ path: d, name: 'x', git: {} }, { type: 'permissions-prune', hashes: [C.hashRule(rules[1])] })).ok, false, 'already gone');
  } finally { if (old === undefined) delete process.env.GUTCHECK_DATA_DIR; else process.env.GUTCHECK_DATA_DIR = old; rm(d, data); }
});

test('LSP: a missing or turned-off plugin gets a Set up fix that installs or enables it, and the server', async () => {
  const f = C.checkContext({ agents: { context: { instructions: [], permissions: [], lsp: [
    { name: 'rust-analyzer-lsp', command: 'rust-analyzer', files: 40, installed: false, enabled: false, binary: true },
    { name: 'pyright-lsp', command: 'pyright-langserver', files: 9, installed: true, enabled: true, binary: false },
    { name: 'gopls-lsp', command: 'gopls', files: 12, installed: true, enabled: true, binary: true },
  ] } } });
  assert.deepEqual(f.map((x) => x.id), ['agent-lsp-rust-analyzer-lsp', 'agent-lsp-pyright-lsp']);
  assert.match(f[0].detail, /Set up installs the plugin;/);
  assert.match(f[1].title, /pyright-language?server is missing|pyright-langserver is missing/);
  const bin = tmp('gutcheck-bin-');
  try {
    for (const b of ['claude', 'npm']) { fs.writeFileSync(path.join(bin, b), '#!/bin/sh\n'); fs.chmodSync(path.join(bin, b), 0o755); }
    const r = { path: bin, name: 'x', git: {}, agents: { context: { lsp: [{ name: 'pyright-lsp', command: 'pyright-langserver', files: 9, installed: false, enabled: false, binary: false }] } } };
    const p = await plan(r, { type: 'lsp-setup', plugin: 'pyright-lsp' }, { env: { PATH: bin } });
    assert.equal(p.ok, true, p.error);
    assert.deepEqual(p.display.map((x) => x.text), ['claude plugin install pyright-lsp@claude-plugins-official --scope user', 'npm install -g pyright']);
    assert.ok(p.steps.every((x) => x.cwd === os.homedir()), 'installs run from the home folder, not the repo (its .npmrc)');
    assert.equal(p.risk, 'danger', 'a global install changes the machine: the repo name must be typed');
    assert.equal((await plan(r, { type: 'lsp-setup', plugin: 'nope' })).ok, false);
  } finally { rm(bin); }
});

test('usage: transcripts give tool, skill, command and server counts; claude mcp list is parsed without targets', async () => {
  const home = tmp('gutcheck-home-');
  try {
    const proj = path.join(home, '.claude', 'projects', '-w-app');
    const line = (o) => JSON.stringify(o) + '\n';
    put(proj, 's1.jsonl', line({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'used-skill' } }, { type: 'tool_use', name: 'mcp__github__get_issue', input: {} }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --watch' } }] } })
      + line({ message: { content: '<command-name>/deploy</command-name> secret words here' } }) + line({ message: { content: [{ type: 'text', text: 'hello' }] } }) + 'not json\n');
    const used = await U.usage(home, [{ path: '/w/app', name: 'app' }], { permRules: { '/w/app': ['Bash(npm test:*)', 'Bash(rm -rf build)'] } });
    assert.equal(used.sessions, 1);
    assert.equal(used.skills.get('used-skill'), 1);
    assert.equal(used.servers.get('github'), 1);
    assert.equal(used.commands.get('deploy'), 1);
    assert.equal(used.ruleHits.get(`/w/app|${C.hashRule('Bash(npm test:*)')}`), 1);
    const idle = U.ruleVerdicts([{ path: '/w/app', name: 'app' }], { '/w/app': ['Bash(npm test:*)', 'Bash(rm -rf build)'] }, used);
    assert.match(idle[0].title, /1 of 2 Bash permission rules in app never matched/);
    const list = U.parseMcpList(`Checking MCP server health…\n\ngood: node /x/srv.js --token ${SECRET} - ✔ Connected\nbroken: /nonexistent/bin  - ✘ Failed to connect — ENOENT: no such file\nSolve Intelligence: https://api.x/mcp/ (HTTP) - ✘ Failed to connect — Incompatible auth server: does not support dynamic client registration\nslack: https://mcp.slack.com/mcp (HTTP) - ⚠ Needs authentication\n`);
    assert.deepEqual(list.map((s) => [s.name, s.status]), [['good', 'working'], ['broken', 'failed'], ['Solve Intelligence', 'needs-auth'], ['slack', 'needs-auth']]);
    assert.ok(!JSON.stringify(list).includes(SECRET) && !JSON.stringify(list).includes('srv.js'), 'commands and arguments are never kept');
    const v = U.verdicts({ plugins: [], servers: [], skills: [{ name: 'idle-skill', scope: 'project', repo: 'app', path: '/w/app/.claude/skills/idle-skill' }, { name: 'used-skill', scope: 'user', path: '/h/s' }] }, used, list, { home: '/h' });
    assert.deepEqual(v.map((x) => [x.fix.type, x.id]), [['skill-remove', 'usage-skill-project-app-idle-skill'], ['mcp-remove', 'usage-mcp-unused-good'], ['mcp-remove', 'usage-mcp-failed-broken'], ['mcp-login', 'usage-mcp-auth-Solve Intelligence'], ['mcp-login', 'usage-mcp-auth-slack']]);
  } finally { rm(home); }
});

test('stale agent config: old .gutcheck.bak and interrupted-write temp files are found and trashed after a preview', async () => {
  const home = tmp('gutcheck-home-');
  const data = tmp('gutcheck-data-');
  try {
    const old = (p) => { const t = (Date.now() - 10 * 86400000) / 1000; fs.utimesSync(p, t, t); };
    put(home, '.cursor/mcp.json.gutcheck.bak', '{}'); old(path.join(home, '.cursor/mcp.json.gutcheck.bak'));
    put(home, '.claude.json.tmp.123.abc', '{}'); old(path.join(home, '.claude.json.tmp.123.abc'));
    put(home, '.gemini/settings.json.gutcheck.bak', '{}'); // recent: kept
    put(home, '.claude/backups/.claude.json.backup.1', '{}'); old(path.join(home, '.claude/backups/.claude.json.backup.1')); // Claude Code's own rotation
    assert.deepEqual(T.staleConfig(home, data).map((x) => path.relative(home, x.path)).sort(), ['.claude.json.tmp.123.abc', '.cursor/mcp.json.gutcheck.bak']);
    const trashed = [];
    const ac = createAgentConnect({ home, env: { PATH: '' }, platform: 'linux', trash: async (p) => { trashed.push(p); fs.rmSync(p); }, launch: { dataDir: data } });
    const p = ac.planFix({ type: 'agent-config-cleanup' });
    assert.equal(p.ok, true, p.error);
    const r = await ac.apply(p.token);
    assert.equal(r.ok, true);
    assert.equal(trashed.length, 2);
    assert.equal(ac.planFix({ type: 'plugin-disable', plugin: 'x' }).ok, false, 'no claude binary here');
    assert.equal(ac.planFix({ type: 'skill-remove', path: '/etc' }).ok, false, 'only skills found in the config can be removed');
  } finally { rm(home, data); }
});

test('split-instructions keeps imports of the other agents\' files, and offers git checkout as undo only for a clean file', async () => {
  const d = repo();
  try {
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d }); execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
    put(d, 'AGENTS.md', big('Shared rules', 4));
    put(d, 'CLAUDE.md', `# Project\n\n@AGENTS.md\n\n${big('Build', 9)}${big('Release', 9)}`);
    const r = { path: d, name: 'x', git: {}, agents: {} };
    const dirty = await plan(r, { type: 'split-instructions', file: 'CLAUDE.md' });
    assert.equal(dirty.ok, true, dirty.error);
    assert.doesNotMatch(dirty.undo, /git checkout/, 'uncommitted edits would be lost');
    execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['commit', '-qm', 'x'], { cwd: d });
    const clean = await plan(r, { type: 'split-instructions', file: 'CLAUDE.md' });
    assert.match(clean.undo, /^git checkout -- CLAUDE\.md/);
    assert.equal((await apply(clean, {})).ok, true);
    assert.match(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m, 'still an import');
  } finally { rm(d); }
});
