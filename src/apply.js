// Runs a stored plan from actions.js. Each step kind is handled here; every file step re-checks,
// at the last moment, that its target is still inside the repo and unchanged since the preview.

const fs = require('node:fs');
const path = require('node:path');
const { run, READONLY_GIT } = require('./exec');
const { COMMAND_TIMEOUT_MS } = require('./util');
const { scanClutter } = require('./clutter');

const defaultCtx = (over = {}) => {
  const ctx = { run, fs, readOnly: false, clutter: scanClutter, ...over };
  // Recoverable removal. The app passes Electron's shell.trashItem; this fallback uses gio.
  ctx.trash = ctx.trash || (async (p) => {
    const t = await ctx.run('gio', ['trash', '--', p]);
    if (!t.ok) throw new Error('Could not move to trash (is gio installed?): ' + t.stderr.trim());
  });
  return ctx;
};

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

async function apply(p, ctx = {}) {
  ctx = defaultCtx(ctx);
  const io = ctx.fs;
  const results = [];
  for (const s of p.steps) {
    if (s.kind === 'check') {
      const r = await ctx.run(s.cmd, s.args, { cwd: s.cwd });
      const now = r.ok ? r.stdout.trim() : null;
      // subset: fewer lines than previewed is fine (a .gitignore added just before hides some), but
      // nothing that was not previewed may appear.
      const want = new Set(String(s.expect).split('\n'));
      const same = now != null && (s.subset ? now !== '' && now.split('\n').every((l) => want.has(l)) : now === s.expect);
      results.push({ text: s.display, ok: same, out: same ? '' : now === '' && s.subset ? 'Nothing is left to commit.' : 'The files changed since the preview. Rescan and review it again.' });
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
        const tr = await ctx.run('git', [...READONLY_GIT, 'ls-files', '-z', '--', s.rel], { cwd: s.root });
        if (!tr.ok || tr.stdout) throw new Error('Tracked by git (or could not be checked): not removed.');
        if (s.mode === 'trash') await ctx.trash(s.path);
        else io.rmSync(s.path, { recursive: true, force: true });
        results.push({ text: s.display, ok: true, out: '' });
      } catch (e) {
        if (e && e.code === 'ENOENT') { results.push({ text: s.display, ok: true, out: 'already gone' }); continue; }
        results.push({ text: s.display, ok: false, out: String(e.message) });
        return { ok: false, results };
      }
    } else if (s.kind === 'mkdir') {
      // Only GutCheck's own run folder (layer-3 test runs), never inside a repo.
      try { io.mkdirSync(s.path, { recursive: true, mode: 0o700 }); results.push({ text: s.display, ok: true, out: '' }); } catch (e) { results.push({ text: s.display, ok: false, out: String(e.message) }); return { ok: false, results }; }
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
