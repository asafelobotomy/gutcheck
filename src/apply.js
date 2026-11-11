// Runs a stored plan from actions.js. Each step kind is handled here; every file step re-checks,
// at the last moment, that its target is still inside the repo and unchanged since the preview.

const fs = require('node:fs');
const path = require('node:path');
const exec = require('./exec');
const { run, READONLY_GIT, SAFE_GIT_ENV } = exec;
const { COMMAND_TIMEOUT_MS } = require('./util');
const { scanClutter } = require('./clutter');

const defaultCtx = (over = {}) => {
  const ctx = { run, fs, readOnly: false, clutter: scanClutter, ...over };
  // Read-only git for plans and checks: exec.git's guards (repo drivers blanked, no lazy fetch).
  // A runner injected by tests gets the fixed options only, since it runs no real git.
  ctx.safeGit = ctx.safeGit || (ctx.run === run ? (args, cwd, o = {}) => exec.git(args, { cwd, timeout: o.timeout, maxBuffer: o.maxBuffer }) : (args, cwd, o = {}) => ctx.run('git', [...READONLY_GIT, ...args], { cwd, env: SAFE_GIT_ENV, timeout: o.timeout, maxBuffer: o.maxBuffer }));
  // A repo's config entries for some keys, and those its own config decided (git-safety.js). An
  // injected runner has no real repo behind it, so it sees none.
  ctx.gitConfig = ctx.gitConfig || (ctx.run === run ? exec.configEntries : async () => ({ all: [], untrusted: [] }));
  // Recoverable removal. The app passes Electron's shell.trashItem; this fallback uses gio.
  ctx.trash = ctx.trash || (async (p) => {
    const t = await ctx.run('gio', ['trash', '--', p]);
    if (!t.ok) throw new Error('Could not move to trash (is gio installed?): ' + t.stderr.trim());
  });
  return ctx;
};

// Copy a planned list of files out of a repo (the rescue copy). Every file is checked before any is
// copied: still a regular file inside the repo, with the size and mtime the preview showed. Nothing
// is overwritten (COPYFILE_EXCL); new folders are private (0700).
function copyFiles(io, s) {
  const rootReal = io.realpathSync(s.root);
  const srcs = s.files.map((f) => {
    const src = path.join(s.root, f.rel);
    const parent = io.realpathSync(path.dirname(src));
    if (parent !== rootReal && !parent.startsWith(rootReal + path.sep)) throw new Error('Path is outside the repository.');
    const st = io.lstatSync(src);
    if (!st.isFile() || st.size !== f.size || st.mtimeMs !== f.mtimeMs) throw new Error('Files changed since the preview. Rescan and review it again.');
    return { src, dst: path.join(s.dest, f.rel) };
  });
  for (const { src, dst } of srcs) {
    io.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    io.copyFileSync(src, dst, io.constants.COPYFILE_EXCL);
  }
}

// Files we write or append to must really live inside the repo: no symlinked file or folder may
// redirect the write elsewhere (a scanned repo is not necessarily trusted).
function assertInside(io, root, file) {
  const rootReal = io.realpathSync(root);
  let dir = path.dirname(file);
  while (!io.existsSync(dir)) dir = path.dirname(dir); // folders still to be created
  const real = io.realpathSync(dir);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('Path is outside the repository.');
  let st = null;
  try { st = io.lstatSync(file); } catch {}
  if (st && st.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link.');
}

// Whatever happens, the repo's cached git drivers are dropped: the action may have changed its
// config or branch (includeIf onbranch:), and the rescan after it must read them afresh.
async function apply(p, ctx = {}) {
  try {
    return await applySteps(p, ctx);
  } finally {
    // A remote repo's key ("remote:owner/name") is not a folder and has no drivers to forget.
    for (const d of new Set([p.repoPath, ...(p.steps || []).map((s) => s.cwd || s.root)].filter((d) => d && !String(d).startsWith('remote:')))) exec.forgetGitDrivers(d);
  }
}

async function applySteps(p, ctx) {
  ctx = defaultCtx(ctx);
  const io = ctx.fs;
  const results = [];
  for (const s of p.steps) {
    if (s.kind === 'check' && s.expectFail) {
      // The command must fail in the expected way (for example GitHub's 404 for "no protection yet").
      const r = await ctx.run(s.cmd, s.args, { cwd: s.cwd });
      const same = !r.ok && s.expectFail.test(`${r.stdout}\n${r.stderr}`);
      results.push({ text: s.display, ok: same, out: same ? '' : r.ok ? 'It changed since the scan. Rescan and review it again.' : (r.stdout + r.stderr).trim().slice(-500) });
      if (!same) return { ok: false, results };
    } else if (s.kind === 'check') {
      const r = s.safeGit ? await ctx.safeGit(s.args, s.cwd) : await ctx.run(s.cmd, s.args, { cwd: s.cwd });
      const now = r.ok ? r.stdout.trimEnd() : null; // not trim(): " M a" keeps its leading status space
      // subset: fewer lines than previewed is fine (a .gitignore added just before hides some), but
      // nothing that was not previewed may appear.
      const want = new Set(String(s.expect).split('\n'));
      const same = now != null && (s.subset ? now !== '' && now.split('\n').every((l) => want.has(l)) : now === s.expect);
      results.push({ text: s.display, ok: same, out: same ? '' : now === '' && s.subset ? 'Nothing is left to commit.' : s.changed || 'The files changed since the preview. Rescan and review it again.' });
      if (!same) return { ok: false, results };
    } else if (s.kind === 'write') {
      try {
        assertInside(io, s.root, s.path);
        io.mkdirSync(path.dirname(s.path), { recursive: true });
        io.writeFileSync(s.path, s.content, { flag: 'wx' });
        results.push({ text: s.display, ok: true, out: '' });
      } catch (e) {
        results.push({ text: s.display, ok: false, out: String(e.message) });
        return { ok: false, results };
      }
    } else if (s.kind === 'append') {
      try {
        assertInside(io, s.root, s.path);
        const cur = io.existsSync(s.path) ? io.readFileSync(s.path, 'utf8') : '';
        io.appendFileSync(s.path, (cur && !cur.endsWith('\n') ? '\n' : '') + s.content);
        results.push({ text: s.display, ok: true, out: '' });
      } catch (e) {
        results.push({ text: s.display, ok: false, out: String(e.message) });
        return { ok: false, results };
      }
    } else if (s.kind === 'remove') {
      try {
        // Re-check at the last moment: the item must still sit directly inside the repo tree.
        const rootReal = io.realpathSync(s.root);
        const parentReal = io.realpathSync(path.dirname(s.path));
        if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) throw new Error('Path is outside the repository.');
        const st = io.lstatSync(s.path); // throws ENOENT when it is already gone
        if (s.fileStat && (st.size !== s.fileStat.size || st.mtimeMs !== s.fileStat.mtime)) throw new Error('Changed since the preview. Rescan and review it again.');
        // Might have been committed since the preview: never remove anything git tracks.
        // --literal-pathspecs: "a*b.tmp" is that one file, not a pattern that matches a tracked axb.tmp.
        const tr = await ctx.safeGit(['--literal-pathspecs', 'ls-files', '-z', '--', s.rel], s.root);
        if (!tr.ok || tr.stdout) throw new Error('Tracked by git (or could not be checked): not removed.');
        if (s.mode === 'trash') await ctx.trash(s.path);
        else io.rmSync(s.path, { recursive: true, force: true });
        results.push({ text: s.display, ok: true, out: '' });
      } catch (e) {
        if (e && e.code === 'ENOENT') { results.push({ text: s.display, ok: true, out: 'already gone' }); continue; }
        results.push({ text: s.display, ok: false, out: String(e.message) });
        return { ok: false, results };
      }
    } else if (s.kind === 'replace') {
      // Rewrite a file in the repo only if it is byte for byte what was previewed; keep a backup first
      // when the plan names one (outside the repo, in GutCheck's data folder).
      try {
        assertInside(io, s.root, s.path);
        const cur = io.readFileSync(s.path, 'utf8');
        if (require('node:crypto').createHash('sha256').update(cur).digest('hex') !== s.expect) throw new Error('Changed since the preview. Rescan and review it again.');
        if (s.backup) { io.mkdirSync(path.dirname(s.backup), { recursive: true, mode: 0o700 }); io.writeFileSync(s.backup, cur, { mode: 0o600 }); }
        // A new temp file (wx: never one that is already there, or a link someone placed), with the
        // original's permissions, then renamed over it.
        const tmp = `${s.path}.gutcheck-${require('node:crypto').randomBytes(4).toString('hex')}.tmp`;
        io.writeFileSync(tmp, s.content, { flag: 'wx', mode: io.statSync(s.path).mode & 0o7777 });
        io.renameSync(tmp, s.path);
        results.push({ text: s.display, ok: true, out: '' });
      } catch (e) {
        results.push({ text: s.display, ok: false, out: String(e.message) });
        return { ok: false, results };
      }
    } else if (s.kind === 'copy') {
      try { copyFiles(io, s); results.push({ text: s.display, ok: true, out: '' }); } catch (e) { results.push({ text: s.display, ok: false, out: String(e.message) }); return { ok: false, results }; }
    } else if (s.kind === 'mkdir' && s.exclusive) {
      // A new folder outside every guarded root (the rescue): checked again here, after the preview.
      try {
        io.mkdirSync(path.dirname(s.path), { recursive: true, mode: 0o700 });
        const real = path.join(io.realpathSync(path.dirname(s.path)), path.basename(s.path));
        const inside = (s.guard || []).some((g) => { let gr = g; try { gr = io.realpathSync(g); } catch {} return real === gr || real.startsWith(gr + path.sep); });
        if (inside) throw new Error('Choose a folder outside the workspace and its repos.');
        try { io.mkdirSync(s.path, { mode: 0o700 }); } catch (e) { throw e && e.code === 'EEXIST' ? new Error(`${s.path} already exists. Choose another folder.`) : e; }
        results.push({ text: s.display, ok: true, out: '' });
      } catch (e) { results.push({ text: s.display, ok: false, out: String(e.message) }); return { ok: false, results }; }
    } else if (s.kind === 'mkdir') {
      // Only GutCheck's own run folder (layer-3 test runs), never inside a repo.
      try { io.mkdirSync(s.path, { recursive: true, mode: 0o700 }); results.push({ text: s.display, ok: true, out: '' }); } catch (e) { results.push({ text: s.display, ok: false, out: String(e.message) }); return { ok: false, results }; }
    } else if (s.safeGit) {
      // git with the repo's hooks, filters and config-defined commands switched off (the rescue).
      const r = await ctx.safeGit(s.args, s.cwd, { timeout: s.timeout || COMMAND_TIMEOUT_MS });
      results.push({ text: s.display, ok: r.ok, out: (r.stdout + r.stderr).trim().slice(-2000) });
      if (!r.ok) return { ok: false, results };
    } else {
      const r = await ctx.run(s.cmd, s.args, { cwd: s.cwd, input: s.input, timeout: s.timeout || COMMAND_TIMEOUT_MS, env: s.env, maxBuffer: s.saveOutput ? 64 * 1024 * 1024 : undefined });
      // okCodes: tools that exit non-zero to report findings (mutmut exits 1-2 when mutants survive).
      const good = r.ok || (Array.isArray(s.okCodes) && s.okCodes.includes(r.code));
      if (s.saveOutput && good) { try { io.writeFileSync(s.saveOutput, r.stdout); } catch {} }
      results.push({ text: s.display, ok: good, out: (r.stdout + r.stderr).trim().slice(-2000) });
      if (!good) return { ok: false, results };
    }
  }
  return { ok: true, results };
}

module.exports = { apply, defaultCtx };
