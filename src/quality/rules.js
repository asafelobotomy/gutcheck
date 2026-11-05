// Pattern rules for the code-quality scan. Everything here is plain data or a pure function.

const { HEAVY_DIRS } = require('../util');

const ALLOWED_NUMBERS = new Set([0, 1, 2, 10, 100, 0.5]); // too ordinary to call magic (signs are ignored)
const NUM_RE = /(?<![\w.$])(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)(?![\w$])/g;
const DENSE_LINE = 5; // lines with this many numbers are data tables, not logic

// Lines that define a constant (UPPER_CASE name) or are not logic at all: their numbers are not magic.
const DECL_RE = /^\s*(?:export\s+)?(?:(?:public|private|protected|static|final|readonly|const|let|var|val|pub|int|long|double|float|unsigned)\s+)*[A-Z][A-Z0-9_]+\b\s*(?::[^=]*)?=/;
const SKIP_LINE_RE = /^\s*(?:import\b|from\b|using\b|package\b|#\s*(?:include|if|ifdef|ifndef|pragma|define|endif)\b)/;
// `NAME = 123` (also `#define NAME 123`): a named numeric constant. Same name rule as DECL_RE (2+ chars).
const NUM_VALUE = '(-?(?:0[xX][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?))';
const CONST_DEF_RE = new RegExp(`^\\s*(?:export\\s+)?(?:(?:public|private|protected|static|final|readonly|const|let|var|val|pub|int|long|double|float|unsigned)\\s+)*([A-Z][A-Z0-9_]+)\\s*(?::\\s*[\\w<>[\\]\\s]+)?=\\s*${NUM_VALUE}\\s*(?:as\\s+const)?\\s*[;,]?\\s*$`);
const DEFINE_RE = new RegExp(`^\\s*#\\s*define\\s+([A-Z][A-Z0-9_]+)\\s+${NUM_VALUE}\\s*$`);

const CONST_FILE_RE = /(^|\/)(constants?|consts?|defaults|limits|settings|config)(\.[a-z]+)?$|(^|\/)constants?\//i;
const TEST_RE = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|__mocks__|testdata)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const GENERATED_RE = /@generated|DO NOT EDIT|auto-?generated|Code generated/i;
const SKIP_SEGMENTS = new Set([...HEAVY_DIRS, '.git', '.venv', 'venv', '.next', '.nuxt', '.svelte-kit', '.cxx', '.gradle', '__pycache__', 'coverage']);
const SKIP_FILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$/;
const CONFIG_EXT = new Set(['json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'tf', 'xml']);

// A marker counts when the comment starts with it ("// TODO: x", "# FIXME(sam) y"), not when prose mentions the word.
const MARKER_RE = /^[\s*!/#-]*(TODO|FIXME|HACK|XXX)\b/;

// Hardcoded-secret signatures. Findings record the kind and location only, never the value.
const SECRET_PATTERNS = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b[sr]k_live_[0-9A-Za-z]{20,}\b/],
  ['API secret key', /\bsk-[A-Za-z0-9_-]{32,}\b/],
];
const GENERIC_SECRET = /(?:password|passwd|secret|token|api[_-]?key|auth[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i;
// Checked against the captured value only: a `{` or `$` elsewhere on the line says nothing about it.
const PLACEHOLDER = /example|changeme|change_me|your[_-]|xxx|placeholder|dummy|sample|redacted|<|\{|\$|\*\*\*/i;
const ENV_LOOKUP = /process\.env|os\.environ|getenv|ENV\[/;

function entropy(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  return -Object.values(f).reduce((n, k) => n + (k / s.length) * Math.log2(k / s.length), 0);
}

// Returns a list of secret kinds found on one raw line (testFile relaxes the generic rule only).
function secretKinds(line, testFile) {
  const out = [];
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) out.push(kind);
  if (!out.length && !testFile) {
    const m = GENERIC_SECRET.exec(line);
    if (m && !PLACEHOLDER.test(m[1]) && !ENV_LOOKUP.test(line) && entropy(m[1]) >= 3) out.push('Hardcoded credential');
  }
  return out;
}

// Debug leftovers on a code line (strings and comments already blanked).
function debugKind(line, ext) {
  if (/\bdebugger\s*;?\s*$/.test(line)) return ['debugger', 'warn'];
  if (ext === 'py' && /\b(?:breakpoint\(\)|pdb\.set_trace\(\)|import\s+pdb\b)/.test(line)) return ['breakpoint', 'warn'];
  if (ext === 'rb' && /\bbinding\.(?:pry|irb)\b/.test(line)) return ['breakpoint', 'warn'];
  if (/\bconsole\.(?:log|debug)\s*\(/.test(line)) return ['console.log', 'info'];
  return null;
}

// Numbers on a code line that look like magic numbers. Returns [{ value, text }].
function magicNumbers(line) {
  if (SKIP_LINE_RE.test(line) || DECL_RE.test(line)) return [];
  const found = [...line.matchAll(NUM_RE)];
  if (!found.length || found.length >= DENSE_LINE) return [];
  const out = [];
  for (const m of found) {
    const value = Number(m[0].replace(/_/g, ''));
    if (!Number.isFinite(value) || ALLOWED_NUMBERS.has(value)) continue;
    if (line[m.index - 1] === '[' && line[m.index + m[0].length] === ']') continue; // array index
    out.push({ value, text: m[0] });
  }
  return out;
}

function constantDef(line) {
  const m = CONST_DEF_RE.exec(line) || DEFINE_RE.exec(line);
  if (!m) return null;
  const value = Number(m[2].replace(/_/g, ''));
  return Number.isFinite(value) ? { name: m[1], value } : null;
}

module.exports = { CONST_FILE_RE, TEST_RE, GENERATED_RE, SKIP_SEGMENTS, SKIP_FILE_RE, CONFIG_EXT, MARKER_RE, secretKinds, debugKind, magicNumbers, constantDef };
