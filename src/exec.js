const { execFile } = require('node:child_process');

// Run a command without a shell. Resolves { ok, stdout, stderr } and never rejects.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout || 30000, maxBuffer: opts.maxBuffer || 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } },
      (err, stdout, stderr) => resolve({ ok: !err, code: !err ? 0 : typeof err.code === 'number' ? err.code : null, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') })
    );
    // Optional stdin (used to send JSON bodies to `gh api --input -` without touching disk or the shell).
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input != null ? opts.input : undefined);
    }
  });
}

async function json(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (!r.ok) return { ok: false, error: r.stderr.trim(), data: null };
  try {
    return { ok: true, data: JSON.parse(r.stdout || 'null') };
  } catch {
    return { ok: false, error: 'invalid JSON from ' + cmd, data: null };
  }
}

// Scanning opens repos we did not necessarily write. A repo's own .git/config can name programs
// to execute, so read-only git calls switch off the ones a fixed -c can reach: fsmonitor, hooks,
// signature checks (log.showSignature runs gpg.program), and the ext:: and fd:: transports. They
// never take the index lock, so a scan cannot interfere with the user's own git commands.
const READONLY_GIT = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'log.showSignature=false', '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false',
  '-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never',
];

const { driverOverrides } = require('./git-drivers')(run, READONLY_GIT);

// Every scan git call. Filter and diff drivers are named per repo, so they are read first (from a
// short cache) and the repo-local ones are blanked; if that lookup fails the call is refused.
async function git(args, opts = {}) {
  let extra;
  try {
    extra = await driverOverrides(opts.cwd || process.cwd(), opts.env);
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: `GutCheck refused to run git here: ${e.message}` };
  }
  return run('git', [...READONLY_GIT, ...extra, ...args], opts);
}

module.exports = { run, json, git, READONLY_GIT };
