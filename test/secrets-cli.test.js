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
    assert.equal(by['gutcheck: alpha/.env'].status, 'unbacked');
    assert.equal(by['gutcheck: ~/.aws/credentials'].status, 'unbacked');
    assert.equal(by['gutcheck: ~/.gnupg/private-keys-v1.d'].saveable, false, 'a folder cannot be saved as one item');

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
    assert.equal(after.items.find((x) => x.title === 'gutcheck: ~/.aws/credentials').status, 'skipped');
    const rec = fs.readFileSync(path.join(w.data, 'secret-backups.json'), 'utf8');
    assert.match(rec, /kept in the team vault/);
  } finally { w.cleanup(); }
});
