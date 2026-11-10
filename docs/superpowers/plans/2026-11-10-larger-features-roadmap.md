# Larger Features Roadmap

> **For agentic workers:** each feature below becomes its own spec (`docs/superpowers/specs/`) and task-level plan before any code. Use superpowers:brainstorming for the spec, superpowers:writing-plans for the plan, then superpowers:subagent-driven-development to build it.

**Source:** `reports/GutCheck improvement opportunities.md` (research of 2026-11-10) and its notes in `research_notes/GutCheck improvement opportunities/`.

**Goal:** turn what GutCheck already knows about a workspace into things the user can recover from or act on: a copy of local-only work, a list of real vulnerabilities instead of an "alerts enabled" flag, safe cleanup of agent worktrees, a manifest that rebuilds the workspace, and opt-in integrity checks.

## Order and why

| # | Feature | Value | Effort | New risk surface |
|---|---|---|---|---|
| 1 | Local-only work report, then rescue bundle | High: this workspace already lost nothing only because every repo was checked by hand before a deletion (2026-11-09) | Medium | Writes files, but only into a folder the user picks |
| 2 | Vulnerability layer: alert counts, then opt-in OSV | High: GutCheck checks Dependabot is on but never says what it found | Medium | New API scopes; OSV sends dependency names out (opt-in) |
| 3 | Agent worktree cleanup | Medium-high: `.claude/worktrees/` is already in buckler and the-candidate, and agent tools leave stale and locked worktrees | Medium | Deletes worktrees, so the strictest rules here |
| 4 | Workspace manifest and restore | Medium: new-machine setup and "on GitHub but not cloned" | Medium | Clones repos (network, new folders) |
| 5 | Opt-in deep checks: integrity, LFS pointers, line endings | Medium-low: rare problems, slow to check | Low-medium | None new if every call goes through `ctx.safeGit` |

Order rule: features that **protect work** come before features that **add insight**, and both come before features that **add convenience**. 1 and 3 also share the "what exists only here" classifier, so 3 reuses 1's code.

## Rules every feature keeps

- Plan, preview, apply. Nothing deletes repos, rewrites history or force-pushes; no `--force` on anything that holds uncommitted work.
- Scans stay read-only and never run repo code. Every git call goes through `exec.git` (scans) or `ctx.safeGit` (plans and actions), so the repo's own drivers and config-defined hooks stay blanked.
- New network use is opt-in, named in Settings, and sends no repo contents. `npm test` stays offline (stub `gh` and HTTP the way existing tests do).
- No secret values, `.env` contents or settings values in findings, reports, bundles' manifests or logs.
- Files under 400 lines; sources in `docs/sources.md`; changelog under Unreleased; an accuracy test for each false alarm fixed.
- Each feature ships on all three surfaces (app, CLI, MCP) unless its spec says why not. MCP may read; writes over MCP follow the existing rules (refused where the secrets feature refuses them).

## 1. Local-only work report, then rescue bundle

**Phase 1a, the report (read-only, ships alone):** for each repo, list what exists only on this machine:
- branches with commits on no remote (`git rev-list <b> --not --remotes`, already used ad hoc),
- stashes (`git stash list`),
- untracked, not-ignored files (counts and total size, names on request),
- repos with no remote at all, and remotes whose fetch fails or whose upstream is gone.

Surfaces: a workspace column/badge ("3 repos hold local-only work"), `gutcheck local-only` in the CLI, `gutcheck_local_only` over MCP.

**Phase 1b, the rescue action (`rescue-bundle`):** writes into a folder the user chooses (default `~/GutCheck-rescue/<date>/<repo>/`):
- `local.bundle` from `git bundle create <file> --all --not --remotes` (fall back to `--all` when there is no remote), then `git bundle verify`;
- `stash-<n>.patch` from `git stash show -p --include-untracked stash@{n}` (verify the flag on the minimum supported git),
- `untracked.tar` of untracked, not-ignored files only, skipping anything the secrets scanner would classify as a secret (those belong in the Secrets backup), plus a `MANIFEST.txt` of paths and sizes, never contents of env files.

Risk: writes only outside the repo, never changes the repo. Preview lists every file and the total size; refuse when the destination is inside a repo or the workspace.

**Tests:** temp repos with unpushed branches, stashes with untracked files, no-remote repos; assert the bundle restores (`git clone local.bundle`) and that ignored files and secret-classified files are not copied.

**Verify first:** `git bundle create --all --not --remotes` behaviour with no remote refs; stash `--include-untracked` show support (git 2.32+?); gitolite and simplified.guide recipes cited in the report.

## 2. Vulnerability layer

**Phase 2a, alert counts (GitHub only, no new data leaves):** per repo, counts by severity of open Dependabot, code-scanning and secret-scanning alerts. Counts only; never secret values or alert bodies. Handle 403/404 (scope or feature off) as "not readable", not as zero.
- Confirm endpoints and scopes at docs.github.com before building: `GET /repos/{o}/{r}/dependabot/alerts?state=open`, `.../code-scanning/alerts?state=open`, `.../secret-scanning/alerts?state=open` (the research listed these from memory).

**Phase 2b, OSV (opt-in, off by default):** parse lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `uv.lock`, `poetry.lock`, `go.sum`/`go.mod`, Gradle lockfiles if present) into `(ecosystem, name, version)` and call OSV `POST /v1/querybatch`.
- Exclude path, git and private-registry dependencies; never send repo names or paths.
- Mark dev versus prod dependencies where the lockfile says so, and group findings per package with the fixed version.
- Cache responses per lockfile hash for a day.
- Fix: printed upgrade commands only (they run package managers), plus "Copy for LLM" steps.

**Tests:** fixture lockfiles for each ecosystem, a stubbed OSV server, the opt-out path (no request at all when off).

**Verify first:** OSV request schema and ecosystem names (`npm`, `PyPI`, `crates.io`, `Go`, `Maven`), batch size limits, the "no rate limit" claim (https://google.github.io/osv.dev/api/).

## 3. Agent worktree cleanup

Classify every linked worktree (`git worktree list --porcelain`):
- **clean and merged:** no changes, HEAD reachable from a remote branch or the default branch;
- **clean, unmerged:** commits exist only here (route to feature 1);
- **dirty:** uncommitted changes;
- **locked:** `locked` reason, and whether the locking process is still alive when the reason names a PID;
- **prunable:** folder gone.

Fixes: `worktree-prune` already exists for prunable; add `worktree-remove` for **clean and merged only**, one worktree per step, never `--force`, never a loop that continues after a failure. Dirty and unmerged worktrees get "rescue first" advice that links to feature 1. Locked worktrees with a live process are never touched. Also flag a leftover `extensions.worktreeConfig` with no worktrees using it (Claude Code issue #45645), as advice.

Why this order: the Mergify incident (about 29 worktrees with uncommitted work deleted by a `--force` loop) is the failure to design against; the classification from feature 1 makes "only here" detection reliable.

**Tests:** temp repos with each worktree class, including a locked one with a dead PID and one with a live PID (the test process's own).

## 4. Workspace manifest and restore

- `gutcheck manifest` writes `gutcheck-workspace.json` (or YAML) at the workspace root: each repo's folder, remotes (URLs as configured, credentials stripped), default branch, and optional group tags. No local paths outside the workspace and no tokens.
- Report "listed but missing here" and "here but not listed".
- With `gh`, report "on your GitHub account but not cloned" (respecting archived and forks filters).
- Restore: a plan with one `git clone` per missing repo into its listed folder; clones go through `ctx.safeGit`, never run hooks, and refuse `file://`, `ext::` and local-path remotes (the existing remote safety rules).

**Tests:** manifest round-trip, credential stripping (`https://user:token@host` → `https://host`), refusal of unsafe remotes, restore into an empty temp workspace from local bare repos via GutCheck's test-only transport allowance (or stub).

**Verify first:** how gita, mani and ghq structure their manifests (cited in the research) so the format is familiar.

## 5. Opt-in deep checks

One `deep-integrity` action per repo (like `tests-run`, opt-in and per repo):
- `git fsck --connectivity-only --no-dangling`, `git commit-graph verify`, and `git refs verify` when git supports it (version-gate on `git --version`);
- LFS pointers left unsmudged: tracked files under 1024 bytes starting with `version https://git-lfs.github.com/spec/v1`, read from the work tree only;
- mixed or CRLF text files from `git ls-files --eol` (`i/mixed`, `i/crlf` where `.gitattributes` does not ask for CRLF).

Fixes stay advice: `git lfs pull` printed only; `git add --renormalize` printed with a warning that it makes a large commit and changes blame. Never `git lfs fsck` without `--dry-run`.

**Verify first:** whether `git ls-files --eol` and `git refs verify` are read-only and filter-free under `ctx.safeGit`; the git release that added `refs verify`.

## Open questions for the user

1. Rescue destination default: inside `~/GutCheck-rescue/` or the Secrets backup's password manager for small repos?
2. Should OSV ever run on a schedule, or only on demand?
3. Manifest format: JSON (matches `.gutcheck.json`) or YAML (matches mani)?
