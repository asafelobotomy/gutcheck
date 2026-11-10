# Local-only work report and rescue copy: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Report, per repo and across the workspace, the work that exists only on this machine.
- Add a `rescue-bundle` action that saves it outside the repo, in files verified to restore it.

**Architecture:**
- A read-only collector (`src/local-only.js`) runs during the normal scan and stores `localOnly` on the snapshot.
- One new check, a workspace advice line, a CLI command and an MCP tool read it.
- The rescue is an ordinary planned action (`src/actions-rescue.js`). It uses two additions to `apply.js`: `safeGit` on run steps, and a `copy` step kind.

**Tech stack:** Node 22, plain CommonJS, `node --test`, temp git repos (no network).

**Spec:** `docs/superpowers/specs/2026-11-10-local-only-work-design.md` (read it first; this plan does not repeat its reasoning).

## Global constraints

- Every git call in scans goes through `exec.git`. Plans and apply steps use `ctx.safeGit`, or a step with `safeGit: true`. Never call plain `git` with repo-controlled config.
- Never put file contents, secret values or `.env` contents into findings, MANIFEST.txt, results or logs. Names and sizes only.
- Every file stays under 400 lines. Run `wc -l` on every touched file before committing.
- `npm test` must pass offline. Tests use temp repos under `os.tmpdir()`, and a local bare repo where a remote is needed.
- Each changelog line goes under `## [Unreleased]` in `CHANGELOG.md`.
- Each new rule's source goes in `docs/sources.md`.
- Each false-alarm guard gets a test in `test/accuracy.test.js` (356 lines today; if it would pass 400, put the test in `test/accuracy-runtime.test.js`).
- **Branch limit:** 50 branches are counted, and more set `truncated: true`.
- **Rescue limits:** files over 100 MB are skipped; the rescue folder has mode 0700.
- **Default rescue folder:** `~/GutCheck-rescue/<YYYY-MM-DD>/<repo>/`. The `rescueDir` setting overrides the base.
- Subagents: run builds and tests in the foreground, and leave nothing running in the background when you report.
- Subagents: don't wait on CI. Report what you pushed; the session that started you checks CI.

## Review focus

Inputs the spec implies but no happy-path test covers. Each has a test in the task named.

1. **Branch names that are hostile or unusual** (`--help`, spaces, unicode, a control character). The scan counts them correctly and shows them safely, and no name is read as an option. *Task 1, Task 2.*
2. **Untracked file names with newlines or leading dashes.** The rescue copies them exactly, which needs `-z` parsing and `--` before paths. *Task 5.*
3. **A very large repo.** The bundle step gets a 30-minute timeout, not the default command timeout. The preview shows the size estimate before anything runs. *Task 5.*
4. **A step failing partway** (disk full, a git error). Apply stops, keeps what it wrote, and the result names the folder. Nothing is deleted. *Task 4, Task 5.*
5. **Submodules and linked worktrees.** Their own local work is not in the bundle. MANIFEST.txt says so instead of implying a complete copy. *Task 5.*

---

### Task 1: The local-only collector

**Files:**
- Create: `src/local-only.js`
- Modify: `src/scanner.js` (`collectGit` counts untracked lines; `collectLocal` and the snapshot gain `localOnly`)
- Test: `test/local-only.test.js`

**Interfaces:**
- **Produces:**
  - `collectLocalOnly(dir, facts) -> Promise<LocalOnly>`, where `facts = { branch, noRemote, upstreamGone, stashes, uncommitted, untracked, detachedOnly }`.
  - `LocalOnly = { branches: [{ name, ahead }], truncated, neverPushed, stashes, uncommitted, untracked, noRemote, upstreamGone, detachedOnly, any }`.
  - `summarizeLocalOnly(lo) -> string`, a short line such as `"2 branches, 1 stash, 3 uncommitted, 1 untracked"`, or `''` when `!lo.any`.
  - `snapshot.localOnly` and `snapshot.git.untracked` (number).
- **Consumes:**
  - `g.dirty`: stays the count of all non-header status lines, so `git-dirty` is unchanged.
  - The new `g.untracked`: the lines starting with `? `. So `uncommitted = g.dirty - g.untracked`.
  - `hygiene.stashes`, `hygiene.currentGone`, `!originUrl`.
  - `gitState` detached-only count: read the field name from `src/git-state.js`; it is the `rev-list --count HEAD --not --branches --tags --remotes` result.

- [ ] **Step 1: Write the failing tests** in `test/local-only.test.js`. Build each repo with `git init -q -b main`, commits with `-c user.name=t -c user.email=t@t`, and a bare remote via `git init --bare` plus `git push -u`.
  - `counts a branch with commits on no remote next to a pushed one`: `branches` deep-equals `[{ name: 'feature', ahead: 2 }]`, and `any === true`.
  - `no remote-tracking refs: every branch counts and neverPushed is true`.
  - `more than 50 branches sets truncated and counts 50`: create 55 branches.
  - `a branch named --help is counted, not read as an option`: `branches[0].name === '--help'`.
  - `a clean pushed repo reports any === false and summarize returns ''`.
  - `summarizeLocalOnly` with stashes 1, uncommitted 3, untracked 1 and one branch gives `'1 branch, 1 stash, 3 uncommitted, 1 untracked'`.
  - Scanner-level, via `require('../src/scanner')`'s exported collector or a full local scan, whichever the existing tests in `test/hygiene.test.js` use: a repo with one modified tracked file and one new file gives `git.untracked === 1` and `localOnly.uncommitted === 1`.

- [ ] **Step 2: Run them and check they fail.** Run `node --test test/local-only.test.js`. Expected: FAIL with `Cannot find module '../src/local-only'`.

- [ ] **Step 3: Implement `src/local-only.js`.**
  - List branches with `git for-each-ref --format=%(refname) refs/heads`, taking the full ref, and strip `refs/heads/` for display.
  - Count with `git rev-list --count <full ref> --not --remotes`, one call per branch, in parallel, capped at 50.
  - Find `neverPushed` with `git for-each-ref --count=1 refs/remotes`: true when that prints nothing.
  - Keep only branches with `ahead > 0`.
  - `any` is true when the branches list is non-empty or any count or flag is set.
  - Then wire it into `scanner.js`:
    - `collectGit` adds `g.untracked`.
    - `collectLocal` calls `collectLocalOnly` after `collectGitState` and returns `localOnly`.
    - The snapshot (scanner.js:268) copies `localOnly: local.localOnly`.

- [ ] **Step 4: Run the tests and check they pass.** Run `node --test test/local-only.test.js && npm test`. Expected: every test passes.

- [ ] **Step 5: Commit.** `git add src/local-only.js src/scanner.js test/local-only.test.js && git commit -m "Local-only work: collect branches, stashes and changes that exist only here"`

### Task 2: The `git-unpushed-branches` check and its report step

**Files:**
- Modify: `src/checks-hygiene.js` (or whichever file has room; it is added to `checks.js` evaluate if it is new)
- Modify: `src/report-fixes.js`
- Test: `test/local-only.test.js` and `test/accuracy.test.js`

**Interfaces:**
- **Consumes:** `snapshot.localOnly` and `snapshot.git.branch` from Task 1.
- **Produces:** the finding `{ id: 'git-unpushed-branches', category: 'Branches', severity: 'warn', title, detail, fix: { type: 'rescue-bundle', label: 'Save a rescue copy' } }`.

- [ ] **Step 1: Write the failing tests.**
  - `git-unpushed-branches lists other branches with counts`: a snapshot with `localOnly.branches` set to `[{name:'main',ahead:1},{name:'feature',ahead:2}]`, `git.branch:'main'` and an `originUrl`.
    - The title is `'1 other branch has commits on no remote'`.
    - The detail contains `feature (2)`.
  - `no finding without a remote (no-remote already warns)`.
  - `no finding when only the current branch is ahead (git-ahead covers it)`.
  - `a branch name with a control character is shown escaped`: the detail must not contain `\u001b`. Use the existing `printable` helper.
  - **Accuracy** (`test/accuracy.test.js`), real temp repos run through the full checks, as the existing accuracy tests do:
    - `pushed single-branch repo: no git-unpushed-branches`.
    - `fresh git init with no commits: no git-unpushed-branches`.
  - **Report:** the report text for the finding contains `git push -u origin 'feature'`, quoted with `sq`.

- [ ] **Step 2: Run them and check they fail.** Run `node --test test/local-only.test.js test/accuracy.test.js`. Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement the check.**
  - It filters out `git.branch` and lists up to 8 names as `name (n)`.
  - It is shown only when `originUrl` is set.
  - Add a report entry in `report-fixes.js`:
    - phase 1, rank 5
    - `why: 'These commits exist only on this machine.'`
    - one `git push -u origin <sq(name)>` command per branch, at most 20
    - `note: 'Ask the owner before pushing a branch they may have meant to delete; Save a rescue copy keeps everything without pushing.'`
    - `ref: REFS.branch`
  - Add `'git-unpushed-branches'` to the unpushed-work group in `ignore-rules.js:19`, next to `git-ahead`.

- [ ] **Step 4: Run the tests and check they pass.** Run `npm test`. Expected: every test passes.

- [ ] **Step 5: Commit.** `git add -A src test && git commit -m "Check: commits on other branches that exist on no remote"`

### Task 3: The workspace, CLI and MCP views

**Files:**
- Modify: `src/workspace.js` (`devAdvice` adds `localOnlyAdvice(repos)`)
- Modify: `src/engine.js` (new `localOnly()`)
- Modify: `src/cli.js` (`case 'local-only'` and help text)
- Modify: `src/mcp.js` (tool `gutcheck_local_only`)
- Test: `test/local-only.test.js`, `test/mcp.test.js`, `test/upkeep-cli.test.js`. Follow whichever existing test drives `cli.js` with a stub engine.

**Interfaces:**
- **Consumes:** `snapshot.localOnly` and `summarizeLocalOnly` from Task 1.
- **Produces:**
  - `localOnlyAdvice(repos) -> Advice[]`, with id `ws-local-only`, severity `info`. The title is `` `${n} repos hold work that exists only on this machine` `` (`1 repo holds…` when n is 1). The detail has one line per repo: `` `${name}: ${summarizeLocalOnly(lo)}` ``.
  - `engine.localOnly() -> { ok, repos: [{ repo, ...LocalOnly }] }`, listing only repos with `any`.
  - CLI `gutcheck local-only [--json]`.
  - MCP `gutcheck_local_only`, with annotations `RO` and an empty input schema.

- [ ] **Step 1: Write the failing tests.**
  - `ws-local-only names each repo with its summary and is absent when no repo has local work`.
  - **MCP:** the tool list includes `gutcheck_local_only` with `readOnlyHint: true`. Calling it with a stub engine returns the stub's repos.
  - **CLI:** `local-only --json` prints JSON with a `repos` array, and the plain form prints `noti-fi: 2 branches, 1 stash`. Exit code 0.

- [ ] **Step 2: Run them and check they fail.** Run `node --test test/local-only.test.js test/mcp.test.js`. Expected: FAIL on the new tests.

- [ ] **Step 3: Implement.**
  - `engine.localOnly` reads the cached scan through `ensure()`, as `findings` does, and is added to the returned object.
  - Add `local-only` to the CLI help list, next to `workspace`.

- [ ] **Step 4: Run the tests and check they pass.** Run `npm test`. Expected: every test passes. Also run `wc -l src/engine.js src/cli.js src/mcp.js`: each must be under 400.

- [ ] **Step 5: Commit.** `git commit -am "Local-only work: workspace advice, gutcheck local-only, gutcheck_local_only"`, after `git add`-ing any new test file.

### Task 4: `apply.js`: safeGit run steps, the `copy` kind, and mkdir for rescue folders

**Files:**
- Modify: `src/apply.js`
- Test: `test/rescue.test.js` (new; the apply-level tests come first)

**Interfaces:**
- **Produces:**
  - **Run steps with `{ safeGit: true }`:** the generic branch runs `ctx.safeGit(s.args, s.cwd)` and ignores `s.cmd`.
    - A `timeout` given on the step must reach the call. Today `ctx.safeGit(args, cwd)` takes no options, so extend both implementations at apply.js:15 to `(args, cwd, opts = {})` and pass `opts.timeout` through.
  - **Copy steps:** `{ kind: 'copy', root, dest, files: [{ rel, size, mtimeMs }], display }`.
    - For each file, apply runs `lstat(path.join(root, rel))`, then refuses the whole step before copying anything if any file:
      - is not a regular file
      - has a different size or mtime
      - resolves outside `root`
    - The refusal text is `'Files changed since the preview. Rescan and review it again.'`.
    - It then makes parent folders under `dest` with mode 0o700, and copies each file with `fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL)`.
    - Any error stops the plan with `ok: false` and the message.
  - **Mkdir steps:** unchanged code. The plan now also produces these for rescue folders; apply trusts the planned path.
  - **Every failure result** includes `out` naming what failed. The plan's own `note` names the destination folder, so a partial rescue can be found.

- [ ] **Step 1: Write the failing tests** in `test/rescue.test.js`, calling `apply` directly with hand-built steps:
  - `a safeGit run step runs through ctx.safeGit`: a stub `ctx.safeGit` records its args, and `ctx.run` throws if called.
  - `copy copies the listed files and keeps their bytes`.
  - `copy refuses when a file grew after planning, and copies nothing`.
  - `copy refuses a file that became a symlink`.
  - `copy never overwrites an existing destination file` (`ok: false`).
  - `copy handles a name with a newline and a leading dash`.

- [ ] **Step 2: Run them and check they fail.** Run `node --test test/rescue.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement** the generic-step `safeGit` branch, the `safeGit` opts passthrough and the `copy` kind in `apply.js`.

- [ ] **Step 4: Run the tests and check they pass.** Run `npm test && wc -l src/apply.js`. Expected: every test passes. If `apply.js` would pass 400 lines, move `copy` into `src/apply-copy.js` and require it.

- [ ] **Step 5: Commit.** `git add src/apply*.js test/rescue.test.js && git commit -m "apply: safe git run steps and a no-overwrite copy step"`

### Task 5: The `rescue-bundle` action

**Files:**
- Create: `src/actions-rescue.js`
- Modify: `src/actions.js` (register it: `Object.assign(ACTIONS, require('./actions-rescue')({ fail, nothing }))`)
- Modify: `src/service.js:74` (plan ctx gains `workspaceRoot: settings().root`, `repoPaths: [...known.values()].map((r) => r.path)`, `rescueDir: settings().rescueDir`)
- Modify: `src/engine.js` (`ACTION_CATALOG['rescue-bundle'] = { about: 'Save a copy of everything in this repo that exists only on this machine, outside the repo', params: { dest: 'optional: base folder (default ~/GutCheck-rescue)' } }`)
- Test: `test/rescue.test.js`

**Interfaces:**
- **Consumes:**
  - The `copy` kind and `safeGit` run steps from Task 4.
  - `snapshot.localOnly` and `summarizeLocalOnly` from Task 1.
  - `findRepoSecrets(dir)` from `src/secrets.js`: a list of candidates. Use each candidate's repo-relative path; the field name is in `secrets.js`.
- **Produces:** `ACTIONS['rescue-bundle'].plan(r, p, ctx)`, returning `{ risk: 'safe', title: 'Save a rescue copy of <name>', steps, note, warnings }`.

**Plan details:**
- **Base folder:** `p.dest || ctx.rescueDir || path.join(ctx.home || os.homedir(), 'GutCheck-rescue')`.
- **Destination:** `<base>/<YYYY-MM-DD local date>/<r.name>`.
- **Refusals** (via `fail`):
  - The destination is inside `ctx.workspaceRoot`, or inside any of `ctx.repoPaths` or `r.path`.
    - Compare the `realpath` of the nearest existing ancestor joined with the rest.
    - Message: `'Choose a folder outside the workspace and its repos.'`
  - The destination exists and is not empty. Message: `'<dest> already has files. Choose another folder.'`
  - No commits and no untracked files: `nothing('Nothing to save: the repo has no commits and no untracked files.')`.
- **Steps**, in order:
  1. **mkdir** the destination.
  2. **Bundle:** `bundle create <dest>/repo.bundle --all` as a safeGit run step, `timeout: 30 * 60 * 1000`.
  3. **Bundle check:** `bundle verify <dest>/repo.bundle` as a safeGit run step.
  4. **Uncommitted changes**, only when `localOnly.uncommitted > 0`: `diff HEAD --binary --output=<dest>/uncommitted.patch`.
  5. **Stashes:** for each n below `localOnly.stashes`, `stash show -p --binary --include-untracked --output=<dest>/stash-<n>.patch stash@{<n>}`.
     - Gate `--include-untracked` on `git --version` ≥ 2.32. Verify this number in git's RelNotes before relying on it, and write the confirmed version in a code comment.
     - Below that version, drop the flag and add a warning.
  6. **Untracked files:** one `copy` step, only if any files survive the filters.
     - The list comes from `ctx.safeGit(['ls-files', '-o', '--exclude-standard', '-z'], r.path)`.
     - Drop: secret paths, anything over `p.maxFileBytes || 100 * 1024 * 1024` (tests inject a small value), and anything that `lstat` says is not a regular file.
  7. **Manifest:** a `write` of `<dest>/MANIFEST.txt`.
     - Plain text: the repo name, date, git version and HEAD sha, `summarizeLocalOnly`, the branches with counts, and the files to be written.
     - Skipped files, each as `skipped <rel>: secret|too large|not a regular file`.
     - The restore commands from the spec.
     - The line `Not included: local work inside submodules and linked worktrees.`
     - The `write` step today expects an existing file (it reads the mode from `statSync`). Either give the manifest a `create` flag, or write it with the `copy` helper's `wx` path. Whichever is chosen, it must refuse to overwrite.
- **Note:** `` `Writes only to ${dest}; the repo is not changed. If a step fails, what was written so far stays there.` `` plus the size estimate: `hygiene.storage.packKiB` × 1024, plus the untracked sizes, as MB.

- [ ] **Step 1: Write the failing tests** in `test/rescue.test.js`. Build a repo with:
  - a pushed `main` and an unpushed `feature`
  - one modified tracked file and a stash with an untracked file
  - an untracked `notes.txt`, an ignored `build.log`, a `.env` containing `TOKEN=x`, a symlink, and a file over the injected limit
  - Its own copy of the facts the plan reads (`localOnly`, `hygiene.storage`) from a real scan of the temp repo, or built from `collectLocalOnly`.

  Tests:
  - **`plan refuses a destination inside the workspace`.** Also a destination inside the repo, and an existing non-empty destination.
  - **`plan says nothing to save for an empty repo with no files`.**
  - **`apply writes a bundle that clones every branch`:** `git clone repo.bundle x`, then `git -C x branch -a` lists `feature`.
  - **`uncommitted.patch applies to a clone at HEAD`**, and **`stash-0.patch` applies**.
  - **`untracked/ has notes.txt and nothing else`:** no `build.log`, `.env`, symlink or large file.
  - **`MANIFEST.txt names skipped files by reason and never contains TOKEN=x`.**
  - **`the repo is unchanged`:** `git status --porcelain=v2 --branch`, `git for-each-ref` and `git stash list` outputs are identical before and after.
  - **`plan uses safeGit for every git step`:** every step with `args` has `safeGit: true`.
  - **`the bundle step has a 30-minute timeout`.**
  - **`a failing bundle step stops apply and leaves the folder`:** use a stub `safeGit` that fails on `bundle`. The result is `ok: false`, and the folder still exists.

- [ ] **Step 2: Run them and check they fail.** Run `node --test test/rescue.test.js`. Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** `src/actions-rescue.js`, the registration, the service ctx and the catalog entry.

- [ ] **Step 4: Run the tests and check they pass.** Run `npm test && wc -l src/actions*.js src/service.js src/engine.js`. Expected: every test passes, and every file is under 400 lines.

- [ ] **Step 5: Commit.** `git add -A src test && git commit -m "Action: save a rescue copy of local-only work outside the repo"`

### Task 6: The app entry, docs and an end-to-end check

**Files:**
- Modify: the renderer's repo action list.
  - Find where actions such as `worktree-prune` or `maintenance-register` are offered without a finding: `grep -rn "maintenance-register" src/renderer`.
  - Add "Save a rescue copy" for repos with `localOnly.any`, or any repo with commits.
- Modify: `docs/sources.md`, `CHANGELOG.md` (Unreleased → Added), `README.md` (one feature line).
- Test: `test/renderer.test.js`, following its existing pattern for action buttons.

**Interfaces:**
- **Consumes:** `rescue-bundle` from Task 5, and `localOnly` on the repo object the renderer receives. Check that the IPC repo summary passes it through, in `service.js`'s repo view. If it does not, add `localOnly` to that view.

- [ ] **Step 1: Write the failing test:** `repo detail offers Save a rescue copy when localOnly.any`.
- [ ] **Step 2: Run it and check it fails.** Run `node --test test/renderer.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the renderer entry.
- [ ] **Step 3b: Write the docs.**
  - **Sources:** the git-bundle docs (https://git-scm.com/docs/git-bundle), git-stash `show` (https://git-scm.com/docs/git-stash) and git-ls-files (https://git-scm.com/docs/git-ls-files).
  - **Motivating case:** the 2026-11-09 manual check before trashing aur-xzram.
  - **Changelog:** two Added bullets, "Local-only work report and rescue copy" and "`git-unpushed-branches` check".
- [ ] **Step 4: Verify end to end.**
  - Run `npm test`.
  - Run `node src/cli.js local-only` against `~/Projects`; expected: a list of repos with local work, or none.
  - Run `node src/cli.js fix <a repo with local work> rescue-bundle dest=<scratch folder>`; expected: a preview, then apply on confirm, and `git bundle verify` passes on the result.
  - Then delete the scratch rescue folder.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Rescue copy in the app; docs and changelog"`

## Self-review notes

- **Spec coverage:**
  - collector → Task 1
  - finding and report → Task 2
  - advice, CLI and MCP → Task 3
  - apply changes → Task 4
  - plan, refusals, steps, manifest, restore and errors → Task 5
  - app, docs and changelog → Task 6
  - accuracy tests → Task 2
  - "repo unchanged" → Task 5
- **One deviation from the spec:** the spec says `mkdir` gets "widened". The code has no path check in apply, so nothing changes there; the plan owns the check (Task 5 refusals).
