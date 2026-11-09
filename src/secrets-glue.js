// Secrets wiring shared by the service (app and report), the engine (CLI and MCP) and the app's IPC.
// The controller (secrets-ctl.js) does the work; this passes it the scanned workspace, shapes what
// each surface may see (never contents or hashes; MCP gets no absolute paths) and gates writes.
const fs = require('node:fs');
const path = require('node:path');
const { MCP_REFUSAL, SCAN_FIRST, repoLabel } = require('./secrets-ctl');

const READ_ONLY = 'Read-only mode is on.';
const GPG_NOTE = 'a folder, not one file: export with gpg --export-secret-keys yourself';
// Finding fix types that only the app or the CLI may plan.
const SECRET_TYPES = new Set(['secret-backup', 'secret-link', 'vault-verify']);

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// One item as the app and the CLI see it: paths and sizes, never the sha256.
function itemView(c) {
  const saveable = isFile(c.real);
  const v = { title: c.title, path: c.real, scope: c.scope, repo: c.repo || null, rel: c.rel, status: c.status, kind: c.kind, size: c.size, confidence: c.confidence, saveable };
  if (c.sameAs) v.sameAs = c.sameAs;
  if (c.fingerprint) v.fingerprint = c.fingerprint;
  if (!saveable) v.note = GPG_NOTE;
  return v;
}

// A folder candidate (~/.gnupg/private-keys-v1.d) can't be saved: its advice says what to do instead.
function adviceView(advice, items) {
  const folders = items.filter((i) => !i.saveable && i.status !== 'backed' && i.status !== 'skipped');
  return advice.map((a) => {
    if (a.repo || !folders.length || !/^ws-secret-/.test(a.id)) return a;
    return { ...a, detail: `${a.detail}. ${folders.map((f) => f.title.replace(/^gutcheck: /, '')).join(', ')}: ${GPG_NOTE}.` };
  });
}

function view(res) {
  if (!res || !res.ok) return res;
  const items = res.items.map(itemView);
  return { ok: true, linked: res.linked, tool: res.tool, target: res.target, items, advice: adviceView(res.advice, items) }; // mcpView leaves target out
}

// What the MCP server may return: titles, statuses, kinds and confidence. No paths, no hashes.
function mcpView(res) {
  if (!res || !res.ok) return res;
  return {
    ok: true, linked: res.linked, tool: res.tool,
    items: res.items.map((i) => ({ title: i.title, status: i.status, kind: i.kind, confidence: i.confidence })),
    advice: res.advice.map(({ fix, ...a }) => ({ ...a, ...(fix ? { fix: { type: fix.type } } : {}) })),
  };
}

// deps: { ctl (createSecretsCtl), known (path -> scan result), settings: () => { root } }
function createSecretsService({ ctl, known, settings }) {
  const repos = (dirs) => [...known.values()].filter((r) => !r.error && (!dirs || dirs.includes(r.path))).map((r) => ({ path: r.path, name: r.name }));
  const ws = () => ({ repos: repos(), root: settings().root || null });
  const ready = () => known.size > 0 || !!settings().root;
  const need = (fn) => (...a) => (ready() ? fn(...a) : { ok: false, error: SCAN_FIRST });

  // Read-only. `dirs` limits the repos (no workspace root then); home files are always included.
  async function scan(dirs, { home = true } = {}) {
    const d = Array.isArray(dirs) && dirs.length ? dirs : null;
    if (!d && !ready()) return { ok: false, error: SCAN_FIRST };
    return view(await ctl.scan(d ? { repos: repos(d), root: null, home } : { ...ws(), home }));
  }

  function skip(p, reason, remove = false) {
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'Name the file.' };
    let real = path.resolve(p);
    try { real = fs.realpathSync(real); } catch { /* a file that is gone can still be unskipped */ }
    if (remove) return ctl.unskip(real);
    const why = String(reason || '').trim();
    return why ? ctl.skip(real, why) : { ok: false, error: 'Give a reason for not backing it up.' };
  }

  // The report's advice: per repo path, and the workspace/home advice. Errors leave the report as it was.
  async function reportAdvice(dir) {
    const byPath = new Map();
    let workspace = [];
    try {
      const res = await scan(dir ? [dir] : undefined, { home: !dir }); // one repo: no workspace section, so no home scan
      if (!res.ok) return { byPath, workspace };
      const root = dir ? null : settings().root || null; // labels as ctl.scan made them
      for (const r of repos(dir ? [dir] : null)) byPath.set(r.path, { advice: res.advice.filter((a) => a.repo === repoLabel(r.path, root)) });
      if (!dir) workspace = res.advice.filter((a) => !a.repo);
    } catch { /* no secrets section */ }
    return { byPath, workspace };
  }

  return {
    scan, skip, reportAdvice,
    tools: () => ctl.tools(),
    link: (o) => ctl.link(o && typeof o === 'object' ? { tool: o.tool, target: o.target } : {}),
    test: need(() => ctl.test(ws())),
    plan: need((paths, via) => ctl.plan(Array.isArray(paths) ? paths : [], { via, ...ws() })),
    apply: (token, via) => ctl.apply(String(token || ''), { via }),
    verify: need((via) => ctl.verify({ via, ...ws() })),
  };
}

// The app's IPC channels. scan and tools stay readable; the rest write, or run the vault CLI, so
// Read-only mode blocks them.
function registerIpc(handle, s, readOnly) {
  const arg = (a) => (a && typeof a === 'object' ? a : {});
  const w = (fn) => (_e, a) => (readOnly() ? { ok: false, error: READ_ONLY } : fn(arg(a)));
  handle('secrets:scan', (_e, a) => s.scan(arg(a).dirs));
  handle('secrets:tools', () => s.tools());
  handle('secrets:link', w((a) => s.link(a)));
  handle('secrets:test', w(() => s.test()));
  handle('secrets:plan', w((a) => s.plan(a.paths, 'app')));
  handle('secrets:apply', w((a) => s.apply(a.token, 'app')));
  handle('secrets:verify', w(() => s.verify('app')));
  handle('secrets:skip', w((a) => s.skip(a.path, a.reason, a.remove === true)));
}

// Engine (CLI and MCP) entry points: MCP is refused outright, then the app's Read-only switch.
function engineSecrets({ service, via, readOnly, ensure }) {
  const guard = (fn) => async (...a) => {
    if (via === 'mcp') return { ok: false, error: MCP_REFUSAL };
    if (readOnly()) return { ok: false, error: 'Read-only mode is on in the GutCheck app. The user can turn it off in the app header.' };
    const s = await ensure();
    return s.ok ? fn(...a) : s;
  };
  return {
    async list(o = {}) {
      const s = await ensure(o);
      if (!s.ok) return s;
      const r = await service.secrets.scan();
      return via === 'mcp' ? mcpView(r) : r;
    },
    plan: guard((paths) => service.secrets.plan(paths, via)),
    apply: guard((token) => service.secrets.apply(token, via)),
    verify: guard(() => service.secrets.verify(via)),
    skip: guard((p, reason, remove) => service.secrets.skip(p, reason, remove)),
  };
}

module.exports = { createSecretsService, registerIpc, engineSecrets, itemView, mcpView, SECRET_TYPES, MCP_REFUSAL, READ_ONLY };
