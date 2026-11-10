// Lockfile and manifest drift, from files only (nothing runs):
//  - package-lock.json's root entry against package.json (name, version, dependency specifiers);
//  - the version fields of one project's manifests: package.json, src-tauri/tauri.conf.json (Tauri 2
//    `version`, or Tauri 1 `package.version`), Cargo.toml [package] and pyproject.toml [project];
//  - a Rust binary crate whose Cargo.lock is not tracked by git.
// Specifier values are never put in findings (a git URL may carry a token), only dependency names.

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./exec');
const { tomlVersion } = require('./release');
const { list } = require('./util');

const MAX_BYTES = 8 * 1024 * 1024; // lockfiles are large; this is only a guard against absurd files
const read = (dir, rel, max = MAX_BYTES) => {
  try {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    return st.isFile() && st.size <= max ? fs.readFileSync(abs, 'utf8') : null;
  } catch { return null; }
};
const json = (dir, rel) => { try { const v = JSON.parse(read(dir, rel) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const core = (v) => (/^v?(\d+\.\d+\.\d+)/.exec(String(v)) || [])[1] || null; // 1.2.3-rc.1 and 1.2.3rc1 both compare as 1.2.3
const SPEC_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function lockDrift(dir) {
  const pkg = json(dir, 'package.json');
  const lock = json(dir, 'package-lock.json');
  const root = lock && lock.packages && lock.packages[''];
  if (!pkg || !root) return null; // lockfileVersion 1 has no root entry to compare
  const problems = [];
  let deps = false;
  if (typeof pkg.name === 'string' && typeof root.name === 'string' && pkg.name !== root.name) problems.push(`name ${pkg.name} vs ${root.name}`);
  if (typeof pkg.version === 'string' && typeof root.version === 'string' && pkg.version !== root.version) problems.push(`version ${pkg.version} vs ${root.version}`);
  const names = new Set();
  for (const f of SPEC_FIELDS) {
    const a = (pkg[f] && typeof pkg[f] === 'object') ? pkg[f] : {};
    const b = (root[f] && typeof root[f] === 'object') ? root[f] : {};
    for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[n] !== b[n]) names.add(n);
  }
  if (names.size) { deps = true; problems.push(`dependencies that differ: ${list([...names].sort(), 8)}`); }
  return problems.length ? { file: 'package-lock.json', problems, deps } : { file: 'package-lock.json', problems: [], deps: false };
}

function versionSources(dir) {
  const pkg = json(dir, 'package.json');
  const tauriDir = ['src-tauri', ''].find((d) => read(dir, path.posix.join(d, 'tauri.conf.json'), 1 << 20) != null);
  const tauriCargo = read(dir, 'src-tauri/Cargo.toml', 1 << 20) != null;
  const isTauri = tauriDir != null || tauriCargo;
  const out = [];
  if (pkg && typeof pkg.version === 'string' && (!pkg.private || isTauri)) out.push({ file: 'package.json', version: pkg.version });
  if (tauriDir != null) {
    const file = path.posix.join(tauriDir, 'tauri.conf.json');
    const c = json(dir, file);
    const v = c && (typeof c.version === 'string' ? c.version : c.package && typeof c.package.version === 'string' ? c.package.version : null);
    if (v && core(v)) out.push({ file, version: v }); // "../package.json" and other paths are not versions
  }
  for (const f of ['Cargo.toml', 'src-tauri/Cargo.toml']) {
    const v = tomlVersion(read(dir, f, 1 << 20), ['package']); // version.workspace = true has no such line
    if (v) out.push({ file: f, version: v });
  }
  const py = tomlVersion(read(dir, 'pyproject.toml', 1 << 20), ['project', 'tool.poetry']); // dynamic = ["version"] has none either
  if (py) out.push({ file: 'pyproject.toml', version: py });
  return out.filter((x) => core(x.version));
}

// Binary crates only: a library's lock is for its own tests, and the default for `cargo new` is to track it anyway.
async function cargoLocks(dir) {
  const out = [];
  for (const d of ['', 'src-tauri']) {
    const toml = read(dir, path.posix.join(d, 'Cargo.toml'), 1 << 20);
    if (!toml || !/^\s*\[package\]/m.test(toml)) continue;
    const binary = /^\s*\[\[bin\]\]/m.test(toml) || read(dir, path.posix.join(d, 'src/main.rs'), 1 << 20) != null;
    if (!binary) continue;
    const lock = path.posix.join(d, 'Cargo.lock');
    if (read(dir, lock, MAX_BYTES) == null) continue; // none at all: the no-lock-Cargo.toml finding covers it
    const tracked = await git(['ls-files', '--cached', '-z', '--', lock], { cwd: dir });
    if (tracked.ok && !tracked.stdout.includes(lock)) out.push({ file: lock });
  }
  return out;
}

async function collectDrift(dir) {
  return { lock: lockDrift(dir), versions: versionSources(dir), cargo: await cargoLocks(dir) };
}

function checkDrift(s) {
  const d = s.drift;
  if (!d) return [];
  const out = [];
  const add = (id, severity, title, detail) => out.push({ id, category: 'Project setup', severity, title, detail });
  if (d.lock && d.lock.problems.length) {
    add('lockfile-drift', d.lock.deps ? 'warn' : 'info', 'package-lock.json disagrees with package.json',
      `${d.lock.problems.join('; ')}. ${d.lock.deps ? '`npm ci` refuses to install when the two disagree, so CI can fail.' : 'Installs still work, but the lockfile records a stale name or version.'} Regenerate the lockfile.`);
  }
  const spread = new Set((d.versions || []).map((v) => core(v.version)));
  if (spread.size > 1) add('version-drift', 'warn', 'Version fields disagree across manifests', `${d.versions.map((v) => `${v.file} ${v.version}`).join(', ')}. One project should carry one version, or each build reports a different one.`);
  if ((d.cargo || []).length) add('cargo-lock-untracked', 'info', `${list(d.cargo.map((c) => c.file), 3)} is not tracked by git`, `${list(d.cargo.map((c) => c.file), 3)} belongs to a crate that builds a binary. Cargo tracks Cargo.lock for new projects by default, so builds and CI use the same dependency versions; without it "cargo install" and fresh clones pick the newest compatible versions ("cargo install --locked" uses the lock). Remove it from .gitignore and commit it.`);
  return out;
}

module.exports = { collectDrift, checkDrift };
