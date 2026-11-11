// Clutter rules: which folders and files count as clutter, and how build output is recognised.
// Data and small helpers only; clutter.js does the scanning.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { run } = require('./exec');
const { COMMAND_TIMEOUT_MS } = require('./util');

// Regenerable folders. `sure`: the name alone is unambiguous, so high confidence even when not ignored.
const CACHE_DIRS = {
  __pycache__: { category: 'cache', reason: 'Python bytecode cache', ignoreAs: '__pycache__/', sure: true },
  '.pytest_cache': { category: 'cache', reason: 'pytest cache', ignoreAs: '.pytest_cache/', sure: true },
  '.mypy_cache': { category: 'cache', reason: 'mypy cache', ignoreAs: '.mypy_cache/', sure: true },
  '.ruff_cache': { category: 'cache', reason: 'ruff cache', ignoreAs: '.ruff_cache/', sure: true },
  '.tox': { category: 'cache', reason: 'tox environments', ignoreAs: '.tox/', sure: true },
  '.parcel-cache': { category: 'cache', reason: 'Parcel cache', ignoreAs: '.parcel-cache/', sure: true },
  '.turbo': { category: 'cache', reason: 'Turborepo cache', ignoreAs: '.turbo/', sure: true },
  '.sass-cache': { category: 'cache', reason: 'Sass cache', ignoreAs: '.sass-cache/', sure: true },
  '.nyc_output': { category: 'test-artifact', reason: 'nyc coverage data', ignoreAs: '.nyc_output/', sure: true },
  htmlcov: { category: 'test-artifact', reason: 'Python coverage HTML report', ignoreAs: 'htmlcov/', sure: false },
  coverage: { category: 'test-artifact', reason: 'Test coverage report', ignoreAs: 'coverage/', sure: false },
  'test-results': { category: 'test-artifact', reason: 'Test runner output', ignoreAs: 'test-results/', sure: false },
  'playwright-report': { category: 'test-artifact', reason: 'Playwright report', ignoreAs: 'playwright-report/', sure: false },
};

// First match wins. `base` derives the name of the file this one is a leftover copy of.
// `ignoreAs` must match every name `re` matches (gitignore is case-sensitive), otherwise adding the
// suggested rule would never clear the "not in .gitignore" advice.
const FILE_RULES = [
  { re: /^\.DS_Store$/, category: 'junk', reason: 'macOS folder metadata', confidence: 'high', ignoreAs: '.DS_Store' },
  { re: /^Thumbs\.db$/, category: 'junk', reason: 'Windows thumbnail cache', confidence: 'high', ignoreAs: 'Thumbs.db' },
  { re: /^desktop\.ini$/, category: 'junk', reason: 'Windows folder metadata', confidence: 'high', ignoreAs: 'desktop.ini' },
  { re: /^\._./, category: 'junk', reason: 'macOS resource-fork file', confidence: 'medium', ignoreAs: '._*', base: (n) => n.slice(2), highWithBase: true },
  { re: /\.sw[a-p]$/, category: 'junk', reason: 'Editor swap file (may hold unsaved edits)', confidence: 'medium', ignoreAs: '*.sw[a-p]' },
  { re: /~$/, category: 'backup', reason: 'Editor backup file', confidence: 'medium', ignoreAs: '*~', base: (n) => n.slice(0, -1) },
  { re: /^\.#./, category: 'junk', reason: 'Emacs lock file', confidence: 'medium', ignoreAs: '.#*' },
  { re: /^#.+#$/, category: 'junk', reason: 'Emacs autosave file', confidence: 'medium', ignoreAs: '#*#' },
  { re: /^~\$./, category: 'junk', reason: 'Office lock file', confidence: 'medium', ignoreAs: null },
  { re: /\.tmp$/, category: 'temp', reason: 'Temporary file', confidence: 'medium', ignoreAs: '*.tmp' },
  { re: /\.temp$/, category: 'temp', reason: 'Temporary file', confidence: 'medium', ignoreAs: '*.temp' },
  { re: /\.orig$/, category: 'backup', reason: 'Leftover from a merge or patch', confidence: 'medium', ignoreAs: '*.orig', base: (n) => n.replace(/\.orig$/, '') },
  { re: /\.rej$/, category: 'backup', reason: 'Rejected patch hunk', confidence: 'medium', ignoreAs: '*.rej', base: (n) => n.replace(/\.rej$/, '') },
  { re: /\.bak$/, category: 'backup', reason: 'Backup copy', confidence: 'medium', ignoreAs: '*.bak', base: (n) => n.replace(/\.bak$/, '') },
  { re: /\.(old|backup)$/i, category: 'backup', reason: 'Backup copy', confidence: 'medium', ignoreAs: null, base: (n) => n.replace(/\.(old|backup)$/i, '') },
  ...['npm-debug', 'yarn-debug', 'yarn-error', 'pnpm-debug', 'lerna-debug'].map((n) => ({ re: new RegExp(`^${n}\\.log`), category: 'log', reason: 'Package manager crash log', confidence: 'high', ignoreAs: `${n}.log*` })),
  { re: /\.log$/i, category: 'log', reason: 'Log file', confidence: 'low', ignoreAs: '*.log' },
  { re: /^\.(eslint|stylelint)cache$/, category: 'cache', reason: 'Linter cache', confidence: 'high', regenerable: true, ignoreAs: null },
  { re: /^\.coverage$/, category: 'test-artifact', reason: 'Python coverage data', confidence: 'high', regenerable: true, ignoreAs: '.coverage' },
  { re: /\.pyc$/, category: 'cache', reason: 'Stray Python bytecode', confidence: 'high', regenerable: true, ignoreAs: '*.pyc' },
];
// Build output and test temp folders: regenerable, often gigabytes, and slow to rebuild, so they are
// listed (with their real size) but never pre-selected. CACHEDIR.TAG is the Cache Directory Tagging
// spec's marker for "this folder is a cache, safe to delete" (cargo writes it into target/).
const VENV_NAMES = new Set(['.venv', 'venv', 'env', '.env']);
const CACHEDIR_SIG = 'Signature: 8a477f597d28d172789f06886806bc55';
const BUILDER_MARKERS = ['builder-debug.yml', 'builder-effective-config.yaml', 'linux-unpacked', 'win-unpacked', 'mac'];
async function buildOutput(abs, name, parentFiles, parentName) {
  const has = async (f) => { try { await fsp.access(path.join(abs, f)); return true; } catch { return false; } };
  let tag = '';
  try { tag = (await fsp.readFile(path.join(abs, 'CACHEDIR.TAG'), 'utf8')).slice(0, 60); } catch {}
  const rust = name === 'target' && parentFiles.has('Cargo.toml');
  if (tag.startsWith(CACHEDIR_SIG)) return { reason: rust ? 'Rust build output (cargo, tagged as a cache)' : 'Cache folder (tagged CACHEDIR.TAG)', sure: true, ignoreAs: rust ? 'target/' : null, rebuild: rust ? 'cargo build' : 'the tool that made it' };
  if (rust) return { reason: 'Rust build output (cargo)', sure: true, ignoreAs: 'target/', rebuild: 'cargo build' };
  if (/^\.?te?mp$/i.test(parentName) && (name === 'pytest' || /^pytest-of-/.test(name) || (/^pytest-./.test(name) && await looksPytestTemp(abs)))) return { reason: 'pytest temporary folders', sure: false, ignoreAs: null, rebuild: 'the next test run', testTemp: 'pytest' };
  if ((name === 'dist' || name === 'build') && (await Promise.all(BUILDER_MARKERS.map(has))).some(Boolean)) return { reason: 'electron-builder output (packaged app builds)', sure: false, ignoreAs: null, rebuild: 'the next package build' };
  return null;
}
// A --basetemp folder with another name (pytest-main): pytest names each test's folder after the
// test plus a number (test_login0, library-template0), and xdist workers get popen-gw0, popen-gw1.
async function looksPytestTemp(abs) {
  let ents = [];
  try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch {}
  return ents.some((e) => e.isDirectory() && /^(popen-gw\d+|[\w.-]+\d+)$/.test(e.name));
}
// Real size of a big folder: du is far faster than walking it, and a capped walk would under-count.
async function bigDirSize(p) {
  const r = await run('du', ['-sk', '--', p], { timeout: COMMAND_TIMEOUT_MS });
  return r.ok ? (Number(r.stdout.split('\t')[0]) || 0) * 1024 : dirSize(p);
}

const STALE_LOG_DAYS = 14; // an ignored log or temp file untouched this long is stale
const STALE_BACKUP_DAYS = 30; // backups get longer: they may be the only copy of something
const SCRATCH_DIR_RE = /(^|\/)\.?(tmp|temp|scratch)\//i;

async function dirSize(p, budget = { n: 20000 }) {
  let total = 0;
  let ents;
  try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    if (budget.n-- <= 0) return total;
    if (e.isSymbolicLink()) continue;
    const c = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(c, budget);
    else { try { total += (await fsp.lstat(c)).size; } catch {} }
  }
  return total;
}

// A committed "<name>.env" can be plain config (a version pin a script sources). It counts as
// config only when no key name or value looks like a credential; only key names are matched, and
// values only for "://user:pass@". Nothing read here is returned. A dotfile .env is never config.
const CRED_KEY_RE = /secret|token|passw|passwd|pwd|pass$|api_?key|private|credential|auth|(^|_)key$|dsn|session|cookie|salt|signing|webhook|database_url|conn(ection)?_?str/i;
async function envIsConfigOnly(file) {
  if (path.basename(file).startsWith('.')) return false;
  let text;
  try { const st = await fsp.lstat(file); if (!st.isFile() || st.size > 64 * 1024) return false; text = await fsp.readFile(file, 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && (CRED_KEY_RE.test(m[1]) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(m[2]))) return false;
  }
  return true;
}

// The shared git dir of a checkout: a linked worktree (".git" is a "gitdir:" file whose folder has
// a "commondir") resolves to its main repo's, so two worktrees of one repo are not two clones.
async function gitCommonDir(dir) {
  const dotgit = path.join(dir, '.git');
  let text;
  try { text = await fsp.readFile(dotgit, 'utf8'); } catch { return dotgit; } // a folder, or no .git
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return dotgit;
  const gd = path.resolve(dir, m[1]);
  try { return path.resolve(gd, (await fsp.readFile(path.join(gd, 'commondir'), 'utf8')).trim()); } catch { return gd; }
}

module.exports = { CACHE_DIRS, FILE_RULES, VENV_NAMES, buildOutput, bigDirSize, dirSize, STALE_LOG_DAYS, STALE_BACKUP_DAYS, SCRATCH_DIR_RE, envIsConfigOnly, gitCommonDir };
