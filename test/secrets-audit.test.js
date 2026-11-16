// Secrets backup hardening from the 2026-11-16 audit (A4, A5, A7, A8, A9, A12, A14).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setup } = require('./helpers/vault-ctl');
const { ADAPTERS } = require('../src/vault-adapters');
const S = require('../src/secrets');
const { scrub } = require('../src/secrets-io');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const sh = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
const bwRun = (save) => async (cmd, args, o) => {
  if (args[0] === 'status') return { ok: true, code: 0, stdout: '{"status":"unlocked"}', stderr: '' };
  if (args[0] === 'create') return save(args, o);
  return { ok: true, code: 0, stdout: '[]', stderr: '' };
};

test('A4: a committed link into .git does not make git\'s own config a secret to back up', async () => {
  const d = tmp('gutcheck-a4-');
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'remote.origin.url', 'https://user:tok3n-in-config@example.invalid/x.git');
  fs.symlinkSync('.git/config', path.join(d, '.env'));
  fs.writeFileSync(path.join(d, '.env.local'), 'A=real-secret-here\n');
  fs.writeFileSync(path.join(d, '.gitignore'), '.env.local\n');
  const found = await S.findRepoSecrets(d, { name: 'r' });
  assert.deepEqual(found.map((c) => c.rel), ['.env.local']);
  assert.ok(!found.some((c) => c.real.includes(`${path.sep}.git${path.sep}`)));
});

test('A14: a repo with thousands of secret-looking files is checked up to a limit, and says so', async () => {
  const d = tmp('gutcheck-a14-');
  sh(d, 'init', '-q', '-b', 'main');
  for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(d, `.env.${i}`), `K=${i}\n`);
  const problems = [];
  const found = await S.findRepoSecrets(d, { name: 'big', problems });
  assert.equal(found.length, 500);
  assert.equal(problems.length, 1);
  assert.match(problems[0].error, /first 500 secret-looking files in big/);
});

test('A7: a config folder outside the home folder is named xdg-config/…, never ~/../…', async () => {
  const home = tmp('gutcheck-a7home-');
  const xdg = tmp('gutcheck-a7xdg-');
  fs.mkdirSync(path.join(xdg, 'gcloud'));
  fs.writeFileSync(path.join(xdg, 'gcloud', 'application_default_credentials.json'), '{"client_secret":"abc"}');
  const found = await S.findHomeSecrets({ home, env: { XDG_CONFIG_HOME: xdg } });
  assert.deepEqual(found.map((c) => c.rel), ['xdg-config/gcloud/application_default_credentials.json']);
  assert.ok(!found[0].title.includes('..'));
});

test('A5: a secret echoed back JSON-escaped or percent-encoded is scrubbed from the error text', () => {
  const secret = 'pässword "quoted" value\twith tab';
  const json = JSON.stringify(secret).slice(1, -1);
  const ascii = json.replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const out = scrub(`error: bad item\nnotes: "${json}"\nraw: ${ascii}\nurl: ?n=${encodeURIComponent(secret)}\nexit 1`, Buffer.from(secret));
  assert.equal(out, 'error: bad item\nexit 1');
});

test('A8: a file whose name starts with "-" cannot be read as a KeePassXC option', () => {
  const s = ADAPTERS.keepassxc.saveCmd({ title: 'gutcheck: repo api/--key-file=x.pem', rel: '--key-file=x.pem', size: 3 }, { db: '/d.kdbx', keyFile: '/k', group: 'gutcheck' });
  const imp = s.steps[1].args;
  assert.equal(imp[imp.length - 2], '__key-file=x.pem');
  assert.ok(!imp.slice(5).some((a) => a.startsWith('-')), imp.join(' '));
});

test('A9: a file too large for a Bitwarden note is left out and the rest are planned; one failed save does not stop the others', async () => {
  const { repo, envPath, ws, mkCtl, record } = setup();
  const big = path.join(repo, '.env.big');
  const third = path.join(repo, '.env.prod');
  fs.writeFileSync(big, 'K=' + 'x'.repeat(12000) + '\n');
  fs.writeFileSync(third, 'P=third-file-secret\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env*\n');
  let n = 0;
  const ctl = mkCtl({ run: bwRun(() => (++n === 1 ? { ok: false, code: 1, stdout: '', stderr: 'server said no' } : { ok: true, code: 0, stdout: `{"id":"bw-${n}"}`, stderr: '' })) });
  ctl.link({ tool: 'bitwarden', target: '' });
  const p = await ctl.plan([envPath, big, third], { via: 'app', ...ws });
  assert.ok(p.ok, p.error);
  assert.equal(p.skipped, 1);
  assert.ok(p.warnings.some((w) => /^skipped: .*\.env\.big: Bitwarden notes are limited/.test(w)), p.warnings.join('\n'));
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.results.map((x) => x.ok), [false, true], 'the second file was still saved');
  assert.equal(Object.keys(record().entries).length, 1);
});

test('A12: an item id that is the file\'s own content is refused and never recorded', async () => {
  const { envPath, ws, mkCtl, dataDir } = setup();
  const ctl = mkCtl({ run: bwRun(() => ({ ok: true, code: 0, stdout: JSON.stringify({ id: 'hunter2-unique-marker' }), stderr: '' })) });
  ctl.link({ tool: 'bitwarden', target: '' });
  const p = await ctl.plan([envPath], { via: 'app', ...ws });
  assert.ok(p.ok, p.error);
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.equal(r.ok, false);
  assert.match(r.results[0].out, /does not trust/);
  const rec = path.join(dataDir, 'secret-backups.json');
  assert.ok(!fs.existsSync(rec) || !fs.readFileSync(rec, 'utf8').includes('hunter2'));
});
