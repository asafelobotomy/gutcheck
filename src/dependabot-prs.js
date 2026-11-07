// Dependabot PRs that the default branch has already overtaken: every package they bump is at or past
// the target version in the repo's lockfiles. Such a PR shows up as "conflicting" or "failing", but
// the right fix is to close it, not to rebase or repair it. Read-only: lockfiles are parsed as text.

const fs = require('node:fs');
const path = require('node:path');
const { cmpVersion } = require('./util');

// "Bump tar from 0.4.38 to 0.4.46 in /src-tauri" and, in a group PR's body, "Updates `electron` from 33.4.11 to 42.11.16".
function parseUpdates(title, body) {
  const out = [];
  const one = /^Bump (\S+) from (\S+) to (\S+)/.exec(title || '');
  if (one) out.push({ name: one[1], to: one[3] });
  for (const m of String(body || '').matchAll(/^Updates `([^`]+)` from (\S+) to (\S+?)\.?$/gm)) if (!out.some((u) => u.name === m[1])) out.push({ name: m[1], to: m[3] });
  return out;
}

const read = (f) => { try { const st = fs.statSync(f); return st.size <= 32 * 1024 * 1024 ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; } };

// ecosystem -> name -> [versions] from package-lock.json (npm), Cargo.lock (cargo), uv.lock/poetry.lock and
// requirements lock files (pip), at the root and one folder down (src-tauri/, app/, requirements/...).
// Kept per ecosystem: npm's tar and Rust's tar are different packages.
function lockVersions(dir) {
  const v = new Map([['npm', new Map()], ['cargo', new Map()], ['pip', new Map()]]);
  const put = (eco, name, ver) => { const m = v.get(eco); if (name && ver) m.set(name, [...(m.get(name) || []), ver]); };
  const dirs = [''];
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'target', 'dist', 'build'].includes(e.name)) dirs.push(e.name); } catch {}
  for (const d of dirs) {
    const p = (f) => path.join(dir, d, f);
    const npm = read(p('package-lock.json'));
    if (npm) { try { for (const [k, info] of Object.entries(JSON.parse(npm).packages || {})) { const i = k.lastIndexOf('node_modules/'); if (i >= 0) put('npm', k.slice(i + 13), info.version); } } catch {} }
    for (const [f, eco] of [['Cargo.lock', 'cargo'], ['uv.lock', 'pip'], ['poetry.lock', 'pip']]) for (const m of read(p(f)).matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"/gm)) put(eco, eco === 'pip' ? m[1].toLowerCase() : m[1], m[2]);
    let txt = [];
    try { txt = fs.readdirSync(path.join(dir, d)).filter((f) => /requirements.*\.txt$|\.lock\.txt$/.test(f)); } catch {}
    for (const f of txt) for (const m of read(p(f)).matchAll(/^([A-Za-z0-9_.-]+)==([^\s;\\]+)/gm)) put('pip', m[1].toLowerCase(), m[2]);
  }
  return v;
}

// Dependabot branches are dependabot/<ecosystem>/...: npm_and_yarn, cargo, pip, uv...
const ECO = { npm_and_yarn: 'npm', cargo: 'cargo', pip: 'pip', uv: 'pip', poetry: 'pip' };

// pr: { headRefName, updates } -> null, or [{ name, to, have }] when every update is already met.
function superseded(pr, versions) {
  const m = /^dependabot\/([^/]+)\//.exec(pr.headRefName || '');
  const eco = m && ECO[m[1]];
  if (!eco || !pr.updates || !pr.updates.length) return null;
  const known = versions.get(eco);
  const met = [];
  for (const u of pr.updates) {
    const have = [...(known.get(u.name) || known.get(u.name.toLowerCase()) || [])].sort(cmpVersion).pop();
    if (!have || cmpVersion(have, u.to) < 0) return null;
    met.push({ name: u.name, to: u.to, have });
  }
  return met;
}

module.exports = { parseUpdates, lockVersions, superseded };
