// Reviewing permission rules in the app (a value only on request), and agent usage and fixes over MCP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, tick } = require('./helpers/dom');
const { createEngine } = require('../src/engine');
const { TOOLS } = require('../src/mcp');

const click = (el) => el.click();
const SECRET = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';

test('app: Review rules lists shapes, shows one value only when asked, and removes the ticked rules', async () => {
  const r = { path: '/w/app', name: 'app', score: 80, grade: 'B', prs: [], ci: { failed: [] }, alerts: [], files: { license: true, readme: true }, remote: { pushedAt: new Date().toISOString(), url: 'https://github.com/o/app' },
    git: { branch: 'main', dirty: 0, ahead: 0, behind: 0, branches: [], remoteBranches: [], mergedBranches: [] },
    findings: [{ id: 'agent-permissions-secret', category: 'AI agents', severity: 'warn', title: '1 permission rule holds a token-like value', detail: 'Bash(curl … [97 chars, token-like]) #aaaa1111', fix: { type: 'permissions-prune', label: 'Remove…', hashes: ['aaaa1111'] } }] };
  const t = await boot({ repos: [r] });
  const calls = [];
  t.w.api.agentRules = async (dir) => { calls.push(['rules', dir]); return { ok: true, rules: [{ hash: 'aaaa1111', shape: 'Bash(curl … [97 chars, token-like])', tokenLike: true, oneOff: true }, { hash: 'bbbb2222', shape: 'Bash(npm … [10 chars])', tokenLike: false, oneOff: false }] }; };
  t.w.api.revealRule = async (dir, hash) => { calls.push(['reveal', hash]); return { ok: true, value: `Bash(curl -H "Authorization: Bearer ${SECRET}" https://api.github.com)` }; };
  let planned = null;
  t.w.api.planActions = async (items) => { planned = items; return [{ ok: false, error: 'stop' }]; };
  click(t.$('#scan')); await tick(80);
  click(t.$$('#repos li')[0]); await tick();
  click(t.$$('.finding button').find((b) => b.textContent === 'Review rules…')); await tick();
  assert.ok(!t.$('.modal').textContent.includes(SECRET), 'no value until asked');
  assert.deepEqual(t.$$('.modal input[type=checkbox]').map((c) => c.checked), [true, false], 'the flagged rule starts ticked');
  click(t.$$('.modal .row button')[0]); await tick();
  assert.ok(t.$('.modal').textContent.includes(SECRET), 'Show reveals it in this window');
  assert.deepEqual(calls.at(-1), ['reveal', 'aaaa1111']);
  click(t.$$('.modal .row button')[0]); await tick();
  assert.ok(!t.$('.modal').textContent.includes(SECRET), 'Hide removes it again');
  const second = t.$$('.modal input[type=checkbox]')[1];
  second.checked = true; second.dispatchEvent(new t.w.Event('change'));
  const go = t.$$('.modal button').find((b) => /^Remove 2 rules/.test(b.textContent));
  click(go); await tick();
  assert.deepEqual(planned[0].action, { type: 'permissions-prune', hashes: ['aaaa1111', 'bbbb2222'] });
});

test('mcp: agent usage needs --allow-actions to start servers, and agent fixes plan and apply through the usual tools', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-mhome-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-mdata-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-mws-'));
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const stale = path.join(home, '.cursor', 'mcp.json.gutcheck.bak');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, '{}');
    const t = (Date.now() - 10 * 86400000) / 1000;
    fs.utimesSync(stale, t, t);
    const env = { ...process.env, HOME: home, GUTCHECK_DATA_DIR: data };
    const tool = (n) => TOOLS.find((x) => x.name === n);
    const ro = createEngine({ env, via: 'mcp' });
    await ro.scan({ root });
    assert.match((await tool('gutcheck_agent_usage').run(ro, { live: true }, () => {})).error, /--allow-actions/);
    const r = await tool('gutcheck_agent_usage').run(ro, {}, () => {});
    assert.equal(r.ok, true);
    assert.equal(r.servers, null, 'no server was started');
    const rw = createEngine({ env, via: 'mcp', allowActions: true });
    await rw.scan({ root });
    const p = await rw.plan({ items: [{ agentFix: { type: 'agent-config-cleanup' } }] });
    const plan = p.plans[0];
    assert.equal(plan.ok, true, plan.error);
    assert.match(plan.token, /^a:/);
    assert.deepEqual(plan.commands, ['trash ~/.cursor/mcp.json.gutcheck.bak']);
    const done = await rw.apply({ tokens: [plan.token] });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.ok(!fs.existsSync(stale));
    assert.match(fs.readFileSync(path.join(data, 'audit.log'), 'utf8'), /stale config file/);
  } finally {
    process.env.HOME = oldHome;
    for (const d of [home, data, root]) fs.rmSync(d, { recursive: true, force: true });
  }
});
