// Shared set-up for the secrets controller tests: fake run, temp dataDir, temp repo, fake bins on a temp PATH.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SECRET = 'API_KEY=hunter2-unique-marker';

const { execFileSync } = require('node:child_process');
const { createSettingsStore } = require('../../src/settings');

const OK_ID = 'ID_' + 'x'.repeat(30);
function setup({ binInRepo = false } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vctl-')));
  const dataDir = path.join(tmp, 'data'), home = path.join(tmp, 'home'), wsRoot = path.join(tmp, 'ws');
  const repo = path.join(wsRoot, 'api');
  for (const d of [dataDir, home, repo]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  const envPath = path.join(repo, '.env');
  fs.writeFileSync(envPath, SECRET + '\nOTHER=plain\n');
  const binDir = binInRepo ? path.join(repo, 'bin') : path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const b of ['pass-cli', 'pass', 'keepassxc-cli', 'bw']) fs.writeFileSync(path.join(binDir, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const ws = { repos: [{ path: repo, name: 'api' }], root: wsRoot };
  const env = { PATH: binDir, HOME: home, PASSWORD_STORE_DIR: path.join(home, '.password-store') };
  const mkCtl = (o = {}) => require('../../src/secrets-ctl').createSecretsCtl({
    dataDir, settings: createSettingsStore(path.join(dataDir, 'settings.json')), env, home, ...o });
  const record = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'secret-backups.json'), 'utf8'));
  return { tmp, dataDir, home, repo, envPath, ws, env, mkCtl, record };
}
const STATUS_OK = { ok: true, code: 0, stdout: '{"id":"u"}', stderr: '' };
// Answers the status call (pass-cli info) as signed in; records only save calls.
const okRun = (calls = []) => async (cmd, args, o) => {
  if (args[0] === 'info') return STATUS_OK;
  calls.push({ cmd, args, input: String(o.input), opts: o });
  return { ok: true, code: 0, stdout: OK_ID + '\n', stderr: '' };
};

module.exports = { SECRET, OK_ID, STATUS_OK, setup, okRun };
