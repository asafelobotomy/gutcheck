// Dependency automation, release health, ignores, baseline drift and scheduled-scan diffs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseDependabot, auditAutoMerge, auditDepAutomation, checkDepAutomation } = require('../src/dep-automation');
const { collectRelease, checkRelease } = require('../src/release');
const { applyPolicy, createPolicyStore, driftReport, normalizeBaseline, matches } = require('../src/policy');
const sched = require('../src/schedule');
const { score } = require('../src/checks');
const { TEMPLATES } = require('../src/templates');
const { buildReport } = require('../src/report');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-up-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const repo = () => { const d = tmp(); sh(d, 'init', '-q', '-b', 'main'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't'); return d; };
const commit = (d, msg, date) => { put(d, 'f-' + msg, msg); sh(d, 'add', '-A'); execFileSync('git', ['commit', '-qm', msg], { cwd: d, env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) } }); };

test('dependabot.yml entries: ecosystem, folder, groups and cooldown per entry', () => {
  const e = parseDependabot(`version: 2
updates:
  - package-ecosystem: npm   # the app
    directory: "/"
    schedule: { interval: weekly }
    groups:
      all:
        patterns: ["*"]
  - package-ecosystem: "cargo"
    directory: /src-tauri
    cooldown:
      default-days: 5
`);
  assert.deepEqual(e, [{ eco: 'npm', dir: '/', groups: true, cooldown: false }, { eco: 'cargo', dir: '/src-tauri', groups: false, cooldown: true }]);
});

test('the Dependabot template groups minor and patch updates and adds a cooldown', () => {
  const y = TEMPLATES.dependabot.build({ ecosystems: [{ eco: 'npm', dir: '/' }], hasWorkflows: true });
  const e = parseDependabot(y);
  assert.ok(e.length === 2 && e.every((x) => x.groups && x.cooldown), y);
  assert.match(y, /update-types: \[minor, patch\]/);
});

test('auto-merge workflows: ungated ones are flagged, ones that check the update type are not', () => {
  const ungated = 'on: pull_request\njobs:\n  m:\n    if: github.actor == \'dependabot[bot]\'\n    steps:\n      - run: gh pr merge --auto --squash "$PR_URL"\n';
  const gated = 'on: pull_request\njobs:\n  m:\n    steps:\n      - id: metadata\n        uses: dependabot/fetch-metadata@abc\n      - if: steps.metadata.outputs.update-type == \'version-update:semver-patch\'\n        run: gh pr merge --auto --merge "$PR_URL"\n';
  assert.deepEqual(auditAutoMerge(ungated), { gated: false });
  assert.deepEqual(auditAutoMerge(gated), { gated: true });
  assert.equal(auditAutoMerge('jobs:\n  r:\n    steps:\n      - run: gh pr merge 3'), null, 'merging a PR is not bot auto-merge');
  const d = tmp();
  try {
    put(d, '.github/workflows/auto.yml', ungated);
    put(d, '.github/workflows/ok.yml', gated);
    const a = auditDepAutomation(d);
    const f = checkDepAutomation({ depAutomation: a, prs: [] });
    assert.deepEqual(f.map((x) => x.id), ['automerge-ungated']);
    assert.match(f[0].title, /auto\.yml/);
  } finally { rm(d); }
});

test('ungrouped Dependabot is only a finding when its PRs actually pile up', () => {
  const depAutomation = { dependabot: [{ eco: 'npm', dir: '/', groups: false, cooldown: false }], renovate: false, autoMerge: [] };
  const pr = (n, extra = {}) => ({ number: n, headRefName: `dependabot/npm_and_yarn/p${n}`, ...extra });
  assert.equal(checkDepAutomation({ depAutomation, prs: [1, 2, 3, 4].map((n) => pr(n)) }).length, 0, 'four open PRs is not noise');
  assert.equal(checkDepAutomation({ depAutomation, prs: [1, 2, 3, 4, 5].map((n) => pr(n)) })[0].id, 'dependabot-ungrouped');
  assert.equal(checkDepAutomation({ depAutomation, prs: [1, 2, 3, 4, 5].map((n) => pr(n, n > 1 ? { superseded: [{}] } : {})) }).length, 0, 'superseded PRs do not count');
  const grouped = { ...depAutomation, dependabot: [{ eco: 'npm', dir: '/', groups: true }, { eco: 'github-actions', dir: '/', groups: false }] };
  assert.equal(checkDepAutomation({ depAutomation: grouped, prs: [1, 2, 3, 4, 5].map((n) => pr(n)) }).length, 0, 'github-actions without groups is fine');
});

test('release health: unreleased work, a manifest behind its tag, an untagged bump, a stale changelog', async () => {
  const d = repo();
  try {
    put(d, 'package.json', JSON.stringify({ name: 'x', version: '1.2.0' }));
    put(d, 'CHANGELOG.md', '# Changelog\n\n## 1.1.0\n- old\n');
    commit(d, 'a', '2020-01-01T00:00:00Z');
    sh(d, 'tag', 'v1.2.0');
    sh(d, 'tag', 'v1.10.0-rc1'); // pre-releases are not releases
    for (const m of ['b', 'c', 'd', 'e', 'f']) commit(d, m, '2020-02-01T00:00:00Z');
    const rel = await collectRelease(d);
    assert.equal(rel.latest, 'v1.2.0');
    assert.equal(rel.commitsSince, 5);
    assert.deepEqual(rel.manifest, { file: 'package.json', version: '1.2.0' });
    const s = { release: rel, git: { ahead: 0, dirty: 0 }, files: {} };
    const ids = (x) => checkRelease(x).map((f) => f.id).sort();
    assert.deepEqual(ids(s), ['changelog-stale', 'release-unreleased']);
    assert.deepEqual(ids({ ...s, release: { ...rel, manifest: { file: 'package.json', version: '1.1.0' } } }), ['changelog-stale', 'release-unreleased', 'release-version-behind']);
    assert.ok(ids({ ...s, release: { ...rel, manifest: { file: 'package.json', version: '1.3.0' } } }).includes('release-untagged'));
    assert.ok(!ids({ ...s, git: { ahead: 1, dirty: 0 }, release: { ...rel, manifest: { file: 'package.json', version: '1.3.0' } } }).includes('release-untagged'), 'not pushed yet: CI has not had the chance to tag it');
  } finally { rm(d); }
});

test('release false alarms: GitHub\'s newer release counts, unversioned changelogs, untagged repos', async () => {
  const rel = { latest: 'v1.2.0', version: '1.2.0', commitsSince: 0, taggedAt: new Date().toISOString(), manifest: { file: 'package.json', version: '1.3.0' }, changelog: { file: 'CHANGELOG.md', versioned: false, mentions: false } };
  const ids = (x) => checkRelease(x).map((f) => f.id);
  assert.deepEqual(ids({ release: rel, git: {}, remote: { latestRelease: 'v1.3.0' } }), [], 'a tag made by CI that is not fetched yet is still a release');
  assert.deepEqual(ids({ release: { ...rel, manifest: null }, git: {} }), [], 'a changelog that never names versions is not expected to');
  const d = repo();
  try { commit(d, 'a'); const r = await collectRelease(d); assert.equal(r.latest, null); assert.deepEqual(ids({ release: r, git: {} }), []); } finally { rm(d); }
});

const result = (findings, extra = {}) => ({ path: '/w/app', name: 'app', remote: { owner: 'o', name: 'app', isPublic: true }, files: { license: true, readme: true }, ...score(findings), ...extra });

test('ignores: by id, by prefix, from the repo file and for every repo; the score leaves them out', () => {
  const fs_ = [{ id: 'no-topics', severity: 'info' }, { id: 'pr-stale-3', severity: 'warn' }, { id: 'pr-stale-9', severity: 'warn' }, { id: 'no-codeowners', severity: 'info' }, { id: 'git-dirty', severity: 'warn' }];
  const r = applyPolicy(result(fs_, { repoPolicy: { ignore: { 'no-codeowners': 'solo project' } } }), { ignores: { '*': { 'no-topics': 'not needed' }, 'o/app': { 'pr-stale-*': 'parked on purpose' } } }, score);
  assert.deepEqual(r.findings.map((f) => f.id), ['git-dirty']);
  assert.equal(r.score, 95);
  assert.deepEqual(r.ignored.map((f) => [f.id, f.ignoredIn]).sort(), [['no-codeowners', '.gutcheck.json'], ['no-topics', 'all repos'], ['pr-stale-3', 'GutCheck'], ['pr-stale-9', 'GutCheck']]);
  assert.ok(matches('pr-stale-*', 'pr-stale-12') && !matches('pr-stale', 'pr-stale-12'));
});

test('the ignore store needs a reason, keeps ids safe and is removable', () => {
  const d = tmp();
  try {
    const p = createPolicyStore(d);
    assert.equal(p.setIgnore('o/app', 'no-topics', '  ').ok, false, 'a reason is required');
    assert.equal(p.setIgnore('o/app', '../x;rm', 'r').ok, false);
    assert.equal(p.setIgnore('o/app', 'no-topics', 'not needed').ok, true);
    assert.deepEqual(p.load().ignores, { 'o/app': { 'no-topics': 'not needed' } });
    assert.equal(p.removeIgnore('o/app', 'no-topics').ok, true);
    assert.deepEqual(p.load().ignores, {});
    assert.equal(p.removeIgnore('o/app', 'no-topics').ok, false);
  } finally { rm(d); }
});

test('baseline: drift finding per repo, public-only rules, skips, and the workspace table', () => {
  const baseline = normalizeBaseline({ require: ['license', 'readme', 'security-policy:public', 'ci', 'nonsense'], skip: { tool: ['ci'] } });
  assert.deepEqual(baseline.require.map((r) => r.id), ['license', 'readme', 'security-policy', 'ci'], 'unknown rules are dropped');
  const a = applyPolicy(result([], { files: { license: true, readme: false }, hasWorkflows: false }), { baseline }, score);
  assert.deepEqual(a.drift.failed.map((f) => f.id), ['readme', 'security-policy', 'ci']);
  assert.equal(a.findings[0].id, 'baseline-drift');
  const b = applyPolicy(result([], { path: '/w/tool', name: 'tool', remote: { owner: 'o', name: 'tool', isPublic: false }, files: { license: false, readme: true }, hasWorkflows: false }), { baseline }, score);
  assert.deepEqual(b.drift.failed.map((f) => f.id), ['license'], 'private repo: no security policy needed; ci skipped for this repo');
  const table = driftReport([a, b], baseline);
  assert.deepEqual(table.find((x) => x.id === 'readme'), { id: 'readme', label: 'README', publicOnly: false, ok: 1, missing: ['app'] });
  const ok = applyPolicy(result([], { files: { license: true, readme: true, security: true }, hasWorkflows: true }), { baseline }, score);
  assert.ok(!ok.findings.some((f) => f.id === 'baseline-drift'));
});

test('the report tells an LLM which findings the owner ignored, and has steps for the new findings', () => {
  const r = applyPolicy(result([{ id: 'no-topics', severity: 'info', title: 't', category: 'Project setup' }, { id: 'automerge-ungated', severity: 'warn', title: 'auto.yml auto-merges', category: 'Dependencies' }], { git: {}, scannedAt: 'now' }), { ignores: { 'o/app': { 'no-topics': 'not needed' } } }, score);
  const text = buildReport({ repos: [r] });
  assert.match(text, /Ignored by the owner \(do not suggest fixing these\): no-topics \(not needed\)/);
  assert.match(text, /version-update:semver-patch/);
});

test('scheduled scans: only findings missing from the last scan are new, and the notification names them', () => {
  const r1 = [{ ...result([{ id: 'git-dirty', severity: 'warn', title: '2 uncommitted' }]) }];
  const r2 = [{ ...result([{ id: 'git-dirty', severity: 'warn', title: '2 uncommitted' }, { id: 'ci-failed-1', severity: 'error', title: 'Failed: CI' }]) }];
  assert.deepEqual(sched.newFindings(null, r2), [], 'nothing to compare with');
  const fresh = sched.newFindings(sched.findingKeys(r1), r2);
  assert.deepEqual(fresh.map((f) => f.id), ['ci-failed-1']);
  assert.deepEqual(sched.notification(fresh), { title: 'GutCheck: 1 new finding (1 error)', body: 'app: Failed: CI' });
  assert.equal(sched.notification([]), null);
  const d = tmp();
  try {
    const st = sched.createSeenStore(path.join(d, 'seen.json'));
    assert.deepEqual(st.record('/w', r1), { compared: false, fresh: [] });
    assert.deepEqual(st.record('/w', r2).fresh.map((f) => f.id), ['ci-failed-1']);
    assert.deepEqual(st.record('/other', r2), { compared: false, fresh: [] }, 'another workspace is not compared');
  } finally { rm(d); }
  const s = sched.normalizeSchedule({ enabled: true, hours: 6 });
  assert.equal(sched.isDue(10 * 3600e3, 5 * 3600e3, s), false);
  assert.equal(sched.isDue(12 * 3600e3, 5 * 3600e3, s), true);
  assert.equal(sched.isDue(12 * 3600e3, 0, sched.normalizeSchedule({ enabled: false })), false);
  assert.equal(sched.normalizeSchedule({ enabled: true, hours: 5 }).hours, 24, 'only offered intervals');
});
