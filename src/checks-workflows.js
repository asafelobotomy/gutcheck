// Findings from the extra workflow audits (workflows-extra.js). Security ones use wf-* ids (and the
// "Actions security" category, which a repo's own .gutcheck.json cannot hide); upkeep ones use
// actions-* ids and the "Actions upkeep" category. The facts and dates live in workflow-facts.js.

const { plural, list } = require('./util');
const { PR_TARGET_BLOCK, NODE20_UNTIL } = require('./workflow-facts');

const day = (iso) => new Date(iso + 'T00:00:00Z');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const long = (iso) => `${day(iso).getUTCDate()} ${MONTHS[day(iso).getUTCMonth()]} ${day(iso).getUTCFullYear()}`;
const at = (xs, n = 4) => list(xs.map((x) => `${x.file}${x.line ? ':' + x.line : ''}`), n);

function checkWorkflowAudits(s, now = new Date()) {
  const w = s.hygiene && s.hygiene.workflows;
  const x = w && w.extra;
  if (!w || !w.files || !x) return [];
  const out = [];
  const sec = (id, severity, title, detail) => out.push({ id, category: 'Actions security', severity, title, detail });
  const up = (id, title, detail, severity = 'info') => out.push({ id, category: 'Actions upkeep', severity, title, detail });
  const files = (xs) => [...new Set(xs.map((e) => e.file))];

  // Perishable: delete this block (and PR_TARGET_BLOCK) once the change is old news.
  if (x.prTargetPolicy.length && s.remote && s.remote.isPublic && now < day(PR_TARGET_BLOCK.retireAfter)) {
    const started = now >= day(PR_TARGET_BLOCK.from);
    const [b1, b2] = PR_TARGET_BLOCK.brownouts.map(long);
    sec('wf-pr-target-blocked', 'warn', 'pull_request_target is blocked by default on public repos',
      `${list(files(x.prTargetPolicy), 4)}. GitHub ${started ? 'now blocks' : 'will block'} pull_request_target by default on public repositories${started ? ' (since' : ' from'} ${long(PR_TARGET_BLOCK.from)}${started ? ')' : ` (brownouts, when it is enforced for two hours, on ${b1} and ${b2})`} unless an Actions event policy allows it, so these workflows would fail. Move them to the pull_request trigger, or add a policy that permits pull_request_target for those files.`);
  }
  if (x.persist.length) {
    const art = x.persist.filter((p) => p.artifacts);
    out.push({ id: 'wf-persist-credentials', category: 'Actions security', severity: art.length ? 'warn' : 'info', title: `${plural(x.persist.length, 'checkout')} keep the git token on disk`,
      detail: `${at(x.persist)}. actions/checkout leaves the token in .git/config unless persist-credentials is false${art.length ? `; ${art.length === 1 ? 'one of these jobs' : 'some of these jobs'} also upload${art.length === 1 ? 's' : ''} artifacts, which can carry it out` : ''}. Add "with: persist-credentials: false" to steps that never push.` });
  }
  if (x.secretsInherit.length) {
    const ext = x.secretsInherit.filter((e) => e.external);
    sec('wf-secrets-inherit', ext.length ? 'warn' : 'info', '"secrets: inherit" passes every secret to a called workflow',
      `${at(x.secretsInherit)}. ${ext.length ? 'The called workflow lives outside this repo and receives all of them.' : 'The called workflow is in this repo.'} Pass only the secrets it needs, by name.`);
  }
  if (x.botActor.length) sec('wf-bot-actor', 'warn', 'Bot check on github.actor can be spoofed', `${at(x.botActor)}. github.actor is whoever triggered the run, so a person re-running or pushing to a bot's branch can pass it. Check github.event.pull_request.user.login (the PR author) instead, and avoid pull_request_target for auto-merge.`);
  if (x.unsecure.length) sec('wf-insecure-commands', 'warn', 'Workflow turns the deprecated unsafe commands back on', `${at(x.unsecure)}. ACTIONS_ALLOW_UNSECURE_COMMANDS re-enables set-env and add-path, which let log text change the environment. Use the GITHUB_ENV and GITHUB_PATH files.`);
  if (x.envWrite.length) sec('wf-env-write', 'warn', 'Privileged workflow writes to GITHUB_ENV or GITHUB_PATH', `${at(x.envWrite)}. In a pull_request_target or workflow_run workflow that also reads PR-controlled text, a value written there can change later steps (LD_PRELOAD, PATH, NODE_OPTIONS). Write only constants, or pass values through GITHUB_OUTPUT and validate them.`);
  if (x.retired.length) up('actions-retired-runner', `${plural(x.retired.length, 'job')} use a retired runner image`, `${list(x.retired.map((r) => `${r.file}:${r.line} ${r.label}`), 4)}. GitHub has retired these images, so jobs on them never start. Move to ${x.retired[0].use}.`, 'warn');
  if (x.node20.length) up('actions-node20', `${plural(x.node20.length, 'action')} still run on Node 20 or older`, `${list([...new Set(x.node20.map((n) => n.uses))], 5)}. GitHub removed Node 20 from Actions on ${long(NODE20_UNTIL)} and runs JavaScript actions on Node 24, so these versions can fail. Update to a release that declares node24 (from the action's own releases).`, 'warn');
  if (x.deprecated.length) up('actions-deprecated-commands', 'Workflow uses deprecated ::set-output or ::save-state commands', `${at(x.deprecated)}. Write "name=value" to the $GITHUB_OUTPUT (or $GITHUB_STATE) file instead.`);
  if (x.noTimeout.length) up('actions-no-timeout', `${plural(x.noTimeout.length, 'job')} without timeout-minutes`, `${list(x.noTimeout.map((j) => `${j.file} (${j.job})`), 4)}. The default is 360 minutes, so a hung job burns up to six hours of runner time. Add a timeout-minutes that fits the job.`);
  if (x.noConcurrency.length) up('actions-no-concurrency', `${plural(x.noConcurrency.length, 'pull request workflow')} without concurrency`, `${list(x.noConcurrency.map((c) => c.file), 4)}. Each push to a PR starts a new run while the old one keeps going. A concurrency group with cancel-in-progress: true stops the superseded runs.`);
  return out;
}

module.exports = { checkWorkflowAudits };
