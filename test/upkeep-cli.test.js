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
    require('./helpers/env').chooseWorkspace(data, root);
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
    assert.deepEqual(d.ignored, [{ id: 'no-remote', title: 'No GitHub remote', reason: '"scratch"', from: 'Ignored through an AI agent (MCP)', note: 'Written by an AI agent through MCP, not in GutCheck by the user.' }]);
  } finally { for (const d of [root, data]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('cli: no command prints terminal escapes or bidi controls from a repo name, and --json still parses (audit 2026-11-16, T3)', async () => {
  const root = tmp('gutcheck-upws-');
  const evil = 'al\x1b]0;PWNED\x07\x1b[31mpha‮';
  const d = path.join(root, evil);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't');
  sh(d, 'commit', '-q', '--allow-empty', '-m', 'init');
  const env = isolatedEnv({ GUTCHECK_DATA_DIR: tmp('gutcheck-updata-') });
  try {
    const raw = /[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/;
    for (const argv of [['scan', root], ['findings', '--root', root], ['repo', evil, '--root', root], ['ignored', '--root', root], ['local-only', '--root', root]]) {
      const r = await run(argv, env);
      assert.ok(!raw.test(r.out + r.err), `${argv[0]} printed a raw control character`);
    }
    const scan = await run(['scan', root], env);
    assert.ok(scan.out.includes('al\\x1b]0;PWNED\\x07'), scan.out);
    const j = await run(['findings', '--json', '--root', root], env);
    assert.ok(!raw.test(j.out));
    assert.ok(JSON.parse(j.out).findings.some((f) => f.repo === evil), 'the name survives as JSON escapes');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cli: a mistyped command or option is an error before anything is scanned or run (audit 2026-11-07, B23)', async () => {
  const env = isolatedEnv({ GUTCHECK_DATA_DIR: tmp('gutcheck-updata-') });
  let scans = 0;
  const run2 = async (argv) => { const o = []; const e = []; const code = await main(argv, { out: (s) => o.push(s), err: (s) => e.push(s), env, engineOpts: { onScan: () => scans++ } }); return { code, out: o.join('\n'), err: e.join('\n') }; };
  for (const [argv, why] of [
    [['findigs', '--root', '/nowhere'], /unknown command "findigs"/],
    [['fix', 'alpha', 'all', '--yess'], /unknown option --yess/],
    [['findings', '--severity', 'critical'], /--severity is error, warn or info/],
    [['findings', '--repo'], /--repo needs a value/],
    [['findings', '--repo', '--json'], /--repo needs a value/],
  ]) {
    const r = await run2(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, why);
    assert.equal(r.out, '', 'nothing else is printed');
  }
  assert.equal((await run2(['--version'])).code, 0);
  assert.equal((await run2(['help'])).code, 0);
});
