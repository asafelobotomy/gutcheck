# Remote Repos Scan (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan GitHub repos you own (and chosen orgs) that are not cloned in the workspace, with the same checks, scores and reports as local repos, read-only.

**Architecture:** A listing step (`remote-list.js`) finds uncloned repos, a cache step (`remote-cache.js`) keeps a hook-free `--depth 1` clone of each under the data folder, and `remote-scan.js` runs the existing `collectLocal` + `finish` on that clone with working-copy state blanked. `workspace-scan.js` runs this as a second stage and stores results in `known` under `remote:owner/name`. Every consumer that treats `r.path` as a folder goes through `repoDir(r)` or skips remote repos; plans refuse them.

**Tech Stack:** Node 22, `node:test`, jsdom (renderer tests), `git`, `gh` CLI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-remote-repos-scan-design.md`

## Global Constraints

- Remote scanning is off unless `settings.remote.enabled === true`; defaults `{ enabled: false, orgs: [], forks: false, archived: false, skip: [], maxSizeMB: 500, cacheMaxGB: 5 }`.
- Remote result keys and paths: `remote:<owner>/<name>`; `name` is `<owner>/<name>`; `source: 'remote'`; `cacheDir` (string or `null`); `partial` (boolean).
- Cache: `dataDir()/remote-cache/<owner>__<name>/` and metadata `dataDir()/remote-cache/<owner>__<name>.json` = `{ branch, pushedAt, clonedAt, lastScannedAt }`.
- Clone URL is always built as `https://github.com/<owner>/<name>.git`; owner, name and org logins must match `/^[A-Za-z0-9._-]+$/`.
- Clone/fetch `-c` set, verbatim: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `protocol.ext.allow=never`, `protocol.fd.allow=never`, `protocol.file.allow=never`, `filter.lfs.smudge=`, `filter.lfs.process=`, `filter.lfs.required=false`; env `GIT_LFS_SKIP_SMUDGE=1`, `GIT_TERMINAL_PROMPT=0` plus `SAFE_GIT_ENV`.
- Clone args: `clone --depth 1 --single-branch --no-tags --branch <b> --no-recurse-submodules -- <url> <dir>`. Clones 2 at a time, 5-minute timeout each.
- New finding ids: `uncloned-unavailable` (workspace advice), `uncloned-clone-failed`, `uncloned-too-large` (repo findings, info). Never `remote-*`.
- Guard message, verbatim: `Fixes for uncloned repos come in a later version; clone the repo to fix it now.`
- Error text from git: first line of stderr with any `user:pass@` / `user@` userinfo removed. No tokens in findings, reports, logs.
- Files under 400 lines (`engine.js` is 354, `app.js` 390: add code to new files, not these). `npm test` offline. Changelog under `## [Unreleased]`.

## Review Focus

- A remote result's `path` reaching code that opens it as a folder (`open:folder`, `agents:rules`, `agents:usage`, clutter/quality/tests/secrets scans, `workspaceAdvice`, rescue): must use `cacheDir` or skip, never `fs` on `remote:…`. Tested in Task 6.
- `gh` signed out / offline mid-scan: local results intact, one `uncloned-unavailable` advice, zero remote results. Tested in Task 5.
- A repo cloned into the workspace between two scans: it disappears from remote results and its cache folder is deleted. Tested in Task 5.
- A committed `.gitattributes` filter or LFS pointer in a remote repo: nothing runs during clone or fetch. Tested in Task 3.
- A repo name containing `__` (legal on GitHub; owners can only use letters, digits and `-`): the cache folder name must map back to one `owner/name`, so split on the first `__`. Tested in Task 1.

---

### Task 1: Settings and paths

**Files:**
- Create: `src/remote-settings.js`
- Modify: `src/paths.js`
- Test: `test/remote-settings.test.js`

**Interfaces:**
- Produces: `normalizeRemoteSettings(raw) -> { enabled, orgs, forks, archived, skip, maxSizeMB, cacheMaxGB }`; `NAME_RE`; `validRef({owner,name}) -> boolean`; `paths.remoteCacheRoot(env?) -> string`; `paths.remoteDir(owner, name, env?) -> string` (throws on invalid names); `paths.remoteKeyFromDir(basename) -> {owner,name} | null`.

- [ ] **Step 1: Write the failing tests**
  - `normalizeRemoteSettings(undefined)` deep-equals the Global Constraints defaults.
  - Junk is dropped: `orgs: ['ok-org', '--evil', 'a b', 7]` → `['ok-org']`; `skip: ['o/n', 'bad', 'o/n/x']` → `['o/n']`; `maxSizeMB: -1` → `500`; `cacheMaxGB: 'x'` → `5`; `enabled: 'yes'` → `false`.
  - `remoteDir('octo', 'a__b', env)` ends with `remote-cache/octo__a__b`; `remoteKeyFromDir('octo__a__b')` → `{ owner: 'octo', name: 'a__b' }`; `remoteKeyFromDir('nounderscore')` → `null`.
  - `remoteDir('..', 'x')` and `remoteDir('o', '../x')` throw.
- [ ] **Step 2: Run** `node --test test/remote-settings.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/remote-settings.js` and the three `paths.js` functions. Owners and org logins must match `/^[A-Za-z0-9-]+$/` (GitHub's own rule), names `/^[A-Za-z0-9._-]+$/`, so `__` splits unambiguously.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `Remote repos: settings and cache paths`.

### Task 2: Listing uncloned repos

**Files:**
- Create: `src/remote-list.js`
- Test: `test/remote-list.test.js`

**Interfaces:**
- Consumes: `normalizeRemoteSettings`, `validRef` (Task 1).
- Produces:
  - `listRemote({ run, orgs }) -> Promise<{ ok: true, repos: Listing[] } | { ok: false, error: string }>` where `Listing = { owner, name, isFork, isArchived, diskKB, defaultBranch, pushedAt }`.
  - `selectUncloned(listing, localRefs, settings) -> { include: Listing[], excluded: { owner, name, why }[] }`; `why` ∈ `'cloned' | 'fork' | 'archived' | 'skipped' | 'empty'` (no default branch).

- [ ] **Step 1: Write the failing tests** (stub `run` returns canned `gh api graphql --paginate` JSON; assert args never contain string-built owner text, only `-f`/`-F` variables):
  - two pages of viewer repos are merged; `org1` repos fetched with `login` passed as a variable.
  - names failing `validRef` are dropped.
  - `gh` exiting non-zero with "auth login" in stderr → `{ ok: false, error }` with that first line.
  - `selectUncloned` matches local `Octo/App` against listing `octo/app` (case-insensitive) as `cloned`; fork/archived excluded unless enabled; `skip` honoured; repo with `defaultBranch: null` → `empty`.
  - Same repo listed under viewer and org appears once.
- [ ] **Step 2: Run** `node --test test/remote-list.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** Query `viewer { repositories(first:100, after:$endCursor, ownerAffiliations: OWNER) { nodes { owner{login} name isFork isArchived diskUsage pushedAt defaultBranchRef{name} } pageInfo{hasNextPage endCursor} } }` and `organization(login:$login) { repositories(...) }` via `gh api graphql --paginate`. Note the call with github.js's rate tracking by exporting a small `noteCall` there if not already exported.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Remote repos: list uncloned repos`.

### Task 3: Cache clone

**Files:**
- Create: `src/remote-cache.js`
- Test: `test/remote-cache.test.js`

**Interfaces:**
- Consumes: `paths.remoteCacheRoot`, `paths.remoteDir`, `paths.remoteKeyFromDir` (Task 1); `exec.run`, `exec.SAFE_GIT_ENV`.
- Produces:
  - `createRemoteCache({ root, run = exec.run, urlFor = defaultUrlFor, now = Date.now })` returning:
    - `sync(listing) -> Promise<{ ok: true, dir, fetched: boolean } | { ok: false, error }>`
    - `sizeBytes() -> number`
    - `evictFor(needBytes, maxBytes, keep: Set<string>) -> string[]` (deleted keys `owner/name`, oldest `lastScannedAt` first, never one in `keep`)
    - `cleanup(keep: Set<string>) -> string[]`
    - `clear() -> void`
  - `defaultUrlFor({owner,name}) -> 'https://github.com/<owner>/<name>.git'` (not overridable in production code paths: only the factory parameter).

- [ ] **Step 1: Write the failing tests** using a local bare repo as origin (`urlFor` returns its path; the test's `run` wrapper adds `-c protocol.file.allow=always` after GutCheck's args so only the test can use the file transport):
  - recorded clone args equal the Global Constraints list in order; env has `GIT_LFS_SKIP_SMUDGE=1`, `GIT_TERMINAL_PROMPT=0`.
  - first `sync` clones (`fetched: true`) and writes the metadata JSON; second `sync` with the same `pushedAt` runs no git network command (`fetched: false`); newer `pushedAt` fetches and the work tree has the new commit.
  - default branch renamed → folder deleted and re-cloned.
  - extra key in the clone's `.git/config` (`core.sshCommand=touch pwned`) → re-cloned, and `pwned` never exists.
  - origin repo containing `.gitattributes` `*.bin filter=lfs` and an LFS pointer file, with the test's isolated global config (`GIT_CONFIG_GLOBAL`) setting `filter.lfs.smudge=touch marker` and `filter.lfs.required=true`: after clone and after a refresh, `marker` does not exist and the pointer file still holds the pointer text.
  - `evictFor` deletes oldest first and stops once it fits; `cleanup` deletes only `<owner>__<name>` dirs and `.json` files not in `keep`, and leaves an unrelated `notes.txt` in `remote-cache/`.
  - clone failure stderr `fatal: could not read from https://user:tok@github.com/o/n` → `error` without `user:tok@`.
- [ ] **Step 2: Run** `node --test test/remote-cache.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** Refresh = `fetch --depth 1 --no-tags origin <branch>` then `reset --hard FETCH_HEAD`, same `-c` set, in the clone. Config check before fetch: `git config --local --list --name-only`; allowed keys are `core.repositoryformatversion`, `core.filemode`, `core.bare`, `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`, `core.symlinks`, `remote.origin.url` (must equal `urlFor(ref)`), `remote.origin.fetch`, `branch.<b>.remote`, `branch.<b>.merge`, `extensions.*`, `shallow.*`. Size via a recursive `lstat` sum (no symlink following).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Remote repos: hook-free shallow cache clone`.

### Task 4: Scanning one remote repo

**Files:**
- Create: `src/remote-scan.js`
- Modify: `src/scanner.js` (export `finish`; let `collectLocal` accept `opts.origin = { ref, originUrl }` to use instead of reading `origin`)
- Test: `test/remote-scan.test.js`

**Interfaces:**
- Consumes: `collectLocal`, `finish` (scanner), `github.fetchRepos`.
- Produces:
  - `WORKING_COPY_IDS` — array: `git-ahead git-behind git-detached git-dirty git-garbage git-gone git-identity git-maintenance git-merged git-no-upstream git-op git-stale git-stashes git-upstream-gone git-worktrees deps-not-installed repo-size no-remote remote-credentials remote-http` plus every `local-only*` id.
  - `blankWorkingCopy(local) -> local` (pure; empties dirty/untracked/stashes/ahead/behind/branches/worktrees, `gitState` to its "nothing" shape, `localOnly` to `{ any: false }`, hygiene storage and `currentGone`, and marks deps as installed-not-applicable so `deps-not-installed` cannot fire).
  - `scanRemote(listing, { cacheDir, ghRes, policy, deep, reason }) -> Promise<Result>`; `cacheDir: null` means GitHub checks only and `reason` ∈ `'too-large' | 'clone-failed: <msg>'` adds `uncloned-too-large` / `uncloned-clone-failed`.
  - `repoDir(r) -> string | null` — `r.cacheDir` for remote results, `r.path` otherwise.

- [ ] **Step 1: Write the failing tests** (a temp git repo stands in for the cache clone, with uncommitted changes, a stash, an extra branch, no `node_modules` but a `package.json`, and a workflow file; `ghRes` stubbed `{ ok: true, snap }`):
  - result has `source: 'remote'`, `path: 'remote:o/n'`, `name: 'o/n'`, `partial: false`, and no finding id in `WORKING_COPY_IDS`.
  - file checks still fire (e.g. `no-license` for a repo without LICENSE, `wf-unpinned` from the workflow).
  - `cacheDir: null, reason: 'too-large'` → `partial: true`, one `uncloned-too-large` info finding, GitHub findings present, no file findings.
  - `repoDir` returns `cacheDir` for remote, `path` for local.
- [ ] **Step 2: Run** `node --test test/remote-scan.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** `scanRemote` calls `collectLocal(cacheDir, { deep, origin: { ref, originUrl: defaultUrlFor(ref) } })`, `blankWorkingCopy`, then `finish(local, ghRes, { policy, force: false })`, then sets the remote fields. Partial: build an empty local object (no files) the same way.
- [ ] **Step 4: Run** the test and `npm test` — Expected: PASS, existing scanner tests unchanged.
- [ ] **Step 5: Commit** `Remote repos: scan a cache clone with working-copy checks skipped`.

### Task 5: Workspace scan stage

**Files:**
- Modify: `src/workspace-scan.js`, `src/engine.js` (wiring only, ≤10 lines), `src/main.js` (wiring only)
- Create: `src/remote-stage.js` (keeps workspace-scan.js small)
- Test: `test/remote-stage.test.js`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces:
  - `runRemoteStage({ localResults, settings, cache, list = listRemote, fetch = github.fetchRepos, policy, deep, onRepo, pool }) -> Promise<{ results: Result[], status: RemoteStatus }>` with `RemoteStatus = { ran: boolean, error: string | null, included: number, excluded: {owner,name,why}[], cloned: number, cacheBytes: number }`.
  - `createWorkspaceScanner({ ..., remote?: { settings: () => object, cache } })` — new optional dep; scanner gains `remoteStatus() -> RemoteStatus | null`; `scan({ ..., remote?: boolean })` overrides `settings.enabled` for one run; `refresh('remote:o/n')` rescans that remote repo (re-sync + re-scan).
  - Workspace advice item when `status.error`: `{ id: 'uncloned-unavailable', severity: 'info', title: 'Remote repos not checked', detail: status.error }`, added in `service.wsAdvice`.

- [ ] **Step 1: Write the failing tests** (stub `list`, `fetch`, and a cache whose `sync` returns a prepared temp repo):
  - disabled → `list` never called, `status.ran === false`.
  - `list` fails → local results intact, zero remote results, `status.error` set; engine `workspace()` advice includes `uncloned-unavailable`.
  - repo with `diskKB` over `maxSizeMB*1024` → `sync` not called, result partial with `uncloned-too-large`.
  - `sync` failure → partial with `uncloned-clone-failed`.
  - remote results land in `known` under `remote:o/n`; `onRepo` called with progress counts continuing after the local ones.
  - second scan after `o/n` gets a local clone with that origin → no `remote:o/n` in `known`, `cache.cleanup` called without `o/n` in keep.
  - `evictFor` called before a clone that would exceed `cacheMaxGB`.
- [ ] **Step 2: Run** `node --test test/remote-stage.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** One batched `fetchRepos` for all included refs; clones through `pool(items, 2, …)`; record `lastScannedAt` in metadata. Engine and `main.js` pass `remote: { settings: () => store.load().remote, cache: createRemoteCache({ root: paths.remoteCacheRoot(env) }) }`.
- [ ] **Step 4: Run** the test and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `Remote repos: second scan stage in the workspace scan`.

### Task 6: Guards and folder-safe consumers

**Files:**
- Modify: `src/service.js`, `src/renderer/fix-all.js`, `src/report.js`, `src/main.js`, `src/engine.js` (filters only)
- Test: `test/remote-guard.test.js`

**Interfaces:**
- Consumes: `repoDir`, `source: 'remote'`.
- Produces: no new exports; behaviour only.

- [ ] **Step 1: Write the failing tests** with a `known` map holding one local and one remote result:
  - `service.planActions([{ dir: 'remote:o/n', action: { type: 'repo-edit' } }])` → `{ ok: false, error: <guard message> }`; same through CLI `fix o/n …` and MCP `gutcheck_plan`.
  - `FixAll.plan(remoteResult)` → `{ actions: [], decisions: [], blocked: <guard message> }`.
  - `buildReport` for a remote repo contains the guard message and no `cd ` line, and its findings section is still present.
  - `clutterScan()` / `qualityScan()` scan `cacheDir` for remote repos and skip partial ones; `testsScan()`, `localOnly()`, `secrets`, and `wsRepos()` (workspace advice, `ws-git-identity`) exclude remote repos.
  - IPC handlers `open:folder`, `agents:rules`, `agents:usage` ignore remote keys (call handler functions extracted for testing, or assert through `service`/`engine` equivalents).
- [ ] **Step 2: Run** `node --test test/remote-guard.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the guard in `planActions` before `actions.plan`; `blocked` field in `fix-all.js`; report note in `repoSection` when `r.source === 'remote'`; filters as listed.
- [ ] **Step 4: Run** the test and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `Remote repos: refuse fixes and keep remote paths out of folder code`.

### Task 7: CLI and MCP

**Files:**
- Modify: `src/cli.js`, `src/mcp.js`, `src/engine.js` (one `remote()` method, or put it in `src/remote-stage.js` and delegate)
- Test: `test/remote-cli.test.js`

**Interfaces:**
- Consumes: `scan({ remote })`, `remoteStatus()`, `cache.clear()`, `cache.sizeBytes()`.
- Produces: `engine.remote({ clearCache?: boolean }) -> { ok, status: RemoteStatus | null, cacheBytes, cleared?: true }`; summary rows gain `source`.

- [ ] **Step 1: Write the failing tests** (engine with injected stub stage):
  - `gutcheck scan --remote` prints `[remote]` after remote repo names; `--no-remote` with `enabled: true` lists none.
  - `gutcheck remote` prints included count, each excluded repo with its `why`, and cache size; `gutcheck remote --clear-cache` empties `remote-cache/` and prints the freed size.
  - `gutcheck repo o/n` resolves the remote repo.
  - MCP `gutcheck_overview` rows carry `source: "remote"`; `gutcheck_tests` and `gutcheck_local_only` exclude them.
  - `--help` lists `remote`, `--remote`, `--no-remote`.
- [ ] **Step 2: Run** `node --test test/remote-cli.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `cli.js` under 400 lines (281 now).
- [ ] **Step 4: Run** the test and `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `Remote repos: CLI and MCP`.

### Task 8: App UI

**Files:**
- Create: `src/renderer/remote-view.js` (settings section, filter, chip helpers), loaded in `index.html` and `test/helpers/dom.js` after `dashboard.js`
- Modify: `src/renderer/dashboard.js`, `src/renderer/app.js` (≤10 lines: call helpers), `src/main.js`, `src/preload.js`, `src/renderer/style.css`
- Test: `test/remote-ui.test.js`

**Interfaces:**
- Consumes: `source`, `partial`, `RemoteStatus`.
- Produces: IPC `remote:get -> { settings, status, cacheBytes }`, `remote:set(patch) -> settings` (through `normalizeRemoteSettings`), `remote:orgs -> string[]` (`gh api user/orgs --jq '.[].login'`, validated), `remote:clear -> { freedBytes }`; preload `api.remote*` wrappers.

- [ ] **Step 1: Write the failing jsdom tests:**
  - list row for a remote repo shows a "Remote" chip; partial adds "GitHub checks only".
  - All / Local / Remote filter changes the visible rows.
  - repo detail for a remote repo shows "Not cloned in this workspace", has no "Open folder" or "Fetch & prune" button, has "Open on GitHub ↗", and no git state, local-only, secrets or tests panels.
  - Settings "Remote repos" section saves `{ enabled, orgs, forks, archived, skip, maxSizeMB, cacheMaxGB }` via `remote:set`; "Clear remote cache" shows the size and calls `remote:clear`.
  - scan progress label reads `Checking 3 remote repos (cloning 1)` from a `scan:repo` event carrying `stage: 'remote'`.
- [ ] **Step 2: Run** `node --test test/remote-ui.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** `main.js` `remote:set` must not accept any key outside the remote settings.
- [ ] **Step 4: Run** the test and `npm test` — Expected: PASS. Then `npm start` against a workspace with remote enabled and check the list and settings by eye.
- [ ] **Step 5: Commit** `Remote repos: app list, detail and settings`.

### Task 9: Docs and release notes

**Files:**
- Modify: `docs/sources.md`, `CHANGELOG.md`, `README.md`, `AGENTS.md`

- [ ] **Step 1:** `docs/sources.md` row "Remote repos (uncloned)": `diskUsage` (GitHub GraphQL `Repository.diskUsage`, KB), `git clone --depth/--single-branch/--no-tags/--no-recurse-submodules`, `GIT_LFS_SKIP_SMUDGE`, `protocol.<name>.allow`, the `uncloned-*` ids and their severities, and one line per skipped working-copy id family with the reason.
- [ ] **Step 2:** `CHANGELOG.md` `## [Unreleased]` entry; README "Remote repos" section (turning it on, what's checked, cache location and size, no fixes yet); `AGENTS.md` layout line for `remote-settings.js`, `remote-list.js`, `remote-cache.js`, `remote-scan.js`, `remote-stage.js`, `renderer/remote-view.js`.
- [ ] **Step 3: Run** `npm test` — Expected: PASS (version/changelog agreement tests included). Run `node src/cli.js scan --remote .` style self-check: GutCheck scanning itself reports no file over 400 lines.
- [ ] **Step 4: Commit** `Remote repos: docs, sources and changelog`.
