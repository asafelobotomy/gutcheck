// How a repo's dependency updates are automated: the Dependabot config (grouping, cooldown), a Renovate
// config, and workflows that auto-merge bot PRs. Read as text, never executed. The point is noise and
// risk: one PR per package floods the PR list, and auto-merging every update (majors included) lets a
// breaking or freshly published malicious release land without review.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 256 * 1024;
const read = (f) => { try { const st = fs.statSync(f); return st.isFile() && st.size <= MAX_BYTES ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
const RENOVATE_FILES = ['renovate.json', 'renovate.json5', '.renovaterc', '.renovaterc.json', '.renovaterc.json5', '.github/renovate.json', '.github/renovate.json5', '.gitlab/renovate.json'];

// dependabot.yml -> [{ eco, dir, groups, cooldown }], one per `updates:` entry. A small line parser:
// entries start at "- package-ecosystem:" and own every line indented deeper than the dash.
function parseDependabot(text) {
  const out = [];
  let cur = null;
  let indent = -1;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const ind = line.length - line.trimStart().length;
    const m = /^(\s*)-\s+package-ecosystem:\s*['"]?([\w-]+)/.exec(line);
    if (m) { cur = { eco: m[2], dir: '/', groups: false, cooldown: false }; indent = m[1].length; out.push(cur); continue; }
    if (!cur) continue;
    if (ind <= indent) { cur = null; continue; }
    const k = /^\s*(directory|directories|groups|cooldown):\s*['"]?([^'"]*)/.exec(line);
    if (!k) continue;
    if (k[1] === 'directory') cur.dir = k[2].trim() || '/';
    else if (k[1] === 'groups') cur.groups = true;
    else if (k[1] === 'cooldown') cur.cooldown = true;
  }
  return out;
}

// A workflow that merges Dependabot or Renovate PRs. Gated when it checks the update type, so majors
// (breaking by SemVer) still wait for a person.
const MERGES = /gh\s+pr\s+merge\b|pascalgn\/automerge-action|ahmadnassri\/action-dependabot-auto-merge|fastify\/github-action-merge-dependabot|peter-evans\/enable-pull-request-automerge/;
const BOT = /dependabot\[bot\]|dependabot\/fetch-metadata|renovate\[bot\]|github\.actor\s*==\s*['"]dependabot/;
const GATE = /version-update:semver-(patch|minor|major)|update-type|target:\s*['"]?(patch|minor)\b|semver-(patch|minor)/;
function auditAutoMerge(text) {
  if (!MERGES.test(text) || !BOT.test(text)) return null;
  return { gated: GATE.test(text) };
}

function auditDepAutomation(dir) {
  const ghDir = path.join(dir, '.github');
  const cfgName = ['dependabot.yml', 'dependabot.yaml'].find((n) => read(path.join(ghDir, n)) != null);
  const dependabot = cfgName ? parseDependabot(read(path.join(ghDir, cfgName))) : null;
  const renovate = RENOVATE_FILES.some((f) => read(path.join(dir, f)) != null) || (() => { try { return !!JSON.parse(read(path.join(dir, 'package.json')) || '{}').renovate; } catch { return false; } })();
  const autoMerge = [];
  let names = [];
  try { names = fs.readdirSync(path.join(ghDir, 'workflows')).filter((n) => /\.ya?ml$/i.test(n)).slice(0, 50); } catch {}
  for (const n of names) {
    const a = auditAutoMerge(read(path.join(ghDir, 'workflows', n)) || '');
    if (a) autoMerge.push({ file: '.github/workflows/' + n, ...a });
  }
  return { dependabot, renovate, autoMerge };
}

// Ecosystems whose updates come one package at a time and benefit from groups (not github-actions,
// docker and the like, which usually have few dependencies).
const MANY_DEPS = new Set(['npm', 'cargo', 'pip', 'uv', 'poetry', 'gomod', 'gradle', 'maven', 'composer', 'bundler', 'nuget', 'pub', 'mix']);
const OPEN_BOT_PRS_NOISY = 5; // this many open Dependabot PRs at once is the noise people complain about
// Dependabot branch names (dependabot/<this>/...) -> the package-ecosystem in dependabot.yml.
const BRANCH_ECO = { npm_and_yarn: 'npm', go_modules: 'gomod', github_actions: 'github-actions', pip: 'pip', uv: 'uv', cargo: 'cargo', gradle: 'gradle', maven: 'maven', composer: 'composer', bundler: 'bundler', nuget: 'nuget' };

function checkDepAutomation(s) {
  const a = s.depAutomation;
  if (!a) return [];
  const out = [];
  const add = (id, severity, title, detail, extra = {}) => out.push({ id, category: 'Dependencies', severity, title, detail, ...extra });
  for (const w of a.autoMerge.filter((x) => !x.gated))
    add('automerge-ungated', 'warn', `${w.file} auto-merges every bot update`, 'It merges Dependabot or Renovate PRs without checking the update type, so major (breaking) updates and freshly published releases land unreviewed. Merge only "version-update:semver-patch" and "version-update:semver-minor" (dependabot/fetch-metadata\'s update-type output), and require status checks on the branch.');
  // Only PRs from the ecosystems that are not grouped count (github-actions PRs are not asked to group).
  const ungrouped = (a.dependabot || []).filter((e) => MANY_DEPS.has(e.eco) && !e.groups);
  const ecos = new Set(ungrouped.map((e) => e.eco));
  const bot = (s.prs || []).filter((p) => { const m = /^dependabot\/([^/]+)\//.exec(p.headRefName || ''); return m && ecos.has(BRANCH_ECO[m[1]] || m[1]) && !p.superseded; });
  if (bot.length >= OPEN_BOT_PRS_NOISY && ungrouped.length)
    add('dependabot-ungrouped', 'warn', `${bot.length} open Dependabot PRs, updates not grouped`, `${ungrouped.map((e) => `${e.eco} (${e.dir})`).join(', ')} open one PR per package. Add a "groups" entry (for example minor and patch updates together) so routine updates arrive as one PR, and a "cooldown" so brand-new releases wait a few days.`);
  return out;
}

module.exports = { parseDependabot, auditAutoMerge, auditDepAutomation, checkDepAutomation, OPEN_BOT_PRS_NOISY };
