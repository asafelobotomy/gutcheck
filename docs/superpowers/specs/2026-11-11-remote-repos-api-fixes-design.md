# Remote repos: GitHub API fixes for repos that are not cloned

Part 2 of 3 of "GutCheck for remote repos". Builds on part 1 (`2026-11-11-remote-repos-scan-design.md`).

| Part | Scope | Status |
|---|---|---|
| 1 | Find and scan uncloned GitHub repos, read-only | Done |
| 2 | GitHub API fixes on uncloned repos (this spec) | Done |
| 3 | File fixes delivered as pull requests from the cache clone | Later spec |

## Goal

Fixes that only call the GitHub API (pull requests, CI re-runs, branch and tag protection, Actions settings, security features, repository settings) can be planned, previewed and applied on a repo that is on GitHub but not cloned in the workspace, from the app, `gutcheck fix` and MCP `gutcheck_plan`. Fixes that change files or local git stay refused.

**Success:**
- Fix all on a remote repo offers its API fixes (automatic and decisions) and lists every file fix as skipped with the reason.
- `gutcheck fix owner/name <finding>` and `gutcheck fix owner/name all`, and MCP `gutcheck_plan` with `{ repo: 'owner/name', ... }`, plan and apply those fixes.
- Every step of such a plan is a `gh` command that names the repo itself (`-R owner/name`, `repo edit owner/name` or `api repos/owner/name/...`), runs in a neutral folder (never `remote:owner/name`), and has no git, write, append, remove or copy step.
- Any other action on a remote repo is refused, with a message that says why and what to do.

**Rules kept:** plan, preview, apply; single-use plan tokens; read-only mode; danger plans need the repo name typed (`owner/name`); every change goes to History; after a change the repo is refreshed through the remote refresh, not a folder scan.

## 1. Which actions

An allowlist, `API_ACTIONS`, exported from `src/renderer/fix-all.js` so the app, CLI, MCP, `actions.js` and the report share it:

`pr-merge`, `pr-close`, `pr-ready`, `run-rerun`, `protect-branch`, `protect-tags`, `actions-settings`, `security-enable`, `repo-edit`.

Each of these is already written in `actions-github.js` against `owner/name` from `needRemote(r)` and reads only the scan's GitHub data (`r.remote`, `r.prs`, `r.ci`, `r.tagRulesets`, `r.actionsSettings`), which a remote result has, partial or not.

**Left out, on purpose:**
- `delete-remote`: it pushes a delete refspec from the local clone, and a remote result has no branch list (`remoteBranches` is blanked in part 1). An API version needs branch data the remote scan does not collect. Not needed for any finding's fix.
- `pr-create`: needs a local branch.
- `unprotect-branch` and `repo-archive`: danger actions that no finding offers; they stay local-only so the remote surface is only what Fix all and findings need. The app hides their buttons on remote repos.

## 2. Planning (`actions.js`)

`plan(repo, action)` gains one rule, before the action's own `plan`:

- `repo.source === 'remote'` and `action.type` not in `API_ACTIONS` -> fail with `REMOTE_FILE_FIX`: "This fix changes files or local git, and the repo is not cloned in this workspace. Clone it to fix this; fixes as pull requests come in a later version."

After the action's `plan` returns, for a remote repo every step is checked: `cmd === 'gh'`, kind `cmd` or `check`, no `safeGit`. Anything else fails the plan ("Only GitHub API steps can run on a repo that is not cloned here."), so a later change to an action cannot slip a git or file step onto a remote repo. Each step's `cwd` is replaced with `os.tmpdir()`: `gh` with an explicit repo does not read the folder it runs in, and `remote:owner/name` is not a folder (spawning there fails).

This lives in `actions.js`, the one place every caller (app, CLI, MCP) goes through. `service.planActions` drops its blanket refusal.

`inspect` and `recheck` already return "nothing to check" for plans with no git `uses`, which every API action is.

## 3. Applying (`service.js`, `apply.js`)

No change in behaviour. `applyActions` keys by `repoPath` (`remote:owner/name`), which is in `known`; `rescan` is `ws.refresh`, which already refreshes a remote repo from its listing. `apply`'s driver-cache clean-up gets `remote:…` and the temp folder as keys and forgets nothing, which is harmless; it is changed to skip keys starting with `remote:` for clarity.

## 4. Fix all (`renderer/fix-all.js`)

`plan(r)` for a remote repo runs the normal logic, but a finding whose fix type is not in `API_ACTIONS` goes to `skipped` with the reason "changes files; the repo is not cloned here". `blocked` is gone. `order()` needs no change: with no commits there is no push.

`REMOTE_BLOCKED` is replaced by two constants: `REMOTE_FILE_FIX` (above) and `REMOTE_NOTE`: "Not cloned in this workspace: GitHub fixes (pull requests, CI, protection, security and repository settings) run here; fixes that change files need a clone for now."

## 5. App

- Detail view: Fix all shows when there is anything to fix. Finding fix buttons show when the fix type is in `API_ACTIONS`. The note under the toolbar is `REMOTE_NOTE`.
- The Branches panel and "Add missing files" panel are hidden for remote repos (they are local git and file actions). In the Repository settings panel, "Remove protection" and "Archive repo" are hidden for remote repos.
- Workspace overview (`overview-view.js`): a group is not bulk-fixed when any of its fixes is on a remote repo and not in `API_ACTIONS`.

`app.js` is at 390 lines, so the remote checks are helpers in `remote-view.js` (`canFix(r, fix)`, `localPanel(r, panel)`).

## 6. Report ("Copy for LLM")

The remote section keeps its findings list and replaces the old note with `REMOTE_NOTE` plus: "Run gh commands with `-R owner/name`; there is no folder to `cd` into. Or use `gutcheck fix owner/name all`." Still no `cd` step.

## 7. CLI and MCP

No new commands or tools. `engine.plan` already resolves `owner/name` and calls `FixAll.plan` and `service.planActions`, so `gutcheck fix` and `gutcheck_plan` pick up the change. A refused file fix comes back as a plan error with `REMOTE_FILE_FIX`.

## Testing (offline)

- `actions.plan` on a remote result: each allowlisted action plans with only `gh` steps whose `cwd` is the temp folder and whose args name `owner/name`; `add-file`, `commit-all`, `delete-remote`, `pull`, `unprotect-branch` are refused with `REMOTE_FILE_FIX`.
- A stubbed action that returns a git step on a remote repo is refused (the step check).
- `service.planActions` + `applyActions` with an injected runner: a `repo-edit` plan runs `gh repo edit octo/app ...` in the temp folder, is audited, and the repo is refreshed through `rescan`.
- `FixAll.plan`: API fixes in `actions`/`decisions`, file fixes in `skipped`.
- CLI `gutcheck fix octo/app repo-edit description=x` plans (no `--yes`: nothing runs); `fix octo/app no-license` is refused. MCP `gutcheck_plan` returns a token for an API fix and an error for a file fix.
- Report: remote section has `REMOTE_NOTE`, `-R octo/app`, no `cd`.
- Renderer (jsdom): Fix all button and API fix buttons present; Branches and Add missing files absent; no Archive/Remove protection.

## Docs

- `docs/sources.md`: `gh` `-R/--repo` (gh manual) as why no folder is needed.
- `CHANGELOG.md` under `## [Unreleased]`: replace part 1's "Fixes for them come in a later version" sentence with what now works.
- README remote section: which fixes run on uncloned repos.

## Not in part 2

File fixes as pull requests (part 3), deleting branches on GitHub for remote repos, hosts other than GitHub.
