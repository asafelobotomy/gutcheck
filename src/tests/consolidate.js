// Tests to consolidate: near-duplicate test bodies (candidates for one parameterized test), many tiny
// test files for one module, and the same setup lines opening many tests (a fixture or helper).
// Works on test code with strings and comments blanked, so tests that differ only in their inputs
// and expected values read as the same test. Read-only; nothing runs.

const path = require('node:path');

const MIN_DUP = 3; // tests in one file with the same body
const MIN_DUP_LINES = 2;
const MIN_CROSS_LINES = 6; // a body copied into another file
const MIN_SETUP_TESTS = 5; // tests in one file opening with the same lines
const SETUP_LINES = 3;
const MIN_TINY_FILES = 3;
const TINY_CASES = 2;
const TINY_LINES = 40;
const MAX_KEPT = 30;

// The text between the bracket at `open` and its partner (strings are already blanked).
function matched(code, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') { if (stack.pop() !== c) return null; if (!stack.length) return i; }
  }
  return null;
}

const lineAt = (code, i) => code.slice(0, i).split('\n').length;

// Test bodies, per language: [{ line, lines: [normalised statement lines] }].
function testBodies(code, lang) {
  const out = [];
  const push = (line, text) => out.push({ line, lines: normalise(text) });
  if (lang === 'js') {
    const re = /(?:^|[^.\w])(?:it|test)(?:\.(?:only|skip|concurrent|fails))*\s*\(/g;
    let m;
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      const close = matched(code, open);
      if (close == null) continue;
      const inner = code.slice(open + 1, close);
      // The callback's own brace: after => or function(...), not a destructured ({ page }) parameter.
      const fn = /(?:=>|\bfunction\b[^{]*\))\s*\{/.exec(inner);
      const b = fn ? fn.index + fn[0].length - 1 : -1;
      if (b >= 0) push(lineAt(code, m.index + m[0].length), inner.slice(b + 1, inner.lastIndexOf('}')));
      re.lastIndex = close;
    }
  } else if (lang === 'py') {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:async\s+)?def\s+test\w*\s*\(/.exec(lines[i]);
      if (!m) continue;
      let j = i + 1;
      while (j < lines.length && !/\)\s*(?:->[^:]*)?:\s*$/.test(lines[j - 1]) && j < i + 10) j++; // multi-line signature
      const body = [];
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() && l.match(/^\s*/)[0].length <= m[1].length) break;
        body.push(l);
      }
      push(i + 1, body.join('\n'));
    }
  } else if (lang === 'rs' || lang === 'go') {
    const re = lang === 'rs' ? /#\[(?:tokio::|async_std::)?test\b[^\]]*\][\s\S]{0,400}?\bfn\s+\w+[^{]*\{/g : /^func\s+Test\w*\s*\([^)]*\)\s*\{/gm;
    let m;
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      const close = matched(code, open);
      if (close == null) continue;
      push(lineAt(code, m.index), code.slice(open + 1, close));
      re.lastIndex = close;
    }
  }
  return out;
}

// One statement per line, whitespace collapsed, numbers as 0, lone brackets dropped.
function normalise(text) {
  return text.split('\n').map((l) => l.trim().replace(/\s+/g, ' ').replace(/\b\d+(?:\.\d+)?\b/g, '0').replace(/[;,]$/, ''))
    .filter((l) => l && !/^[)}\]]+[)}\];,]*$/.test(l));
}

const ASSERTISH = /\bassert|\bexpect\s*\(|\.should\b|\bt\.(?:Error|Fatal|is|true|deepEqual)|\brequire\.\w+\(/;

// tests: [{ rel, lang, code }] (test files only).
function consolidation(tests, sources) {
  const dupes = [];
  const setup = [];
  const cross = new Map();
  const sharedSetup = new Map();
  for (const f of tests) {
    const bodies = testBodies(f.code, f.lang);
    const byBody = new Map();
    for (const b of bodies) {
      if (b.lines.length < MIN_DUP_LINES || b.lines.join('').length < 40) continue;
      const k = b.lines.join('\n');
      (byBody.get(k) || byBody.set(k, []).get(k)).push(b.line);
    }
    // Copies between files compare the raw bodies: with strings blanked, tests of two endpoints look alike.
    for (const b of testBodies(f.text, f.lang)) {
      if (b.lines.length < MIN_CROSS_LINES) continue;
      const k = b.lines.join('\n');
      const c = cross.get(k) || cross.set(k, new Map()).get(k);
      if (!c.has(f.rel)) c.set(f.rel, b.line);
    }
    const dupLines = new Set();
    for (const lines of byBody.values()) if (lines.length >= MIN_DUP) { dupes.push({ path: f.rel, line: lines[0], count: lines.length, lines: lines.slice(0, 6) }); lines.forEach((l) => dupLines.add(l)); }
    // Repeated setup: the same opening lines (before any assertion) in many tests of a file.
    const bySetup = new Map();
    for (const b of bodies) {
      if (dupLines.has(b.line)) continue;
      const head = [];
      for (const l of b.lines) { if (ASSERTISH.test(l) || head.length === SETUP_LINES) break; head.push(l); }
      if (head.length < SETUP_LINES || head.join('').length < 45) continue;
      const k = head.join('\n');
      (bySetup.get(k) || bySetup.set(k, []).get(k)).push(b.line);
      const s = sharedSetup.get(k) || sharedSetup.set(k, new Set()).get(k);
      s.add(f.rel);
    }
    // One entry per file: the opening shared by the most tests.
    const best = [...bySetup].filter(([, l]) => l.length >= MIN_SETUP_TESTS).sort((a, b) => b[1].length - a[1].length)[0];
    if (best) setup.push({ path: f.rel, line: best[1][0], count: best[1].length, first: best[0].split('\n')[0].slice(0, 80) });
  }
  const copies = [...cross.values()].filter((m) => m.size >= 2).map((m) => [...m].map(([p, l]) => ({ path: p, line: l })));
  const inFile = new Set(setup.map((s) => s.path));
  const sharedAcross = [...sharedSetup.entries()].filter(([, s]) => s.size >= 3 && [...s].some((p) => !inFile.has(p)))
    .map(([k, s]) => ({ files: [...s].slice(0, 8), count: s.size, first: k.split('\n')[0].slice(0, 80) }));
  return { duplicates: dupes.slice(0, MAX_KEPT), copies: copies.slice(0, MAX_KEPT), setup: setup.slice(0, MAX_KEPT), sharedSetup: sharedAcross.slice(0, 10), tinyFiles: tinyFiles(tests, sources) };
}

// Several small test files in one folder for the same module (cart.add.test.js, cart.remove.test.js
// next to src/cart.js): one file per module is easier to find and share setup in.
// Only when the tiny files are most of that module's test files and add up to one small file: a
// project that keeps one test file per feature (test_reddit_*.py, dozens of them) is a convention.
function tinyFiles(tests, sources) {
  const mods = new Set(sources.map((s) => path.basename(s.rel).replace(/\.[^.]+$/, '').toLowerCase()));
  const groups = new Map();
  const totals = new Map();
  for (const f of tests) {
    const base = path.basename(f.rel).replace(/\.[^.]+$/, '').replace(/^test_|_test$|\.(test|spec)$|_spec$/, '').toLowerCase();
    const mod = base.split(/[._-]/)[0];
    if (mod.length < 3 || mod === base || !mods.has(mod)) continue;
    const k = `${path.dirname(f.rel)}\0${mod}`;
    const tot = totals.get(k) || totals.set(k, { files: 0, cases: 0 }).get(k);
    tot.files++; tot.cases += f.cases;
    if (f.cases <= TINY_CASES && f.lines <= TINY_LINES && f.cases) (groups.get(k) || groups.set(k, []).get(k)).push(f.rel);
  }
  return [...groups.entries()].filter(([k, g]) => g.length >= MIN_TINY_FILES && g.length >= 0.6 * totals.get(k).files && totals.get(k).cases <= 12)
    .map(([k, g]) => ({ dir: k.split('\0')[0], module: k.split('\0')[1], files: g.sort() })).slice(0, MAX_KEPT);
}

module.exports = { consolidation, testBodies, normalise, matched };
