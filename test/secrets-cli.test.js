// `gutcheck secrets` run as a real process with a temp HOME, data folder and workspace: it lists
// secret files by title and status, never their contents, and skips with a reason.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

function setup() {
  const root = tmp('gutcheck-secws-');
  const home = tmp('gutcheck-sechome-');
  const data = tmp('gutcheck-secdata-');
  const d = path.join(root, 'alpha');
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@t');
  sh(d, 'config', 'user.name', 't');
  sh(d, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(d, '.env'), 'API_TOKEN=cli-hunter2\n');
  fs.mkdirSync(path.join(home, '.aws'));
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key=cli-hunter3\n');
  fs.mkdirSync(path.join(home, '.gnupg', 'private-keys-v1.d'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gnupg', 'private-keys-v1.d', 'ABC.key'), 'gpg-hunter4');
  // Only the temp folders: the real home and the real data folder are never read or written.
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GUTCHECK_DATA_DIR: data, GH_CONFIG_DIR: path.join(home, '.gh') };
  const run = (...a) => spawnSync(process.execPath, [CLI, 'secrets', '--root', root, ...a], { env, encoding: 'utf8', timeout: 60000 });
  return { root, home, data, env, run, cleanup: () => [root, home, data].forEach((x) => fs.rmSync(x, { recursive: true, force: true })) };
}

test('cli: gutcheck secrets lists files by title and status, never contents or hashes', () => {
  const w = setup();
  try {
    const j = w.run('--json');
    assert.equal(j.status, 0, j.stderr);
    for (const bad of ['hunter', 'sha256']) assert.ok(!j.stdout.includes(bad), bad);
    const r = JSON.parse(j.stdout);
    assert.equal(r.linked, false);
    const by = Object.fromEntries(r.items.map((x) => [x.title, x]));
    assert.equal(by['gutcheck: repo alpha/.env'].status, 'unbacked');
    assert.equal(by['gutcheck: home ~/.aws/credentials'].status, 'unbacked');
    assert.equal(by['gutcheck: home ~/.gnupg/private-keys-v1.d'].saveable, false, 'a folder cannot be saved as one item');

    const t = w.run();
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /unbacked .*alpha\/\.env/);
    assert.match(t.stdout, /~\/\.gnupg\/private-keys-v1\.d.*export with gpg --export-secret-keys yourself/);
    assert.ok(!t.stdout.includes('hunter'));

    const b = w.run('--backup');
    assert.equal(b.status, 1);
    assert.match(b.stderr, /Link a password manager first/);

    const real = fs.realpathSync(path.join(w.home, '.aws', 'credentials'));
    assert.equal(w.run('--skip', real).status, 1, 'a reason is required');
    const s = w.run('--skip', real, 'kept', 'in', 'the', 'team', 'vault');
    assert.equal(s.status, 0, s.stderr);
    const after = JSON.parse(w.run('--json').stdout);
    assert.equal(after.items.find((x) => x.title === 'gutcheck: home ~/.aws/credentials').status, 'skipped');
    const rec = fs.readFileSync(path.join(w.data, 'secret-backups.json'), 'utf8');
    assert.match(rec, /kept in the team vault/);
  } finally { w.cleanup(); }
});

test('report: same-named nested repos each get their own secret step; a one-repo report skips the home scan', async () => {
  const { createEngine } = require('../src/engine');
  const { isolatedEnv } = require('./helpers/env');
  const root = tmp('gutcheck-secnest-');
  const data = tmp('gutcheck-secnestdata-');
  try {
    for (const side of ['a', 'b']) {
      const d = path.join(root, side, 'api');
      fs.mkdirSync(d, { recursive: true });
      sh(d, 'init', '-q', '-b', 'main');
      sh(d, 'config', 'user.email', 't@t');
      sh(d, 'config', 'user.name', 't');
      sh(d, 'commit', '-q', '--allow-empty', '-m', 'init');
      fs.writeFileSync(path.join(d, `.env.${side}`), 'K=nest-hunter5\n');
    }
    const env = isolatedEnv({ GUTCHECK_DATA_DIR: data });
    fs.mkdirSync(path.join(env.HOME, '.aws'));
    fs.writeFileSync(path.join(env.HOME, '.aws', 'credentials'), '[default]\nk=v\n');
    const e = createEngine({ env, via: 'cli' });
    assert.ok((await e.scan({ root })).ok);
    const titles = (await e.secrets()).items.map((x) => x.title).sort();
    assert.deepEqual(titles, ['gutcheck: home ~/.aws/credentials', 'gutcheck: repo a/api/.env.a', 'gutcheck: repo b/api/.env.b']);
    const md = (await e.report()).text;
    const sections = md.split(/^### api$/m).slice(1);
    assert.equal(sections.length, 2);
    // No password manager linked: each repo's step says to link one, never to run the backup yet.
    assert.ok(sections.every((s) => /Secrets > Password manager/.test(s.split(/^## /m)[0]) && !/gutcheck secrets --backup/.test(s.split(/^## /m)[0])), 'each repo section has its own step');
    assert.ok(!sections.some((s) => s.split(/^## /m)[0].includes('.env.a') && s.split(/^## /m)[0].includes('.env.b')), 'no mixing');
    assert.match(md, /Workspace-level tidy-up[\s\S]*~\/\.aws\/credentials/);
    const one = (await e.report({ repo: path.join(root, 'a', 'api') })).text;
    assert.match(one, /\.env\.a/);
    assert.ok(!one.includes('.aws'));
    assert.ok(!md.includes('hunter5') && !one.includes('hunter5'));
  } finally { for (const d of [root, data]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('cli: --backup shows a dropped file as a skipped: line, and --backup --yes exits 2 when one was left out', () => {
  const w = setup();
  try {
    const bin = path.join(w.home, 'bin');
    fs.mkdirSync(bin);
    // A fake pass-cli: signed in, and every create prints an item id.
    fs.writeFileSync(path.join(bin, 'pass-cli'), '#!/bin/sh\ncat >/dev/null\nif [ "$1" = info ]; then echo \'{"id":"u"}\'; else echo ID_' + 'x'.repeat(30) + '; fi\n', { mode: 0o755 });
    w.env.PATH = `${bin}:${process.env.PATH}`;
    fs.writeFileSync(path.join(w.data, 'settings.json'), JSON.stringify({ vault: { tool: 'proton', target: 'Dev' } }));
    // Another file, still on disk, already owns alpha's title.
    const other = path.join(w.home, 'elsewhere.env');
    fs.writeFileSync(other, 'X=1\n');
    fs.writeFileSync(path.join(w.data, 'secret-backups.json'), JSON.stringify({ version: 1, skipped: {}, entries: {
      [other]: { sha256: 'x', tool: 'proton', target: 'Dev', itemId: 'ID_' + 'y'.repeat(30), key: 'gutcheck: repo alpha/.env', title: 'gutcheck: repo alpha/.env' } } }));
    const p = w.run('--backup');
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^ {2}skipped: repo alpha\/\.env: another file already uses the vault item title gutcheck: repo alpha\/\.env$/m);
    assert.ok(!/\$ .*skipped/.test(p.stdout));
    const y = w.run('--backup', '--yes');
    assert.equal(y.status, 2, y.stdout + y.stderr);
    assert.match(y.stdout, /ok +Back up gutcheck: home ~\/\.aws\/credentials to Proton Pass/);
    assert.match(y.stdout, /Not backed up: 1 file was left out/);
  } finally { w.cleanup(); }
});
