// The CLI and MCP side of ignores, the baseline and "new since last scan", on a real temp workspace.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isolatedEnv } = require('./helpers/env');
const { execFileSync } = require('node:child_process');
const { main } = require('../src/cli');
const { createEngine } = require('../src/engine');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
function workspace() {
  const root = tmp('gutcheck-upws-');
  for (const n of ['alpha', 'beta']) {
    const d = path.join(root, n);
    fs.mkdirSync(d);
    sh(d, 'init', '-q', '-b', 'main');
    sh(d, 'config', 'user.email', 't@t');
    sh(d, 'config', 'user.name', 't');
    sh(d, 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  return root;
}
const run = async (argv, env) => { const o = []; const e = []; const code = await main(argv, { out: (s) => o.push(s), err: (s) => e.push(s), env }); return { code, out: o.join('\n'), err: e.join('\n') }; };

test('cli: ignore with a reason, list it, stop ignoring; drift after baseline init; new findings', async () => {
  const root = workspace();
  const data = tmp('gutcheck-updata-');
  const env = isolatedEnv({ GUTCHECK_DATA_DIR: data });
  try {
    const first = await run(['new', '--root', root], env);
    assert.match(first.out, /First scan/);
    fs.writeFileSync(path.join(root, 'beta', 'new.txt'), 'x');
    const second = await run(['new', '--root', root], env);
    assert.match(second.out, /beta: 1 uncommitted change {2}\[git-dirty\]/);
    assert.match((await run(['new', '--root', root], env)).out, /No new findings/);

    assert.equal((await run(['ignore', 'alpha', 'no-remote', '--root', root], env)).code, 1, 'a reason is required');
    const ig = await run(['ignore', 'alpha', 'no-remote', 'scratch', 'repo', 'only', '--root', root], env);
    assert.equal(ig.code, 0, ig.err);
    assert.match(ig.out, /Ignoring no-remote in alpha: scratch repo only/);
    const list = await run(['ignored', '--root', root], env);
    assert.match(list.out, /alpha: No GitHub remote {2}\[no-remote\]\n {4}Ignored by you \(GutCheck settings\): scratch repo only/);
    const f = JSON.parse((await run(['findings', '--repo', 'alpha', '--json', '--root', root], env)).out);
    assert.ok(!f.findings.some((x) => x.id === 'no-remote'), 'ignored findings are gone from findings');
    assert.equal((await run(['unignore', 'alpha', 'no-remote', '--root', root], env)).code, 0);
    assert.match((await run(['ignored', '--root', root], env)).out, /Nothing is ignored/);
    assert.match(fs.readFileSync(path.join(data, 'audit.log'), 'utf8'), /Ignored no-remote: scratch repo only/);

    assert.match((await run(['drift', '--root', root], env)).out, /No baseline yet/);
    assert.match((await run(['baseline', 'init'], env)).out, /Created: .*baseline\.json/);
    const b = JSON.parse(fs.readFileSync(path.join(data, 'baseline.json'), 'utf8'));
    fs.writeFileSync(path.join(data, 'baseline.json'), JSON.stringify({ ...b, require: ['readme', 'license'], skip: { beta: ['license'] } }));
    const dr = await run(['drift', '--root', root], env);
    assert.match(dr.out, /! README +0 ok, missing in alpha, beta/);
    assert.match(dr.out, /! Licence file +0 ok, missing in alpha$/m);
  } finally { for (const d of [root, data]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('mcp engine: ignoring needs --allow-actions on the server; drift and new are read-only', async () => {
  const root = workspace();
  const data = tmp('gutcheck-updata-');
  try {
    const ro = createEngine({ env: isolatedEnv({ GUTCHECK_DATA_DIR: data }), via: 'mcp' });
    await ro.scan({ root });
    const { TOOLS } = require('../src/mcp');
    const tool = (n) => TOOLS.find((t) => t.name === n);
    assert.match((await tool('gutcheck_ignore').run(ro, { repo: 'alpha', finding: 'no-remote', reason: 'x' })).error, /read-only/);
    assert.equal((await tool('gutcheck_drift').run(ro, {})).baseline, null);
    assert.equal((await tool('gutcheck_new').run(ro, {}, () => {})).compared, false);
    const rw = createEngine({ env: isolatedEnv({ GUTCHECK_DATA_DIR: data }), via: 'mcp', allowActions: true });
    await rw.scan({ root });
    assert.equal((await tool('gutcheck_ignore').run(rw, { repo: 'alpha', finding: 'no-remote', reason: 'scratch' })).ok, true);
    const d = await rw.repoDetail({ repo: 'alpha' });
    assert.deepEqual(d.ignored, [{ id: 'no-remote', title: 'No GitHub remote', reason: 'scratch', from: 'Ignored by you (GutCheck settings)' }]);
  } finally { for (const d of [root, data]) fs.rmSync(d, { recursive: true, force: true }); }
});
