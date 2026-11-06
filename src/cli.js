#!/usr/bin/env node
// GutCheck command line. Same scans, report and actions as the app; also starts the MCP server.
// Run with node (`node src/cli.js ...`, or `gutcheck ...` once linked) or from the AppImage
// (`GutCheck.AppImage --cli ...`, `GutCheck.AppImage --mcp`).

const { createEngine } = require('./engine');
const { version } = require('../package.json');

const HELP = `GutCheck ${version}: health checks for every git repo in a folder.

Usage: gutcheck <command> [options]

  scan [folder]                 scan and list repos, worst first (default folder: the one last scanned)
  findings                      every finding; filter with --repo, --severity error|warn|info, --category
  repo <name>                   one repo in full
  report [repo]                 the Markdown fix plan ("Copy for LLM")
  clutter [repo...]             caches, temp files, stray env files (read-only)
  quality [repo...]             code-quality scan (read-only)
  tests [repo...]               test review: missing, skipped and assertion-free tests, CI gaps,
                                coverage and mutation results (read-only); run them with
                                fix <repo> tests-run kind=coverage|mutation --yes
  workspace                     workspace and machine advice (git config, disk, AI agent setup)
  actions                       actions that fix accepts, with parameters
  fix <repo> <finding|action> [key=value...]
                                plan a fix and show the exact commands; add --yes to run them
                                (and --confirm <repo name> for dangerous ones)
  history                       changes GutCheck has made
  mcp [--allow-actions]         run as an MCP server on stdio (read-only unless --allow-actions)

Options: --root <folder>  --deep  --json  --yes  --confirm <name>  --help  --version
`;

// key=value pairs for fix: numbers and booleans are converted, a,b,c becomes a list for list params.
const LIST_PARAMS = new Set(['branches', 'paths', 'entries']);
function parseValue(k, v) {
  if (LIST_PARAMS.has(k)) return v.split(',').map((x) => x.trim()).filter(Boolean);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function parseArgs(argv) {
  const o = { _: [], flags: {} };
  const takesValue = new Set(['root', 'repo', 'severity', 'category', 'confirm', 'limit']);
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
    const s = await engine.scan({ root: f.root || (cmd === 'scan' ? rest[0] : undefined), deep: !!f.deep, onProgress: (d, t) => { if (process.stderr.isTTY) process.stderr.write(`\rScanning ${d}/${t}…`); } });
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    return s;
  };
  const done = (r, print) => {
    if (!r.ok) { err(`gutcheck: ${r.error}`); return 1; }
    if (f.json || !print) json(r); else print(r, out);
    return 0;
  };

  if (cmd === 'actions') return done(engine.actions());
  if (cmd === 'history') return done(engine.history({ limit: Number(f.limit) || 50 }), (r) => r.entries.forEach((e) => out(`${e.ts}  ${e.ok ? 'ok    ' : 'FAILED'}  ${e.repo}: ${e.title}${e.via ? `  (${e.via})` : ''}`)));

  const s = await scanned();
  if (!s.ok && cmd !== 'scan') { err(`gutcheck: ${s.error}`); return 1; }
  switch (cmd) {
    case 'scan': if (!s.ok) { err(`gutcheck: ${s.error}`); return 1; } return done(await engine.repos(), printRepos);
    case 'findings': return done(await engine.findings({ repo: f.repo, severity: f.severity, category: f.category, limit: Number(f.limit) || 1000 }), printFindings);
    case 'repo': return done(await engine.repoDetail({ repo: rest[0] }));
    case 'report': { const r = await engine.report({ repo: rest[0] }); if (!r.ok) return done(r); out(r.text); return 0; }
    case 'clutter': return done(await engine.clutter({ repos: rest }));
    case 'quality': return done(await engine.quality({ repos: rest }));
    case 'tests': return done(await engine.tests({ repos: rest }), (r) => r.repos.forEach((x) => { out(`\n${x.name}: ${x.testCases} tests in ${x.testFiles} files${x.results && x.results.coverage ? `, coverage ${x.results.coverage.percent}%` : ''}${x.results && x.results.mutation ? `, mutation score ${x.results.mutation.score}%` : ''}`); (x.advice || []).forEach((a) => out(`  ${icon[a.severity]} ${a.title}${a.fix ? `  (gutcheck fix ${x.name} tests-run kind=${a.fix.kind}${a.fix.stack ? ` stack=${a.fix.stack}` : ''})` : ''}\n      ${String(a.detail).slice(0, 300)}`)); }));
    case 'workspace': return done(await engine.workspace(), (r) => r.advice.forEach((x) => out(`${icon[x.severity]} ${x.title}\n    ${x.detail}${x.ref ? `\n    Source: ${x.ref}` : ''}`)));
    case 'fix': {
      const [repo, what, ...kv] = rest;
      if (!repo || !what) { err('gutcheck: usage: gutcheck fix <repo> <finding-id | action-type> [key=value...]'); return 1; }
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
