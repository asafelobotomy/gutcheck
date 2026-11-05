// Code-quality scan of one repo: file length (LOC), magic numbers and constants reuse, TODO markers,
// debug leftovers, hardcoded secrets, oversized files. Read-only. Results never contain secret
// values or string contents: only locations, kinds and blanked-out code snippets.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { git } = require('../exec');
const { LANGS, lex } = require('./lexer');
const R = require('./rules');
const { buildAdvice } = require('./advice');

const DEFAULTS = { maxLines: 400, locMode: 'total', ignore: [] };
const MAX_FILES = 6000;
const MAX_READ = 1024 * 1024;
const BIG_FILE = 5 * 1024 * 1024;
const DENSE_FILE = 15; // magic numbers in one file before it is called out
const CANDIDATE_MIN = 3; // a literal repeated this often deserves a name
const REUSE_MIN = 100; // smaller values (3, 5, 30...) collide by accident, so only larger ones count as "the same constant"

// Validate user settings (they come from disk and from the UI): anything odd falls back to defaults.
function normalizeSettings(q = {}) {
  const maxLines = Number.isInteger(q.maxLines) && q.maxLines >= 20 && q.maxLines <= 20000 ? q.maxLines : DEFAULTS.maxLines;
  const locMode = q.locMode === 'code' ? 'code' : 'total';
  const ignore = (Array.isArray(q.ignore) ? q.ignore : []).filter((s) => typeof s === 'string').map((s) => s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100)).filter(Boolean).slice(0, 50);
  return { maxLines, locMode, ignore };
}

// Ignore rules: "dir/" matches a folder anywhere, "*.ext" an extension, anything else a path substring.
function ignored(rel, rules) {
  return rules.some((r) => (r.endsWith('/') ? rel.startsWith(r) || rel.includes('/' + r) : r.startsWith('*.') ? rel.endsWith(r.slice(1)) : rel.includes(r)));
}

async function listFiles(dir) {
  const r = await git(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, timeout: 60000 });
  return [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
}

const tick = () => new Promise((r) => setImmediate(r));
const snippet = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 80);

async function scanQuality(dir, rawSettings) {
  const cfg = normalizeSettings(rawSettings);
  const res = { files: 0, lines: 0, languages: new Map(), over: [], largest: [], tests: 0, skipped: { generated: 0, minified: 0, large: 0 }, truncated: false };
  const magicFiles = [];
  const values = new Map(); // value -> { count, files:Set, fam, uses:[{path,line}] }
  const defs = []; // { name, value, path, line, fam }
  const constantsFiles = [];
  const markers = { TODO: 0, FIXME: 0, HACK: 0, XXX: 0, items: [] };
  const debug = [];
  const secrets = [];
  const largeFiles = [];
  let magicTotal = 0;
  let sourceFiles = 0;

  const all = (await listFiles(dir)).filter((rel) => {
    const segs = rel.split('/');
    return !segs.slice(0, -1).some((s) => R.SKIP_SEGMENTS.has(s)) && !R.SKIP_FILE_RE.test(rel) && !ignored(rel, cfg.ignore);
  });
  const candidates = all.filter((rel) => LANGS[path.extname(rel).slice(1).toLowerCase()] || R.CONFIG_EXT.has(path.extname(rel).slice(1).toLowerCase()) || R.CONST_FILE_RE.test(rel));
  if (candidates.length > MAX_FILES) res.truncated = true;

  let n = 0;
  for (const rel of candidates.slice(0, MAX_FILES)) {
    if (++n % 25 === 0) await tick(); // let the app breathe during big scans
    const ext = path.extname(rel).slice(1).toLowerCase();
    const spec = LANGS[ext];
    const abs = path.join(dir, ...rel.split('/'));
    let st;
    try { st = await fsp.lstat(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > BIG_FILE) largeFiles.push({ path: rel, size: st.size });
    if (st.size > MAX_READ) { res.skipped.large++; continue; }
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue; // binary
    const isTest = R.TEST_RE.test(rel);
    const rawLines = text.split('\n');
    if (rawLines[rawLines.length - 1] === '') rawLines.pop();

    // Secrets: raw text, source and config files only.
    rawLines.forEach((l, i) => {
      if (l.length > 2000) return;
      for (const kind of R.secretKinds(l, isTest)) if (secrets.length < 200) secrets.push({ path: rel, line: i + 1, kind });
    });
    if (!spec) continue;

    if (R.GENERATED_RE.test(text.slice(0, 600))) { res.skipped.generated++; continue; }
    const longest = rawLines.reduce((m, l) => Math.max(m, l.length), 0);
    if (longest > 2000 || (rawLines.length > 0 && text.length / rawLines.length > 300)) { res.skipped.minified++; continue; }

    res.files++;
    if (isTest) res.tests++; else sourceFiles++;
    const lexed = spec.fam === 'plain' ? { code: rawLines, comments: [] } : lex(text, spec);
    const total = rawLines.length;
    const code = lexed.code.filter((l) => l.trim()).length;
    res.lines += total;
    const lang = res.languages.get(spec.lang) || { lang: spec.lang, files: 0, lines: 0 };
    lang.files++; lang.lines += total;
    res.languages.set(spec.lang, lang);
    const measured = cfg.locMode === 'code' ? code : total;
    const entry = { path: rel, lines: total, code, lang: spec.lang, test: isTest, measured };
    res.largest.push(entry);
    if (measured > cfg.maxLines) res.over.push(entry);

    if (R.CONST_FILE_RE.test(rel) && !isTest) constantsFiles.push(rel);
    if (spec.fam === 'plain') continue;

    let fileMagic = 0;
    const examples = [];
    lexed.code.forEach((line, i) => {
      const def = R.constantDef(line);
      if (def) defs.push({ ...def, path: rel, line: i + 1, fam: spec.fam });
      if (isTest) return;
      const dbg = R.debugKind(line, ext);
      if (dbg && debug.length < 200) debug.push({ path: rel, line: i + 1, kind: dbg[0], severity: dbg[1] });
      for (const m of R.magicNumbers(line)) {
        fileMagic++;
        const key = String(m.value);
        const v = values.get(key) || { value: m.value, count: 0, files: new Set(), fam: spec.fam, uses: [] };
        v.count++; v.files.add(rel);
        if (v.uses.length < 10) v.uses.push({ path: rel, line: i + 1 });
        values.set(key, v);
        if (examples.length < 5) examples.push({ line: i + 1, value: m.text, text: snippet(line) });
      }
    });
    magicTotal += fileMagic;
    if (fileMagic) magicFiles.push({ path: rel, count: fileMagic, examples });

    lexed.comments.forEach((c, i) => {
      const m = c && R.MARKER_RE.exec(c);
      if (!m) return;
      markers[m[1]]++;
      if (markers.items.length < 40 && !R.secretKinds(c, true).length) markers.items.push({ path: rel, line: i + 1, kind: m[1], text: snippet(c) });
    });
  }

  // Constants: literals that repeat a constant the repo already defines, and literals worth naming.
  const defByValue = new Map();
  for (const d of defs) if (Math.abs(d.value) > REUSE_MIN) defByValue.set(String(d.value), [...(defByValue.get(String(d.value)) || []), d]);
  const reuse = [];
  const candidatesOut = [];
  for (const [key, v] of values) {
    const ds = (defByValue.get(key) || []).filter((d) => d.fam === v.fam);
    if (ds.length) reuse.push({ value: v.value, constant: ds[0].name, definedIn: `${ds[0].path}:${ds[0].line}`, count: v.count, uses: v.uses.slice(0, 6) });
    else if (v.count >= CANDIDATE_MIN) candidatesOut.push({ value: v.value, count: v.count, files: v.files.size, uses: v.uses.slice(0, 4) });
  }
  reuse.sort((a, b) => b.count - a.count);
  candidatesOut.sort((a, b) => b.count - a.count);
  magicFiles.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  res.largest.sort((a, b) => b.measured - a.measured);
  res.over.sort((a, b) => b.measured - a.measured);
  largeFiles.sort((a, b) => b.size - a.size);

  const out = {
    settings: cfg, files: res.files, lines: res.lines, sourceFiles, testFiles: res.tests,
    languages: [...res.languages.values()].sort((a, b) => b.lines - a.lines),
    loc: { max: cfg.maxLines, mode: cfg.locMode, overCount: res.over.length, over: res.over.slice(0, 100), largest: res.largest.slice(0, 10) },
    magic: { total: magicTotal, files: magicFiles.slice(0, 20), denseFiles: magicFiles.filter((f) => f.count >= DENSE_FILE).length, repeated: candidatesOut.slice(0, 15), reuse: reuse.slice(0, 15), constants: { files: constantsFiles.slice(0, 10), definitions: defs.length } },
    markers: { TODO: markers.TODO, FIXME: markers.FIXME, HACK: markers.HACK, XXX: markers.XXX, total: markers.TODO + markers.FIXME + markers.HACK + markers.XXX, items: markers.items },
    debug: debug.slice(0, 40), debugCount: debug.length,
    secrets: secrets.slice(0, 40), secretCount: secrets.length,
    largeFiles: largeFiles.slice(0, 10),
    skipped: res.skipped, truncated: res.truncated,
  };
  out.advice = buildAdvice(out);
  return out;
}

module.exports = { scanQuality, normalizeSettings, DEFAULTS };
