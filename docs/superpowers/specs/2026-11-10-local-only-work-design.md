# Local-only work report and rescue bundle

Feature 1 of `docs/superpowers/plans/2026-11-10-larger-features-roadmap.md`. Design approved in chat on 2026-11-10.

## Goal

Before a repo is trashed or the user moves machines, GutCheck says what exists only on this computer, and can save it in one previewed step.

**Success:**
- The workspace shows "N repos hold local-only work", and each of those repos shows what that work is.
- A rescue writes files that restore the work. They are verified before the action reports success.
- The repo itself is never changed.

**Rules kept:**
- Scans are read-only and never run repo code.
- Every step is planned, previewed, then applied.
- Every git call goes through `exec.git` (scans) or `ctx.safeGit` (plans and actions).
- No secret values or file contents in findings, reports, manifests or logs.
- Files stay under 400 lines.
- `npm test` stays offline.

## What exists today (not duplicated)

| Work that exists only here | Existing check |
|---|---|
| Unpushed commits on the **current** branch | `git-ahead` (checks.js) |
| Stashes | `git-stashes` (checks-hygiene.js) |
| Uncommitted and untracked changes | `git-dirty` (checks.js) |
| No remote at all | `no-remote` (checks.js) |
| Current branch's upstream deleted | `git-upstream-gone` (checks-hygiene.js) |
| Commits reachable only from a detached HEAD | `git-detached` (checks-gitstate.js) |

**Missing:**
- commits on **other** local branches that exist on no remote
- a single per-repo answer to "is anything here only on this machine?"
- a workspace roll-up
- a way to save the work

## Part A: the report (read-only)

### Collector: `src/local-only.js`

`collectLocalOnly(dir, { branch, hasRemote, dirty, untracked, stashes, detachedOnly, upstreamGone })`

- It runs during the normal scan, after `collectHygiene`, and reuses values the scan already has: stash count, dirty count, current branch and remotes.
- **Branches.**
  - Command: `git for-each-ref --format=%(refname:short) refs/heads`.
  - For each branch, at most 50, run `git rev-list --count <ref> --not --remotes`.
  - Refs are passed as `refs/heads/<name>` so a name can never be read as an option.
  - More than 50 branches → the result says `truncated: true`.
  - No remote-tracking refs at all → every branch counts, and the result says `neverPushed: true`.
- **Untracked count.**
  - Taken from the scanner's existing `git status --porcelain=v2` output: lines starting with `?`.
  - The scanner now counts these separately from tracked changes.
  - The status is still read without `-uall`, so a new folder counts once.
- **Result** (stored on the snapshot as `localOnly`):

```js
{
  branches: [{ name, ahead }],     // only branches with ahead > 0, current branch included
  truncated: false, neverPushed: false,
  stashes: 2, uncommitted: 3, untracked: 1,
  noRemote: false, upstreamGone: false, detachedOnly: 0,
  any: true,                        // anything above is non-zero or true
}
```

Branch names come from the repo and are data. They pass through the existing `printable` and `text-safe` helpers before display.

### Finding: `git-unpushed-branches`

- **Category:** Branches.
- **Severity:** warn.
- **Title:** "N other branches have commits on no remote".
- **Detail:** lists up to 8 names with counts.
- **Scope:** branches other than the current one (`git-ahead` covers the current one), and only when the repo has a remote. With no remote, `no-remote` already warns.
- **Fix:** `{ type: 'rescue-bundle', label: 'Save a rescue copy' }`.
- **Report step:** phase 1 in `report-fixes.js`. It gives `git push -u origin <branch>` per branch, with a note to ask the owner before pushing branches they may have meant to delete.

### Surfaces

- **Workspace advice** (in `workspace.js` `devAdvice`): `ws-local-only`, info severity.
  - Shown when any repo has `localOnly.any`.
  - Title: "N repos hold work that exists only on this machine".
  - Detail: one line per repo with a short summary, such as `noti-fi: 2 branches, 1 stash, 3 uncommitted`.
- **CLI:** `gutcheck local-only [--json]` prints the same per-repo lines. Exit code 0.
- **MCP:** `gutcheck_local_only`, read-only. It returns `{ repos: [{ repo, ...localOnly }] }`.
- **App:** the workspace advice appears where advice already appears. The repo detail shows the new finding with its fix button. No new screens.

## Part B: the rescue (`rescue-bundle` action)

### Plan

The plan comes from `planRescue(r, { dest })` in a new `src/actions-rescue.js`, registered in `actions.js` and `engine.js`.

**Destination**
- Default: `~/GutCheck-rescue/<YYYY-MM-DD>/<repo>/`. Settings key `rescueDir` overrides the base folder.
- The plan **refuses** when:
  - the resolved destination (after `realpath` of its nearest existing parent) is inside the workspace, or inside this or any scanned repo
  - the destination already exists and is not empty
  - the repo has no commits and no untracked files (nothing to save)

  A repo with nothing local-only can still be rescued (for example before trashing it), and the preview says nothing in it is local-only.

**Steps**, in order:

1. `mkdir` the destination, mode 0700. The existing step kind, widened to accept this destination as well as test-run folders.
2. **Bundle.** `git bundle create <dest>/repo.bundle --all`, run with `safeGit: true`.
   - This is a full, self-contained bundle: it restores without the remote.
   - Skipped when the repo has no commits.
3. **Bundle check.** `git bundle verify <dest>/repo.bundle`, run with `safeGit: true`.
4. **Uncommitted changes.** `git diff HEAD --binary --output=<dest>/uncommitted.patch`, run with `safeGit: true`.
   - Only when there are uncommitted tracked changes.
   - Filters are already blanked by `ctx.safeGit`, so no repo code runs.
5. **Stashes.** One step per stash: `git stash show -p --binary --include-untracked --output=<dest>/stash-<n>.patch stash@{<n>}`, run with `safeGit: true`.
   - Verify first: the git version that added `--include-untracked` to `stash show`. On older git, drop the flag and say so in `MANIFEST.txt`.
6. **Untracked files.** One `copy` step (a new step kind) for the untracked, not-ignored files.
   - The file list comes from `git ls-files -o --exclude-standard -z`, read at plan time.
   - The plan excludes files `findRepoSecrets` reports, files over 100 MB, symlinks and anything outside the repo.
   - The step carries the exact relative paths, sizes and mtimes.
   - At apply time, `copy` re-`lstat`s each file. It refuses the whole step if any file is now a symlink, a different size or a different mtime ("changed since the preview, rescan").
   - Files are copied into `<dest>/untracked/<rel>` with `COPYFILE_EXCL`.
7. **Manifest.** A `write` of `<dest>/MANIFEST.txt`. It lists:
   - the repo name, date, git version and HEAD
   - the branches and counts from `localOnly`
   - each file written, with its size
   - each untracked file skipped, by name and reason (secret, too large, symlink)

   It never holds file contents or secret values.

**Preview** shows every step's display text, the files to be written, and the estimated total size. The estimate is `storage.packKiB` plus the untracked sizes plus a patch estimate.

**Risk:** `safe` (it writes only outside the repo). The plan note says the repo is not changed and how to restore.

### Restore (documented in MANIFEST.txt and the report step)

```sh
git clone repo.bundle <name>            # every branch, tag and the stash ref
cd <name> && git apply ../uncommitted.patch
git apply ../stash-0.patch              # or keep it as a branch
cp -r ../untracked/. .
```

### Changes to `apply.js`

- **Generic run step:** when `s.safeGit` is set, run `ctx.safeGit(s.args, s.cwd)` instead of `ctx.run`. Today only `check` steps honour it.
- **New `copy` kind,** as described in step 6. It never follows symlinks, never overwrites, and creates parent folders with mode 0700.
- **`mkdir`:** today it is limited to GutCheck's run folder. Add the rescue base folder to what it accepts. The check stays in the plan, and apply trusts the planned path as it does now.

### Surfaces

- **App:** the fix button on `git-unpushed-branches`, plus a "Save a rescue copy" entry in the repo's action list. A repo with local-only work but no finding of its own (for example only stashes) still gets the entry.
- **CLI:** `gutcheck fix <repo> rescue-bundle [dest=<dir>]`, through the existing fix flow (plan, show, confirm).
- **MCP:** available through `gutcheck_plan` and `gutcheck_apply` like other safe actions.

## Errors

- A git step fails: stop at that step, and report what was written so far. The partial destination folder is kept and named in the result; nothing is deleted.
- A file changes between preview and apply: the `copy` step refuses with "changed since the preview, rescan".
- The destination appears between plan and apply: `mkdir` succeeds on an empty folder, and `copy` refuses to overwrite.

## Tests

- **`test/local-only.test.js`** (temp repos), covering:
  - an unpushed branch next to a pushed one (via a local bare remote)
  - no remote
  - a never-fetched remote
  - a stash, untracked and uncommitted files
  - more than 50 branches (truncated)
  - a branch named `--help`
  - a clean repo (`any: false`)
- **Finding and surfaces,** covering:
  - `git-unpushed-branches` is absent when the repo has no remote, and excludes the current branch
  - the `ws-local-only` advice text
  - the CLI `local-only --json` shape
  - the MCP tool registration
- **`test/rescue.test.js`,** covering:
  - plan refusals (destination inside the workspace or a repo, an existing non-empty destination, an empty repo with nothing to save)
  - apply on a repo with every kind of work, then `git clone repo.bundle` restores every branch
  - `git apply uncommitted.patch` restores the tracked changes, and the stash patch applies
  - untracked files are copied, except an ignored file, a `.env` (secret), a symlink and an oversized file (size threshold injected for the test)
  - `MANIFEST.txt` contains no file contents
  - a file changed after planning makes `copy` refuse
  - the repo's status, refs and stash list are byte-identical before and after
- **`test/accuracy.test.js`** (or `-runtime`):
  - a repo whose only branch is pushed raises no finding
  - a fresh `git init` with no commits raises no `git-unpushed-branches`

## Docs

- `docs/sources.md`: git-bundle, git-stash `show`, git-ls-files `-o --exclude-standard`, and the 2026-11-09 manual deletion check as the motivating case.
- `CHANGELOG.md` Unreleased:
  - Added: "Local-only work report and rescue copy".
  - Added: "`git-unpushed-branches` check".
- README: one line in the feature list.

## Out of scope

- Agent worktrees (feature 3 reuses `localOnly`).
- Uploading rescues anywhere.
- Deleting repos after a rescue.
- Scheduled rescues.
