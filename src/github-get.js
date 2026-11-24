// Getting repos from GitHub into the workspace folder: a live search of GitHub, your own repos with
// whether each one is here already, and clone or fork plans that follow the app's plan, preview,
// apply flow. Every name is checked against GitHub's own rules (remote-settings.js) before it
// reaches a command line, the search text only ever goes to gh as one -f value, and a clone never
// lands outside the workspace folder or on top of a folder that is already there.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run: execRun } = require('./exec');
const { listRemote } = require('./remote-list');
const { validRef } = require('./remote-settings');

const PLAN_TTL = 5 * 60 * 1000;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000; // a big repo over a slow line
const SEARCH_MAX = 20; // one short page: the search is for finding a repo, not browsing
const QUERY_MAX = 200;
const MAX_ITEMS = 50;

const clean = (s, max = 300) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max);
const keyOf = (r) => `${r.owner}/${r.name}`.toLowerCase();
const firstLine = (s) => clean(String(s || '').trim().split('\n')[0]) || 'GitHub request failed';

// deps: { run = exec.run, io = fs, root: () => the workspace folder or null, local: () => [{ path, owner, name }]
//         (the workspace's clones and their GitHub origin), readOnly: () => bool, audit(entry),
//         adopt?: (dir, replaceKey) => Promise<scan result|null> (adds a new clone to the workspace) }
function createGitHubGet({ run = execRun, io = fs, root, local, readOnly = () => false, audit = () => {}, adopt = async () => null, planTtl = PLAN_TTL }) {
  const plans = new Map(); // token -> { plan, expires }
  let viewer = null; // your GitHub login, asked once
  let busy = false;

  async function me() {
    if (viewer) return viewer;
    const r = await run('gh', ['api', 'user', '--jq', '.login']);
    const login = r.ok ? r.stdout.trim() : '';
    if (validRef({ owner: login, name: 'x' })) viewer = login;
    return viewer;
  }

  // Where each repo already is: a clone whose origin is that repo, else null.
  function hereMap() {
    const m = new Map();
    for (const l of local() || []) if (l && validRef(l)) m.set(keyOf(l), l.path);
    return m;
  }
  const decorate = (list, here, login) => list.map((r) => ({ ...r, here: here.get(keyOf(r)) || null, mine: !!login && r.owner.toLowerCase() === login.toLowerCase() }));

  // A live search: GitHub's own repository search, best match first.
  async function search(query) {
    const q = clean(query, QUERY_MAX);
    if (q.length < 2) return { ok: true, repos: [], total: 0 };
    const r = await run('gh', ['api', '-X', 'GET', 'search/repositories', '-f', `q=${q}`, '-f', `per_page=${SEARCH_MAX}`]);
    let data = null;
    try { data = JSON.parse(r.stdout); } catch {}
    if (!r.ok || !data || !Array.isArray(data.items)) return { ok: false, error: firstLine((data && data.message) || r.stderr) };
    const repos = data.items.map((i) => ({
      owner: i && i.owner && i.owner.login, name: i && i.name, description: clean(i && i.description, 200), stars: Number(i && i.stargazers_count) || 0,
      language: clean(i && i.language, 40) || null, isFork: !!(i && i.fork), isArchived: !!(i && i.archived), isPrivate: !!(i && i.private), pushedAt: (i && i.pushed_at) || null,
    })).filter(validRef);
    return { ok: true, repos: decorate(repos, hereMap(), await me()), total: Number(data.total_count) || repos.length };
  }

  // Every repo you own (not your organisations': those are in Settings > GitHub repos not cloned here).
  async function mine() {
    const [r, login] = await Promise.all([listRemote({ run }), me()]);
    if (!r.ok) return r;
    const repos = r.repos.map((l) => ({ owner: l.owner, name: l.name, isFork: l.isFork, isArchived: l.isArchived, pushedAt: l.pushedAt, sizeKB: l.diskKB, empty: !l.defaultBranch }));
    return { ok: true, login, repos: decorate(repos, hereMap(), login).sort((a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || ''))) };
  }

  const exists = (p) => { try { io.lstatSync(p); return true; } catch { return false; } };

  // One item: { owner, name, kind: 'clone' | 'fork' } -> a plan, or { ok: false, error }.
  async function planOne(it, ws, here, login) {
    const ref = { owner: it && it.owner, name: it && it.name };
    if (!validRef(ref)) return { ok: false, error: 'Not a GitHub repository name.' };
    const label = `${ref.owner}/${ref.name}`;
    const kind = it.kind === 'fork' ? 'fork' : 'clone';
    if (here.has(keyOf(ref))) return { ok: false, nothing: true, repoName: label, error: `Already cloned here: ${here.get(keyOf(ref))}` };
    if (kind === 'fork' && login && ref.owner.toLowerCase() === login.toLowerCase()) return { ok: false, repoName: label, error: 'This is your own repo: clone it instead.' };
    const dest = path.join(ws, ref.name);
    if (path.dirname(dest) !== ws) return { ok: false, repoName: label, error: 'That name would land outside the workspace folder.' };
    if (exists(dest)) return { ok: false, repoName: label, error: `${dest} already exists. Move it, or clone this repo by hand under another name.` };
    const gitFlags = ['--', '--no-recurse-submodules'];
    const step = kind === 'clone'
      ? { cmd: 'gh', args: ['repo', 'clone', label, dest, ...gitFlags] }
      : { cmd: 'gh', args: ['repo', 'fork', label, '--clone', ...gitFlags] };
    const fork = kind === 'fork';
    return {
      ok: true, kind, ref, dest, repoName: label,
      title: fork ? `Fork ${label} to your GitHub account and clone the fork into ${ws}` : `Clone ${label} into ${dest}`,
      risk: fork ? 'caution' : 'safe',
      steps: [{ ...step, cwd: ws, timeout: CLONE_TIMEOUT_MS, display: `${step.cmd} ${step.args.join(' ')}` }],
      warnings: [],
      note: fork ? `Your fork becomes "origin" and ${label} becomes "upstream". If you already have a fork, gh uses it.` : 'Submodules are not fetched. Nothing in the repo runs.',
      undo: fork ? `Delete the folder ${dest}, and the fork on GitHub if you no longer want it.` : `Delete the folder ${dest}.`,
    };
  }

  const publicPlan = (token, p) => ({ ok: true, token, kind: p.kind, repoName: p.repoName, title: p.title, risk: p.risk, display: p.steps.map((s) => ({ text: s.display })), warnings: p.warnings, note: p.note, undo: p.undo, confirmName: null, dest: p.dest });

  async function plan(items) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) return [{ ok: false, error: 'Bad request' }];
    if (readOnly()) return [{ ok: false, error: 'Read-only mode is on. Turn it off in the header to make changes.' }];
    const ws = root();
    if (!ws || !isDir(ws)) return [{ ok: false, error: 'Choose a workspace folder and scan it first: clones go there.' }];
    const here = hereMap();
    const login = items.some((i) => i && i.kind === 'fork') ? await me() : viewer;
    const out = [];
    const taken = new Set(); // two picks with the same name would clone into one folder
    for (const it of items) {
      const p = await planOne(it, ws, here, login);
      if (p.ok && taken.has(p.dest)) { out.push({ ok: false, repoName: p.repoName, error: `Another pick also clones into ${p.dest}.` }); continue; }
      if (!p.ok) { out.push(p); continue; }
      taken.add(p.dest);
      const token = crypto.randomBytes(16).toString('hex');
      plans.set(token, { plan: p, expires: Date.now() + planTtl });
      out.push(publicPlan(token, p));
    }
    for (const [t, v] of plans) if (v.expires < Date.now()) plans.delete(t);
    return out;
  }
  const isDir = (p) => { try { return io.statSync(p).isDirectory(); } catch { return false; } };

  // Runs reviewed plans, one at a time. A clone that worked joins the workspace (adopt), replacing
  // its "not cloned here" entry.
  async function apply(tokens) {
    if (!Array.isArray(tokens)) return [];
    if (busy) return [{ ok: false, error: 'A clone is already running.' }];
    busy = true;
    const out = [];
    try {
      for (const token of tokens) {
        const entry = plans.get(token);
        plans.delete(token);
        if (!entry || entry.expires < Date.now()) { out.push({ ok: false, error: 'Plan expired (plans last 5 minutes). Plan it again and review it.' }); continue; }
        const p = entry.plan;
        if (readOnly()) { out.push({ ok: false, repoName: p.repoName, title: p.title, error: 'Read-only mode is on.' }); continue; }
        if (exists(p.dest)) { out.push({ ok: false, repoName: p.repoName, title: p.title, error: `${p.dest} appeared since the preview, so nothing ran.` }); continue; }
        const results = [];
        let ok = true;
        for (const s of p.steps) {
          const r = await run(s.cmd, s.args, { cwd: s.cwd, timeout: s.timeout });
          results.push({ text: s.display, ok: r.ok, out: (r.stdout + r.stderr).trim().slice(-2000) });
          if (!r.ok) { ok = false; break; }
        }
        audit({ repo: p.repoName, path: p.dest, action: p.kind === 'fork' ? 'gh-fork' : 'gh-clone', risk: p.risk, title: p.title, ok, steps: results.map((x) => ({ cmd: x.text, ok: x.ok })) });
        let res = null;
        if (ok && isDir(p.dest)) { try { res = await adopt(p.dest, `remote:${p.ref.owner}/${p.ref.name}`); } catch {} }
        out.push({ ok, repoName: p.repoName, title: p.title, results, dir: ok && isDir(p.dest) ? p.dest : null, res, replaced: `remote:${p.ref.owner}/${p.ref.name}` });
      }
    } finally { busy = false; }
    return out;
  }

  const forgetPlans = () => plans.clear();
  return { search, mine, plan, apply, forgetPlans };
}

module.exports = { createGitHubGet, SEARCH_MAX };
