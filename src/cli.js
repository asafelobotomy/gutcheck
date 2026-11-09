#!/usr/bin/env node
// GutCheck command line. Same scans, report and actions as the app; also starts the MCP server.
// Run with node (`node src/cli.js ...`, or `gutcheck ...` once linked) or from the AppImage
// (`GutCheck.AppImage --cli ...`, `GutCheck.AppImage --mcp`).

const { createEngine } = require('./engine');
const { version } = require('../package.json');

const HELP = `GutCheck ${version}: health checks for every git repo in a folder.

Usage: gutcheck <command> [options]

  scan [folder]                 scan and list repos, worst first (default folder: the last one scanned here, else the app's)
  new [--notify]                scan, then list only findings that were not there last scan; --notify
                                also shows a desktop notification (for a cron job or systemd timer)
  findings                      every finding; filter with --repo, --severity error|warn|info, --category
  repo <name>                   one repo in full
  report [repo]                 the Markdown fix plan ("Copy for LLM")
  clutter [repo...]             caches, temp files, stray env files (read-only)
  quality [repo...]             code-quality scan (read-only)
  tests [repo...]               test review: missing, skipped and assertion-free tests, CI gaps,
                                coverage and mutation results (read-only); run them with
                                fix <repo> tests-run kind=coverage|mutation --yes
  workspace                     workspace and machine advice (git config, disk, AI agent setup)
  secrets                       secret files that exist only on this machine (env files, keys,
                                credentials in your home folder) and whether they are backed up
  secrets --backup [--yes]      preview copying every unbacked or changed one into the password
                                manager linked in the app; --yes runs it
  secrets --verify              check the backed-up items are still in the password manager
  secrets --skip <path> <reason...>
                                don't back up that file (shown as skipped, with the reason)
  actions                       actions that fix accepts, with parameters
  fix <repo> <finding|action> [key=value...]
                                plan a fix and show the exact commands; add --yes to run them
                                (and --confirm <repo name> for dangerous ones)
  fix <repo> all                every automatic fix for the repo in run order, and the choices
                                only you can make (commit message, PRs...) with how to make them
  ignore <repo> <finding> <reason...>
                                accept a finding: it leaves the score and report, shown with the
                                reason (--all for every repo, a trailing * matches a prefix)
  unignore <repo> <finding>     stop ignoring it (--all for an every-repo ignore)
  ignored                       every ignored finding and why
  drift                         compare every repo with your baseline (baseline.json)
  baseline init                 create a starting baseline.json to edit
  agents usage [--live --yes]   which skills, plugins and MCP servers your agents use (reads only tool
                                names from Claude Code's transcripts); --live --yes also starts each
                                MCP server once to see whether it works
  history                       changes GutCheck has made
  mcp [--allow-actions]         run as an MCP server on stdio (read-only unless --allow-actions)

Options: --root <folder>  --deep  --json  --yes  --confirm <name>  --help  --version
`;

// key=value pairs for fix: numbers and booleans are converted, a,b,c becomes a list for list params.
const LIST_PARAMS = new Set(['branches', 'paths', 'entries', 'hashes']);
function parseValue(k, v) {
  if (LIST_PARAMS.has(k)) return v.split(',').map((x) => x.trim()).filter(Boolean);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function parseArgs(argv) {
  const o = { _: [], flags: {} };
  const takesValue = new Set(['root', 'repo', 'severity', 'category', 'confirm', 'limit', 'skip']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (takesValue.has(k)) o.flags[k] = inline !== undefined ? inline : argv[++i];
      else o.flags[k] = true;
    } else o._.push(a);
  }
  return o;
}

const icon = { error: '✖', warn: '!', info: '·' };

function printRepos(r, out) {
  out(`${r.root}: ${r.count} repos, average health ${r.averageScore ?? '-'}/100\n`);
  for (const x of r.repos) {
    if (x.error) { out(`  ${x.name.padEnd(28)} scan failed: ${x.error}`); continue; }
    const git = [x.dirty ? `${x.dirty} uncommitted` : '', x.ahead ? `${x.ahead} unpushed` : '', x.behind ? `${x.behind} behind` : ''].filter(Boolean).join(', ');
    out(`  ${x.grade} ${String(x.score).padStart(3)}  ${x.name.padEnd(28)} ${x.errors}E ${x.warnings}W ${x.info}I${git ? `  (${git})` : ''}`);
  }
}

function printFindings(r, out) {
  let last = null;
  for (const f of r.findings) {
    if (f.repo !== last) { out(`\n${f.repo}`); last = f.repo; }
    out(`  ${icon[f.severity]} ${f.title}  [${f.id}]${f.fix ? `  fix: gutcheck fix ${f.repo} ${f.id}` : ''}`);
    if (f.detail) out(`      ${String(f.detail).slice(0, 300)}`);
  }
  out(`\n${r.total} finding(s)${r.total > r.findings.length ? `, first ${r.findings.length} shown (--limit)` : ''}.`);
}

// gutcheck fix <repo> all: every automatic fix in run order; --yes runs them (each plan in turn).
async function fixAll(engine, repo, f, out, err) {
  const p = await engine.plan({ items: [{ repo, all: true }] });
  if (!p.ok) { err(`gutcheck: ${p.error}`); return 1; }
  const plans = p.plans.filter((x) => x.ok);
  for (const x of p.plans.filter((y) => !y.ok)) err(`gutcheck: ${x.error}`);
  plans.forEach((x, i) => { out(`${i + 1}. ${x.title}  (risk: ${x.risk})`); x.commands.forEach((c) => out(`     $ ${c}`)); });
  for (const d of (p.decisions || []).flatMap((r) => r.decisions)) {
    out(`\nYour call: ${d.title}`);
    for (const c of d.choices) out(`  - ${c.label}${c.fields ? ` (needs ${c.fields.join(', ')})` : ''}`);
    out(`  Run it yourself: gutcheck fix ${repo} ${d.finding}${d.choices[0].fields ? d.choices[0].fields.map((k) => ` ${k}="..."`).join('') : ''}`);
  }
  if (!plans.length) { out('Nothing to fix automatically.'); return 0; }
  if (!f.yes) { out('\nNothing was run. Add --yes to run exactly these commands, in this order.'); return 0; }
  const confirm = Object.fromEntries(plans.filter((x) => x.confirmName).map((x) => [x.token, f.confirm]));
  if (Object.keys(confirm).length && f.confirm !== plans.find((x) => x.confirmName).confirmName) { err(`gutcheck: some steps are dangerous: add --confirm ${plans.find((x) => x.confirmName).confirmName}`); return 1; }
  const r = await engine.apply({ tokens: plans.map((x) => x.token), confirm });
  for (const x of r.results) { out(`${x.ok ? 'ok     ' : x.skipped ? 'SKIPPED' : 'FAILED '}  ${x.title || ''}`); if (x.error) err(`gutcheck: ${x.error}`); }
  return r.ok ? 0 : 1;
}

// gutcheck secrets: the status table, or --backup [--yes], --verify, --skip <path> <reason...>.
async function secretsCmd(engine, f, rest, out, err, json) {
  const fail = (r) => { err(`gutcheck: ${r.error}`); return 1; };
  if (Object.prototype.hasOwnProperty.call(f, 'skip')) {
    const r = await engine.secretsSkip(typeof f.skip === 'string' ? f.skip : '', rest.join(' '));
    if (!r.ok) return fail(r);
    out(`Not backing up ${f.skip}: ${rest.join(' ')}`);
    return 0;
  }
  if (f.verify) {
    const r = await engine.secretsVerify();
    if (!r.ok) return fail(r);
    if (f.json) json(r); else out(`Checked ${r.checked}: ${r.missing} missing from the password manager, ${r.mismatch} with a different key.`);
    return 0;
  }
  const list = await engine.secrets();
  if (!list.ok) return fail(list);
  if (!f.backup) {
    if (f.json) { json(list); return 0; }
    out(list.linked ? `Password manager: ${list.tool}\n` : 'No password manager linked: link one in the GutCheck app (Secrets > Password manager…).\n');
    for (const x of list.items) out(`  ${x.status.padEnd(9)} ${x.kind.padEnd(5)} ${String(x.size).padStart(8)}  ${x.title.replace(/^gutcheck: /, '')}${x.note ? `  (${x.note})` : ''}${x.sameAs ? '  (same as a backed-up file)' : ''}`);
    if (!list.items.length) out('No secret files found.');
    return 0;
  }
  // Everything unbacked or changed that can be saved as one file; probable test keys are left to the app.
  const todo = list.items.filter((x) => x.saveable && x.confidence !== 'low' && !['backed', 'skipped'].includes(x.status));
  if (!todo.length) { out('Nothing to back up.'); return 0; }
  const p = await engine.secretsPlan(todo.map((x) => x.path));
  if (!p.ok) return fail(p);
  out(`${p.title}  (risk: ${p.risk})`);
  p.display.forEach((d) => out(`  $ ${d.text}`));
  out(`  ${p.note}`);
  if (!f.yes) { out('\nNothing was run. Add --yes to run exactly these commands.'); return 0; }
  const r = await engine.secretsApply(p.token);
  if (r.error) err(`gutcheck: ${r.error}`);
  for (const x of r.results || []) out(`  ${x.ok ? 'ok    ' : 'FAILED'}  ${x.text}${x.out ? `\n    ${x.out.replace(/\n/g, '\n    ')}` : ''}`);
  return r.ok ? 0 : 1;
}

async function main(argv, { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), env = process.env } = {}) {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  const f = a.flags;
  if (f.version) { out(version); return 0; }
  if (!cmd || f.help || cmd === 'help') { out(HELP); return cmd || f.help ? 0 : 1; }
  if (cmd === 'mcp') { await require('./mcp').start({ allowActions: !!f['allow-actions'] }); return 0; }

  // fix is explicit, so the CLI may plan; it still runs nothing without --yes.
  const engine = createEngine({ allowActions: cmd === 'fix', env, via: 'cli' });
  const json = (v) => out(JSON.stringify(v, null, 2));
  const scanned = async () => {
    const s = await engine.scan({ root: f.root || (cmd === 'scan' ? rest[0] : undefined), deep: !!f.deep, recordSeen: cmd === 'new', onProgress: (d, t) => { if (process.stderr.isTTY) process.stderr.write(`\rScanning ${d}/${t}…`); } });
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    return s;
  };
  const done = (r, print) => {
    if (!r.ok) { err(`gutcheck: ${r.error}`); return 1; }
    if (f.json || !print) json(r); else print(r, out);
    return 0;
  };

  if (cmd === 'actions') return done(engine.actions());
  if (cmd === 'baseline') {
    if (rest[0] !== 'init') { err('gutcheck: usage: gutcheck baseline init'); return 1; }
    const r = await engine.drift({ init: true });
    out(`${r.created ? 'Created' : 'Already there'}: ${r.file}. Edit "require" and "skip" in it, then run gutcheck drift.`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'history') return done(engine.history({ limit: Number(f.limit) || 50 }), (r) => r.entries.forEach((e) => out(`${e.ts}  ${e.ok ? 'ok    ' : 'FAILED'}  ${e.repo}: ${e.title}${e.via ? `  (${e.via})` : ''}`)));

  const s = await scanned();
  if (!s.ok && cmd !== 'scan') { err(`gutcheck: ${s.error}`); return 1; }
  switch (cmd) {
    case 'scan': if (!s.ok) { err(`gutcheck: ${s.error}`); return 1; } return done(await engine.repos(), printRepos);
    case 'findings': return done(await engine.findings({ repo: f.repo, severity: f.severity, category: f.category, limit: Number(f.limit) || 1000 }), printFindings);
    case 'new': {
      const r = await engine.fresh();
      if (!r.ok || f.json) return done(r);
      if (!r.compared) { out('First scan of this workspace: nothing to compare with yet. The next run lists what is new.'); return 0; }
      if (!r.findings.length) { out('No new findings since the last scan.'); return 0; }
      r.findings.forEach((x) => out(`${icon[x.severity]} ${x.repo}: ${x.title}  [${x.id}]`));
      if (f.notify) {
        const n = require('./schedule').notification(r.findings); // warnings and errors only, as in the app
        if (n) await require('./exec').run('notify-send', ['--app-name=GutCheck', n.title, n.body]);
      }
      return 0;
    }
    case 'ignore': case 'unignore': {
      const [repo, id, ...why] = f.all ? [null, ...rest] : rest;
      const r = await engine.ignore({ repo, finding: id, reason: why.join(' '), remove: cmd === 'unignore', allRepos: !!f.all });
      return done(r, (x) => out(`${cmd === 'ignore' ? `Ignoring ${x.id} in ${x.key === '*' ? 'every repo' : x.key}: ${x.reason}` : `No longer ignoring ${x.id} in ${x.key === '*' ? 'every repo' : x.key}`}  (${x.file})`));
    }
    case 'ignored': return done(await engine.ignored(), (r) => { if (!r.findings.length) out('Nothing is ignored.'); r.findings.forEach((x) => out(`${x.repo}: ${x.title}  [${x.id}]\n    ${x.from}: ${x.reason}`)); });
    case 'drift': return done(await engine.drift(), (r) => {
      if (!r.rules) { out(r.note); return; }
      out(`Baseline: ${r.file}\n`);
      for (const x of r.rules) out(`  ${x.missing.length ? '!' : '✓'} ${x.label.padEnd(34)} ${x.ok} ok${x.missing.length ? `, missing in ${x.missing.join(', ')}` : ''}`);
    });
    case 'agents': {
      if (rest[0] !== 'usage') { err('gutcheck: usage: gutcheck agents usage [--live --yes]'); return 1; }
      if (f.live && !f.yes) { err('gutcheck: --live starts every configured MCP server (runs their code). Add --yes to agree.'); return 1; }
      return done(await engine.agentUsage({ live: !!(f.live && f.yes) }), (r) => {
        out(`${r.sessions} sessions in the last 28 days; ${r.inventory.plugins} plugins, ${r.inventory.servers} MCP servers, ${r.inventory.skills} skills.`);
        for (const s of r.servers || []) out(`  ${s.status === 'working' ? '✓' : s.status === 'needs-auth' ? '!' : '✖'} ${s.name}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
        for (const x of r.items) out(`${icon[x.severity]} ${x.title}\n    ${x.detail}${x.fix ? `\n    Fix in the app (Settings > AI agents > Check usage) or: ${x.fix.type === 'permissions-prune' ? `gutcheck fix ${x.repo} permissions-prune hashes=${x.fix.hashes.join(',')}` : x.fix.label}` : ''}`);
        if (!r.items.length) out('Everything you have set up was used, and nothing is broken.');
        if (r.note) out(r.note);
      });
    }
    case 'repo': return done(await engine.repoDetail({ repo: rest[0] }));
    case 'report': { const r = await engine.report({ repo: rest[0] }); if (!r.ok) return done(r); out(r.text); return 0; }
    case 'clutter': return done(await engine.clutter({ repos: rest }));
    case 'quality': return done(await engine.quality({ repos: rest }));
    case 'tests': return done(await engine.tests({ repos: rest }), (r) => r.repos.forEach((x) => { out(`\n${x.name}: ${x.testCases} tests in ${x.testFiles} files${x.results && x.results.coverage ? `, coverage ${x.results.coverage.percent}%` : ''}${x.results && x.results.mutation ? `, mutation score ${x.results.mutation.score}%` : ''}`); (x.advice || []).forEach((a) => out(`  ${icon[a.severity]} ${a.title}${a.fix ? `  (gutcheck fix ${x.name} tests-run kind=${a.fix.kind}${a.fix.stack ? ` stack=${a.fix.stack}` : ''})` : ''}\n      ${String(a.detail).slice(0, 300)}`)); }));
    case 'secrets': return secretsCmd(engine, f, rest, out, err, json);
    case 'workspace': return done(await engine.workspace(), (r) => r.advice.forEach((x) => out(`${icon[x.severity]} ${x.title}\n    ${x.detail}${x.ref ? `\n    Source: ${x.ref}` : ''}`)));
    case 'fix': {
      const [repo, what, ...kv] = rest;
      if (!repo || !what) { err('gutcheck: usage: gutcheck fix <repo> <finding-id | action-type> [key=value...]'); return 1; }
      if (what === 'all') return fixAll(engine, repo, f, out, err);
      const isAction = Object.prototype.hasOwnProperty.call(engine.actions().actions, what);
      const params = Object.fromEntries(kv.map((p) => p.split(/=(.*)/s)).filter(([k]) => k).map(([k, v]) => [k, parseValue(k, v ?? '')]));
      const p = await engine.plan({ items: [isAction ? { repo, action: { type: what, ...params } } : { repo, finding: what, params }] });
      if (!p.ok) return done(p);
      const plan = p.plans[0];
      if (!plan.ok) { err(`gutcheck: ${plan.error}`); return 1; }
      out(`${plan.title}  (risk: ${plan.risk}, ${plan.repo})`);
      plan.commands.forEach((c) => out(`  $ ${c}`));
      (plan.warnings || []).forEach((w) => out(`  ! ${w}`));
      if (plan.undo) out(`  undo: ${plan.undo}`);
      if (!f.yes) { out('\nNothing was run. Add --yes to run exactly these commands.'); return 0; }
      if (plan.confirmName && f.confirm !== plan.confirmName) { err(`gutcheck: dangerous action: add --confirm ${plan.confirmName}`); return 1; }
      const r = await engine.apply({ tokens: [plan.token], confirm: plan.confirmName ? { [plan.token]: f.confirm } : {} });
      for (const x of r.results) { if (x.error) err(`gutcheck: ${x.error}`); for (const st of x.steps) out(`  ${st.ok ? 'ok' : 'FAILED'}  ${st.cmd}${st.output ? `\n    ${st.output.replace(/\n/g, '\n    ')}` : ''}`); }
      return r.ok ? 0 : 1;
    }
    default: err(`gutcheck: unknown command "${cmd}". Try gutcheck --help.`); return 1;
  }
}

if (require.main === module) {
  // `gutcheck findings | head` closes the pipe early: stop quietly instead of throwing EPIPE.
  for (const st of [process.stdout, process.stderr]) st.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`gutcheck: ${e && e.stack}\n`); process.exitCode = 1; });
}

module.exports = { main, parseArgs, parseValue };
