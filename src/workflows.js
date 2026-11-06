// GitHub Actions workflow audit, read from .github/workflows/*.yml as text (never executed).
// Rules follow GitHub's "Security hardening for GitHub Actions" (secure-use) and the OpenSSF
// Scorecard checks Dangerous-Workflow, Token-Permissions and Pinned-Dependencies.

const fs = require('node:fs');
const path = require('node:path');

const MAX_WORKFLOWS = 50;
const MAX_BYTES = 256 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;

// Attacker-controllable contexts (GitHub docs, "Understanding the risk of script injections"):
// github.head_ref and github.event.* values ending in body, default_branch, email, head_ref, label,
// message, name, page_name, ref or title.
const UNTRUSTED = /\$\{\{[^}]*\b(github\.head_ref|github\.event\.[\w.[\]'"*-]*?\b(?:body|default_branch|email|head_ref|label|message|name|page_name|ref|title))\b[^}]*\}\}/;
const PR_HEAD_CHECKOUT = /\$\{\{\s*github\.event\.pull_request\.head\.(?:sha|ref)\s*\}\}|\$\{\{\s*github\.head_ref\s*\}\}|refs\/pull\/\$\{\{/;

const indentOf = (l) => l.length - l.trimStart().length;

// Lines (1-based) that belong to `run:` scripts, inline or block (| / >).
function runLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyIndent = lines[i].indexOf('run:');
    if (!/^[|>][-+0-9]*\s*(#.*)?$/.test(m[2])) { out.push(i + 1); continue; }
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && indentOf(lines[j]) <= keyIndent) break;
      out.push(j + 1);
    }
  }
  return out;
}

function auditWorkflow(rel, text) {
  const lines = text.split('\n');
  const res = { file: rel, unpinned: [], injections: [], prTarget: false, headCheckout: false, topPermissions: false, writeAll: false, jobPermissions: false, selfHosted: false, codeql: false };
  const run = new Set(runLines(lines));
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '');
    const uses = !run.has(i + 1) && /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s]+)/.exec(line);
    if (uses) {
      const u = uses[1];
      if (/^github\/codeql-action\//.test(u)) res.codeql = true;
      const at = u.lastIndexOf('@');
      // Local actions (./) and docker images pinned by digest are fine; everything else needs a full SHA.
      if (!u.startsWith('./') && !(u.startsWith('docker://') && u.includes('@sha256:')) && (at < 0 || !SHA_RE.test(u.slice(at + 1)))) res.unpinned.push({ line: i + 1, uses: u });
    }
    if (run.has(i + 1) && UNTRUSTED.test(line)) res.injections.push({ line: i + 1, expr: UNTRUSTED.exec(line)[1] });
    if (/^\s*(?:-\s+)?(pull_request_target|workflow_run)\b|^on:.*\b(pull_request_target|workflow_run)\b/.test(line)) res.prTarget = true;
    if (PR_HEAD_CHECKOUT.test(line) && /\bref:/.test(line)) res.headCheckout = true;
    if (/^permissions:/.test(line)) { res.topPermissions = true; if (/write-all/.test(line)) res.writeAll = true; }
    else if (/^\s+permissions:/.test(line) && !run.has(i + 1)) { res.jobPermissions = true; if (/write-all/.test(line)) res.writeAll = true; }
    if (/^\s*runs-on:.*self-hosted/.test(line)) res.selfHosted = true;
  });
  return res;
}

// Returns null when the repo has no workflows folder.
function auditWorkflows(dir) {
  const wfDir = path.join(dir, '.github', 'workflows');
  let names;
  try { names = fs.readdirSync(wfDir).filter((n) => /\.ya?ml$/i.test(n)).sort().slice(0, MAX_WORKFLOWS); } catch { return null; }
  const files = [];
  for (const n of names) {
    const abs = path.join(wfDir, n);
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      files.push(auditWorkflow('.github/workflows/' + n, fs.readFileSync(abs, 'utf8')));
    } catch {}
  }
  return {
    files: files.length,
    unpinned: files.flatMap((f) => f.unpinned.map((u) => ({ file: f.file, ...u }))),
    injections: files.flatMap((f) => f.injections.map((x) => ({ file: f.file, ...x }))),
    prTarget: files.filter((f) => f.prTarget).map((f) => ({ file: f.file, headCheckout: f.headCheckout })),
    noPermissions: files.filter((f) => !f.topPermissions).map((f) => ({ file: f.file, jobLevel: f.jobPermissions })),
    writeAll: files.filter((f) => f.writeAll).map((f) => f.file),
    selfHosted: files.filter((f) => f.selfHosted).map((f) => f.file),
    codeql: files.some((f) => f.codeql),
  };
}

module.exports = { auditWorkflows, auditWorkflow, runLines };
