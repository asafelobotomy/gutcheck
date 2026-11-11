# Remote Repos API Fixes (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let GitHub API-only fixes be planned and applied on repos that are on GitHub but not cloned here; keep every other fix refused.

**Architecture:** An allowlist `API_ACTIONS` in `renderer/fix-all.js` (shared by app, CLI, MCP). `actions.plan` refuses other types on `source: 'remote'`, checks every planned step is a `gh` step, and moves its `cwd` to `os.tmpdir()`. Fix all, the report and the app follow the allowlist.

**Tech Stack:** Node 22, `node:test`, jsdom. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-remote-repos-api-fixes-design.md`

## Global Constraints

- `API_ACTIONS` = `pr-merge`, `pr-close`, `pr-ready`, `run-rerun`, `protect-branch`, `protect-tags`, `actions-settings`, `security-enable`, `repo-edit`.
- `REMOTE_FILE_FIX`, verbatim: `This fix changes files or local git, and the repo is not cloned in this workspace. Clone it to fix this; fixes as pull requests come in a later version.`
- `REMOTE_NOTE`, verbatim: `Not cloned in this workspace: GitHub fixes (pull requests, CI, protection, security and repository settings) run here; fixes that change files need a clone for now.`
- Step check failure, verbatim: `Only GitHub API steps can run on a repo that is not cloned here.`
- Fix all skip reason, verbatim: `changes files; the repo is not cloned here`.
- `REMOTE_BLOCKED` is removed everywhere. Files under 400 lines (`app.js` is 390). Tests offline.

## Review Focus

- A remote repo's `gh` step must never run with `cwd: 'remote:owner/name'` (spawn ENOENT): Task 1 asserts `cwd === os.tmpdir()` for every step, `check` steps included.
- A danger plan on a remote repo (`pr-merge` with failing checks) needs the confirm name `owner/name`: Task 1 asserts `confirmName`.
- A finding fix of a file type reached via `{ repo, finding }` on MCP: refused with `REMOTE_FILE_FIX`, Task 3.
- After apply, the refresh goes through the injected `rescan` with the `remote:` key: Task 1.
- Overview bulk Fix all mixing local and remote file fixes: not offered (`RemoteView.canFix` in `overview-view.js`), Task 4.

---

### Task 1: Allowlist and planning guard

**Files:** Modify `src/renderer/fix-all.js`, `src/actions.js`, `src/service.js`, `src/apply.js`. Test: `test/remote-api-fixes.test.js` (new); update `test/remote-guard.test.js`.

**Interfaces — Produces:** `FixAll.API_ACTIONS` (Set), `FixAll.REMOTE_FILE_FIX`, `FixAll.REMOTE_NOTE` (strings).

- [ ] Write tests: each allowlisted action (repo-edit, security-enable alerts, protect-branch minimal, protect-tags, actions-settings read-token, run-rerun, pr-merge, pr-close, pr-ready) on a remote result plans `ok`, every step has `cmd === 'gh'` and `cwd === os.tmpdir()`, and the joined args contain `octo/app`; `add-file`, `commit-all`, `pull`, `delete-remote`, `unprotect-branch` fail with `REMOTE_FILE_FIX`; `pr-merge` on a FAILURE PR has `confirmName === 'octo/app'`; service plan + apply of `repo-edit` with an injected runner (via `actions.apply` ctx is not injectable from service, so stub `run` by planning with `actions.plan` and calling `actions.apply(p, { run })`) runs `gh repo edit octo/app --description x` in tmpdir; service `applyActions` calls `rescan('remote:octo/app')`.
- [ ] Run `node --test test/remote-api-fixes.test.js`: FAIL.
- [ ] Implement: constants in fix-all.js; guard + step check + cwd rewrite in `actions.plan` (after `inspect`); remove service refusal; `apply` skips `remote:` keys when forgetting drivers.
- [ ] Run: PASS. Commit.

### Task 2: Fix all

**Files:** Modify `src/renderer/fix-all.js`. Test: `test/remote-api-fixes.test.js`.

- [ ] Test: `FixAll.plan(remote)` with findings `repo-edit` (deleteBranchOnMerge true), `security-enable`, `pr-close`, `add-file license`, `gitignore-append`: actions hold repo-edit and security-enable, decisions hold pr-close, skipped holds the two file fixes with the reason; no `blocked` key.
- [ ] Implement in `plan(r)`: for `source === 'remote'`, a fix type outside `API_ACTIONS` goes to `skipped`.
- [ ] Run: PASS. Commit.

### Task 3: CLI, MCP and report

**Files:** Modify `src/report.js`. Test: update `test/remote-cli.test.js`, `test/remote-guard.test.js`.

- [ ] Tests: CLI `fix octo/app repo-edit description=x` exits 0 and prints `gh repo edit octo/app`; CLI `fix octo/app no-license` (or an add-file finding in the fixture) fails with `REMOTE_FILE_FIX`; MCP `gutcheck_plan` returns a token for repo-edit and `REMOTE_FILE_FIX` for add-file; report remote section contains `REMOTE_NOTE` and `-R octo/app`, no `cd`.
- [ ] Implement the report note. Run: PASS. Commit.

### Task 4: App

**Files:** Modify `src/renderer/remote-view.js` (`canFix(r, fix)`, `localPanel(r, panel)`, `note` uses `REMOTE_NOTE`), `src/renderer/app.js`, `src/renderer/overview-view.js`. Test: update `test/remote-ui.test.js`.

- [ ] Tests: remote detail shows Fix all and "Set description…", no "New branch…", no "+ LICENSE", no "Archive repo", no "Remove protection"; text includes `REMOTE_NOTE`. Overview bulk Fix all checks `RemoteView.canFix`.
- [ ] Implement; keep `app.js` under 400 lines. Run: PASS. Commit.

### Task 5: Archive from the inactive finding

**Files:** `src/checks.js` (fix on `inactive` when ADMIN), `src/actions-github.js` (`repo-archive`: admin check, warning), `src/renderer/fix-all.js` (allowlist, decision pick leave, STEP 13), `src/renderer/app.js` (Archive button back on remote). Test: `test/remote-branches.test.js`.

- [ ] Tests: `inactive` carries the fix only for ADMIN; plan on a remote repo is `gh repo archive octo/app --yes`, danger, confirmName `octo/app`; non-admin refused; Fix all puts it in decisions with pick on "leave", and `order` runs it after `security-enable` and `pr-close`.
- [ ] Implement; PASS; commit.

### Task 6: Branches from GitHub

**Files:** Create `src/remote-branches.js` (`parseBranches(data, defaultBranch)`, `fetchBranches(ref, defaultBranch, { run })`, `fetchRemoteData(refs, opts)`, `branchFindings(branches, snap)`); modify `src/remote-stage.js` (default `fetch`), `src/remote-scan.js` (`ghBranches`, extra findings). Test: `test/remote-branches.test.js`.

- [ ] Tests: parse a canned GraphQL payload (merged by ancestry, merged by squash PR, unique > 0, default dropped, bad name dropped); `fetchBranches` passes `-f o= n= d=` and returns `null` on a failed run; `branchFindings` makes `gh-merged-branches` (fix only with push permission) and at most 5 `gh-branch-no-pr-*`, skipping branches with an open PR; `scanRemote` with `ghRes.branches` sets `ghBranches` and adds the findings.
- [ ] Implement; PASS; commit.

### Task 7: API branch actions

**Files:** `src/actions-github.js` (factory also returns `deleteOnGitHub`; `pr-create` and `pr-close` remote variants), `src/actions.js` (`delete-remote` delegates for remote repos), `src/renderer/fix-all.js` (allowlist, decisions, STEP), `src/engine.js` (action catalogue params), `src/renderer/remote-view.js` + `app.js` (Branches on GitHub panel). Test: `test/remote-branches.test.js`, `test/remote-ui.test.js`.

- [ ] Tests: per the spec's section 8 (args, check step expect, risk, undo, refusals); panel lists branches with buttons.
- [ ] Implement; PASS; commit.

### Task 8: Docs and full suite

- [ ] `docs/sources.md` (`gh --repo`), `CHANGELOG.md` Unreleased, README remote section, AGENTS.md layout line.
- [ ] `npm test`: all pass. Commit.
