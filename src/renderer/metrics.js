// Dashboard maths. Pure functions over scan results, usable from the page (global `Metrics`) and
// from node tests (module.exports). No DOM here.
(function (root) {
  const DAY = 86400000;
  const DAYS_PER_YEAR = 365;
  const ageDays = (iso, now) => (iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : null);
  const bucket = (value, edges, labels) => {
    for (let i = 0; i < edges.length; i++) if (value <= edges[i]) return labels[i];
    return labels[labels.length - 1];
  };
  const SEV_ORDER = { error: 0, warn: 1, info: 2 };

  // Same grouping the Workspace overview uses: identical findings across repos collapse into one row.
  function groupFindings(repos) {
    const groups = new Map();
    for (const r of repos) for (const f of r.findings || []) {
      const title = f.title.replace(/#?\d+/g, 'N');
      const key = f.category + '|' + title;
      const g = groups.get(key) || { title, sev: f.severity, cat: f.category, repos: [], fixes: [] };
      g.repos.push(r.name);
      g.fixes.push(f.fix ? { repo: r, action: f.fix } : null);
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.repos.length - a.repos.length);
  }

  const ACTIVITY = ['Last 7 days', 'Last 30 days', 'Last 90 days', 'Last year', 'Over a year', 'Unknown'];
  const PR_AGE = ['Under 3 days', '3 to 14 days', '14 to 30 days', 'Over 30 days'];

  // repos: scan results. clutter: Map(path -> clutter result) or null when never scanned.
  function compute(allRepos, clutter = null, now = Date.now()) {
    const scanned = allRepos.filter((r) => !r.error);
    const failedScans = allRepos.length - scanned.length;
    const t = { repos: scanned.length, failedScans, errors: 0, warns: 0, infos: 0, prs: 0, failingCI: 0, dirty: 0, ahead: 0, behind: 0, alertsTotal: 0, alertsHigh: 0, mergedBranches: 0, staleBranches: 0, localOnly: 0, noLicense: 0, noReadme: 0, conflictPRs: 0, readyPRs: 0, draftPRs: 0, failingPRs: 0 };
    const grades = { A: 0, B: 0, C: 0, D: 0 };
    const cats = new Map();
    const activity = Object.fromEntries(ACTIVITY.map((l) => [l, 0]));
    const prAges = Object.fromEntries(PR_AGE.map((l) => [l, 0]));
    const perRepo = [];

    for (const r of scanned) {
      const g = r.git || {};
      let e = 0, w = 0;
      for (const f of r.findings || []) {
        if (f.severity === 'error') { t.errors++; e++; } else if (f.severity === 'warn') { t.warns++; w++; } else t.infos++;
        const c = cats.get(f.category) || { cat: f.category, error: 0, warn: 0, info: 0 };
        c[f.severity]++;
        cats.set(f.category, c);
      }
      if (grades[r.grade] != null) grades[r.grade]++;
      t.prs += (r.prs || []).length;
      t.failingCI += ((r.ci && r.ci.failed) || []).length;
      if (g.dirty > 0) t.dirty++;
      t.ahead += g.ahead || 0;
      t.behind += g.behind || 0;
      t.mergedBranches += (g.mergedBranches || []).length;
      t.staleBranches += (g.branches || []).filter((b) => !b.current && ageDays(b.date, now) >= 60 && !(g.mergedBranches || []).includes(b.name)).length;
      t.alertsTotal += (r.alerts || []).length;
      t.alertsHigh += (r.alerts || []).filter((a) => a.severity === 'high' || a.severity === 'critical').length;
      if (!r.remote) t.localOnly++;
      if (r.files && !r.files.license) t.noLicense++;
      if (r.files && !r.files.readme) t.noReadme++;
      for (const p of r.prs || []) {
        if (p.mergeable === 'CONFLICTING') t.conflictPRs++;
        if (p.statusCheckRollup === 'FAILURE') t.failingPRs++;
        if (p.isDraft) t.draftPRs++;
        if (p.reviewDecision === 'APPROVED' && p.mergeable === 'MERGEABLE' && p.statusCheckRollup !== 'FAILURE') t.readyPRs++;
        const a = ageDays(p.updatedAt, now);
        if (a != null) prAges[bucket(a, [3, 14, 30], PR_AGE)]++;
      }
      // Activity: last push if GitHub told us, else the newest local branch commit.
      const newest = (g.branches || []).map((b) => b.date).filter(Boolean).sort().pop();
      const last = ageDays((r.remote && r.remote.pushedAt) || newest, now);
      activity[last == null ? 'Unknown' : bucket(last, [7, 30, 90, DAYS_PER_YEAR], ACTIVITY)]++;
      perRepo.push({ name: r.name, path: r.path, score: r.score ?? 0, grade: r.grade, errors: e, warns: w });
    }

    perRepo.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    const avg = scanned.length ? Math.round(scanned.reduce((n, r) => n + (r.score || 0), 0) / scanned.length) : null;

    let cl = null;
    if (clutter && clutter.size) {
      const rows = [...clutter.values()].filter((c) => c.count).map((c) => ({ name: c.name, path: c.path, size: c.totalSize, count: c.count })).sort((a, b) => b.size - a.size);
      const hi = [...clutter.values()].reduce((n, c) => n + (c.items || []).filter((i) => i.confidence === 'high').reduce((m, i) => m + i.size, 0), 0);
      cl = { scannedRepos: clutter.size, items: rows.reduce((n, x) => n + x.count, 0), totalSize: rows.reduce((n, x) => n + x.size, 0), safeSize: hi, byRepo: rows };
    }

    return {
      totals: t, avg, grades,
      perRepo,
      categories: [...cats.values()].sort((a, b) => b.error * 100 + b.warn * 10 + b.info - (a.error * 100 + a.warn * 10 + a.info)),
      activity: ACTIVITY.map((label) => ({ label, count: activity[label] })),
      prAges: PR_AGE.map((label) => ({ label, count: prAges[label] })),
      attention: perRepo.filter((p) => p.errors || p.warns).slice(0, 6).map((p) => {
        const r = scanned.find((x) => x.path === p.path);
        return { ...p, top: (r.findings || [])[0] || null };
      }),
      recommendations: groupFindings(scanned).slice(0, 6),
      clutter: cl,
    };
  }


  // ---- Heatmap: repos x finding categories, cell = weighted count, coloured by worst severity ----
  const WEIGHT = { error: 3, warn: 2, info: 1 };
  function heatmap(allRepos) {
    const repos = allRepos.filter((r) => !r.error);
    const totals = new Map();
    for (const r of repos) for (const f of r.findings || []) totals.set(f.category, (totals.get(f.category) || 0) + WEIGHT[f.severity]);
    const cols = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const rows = repos.map((r) => {
      let heat = 0;
      const cells = cols.map((cat) => {
        const c = { error: 0, warn: 0, info: 0 };
        for (const f of r.findings || []) if (f.category === cat) c[f.severity]++;
        const w = c.error * 3 + c.warn * 2 + c.info;
        heat += w;
        const worst = c.error ? 'error' : c.warn ? 'warn' : c.info ? 'info' : null;
        return { ...c, worst, level: w === 0 ? 0 : w <= 2 ? 1 : w <= 5 ? 2 : 3 };
      });
      return { name: r.name, path: r.path, heat, cells };
    }).sort((a, b) => b.heat - a.heat || a.name.localeCompare(b.name));
    return { cols, rows };
  }

  // ---- Trend: one small snapshot per scan, kept on disk by the main process ----
  function snapshot(allRepos, root, now = Date.now()) {
    const m = compute(allRepos, null, now);
    const t = m.totals;
    return {
      ts: now, root: root || '', repos: t.repos, avg: m.avg,
      errors: t.errors, warns: t.warns, infos: t.infos, prs: t.prs, failingCI: t.failingCI, dirty: t.dirty, ahead: t.ahead,
      alertsHigh: t.alertsHigh, mergedBranches: t.mergedBranches, staleBranches: t.staleBranches, clutter: null, quality: null,
      scores: Object.fromEntries(m.perRepo.map((p) => [p.name, p.score])),
    };
  }

  // Score changes between two snapshots, biggest first. Repos present in only one are listed as added/removed.
  function movers(prev, cur) {
    if (!prev || !cur) return null;
    const up = [], down = [];
    for (const [name, score] of Object.entries(cur.scores || {})) {
      const before = (prev.scores || {})[name];
      if (before == null || before === score) continue;
      (score > before ? up : down).push({ name, from: before, to: score, delta: score - before });
    }
    up.sort((a, b) => b.delta - a.delta);
    down.sort((a, b) => a.delta - b.delta);
    return {
      up, down,
      added: Object.keys(cur.scores || {}).filter((n) => !(n in (prev.scores || {}))),
      removed: Object.keys(prev.scores || {}).filter((n) => !(n in (cur.scores || {}))),
    };
  }

  // delta between a live value and an earlier one; `better` is 'down' (fewer is good) or 'up'.
  function delta(now, then, better = 'down') {
    if (now == null || then == null) return null;
    const d = now - then;
    if (d === 0) return { d, dir: 0, good: null };
    return { d, dir: d > 0 ? 1 : -1, good: better === 'up' ? d > 0 : d < 0 };
  }

  // Roll code-quality scan results (one per repo) up to workspace level.
  function qualityTotals(repos) {
    const ok = repos.filter((r) => !r.error);
    const langs = new Map();
    const largest = [];
    for (const r of ok) {
      for (const l of r.languages || []) { const x = langs.get(l.lang) || { lang: l.lang, files: 0, lines: 0 }; x.files += l.files; x.lines += l.lines; langs.set(l.lang, x); }
      for (const f of (r.loc && r.loc.largest) || []) largest.push({ repo: r.name, path: f.path, lines: f.lines, measured: f.measured });
    }
    const sum = (f) => ok.reduce((n, r) => n + (f(r) || 0), 0);
    return {
      repos: ok.length, files: sum((r) => r.files), lines: sum((r) => r.lines), over: sum((r) => r.loc.overCount), magic: sum((r) => r.magic.total),
      secrets: sum((r) => r.secretCount), todos: sum((r) => r.markers.total), debug: sum((r) => r.debugCount),
      max: ok.length ? ok[0].loc.max : null,
      languages: [...langs.values()].sort((a, b) => b.lines - a.lines),
      largest: largest.sort((a, b) => b.measured - a.measured).slice(0, 10),
      magicByRepo: ok.map((r) => ({ name: r.name, path: r.path, count: r.magic.total })).filter((x) => x.count).sort((a, b) => b.count - a.count),
    };
  }

  const api = { compute, groupFindings, heatmap, snapshot, movers, delta, qualityTotals, ACTIVITY, PR_AGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Metrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
