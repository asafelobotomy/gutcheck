// File names are attacker-chosen (a cloned repo names its own folders), so the secrets CLI and the
// plan display escape control, C1 and bidi characters instead of sending them to the terminal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { printable } = require('../src/util');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const EVIL = 'evil\x1b]52;c;aGk=\x07\u202Etxt.\x9b2K\u2028';
const FILE = '\x1b[2K\u202Eyek.pem'; // a name a secret pattern matches (no line separator there)
const RAW = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

test('printable escapes C0, C1, DEL, line separators and bidi controls, and nothing else', () => {
  assert.equal(printable('a\x1b]52;c;x\x07b'), 'a\\x1b]52;c;x\\x07b');
  assert.equal(printable('\x7f\x85\x9b'), '\\x7f\\x85\\x9b');
  assert.equal(printable('x\u202Ey\u2066\u2069\u200E\u200F\u061C\u2028\u2029'), 'x\\u{202e}y\\u{2066}\\u{2069}\\u{200e}\\u{200f}\\u{61c}\\u{2028}\\u{2029}');
  assert.equal(printable('café ~/.env\t"x"'), 'café ~/.env\\x09"x"');
  assert.equal(printable(42), '42');
  assert.ok(!RAW.test(printable(EVIL)));
});

test('printable also escapes format and invisible characters, and backslash, so it is one-to-one', () => {
  for (const ch of ['\u{200b}', '\u{200d}', '\u{2060}', '\u{feff}', '\u{ad}', '\u{180e}', '\u{fe0f}', '\u{E0041}', '\u{fff9}', '\u{34f}', '\u{3164}', '\u{115f}', '\u{1160}', '\u{fe00}', '\u{E0100}', '\u{E01EF}']) {
    const got = printable(`a${ch}b`);
    assert.equal(got, `a\\u{${ch.codePointAt(0).toString(16)}}b`, JSON.stringify(ch));
  }
  assert.equal(printable('a\\x1b'), 'a\\\\x1b');
  assert.notEqual(printable('a\\x1b'), printable('a\x1b'), 'a literal backslash never looks like an escape');
});

function setup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-esc-')));
  const root = path.join(tmp, 'ws'), home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), bin = path.join(tmp, 'bin');
  const repo = path.join(root, EVIL);
  for (const d of [repo, home, data, bin]) fs.mkdirSync(d, { recursive: true });
  const gitcfg = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitcfg, '[user]\n\temail = t@t\n\tname = t\n');
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GUTCHECK_DATA_DIR: data,
    GH_CONFIG_DIR: path.join(home, '.gh'), GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', repo], { env });
  fs.writeFileSync(path.join(repo, FILE), 'API_TOKEN=esc-hunter2\n');
  // A fake pass-cli that is never run: the preview only names it.
  fs.writeFileSync(path.join(bin, 'pass-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const run = (...a) => spawnSync(process.execPath, [CLI, 'secrets', '--root', root, ...a], { env, encoding: 'utf8', timeout: 60000 });
  return { tmp, root, repo, data, run, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('cli: secrets table and backup preview print escaped names, never raw ESC, BEL or bidi characters', () => {
  const w = setup();
  try {
    const t = w.run();
    assert.equal(t.status, 0, t.stderr);
    assert.ok(!RAW.test(t.stdout), JSON.stringify(t.stdout));
    assert.ok(t.stdout.includes('evil\\x1b]52;c;aGk=\\x07\\u{202e}txt.\\x9b2K\\u{2028}/\\x1b[2K\\u{202e}yek.pem'), t.stdout);
    assert.ok(!t.stdout.includes('hunter'));

    fs.writeFileSync(path.join(w.data, 'settings.json'), JSON.stringify({ vault: { tool: 'proton', target: 'Dev' } }));
    const b = w.run('--backup');
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /Back up 1 secret file to Proton Pass/);
    assert.ok(!RAW.test(b.stdout + b.stderr), JSON.stringify(b.stdout));
    assert.ok(b.stdout.includes('← contents of repo evil\\x1b]52'), b.stdout);
    assert.match(b.stdout, /Nothing was run/);
  } finally { w.cleanup(); }
});

test('plan display text escapes the file name for the app as well', async () => {
  const { setup: vsetup, okRun } = require('./helpers/vault-ctl');
  const { tmp, mkCtl } = vsetup();
  const root = path.join(tmp, 'ws5');
  const repo = path.join(root, EVIL);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const file = path.join(repo, FILE);
  fs.writeFileSync(file, 'K=1\n');
  const ws = { repos: [{ path: repo, name: EVIL }], root };
  const ctl = mkCtl({ run: okRun() });
  for (const [tool, target] of [['proton', 'Dev'], ['pass', ''], ['keepassxc', { db: '/d.kdbx', keyFile: '/k' }], ['bitwarden', '']]) {
    ctl.link({ tool, target });
    const p = await ctl.plan([file], { via: 'app', ...ws });
    assert.ok(p.ok, `${tool}: ${p.error}`);
    for (const d of p.display) assert.ok(!RAW.test(d.text), `${tool}: ${JSON.stringify(d.text)}`);
    assert.ok(!RAW.test(p.note) && !RAW.test(p.title));
  }
});
