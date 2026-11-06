// Tests view: the test review (static review plus existing coverage, JUnit and mutation results) and
// the opt-in runs. Loaded after quality-view.js; shares its globals ($, h, put, btn, stat, plural,
// state, toast, onDemand, adviceEl, runActions, miniList, where, hbars).

function scanTestsNow(dirs) {
  return onDemand('tests', () => window.api.testsScan(dirs), (out) => {
    if (!state.tests) state.tests = { repos: new Map() };
    if (!dirs) state.tests.repos.clear();
    for (const r of out.repos) state.tests.repos.set(r.path, r);
  });
}

function openTests() {
  state.view = 'tests'; state.selected = null;
  renderList(); renderTestsView();
  if (!state.tests && state.repos.size) scanTestsNow();
}

// Runs execute the project's own code: always previewed, and the review asks for the repo name.
async function runTestsFor(res, kind, stack, root) {
  const repo = state.repos.get(res.path);
  if (!repo) return;
  if (await runActions([{ repo, action: { type: 'tests-run', kind, stack, root } }])) await scanTestsNow([res.path]);
}

const pctCls = (p, warn, ok) => (p == null ? '' : p < warn ? 'err' : p < ok ? 'warn' : 'ok');

function testsRepoEl(res) {
  if (res.error) return h('div', { class: 'cblock' }, h('h3', {}, res.name), h('p', { class: 'b-err' }, res.error));
  const r = res.results || {};
  const details = [];
  if (r.coverage && r.coverage.lowest.length) details.push(h('details', {}, h('summary', {}, `Least covered files (${r.coverage.file})`),
    hbars(r.coverage.lowest.map((f) => ({ label: f.path, value: f.percent, cls: f.percent < 50 ? 'c-err' : f.percent < 75 ? 'c-warn' : 'c-info', title: `${f.path}: ${f.percent}% of ${f.lines} lines` })), { max: 100 })));
  if (r.mutation && r.mutation.examples.length) details.push(h('details', {}, h('summary', {}, `Surviving mutants (${r.mutation.survived})`), miniList(r.mutation.examples.map((e) => [h('code', {}, e)]))));
  if (r.junit && r.junit.slowest.length) details.push(h('details', {}, h('summary', {}, `Slowest tests (${r.junit.file})`), miniList(r.junit.slowest.map((s) => [h('code', {}, s.name), ` ${s.time}s`]))));
  if (res.untested && res.untested.length) details.push(h('details', {}, h('summary', {}, `Largest files with no test named after them (${res.untestedCount})`), miniList(res.untested.map((u) => [h('code', {}, u.path), ` ${u.lines} lines`]))));
  const runs = (res.runnable || []).flatMap((s) => [
    s.coverage ? btn(`Run coverage (${s.name}${s.root !== '.' ? `, ${s.root}` : ''})…`, () => runTestsFor(res, 'coverage', s.stack, s.root)) : null,
    s.mutation ? btn(`Mutation testing (${s.name}${s.root !== '.' ? `, ${s.root}` : ''})…`, () => runTestsFor(res, 'mutation', s.stack, s.root)) : null,
  ]).filter(Boolean);
  const repo = state.repos.get(res.path);
  return h('div', { class: 'cblock' },
    h('h3', {}, res.name, h('span', { class: 'pill' }, `${plural(res.testCases, 'test')} · ${plural(res.testFiles, 'test file')}`),
      r.coverage ? h('span', { class: 'pill ' + pctCls(r.coverage.percent, 50, 75), title: `${r.coverage.file}, ${r.coverage.date.slice(0, 10)}` }, `coverage ${r.coverage.percent}%`) : null,
      r.mutation ? h('span', { class: 'pill ' + pctCls(r.mutation.score, 60, 80), title: r.mutation.tool }, `mutation ${r.mutation.score}%`) : null),
    h('div', { class: 'muted' }, res.stacks.length ? res.stacks.map((s) => `${s.name}${s.runner ? ` (${s.runner})` : ''}${s.root !== '.' ? ` in ${s.root}/` : ''}`).join(', ') : 'No test setup found'),
    res.advice.length ? res.advice.map((f) => (f.fix && repo ? adviceEl(repo, f) : adviceEl(null, f))) : h('p', { class: 'ok-msg' }, 'Nothing to flag.'),
    runs.length ? h('div', { class: 'toolbar' }, ...runs) : null,
    ...details);
}

function renderTestsView() {
  if (state.view !== 'tests') return;
  const c = state.tests;
  const head = [h('h2', {}, 'Tests'),
    h('p', { class: 'sub' }, 'Reads each repo\'s tests without running them: tests CI never runs, focused, skipped and assertion-free tests, sleeps and real network calls, and large files with no test. Coverage, JUnit and mutation reports that already exist are read too. Running tests with coverage or mutation testing executes the project\'s code, so each run is previewed and asks for the repo name.')];
  if (!c) {
    const err = state.scanError.tests;
    const msg = !state.repos.size ? 'Choose a workspace folder and press Scan first.' : err ? `Test review failed: ${err}` : 'Reviewing…';
    return put($('detail'), ...head, h('p', { class: err ? 'b-err' : 'empty' }, msg), err ? btn('Try again', () => scanTestsNow()) : null);
  }
  const all = [...c.repos.values()].filter((r) => !r.error);
  const sum = (f) => all.reduce((n, r) => n + f(r), 0);
  const covered = all.filter((r) => r.results && r.results.coverage);
  const n = (x) => x.toLocaleString();
  const top = $('detail').scrollTop;
  put($('detail'), ...head,
    h('div', { class: 'toolbar' }, btn('Review again', (e) => { e.target.disabled = true; scanTestsNow(); })),
    h('div', { class: 'qstats' }, stat('Test cases', n(sum((r) => r.testCases))), stat('Repos without tests', n(all.filter((r) => !r.testCases).length), all.some((r) => !r.testCases) ? 'warn' : 'ok'),
      stat('Not run by CI', n(all.filter((r) => r.advice.some((a) => a.id === 't-ci' || a.id === 't-ci-none')).length), 'warn'),
      stat('Skipped or focused', n(sum((r) => r.skipped.length + r.focused.length))), stat('With coverage', `${covered.length}/${all.length}`)),
    [...c.repos.values()].sort((a, b) => (b.advice || []).filter((x) => x.severity !== 'info').length - (a.advice || []).filter((x) => x.severity !== 'info').length || a.name.localeCompare(b.name)).map(testsRepoEl));
  $('detail').scrollTop = top;
}

$('tests').addEventListener('click', openTests);
