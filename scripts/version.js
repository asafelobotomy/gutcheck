#!/usr/bin/env node
// Versioning for GutCheck. One version lives in package.json, package-lock.json and CHANGELOG.md, and
// CI releases whatever version reaches main (see .github/workflows/build.yml).
//
//   npm run bump -- patch|minor|major|<x.y.z>   move "Unreleased" in CHANGELOG.md to a dated section
//                                               for the new version and update both package files
//   node scripts/version.js notes <x.y.z>       print that version's changelog section (release notes)
//   node scripts/version.js check               fail unless the changelog has the current version

const fs = require('node:fs');
const path = require('node:path');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/;

function next(current, kind) {
  if (SEMVER.test(kind)) return kind;
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`package.json version "${current}" is not x.y.z`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return m[4] ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`; // 1.2.3-rc.1 -> 1.2.3
  throw new Error(`Bump by patch, minor, major or an exact x.y.z, not "${kind}"`);
}

const cmp = (a, b) => { const x = SEMVER.exec(a).slice(1, 4).map(Number); const y = SEMVER.exec(b).slice(1, 4).map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// The text under "## [<version>]" (or "## [Unreleased]") up to the next "## " heading.
function section(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'i').test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

// Returns the new version. Writes package.json, package-lock.json and CHANGELOG.md in root.
function bump(root, kind, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const file = (f) => path.join(root, f);
  const pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf8'));
  const version = next(pkg.version, kind);
  if (cmp(version, pkg.version) <= 0 && !(kind === 'patch' && pkg.version.includes('-'))) throw new Error(`${version} is not newer than ${pkg.version}`);
  const log = fs.readFileSync(file('CHANGELOG.md'), 'utf8');
  const unreleased = section(log, 'Unreleased');
  if (unreleased == null) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  if (!unreleased) throw new Error('Nothing under "## [Unreleased]" in CHANGELOG.md: say what changed first');
  let updated = log.replace(/^## \[Unreleased\][^\n]*\n[\s\S]*?(?=^## |^\[Unreleased\]:|(?![\s\S]))/m, `## [Unreleased]\n\n## [${version}] - ${today}\n\n${unreleased}\n\n`);
  // Compare links at the bottom: Unreleased now starts at the new tag.
  updated = updated.replace(/^\[Unreleased\]: (\S+)\/compare\/(\S+)\.\.\.HEAD$/m, (all, base, from) => `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/${from}...v${version}`);
  // package.json and the lockfile keep their formatting: only the version strings change.
  const setPkg = (text) => text.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
  const lockText = fs.readFileSync(file('package-lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  let n = 0;
  const newLock = lockText.replace(/("version":\s*")[^"]+(")/g, (all, a, b) => (n++ < 2 ? `${a}${version}${b}` : all)); // top level, then packages[""]
  const parsed = JSON.parse(newLock);
  if (parsed.version !== version || parsed.packages[''].version !== version || lock.packages[''].name !== parsed.packages[''].name) throw new Error('Could not update package-lock.json safely');
  fs.writeFileSync(file('package.json'), setPkg(fs.readFileSync(file('package.json'), 'utf8')));
  fs.writeFileSync(file('package-lock.json'), newLock);
  fs.writeFileSync(file('CHANGELOG.md'), updated.replace(/\n{3,}/g, '\n\n'));
  return version;
}

function check(root) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const notes = section(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes) throw new Error(`CHANGELOG.md has no section for ${version}: run "npm run bump" instead of editing the version by hand`);
  return version;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'bump') { const v = bump(root, arg); process.stdout.write(`Bumped to ${v}. Commit, then push to main: CI tags v${v} and publishes the release.\n`); }
    else if (cmd === 'notes') { const s = section(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), String(arg || '').replace(/^v/, '')); if (!s) throw new Error(`No changelog section for ${arg}`); process.stdout.write(s + '\n'); }
    else if (cmd === 'check') process.stdout.write(`CHANGELOG.md has ${check(root)}\n`);
    else throw new Error('Usage: version.js bump <patch|minor|major|x.y.z> | notes <x.y.z> | check');
  } catch (e) { process.stderr.write(`version: ${e.message}\n`); process.exitCode = 1; }
}

module.exports = { next, section, bump, check };
