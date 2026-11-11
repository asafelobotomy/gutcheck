// Remote repos: the hook-free shallow cache clone. A local bare repo stands in for GitHub; only the
// test's run wrapper allows the file transport, after GutCheck's own arguments.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run } = require('../src/exec');
const { createRemoteCache, defaultUrlFor, CLONE_CONFIG } = require('../src/remote-cache');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// An origin repo with one commit on `branch`; returns { bare, commit(msg, files) }.
function origin(branch = 'main', gitEnv = {}) {
  const base = tmp('gutcheck-rc-origin-');
  const work = path.join(base, 'work');
  const bare = path.join(base, 'bare.git');
  fs.mkdirSync(work);
  const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...gitEnv } });
  sh(work, 'init', '-q', '-b', branch); sh(work, 'config', 'user.email', 't@t'); sh(work, 'config', 'user.name', 't');
  const commit = (msg, files = {}) => {
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), c); }
    sh(work, 'add', '-A'); sh(work, 'commit', '-q', '--allow-empty', '-m', msg);
    sh(work, 'push', '-q', bare, `HEAD:refs/heads/${branch}`);
  };
  sh(base, 'init', '-q', '--bare', '-b', branch, bare);
  commit('init', { 'README.md': 'hi\n' });
  return { base, bare, work, sh, commit };
}

// The test's own run: records calls, and allows file:// only after GutCheck's -c list.
function testRun(extraEnv = {}) {
  const calls = [];
  const r = (cmd, args, opts = {}) => {
    calls.push({ cmd, args: [...args], env: opts.env || {} });
    let i = 0;
    while (args[i] === '-c') i += 2;
    const a = [...args.slice(0, i), '-c', 'protocol.file.allow=always', ...args.slice(i)];
    return run(cmd, a, { ...opts, env: { ...(opts.env || {}), ...extraEnv } });
  };
  return { run: r, calls };
}

const listing = (o = {}) => ({ owner: 'octo', name: 'app', isFork: false, isArchived: false, diskKB: 1, defaultBranch: 'main', pushedAt: '2026-11-01T00:00:00Z', ...o });

test('defaultUrlFor builds the GitHub https URL', () => {
  assert.equal(defaultUrlFor({ owner: 'octo', name: 'app' }), 'https://github.com/octo/app.git');
});

test('clone runs with the fixed safety config and arguments, then a same-pushedAt sync downloads nothing', async () => {
  const o = origin();
  const root = tmp('gutcheck-rc-root-');
  const t = testRun();
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  const r = await cache.sync(listing());
  assert.ok(r.ok, r.error);
  assert.equal(r.fetched, true);
  assert.equal(r.dir, path.join(root, 'octo__app'));
  assert.ok(fs.existsSync(path.join(r.dir, 'README.md')));
  const clone = t.calls.find((c) => c.args.includes('clone'));
  const at = clone.args.indexOf('clone');
  assert.deepEqual(clone.args.slice(0, CLONE_CONFIG.length), CLONE_CONFIG);
  assert.ok(clone.args.slice(0, at).includes('filter.lfs.smudge='));
  assert.deepEqual(CLONE_CONFIG, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never', '-c', 'protocol.file.allow=never', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false']);
  assert.deepEqual(clone.args.slice(at, at + 11), ['clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', 'main', '--no-recurse-submodules', '--origin', 'origin', '--']);
  assert.equal(clone.env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.equal(clone.env.GIT_TERMINAL_PROMPT, '0');
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'octo__app.json'), 'utf8'));
  assert.equal(meta.branch, 'main');
  assert.equal(meta.pushedAt, '2026-11-01T00:00:00Z');

  const before = t.calls.length;
  const again = await cache.sync(listing());
  assert.ok(again.ok);
  assert.equal(again.fetched, false);
  assert.ok(!t.calls.slice(before).some((c) => c.args.includes('fetch') || c.args.includes('clone')), 'no network call');
});

test('a newer pushedAt fetches the new commit', async () => {
  const o = origin();
  const root = tmp('gutcheck-rc-root-');
  const t = testRun();
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  await cache.sync(listing());
  o.commit('two', { 'NEW.md': 'new\n' });
  const r = await cache.sync(listing({ pushedAt: '2026-11-02T00:00:00Z' }));
  assert.ok(r.ok, r.error);
  assert.equal(r.fetched, true);
  assert.ok(fs.existsSync(path.join(r.dir, 'NEW.md')));
  assert.ok(t.calls.some((c) => c.args.includes('fetch')), 'refreshed by fetch, not a new clone');
});

test('a renamed default branch is cloned again', async () => {
  const o = origin();
  const root = tmp('gutcheck-rc-root-');
  const t = testRun();
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  await cache.sync(listing());
  o.sh(o.work, 'push', '-q', o.bare, 'HEAD:refs/heads/trunk');
  const r = await cache.sync(listing({ defaultBranch: 'trunk' }));
  assert.ok(r.ok, r.error);
  assert.equal(t.calls.filter((c) => c.args.includes('clone')).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'octo__app.json'), 'utf8')).branch, 'trunk');
});

test('a clone whose config gained a key clone never writes is replaced, never fetched into', async () => {
  const o = origin();
  const root = tmp('gutcheck-rc-root-');
  const t = testRun();
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  const r = await cache.sync(listing());
  const pwned = path.join(root, 'pwned');
  execFileSync('git', ['config', 'core.sshCommand', `touch ${pwned}`], { cwd: r.dir });
  const before = t.calls.length;
  const again = await cache.sync(listing({ pushedAt: '2026-11-03T00:00:00Z' }));
  assert.ok(again.ok, again.error);
  assert.ok(!t.calls.slice(before).some((c) => c.args.includes('fetch')), 'no fetch into a tampered clone');
  assert.ok(t.calls.slice(before).some((c) => c.args.includes('clone')));
  assert.throws(() => execFileSync('git', ['config', '--local', '--get', 'core.sshCommand'], { cwd: again.dir, stdio: 'pipe' }), 'the fresh clone has no sshCommand');
  assert.ok(!fs.existsSync(pwned));
});

test('an LFS filter from the user config never runs during clone or refresh', async () => {
  const home = tmp('gutcheck-rc-home-');
  const marker = path.join(home, 'marker');
  const gcfg = path.join(home, 'gitconfig');
  fs.writeFileSync(gcfg, `[filter "lfs"]\n\tsmudge = touch ${marker}\n\tprocess = touch ${marker}\n\trequired = true\n[user]\n\temail = t@t\n\tname = t\n`);
  const o = origin('main', { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12\n';
  o.commit('lfs', { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'big.bin': pointer });
  const root = tmp('gutcheck-rc-root-');
  const t = testRun({ GIT_CONFIG_GLOBAL: gcfg, GIT_CONFIG_NOSYSTEM: '1' });
  const cache = createRemoteCache({ root, run: t.run, urlFor: () => o.bare });
  const r = await cache.sync(listing());
  assert.ok(r.ok, r.error);
  assert.ok(!fs.existsSync(marker), 'smudge did not run on clone');
  assert.equal(fs.readFileSync(path.join(r.dir, 'big.bin'), 'utf8'), pointer);
  o.commit('more', { 'other.bin': pointer });
  const again = await cache.sync(listing({ pushedAt: '2026-11-05T00:00:00Z' }));
  assert.ok(again.ok, again.error);
  assert.ok(!fs.existsSync(marker), 'smudge did not run on refresh');
});

test('evictFor deletes least recently scanned first and stops once it fits; cleanup leaves other files', async () => {
  const root = tmp('gutcheck-rc-evict-');
  const mk = (key, at, bytes) => {
    fs.mkdirSync(path.join(root, key));
    fs.writeFileSync(path.join(root, key, 'f'), Buffer.alloc(bytes));
    fs.writeFileSync(path.join(root, key + '.json'), JSON.stringify({ branch: 'main', pushedAt: null, clonedAt: at, lastScannedAt: at }));
  };
  mk('o__old', 1, 1000); mk('o__mid', 2, 1000); mk('o__new', 3, 1000); mk('o__kept', 0, 1000);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'mine');
  const cache = createRemoteCache({ root, run: async () => ({ ok: false }) });
  const total = cache.sizeBytes();
  assert.ok(total >= 4000);
  const gone = cache.evictFor(1500, total, new Set(['o/kept']));
  assert.deepEqual(gone, ['o/old', 'o/mid']);
  assert.ok(fs.existsSync(path.join(root, 'o__kept')));
  assert.ok(!fs.existsSync(path.join(root, 'o__old.json')));
  const cleaned = cache.cleanup(new Set(['o/kept']));
  assert.deepEqual(cleaned, ['o/new']);
  assert.ok(fs.existsSync(path.join(root, 'notes.txt')), 'files GutCheck did not make stay');
  assert.ok(fs.existsSync(path.join(root, 'o__kept')));
  cache.clear();
  assert.ok(!fs.existsSync(path.join(root, 'o__kept')));
  assert.ok(fs.existsSync(path.join(root, 'notes.txt')));
});

test('a failed clone reports git\'s first line without credentials', async () => {
  const root = tmp('gutcheck-rc-fail-');
  const fake = async () => ({ ok: false, code: 128, stdout: '', stderr: "fatal: could not read from 'https://user:tok@github.com/o/n.git'\nmore" });
  const cache = createRemoteCache({ root, run: fake });
  const r = await cache.sync(listing());
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes('tok'), r.error);
  assert.match(r.error, /^fatal: could not read from 'https:\/\/github.com\/o\/n.git'$/);
  assert.ok(!fs.existsSync(path.join(root, 'octo__app')), 'no half clone left');
});
