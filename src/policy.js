// The user's own rules on top of GutCheck's checks:
// - Ignores: a finding the user has accepted, with the reason. Stored in GutCheck's data folder
//   (ignores.json, per repo or "*" for every repo), or in a repo's own .gutcheck.json so a team shares
//   them. Ignored findings leave the score and the report but stay listed with their reason.
// - Baseline: what every repo should have (baseline.json in the data folder). Each repo is compared
//   with it and the differences ("drift") are one finding plus a workspace-wide table.

const fs = require('node:fs');
const path = require('node:path');

const MAX_REASON = 300;
const ID_RE = /^[A-Za-z0-9][\w.:/-]{0,120}\*?$/; // a finding id, or a prefix ending in * (pr-stale-*)

const readJSON = (f) => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
const writeJSON = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2) + '\n'); fs.renameSync(f + '.tmp', f); };

// The key ignores are stored under: owner/name for GitHub repos (stable across clones), else the folder name.
const repoKey = (r) => (r.remote && r.remote.owner && !r.remote.unreachable ? `${r.remote.owner}/${r.remote.name}` : r.ref ? `${r.ref.owner}/${r.ref.name}` : path.basename(r.path || r.dir || ''));

// Repo-local rules: .gutcheck.json { "ignore": { "<id>": "<reason>" } }. Read as data only.
function repoPolicy(dir) {
  const v = readJSON(path.join(dir, '.gutcheck.json'));
  return v && v.ignore && typeof v.ignore === 'object' ? { ignore: clean(v.ignore) } : null;
}
function clean(map) {
  const out = {};
  for (const [id, reason] of Object.entries(map || {})) if (ID_RE.test(id)) out[id] = String(typeof reason === 'string' ? reason : (reason && reason.reason) || '').slice(0, MAX_REASON);
  return out;
}

const matches = (pattern, id) => (pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : pattern === id);

// ---------------------------------------------------------------- baseline rules
// id -> { label, test(snapshot) -> true (has it) | false (drift) | null (does not apply) }
const has = (v) => (v == null ? null : !!v);
const RULES = {
  license: { label: 'Licence file', test: (s) => s.files && s.files.license },
  readme: { label: 'README', test: (s) => s.files && s.files.readme },
  gitignore: { label: '.gitignore', test: (s) => s.files && s.files.gitignore },
  'security-policy': { label: 'Security policy', test: (s) => s.files && (s.files.security || !!(s.remote && s.remote.securityPolicy)) },
  contributing: { label: 'CONTRIBUTING.md', test: (s) => s.files && (s.files.contributing || !!(s.remote && s.remote.contributing)) },
  'code-of-conduct': { label: 'Code of conduct', test: (s) => s.files && (s.files.codeOfConduct || !!(s.remote && s.remote.codeOfConduct)) },
  codeowners: { label: 'CODEOWNERS', test: (s) => has(s.hygiene && s.hygiene.project && s.hygiene.project.codeowners) },
  editorconfig: { label: '.editorconfig', test: (s) => has(s.hygiene && s.hygiene.project && s.hygiene.project.editorconfig) },
  gitattributes: { label: '.gitattributes', test: (s) => has(s.hygiene && s.hygiene.project && s.hygiene.project.gitattributes) },
  changelog: { label: 'Changelog', test: (s) => has(s.hygiene && s.hygiene.project && s.hygiene.project.changelog) },
  ci: { label: 'CI workflow', test: (s) => !!s.hasWorkflows },
  'actions-pinned': { label: 'Actions pinned to SHAs', test: (s) => (s.hygiene && s.hygiene.workflows ? !s.hygiene.workflows.unpinned.length : null) },
  dependabot: { label: 'Dependabot config', test: (s) => (s.deps && s.deps.manifests && s.deps.manifests.length ? !!(s.files && s.files.dependabotConfig) || !!(s.depAutomation && s.depAutomation.renovate) : null) },
  'dependabot-groups': { label: 'Dependabot updates grouped', test: (s) => { const d = s.depAutomation && s.depAutomation.dependabot; return d && d.length ? d.every((e) => e.groups) : null; } },
  'dependabot-cooldown': { label: 'Dependabot cooldown', test: (s) => { const d = s.depAutomation && s.depAutomation.dependabot; return d && d.length ? d.every((e) => e.cooldown) : null; } },
  'agents-file': { label: 'AGENTS.md or CLAUDE.md', test: (s) => (s.agents ? !!(s.agents.agentsMd || s.agents.claudeMd) : null) },
  'branch-protection': { label: 'Default branch protected', test: (s) => (s.remote && !s.remote.archived && !s.remote.protectionUnavailable && s.protection != null ? s.protection === true : null) },
  'auto-delete': { label: 'Merged branches auto-deleted', test: (s) => (s.remote && s.remote.deleteBranchOnMerge != null ? !!s.remote.deleteBranchOnMerge : null) },
  'secret-scanning': { label: 'Secret scanning on', test: (s) => (s.security && s.security.secretScanning ? s.security.secretScanning === 'enabled' : null) },
  'private-reporting': { label: 'Private vulnerability reporting', test: (s) => (s.security && typeof s.security.privateReporting === 'boolean' ? s.security.privateReporting : null) },
  description: { label: 'GitHub description', test: (s) => (s.remote && !s.remote.unreachable ? !!s.remote.description : null) },
};

// Written by `gutcheck baseline init` and the app: a starting point the user edits.
const DEFAULT_BASELINE = {
  about: 'GutCheck baseline: what every repo in the workspace should have. "require" lists rule ids (add ":public" to apply a rule to public repos only); "skip" exempts repos (owner/name or folder name) from rules. Rules: ' + Object.keys(RULES).join(', '),
  require: ['license:public', 'readme', 'gitignore', 'security-policy:public', 'ci', 'actions-pinned', 'dependabot', 'dependabot-groups', 'branch-protection:public', 'auto-delete', 'secret-scanning:public', 'description'],
  skip: {},
};

function normalizeBaseline(b) {
  if (!b || !Array.isArray(b.require)) return null;
  const require = b.require.map((x) => String(x)).map((x) => { const [id, scope] = x.split(':'); return { id, publicOnly: scope === 'public' }; }).filter((r) => RULES[r.id]);
  const skip = {};
  for (const [k, v] of Object.entries(b.skip && typeof b.skip === 'object' ? b.skip : {})) if (Array.isArray(v)) skip[k] = v.map(String);
  return { require, skip };
}

// -> { failed: [{ id, label }], passed: n, checked: n }
function driftOf(s, baseline, key) {
  const skipped = new Set([...(baseline.skip[key] || []), ...(baseline.skip[path.basename(s.path || '')] || []), ...(baseline.skip['*'] || [])]);
  const failed = [];
  let passed = 0;
  for (const r of baseline.require) {
    if (skipped.has(r.id)) continue;
    if (r.publicOnly && !(s.remote && s.remote.isPublic)) continue;
    const v = RULES[r.id].test(s);
    if (v === true) passed++;
    else if (v === false) failed.push({ id: r.id, label: RULES[r.id].label });
  }
  return { failed, passed, checked: failed.length + passed };
}

// ---------------------------------------------------------------- store
function createPolicyStore(dir) {
  const ignoreFile = path.join(dir, 'ignores.json');
  const baselineFile = path.join(dir, 'baseline.json');
  const loadIgnores = () => { const v = readJSON(ignoreFile) || {}; const out = {}; for (const [k, m] of Object.entries(v)) if (m && typeof m === 'object') out[k] = clean(m); return out; };
  function setIgnore(key, id, reason) {
    if (typeof key !== 'string' || !key || !ID_RE.test(String(id || ''))) return { ok: false, error: 'Name a repo and a finding id (a trailing * ignores every id that starts with it).' };
    const why = String(reason || '').trim().slice(0, MAX_REASON);
    if (!why) return { ok: false, error: 'Give a reason: it is shown wherever the finding would have been.' };
    const all = loadIgnores();
    all[key] = { ...(all[key] || {}), [id]: why };
    writeJSON(ignoreFile, all);
    return { ok: true, key, id, reason: why };
  }
  function removeIgnore(key, id) {
    const all = loadIgnores();
    if (!all[key] || !(id in all[key])) return { ok: false, error: `"${id}" is not ignored in GutCheck's settings for ${key}${key === '*' ? '' : ' (it may come from the repo\'s .gutcheck.json)'}.` };
    delete all[key][id];
    if (!Object.keys(all[key]).length) delete all[key];
    writeJSON(ignoreFile, all);
    return { ok: true, key, id };
  }
  const loadBaseline = () => normalizeBaseline(readJSON(baselineFile));
  function initBaseline() {
    if (fs.existsSync(baselineFile)) return { ok: true, file: baselineFile, created: false };
    writeJSON(baselineFile, DEFAULT_BASELINE);
    return { ok: true, file: baselineFile, created: true };
  }
  return { load: () => ({ ignores: loadIgnores(), baseline: loadBaseline() }), setIgnore, removeIgnore, initBaseline, ignoreFile, baselineFile };
}

// Apply the policy to a scored result (mutates and returns it). score(findings) recomputes the score.
function applyPolicy(res, policy, score) {
  if (!res || res.error || !policy) return res;
  const key = repoKey(res);
  const rules = [
    ...Object.entries((policy.ignores || {})['*'] || {}).map(([id, reason]) => ({ id, reason, from: 'all repos' })),
    ...Object.entries((policy.ignores || {})[key] || {}).map(([id, reason]) => ({ id, reason, from: 'GutCheck' })),
    ...Object.entries((res.repoPolicy && res.repoPolicy.ignore) || {}).map(([id, reason]) => ({ id, reason, from: '.gutcheck.json' })),
  ];
  let findings = res.findings;
  if (policy.baseline) {
    const d = driftOf(res, policy.baseline, key);
    res.drift = d;
    findings = findings.filter((f) => f.id !== 'baseline-drift');
    if (d.failed.length) findings.push({ id: 'baseline-drift', category: 'Baseline', severity: 'warn', title: `Differs from your baseline in ${d.failed.length} of ${d.checked} rule${d.checked === 1 ? '' : 's'}`, detail: `Missing: ${d.failed.map((f) => f.label).join(', ')}. The baseline is your own baseline.json; other findings here say how to fix each one.` });
  } else delete res.drift;
  const ignored = [];
  const kept = [];
  for (const f of findings) {
    const rule = rules.find((r) => matches(r.id, f.id));
    if (rule) ignored.push({ ...f, ignoredBecause: rule.reason, ignoredIn: rule.from, ignoreRule: rule.id }); else kept.push(f);
  }
  res.ignoreKey = key;
  res.ignored = ignored;
  return Object.assign(res, score(kept));
}

// Workspace-wide drift table: per rule, which repos have it and which do not.
function driftReport(results, baseline) {
  if (!baseline) return null;
  return baseline.require.map((r) => {
    const ok = [];
    const missing = [];
    for (const res of results) {
      if (res.error || !res.drift) continue;
      if (res.drift.failed.some((f) => f.id === r.id)) missing.push(res.name);
      else if (RULES[r.id].test(res) === true) ok.push(res.name);
    }
    return { id: r.id, label: RULES[r.id].label, publicOnly: r.publicOnly, ok: ok.length, missing };
  });
}

module.exports = { RULES, DEFAULT_BASELINE, normalizeBaseline, driftOf, driftReport, applyPolicy, createPolicyStore, repoPolicy, repoKey, matches };
