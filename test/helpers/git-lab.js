// Throwaway git repos for the scan-safety tests. Requiring this file gives the test process a
// private HOME and global git config (and no system config), so every child git uses them and
// the developer's own config plays no part. A "marker" program proves a program ran.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-lab-'));
const HOME = path.join(ROOT, 'home');
const GLOBAL = path.join(ROOT, 'gitconfig');
fs.mkdirSync(HOME);
fs.writeFileSync(GLOBAL, '[protocol "file"]\n\tallow = always\n');
Object.assign(process.env, { HOME, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch {} });

let n = 0;
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const sh = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const fresh = (name = 'repo') => path.join(ROOT, `${name}${++n}`);

function repo(files, name) {
  const d = fresh(name);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@t');
  sh(d, 'config', 'user.name', 't');
  for (const [rel, text] of Object.entries(files)) put(d, rel, text);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'init');
  return d;
}

// A program that leaves a marker when it runs; `body` runs after the marker is written.
function marker(body = 'cat') {
  const m = path.join(ROOT, `marker${++n}`);
  const prog = path.join(ROOT, `prog${n}.sh`);
  fs.writeFileSync(prog, `#!/bin/sh\necho ran >> '${m}'\n${body}\n`, { mode: 0o755 });
  return { prog, ran: () => fs.existsSync(m), reset: () => fs.rmSync(m, { force: true }) };
}

// Change a file's mtime so git must re-read it (and run its clean filter) to know it is unchanged.
const statDirty = (d, rel) => { const t = new Date(Date.now() - 86400000 * (++n)); fs.utimesSync(path.join(d, rel), t, t); };

module.exports = { ROOT, HOME, GLOBAL, put, sh, fresh, repo, marker, statDirty };
