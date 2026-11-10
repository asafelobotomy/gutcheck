// End-of-life runtimes, read from the version pins a repo already has: .nvmrc, .node-version,
// .python-version, .tool-versions, engines.node, requires-python, the go.mod toolchain line and the
// versions its workflows ask setup-node, setup-python and setup-go for. Parses text only; nothing runs.
//
// What counts as "in use" (a floor is not a version): an exact pin, a range with an upper bound where
// every admitted line has ended, a go.mod `toolchain` line (the `go` line is only a minimum), and a
// workflow file whose every version for a runtime has ended. A matrix that also tests a supported
// version is fine. The dates come from the bundled table in eol-data.js.

const fs = require('node:fs');
const path = require('node:path');
const { AS_OF, PRODUCTS } = require('./eol-data');
const { allowedLines } = require('./runtime-ranges');
const { plural } = require('./util');

const SOON_DAYS = 90;
const YOUNG_DAYS = 90; // a release younger than this is not the one to point people at yet
const DAY = 24 * 3600 * 1000;
const MAX_BYTES = 256 * 1024;
const MAX_WORKFLOWS = 50;
const KEYS = { node: 'node-version', python: 'python-version', go: 'go-version' };

const read = (dir, rel) => {
  try {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    return st.isFile() && st.size <= MAX_BYTES ? fs.readFileSync(abs, 'utf8') : null;
  } catch { return null; }
};
const key = (c) => String(c).split('.').map(Number);
const byCycle = (a, b) => { const x = key(a), y = key(b); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };
const day = (s) => Date.parse(s + 'T00:00:00Z');

// { state: 'ok' } | { state: 'soon', eol, days } | { state: 'eol', eol }. A version newer than the table is
// unknown, so never flagged; older than its oldest cycle has certainly ended.
function eolStatus(product, cycle, now = new Date()) {
  const cycles = PRODUCTS[product].cycles;
  const c = cycles[cycle];
  if (!c) return Object.keys(cycles).every((k) => byCycle(cycle, k) < 0) ? { state: 'eol', eol: null } : { state: 'ok' };
  if (!c.eol) return { state: 'ok' };
  const left = Math.ceil((day(c.eol) - now.getTime()) / DAY);
  if (left <= 0) return { state: 'eol', eol: c.eol };
  return left <= SOON_DAYS ? { state: 'soon', eol: c.eol, days: left } : { state: 'ok' };
}

// Supported lines from the table, and the one to point at: the longest support left among those
// released at least YOUNG_DAYS ago (no end date counts as longest, newest first).
function suggestion(product, now = new Date()) {
  const cycles = PRODUCTS[product].cycles;
  const supported = Object.keys(cycles).filter((k) => eolStatus(product, k, now).state !== 'eol').sort(byCycle);
  const mature = supported.filter((k) => day(cycles[k].released) <= now.getTime() - YOUNG_DAYS * DAY);
  const end = (k) => (cycles[k].eol ? day(cycles[k].eol) : Infinity);
  const pool = mature.length ? mature : supported;
  const pick = pool.slice().sort((a, b) => (end(a) - end(b)) || byCycle(a, b)).pop() || null;
  return { supported, pick };
}

const lineOf = (product, text) => {
  const m = product === 'node' ? /^v?(\d+)(?:[.x*]|$)/i.exec(text) : /^v?(\d+\.\d+)(?:[.x*a-z]|$)/i.exec(text);
  if (!m) return null;
  return product === 'python' && !m[1].startsWith('3.') ? null : m[1];
};

function workflowValues(lines, name) {
  const out = [];
  const rx = new RegExp(`^(\\s*)(?:-\\s+)?${name}:\\s*(.*?)\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    const m = rx.exec(lines[i]);
    if (!m) continue;
    if (m[2]) { out.push(...(m[2].startsWith('[') ? m[2].replace(/^\[|\]$/g, '').split(',') : [m[2]])); continue; }
    const indent = lines[i].length - lines[i].trimStart().length;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const it = /^(\s*)-\s+(.+?)\s*(?:#.*)?$/.exec(lines[j]);
      if (!it || it[1].length < indent) break; // a list may sit at the key's own indent
      out.push(it[2]);
    }
  }
  return out.map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function workflowUses(dir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, '.github', 'workflows')).filter((n) => /\.ya?ml$/i.test(n)).sort().slice(0, MAX_WORKFLOWS); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = `.github/workflows/${n}`;
    const text = read(dir, file);
    if (!text) continue;
    const lines = text.split('\n');
    for (const [product, name] of Object.entries(KEYS)) {
      const cycles = new Set();
      for (const raw of workflowValues(lines, name)) {
        const ref = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(raw);
        for (const v of ref ? workflowValues(lines, ref[1]) : [raw]) { const c = lineOf(product, v); if (c) cycles.add(c); }
      }
      if (cycles.size) out.push({ product, cycles: [...cycles].sort(byCycle), file, kind: 'ci' });
    }
  }
  return out;
}

function collectRuntimes(dir) {
  const uses = [];
  const add = (product, cycles, file, kind) => { if (cycles && cycles.length) uses.push({ product, cycles, file, kind }); };
  for (const f of ['.nvmrc', '.node-version']) {
    const t = read(dir, f);
    const c = t && lineOf('node', t.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '');
    if (c) add('node', [c], f, 'pin');
  }
  const py = read(dir, '.python-version');
  const pc = py && lineOf('python', (py.split('\n')[0] || '').trim());
  if (pc) add('python', [pc], '.python-version', 'pin');
  const tv = read(dir, '.tool-versions');
  for (const l of (tv || '').split('\n')) {
    const m = /^\s*(nodejs|node|python|golang|go)\s+(\S+)/.exec(l);
    if (!m) continue;
    const product = m[1].startsWith('node') ? 'node' : m[1] === 'python' ? 'python' : 'go';
    const c = lineOf(product, m[2]);
    if (c) add(product, [c], '.tool-versions', 'pin');
  }
  try {
    const eng = JSON.parse(read(dir, 'package.json') || 'null');
    const spec = eng && eng.engines && eng.engines.node;
    if (typeof spec === 'string') add('node', allowedLines('node', spec), 'package.json', 'range');
  } catch {}
  const pp = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(read(dir, 'pyproject.toml') || '');
  if (pp) add('python', allowedLines('python', pp[1]), 'pyproject.toml', 'range');
  const tc = /^\s*toolchain\s+go(\d+\.\d+)/m.exec(read(dir, 'go.mod') || ''); // the `go` line is a minimum, so it is not read
  if (tc) add('go', [tc[1]], 'go.mod', 'pin');
  uses.push(...workflowUses(dir));
  return { uses };
}

const how = (u) => (u.kind === 'range' ? ', a range that allows only ' + (u.cycles.length > 1 ? 'these' : 'this') : u.kind === 'ci' ? ', every version it tests' : '');

function checkRuntimeEol(s, now = new Date()) {
  const uses = (s.runtimes && s.runtimes.uses) || [];
  const ended = [], soon = [];
  for (const u of uses) {
    const st = u.cycles.map((c) => eolStatus(u.product, c, now));
    if (st.some((x) => x.state === 'ok')) continue; // some version it admits or tests is still supported
    const label = `${PRODUCTS[u.product].label} ${u.cycles.join(', ')} (${u.file})${how(u)}`;
    if (st.every((x) => x.state === 'eol')) {
      const dates = st.map((x) => x.eol).filter(Boolean).sort();
      ended.push({ u, text: `${label} ${dates.length ? 'ended ' + dates[dates.length - 1] : 'ended long ago'}` });
    } else {
      const k = st.filter((x) => x.state === 'soon').sort((a, b) => b.days - a.days)[0];
      soon.push({ u, text: `${label} ends ${k.eol} (${plural(k.days, 'day')})` });
    }
  }
  const out = [];
  const advice = (list) => {
    const products = [...new Set(list.map((x) => x.u.product))];
    const bits = products.map((p) => { const g = suggestion(p, now); return `${PRODUCTS[p].label} still supported: ${g.supported.join(', ')}${g.pick ? `; ${g.pick} has the longest support left` : ''}`; });
    return `${bits.join('. ')}. Bundled table as of ${AS_OF} (${products.map((p) => PRODUCTS[p].source).join(', ')}).`;
  };
  const add = (id, severity, list, title) => out.push({ id, category: 'Project setup', severity, title, detail: `${list.map((x) => x.text).join('; ')}. ${advice(list)}` });
  if (ended.length) add('runtime-eol', 'warn', ended, ended.length === 1 ? `${PRODUCTS[ended[0].u.product].label} ${ended[0].u.cycles.join(', ')} is past end of life` : `${plural(ended.length, 'runtime pin')} past end of life`);
  if (soon.length) add('runtime-eol-soon', 'info', soon, `${plural(soon.length, 'runtime pin')} reaching end of life within ${SOON_DAYS} days`);
  return out;
}

module.exports = { collectRuntimes, checkRuntimeEol, eolStatus, suggestion, SOON_DAYS };
