// Which runtime lines a version range admits, from `engines.node` (npm semver) or `requires-python`
// (PEP 440). A range with no upper bound (">=16") is a floor, not the version in use, so it returns null
// and nobody flags it. Parsing only: nothing runs. Candidate versions are the lowest and highest patch
// of each line, which errs towards admitting a line (fewer findings) when the range is unusual.

const CAP = 40; // lines above this count as unbounded
const num = (x) => (x == null || /^[xX*]$/.test(x) ? null : Number(x));
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
const lo = (p) => [p[0] || 0, p[1] || 0, p[2] || 0];
const PARTIAL = /^[v=]*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:\.[xX*])?/;

// "1.2" -> [1, 2, null]; wildcards and missing parts are null.
function partial(s) {
  const m = PARTIAL.exec(s);
  if (!m) return null;
  return [num(m[1]), num(m[2]), num(m[3])];
}
// The first version above everything the partial covers: 1 -> 2.0.0, 1.2 -> 1.3.0.
function next(p) {
  if (p[0] == null) return null;
  if (p[1] == null) return [p[0] + 1, 0, 0];
  if (p[2] == null) return [p[0], p[1] + 1, 0];
  return [p[0], p[1], p[2] + 1];
}
const isFull = (p) => p[0] != null && p[1] != null && p[2] != null;

// One comparator token -> list of [op, [a,b,c]] that must all hold.
function nodeToken(op, text) {
  const p = partial(text);
  if (!p) return null;
  if (p[0] == null) return [];
  const n = next(p);
  if (op === '' || op === '=') return [['>=', lo(p)], ['<', n]];
  if (op === '>=') return [['>=', lo(p)]];
  if (op === '>') return [['>=', isFull(p) ? [p[0], p[1], p[2] + 1] : n]];
  if (op === '<') return [['<', lo(p)]];
  if (op === '<=') return [['<', isFull(p) ? [p[0], p[1], p[2] + 1] : n]];
  if (op === '~') return [['>=', lo(p)], ['<', p[1] == null ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0]]];
  if (op === '^') {
    const [a, b, c] = lo(p);
    if (a > 0 || p[1] == null) return [['>=', lo(p)], ['<', [a + 1, 0, 0]]];
    if (b > 0 || p[2] == null) return [['>=', lo(p)], ['<', [0, b + 1, 0]]];
    return [['>=', lo(p)], ['<', [0, 0, c + 1]]];
  }
  return null;
}

function nodeAlternative(text) {
  const hy = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(text);
  if (hy) { const a = partial(hy[1]), b = partial(hy[2]); return a && b ? [...nodeToken('>=', hy[1]), ...nodeToken('<=', hy[2])] : null; }
  const out = [];
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=|~>|~|\^)?\s*(.+)$/.exec(tok);
    const c = m && nodeToken(m[1] === '~>' ? '~' : m[1] || '', m[2]);
    if (!c) return null;
    out.push(...c);
  }
  return out;
}

// PEP 440 specifier set: comma-separated clauses; != carries no bound and is ignored.
function pythonAlternative(text) {
  const out = [];
  for (const clause of text.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(===|==|~=|!=|>=|<=|>|<)\s*(.+)$/.exec(clause);
    if (!m) return null;
    const [, op, v] = m;
    if (op === '!=') continue;
    const wild = /\.\*$/.test(v);
    const p = partial(v.replace(/\.\*$/, ''));
    if (!p || p[0] == null) return null;
    if (op === '==' || op === '===') out.push(...[['>=', lo(p)], ['<', next(p)]]);
    else if (op === '~=') out.push(['>=', lo(p)], ['<', p[2] != null ? [p[0], p[1] + 1, 0] : [p[0] + 1, 0, 0]]);
    else if (op === '>=') out.push(['>=', lo(p)]);
    else if (op === '>') out.push(['>=', lo(p)]);
    else out.push(['<', op === '<' ? lo(p) : next(p)]);
  }
  return out;
}

// An alternative is a half-open interval [L, U) of versions; a line is admitted when it overlaps it.
function interval(comparators) {
  let L = [0, 0, 0], U = null;
  for (const [op, v] of comparators) {
    if (op === '>=' && cmp(v, L) > 0) L = v;
    if (op === '<' && (!U || cmp(v, U) < 0)) U = v;
  }
  return !U || cmp(L, U) < 0 ? { L, U } : null;
}

// The lines ("16", or "3.10") a range admits, or null when it is open-ended or cannot be read.
function allowedLines(flavor, spec) {
  if (typeof spec !== 'string' || spec.length > 200) return null;
  const alts = flavor === 'node' ? spec.split('||').map(nodeAlternative) : [pythonAlternative(spec)];
  if (!alts.length || alts.some((a) => a == null)) return null;
  const spans = alts.map(interval).filter(Boolean);
  const lines = [];
  for (let n = 0; n <= CAP; n++) {
    const start = flavor === 'node' ? [n, 0, 0] : [3, n, 0];
    const end = flavor === 'node' ? [n + 1, 0, 0] : [3, n + 1, 0];
    if (spans.some(({ L, U }) => cmp(L, end) < 0 && (!U || cmp(U, start) > 0))) lines.push(flavor === 'node' ? String(n) : `3.${n}`);
  }
  if (!lines.length || lines.includes(flavor === 'node' ? String(CAP) : `3.${CAP}`)) return null;
  return lines;
}

module.exports = { allowedLines };
