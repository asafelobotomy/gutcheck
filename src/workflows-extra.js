// More workflow audits, read as text like workflows.js and never executed. Several mirror audits of
// zizmor (https://docs.zizmor.sh/audits/), each noted below; the rest follow GitHub's own docs.
// Every audit is quiet by design: it reports only the shape that is actually risky or stale.

const { RETIRED_RUNNERS, NODE20_MAJORS, CHECKOUT_SAFE_MAJOR } = require('./workflow-facts');

const indentOf = (l) => l.length - l.trimStart().length;
const PUSHES = /\bgit\s+(?:push|commit)\b|git-auto-commit-action|add-and-commit|create-pull-request|github-push-action/;
const major = (v) => { const m = /^v?(\d+)(?:\.|$)/.exec(v || ''); return m ? Number(m[1]) : null; };

// Jobs under `jobs:` as { name, start, end (exclusive line index), props } where `props` is the indent of
// the job's own keys.
function jobBlocks(lines) {
  const at = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (at < 0) return [];
  const live = (i) => lines[i].trim() && !lines[i].trim().startsWith('#');
  let ji = -1;
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!live(i)) continue;
    const ind = indentOf(lines[i]);
    if (ind === 0) break;
    if (ji < 0) ji = ind;
    const m = ind === ji && /^\s*['"]?([\w-]+)['"]?:/.exec(lines[i]);
    if (m) { if (out.length) out[out.length - 1].end = i; out.push({ name: m[1], start: i, end: lines.length, props: -1 }); }
    else if (out.length && out[out.length - 1].props < 0 && ind > ji) out[out.length - 1].props = ind;
  }
  return out;
}

// The lines (index range) of the step that holds line i: from its "- " line to the next sibling.
function stepRange(lines, i) {
  let s = i;
  if (!/^\s*-\s/.test(lines[i])) { const ind = indentOf(lines[i]); while (s > 0 && !(/^\s*-\s/.test(lines[s]) && indentOf(lines[s]) < ind)) s--; }
  const d = indentOf(lines[s]);
  let e = s + 1;
  while (e < lines.length && (!lines[e].trim() || indentOf(lines[e]) > d)) e++;
  return [s, e];
}

function auditExtra(lines, run, untrusted) {
  const out = { persist: [], secretsInherit: [], botActor: [], unsecure: [], envWrite: [], deprecated: [], noTimeout: [], noConcurrency: [], retired: [], node20: [], prTargetPolicy: [] };
  const code = lines.map((raw, i) => (run.has(i + 1) || raw.trimStart().startsWith('#') ? '' : raw.replace(/\s+#.*$/, '')));
  const jobs = jobBlocks(lines);
  const jobAt = (i) => jobs.find((j) => i >= j.start && i < j.end);
  const trig = (re) => code.some((l) => re.test(l));
  const prTarget = trig(/^\s*pull_request_target\s*:|^\s*on:.*\bpull_request_target\b|^\s*-\s*pull_request_target\b/);
  const workflowRun = trig(/^\s*workflow_run\s*:|^\s*on:.*\bworkflow_run\b|^\s*-\s*workflow_run\b/);
  const prTriggered = prTarget || trig(/^\s*pull_request\s*:|^\s*on:.*\bpull_request\b|^\s*-\s*pull_request\b/);
  const tainted = code.some((l) => untrusted.test(l));

  // GitHub changelog 2026-11-02: pull_request_target is blocked by default on public repos (see workflow-facts).
  if (prTarget) out.prTargetPolicy.push({});

  jobs.forEach((j) => {
    const reusable = lines.some((l, i) => i > j.start && i < j.end && indentOf(l) === j.props && /^\s*uses:/.test(l));
    // Default job timeout is 360 minutes; a hung job burns six hours of runner time.
    if (!reusable && !lines.some((l, i) => i > j.start && i < j.end && indentOf(l) === j.props && /^\s*timeout-minutes:/.test(l))) out.noTimeout.push({ line: j.start + 1, job: j.name });
  });
  if (prTriggered && jobs.length && !trig(/^\s*concurrency\s*:/)) out.noConcurrency.push({});

  lines.forEach((raw, i) => {
    const line = code[i];
    if (line) {
      // zizmor: artipacked. Checkout leaves the token in .git/config unless persist-credentials is false.
      const co = /^\s*(?:-\s+)?uses:\s*['"]?actions\/checkout@([^'"\s]+)/.exec(line);
      if (co) {
        const [s, e] = stepRange(lines, i);
        const step = lines.slice(s, e).join('\n');
        const job = jobAt(i);
        const jobText = job ? lines.slice(job.start, job.end).join('\n') : lines.join('\n');
        const ver = /^[0-9a-f]{40}$/.test(co[1]) ? (/#\s*(v?\d[\w.]*)/.exec(raw) || [])[1] : co[1];
        const v = major(ver);
        if (!/persist-credentials\s*:/.test(step) && !PUSHES.test(jobText) && !(v != null && v >= CHECKOUT_SAFE_MAJOR))
          out.persist.push({ line: i + 1, artifacts: /actions\/upload-artifact@/.test(jobText) });
      }
      // zizmor: secrets-inherit. Forwards every secret to the called workflow.
      if (/^\s*secrets:\s*inherit\s*$/.test(line)) {
        const job = jobAt(i);
        const callee = job && lines.slice(job.start, job.end).map((l) => /^\s*uses:\s*['"]?([^'"\s#]+)/.exec(l)).find(Boolean);
        out.secretsInherit.push({ line: i + 1, external: !(callee && callee[1].startsWith('./')) });
      }
      // zizmor: bot-conditions. github.actor is the user who triggered the run, not who authored the PR.
      if (/github\.(?:triggering_)?actor\s*==\s*['"][^'"]*\[bot\]['"]|['"][^'"]*\[bot\]['"]\s*==\s*github\.(?:triggering_)?actor/.test(line)) out.botActor.push({ line: i + 1 });
      // zizmor: insecure-commands.
      if (/ACTIONS_ALLOW_UNSECURE_COMMANDS\s*:\s*['"]?true\b/i.test(line)) out.unsecure.push({ line: i + 1 });
      // Retired runner labels (workflow-facts), on runs-on, matrix and list lines only.
      if (/^\s*(?:runs-on|os|runner|platform|image)\s*:|^\s*-\s*['"]?[\w.-]+['"]?\s*$|^\s*[\w-]+:\s*\[/.test(line))
        for (const tok of line.split(/[\s,[\]'"]+/)) { const r = RETIRED_RUNNERS.find((x) => x.re.test(tok)); if (r) out.retired.push({ line: i + 1, label: tok, use: r.use }); }
      // First-party actions whose action.yml said Node 20 or older (workflow-facts).
      const u = /^\s*(?:-\s+)?uses:\s*['"]?([\w.-]+\/[\w.-]+)(?:\/[^@'"\s]*)?@([^'"\s]+)/.exec(line);
      if (u && NODE20_MAJORS[u[1]]) {
        const ver = /^[0-9a-f]{40}$/.test(u[2]) ? (/#\s*(v?\d[\w.]*)/.exec(raw) || [])[1] : u[2];
        const v = major(ver);
        if (v != null && v <= NODE20_MAJORS[u[1]]) out.node20.push({ line: i + 1, uses: `${u[1]}@${ver}` });
      }
    } else if (run.has(i + 1) && !raw.trimStart().startsWith('#')) {
      // zizmor: github-env. Only where untrusted text is in play, in a privileged workflow.
      if ((prTarget || workflowRun) && tainted && /\$/.test(raw.replace(/>>.*$/, '')) && />>\s*"?\$\{?GITHUB_(?:ENV|PATH)\b/.test(raw)) out.envWrite.push({ line: i + 1 });
      if (/::(?:set-output|save-state|set-env|add-path)\b/.test(raw)) out.deprecated.push({ line: i + 1 });
    }
  });
  return out;
}

module.exports = { auditExtra, jobBlocks };
