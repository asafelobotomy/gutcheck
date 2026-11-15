// Regression tests from running GutCheck over ~/Projects on 2026-11-15: a branch made from origin/main
// whose "safe" Push would have landed on main, a diverged branch offered a fast-forward, the secret
// scan reading GutCheck's own key-header regexes as keys, and golden-test env files called secrets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gutcheck-accbr-'));
const GLOBAL = path.join(ROOT, 'gitconfig');
fs.mkdirSync(path.join(ROOT, 'home'));
fs.writeFileSync(GLOBAL, '');
Object.assign(process.env, { HOME: path.join(ROOT, 'home'), GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { evaluate } = require('../src/checks');
const { buildReport } = require('../src/report');
const { plan, apply } = require('../src/actions');
const { scanRepo } = require('../src/scanner');
const { scanClutter } = require('../src/clutter');
const R = require('../src/quality/rules');
const { sshUrl } = require('./helpers/fake-ssh');

const sh = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
let n = 0;

const snap = (git) => ({
  remote: { owner: 'o', name: 'r', url: 'https://github.com/o/r', isPublic: true, description: 'x', defaultBranch: 'main', pushedAt: new Date().toISOString(), openIssues: 0 },
  git: { branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, branches: [], mergedBranches: [], ...git },
  files: { license: true, readme: true, gitignore: true, security: true, contributing: true, codeOfConduct: true, prTemplate: true },
  deps: { manifestsWithoutLock: [], needsInstall: false, outdated: null, outdatedNames: [] },
  ci: { failed: [], error: null }, prs: [], alerts: [], hasWorkflows: true, protection: true,
});
const find = (s, id) => evaluate(s).findings.find((f) => f.id === id);

test('a diverged branch is not offered a fast-forward pull or a push that would be rejected', () => {
  const s = snap({ branch: 'm1d-core', upstream: 'origin/m1d-core', ahead: 6, behind: 1 });
  const behind = find(s, 'git-behind');
  assert.match(behind.title, /diverged/);
  assert.doesNotMatch(behind.detail, /fast-forwarded/);
  assert.equal(behind.fix, undefined);
  assert.equal(find(s, 'git-ahead').fix, undefined);
  const r = { name: 'r', path: '/w/r', score: 50, grade: 'C', git: s.git, remote: s.remote, findings: evaluate(s).findings };
  const text = buildReport({ repos: [r] });
  assert.match(text, /git pull --rebase/);
  assert.doesNotMatch(text, /git pull --ff-only/);
});

test('a branch only behind its upstream still gets the fast-forward', () => {
  const f = find(snap({ behind: 2 }), 'git-behind');
  assert.equal(f.fix.type, 'pull');
  assert.match(f.detail, /fast-forwarded/);
});

test('a branch that tracks the default branch under another name says Push makes a branch of its own', () => {
  const s = snap({ branch: 'scoped-launches', upstream: 'origin/main', ahead: 1 });
  assert.match(find(s, 'git-ahead').detail, /default branch/);
  const r = { name: 'r', path: '/w/r', score: 50, grade: 'C', git: s.git, remote: s.remote, findings: evaluate(s).findings };
  assert.match(buildReport({ repos: [r] }), /git push -u origin 'scoped-launches'/);
});

test('pull refuses a diverged branch at plan time', async () => {
  const r = { path: ROOT, git: { branch: 'dev', upstream: 'origin/dev', ahead: 2, behind: 1, dirty: 0 } };
  const p = await plan(r, { type: 'pull' });
  assert.equal(p.ok, false);
  assert.match(p.error, /diverged/);
});

// A bare remote whose HEAD is main; a clone with a feature branch made from origin/main (so it tracks main).
function featureFromMain() {
  const bare = path.join(ROOT, `bare${++n}.git`);
  const d = path.join(ROOT, `work${n}`);
  sh(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@t');
  sh(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), '1\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-qm', 'one');
  sh(d, 'remote', 'add', 'origin', sshUrl(bare));
  sh(d, 'push', '-q', '-u', 'origin', 'main');
  sh(d, 'remote', 'set-head', 'origin', 'main');
  sh(d, 'switch', '-q', '-c', 'scoped-launches', '--track', 'origin/main');
  fs.writeFileSync(path.join(d, 'a.txt'), '2\n');
  sh(d, 'commit', '-qam', 'feature');
  return { d, bare };
}

test('Push never sends a branch that tracks the default branch onto it', async () => {
  const { d, bare } = featureFromMain();
  const main = sh(bare, 'rev-parse', 'main');
  const p = await plan(await scanRepo(d, {}), { type: 'push' });
  assert.ok(p.ok, JSON.stringify(p));
  assert.match(p.display[0].text, /-u -- origin refs\/heads\/scoped-launches:refs\/heads\/scoped-launches$/);
  assert.match(p.note, /default branch/);
  const a = await apply(p);
  assert.ok(a.ok, JSON.stringify(a));
  assert.equal(sh(bare, 'rev-parse', 'main'), main, 'main on the remote moved');
  assert.equal(sh(bare, 'rev-parse', 'scoped-launches'), sh(d, 'rev-parse', 'scoped-launches'));
  assert.equal(sh(d, 'rev-parse', '--abbrev-ref', 'scoped-launches@{u}'), 'origin/scoped-launches');
});

test('a private-key header inside a regex is not a key; a real header still is', () => {
  const HEAD = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----';
  assert.deepEqual(R.secretKinds(`  if (/^${HEAD}$/.test(l)) return 'ssh';`), []);
  assert.deepEqual(R.secretKinds(`    const m = /${HEAD}([\\s\\S]*?)-----END/.exec(t);`), []);
  assert.deepEqual(R.secretKinds(HEAD), ['Private key']);
  assert.deepEqual(R.secretKinds(`const k = "${HEAD}\\nb3BlbnNzaC1rZXk...";`), ['Private key']);
});

test('generated env files in golden test folders are config, not committed secrets', async () => {
  const d = path.join(ROOT, `env${++n}`);
  fs.mkdirSync(path.join(d, 'tests/golden/dark'), { recursive: true });
  sh(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'tests/golden/dark/shell.env'), '# Written by the daemon from the theme; edits are replaced.\nQS_ICON_THEME=Papirus\n');
  sh(d, 'add', '-A');
  sh(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  assert.equal((await scanClutter(d)).advice.find((a) => a.id === 'env-tracked'), undefined);
});
