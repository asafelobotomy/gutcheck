// Layer 2: read test results that already exist, without running anything. Coverage (lcov,
// Cobertura XML, Go cover profiles, JaCoCo XML), JUnit XML test reports, and mutation-testing
// reports (cargo-mutants, Stryker, mutmut). Looks in the usual places in the repo and in
// GutCheck's own run folder (layer 3 writes there, so runs never add files to the repo).

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES_KEPT = 15;
const read = (f) => { try { const st = fs.statSync(f); return st.isFile() && st.size <= MAX_BYTES ? { text: fs.readFileSync(f, 'utf8'), mtime: st.mtimeMs } : null; } catch { return null; } };
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
const pct = (hit, total) => (total ? Math.round((1000 * hit) / total) / 10 : null);
const rel = (root, f) => { const r = path.isAbsolute(f) ? path.relative(root, f) : f; return r.startsWith('..') ? f : r.split(path.sep).join('/'); };

// Coverage parsers: each returns [{ path, hit, total }] (lines).
function parseLcov(text, root) {
  const files = [];
  let cur = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('SF:')) cur = { path: rel(root, l.slice(3).trim()), hit: 0, total: 0 };
    else if (cur && l.startsWith('LF:')) cur.total = Number(l.slice(3)) || 0;
    else if (cur && l.startsWith('LH:')) cur.hit = Number(l.slice(3)) || 0;
    else if (cur && l === 'end_of_record') { files.push(cur); cur = null; }
  }
  return files;
}
function parseCobertura(text, root) {
  const files = [];
  const re = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
  let m;
  const by = new Map();
  while ((m = re.exec(text))) {
    const name = attr(m[1], 'filename');
    if (!name) continue;
    const lines = m[2].match(/<line\b[^>]*>/g) || [];
    const f = by.get(name) || { path: rel(root, name), hit: 0, total: 0 };
    for (const ln of lines) { f.total++; if (Number(attr(ln, 'hits')) > 0) f.hit++; }
    by.set(name, f);
  }
  for (const f of by.values()) files.push(f);
  return files;
}
function parseGoCover(text) {
  const by = new Map();
  for (const l of text.split('\n').slice(1)) {
    const m = /^(.+?):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/.exec(l.trim());
    if (!m) continue;
    const f = by.get(m[1]) || { path: m[1], hit: 0, total: 0 };
    f.total += Number(m[2]);
    if (Number(m[3]) > 0) f.hit += Number(m[2]);
    by.set(m[1], f);
  }
  return [...by.values()];
}
function parseJacoco(text) {
  const files = [];
  const re = /<package\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
  let m;
  while ((m = re.exec(text))) {
    const sre = /<sourcefile\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/sourcefile>/g;
    let s;
    while ((s = sre.exec(m[2]))) {
      const c = /<counter\b[^>]*type="LINE"[^>]*>/.exec(s[2]);
      if (c) { const missed = Number(attr(c[0], 'missed')) || 0; const covered = Number(attr(c[0], 'covered')) || 0; files.push({ path: `${m[1]}/${s[1]}`, hit: covered, total: missed + covered }); }
    }
  }
  return files;
}

// JUnit XML: totals, failures, skips and the slowest test cases.
function parseJunit(text) {
  const cases = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[3] || '';
    cases.push({ name: `${attr(m[1], 'classname') || ''}${attr(m[1], 'classname') ? '::' : ''}${attr(m[1], 'name') || '?'}`.slice(0, 160), time: Number(attr(m[1], 'time')) || 0, failed: /<(failure|error)\b/.test(body), skipped: /<skipped\b/.test(body) });
  }
  return { tests: cases.length, failed: cases.filter((c) => c.failed).length, skipped: cases.filter((c) => c.skipped).length, time: Math.round(cases.reduce((n, c) => n + c.time, 0) * 10) / 10, slowest: [...cases].sort((a, b) => b.time - a.time).slice(0, 5).map((c) => ({ name: c.name, time: c.time })), failures: cases.filter((c) => c.failed).slice(0, 10).map((c) => c.name) };
}

// Mutation reports: killed (caught by a test) vs survived (a bug the tests would miss).
function parseCargoMutants(text) {
  const j = JSON.parse(text);
  const outs = j.outcomes || [];
  const survived = outs.filter((o) => /missed/i.test(o.summary || ''));
  const killed = outs.filter((o) => /caught/i.test(o.summary || '')).length;
  return { tool: 'cargo-mutants', killed, survived: survived.length, timeout: outs.filter((o) => /timeout/i.test(o.summary || '')).length,
    examples: survived.slice(0, 10).map((o) => { const s = o.scenario && o.scenario.Mutant; return s ? `${s.file}:${(s.span && s.span.start && s.span.start.line) || '?'} ${String(s.name || s.replacement || '').slice(0, 100)}` : String(o.scenario).slice(0, 100); }) };
}
function parseStryker(text) {
  const j = JSON.parse(text);
  let killed = 0; let survived = 0; const examples = [];
  for (const [file, f] of Object.entries(j.files || {})) for (const mu of f.mutants || []) {
    if (mu.status === 'Killed' || mu.status === 'Timeout') killed++;
    else if (mu.status === 'Survived' || mu.status === 'NoCoverage') { survived++; if (examples.length < 10) examples.push(`${file}:${mu.location && mu.location.start && mu.location.start.line} ${mu.mutatorName}${mu.status === 'NoCoverage' ? ' (no test runs this code)' : ''}`); }
  }
  return { tool: 'Stryker', killed, survived, examples };
}
function parseMutmut(text) {
  // `mutmut results` lines: "<mutant name>: survived" (mutmut 3).
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const survived = lines.filter((l) => /:\s*survived$/.test(l));
  return { tool: 'mutmut', killed: lines.filter((l) => /:\s*killed$/.test(l)).length, survived: survived.length, examples: survived.slice(0, 10).map((l) => l.replace(/:\s*survived$/, '')) };
}

// Where results usually are. `runDir` is GutCheck's own output folder for this repo.
const COVERAGE = [
  ['lcov', ['lcov.info', 'coverage/lcov.info', 'coverage/lcov/lcov.info', 'target/lcov.info', 'target/llvm-cov/lcov.info']],
  ['cobertura', ['coverage.xml', 'cobertura.xml', 'coverage/cobertura-coverage.xml', 'target/cobertura.xml', 'target/tarpaulin/cobertura.xml']],
  ['go', ['cover.out', 'coverage.out', 'coverage.txt']],
  ['jacoco', ['build/reports/jacoco/test/jacocoTestReport.xml', 'app/build/reports/jacoco/test/jacocoTestReport.xml', 'build/reports/kover/report.xml', 'app/build/reports/kover/report.xml', 'android/app/build/reports/kover/report.xml']],
];
const JUNIT = ['junit.xml', 'test-results.xml', 'report.xml', 'test-results/junit.xml', 'target/nextest/default/junit.xml', 'build/test-results/test'];
const MUTATION = [['cargo-mutants', 'mutants.out/outcomes.json'], ['stryker', 'reports/mutation/mutation.json'], ['mutmut', 'mutmut-results.txt']];
const PARSE = { lcov: parseLcov, cobertura: parseCobertura, go: parseGoCover, jacoco: parseJacoco };
const MUT = { 'cargo-mutants': parseCargoMutants, stryker: parseStryker, mutmut: parseMutmut };

function readResults(dir, runDir = null) {
  const bases = [dir, ...(runDir && fs.existsSync(runDir) ? [runDir] : [])];
  const out = { coverage: null, junit: null, mutation: null };
  // Newest coverage file wins.
  let best = null;
  for (const base of bases) for (const [kind, names] of COVERAGE) for (const n of names) {
    const r = read(path.join(base, n));
    if (r && (!best || r.mtime > best.mtime)) best = { kind, file: path.join(base, n), ...r };
  }
  if (best) {
    try {
      const files = PARSE[best.kind](best.text, dir).filter((f) => f.total > 0);
      const hit = files.reduce((n, f) => n + f.hit, 0);
      const total = files.reduce((n, f) => n + f.total, 0);
      out.coverage = { format: best.kind, file: rel(dir, best.file), date: new Date(best.mtime).toISOString(), percent: pct(hit, total), hit, total, files: files.length,
        lowest: files.filter((f) => f.total >= 20).map((f) => ({ path: f.path, percent: pct(f.hit, f.total), lines: f.total })).sort((a, b) => a.percent - b.percent || b.lines - a.lines).slice(0, MAX_FILES_KEPT) };
    } catch {}
  }
  for (const base of bases) for (const n of JUNIT) {
    const p = path.join(base, n);
    let texts = [];
    try { texts = fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.xml')).slice(0, 200).map((f) => read(path.join(p, f))).filter(Boolean) : [read(p)].filter(Boolean); } catch {}
    if (!texts.length || !texts.some((t) => /<testcase\b/.test(t.text))) continue;
    const parts = texts.map((t) => parseJunit(t.text));
    const j = { file: rel(dir, p), date: new Date(Math.max(...texts.map((t) => t.mtime))).toISOString(), tests: 0, failed: 0, skipped: 0, time: 0, slowest: [], failures: [] };
    for (const x of parts) { j.tests += x.tests; j.failed += x.failed; j.skipped += x.skipped; j.time += x.time; j.slowest.push(...x.slowest); j.failures.push(...x.failures); }
    j.slowest = j.slowest.sort((a, b) => b.time - a.time).slice(0, 5);
    j.failures = j.failures.slice(0, 10);
    if (!out.junit || j.date > out.junit.date) out.junit = j;
  }
  for (const base of bases) for (const [kind, n] of MUTATION) {
    const r = read(path.join(base, n));
    if (!r) continue;
    try { const m = MUT[kind](r.text); if (!out.mutation || r.mtime > Date.parse(out.mutation.date)) out.mutation = { ...m, file: rel(dir, path.join(base, n)), date: new Date(r.mtime).toISOString(), score: pct(m.killed, m.killed + m.survived) }; } catch {}
  }
  return out;
}

module.exports = { readResults, parseLcov, parseCobertura, parseGoCover, parseJacoco, parseJunit, parseCargoMutants, parseStryker, parseMutmut };
