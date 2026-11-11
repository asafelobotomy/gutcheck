# Remote repos: health checks for repos that are not cloned

Part 1 of 3 of "GutCheck for remote repos". Design approved in chat on 2026-11-11.

| Part | Scope | Status |
|---|---|---|
| 1 | Find and scan uncloned GitHub repos, read-only (this spec) | Designed |
| 2 | GitHub API fixes on uncloned repos (`actions-github.js` keyed by `owner/name`) | Later spec |
| 3 | File fixes delivered as pull requests from the cache clone | Later spec |

## Goal

GutCheck reports the health of GitHub repos you own (and orgs you choose) that have no folder in the scanned workspace, with the same checks, scores and reports as local repos.

**Success:**
- With remote repos turned on, a workspace scan lists every included uncloned repo next to the local ones, marked "Remote".
- A remote repo gets the GitHub-side checks and every file-based check; checks that describe a working copy never appear on it.
- A repo that cannot be cloned (too large, clone failed, rate limited) still gets the GitHub-side checks, marked "GitHub checks only".
- No action can be planned or applied on a remote repo in part 1.

**Rules kept:**
- Scans never run a repo's code. The cache clone is made so that no hook, filter driver, LFS smudge or transport helper from the repo can run.
- The user's repos and workspace are never changed. GutCheck writes only under its own data folder.
- Every git call goes through `exec.git` (scans) or the fixed-argument clone/fetch helper defined below.
- No secret values, tokens or credential-bearing URLs in findings, reports or logs.
- Files stay under 400 lines. `npm test` stays offline.

**Assumptions:** GitHub only, through the `gh` CLI the user is already signed in with. Repos cloned outside the scanned workspace count as uncloned ("not cloned in this workspace").

## 1. Finding uncloned repos

New module `src/remote-repos.js`, using `github.js`'s `run('gh', …)` and its rate tracking (`refreshRate`, `getRate`, `MIN_GRAPHQL`).

**Listing:** one paginated GraphQL query on `viewer.repositories(ownerAffiliations: OWNER)`, plus `organization(login).repositories` for each org in settings. Per repo: `owner/name`, `isFork`, `isArchived`, `diskUsage` (KB), `defaultBranchRef.name`, `pushedAt`. Names that fail `NAME_RE` are dropped. Org logins from settings are validated with the same pattern before use.

**Uncloned:** a listed repo is uncloned when no scanned folder's parsed origin `ref` has the same `owner/name`, compared case-insensitively.

**Settings** (`settings.json`, key `remote`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Off by default, so an update never starts downloading |
| `orgs` | `[]` | Org logins to include besides your own repos |
| `forks` | `false` | Include forks |
| `archived` | `false` | Include archived repos |
| `skip` | `[]` | `owner/name` entries to leave out |
| `maxSizeMB` | `500` | Larger repos (by `diskUsage`) are not cloned: GitHub checks only, with the info finding `uncloned-too-large` |
| `cacheMaxGB` | `5` | Total cache size before the least recently scanned clones are deleted |

**When:** a stage of `workspace-scan.js` `scan()`, after local discovery and the local scan. Remote repos enter the `known` map under `remote:owner/name`, so `refresh()`, `forgetPlans()` and the "only known repos" rule cover them.

**Failure:** if `gh` is not signed in, or the network or rate limit fails, the local scan finishes normally and the workspace gets one info finding, `uncloned-unavailable` ("Remote repos not checked: <reason>"). No uncloned repo is reported then.

## 2. The cache clone

**Location:** `dataDir()/remote-cache/<owner>__<name>/`, from a new `paths.remoteDir(owner, name)` that accepts only `NAME_RE` names. A sibling file `remote-cache/<owner>__<name>.json`, outside the work tree so no check sees it, records `{ branch, pushedAt, clonedAt, lastScannedAt }`.

**Create** (first scan, or folder missing or unreadable). Fixed arguments; the URL is built by GutCheck as `https://github.com/<owner>/<name>.git`:

```
git -c core.hooksPath=/dev/null -c core.fsmonitor=false
    -c protocol.ext.allow=never -c protocol.fd.allow=never -c protocol.file.allow=never
    -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false
    clone --depth 1 --single-branch --no-tags --branch <defaultBranch>
          --no-recurse-submodules -- <url> <dir>
```

Environment: `GIT_LFS_SKIP_SMUDGE=1`, `GIT_TERMINAL_PROMPT=0`, plus `SAFE_GIT_ENV`. Authentication comes from the user's global credential helper (normally `gh auth git-credential`). A fresh clone has no repo-level config, hooks or drivers.

**Refresh:** when the listing's `pushedAt` is newer than the recorded one, `fetch --depth 1 --no-tags origin <branch>` then `reset --hard FETCH_HEAD`, with the same `-c` set. Otherwise nothing is downloaded. If the default branch changed, the folder is deleted and cloned again. Before each fetch the helper checks that the clone's local config holds only the keys `clone` writes (`core.*` defaults, `remote.origin.url` equal to the built URL, `remote.origin.fetch`, `branch.<b>.*`); anything else means the folder is deleted and cloned again.

**Limits:** repos over `maxSizeMB` are never cloned. Before a new clone that would take the cache over `cacheMaxGB` (measured by the cache's on-disk size, estimated for the new repo by `diskUsage`), the least recently scanned clones are deleted. Clones run 2 at a time in the existing `pool()`, with a 5-minute timeout each.

**Clean-up:** at the end of a scan, cache folders for repos that are no longer listed, are filtered out, or are now cloned in the workspace are deleted. Deletion only ever touches direct children of `remote-cache/` named `<owner>__<name>` or `<owner>__<name>.json`. Settings has "Clear remote cache" and the CLI has `gutcheck remote --clear-cache`.

**Errors:** a failed or timed-out clone or fetch falls back to the GitHub-only result with an info finding, `uncloned-clone-failed`, whose detail is the first line of git's stderr with any `user:pass@` removed.

**Testability:** the clone/fetch helper takes `run` and a `urlFor(ref)` function by injection. Tests pass a `urlFor` that points at a local bare repo and a `run` that allows the file transport only for that test; production has no way to override `urlFor`.

## 3. Which checks run

`scanRemote(ref, listing, opts)` in `remote-repos.js` builds the same object `collectLocal` returns and passes it to the existing `finish()`, so scoring, policy, ignores and the GitHub follow-up calls (CI, security, tag rulesets, Actions settings, alerts) are unchanged. The result carries `source: 'remote'`, `path: 'remote:owner/name'`, `name: 'owner/name'`, `cacheDir` (or `null`) and `partial` (true when no clone was used).

**On the cache clone:** files, docs and hygiene file checks, workflows and Actions security, deps (manifests, lockfiles), runtimes, `depAutomation`, `release` (tags from the API's `latestRelease`, since the clone has none), agent config and context, drift, `repoPolicy`, clutter and quality (committed files only), and Dependabot "superseded" checks against the lockfiles.

**Skipped** (they describe a working copy, not the repo): uncommitted and untracked files, stashes, ahead/behind, local and merged branches, `gitState` (unfinished operations, detached HEAD, maintenance, identity), `localOnly`, storage size, and the origin-URL checks (`no-remote`, `remote-*`). They are filled with the empty values `evaluate()` already reads as "nothing to report". A test asserts that no finding from these families appears on a remote result.

**GitHub checks only** (`partial: true`): the local object is empty and only the GitHub-side checks run. The UI and report say "GitHub checks only" with the reason.

**Unchanged rules:** `tests-run` never runs on a remote repo, deep scans included. Ignores and baseline use the same `owner/name` key as a local clone, so they carry over when a repo is cloned. `seen.json` keys remote repos by `remote:owner/name`.

## 4. App, CLI, MCP and the actions guard

**App:**
- `dashboard.js` / `overview-view.js`: remote repos in the same list with a "Remote" chip (and "GitHub checks only" when partial), and an All / Local / Remote filter.
- Repo detail: "Not cloned in this workspace" instead of a path; git state, local-only work, secrets and tests panels hidden.
- Settings: a "Remote repos" section with every setting from section 1, an org picker filled from `gh api user/orgs`, and "Clear remote cache" with the current size.
- Scan progress: a second stage, "Checking N remote repos (cloning K)".

**CLI:** `--remote` / `--no-remote` override the setting for one run. `gutcheck scan` tags remote repos `[remote]`. `gutcheck remote` prints the inventory (included, filtered out and why, cache use); `gutcheck remote --clear-cache` empties the cache. Commands that take a repo name also take `owner/name`.

**MCP:** no new tools. `gutcheck_overview`, `gutcheck_findings`, `gutcheck_repo`, `gutcheck_report`, `gutcheck_clutter` and `gutcheck_quality` include remote repos with `source: "remote"`. `gutcheck_local_only`, `gutcheck_secrets` and `gutcheck_tests` exclude them.

**Actions guard:** `service.plan()` and `renderer/fix-all.js` refuse any action on a target with `source: 'remote'`: "Fixes for uncloned repos come in a later version; clone the repo to fix it now." `report.js` writes that note in place of fix steps, so "Copy for LLM" never points at a path that does not exist. Part 2 lifts this guard for GitHub API actions only.

## Testing

All offline, with temp folders and stubbed `gh`:
- Listing: pagination, org inclusion, fork/archived/skip filters, bad names dropped, case-insensitive match against local refs.
- Clone helper: exact argument list; refusal of names outside `NAME_RE`; refresh skipped when `pushedAt` is unchanged; re-clone when the branch changed or local config has unexpected keys; a repo with a committed `.gitattributes` filter and an LFS pointer clones without running anything (a filter command that writes a marker file must not have run).
- Cache: size cap eviction order; clean-up deletes only `<owner>__<name>` and `<owner>__<name>.json` children of `remote-cache/`.
- Finding ids: the new `uncloned-*` ids are distinct from the skipped `remote-*` origin-URL family.
- Scan: a remote result has no working-copy findings; partial results when too large or the clone fails; `uncloned-unavailable` when `gh` fails, with the local scan intact.
- Guard: plan, apply, CLI `fix` and MCP `gutcheck_plan` all refuse remote targets; the report has no `cd` step for them.
- Renderer (jsdom): chip, filter, hidden panels.

## Docs

- `docs/sources.md`: GitHub's `diskUsage` field, `git clone --depth/--single-branch/--no-tags`, `GIT_LFS_SKIP_SMUDGE`, `protocol.*.allow`, and why each working-copy check is skipped.
- `CHANGELOG.md` under `## [Unreleased]`, a README section, and an `AGENTS.md` layout line for `remote-repos.js`.

## Not in part 1

Cloning into the workspace (roadmap item 4), API fixes (part 2), PR-based file fixes (part 3), and hosts other than GitHub.
