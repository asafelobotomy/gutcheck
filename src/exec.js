const { execFile } = require('node:child_process');

// Run a command without a shell. Resolves { ok, stdout, stderr } and never rejects.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout || 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') })
    );
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
// to execute (core.fsmonitor, hooks), so read-only git calls disable both and never take the
// index lock (so a scan cannot interfere with the user's own git commands).
const READONLY_GIT = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const git = (args, opts) => run('git', [...READONLY_GIT, ...args], opts);
// For user-initiated writes (push/pull): hooks are the user's own, but still no fsmonitor.
const gitWrite = (args, opts) => run('git', ['-c', 'core.fsmonitor=false', ...args], opts);

module.exports = { run, json, git, gitWrite };
