// Test-suite upkeep: what to consolidate, what is stale, what is unused, what is legacy. Runs after
// the static review on the test files it read, then turns the results into advice rows (category
// Tests) with report steps an agent can follow. Read-only: files, configs, git blame and git log.

const path = require('node:path');
const { plural, list } = require('../util');
const { consolidation } = require('./consolidate');
const { staleness, STALE_DAYS, DRIFT_COMMITS } = require('./stale');
const { unusedHelpers, notCollected, missingTargets, configText } = require('./unused');
const { legacyApis, mixedRunners, orphanSnapshots } = require('./legacy');

// review: { files, tests, kept, candidates, sources, skipped, stacks }
async function scanUpkeep(dir, r) {
  const nested = r.files.filter((f) => f !== 'package.json' && f.endsWith('/package.json')).map((f) => path.dirname(f));
  const rawByPath = new Map(r.kept.map((k) => [k.rel, k.text]));
  const stems = new Map();
  for (const s of r.sources) { const k = stemOf(s.rel); stems.set(k, stems.has(k) ? null : s.rel); } // ambiguous stems pair with nothing
  const pairs = r.tests.map((t) => ({ test: t.rel, source: stems.get(stemOf(t.rel)) })).filter((p) => p.source);
  const c = consolidation(r.tests, r.sources);
  const s = await staleness(dir, { skipped: r.skipped, tests: r.tests, rawByPath, pairs });
  const u = unusedHelpers(r.kept, configText(dir, r.files));
  const collect = notCollected(dir, { stacks: r.stacks, candidates: r.candidates, nested });
  const missing = await missingTargets(dir, r.tests);
  const snaps = orphanSnapshots(r.files);
  return { ...c, ...s, ...u, notCollected: collect, missing, legacy: legacyApis(r.tests, r.stacks, dir), mixed: mixedRunners(r.tests, r.stacks, nested), orphanSnapshots: snaps.orphans, pendingSnapshots: snaps.pending };
}
const stemOf = (rel) => path.basename(rel).replace(/\.[^.]+$/, '').replace(/^test_|_test$|\.(test|spec)$|_spec$|Test$|Tests$/, '').toLowerCase();

const at = (x) => `${x.path}${x.line ? ':' + x.line : ''}`;

function upkeepAdvice(u) {
  if (!u) return [];
  const out = [];
  const add = (id, severity, title, detail) => out.push({ id, category: 'Tests', severity, title, detail });
  // Consolidate
  if (u.duplicates.length) add('t-dup', 'info', `${plural(u.duplicates.length, 'group')} of near-identical tests`, `${list(u.duplicates.map((d) => `${d.path}:${d.lines.join(',')} (${d.count} tests)`), 4)}. Tests that differ only in their inputs and expected values read better as one parameterized test.`);
  if (u.copies.length) add('t-dup-copies', 'info', `${plural(u.copies.length, 'test body', 'test bodies')} copied between files`, `${list(u.copies.map((c) => c.map(at).join(' = ')), 3)}. The same test in two places runs twice and drifts apart: keep one.`);
  if (u.setup.length || u.sharedSetup.length) add('t-setup', 'info', 'Same setup repeated across tests', `${list([...u.setup.map((x) => `${x.path} (${x.count} tests open with the same lines, from \`${x.first}\`)`), ...u.sharedSetup.map((x) => `${x.count} files open tests with the same lines, from \`${x.first}\` (${list(x.files, 3)})`)], 4)}. Move it into a fixture, beforeEach or helper.`);
  if (u.tinyFiles.length) add('t-tiny-files', 'info', `${plural(u.tinyFiles.length, 'module')} with many tiny test files`, `${list(u.tinyFiles.map((g) => `${g.module}: ${list(g.files, 4)}`), 3)}. One test file per module is easier to find and shares its setup.`);
  // Stale
  if (u.oldMarkers.length) add('t-stale-skip', 'warn', `${plural(u.oldMarkers.length, 'test')} switched off for over ${Math.round(STALE_DAYS / 30)} months`, `${list(u.oldMarkers.map((m) => `${at(m)} (${m.kind === 'xfail' ? 'xfail' : 'skipped'} ${Math.round(m.age / 30)} months${m.reason ? `: "${m.reason}"` : ', no reason'})`), 5)}. A test nobody has turned back on is noise: fix it or delete it.`);
  const freshX = u.xfail.filter((m) => !u.oldMarkers.includes(m));
  if (freshX.length) add('t-xfail', 'info', `${plural(freshX.length, 'expected failure')} (xfail) without strict`, `${list(freshX.map(at), 5)}. A non-strict xfail keeps passing silently once the bug is fixed: add strict=True, or fix and remove it.`);
  if (u.drift.length) add('t-drift', 'info', `${plural(u.drift.length, 'test file')} untouched while the code changed`, `${list(u.drift.map((d) => `${d.path} (${d.source}: ${d.commits} commits since${d.days != null ? `, test unchanged ${Math.round(d.days / 30)} months` : ''})`), 5)}. The tests may no longer cover what the code does now.`);
  // Unused
  if (u.notCollected.length) add('t-not-collected', 'warn', `${plural(u.notCollected.length, 'test file')} the runner never picks up`, `${list(u.notCollected.map((x) => `${x.path} (${x.why})`), 5)}. These tests never run, so they never fail.`);
  if (u.missing.length) add('t-missing-target', 'warn', `${plural(u.missing.length, 'test import')} of a module that no longer exists`, `${list(u.missing.map((x) => `${at(x)} imports ${x.target}`), 5)}. The code they tested was moved or deleted.`);
  const unused = [...u.helpers.map((h) => `${h.path} (helper file)`), ...u.fixtures.map((f) => `${at(f)} fixture ${f.name}`), ...u.goFuncs.map((f) => `${at(f)} ${f.name}()`)];
  if (unused.length) add('t-unused-helper', 'info', `${plural(unused.length, 'test helper')} nothing uses`, `${list(unused, 5)}. Delete them, or use them.`);
  // Legacy
  for (const l of u.legacy) add(`t-legacy-${l.what.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '').slice(0, 30)}`, /nose|removed/.test(l.what) ? 'warn' : 'info', `Legacy test API: ${l.what}`, `${list(l.files.map(at), 5)}. Use ${l.instead}.`);
  for (const m of u.mixed) add('t-mixed-runners', 'info', `${m.runners.length} test runners in one ${m.lang} project`, `${m.runners.map((r) => `${r.name} (${plural(r.count, 'file')}, e.g. ${r.example})`).join('; ')}. Two runners mean two configs and two ways to write a test: move to one.`);
  if (u.orphanSnapshots.length) add('t-orphan-snapshot', 'info', `${plural(u.orphanSnapshots.length, 'snapshot file')} with no matching test`, `${list(u.orphanSnapshots.map((s) => `${s.path} (no ${s.test})`), 5)}. Their test was renamed or deleted.`);
  if (u.pendingSnapshots.length) add('t-pending-snapshot', 'info', `${plural(u.pendingSnapshots.length, 'unreviewed snapshot')} (.snap.new)`, `${list(u.pendingSnapshots.map(at), 5)}. Review them with cargo insta review, then commit or delete.`);
  return out;
}

const Q = 8;
const UPKEEP_STEPS = {
  't-not-collected': { phase: 2, rank: 6, why: 'Some test files never run.', note: 'For each listed file, either rename or move it so the runner collects it (and make it pass), or change the runner config to include it. If it is dead, delete it. Ask the owner which.' },
  't-missing-target': { phase: Q, rank: 2, why: 'Tests import code that is gone.', note: 'For each listed import, find where the module moved (git log --follow, or search for its functions) and point the test there. If the code was deleted on purpose, delete the tests for it.' },
  't-stale-skip': { phase: Q, rank: 5, why: 'Tests have been switched off for months.', note: 'For each listed test, try running it. If it passes, remove the skip. If it fails, fix the code or the test. If nobody wants it, delete it. Ask the owner before deleting. Do not delete skips whose reason names a platform or tool they wait for.' },
  't-xfail': { phase: Q, rank: 6, why: 'Non-strict xfail hides fixed bugs.', note: 'Add strict=True to each listed xfail (or xfail_strict = true in the pytest config), then run the tests: any XPASS is a bug that was fixed, so remove its marker.' },
  't-drift': { phase: Q, rank: 6, why: 'The code moved on and its tests did not.', note: 'For each listed pair, read the code changes since the test last changed (git log -p <source>) and add tests for new behaviour. Remove tests for behaviour that no longer exists.' },
  't-dup': { phase: Q, rank: 7, why: 'Near-identical tests should be one parameterized test.', note: 'Merge each listed group into one table-driven test (test.each / it.each, @pytest.mark.parametrize, a Go table with t.Run, or rstest #[case]). Keep every input and expected value, and give each case a name.' },
  't-dup-copies': { phase: Q, rank: 7, why: 'The same test lives in two files.', note: 'Keep the copy next to the code it tests and delete the other. Check both still assert the same thing first.' },
  't-setup': { phase: Q, rank: 7, why: 'Setup is repeated in many tests.', note: 'Move the repeated opening lines into a fixture (pytest), beforeEach or a helper function (JS), a helper with t.Helper() (Go), or a shared fn (Rust). Leave the per-test differences in the tests.' },
  't-tiny-files': { phase: Q, rank: 8, why: 'One module has many tiny test files.', note: 'Merge the listed files for each module into one test file named after the module, one describe block (or class) per former file. Use git mv for the largest so history follows it.' },
  't-unused-helper': { phase: Q, rank: 8, why: 'Test helpers nobody uses.', note: 'Search the repo for each listed name (it may be used from a config or by a string). If nothing uses it, delete it.' },
  't-mixed-runners': { phase: Q, rank: 8, why: 'Two test runners in one project.', note: 'Ask the owner which runner to keep (usually the one with more files), port the other files to it, and remove the other runner and its config from the dev dependencies.' },
  't-orphan-snapshot': { phase: Q, rank: 9, why: 'Snapshots from deleted tests.', note: 'Check each listed test file is really gone (it may have been renamed: then the runner rewrites the snapshot). Delete snapshots with no test. Jest/Vitest: run with -u (or --ci to list obsolete ones).' },
  't-pending-snapshot': { phase: Q, rank: 9, why: 'Snapshot changes never reviewed.', cmds: ['cargo insta review'] },
};
const LEGACY_STEP = { phase: Q, rank: 7, why: 'Tests use a deprecated or removed API.', note: 'Replace each listed use with the suggested API. Run the tests after each file.' };

function upkeepFix(id) {
  if (id.startsWith('t-legacy-')) return LEGACY_STEP;
  return UPKEEP_STEPS[id] || null;
}

module.exports = { scanUpkeep, upkeepAdvice, upkeepFix, DRIFT_COMMITS };
