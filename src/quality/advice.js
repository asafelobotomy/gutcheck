// Turns raw quality results into advice rows (same shape as every other finding).

const { plural, list } = require('../util');

const fmtSize = (n) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// `lim` carries scan.js thresholds so the text always matches what was measured.
function buildAdvice(q, lim) {
  const out = [];
  const add = (id, severity, title, detail) => out.push({ id, category: 'Code quality', severity, title, detail });
  const at = (x) => `${x.path}:${x.line}`;

  if (q.secretCount)
    add('q-secrets', 'error', `${plural(q.secretCount, 'possible hardcoded secret')}`, `${list(q.secrets.map((s) => `${at(s)} (${s.kind})`), 8)}. Values are never shown. Rotate them, move them to environment variables or a secret store, and check git history.`);

  const L = q.loc;
  if (L.overCount) {
    const worst = L.over[0].measured;
    add('q-loc', worst > L.max * 2 ? 'warn' : 'info', `${plural(L.overCount, 'file')} over ${L.max} ${L.mode === 'code' ? 'code lines' : 'lines'}`, `${list(L.over.map((f) => `${f.path} (${f.measured})`), 6)}. Split by responsibility into smaller modules.`);
  }

  const M = q.magic;
  if (M.reuse.length)
    add('q-constants-reuse', 'info', `${plural(M.reuse.reduce((n, r) => n + r.count, 0), 'literal')} may repeat an existing constant`, list(M.reuse.map((r) => `${r.value} = ${r.constant} (${r.definedIn}), raw ${r.count}x`), 5) + '. If it is the same quantity, use the constant.');
  if (M.repeated.length)
    add('q-constants-candidates', 'info', `${plural(M.repeated.length, 'number')} repeated without a name`, `${list(M.repeated.map((r) => `${r.value} x${r.count} in ${plural(r.files, 'file')}`), 6)}. Give each a named constant.`);
  if (M.denseFiles)
    add('q-magic-dense', 'info', `${plural(M.denseFiles, 'file')} with many magic numbers`, list(M.files.filter((f) => f.count >= lim.denseFile).map((f) => `${f.path} (${f.count})`), 5));
  if (M.total >= 20 && !M.constants.files.length && M.constants.definitions < 3)
    add('q-no-constants', 'info', 'No constants module', `${M.total} bare numbers and no constants file or named constants. Create a constants module (for example constants.js) and import from it.`);

  if (q.breakpointCount) add('q-debug', 'warn', `${plural(q.breakpointCount, 'debugger/breakpoint statement')}`, `${list(q.debug.filter((d) => d.severity === 'warn').map(at), 6)}. Remove before shipping.`);
  const logs = q.debugCount - q.breakpointCount;
  if (logs >= 10) add('q-console', 'info', `${logs} console.log calls in source`, 'Use a real logger or remove the leftovers.');

  if (q.markers.total)
    add('q-markers', q.markers.FIXME + q.markers.HACK ? 'warn' : 'info', `${plural(q.markers.total, 'TODO/FIXME marker')}`, `TODO ${q.markers.TODO}, FIXME ${q.markers.FIXME}, HACK ${q.markers.HACK}, XXX ${q.markers.XXX}. ${list(q.markers.items.map((m) => `${at(m)}`), 4)}.`);
  if (q.largeFiles.length)
    add('q-large-files', 'warn', `${plural(q.largeFiles.length, 'file')} over ${fmtSize(lim.bigFile)}`, `${list(q.largeFiles.map((f) => `${f.path} (${fmtSize(f.size)})`), 5)}. Large binaries bloat clones: use Git LFS or keep them out of the repo.`);
  if (q.sourceFiles >= 5 && !q.testFiles) add('q-no-tests', 'info', 'No test files found', `${q.sourceFiles} source files and no tests. Add some so changes can be checked.`);
  if (q.truncated) add('q-truncated', 'info', 'Very large repo: scan was capped', `Only the first ${lim.maxFiles} files were analysed.`);
  return out;
}

module.exports = { buildAdvice };
