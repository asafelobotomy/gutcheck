const test = require('node:test');
const assert = require('node:assert');
const { auditWorkflow } = require('../src/workflows');
const { checkWorkflowAudits } = require('../src/checks-workflows');
const { hygieneFix } = require('../src/report-fixes');

const $ = (s) => '$' + '{{ ' + s + ' }}';
const SHA = '11bd71901bbe5b1630ceea73d27597364c9af683';
const wf = (...l) => l.join('\n') + '\n';
const audit = (text) => auditWorkflow('.github/workflows/w.yml', text);
const roll = (...texts) => {
  const files = texts.map(audit);
  const x = (k) => files.flatMap((f) => (f.extra[k] || []).map((e) => ({ file: f.file, ...e })));
  return { files: files.length, extra: { persist: x('persist'), secretsInherit: x('secretsInherit'), botActor: x('botActor'), unsecure: x('unsecure'), envWrite: x('envWrite'), deprecated: x('deprecated'), noTimeout: x('noTimeout'), noConcurrency: x('noConcurrency'), retired: x('retired'), node20: x('node20'), prTargetPolicy: x('prTargetPolicy') } };
};
const ids = (w, s = {}, now) => checkWorkflowAudits({ hygiene: { workflows: w }, remote: { isPublic: true }, ...s }, now).map((f) => f.id);

test('pull_request_target readiness: public repos only, advice only, retires after its date', () => {
  const w = roll(wf('on:', '  pull_request_target:', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    timeout-minutes: 5', '    steps:', '      - run: echo hi'));
  assert.deepEqual(w.extra.prTargetPolicy.map((x) => x.file), ['.github/workflows/w.yml']);
  const now = new Date('2026-11-10T00:00:00Z');
  const [f] = checkWorkflowAudits({ hygiene: { workflows: w }, remote: { isPublic: true } }, now);
  assert.equal(f.id, 'wf-pr-target-blocked');
  assert.equal(f.severity, 'warn');
  assert.match(f.detail, /2 December 2026/);
  assert.match(f.detail, /16 November/);
  assert.ok(!f.fix, 'advice only');
  assert.ok(!ids(w, { remote: { isPublic: false } }, now).includes('wf-pr-target-blocked'), 'private repos are not affected');
  assert.ok(!ids(w, {}, new Date('2027-04-01T00:00:00Z')).includes('wf-pr-target-blocked'), 'retired after the date');
  const after = checkWorkflowAudits({ hygiene: { workflows: w }, remote: { isPublic: true } }, new Date('2026-12-05T00:00:00Z'));
  assert.match(after[0].detail, /blocks .* by default/, 'wording switches to present tense after the block starts');
  const wr = roll(wf('on:', '  workflow_run:', '    workflows: [CI]', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hi'));
  assert.ok(!ids(wr, {}, now).includes('wf-pr-target-blocked'), 'workflow_run is not part of the change');
  const comment = roll(wf('# on pull_request_target we used to run', 'on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo pull_request_target'));
  assert.equal(comment.extra.prTargetPolicy.length, 0, 'comments and run text do not count');
});

test('artipacked: checkout without persist-credentials, skipped for pushes and v6+', () => {
  const base = (step, extra = []) => wf('on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', ...step, ...extra);
  const bad = roll(base(['      - uses: actions/checkout@' + SHA + ' # v4.2.2', '      - run: npm ci']));
  assert.equal(bad.extra.persist.length, 1);
  assert.equal(bad.extra.persist[0].line, 6);
  assert.equal(bad.extra.persist[0].artifacts, false);
  assert.equal(ids(bad).filter((i) => i === 'wf-persist-credentials').length, 1);
  assert.equal(checkWorkflowAudits({ hygiene: { workflows: bad } })[0].severity, 'info');
  const art = roll(base(['      - uses: actions/checkout@v4', '      - uses: actions/upload-artifact@v4']));
  assert.equal(checkWorkflowAudits({ hygiene: { workflows: art } }).find((f) => f.id === 'wf-persist-credentials').severity, 'warn', 'artifacts make the leak real');
  const fine = roll(base(['      - uses: actions/checkout@v4', '        with:', '          persist-credentials: false']));
  assert.equal(fine.extra.persist.length, 0);
  const push = roll(base(['      - uses: actions/checkout@v4', '      - run: |', '          git commit -am x', '          git push']));
  assert.equal(push.extra.persist.length, 0, 'a job that pushes needs the credential');
  const v6 = roll(base(['      - uses: actions/checkout@v6']));
  assert.equal(v6.extra.persist.length, 0, 'v6 stores the token outside .git/config');
  const other = roll(base(['      - uses: actions/checkout@v4', '        with:', '          fetch-depth: 0']));
  assert.equal(other.extra.persist.length, 1, 'other with: keys do not count');
  const inRun = roll(base(['      - run: |', '          echo "uses: actions/checkout@v4"']));
  assert.equal(inRun.extra.persist.length, 0);
});

test('script injection covers workflow_run branch names and display titles', () => {
  const r = audit(wf('jobs:', '  a:', '    steps:', `      - run: echo ${$('github.event.workflow_run.head_branch')}`, `      - run: echo ${$('github.event.workflow_run.display_title')}`, `      - run: echo ${$('github.event.workflow_run.head_commit.message')}`, `      - run: echo ${$('github.event.workflow_run.id')}`, `      - run: echo ${$('github.event.pull_request.number')}`));
  assert.deepEqual(r.injections.map((x) => x.expr), ['github.event.workflow_run.head_branch', 'github.event.workflow_run.display_title', 'github.event.workflow_run.head_commit.message']);
});

test('secrets: inherit, bot-actor checks, unsecure commands', () => {
  const w = roll(wf('on: push', 'jobs:', '  call:', '    uses: org/repo/.github/workflows/x.yml@main', '    secrets: inherit', '  local:', '    uses: ./.github/workflows/y.yml', '    secrets: inherit', '  merge:', '    runs-on: ubuntu-latest', `    if: ${$("github.actor == 'dependabot[bot]'")}`, '    steps:', '      - run: echo hi', '    env:', '      ACTIONS_ALLOW_UNSECURE_COMMANDS: true'));
  assert.deepEqual(w.extra.secretsInherit.map((x) => [x.line, x.external]), [[5, true], [8, false]]);
  assert.equal(w.extra.botActor.length, 1);
  assert.equal(w.extra.unsecure.length, 1);
  const f = Object.fromEntries(checkWorkflowAudits({ hygiene: { workflows: w } }).map((x) => [x.id, x.severity]));
  assert.equal(f['wf-secrets-inherit'], 'warn');
  assert.equal(f['wf-bot-actor'], 'warn');
  assert.equal(f['wf-insecure-commands'], 'warn');
  const safe = roll(wf('on: pull_request', 'jobs:', '  merge:', '    runs-on: ubuntu-latest', `    if: ${$("github.event.pull_request.user.login == 'dependabot[bot]'")} && ${$("github.actor != 'dependabot[bot]'")}`, '    steps:', '      - run: echo hi'));
  assert.equal(safe.extra.botActor.length, 0, 'the PR author check and != are fine');
  const named = roll(wf('on: push', 'jobs:', '  call:', '    uses: ./.github/workflows/y.yml', '    secrets:', '      TOKEN: ' + $('secrets.TOKEN')));
  assert.equal(named.extra.secretsInherit.length, 0);
  const local = roll(wf('on: push', 'jobs:', '  local:', '    uses: ./.github/workflows/y.yml', '    secrets: inherit'));
  assert.equal(checkWorkflowAudits({ hygiene: { workflows: local } }).find((x) => x.id === 'wf-secrets-inherit').severity, 'info', 'a reusable workflow in the same repo is a smaller leak');
});

test('GITHUB_ENV/GITHUB_PATH writes matter in privileged workflows that read untrusted text', () => {
  const t = (trigger, body) => roll(wf('on:', '  ' + trigger + ':', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', ...body));
  const bad = t('pull_request_target', ['      - run: echo "X=$TITLE" >> "$GITHUB_ENV"', '        env:', `          TITLE: ${$('github.event.pull_request.title')}`]);
  assert.equal(bad.extra.envWrite.length, 1);
  assert.equal(t('pull_request_target', ['      - run: echo "X=1" >> "$GITHUB_ENV"']).extra.envWrite.length, 0, 'constant values are fine');
  assert.equal(t('pull_request', ['      - run: echo "X=$TITLE" >> "$GITHUB_ENV"', '        env:', `          TITLE: ${$('github.event.pull_request.title')}`]).extra.envWrite.length, 0, 'unprivileged trigger');
  assert.equal(t('pull_request_target', ['      - run: echo "n=1" >> "$GITHUB_OUTPUT"', '        env:', `          TITLE: ${$('github.event.pull_request.title')}`]).extra.envWrite.length, 0, 'GITHUB_OUTPUT with a constant is fine');
});

test('upkeep: timeout, concurrency, retired runners, deprecated commands', () => {
  const w = roll(wf('on: pull_request', 'jobs:', '  a:', '    runs-on: macos-13', '    steps:', '      - run: echo "::set-output name=x::1"', '  b:', '    runs-on: ubuntu-latest', '    timeout-minutes: 10', '    steps:', '      - run: echo hi'));
  assert.deepEqual(w.extra.noTimeout.map((x) => x.job), ['a']);
  assert.equal(w.extra.noConcurrency.length, 1);
  assert.deepEqual(w.extra.retired.map((x) => x.label), ['macos-13']);
  assert.equal(w.extra.deprecated.length, 1);
  const f = Object.fromEntries(checkWorkflowAudits({ hygiene: { workflows: w } }).map((x) => [x.id, x.severity]));
  assert.deepEqual(f, { 'actions-retired-runner': 'warn', 'actions-no-timeout': 'info', 'actions-no-concurrency': 'info', 'actions-deprecated-commands': 'info' });
  const ok = roll(wf('on: pull_request', 'concurrency:', '  group: x', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    timeout-minutes: 15', '    steps:', '      - run: echo hi', '  call:', '    uses: ./.github/workflows/y.yml'));
  assert.deepEqual([ok.extra.noTimeout.length, ok.extra.noConcurrency.length, ok.extra.retired.length], [0, 0, 0], 'reusable-workflow jobs cannot set a timeout');
  const push = roll(wf('on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hi'));
  assert.equal(push.extra.noConcurrency.length, 0, 'concurrency is only asked of PR-triggered workflows');
  const step = roll(wf('on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hi', '        timeout-minutes: 5'));
  assert.equal(step.extra.noTimeout.length, 1, 'a step timeout is not a job timeout');
  const mx = roll(wf('on: push', 'jobs:', '  a:', '    strategy:', '      matrix:', '        os: [ubuntu-20.04, macos-14, macos-13-large]', '    runs-on: ' + $('matrix.os'), '    steps:', '      - run: echo "macos-13 in text"'));
  assert.deepEqual(mx.extra.retired.map((x) => x.label), ['ubuntu-20.04', 'macos-13-large']);
});

test('Node 20 actions: bundled majors, SHA pins use the version comment, unknown refs are skipped', () => {
  const w = roll(wf('on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    timeout-minutes: 5', '    steps:', '      - uses: actions/checkout@v4', '      - uses: actions/setup-node@' + SHA + ' # v4.4.0', '      - uses: actions/upload-artifact@v6', '      - uses: actions/cache@' + SHA, '      - uses: actions/checkout@main', '      - uses: someone/else@v1', '      - uses: actions/setup-python@v5.1.0'));
  assert.deepEqual(w.extra.node20.map((x) => x.uses), ['actions/checkout@v4', 'actions/setup-node@v4.4.0', 'actions/setup-python@v5.1.0']);
  const f = checkWorkflowAudits({ hygiene: { workflows: w } }).find((x) => x.id === 'actions-node20');
  assert.equal(f.severity, 'warn');
  assert.match(f.detail, /Node 24/);
});

test('every new finding has a sourced report step', () => {
  for (const id of ['wf-pr-target-blocked', 'wf-persist-credentials', 'wf-secrets-inherit', 'wf-bot-actor', 'wf-insecure-commands', 'wf-env-write', 'actions-no-timeout', 'actions-no-concurrency', 'actions-retired-runner', 'actions-deprecated-commands', 'actions-node20']) {
    const s = hygieneFix(id, { remote: { owner: 'o', name: 'r' } });
    assert.ok(s && s.why && s.note, id);
    assert.match(s.ref, /^https:\/\//, id);
  }
});
