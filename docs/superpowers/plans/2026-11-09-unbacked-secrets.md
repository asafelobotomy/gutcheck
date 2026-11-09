# Unbacked Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find dev secrets that exist only on this machine and back them up to the password manager the user links, by plan, preview, apply. SSH keys go in as Proton SSH key items.

**Architecture:**
- **The scan** (`secrets.js`) is read-only and on demand, like clutter, quality and tests. It produces candidates, and `secret-status.js` joins them with a local backup record to give statuses and advice.
- **Adapters** (`vault-adapters.js`) only build command lines and parse output.
- **A controller** (`secrets-ctl.js`) handles linking, plan tokens, apply (read once, hash, pipe), Verify and skips, and is the only place that runs a vault CLI. Its tokens carry an `s:` prefix through `engine.apply`, the same way agent fixes use `a:`.
- **Surfaces:** a "Secrets" view in the app, `gutcheck secrets` in the CLI, and a read-only `gutcheck_secrets` tool over MCP.

**Tech Stack:** Node 22 (CommonJS, `node:test`, `node:crypto`), Electron IPC, plain DOM renderer, jsdom tests.

**Spec:** `docs/superpowers/specs/2026-11-09-unbacked-secrets-design.md`

## Changes from the spec (decided while reading the code)

1. **Secrets is its own on-demand scan, not part of the clutter scan.** It follows the `clutterScan` / `testsScan` pattern in `service.js`. Clutter is on demand too, so piggybacking would have bought nothing and tied the two together.
2. **Saving happens in the controller, not in `apply.js` / `ACTIONS`.** The generic `cmd` step in `apply.js:115-120` copies the CLI's stdout and stderr into `results[].out`, which could leak a secret. The controller has its own token store (single use, 5-minute lifetime), as `agent-connect.js:184-226` does.
3. **Fix all integration is left out of v1.** Secrets aren't per-repo findings in the main scan. Their advice reaches "Copy for LLM" through `buildReport` the same way clutter advice does.
4. **Vault writes are refused over MCP in the engine**, by token prefix and action, not just in the tool descriptions.

## Global Constraints

- **Contents never leave the backup step.** No finding, report, plan display, result, log, audit entry or record holds secret contents. Paths, sizes, item titles and public key fingerprints are allowed. The sha256 goes only in the record (mode 0600).
- **Contents never go on a command line.** Every vault CLI gets the content on stdin only.
- **Scans never call a vault CLI.** They only `stat`, read headers (the first line, or the unencrypted public part of an OpenSSH key) and hash files.
- **Size limit:** files over 1 MB are never candidates or saved (`MAX_SECRET_BYTES = 1048576`).
- **Bitwarden notes:** limit 10,000 characters (`BW_NOTE_MAX = 10000`).
- **Item titles:** `gutcheck: <repo-name>/<rel-path>`, `gutcheck: ~/<rel-to-home>`, `gutcheck: workspace/<name>`.
- **Record file:** `<dataDir>/secret-backups.json`, `{ version: 1, entries: {}, skipped: {} }`, written atomically (temp file then rename) with mode 0600.
- **GutCheck never** deletes local files or vault items, and never handles master passwords, session tokens or passphrases.
- **Every new or changed file stays under 400 lines.** Changes are noted under `## [Unreleased]` in `CHANGELOG.md`, and each new rule's source goes in `docs/sources.md`.
- **Run commands in the foreground and leave nothing running in the background. Don't wait on CI.** (Pass both rules on to any subagent you brief.)

## Review Focus

1. **A symlinked secret** (`.env -> ../shared/.env`): it's listed once by its real path and never saved through the link. Tested in Task 2.
2. **A vault CLI that waits for an interactive prompt** (bw/op locked, keepassxc asking for a password): GutCheck must not hang. Stdin is always given and closed, there's a 60 s timeout, and the result says "locked". Tested in Task 5.
3. **A CLI error that echoes the input** (a parser printing the line it choked on): the shown error must not contain any line of the file. Tested in Task 5.
4. **The same secret copied into two repos:** backing one up shows the other as `backed (same as …)`. Tested in Task 3.
5. **An unreadable home file** (`EACCES` on `~/.aws/credentials`) or a missing home folder: skipped with no crash. Tested in Task 2.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/secret-patterns.js` (new) | Name rules, template and fixture rules, first-line classification, OpenSSH fingerprint. Pure functions, no I/O apart from `readHead`. |
| `src/secrets.js` (new) | Read-only discovery: repo walk, workspace root and the fixed home list. Returns candidates with sha256 and SSH info. |
| `src/secret-status.js` (new) | Record load/save, status per candidate, advice/findings builder. |
| `src/vault-adapters.js` (new) | One adapter per tool: argv builders, `encode`, `parseId`, status/exists parsing. No process spawning. |
| `src/secrets-ctl.js` (new) | Link and test, plan tokens, apply, verify, skip/unskip, audit. The only module that runs a vault CLI. |
| `src/renderer/secrets-view.js` (new) | Secrets view and the "Password manager" link panel. |
| `src/actions.js` | Import `looksSecret` from `secret-patterns.js` instead of defining it. |
| `src/service.js`, `src/engine.js`, `src/mcp.js`, `src/cli.js`, `src/main.js`, `src/preload.js`, `src/report.js` | Wiring. |
| `src/renderer/index.html`, `src/renderer/app.js`, `test/helpers/dom.js` | Load and route the view. |
| `docs/sources.md`, `CHANGELOG.md`, `README.md` | Docs. |

---

### Task 1: Secret patterns and SSH fingerprint

**Files:**
- Create: `src/secret-patterns.js`
- Modify: `src/actions.js:46-49` (delete `SECRET_NAME`, `ENV_TEMPLATE`, `looksSecret`; import `looksSecret`)
- Test: `test/secrets.test.js`

**Interfaces:**
- Produces:
  - `looksSecret(relPath: string) -> boolean`: the existing `actions.js` behaviour plus the new names.
  - `isFixturePath(relPath) -> boolean`: the path has a segment `test|tests|testdata|fixtures|__fixtures__`.
  - `classifyHead(firstLine: string, { inSshDir: boolean, name: string }) -> 'ssh' | 'pem' | null`.
  - `opensshFingerprint(text: string) -> { type: string, fingerprint: string } | null`.
  - `readHead(file, bytes = 4096) -> Promise<string>`.
  - `MAX_SECRET_BYTES`.

- [ ] **Step 1: Write the failing tests** in `test/secrets.test.js`:

```js
const P = require('../src/secret-patterns');
test('looksSecret: env files and keys, not templates or public keys', () => {
  for (const p of ['.env', 'api/.env.local', 'certs/server.key', 'a.pem', 'id_ed25519', 'ks.jks', 'credentials.json', 'service-account-prod.json', 'gcp-credentials.json', 'client_secret_123.json', 'android/key.properties', 'App.mobileprovision', '.netrc', '.pgpass'])
    assert.ok(P.looksSecret(p), p);
  for (const p of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'id_ed25519.pub', 'README.md', 'package.json'])
    assert.ok(!P.looksSecret(p), p);
});
test('isFixturePath', () => {
  assert.ok(P.isFixturePath('test/fixtures/key.pem'));
  assert.ok(P.isFixturePath('pkg/testdata/id_rsa'));
  assert.ok(!P.isFixturePath('src/attest/key.pem'));
});
test('classifyHead: TLS keys are never SSH', () => {
  assert.equal(P.classifyHead('-----BEGIN OPENSSH PRIVATE KEY-----', { inSshDir: false, name: 'x' }), 'ssh');
  assert.equal(P.classifyHead('-----BEGIN RSA PRIVATE KEY-----', { inSshDir: true, name: 'deploy' }), 'ssh');
  assert.equal(P.classifyHead('-----BEGIN RSA PRIVATE KEY-----', { inSshDir: false, name: 'id_rsa' }), 'ssh');
  assert.equal(P.classifyHead('-----BEGIN RSA PRIVATE KEY-----', { inSshDir: false, name: 'server.key' }), 'pem');
  assert.equal(P.classifyHead('-----BEGIN PRIVATE KEY-----', { inSshDir: true, name: 'tls' }), 'pem');
  assert.equal(P.classifyHead('API_KEY=1', { inSshDir: false, name: '.env' }), null);
});
test('opensshFingerprint matches ssh-keygen -l, plain and encrypted', () => {
  // keygen into a temp dir: ed25519 with -N '' and with -N 'pw'
  // for each: P.opensshFingerprint(fs.readFileSync(k,'utf8')).fingerprint ===
  //   execFileSync('ssh-keygen',['-lf',k+'.pub']).toString().split(' ')[1]; type === 'ssh-ed25519'
  // returns null for a PEM RSA key and for garbage
});
```

`opensshFingerprint` uses `test.skip` when `ssh-keygen` isn't on PATH.

- [ ] **Step 2: Run** `node --test test/secrets.test.js`. Expected: FAIL, `Cannot find module '../src/secret-patterns'`.

- [ ] **Step 3: Implement `src/secret-patterns.js`.** `looksSecret` takes the regexes from `actions.js:47-49` and adds `credentials\.json|service-account.*\.json|.*-credentials\.json|client_secret.*\.json|key\.properties|.+\.mobileprovision` and excludes `*.pub`.

`opensshFingerprint` decodes the OpenSSH container like this:

```js
// body = base64 between the BEGIN/END OPENSSH PRIVATE KEY lines
// buf starts with "openssh-key-v1\0"; then uint32-length strings: ciphername, kdfname, kdfoptions;
// uint32 nkeys; then uint32-length pubkey blob. type = first length-prefixed string inside the blob.
// fingerprint = 'SHA256:' + sha256(blob).toString('base64').replace(/=+$/, '')
```

Return `null` on any bounds error.

- [ ] **Step 4: Change `src/actions.js`** to `const { looksSecret } = require('./secret-patterns');` and remove its three local definitions.

- [ ] **Step 5: Run** `node --test test/secrets.test.js test/actions.test.js test/fix-hardening.test.js`. Expected: PASS.

- [ ] **Step 6: Commit:**

```bash
git add src/secret-patterns.js src/actions.js test/secrets.test.js
git commit -m "Secrets: name patterns, SSH key classification and fingerprints"
```

### Task 2: Discovery (`secrets.js`)

**Files:**
- Create: `src/secrets.js`
- Test: `test/secrets.test.js` (append)

**Interfaces:**
- Consumes: Task 1 exports; `HEAVY_DIRS` from `src/util.js`; `git` from `src/exec.js` (`ls-files -z` for the tracked set, as `clutter.js:59` `trackedSet` does).
- Produces:
  - `findRepoSecrets(dir: string) -> Promise<Candidate[]>`
  - `findWorkspaceSecrets(root: string) -> Promise<Candidate[]>`: loose `.env*` in the root, not templates.
  - `findHomeSecrets({ home, env }) -> Promise<Candidate[]>`
  - `Candidate = { abs, real, scope: 'repo'|'workspace'|'home', repo: string|null, rel, title, size, sha256, kind: 'ssh'|'pem'|'file', fingerprint: string|null, keyType: string|null, confidence: 'high'|'low' }`
  - `title` follows the global title rule.
  - `confidence` is `low` for fixture paths.

- [ ] **Step 1: Write the failing tests.** Use a temp git repo (reuse the `repo()` / `put()` helpers style from `test/clutter.test.js:10-24`) and a temp HOME:

```js
const S = require('../src/secrets');
test('repo: ignored and untracked secrets found; committed, template, big and node_modules skipped', async () => {
  // put .env (ignored via .gitignore), config/.env.local (untracked), .env.example, server.key (committed),
  // node_modules/x/.env, big.pem (1 MB + 1), test/fixtures/id_rsa (OPENSSH header)
  const c = await S.findRepoSecrets(dir);
  assert.deepEqual(c.map((x) => x.rel).sort(), ['.env', 'config/.env.local', 'test/fixtures/id_rsa']);
  assert.equal(c.find((x) => x.rel === 'test/fixtures/id_rsa').confidence, 'low');
  assert.match(c[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(c.find((x) => x.rel === '.env').title, `gutcheck: ${path.basename(dir)}/.env`);
});
test('repo: a symlinked secret is reported once by its real path', async () => {
  // shared/.env real file (ignored) + app/.env -> ../shared/.env
  const c = await S.findRepoSecrets(dir);
  assert.equal(c.filter((x) => x.real.endsWith('shared/.env')).length, 1);
  assert.ok(c.every((x) => x.abs === x.real));
});
test('home: fixed list only, content-gated, unreadable files skipped', async () => {
  // HOME/.ssh/id_ed25519 (keygen, plain), HOME/.ssh/known_hosts, HOME/.ssh/config,
  // HOME/.npmrc without token, HOME/.pypirc, HOME/.docker/config.json {"auths":{}},
  // HOME/.aws/credentials chmod 000 (skip this assertion when running as root)
  const c = await S.findHomeSecrets({ home, env: {} });
  assert.deepEqual(c.map((x) => x.title).sort(), ['gutcheck: ~/.pypirc', 'gutcheck: ~/.ssh/id_ed25519']);
  assert.equal(c.find((x) => x.kind === 'ssh').fingerprint.startsWith('SHA256:'), true);
});
test('home: .npmrc with _authToken and docker auths with auth are found', async () => { /* ... */ });
test('home: a missing HOME returns []', async () => {
  assert.deepEqual(await S.findHomeSecrets({ home: '/nonexistent-gc', env: {} }), []);
});
```

- [ ] **Step 2: Run** `node --test test/secrets.test.js`. Expected: the new tests FAIL with `Cannot find module '../src/secrets'`.

- [ ] **Step 3: Implement `src/secrets.js`.**
  - **Repo walk:** `fsp.readdir` with `withFileTypes`. Skip `.git`, `HEAVY_DIRS` and `.venv/venv/.next/.nuxt/.svelte-kit/.gradle/.cxx`. Limits are `MAX_DEPTH = 6` and `MAX_FILES = 40000`, the same as `clutter.js:18-19`.
  - **Matching:** a file counts when `looksSecret(rel)` is true and it isn't in the tracked set.
  - **Symlinks:** `lstat`, then `realpath`, and dedupe by `real`. Drop it if the real target is a tracked file or lies outside the repo and the home list. Set `abs = real`.
  - **Hashing:** `crypto.createHash('sha256')` over `fsp.readFile` (files are 1 MB or less).
  - **Home list:** exactly the spec §1 list. Gate `.npmrc` with `/^\s*[^#;].*(_authToken|_auth)\s*=/m` and `.docker/config.json` with `JSON.parse(...).auths` having any value with an `auth` key. Under `~/.ssh`, check every regular file with `classifyHead(readHead(f).split('\n')[0], { inSshDir: true, name })` and keep only `'ssh'`.
  - **`~/.gnupg/private-keys-v1.d/`:** one candidate, `kind: 'file'`, when the folder isn't empty. `sha256` is the hash of the sorted `name:size` list, so a new key changes it.
  - **Errors:** any per-file error (EACCES, ENOENT) is skipped.

- [ ] **Step 4: Run** `node --test test/secrets.test.js`. Expected: PASS.

- [ ] **Step 5: Commit:**

```bash
git add src/secrets.js test/secrets.test.js
git commit -m "Secrets: read-only discovery in repos, workspace root and home"
```

### Task 3: Backup record and status (`secret-status.js`)

**Files:**
- Create: `src/secret-status.js`
- Test: `test/secrets.test.js` (append)

**Interfaces:**
- Consumes: `Candidate` (Task 2).
- Produces:
  - `createRecord(file) -> { load(): Record, save(Record): void, update(fn: (Record) => void): Record }`
  - `Record = { version: 1, entries: { [real]: Entry }, skipped: { [real]: { reason, at } } }`
  - `Entry = { sha256, tool, target, itemId, title, kind, fingerprint, at, missing?: boolean, mismatch?: boolean }`
  - `statusOf(c: Candidate, rec: Record) -> { status: 'unbacked'|'changed'|'backed'|'skipped'|'missing'|'mismatch', sameAs?: string }`
  - `secretAdvice(cands: Candidate[], rec: Record, { linked: boolean }) -> Advice[]`
    - `Advice = { id, category: 'Secrets', severity, title, detail, fix }`
    - `id` is `secret-unbacked`, `secret-changed`, `ws-secret-unbacked` or `ws-secret-changed`
    - `fix` is `{ type: 'secret-backup', paths: string[] }` when linked, else `{ type: 'secret-link' }`

- [ ] **Step 1: Write the failing tests:**

```js
const R = require('../src/secret-status');
const cand = (o) => ({ abs: '/r/.env', real: '/r/.env', scope: 'repo', repo: 'r', rel: '.env', title: 'gutcheck: r/.env', size: 3, sha256: 'a'.repeat(64), kind: 'file', fingerprint: null, keyType: null, confidence: 'high', ...o });
test('statusOf covers every state', () => {
  const rec = { version: 1, entries: { '/r/.env': { sha256: 'a'.repeat(64) }, '/r/old': { sha256: 'b'.repeat(64) }, '/r/gone': { sha256: 'c'.repeat(64), missing: true }, '/r/k': { sha256: 'd'.repeat(64), mismatch: true } }, skipped: { '/r/t.key': { reason: 'throwaway', at: '' } } };
  assert.equal(R.statusOf(cand(), rec).status, 'backed');
  assert.equal(R.statusOf(cand({ real: '/r/old' }), rec).status, 'changed');
  assert.equal(R.statusOf(cand({ real: '/r/new' }), rec).status, 'unbacked');
  assert.equal(R.statusOf(cand({ real: '/r/gone', sha256: 'c'.repeat(64) }), rec).status, 'missing');
  assert.equal(R.statusOf(cand({ real: '/r/k', sha256: 'd'.repeat(64) }), rec).status, 'mismatch');
  assert.equal(R.statusOf(cand({ real: '/r/t.key' }), rec).status, 'skipped');
});
test('a copy of a backed-up file counts as backed', () => {
  const rec = { version: 1, entries: { '/a/.env': { sha256: 'a'.repeat(64) } }, skipped: {} };
  assert.deepEqual(R.statusOf(cand({ real: '/b/.env' }), rec), { status: 'backed', sameAs: '/a/.env' });
});
test('record file is 0600, atomic and survives a corrupt file', () => {
  // save then statSync(file).mode & 0o777 === 0o600; write 'nope' to file -> load() returns empty v1 record
});
test('advice: paths only, no contents; low-confidence excluded from severity', () => {
  const a = R.secretAdvice([cand(), cand({ real: '/r/test/fixtures/id_rsa', rel: 'test/fixtures/id_rsa', confidence: 'low' })], { version: 1, entries: {}, skipped: {} }, { linked: true });
  const u = a.find((x) => x.id === 'secret-unbacked');
  assert.equal(u.severity, 'warn');
  assert.match(u.title, /^1 secret file exists only on this machine$/);
  assert.match(u.detail, /Probably test keys: test\/fixtures\/id_rsa/);
  assert.deepEqual(u.fix, { type: 'secret-backup', paths: ['/r/.env'] });
});
```

- [ ] **Step 2: Run** `node --test test/secrets.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/secret-status.js`.** Handle the record I/O like `settings.js` (temp file then rename) and add `{ mode: 0o600 }` to the write. Use `plural` and `list` from `util.js` for titles and details. `missing` and `mismatch` count toward `unbacked` in the advice, and the detail names them.
- [ ] **Step 4: Run** `node --test test/secrets.test.js`. Expected: PASS.
- [ ] **Step 5: Commit:**

```bash
git add src/secret-status.js test/secrets.test.js
git commit -m "Secrets: backup record, statuses and advice"
```

### Task 4: Vault adapters

**Files:**
- Create: `src/vault-adapters.js`
- Test: `test/vault.test.js`

**Interfaces:**
- Produces: `ADAPTERS: { [id]: Adapter }` for `proton`, `1password`, `bitwarden`, `keepassxc`, `pass`, `gopass`, plus `TOOL_INFO` (labels, a `live: boolean` flag that is true only for `proton`, and an `unlockHint`).

```js
Adapter = {
  id, label, bin,
  targetHelp: string,                                   // shown in Settings
  statusCmd(target) -> { args },  parseStatus({ ok, stdout, stderr }) -> { ok, locked, hint },
  saveCmd(cand, target) -> { args, encode(buf: Buffer) -> Buffer|string, parseId(stdout) -> string|null } | { error },
  listCmd(target) -> { args } | null,  parseList(stdout) -> Set<itemId>,   // existence for Verify
  fingerprintCmd(itemId, target) -> { args } | null, parseFingerprint(stdout) -> string|null,
  existsFs?(itemId, target, env) -> boolean,             // pass only: <store>/<name>.gpg
}
```

The exact argv comes from spec §5 and §5a. The Proton commands below were confirmed live on 2026-11-09:

| Adapter | `saveCmd` args | `encode` |
| --- | --- | --- |
| proton, `kind: 'ssh'` | `['item','create','ssh-key','import','--from-private-key','/dev/stdin','--title',T,'--vault-name',V]` | raw buffer |
| proton, otherwise | `['item','create','note','--vault-name',V,'--from-template','-']` | `JSON.stringify({ title: T, note: text, extra_fields: [] })`, where `text` is the UTF-8 text, or `'base64:\n' + b64` when the buffer isn't valid UTF-8 or contains NUL |
| 1password | `['document','create','-','--title',T,'--file-name',basename,'--vault',V,'--tags','gutcheck','--format','json']` | raw buffer |
| bitwarden | `['create','item']` | base64 of `JSON.stringify({ type: 2, secureNote: { type: 0 }, name: T, notes: text, folderId })`. Returns `{ error }` when `text.length > 10000` |
| keepassxc | two-step; see the note below | raw buffer for `attachment-import … /dev/stdin` |
| pass | `['insert','-m','-f', 'gutcheck/' + slug]` | text, or base64 as for Proton |
| gopass | `['insert','-f','gutcheck/' + slug]` | same as pass |

`parseId`:
- **Proton:** `stdout.trim()` when it matches `/^[A-Za-z0-9_-]{20,}={0,2}$/`.
- **1Password and Bitwarden:** `JSON.parse(stdout).id || .uuid`.
- **pass, gopass and keepassxc:** the entry name.

KeePassXC is the one two-command save. `saveCmd` returns `{ steps: [ {args: add…}, {args: attachment-import…, stdin: true} ] }` and the controller runs them in order. Both use `--no-password -k <keyfile>`, where `target = { db, keyFile, group }`.

The `slug` is the title without `gutcheck: `, with `~` turned into `home` and every character outside `[\w./-]` turned into `_`.

- [ ] **Step 1: Write the failing tests** in `test/vault.test.js`:

```js
const { ADAPTERS } = require('../src/vault-adapters');
const SECRET = 'API_KEY=hunter2-unique-marker';
const c = { title: 'gutcheck: api/.env', rel: '.env', kind: 'file', size: SECRET.length };
for (const [id, a] of Object.entries(ADAPTERS)) {
  test(`${id}: content never in argv, always in encoded stdin`, () => {
    const s = a.saveCmd(c, id === 'keepassxc' ? { db: '/d.kdbx', keyFile: '/k', group: 'gutcheck' } : 'Dev');
    const all = s.steps || [s];
    for (const st of all) assert.ok(!JSON.stringify(st.args).includes('hunter2'));
    const enc = all.map((st) => (st.encode ? String(st.encode(Buffer.from(SECRET))) : '')).join('');
    assert.ok(enc.includes('hunter2') || Buffer.from(enc, 'base64').toString().includes('hunter2'));
  });
}
test('proton ssh keys import from /dev/stdin', () => {
  const s = ADAPTERS.proton.saveCmd({ ...c, kind: 'ssh', title: 'gutcheck: ~/.ssh/id_ed25519' }, 'Dev');
  assert.deepEqual(s.args.slice(0, 6), ['item', 'create', 'ssh-key', 'import', '--from-private-key', '/dev/stdin']);
});
test('proton parseId takes the bare id line', () => {
  const id = 'MfEmlPW3WSPOmNDYWKm_ncPcK3g6DImo_MnoV1sZIsmHaAZMyS2cq-rm8yG2eQdOYrka2ZfuifhrnMXX-R1vQg==';
  assert.equal(ADAPTERS.proton.saveCmd(c, 'Dev').parseId(id + '\n'), id);
  assert.equal(ADAPTERS.proton.saveCmd(c, 'Dev').parseId('Error: x'), null);
});
test('proton parseList and parseFingerprint use recorded output', () => {
  // parseList({"items":[{"id":"A","title":"t","item_type":"Note","state":"Active"}],"folders":[]}) has 'A'
  // parseFingerprint of the recorded ssh-agent debug JSON (spec §5a) -> 'SHA256:oMJ63...'; invalid_items-only -> null
});
test('bitwarden refuses notes over 10000 characters', () => {
  assert.match(ADAPTERS.bitwarden.saveCmd({ ...c, size: 10001 }, '').error, /10,000/);
});
test('bitwarden parseStatus maps locked/unauthenticated to hints', () => {
  assert.deepEqual(ADAPTERS.bitwarden.parseStatus({ ok: true, stdout: '{"status":"locked"}' }).locked, true);
  assert.match(ADAPTERS.bitwarden.parseStatus({ ok: true, stdout: '{"status":"locked"}' }).hint, /bw unlock/);
});
test('binary content is base64 for text-only tools', () => {
  const enc = JSON.parse(ADAPTERS.proton.saveCmd(c, 'Dev').encode(Buffer.from([0, 1, 2, 255])));
  assert.match(enc.note, /^base64:\n/);
});
```

- [ ] **Step 2: Run** `node --test test/vault.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/vault-adapters.js`.** It only builds argv and parses output. It contains no `require('./exec')`.
- [ ] **Step 4: Run** `node --test test/vault.test.js`. Expected: PASS.
- [ ] **Step 5: Commit:**

```bash
git add src/vault-adapters.js test/vault.test.js
git commit -m "Secrets: password manager adapters (argv and parsing only)"
```

### Task 5: Controller (`secrets-ctl.js`)

**Files:**
- Create: `src/secrets-ctl.js`
- Test: `test/vault.test.js` (append)

**Interfaces:**
- Consumes: Tasks 2 to 4; `createSettingsStore` (the `vault` key); `exec.run`.
- Produces: `createSecretsCtl({ dataDir, settings, run = exec.run, env = process.env, home = os.homedir(), audit = () => {} })`, which returns:
  - `tools() -> [{ id, label, found: boolean, live: boolean }]`, plus a fixed `{ id: 'google', label: 'Google Password Manager', found: false, reason: 'No CLI or write API' }`
  - `link({ tool, target }) -> { ok, error? }`, which validates the tool id and target shape
  - `test() -> Promise<{ ok, locked, hint }>`
  - `scan({ repos: [{path,name}], root }) -> Promise<{ ok, linked, tool, items: [Candidate & {status, sameAs}], advice }>`
  - `plan(paths: string[], { via }) -> Promise<{ ok, token, title, risk: 'caution', display: [{text}], note }>`. `via === 'mcp'` returns `{ ok:false, error: 'Backing up secrets runs only from the GutCheck app or CLI.' }`.
  - `apply(token, { via }) -> Promise<{ ok, results: [{ text, ok, out }] }>`, refused for MCP the same way
  - `verify({ via }) -> Promise<{ ok, checked, missing, mismatch }>`, refused for MCP
  - `skip(real, reason)` and `unskip(real) -> { ok }`
  - `PLAN_TTL = 5 * 60 * 1000`

**How `plan` works:**
- It runs a fresh `scan()` and keeps only the requested paths whose status isn't `backed` or `skipped`. It never trusts the caller's list beyond that.
- It refuses when no tool is linked, or when the bin isn't a real executable on `PATH` inside no scanned repo. Use `fs.realpathSync` on the PATH match, then check it isn't under any `repos[].path`.
- For each file it stores `{ cand, sha256, saveCmd }` and shows `display.text = "<bin> <args quoted>  ← contents of <title-without-prefix> (<size> bytes)"`.

**How `apply` handles each file:**
1. `lstat` must not be a symlink, the size must be 1 MB or less, and `fsp.readFile` must succeed.
2. The sha256 must equal the planned one, else the step reads `Changed since the preview. Rescan and review it again.`
3. `run(bin, args, { input: encode(buf), timeout: 60000, env })`.
4. `id = parseId(stdout)`. On failure (or no ID), `out = scrub(stderr, buf).slice(0, 300)` and the run stops.
5. `record.update()` writes the entry. If the adapter has `fingerprintCmd` and `kind === 'ssh'`, the entry's fingerprint is the candidate's.
6. Results never include stdout. `audit({ ok, repo: 'Secrets', title: 'Backed up <title> to <label>' })`.

`scrub(text, buf)` removes every line of `text` that contains any non-empty line of the file, or that contains a run of 8 or more characters from it.

`verify()` per tool:
- It lists IDs once with `listCmd` / `parseList`; pass uses `existsFs`.
- An entry whose ID is absent gets `missing: true`.
- For SSH entries with `fingerprintCmd`, a fingerprint that comes back and differs from the stored one gives `mismatch: true`. A `null` fingerprint (an encrypted key) is left alone.
- A locked status returns `{ ok: false, error: hint }` and changes nothing.

- [ ] **Step 1: Write the failing tests** (fake `run`, temp dataDir, temp repo with a `.env`, and a fake executable `pass-cli` script on a temp PATH):

```js
test('plan/apply: content only on stdin, record written, results clean', async () => {
  const calls = [];
  const run = async (cmd, args, o) => { calls.push({ cmd, args, input: String(o.input) }); return { ok: true, code: 0, stdout: 'ID_' + 'x'.repeat(30) + '\n', stderr: '' }; };
  const ctl = mkCtl({ run }); ctl.link({ tool: 'proton', target: 'Dev' });
  const p = await ctl.plan([envPath], { via: 'app' });
  assert.ok(p.ok && !JSON.stringify(p).includes('hunter2'));
  const r = await ctl.apply(p.token, { via: 'app' });
  assert.ok(r.ok && !JSON.stringify(r).includes('hunter2'));
  assert.ok(calls[0].input.includes('hunter2') && !calls[0].args.join(' ').includes('hunter2'));
  assert.equal((await ctl.scan(ws)).items.find((i) => i.real === envPath).status, 'backed');
  assert.equal(fs.statSync(path.join(dataDir, 'secret-backups.json')).mode & 0o777, 0o600);
  assert.equal((await ctl.apply(p.token, { via: 'app' })).ok, false); // single use
});
test('apply stops when the file changed after the preview, and records nothing', async () => { /* edit .env between plan and apply */ });
test('apply refuses a file that became a symlink', async () => { /* replace .env with a symlink */ });
test('a failing CLI that echoes the input shows scrubbed stderr', async () => {
  // run returns { ok:false, stderr: 'parse error near: API_KEY=hunter2-unique-marker\nhint: unlock' }
  // result out does not include 'hunter2' and does include 'hint: unlock'; no record entry
});
test('a hanging CLI is bounded: input given, timeout 60000', async () => { /* assert opts.timeout === 60000 && opts.input != null */ });
test('MCP is refused for plan, apply and verify', async () => {
  for (const r of [await ctl.plan([envPath], { via: 'mcp' }), await ctl.apply('x', { via: 'mcp' }), await ctl.verify({ via: 'mcp' })])
    assert.match(r.error, /only from the GutCheck app or CLI/);
});
test('a vault bin inside a scanned repo is refused', async () => { /* PATH points at <repo>/bin/pass-cli */ });
test('verify marks missing and mismatch; locked changes nothing', async () => { /* fake list and debug output */ });
test('skip/unskip', async () => { /* status skipped then unbacked */ });
```

- [ ] **Step 2: Run** `node --test test/vault.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `src/secrets-ctl.js`** (target under 300 lines).
- [ ] **Step 4: Run** `node --test test/vault.test.js test/secrets.test.js`. Expected: PASS.
- [ ] **Step 5: Commit:**

```bash
git add src/secrets-ctl.js test/vault.test.js
git commit -m "Secrets: link, plan, apply, verify and skip"
```

### Task 6: Wiring (service, engine, MCP, CLI, IPC, report)

**Files:**
- Modify: `src/service.js` (add `secretsScan(dirs)` next to `clutterScan`, and pass secrets advice into `buildReport` at `:215`)
- Modify: `src/report.js:228` (append `...((sec && sec.advice) || [])` for the repo, and the workspace/home advice to the workspace section)
- Modify: `src/engine.js` (add a `secrets()` read, and route the `s:` prefix in `apply`, as `:252` does for `a:`)
- Modify: `src/mcp.js` (one read-only tool, `gutcheck_secrets`)
- Modify: `src/cli.js` (the `secrets` command and HELP)
- Modify: `src/main.js`, `src/preload.js` (IPC)
- Test: `test/mcp.test.js`, `test/upkeep-cli.test.js` or a new `test/secrets-cli.test.js`, `test/report.test.js`, `test/main.test.js`

**Interfaces:**
- Consumes: `createSecretsCtl` (Task 5).
- Produces:
  - IPC channels: `secrets:scan`, `secrets:tools`, `secrets:link`, `secrets:test`, `secrets:plan`, `secrets:apply`, `secrets:verify`, `secrets:skip`.
    - `preload.js` exposes `window.api.secrets.{scan,tools,link,test,plan,apply,verify,skip}`.
    - Every write channel returns `{ ok:false, error:'Read-only mode is on.' }` when `loadSettings().readOnly`.
  - CLI:
    - `gutcheck secrets` prints the status table (title, status, kind, size), with `--json` support.
    - `gutcheck secrets --backup [--yes]` plans everything unbacked or changed, prints `display`, and applies only with `--yes`.
    - `gutcheck secrets --verify` runs Verify.
    - `gutcheck secrets --skip <path> <reason...>` skips a file.
  - MCP: `gutcheck_secrets` returns `{ linked, tool, items: [{ title, status, kind, confidence }], advice }`, with no absolute home paths beyond `~/…` titles. `engine.plan` returns the refusal for `{ secretBackup }` items when `opts.via === 'mcp'`, and `engine.apply` refuses `s:` tokens for MCP.

- [ ] **Step 1: Write the failing tests:**
  - MCP: `tools/list` includes `gutcheck_secrets` with `readOnlyHint: true`.
  - MCP: `gutcheck_plan` with `items: [{ secretBackup: ['/x'] }]` (allowActions true) has an error matching `/only from the GutCheck app or CLI/`.
  - CLI: `node src/cli.js secrets --json` with a temp HOME and root returns `items` without the file's content.
  - Report: `buildReport` includes a `secret-unbacked` step and never the file's content.
  - Main: `secrets:plan` returns the read-only error when `readOnly` is set (follow the existing `test/main.test.js` handler harness).
- [ ] **Step 2: Run** `node --test test/mcp.test.js test/report.test.js test/main.test.js test/secrets-cli.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the wiring.** Add the report step for `secret-unbacked`, `secret-changed`, `ws-secret-unbacked` and `ws-secret-changed` in `report-fixes.js` at `phase: 0`. Its `why` is `'This file exists only on this machine; losing the disk loses the secret.'` and its `cmds` are `['gutcheck secrets --backup']`, with the note `Ask the owner first: this copies secrets into their password manager.`
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Check line counts:** `wc -l src/engine.js src/cli.js src/main.js src/service.js src/report.js src/report-fixes.js`. Every file must be under 400.
- [ ] **Step 6: Commit:**

```bash
git add src test
git commit -m "Secrets: wire into service, engine, CLI, MCP (read-only) and IPC"
```

### Task 7: Secrets view and password manager panel

**Files:**
- Create: `src/renderer/secrets-view.js`
- Modify: `src/renderer/index.html` (a script tag after `tests-view.js`, plus a nav entry), `src/renderer/app.js` (route `view === 'secrets'`), `test/helpers/dom.js` (the same load order and a fake `window.api.secrets`)
- Test: `test/renderer.test.js` (append) or a new `test/secrets-ui.test.js`

**Interfaces:**
- Consumes: `window.api.secrets.*` (Task 6); the `h`, `toast`, `onDemand`, `adviceEl` globals that `clutter-view.js` and `tests-view.js` use.
- Produces: `renderSecrets()` global, called by `app.js`.

**Layout:**
- Header with counts by status.
- Buttons: "Back up all unbacked", "Verify with vault", "Password manager…".
- A per-file table: title, kind (the SSH key type and fingerprint when known), status, and actions "Back up" and "Don't back up…". "Don't back up…" asks for a reason.
- **Back up** shows the plan preview in the existing confirm modal (`modals.js`) before calling apply.
- **Advice:** advice with `fix.type === 'secret-backup'` (from the report or advice lists) opens this view with those paths picked. `fix.type === 'secret-link'` opens the password manager panel.
- **The password manager panel:**
  - a radio list from `tools()`; tools not found are disabled, Google shows its reason, and adapters with `live: false` are marked "untested with a live vault"
  - target fields: one text field, or for KeePassXC the DB path, key file and group
  - Save and Test connection buttons
  - copy: `GutCheck never asks for your master password. Unlock the password manager in its own app or terminal first.`

- [ ] **Step 1: Write the failing UI tests** (jsdom with fake `window.api.secrets.scan` returning 1 unbacked SSH item and 1 skipped):
  - The view shows `1 not backed up` and the fingerprint text.
  - Clicking "Back up" calls `secrets.plan` with `[real]`, then shows the preview with `← contents of`.
  - Confirming calls `secrets.apply(token)`.
  - The panel lists Google as disabled with "No CLI or write API".
  - With read-only on, "Back up" toasts the read-only message and makes no plan call.
- [ ] **Step 2: Run** `node --test test/secrets-ui.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `secrets-view.js` (under 250 lines) and the `index.html` / `app.js` / `dom.js` changes.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit:**

```bash
git add src/renderer test
git commit -m "Secrets: view and password manager settings"
```

### Task 8: Docs, accuracy cases and a live check

**Files:**
- Modify: `docs/sources.md` (a row per rule: secret names, home credential list, SSH classification and fingerprint, each password manager's commands with the doc links from spec §5, and the record-hash trade-off)
- Modify: `CHANGELOG.md` (`## [Unreleased]`: "Added: Secrets view…")
- Modify: `README.md` (a "Back up local secrets" section with linking, what's scanned, restore notes: Proton `item view --output json` `SshKey.private_key`, `op document get`, `bw get notes`, `pass show`, `keepassxc-cli attachment-export`)
- Test: `test/accuracy.test.js` (one case per false alarm found during Tasks 1 to 7; if there are none, add `.env.example` and a `*.pub` key as regression cases)

- [ ] **Step 1: Add the accuracy cases.** Run `node --test test/accuracy.test.js`. Expected: PASS.
- [ ] **Step 2: Write the docs.** Run `npm test` (the tests check that the CHANGELOG and package versions agree). Expected: all PASS.
- [ ] **Step 3: Live check (needs the user's OK first; ask before running).**
  1. Link `proton` to a throwaway vault created with `pass-cli vault create --name gutcheck-live-check-<date>`.
  2. With a temp HOME holding a fresh throwaway ed25519 key and a temp repo holding a throwaway `.env`, run `node src/cli.js secrets --root <tmp> --backup --yes`, then `node src/cli.js secrets --root <tmp> --verify`. Expected: both items `backed`, Verify reports 0 missing and 0 mismatch.
  3. Delete the vault by share ID after checking its name, as was done on 2026-11-09, and delete the temp files.
- [ ] **Step 4: Commit:**

```bash
git add docs CHANGELOG.md README.md test/accuracy.test.js
git commit -m "Secrets: docs, sources and accuracy cases"
```
