// Application logic behind the IPC handlers, with every Electron/disk dependency injected so it can
// be tested without Electron. main.js only does the wiring (trusted-sender check, dialogs, window).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const actions = require('./actions');
const github = require('./github');
const { scanRepo } = require('./scanner');
const { scanClutter, workspaceAdvice } = require('./clutter');
const { devAdvice } = require('./workspace');
const { buildReport } = require('./report');
const Metrics = require('./renderer/metrics');
const { scanQuality, normalizeSettings, LINE_LIMITS } = require('./quality');
const { scanTests } = require('./tests');
const { createSecretsService } = require('./secrets-glue');

const { DAYS_PER_YEAR } = require('./util');

const PLAN_TTL = 5 * 60 * 1000;
const TREND_MAX = DAYS_PER_YEAR; // about a year of daily snapshots kept on disk
const TREND_MERGE_MS = 10 * 60 * 1000; // scans closer together than this replace each other

const publicPlan = (token, p) => ({ ok: true, token, type: p.type, repoPath: p.repoPath, repoName: p.repoName, title: p.title, risk: p.risk, display: p.display, warnings: p.warnings, undo: p.undo, body: p.body, note: p.note, confirmName: p.confirmName, runsRepoCode: !!p.runsRepoCode });

// deps: { known: Map(path -> scan result), settings: () => obj, audit: (entry) => void,
//         trash: (path) => Promise, clipboard: { writeText }, rescan?: (dir) => Promise<result>,
//         trendStore?: { read(): array, write(array) }, updateSettings?: (patch) => settings,
//         secretsCtl?: createSecretsCtl() (the secrets scan and backup; left out, there is no secrets section) }
function createService({ known, settings, audit, trash, clipboard = { writeText() {} }, rescan = (d) => scanRepo(d, { deep: false }), trendStore = null, updateSettings = () => ({}), secretsCtl = null }) {
  const plans = new Map(); // token -> { plan, expires } (only these stored plans can ever run)
  const busy = new Set(); // repo paths with an action in flight
  let clutterScanning = false;
  let qualityScanning = false;
  let testsScanning = false;
  const secrets = secretsCtl ? createSecretsService({ ctl: secretsCtl, known, settings }) : null;
  // Read-only: secret files in the repos (`dirs` limits them), the workspace root and home, with their backup status.
  const secretsScan = (dirs) => (secrets ? secrets.scan(dirs) : { ok: false, error: 'Secrets are not available here.' });

  // ---- Trend history: a small snapshot per scan (scores and totals only), local to this machine ----
  const rootKey = (r) => (r ? path.resolve(r) : ''); // '/w' and '/w/' are the same workspace
  const loadTrend = () => {
    try { const a = trendStore && trendStore.read(); return Array.isArray(a) ? a.filter((e) => e && typeof e.ts === 'number') : []; } catch { return []; }
  };
  const saveTrend = (a) => { try { if (trendStore) trendStore.write(a.slice(-TREND_MAX)); } catch {} };

  function recordScan(root, results) {
    if (!trendStore || !results || !results.length) return;
    const snap = Metrics.snapshot(results, rootKey(root));
    const all = loadTrend();
    const last = all[all.length - 1];
    if (last && last.root === snap.root && snap.ts - last.ts < TREND_MERGE_MS) {
      snap.clutter = last.clutter ?? null; // keep a clutter size measured for the scan being replaced
      all.pop();
    }
    all.push(snap);
    saveTrend(all);
  }

  // Attach a measurement from an on-demand scan (clutter, code quality) to the newest snapshot of this workspace.
  function stampTrend(root, field, value) {
    const all = loadTrend();
    for (let i = all.length - 1; i >= 0; i--) if (all[i].root === rootKey(root)) { all[i][field] = value; saveTrend(all); return; }
  }

  const trend = () => loadTrend().filter((e) => e.root === rootKey(settings().root)).slice(-90);

  async function planActions(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 200) return [{ ok: false, error: 'Bad request' }];
    const readOnly = !!settings().readOnly;
    const out = [];
    for (const it of items) {
      const repo = it && known.get(it.dir);
      const p = await actions.plan(repo, it && it.action, { readOnly });
      if (!p.ok) { out.push({ ...p, repoName: repo && repo.name }); continue; }
      const token = crypto.randomBytes(16).toString('hex');
      plans.set(token, { plan: p, expires: Date.now() + PLAN_TTL });
      out.push(publicPlan(token, p));
    }
    for (const [t, v] of plans) if (v.expires < Date.now()) plans.delete(t);
    return out;
  }

  // opts.confirm: { token: repo name } must name the repo for every danger plan, from every caller:
  // the app passes what the user typed in its review dialog, the CLI and MCP what the caller passed.
  // Plans run in order, and a failed one stops the rest for the same repo (a failed pull must not be
  // followed by a commit and push); other repos carry on. opts.failed (a Set of repo paths) carries
  // that across calls that apply one token at a time.
  async function applyActions(tokens, opts = {}) {
    if (!Array.isArray(tokens)) return [];
    const out = [];
    const failed = opts.failed instanceof Set ? opts.failed : new Set();
    // A plan counts as fresh if it was when the batch started: a long Fix all (an install, test runs)
    // must not expire the later steps the user already reviewed. opts.startedAt carries it across calls.
    const started = typeof opts.startedAt === 'number' ? opts.startedAt : Date.now();
    const note = (r, p) => { if (!r.ok && p) failed.add(p.repoPath); out.push(r); };
    for (const token of tokens) {
      const entry = plans.get(token);
      plans.delete(token); // single use
      if (!entry || entry.expires < started) { out.push({ ok: false, error: 'Plan expired. Please review it again.' }); continue; }
      const p = entry.plan;
      if (failed.has(p.repoPath)) { out.push({ ok: false, skipped: true, repoName: p.repoName, title: p.title, error: 'Skipped: an earlier change to this repo failed, so the rest did not run.' }); continue; }
      if (p.confirmName && !(opts.confirm && opts.confirm[token] === p.confirmName)) { note({ ok: false, repoName: p.repoName, title: p.title, error: `This is a dangerous action: confirm it by passing the repo name "${p.confirmName}" for this token.` }, p); continue; }
      if (!known.has(p.repoPath)) { note({ ok: false, repoName: p.repoName, title: p.title, error: 'This repo is no longer in the scanned workspace.' }, p); continue; }
      if (settings().readOnly) { note({ ok: false, repoName: p.repoName, title: p.title, error: 'Read-only mode is on.' }, p); continue; }
      if (busy.has(p.repoPath)) { note({ ok: false, repoName: p.repoName, title: p.title, error: 'Another action is running on this repo.' }, p); continue; }
      busy.add(p.repoPath);
      try {
        // An earlier plan in the batch (a pull) may have brought hooks, filters or settings since the preview.
        const held = await actions.recheck(p);
        if (held) { note({ ok: false, held: true, repoName: p.repoName, title: p.title, error: held }, p); continue; }
        const r = await actions.apply(p, { trash });
        audit({ repo: p.repoName, path: p.repoPath, action: p.type, risk: p.risk, title: p.title, ok: r.ok, steps: r.results.map((x) => ({ cmd: x.text, ok: x.ok })) });
        let res = null;
        try { res = await rescan(p.repoPath); if (known.has(p.repoPath)) known.set(p.repoPath, res); } catch {}
        note({ ok: r.ok, repoName: p.repoName, title: p.title, results: r.results, res, rate: github.getRate() }, p);
      } finally {
        busy.delete(p.repoPath);
      }
    }
    return out;
  }

  // activeAt: newest of the last push and the newest local branch commit.
  const activeAt = (r) => [(r.remote && r.remote.pushedAt), ...((r.git && r.git.branches) || []).map((b) => b.date)].filter(Boolean).sort().pop() || null;
  const wsRepos = () => [...known.values()].filter((r) => !r.error).map((r) => ({ path: r.path, name: r.name, originUrl: r.originUrl, activeAt: activeAt(r), identity: r.gitState && r.gitState.identity }));
  const wsAdvice = async (root) => {
    if (!root || !fs.existsSync(root)) return null;
    try { return [...(await workspaceAdvice(root, wsRepos())), ...(await devAdvice(wsRepos()))]; } catch { return null; }
  };

  // Read-only. `dirs` (optional) limits the scan to those repos, otherwise every known repo.
  async function clutterScan(dirs) {
    if (clutterScanning) return { ok: false, error: 'A clutter scan is already running' };
    const targets = (Array.isArray(dirs) && dirs.length ? dirs : [...known.keys()]).filter((d) => known.has(d) && !known.get(d).error);
    if (!targets.length) return { ok: false, error: 'Scan a workspace first.' };
    clutterScanning = true;
    try {
      const repos = [];
      for (const d of targets) {
        try {
          repos.push({ path: d, name: path.basename(d), ...(await scanClutter(d)) });
        } catch (e) {
          repos.push({ path: d, name: path.basename(d), items: [], advice: [], count: 0, totalSize: 0, error: String(e.message || e) });
        }
      }
      const full = !(Array.isArray(dirs) && dirs.length);
      if (full) stampTrend(settings().root, 'clutter', repos.reduce((n, r) => n + (r.totalSize || 0), 0));
      return { ok: true, repos, workspace: full ? await wsAdvice(settings().root) : null };
    } finally {
      clutterScanning = false;
    }
  }

  const qualitySettings = () => normalizeSettings(settings().quality);
  function setQualitySettings(patch) {
    const cur = qualitySettings();
    const next = normalizeSettings({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) }, cur); // a bad field keeps its current value
    updateSettings({ quality: next });
    return next;
  }

  // Read-only code-quality scan (file length, magic numbers, secrets, markers...). `dirs` limits it to those repos.
  async function qualityScan(dirs) {
    if (qualityScanning) return { ok: false, error: 'A code-quality scan is already running' };
    const targets = (Array.isArray(dirs) && dirs.length ? dirs : [...known.keys()]).filter((d) => known.has(d) && !known.get(d).error);
    if (!targets.length) return { ok: false, error: 'Scan a workspace first.' };
    qualityScanning = true;
    try {
      const cfg = qualitySettings();
      const repos = [];
      for (const d of targets) {
        try { repos.push({ path: d, name: path.basename(d), ...(await scanQuality(d, cfg)) }); } catch (e) { repos.push({ path: d, name: path.basename(d), error: String(e.message || e), advice: [], files: 0, lines: 0, loc: { max: cfg.maxLines, overCount: 0, over: [], largest: [] }, magic: { total: 0, files: [], repeated: [], reuse: [], constants: { files: [], definitions: 0 } }, markers: { total: 0, items: [] }, secretCount: 0, debugCount: 0, languages: [] }); }
      }
      if (!(Array.isArray(dirs) && dirs.length)) {
        const sum = (f) => repos.reduce((n, r) => n + f(r), 0);
        stampTrend(settings().root, 'quality', { over: sum((r) => r.loc.overCount), magic: sum((r) => r.magic.total), secrets: sum((r) => r.secretCount), todos: sum((r) => r.markers.total) });
      }
      return { ok: true, repos, settings: cfg, limits: LINE_LIMITS };
    } finally {
      qualityScanning = false;
    }
  }

  // Read-only test review (static review + existing results). `dirs` limits it to those repos.
  async function testsScan(dirs) {
    if (testsScanning) return { ok: false, error: 'A test review is already running' };
    const targets = (Array.isArray(dirs) && dirs.length ? dirs : [...known.keys()]).filter((d) => known.has(d) && !known.get(d).error);
    if (!targets.length) return { ok: false, error: 'Scan a workspace first.' };
    testsScanning = true;
    try {
      const repos = [];
      for (const d of targets) {
        try { repos.push({ path: d, name: path.basename(d), ...(await scanTests(d)) }); } catch (e) { repos.push({ path: d, name: path.basename(d), error: String(e.message || e), advice: [], stacks: [], runnable: [], results: {}, testCases: 0, testFiles: 0 }); }
      }
      return { ok: true, repos };
    } finally {
      testsScanning = false;
    }
  }

  // Build the "Copy for LLM" report from the last scan (one repo, or the whole workspace).
  async function reportText(dir) {
    const repos = dir ? [known.get(dir)].filter(Boolean) : [...known.values()];
    if (!repos.length) return { ok: false, error: dir ? 'Unknown repo' : 'Scan a workspace first.' };
    const clutter = new Map();
    for (const r of repos) {
      if (r.error) continue;
      try { clutter.set(r.path, await scanClutter(r.path)); } catch {}
    }
    const quality = new Map();
    const qcfg = qualitySettings();
    for (const r of repos) {
      if (r.error) continue;
      try { quality.set(r.path, await scanQuality(r.path, qcfg)); } catch {}
    }
    const tests = new Map();
    for (const r of repos) {
      if (r.error) continue;
      try { tests.set(r.path, await scanTests(r.path)); } catch {}
    }
    const root = settings().root;
    const sec = secrets ? await secrets.reportAdvice(dir) : { byPath: new Map(), workspace: [] };
    const workspace = dir ? [] : [...sec.workspace, ...((await wsAdvice(root)) || [])];
    const text = buildReport({ repos, clutter, quality, tests, secrets: sec.byPath, workspace, root: dir ? null : root });
    return { ok: true, text, repos: repos.length };
  }

  // The same report, put on the clipboard (the app's Copy for LLM button).
  async function copyReport(dir) {
    const r = await reportText(dir);
    if (!r.ok) return r;
    clipboard.writeText(r.text);
    return { ok: true, chars: r.text.length, repos: r.repos };
  }

  const forgetPlans = () => plans.clear();
  const hasPlans = () => [...plans.values()].some((v) => v.expires >= Date.now()); // a review may be open

  return { planActions, applyActions, forgetPlans, hasPlans, clutterScan, qualityScan, testsScan, secretsScan, secrets, qualitySettings, setQualitySettings, reportText, copyReport, wsAdvice, recordScan, trend };
}

module.exports = { createService };
