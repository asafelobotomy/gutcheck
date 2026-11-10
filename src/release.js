// Release health: the newest version tag, how much has landed since it, whether the manifest's version
// agrees with it, and whether the changelog mentions it. Read-only: git tags and manifest text.

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./exec');
const { cmpVersion, daysAgo } = require('./util');

const VERSION_TAG = /^v?(\d+\.\d+\.\d+)$/; // plain releases only: v1.2.3 or 1.2.3, no pre-releases
const UNRELEASED_MIN_COMMITS = 5;
const UNRELEASED_MIN_DAYS = 90;
const read = (f) => { try { return fs.readFileSync(f, 'utf8').slice(0, 512 * 1024); } catch { return null; } };

// The `version = "..."` inside the first of the named TOML tables; null when absent (a workspace-inherited
// `version.workspace = true` or a `dynamic` version has no such line).
function tomlVersion(text, names) {
  if (!text) return null;
  let inside = false;
  for (const l of text.split('\n')) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(l);
    if (h) { inside = names.includes(h[1].trim()); continue; }
    const m = inside && /^\s*version\s*=\s*["']([^"']+)["']/.exec(l);
    if (m) return m[1];
  }
  return null;
}

// The version a root manifest declares: package.json, Cargo.toml [package] or pyproject [project]/[tool.poetry].
function manifestVersion(dir) {
  try { const p = JSON.parse(read(path.join(dir, 'package.json')) || 'null'); if (p && typeof p.version === 'string') return { file: 'package.json', version: p.version }; } catch {}
  const cargo = tomlVersion(read(path.join(dir, 'Cargo.toml')), ['package']);
  if (cargo) return { file: 'Cargo.toml', version: cargo };
  const py = tomlVersion(read(path.join(dir, 'pyproject.toml')), ['project', 'tool.poetry']);
  if (py) return { file: 'pyproject.toml', version: py };
  return null;
}

function changelogText(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  const n = names.find((x) => /^(changelog|changes|history|news)(\.(md|markdown|txt|rst))?$/i.test(x));
  return n ? { file: n, text: read(path.join(dir, n)) || '' } : null;
}

async function collectRelease(dir) {
  const t = await git(['tag', '--list'], { cwd: dir });
  const tags = t.stdout.split('\n').map((x) => x.trim()).filter((x) => VERSION_TAG.test(x));
  const manifest = manifestVersion(dir);
  const vAll = t.stdout.split('\n').map((x) => x.trim()).filter((x) => /^v\S*$/.test(x)); // any v* tag: what a tag ruleset covers
  const vTag = vAll[0] || null;
  const vTags = vAll.length;
  if (!tags.length) return { latest: null, manifest, vTag, vTags };
  const latest = tags.sort((a, b) => cmpVersion(a.replace(/^v/, ''), b.replace(/^v/, ''))).pop();
  const [since, date] = await Promise.all([
    git(['rev-list', '--count', `refs/tags/${latest}..HEAD`], { cwd: dir }),
    git(['log', '-1', '--format=%cI', `refs/tags/${latest}`], { cwd: dir }),
  ]);
  const cl = changelogText(dir);
  const ver = latest.replace(/^v/, '');
  const esc = ver.replace(/\./g, '\\.');
  return {
    latest, version: ver, vTag, vTags,
    commitsSince: since.ok ? Number(since.stdout.trim()) || 0 : null,
    taggedAt: date.ok ? date.stdout.trim() : null,
    manifest,
    // Only a versioned changelog (one that names at least one release) is expected to name this one.
    changelog: cl ? { file: cl.file, versioned: /\b\d+\.\d+\.\d+\b/.test(cl.text), mentions: new RegExp(`(^|[^\\d.])v?${esc}(?![\\d])`, 'm').test(cl.text) } : null,
  };
}

function checkRelease(s) {
  const r = s.release;
  if (!r || !r.latest || (s.files && s.files.aurPackage)) return [];
  const out = [];
  const add = (id, severity, title, detail) => out.push({ id, category: 'Releases', severity, title, detail });
  const m = r.manifest;
  // GitHub's latest release counts as released too: tags made by CI may not be fetched here yet.
  const remoteTag = s.remote && s.remote.latestRelease;
  const newest = remoteTag && VERSION_TAG.test(remoteTag) && cmpVersion(remoteTag.replace(/^v/, ''), r.version) > 0 ? remoteTag.replace(/^v/, '') : r.version;
  if (m && /^\d+\.\d+\.\d+$/.test(m.version)) {
    const c = cmpVersion(m.version, newest);
    if (c < 0) add('release-version-behind', 'warn', `${m.file} says ${m.version}, but ${newest} is already released`, `The next release would reuse or go backwards from an old version number. Bump ${m.file} past ${newest}.`);
    else if (c > 0 && s.git && !s.git.ahead && !s.git.dirty) add('release-untagged', 'info', `Version ${m.version} is not tagged yet`, `${m.file} is at ${m.version}, the newest tag is ${newest}. If CI tags releases, check that its last run succeeded; otherwise tag and publish ${m.version}.`);
  }
  const age = daysAgo(r.taggedAt);
  if (r.commitsSince >= UNRELEASED_MIN_COMMITS && age != null && age >= UNRELEASED_MIN_DAYS && newest === r.version)
    add('release-unreleased', 'info', `${r.commitsSince} commits since ${r.latest} (${age} days ago)`, 'Users of the released version are missing these changes. Cut a release, or say in the README that releases are not kept up to date.');
  if (r.changelog && r.changelog.versioned && !r.changelog.mentions)
    add('changelog-stale', 'info', `${r.changelog.file} does not mention ${r.latest}`, `The newest release is missing from the changelog. Add a section for ${r.version}.`);
  return out;
}

module.exports = { collectRelease, checkRelease, manifestVersion, tomlVersion, VERSION_TAG };
