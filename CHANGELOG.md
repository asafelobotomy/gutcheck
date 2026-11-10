# Changelog

All notable changes to GutCheck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Add changes under **Unreleased**; `npm run bump -- patch|minor|major` turns that into a dated release, and CI publishes it with this section as the release notes.

## [Unreleased]

### Security

- Scanning a repo whose `.git/config` someone else wrote can no longer run their programs. A filter (`clean`, `process`) or diff (`textconv`) driver set in the repo's own config, or in a file it includes, is switched off for every git call a scan or a plan makes; a driver your own global config sets to the same value, such as git-lfs, still runs, while ones only the repo sets, such as git-crypt's, are off during scans. Scans also no longer check commit signatures (which ran `gpg.program`), `git blame` skips textconv, never look inside submodules (whose own config could run a filter), never fetch missing objects in a partial clone (which ran the repo's `uploadpack` or `sshCommand`; on git older than 2.44 a partial clone is refused), never fall back to a repo alias for `git lfs`, and never let the trusted git-lfs filter run a program the repo's config names for it (`lfs.extension.*`, `lfs.customtransfer.*`, `lfs.standalonetransferagent`, plus `core.askPass` and `credential.helper`). A repo whose `git status` then fails is reported as an error instead of looking clean. The `ext::` and `fd::` transports are blocked for scans and actions. If GutCheck cannot read a repo's drivers, it refuses the git call instead of running it unprotected. A submodule with uncommitted edits inside it no longer counts as a change in its parent; new commits in it still do.
- The deep scan's `npm outdated` no longer sees your environment: a repo's `.npmrc` could put a token such as `GH_TOKEN` into the registry URL, or route the request through its own proxy. npm now gets only PATH, HOME, locale, TMPDIR and `NODE_EXTRA_CA_CERTS`, the public registry, your own `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (or no proxy), and no scripts or logs.
- Push pushes only the current branch, to its upstream branch or `origin`, with one explicit refspec and no tags or submodules. Repo config can no longer turn it into a mirror push that deletes the remote's other branches, a forced push through `remote.origin.push`, or a push of tags (`push.followTags`) or submodules (`push.recurseSubmodules`), and a branch whose name looks like an option (`--mirror`) is refused.
- A cloned repo's own git config and refs can no longer turn GutCheck's actions against you. Branch and remote names that look like options (`--orphan=wipe`, `--mirror`) are refused everywhere. Fetch and Pull only update remote-tracking branches, so a repo's fetch settings cannot delete or overwrite local branches or tags. Fetch, Pull, Push and remote-branch deletion refuse a repo whose own config names programs for network commands (ssh command, credential helper, askpass, upload-pack, a remote helper or `vcs`) or whose remote is a local folder or `file://` URL (a local remote runs that repo's hooks). GutCheck's git steps never recurse into submodules, never sign commits (a note says so if you normally sign), and never run the repo's alternate-refs or signing-key commands or auto gc.
- Steps that would run the repo's own git hooks or filter drivers say so, are rated caution, and Fix all (and the overview's bulk fix) does not run them on its own: the app shows them unticked, and the CLI and MCP list them as held, without a token. This includes repos that keep hooks or git settings in their own files (`.husky`, a config included from the repo), since a branch can bring new ones. Before each change runs, GutCheck checks the repo again; if an earlier step such as a pull brought new hooks or settings, the change is held until you review it again.
- A remote counts as GitHub only when its host really is github.com (any common URL form); lookalike hosts and local paths no longer do.
- "Copy for LLM" only names plain file extensions in `git lfs track`, single-quoted, so a file name can no longer inject a shell command. Report commands leave out branch, folder and tag names that contain invisible characters instead of altering them, and report text drops zero-width, bidi and Unicode tag characters.
- A repo's own `.gutcheck.json` can no longer hide errors, security findings, your baseline drift, or uncommitted and unpushed work, and its wildcards need 4 characters before `*`. The report, CLI and MCP say who ignored each finding ("Ignored by you", "Ignored through an AI agent (MCP)" or "Ignored by the repo's own .gutcheck.json"); the repo's reasons are left out of the report. AI agents can no longer ignore errors or security findings. Every ignore needs 3 characters before `*`; older shorter rules are listed as not applied.
- Read-only mode now also blocks ignoring findings and creating a baseline, in the app, the CLI and MCP.
- The secrets CLI and backup preview escape control, bidi and other invisible characters in file names, so a folder name cannot send terminal escapes.
- Git 2.54's config-based hooks (`hook.<name>.command` and `.event`) in a repo's own config, or a file it includes, no longer run during scans or plan checks: they ran even with `core.hooksPath=/dev/null`. GutCheck now switches each one off with `hook.<name>.enabled=false` for every scan and plan git call; hooks in your own global or system config are left alone, like your own hook files. Plan previews name such a hook (name and event, never the command), and Fix all holds the step like any other repo hook.
### Added

- More GitHub Actions workflow checks. A public repo with a `pull_request_target` workflow gets a warning that GitHub blocks it by default from 2 December 2026 unless an Actions event policy allows it (advice only; the check retires in 2027). New warnings: `actions/checkout` without `persist-credentials: false` (info unless the job uploads artifacts; skipped when the job pushes), `secrets: inherit`, spoofable `github.actor == 'dependabot[bot]'` conditions, `ACTIONS_ALLOW_UNSECURE_COMMANDS`, GITHUB_ENV/GITHUB_PATH writes in privileged workflows that read untrusted text, retired runner labels (macos-13, ubuntu-20.04), and first-party actions still on Node 20 (removed from Actions on 23 September 2026). Script-injection now also covers `workflow_run` branch names and titles. Info: deprecated `::set-output`/`::save-state`, jobs without `timeout-minutes`, pull request workflows without `concurrency`. Each has a "Copy for LLM" step with its source.
- GitHub repository-settings checks (repos you administer): release tags with no active tag ruleset blocking deletion and force-push (`tag-protection`, warn), a read/write default Actions token (`actions-token-write`, warn), Actions allowed to approve pull requests (`actions-approve-prs`, warn), and an info hint when every action is SHA-pinned so GitHub can enforce it. Settings GitHub will not show are reported as unknown, not as off. New previewed actions `protect-tags` (additive tag ruleset, admin bypass kept) and `actions-settings` (read-only token, no PR approval), both rated caution, with steps in Copy for LLM. Sources in `docs/sources.md`.

- Secrets view: finds local dev secrets that have no backup anywhere else (untracked or ignored `.env` files, keys and credential files in your repos, loose `.env` files in the workspace folder, and dev credentials in your home folder such as SSH keys, `.npmrc`, `.aws/credentials` and `~/.kube/config`) and saves them to a password manager you link in the app: Proton Pass, 1Password, Bitwarden, KeePassXC, pass or gopass. Each file is `unbacked`, `changed`, `backed`, `skipped`, `missing` or `mismatch`; Verify checks the vault still holds them, and SSH keys are compared by fingerprint. Backup is plan, preview, apply, with the content sent on stdin only. GutCheck never deletes a file or a vault item and never handles a master password. Items are titled by scope (`gutcheck: repo <repo path>/<file>`, `gutcheck: home ~/<file>`, `gutcheck: root <file>`); pass and gopass names (and KeePassXC entries) percent-encode the title under an `@repo/`, `@home/` or `@root/` folder, so no two files share one. A file whose item belongs to another file that still exists is left out with a `skipped:` line (and `--backup --yes` exits 2); a backup whose file is no longer found (a renamed folder, an unmounted disk, a repointed dotfiles link) is never overwritten: the new file is saved as `<name>~<hash>` and the old item kept. Submodules, nested clones and in-repo worktrees are scanned as their own repos, so their committed files are never flagged; a repo git cannot list is reported as not checked. A plan is refused when the vault CLI sits inside a repo or the workspace; vault CLIs run from the home folder with a PATH that leaves out relative and workspace entries. A changed file is saved again: a new item in Proton Pass, 1Password and Bitwarden (the old one stays), the same item overwritten in pass and gopass, the attachment replaced in KeePassXC. Home credentials that are symlinks into a dotfiles folder are backed up from their target. `gutcheck secrets [--backup [--yes] | --verify | --skip <path> <reason>]` on the command line; over MCP, `gutcheck_secrets` is read-only and backups are refused. `~/.gnupg/private-keys-v1.d` is reported but must be exported by hand with `gpg`. Only Proton Pass has been tried against a live vault; the others are marked "untested with a live vault". Sources in `docs/sources.md`.
- The Tests review now looks after the test suite itself. It recommends consolidating near-identical tests into one parameterized test, test bodies copied between files, setup repeated across tests (a fixture or `beforeEach`), and many tiny test files for one module. It flags stale tests (skips and xfails left in for over 6 months, unless their reason names a platform or tool; non-strict xfail; tests untouched while their code changed a lot), unused ones (helpers and fixtures nothing uses, test files the runner never collects, imports of modules that no longer exist) and legacy ones (nose, APIs removed in Python 3.12 and Jest 30, Enzyme, golang/mock, two test runners in one project, snapshots left by deleted tests). Node, Python, Rust and Go. Each finding has a "Copy for LLM" step, and all of it shows in `gutcheck_tests` and the CLI. Ages come from `git blame` and `git log`; nothing runs.
- Clutter advice for test and script output that piles up. pytest temp folders with their own `--basetemp` names (`.tmp/pytest-main`, `.tmp/pytest-a88-side`) are now found, not just `pytest` and `pytest-of-*`. Two or more of them, or one of 1 GB or more, get a warning: pytest empties a `--basetemp` folder only when the next run uses the same name, so use one name and set `tmp_path_retention_policy = "failed"`. Twenty or more git-ignored logs, temp files and backups, or 50 MB of them, get advice to have whatever writes them clean up when it finishes. Both have "Copy for LLM" steps.
- Runtime end-of-life checks. GutCheck reads the Node, Python and Go versions a repo pins (`.nvmrc`, `.node-version`, `.python-version`, `.tool-versions`, `engines.node`, `requires-python`, the go.mod `toolchain` line, and the versions its workflows give setup-node, setup-python and setup-go) and compares them with a bundled, dated table (as of 2026-11-09; nothing is fetched during a scan). `runtime-eol` (warn) names each file and version that has ended and the lines still supported; `runtime-eol-soon` (info) covers the next 90 days. A lower-bound range, the go.mod `go` line, a matrix that also tests a supported version, and aliases such as `lts/*` are not flagged. Both have "Copy for LLM" steps.
- Drift checks. `lockfile-drift`: package-lock.json's root entry disagrees with package.json (warn when dependencies differ, since `npm ci` refuses to install; info when only name or version does; names only, never specifier values), with `npm install --package-lock-only --ignore-scripts` as the step. `version-drift` (warn): version fields differ across package.json, `src-tauri/tauri.conf.json`, `Cargo.toml` and `pyproject.toml` (inherited, `dynamic` and path-style versions are skipped). `cargo-lock-untracked` (info): a Rust binary crate (including `src-tauri`) whose Cargo.lock is not tracked. Sources in `docs/sources.md`.
- Unfinished git operations: a warning when a rebase, `git am`, merge, cherry-pick, revert or bisect is stopped part way (found from the marker files git's own prompt script reads, resolved with `git rev-parse --git-path` so linked worktrees are right). The fix previews `git <operation> --abort`, is rated dangerous (it discards any conflict resolution done so far, so you type the repo name) and is never part of Fix all, which only lists it, on "leave it". The report says to finish with `--continue` and to ask before aborting.
- Maintenance health: one info finding per repo when `git count-objects -v` shows more than 50 packs or 6,700 loose objects (git's `gc.autoPackLimit` and `gc.auto` defaults), a `.git/gc.log` from a failed automatic gc newer than `gc.logExpiry`, or no commit-graph on a history of 10,000+ commits. If the repo is not in your global `maintenance.repo`, the fix is `git maintenance register`, previewed with a note that it writes your global git config; it schedules nothing and Fix all never runs it. This replaces the old "loose git objects" finding (`git-loose`).
- Commit identity: one quiet info finding per repo when no email is configured (git would guess one) or when at least two of your last 50 commits, under your own name, use an email other than the configured one (GitHub noreply forms of one account do not count). The title shows only your configured email; the other addresses are in the detail. With several such repos, one workspace summary suggests `includeIf` blocks and `user.useConfigOnly=true`.
- AI agent config trust flags: a committed `.claude/settings.json` or `.mcp.json` that makes everyone who clones the repo run code or send data elsewhere is now reported, by shape only (key and server names, `sh -c`, scheme and host; never values, URLs or commands). Warnings for auto-approved MCP servers (`enableAllProjectMcpServers`, `enabledMcpjsonServers`), base-URL overrides in `env` (`ANTHROPIC_BASE_URL` and other `*_BASE_URL`), hooks that run commands, `apiKeyHelper` and `headersHelper`, `extraKnownMarketplaces`, MCP servers started through `sh -c` or `curl | sh`, and MCP servers over plain `http://` (not localhost). Info for `npx -y`/`uvx` packages without a pinned version, and for a `CODEOWNERS` file that leaves `.mcp.json` or `.claude/` without an owner. A repo's own `.gutcheck.json` cannot hide these. Files that are not committed are not checked. Each has a "Copy for LLM" step.
- Workspace advice for global package caches over 1 GB (npm, pnpm, uv, pip, cargo, Gradle, Go), with each tool's own prune command printed (`npm cache verify`, `pnpm store prune`, `uv cache prune`, `pip cache purge`, `go clean -cache`/`-modcache`). Sizes come from `du`; nothing is run or deleted. It shows in the app, `gutcheck workspace` and `gutcheck_workspace`.

### Changed

- Detached HEAD is info when every commit is also on a branch, tag or remote, a warning that counts the commits when some are held by nothing else, and is not reported during a rebase or bisect, which detach HEAD on purpose.

## [0.27.1] - 2026-11-08

### Changed

- Fix all asks before adding a licence, README, CODEOWNERS or CI workflow: these are the owner's call. A licence starts on "leave it", and GutCheck refuses to write one until `git config user.name` is set, instead of naming "Author".
- Setting up an LSP language server that installs for every user (`npm -g`, `dotnet --global`) or as root (`run0 pacman`) is now dangerous: you type the repo name. Installs run from your home folder, so a repo's `.npmrc` or `nuget.config` cannot choose the registry.
- "Copy for LLM" pulls before it commits, as Fix all does, and ends with a push for the commits its steps make.

### Fixed

- Fix all no longer stops at your commit after adding `.gitignore` rules: the changed `.gitignore` goes into that commit.
- A long Fix all (an install, a test run) no longer expires the later steps you already reviewed.
- Protecting a branch never replaces existing protection: it refuses when the scan saw protection or a ruleset, and checks again just before the change.
- Merging a PR merges only the commit that was scanned and previewed (`--match-head-commit`), and an approved PR is offered for merging only once its checks pass.
- Splitting CLAUDE.md keeps `@AGENTS.md` (and other agents' instruction files) as imports, and suggests `git checkout` as the undo only when the file has no uncommitted edits.
- Removing clutter reads each name literally, so a file named like a pattern (`a*b.tmp`) is no longer refused because of another file it would match.
- Rewriting a file (split, permission rules) keeps its permissions and never writes through a temp file someone placed.
- Connecting an agent no longer overwrites changes made to its config file after the preview, and writes through a symlinked config instead of replacing the link.
- "Copy for LLM" lists two failed runs of the same workflow as two steps.

## [0.27.0] - 2026-11-07

### Changed

- The app, the command line and the MCP server share one workspace scan, so they behave the same way.
- The command line remembers the last folder it scanned, separately from the app's.
- The app, the CLI and MCP use the same data folder, including when `GUTCHECK_DATA_DIR` is set.
- In Settings > AI agents, the "allow actions" choice is saved when you connect, not while you review.

### Fixed

- MCP: calls made while a scan is running wait for it to finish, instead of seeing only some of the repos.
- MCP: asking for another folder while a scan is running scans that folder, instead of returning the first one.
- Ignoring a finding in every repo, or creating a baseline, updates every repo straight away, in the app, the CLI and MCP.
- Only `gutcheck new` and scheduled scans use up "new since last scan". Running `findings`, `report` or other commands in between no longer hides what `new` should report.
- A repo whose scan failed, or whose GitHub data could not be fetched, keeps its previous findings, so they don't all come back as new later.
- Deep and normal scans are compared separately, so findings that only a deep scan finds are not reported as new.
- `gutcheck new --notify` notifies only about warnings and errors, as the app does.
- A scheduled scan replaces the app's old results (no deleted repos or stale clutter, quality or test results). It waits while a change is open for review, and a failed one no longer leaves the progress bar showing.
- A refused scan (no such folder, or one already running) no longer clears the results on screen.
- A change or ignore that finishes after a new workspace scan no longer puts a repo from the old workspace back.
- After a change, the repo is rescanned with the same depth (deep or not) as the scan it came from.
- Read-only mode turns off the live MCP server check in `gutcheck_agent_usage`, and blocks machine-level agent fixes in `gutcheck_apply`.

## [0.26.1] - 2026-11-07

### Fixed

- Code quality no longer shows the text of a TODO or FIXME comment that looks like it holds a credential, in the app, the report or MCP. The marker is still counted and located.
- Planning a test run no longer executes anything from the repo. Tools are looked up on disk, or checked from a neutral folder, so a repo's own `pytest.py`, virtualenv `python` or `node_modules/.bin/c8` cannot run before you approve. Only the approved run executes project code.
- "Copy for LLM": a clutter file name with a newline or backticks can no longer break out of a command block or add a step of its own. Such files are left out of the commands, and the report says why.
- A dangerous change now needs its repo name in the main process too, not only in the review dialog. With several dangerous changes, you type the name of each repo concerned, instead of "CONFIRM".
- When a change fails, the later changes for that repo are skipped (shown as skipped), so a failed pull is never followed by a commit and push. This applies in the app, `gutcheck fix <repo> all --yes` and MCP `gutcheck_apply`. Other repos carry on.
- Commit all refuses env files, private keys and credential files (`.env`, `*.pem`, `*.key`, `id_ed25519`, `.netrc`, and similar) and says how to ignore them. It also lists each file inside a new folder, so one added there after the preview stops the commit.
- Commit all no longer refuses when the first file in the preview was committed or reverted in the meantime.
- The `.gitignore` GutCheck adds, and the env rules it appends, keep `.env.example` committable (`!.env.example` after `.env.*`).

## [0.26.0] - 2026-11-07

### Added

- Agent context: how much CLAUDE.md, `.claude/CLAUDE.md` and AGENTS.md load into every session (KB and tokens, with `@`-imports and the largest sections), and a **Split** fix that keeps a core file and moves the largest sections to `docs/agents/` with pointers, keeping every line.
- LSP plugins: Claude Code's official LSP plugins missing or turned off for a repo's main languages, or their language server not on PATH, with a **Set up** fix (`claude plugin install` or `enable`, plus `npm`, `rustup`, `go`, `gem`, `dotnet` or `pacman` through `run0` for the server).
- Permission rules: one-off and token-like rules in `.claude/settings.local.json`, shown only as redacted shapes and hashes, with a **Remove** fix that backs up the file in GutCheck's data folder.
- Stale agent config files (GutCheck's own `.gutcheck.bak` after a week, temp files left by interrupted writes, GutCheck's old backups) with a **Move to trash** fix.
- **Review rules…** on permission findings: every rule in `.claude/settings.local.json` as a redacted shape; **Show** reads one value into that window only, on request (never saved, logged or reported); tick rules to remove them.
- MCP: `gutcheck_agent_usage` (starting servers needs `--allow-actions`), and machine-level fixes through `gutcheck_plan` with `{ agentFix }` and `gutcheck_apply`.
- **Agent usage and health** (Settings > AI agents > Check usage, or `gutcheck agents usage`): opt-in; reads only tool names from 28 days of transcripts, and with a second consent runs `claude mcp list` to test each MCP server. Unused plugins, skills and servers, failing or signed-out servers, and permission rules that never matched get fixes (turn off, remove, sign in).

### Added

- **Fix all issues** on each repo: every fix in one plan. A short wizard asks the choices only you can make (commit message, merge or close a PR, description, installs, test runs); then one review lists every step in coding order (pull, `.gitignore`, your commit, dependencies, new files, clean-up, push, GitHub settings, test runs), worst issues first within a step. Any step can be unticked. Also `gutcheck fix <repo> all`, and `{ repo, all: true, answers }` in `gutcheck_plan`.
- The review dialog numbers the steps and has a tick box on each when there are several.

### Changed

- The `.gitignore` GutCheck adds also ignores the caches of the languages the repo uses (Python, Gradle, Node coverage).
- Committing all changes still refuses if any file appeared since the preview, but goes ahead when there are fewer (for example after a `.gitignore` hid some).

## [0.25.0] - 2026-11-07

### Changed

- The sidebar holds every view, in one order (Dashboard, Workspace overview, Baseline, Code quality, Tests, Clutter & tidy-up, History), and highlights the one you are on. History moved there from the top bar.
- Shorter, plainer intros on the Code quality, Tests, Clutter and AI agents screens; "Rescan" everywhere; fix buttons all start with "Add".
- Dialogs name their action: Settings saves with **Save**, ignoring with **Ignore**.
- Pull requests read "checks passing · not reviewed" instead of raw GitHub values; clutter made today says "today".
- Clutter lists each repo's items first, then workspace and machine advice.

### Fixed

- Intro text no longer breaks in the middle of words, and heatmap column names are no longer cut off.
- The AI agents dialog no longer shows a stray "null", and History rows no longer end in a dangling "·".

## [0.24.2] - 2026-11-07

### Fixed

- Workspace overview: a group whose repos share the same title shows it as is ("1 workflow without a permissions block", "PR #7 has merge conflicts") instead of replacing every number with N. Titles whose numbers differ per repo still read "PR #N ...".

## [0.24.1] - 2026-11-07

### Added

- README: Ko-fi button, badges, feature summary and screenshots of a made-up demo workspace; `npm run screenshots` rebuilds them.

### Changed

- README, CONTRIBUTING and AGENTS.md brought up to date: every MCP tool, protection preset, file template and data file is listed.

## [0.24.0] - 2026-11-07

### Added

- Versioning: this changelog (back-filled from every release), `npm run bump` to move Unreleased into a new version and update `package.json` and `package-lock.json` together, release notes taken from the changelog, and a check that the version being released has a changelog entry.
- The app shows its version in the header and in Settings.

## [0.23.0] - 2026-11-07

### Added

- Dependency automation: workflows that auto-merge bot PRs without checking the update type, and ungrouped Dependabot updates once five or more of their PRs are open. The Dependabot template groups minor and patch updates and adds a 7-day cooldown.
- Release health: manifest version behind a release, a pushed bump that was never tagged, unreleased work on an old release, and a changelog missing the newest release.
- Ignore a finding with a reason (app, CLI, MCP with `--allow-actions`), per repo, for every repo, by prefix, or from a repo's `.gutcheck.json`.
- Baseline: `baseline.json` lists what every repo should have; drift is one finding per repo plus a Baseline view and `gutcheck drift`.
- Scheduled scans in the app, notifying only about new warnings and errors; `gutcheck new [--notify]` for cron or systemd timers.

## [0.22.0] - 2026-11-07

### Added

- Dependabot PRs the default branch has already overtaken are reported as superseded, with a close instead of a rebase.
- A failed CI run says when a newer run is already queued.

## [0.21.1] - 2026-11-07

### Fixed

- The `.gitattributes` template keeps Windows scripts CRLF.
- The Dependabot template adds no github-actions entry to repos without workflows.

## [0.21.0] - 2026-11-07

### Fixed

- Accurate fixes for the files GutCheck adds; no re-run offered for Dependabot Updates runs, which GitHub cannot re-run.

## [0.20.0] - 2026-11-07

### Fixed

- GutCheck run on itself: fixed what it got wrong, and its own findings.

## [0.19.0] - 2026-11-07

### Fixed

- Every finding checked against the real state of the workspace and GitHub, and the wrong ones fixed.

## [0.18.0] - 2026-11-07

### Fixed

- Fewer false alarms, from a real review of another project.

## [0.17.1] - 2026-11-06

### Fixed

- Agents connect through an unpacked copy, because AppImages cannot mount under `NoNewPrivs`.

## [0.17.0] - 2026-11-06

### Added

- Tests view: static review, existing coverage, JUnit and mutation results, and opt-in coverage and mutation runs.

## [0.16.0] - 2026-11-06

### Added

- Storage advice: where a big repo's space is, session-history cleanup, smarter logs and backups.

## [0.15.0] - 2026-11-06

### Added

- The clutter scan finds build output: cargo `target/`, `CACHEDIR.TAG` caches, pytest temp folders and packaged builds.

## [0.14.0] - 2026-11-06

### Added

- Settings > AI agents: connect GutCheck's MCP server to installed coding agents.

## [0.13.0] - 2026-11-06

### Added

- A command line and an MCP server for AI agents.

## [0.12.0] - 2026-11-06

### Added

- AI coding agent checks.

## [0.11.1] - 2026-11-06

### Fixed

- Honest previews, `~` paths, glob rulesets and spec-correct autostart.

## [0.11.0] - 2026-11-05

### Changed

- Checks aligned with GitHub's docs, OpenSSF Scorecard and git guidance.

## [0.10.1] - 2026-11-05

### Fixed

- Safer settings and actions, more accurate findings, UI races and accessibility.

## [0.10.0] - 2026-11-05

### Changed

- New logo, used for the window, tray and AppImage.

## [0.9.1] - 2026-11-05

### Fixed

- A false outdated-package report; quieter magic-number rule.

## [0.9.0] - 2026-11-05

### Added

- Launch on start-up, minimise to tray and close to tray.

## [0.8.0] - 2026-11-05

### Added

- Code quality checks: file length, magic numbers, constants and secrets.
- Releases happen automatically when the version is bumped on main.

## [0.7.1] - 2026-11-05

### Added

- Dashboard with an issue heatmap and trends over time (0.7.0).
- "Copy for LLM" report (0.6.0).
- Clutter cleaner and tidy-up advice (0.5.0).

### Fixed

- Review gaps closed, tech debt paid down, clutter removal and report output hardened (0.6.1 to 0.7.1).

## [0.4.1] - 2026-11-05

### Fixed

- Version bump only.

## [0.4.0] - 2026-11-05

### Added

- Direct actions with plan, preview and confirm.

## [0.3.0] - 2026-11-05

### Changed

- Hardened security and fewer GitHub API calls.

## [0.2.1] - 2026-11-05

### Fixed

- Test script on Node 22.

## [0.2.0] - 2026-11-05

### Added

- First release: health checks for every git repo in a folder.

[Unreleased]: https://github.com/asafelobotomy/gutcheck/compare/v0.27.1...HEAD
[0.27.1]: https://github.com/asafelobotomy/gutcheck/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/asafelobotomy/gutcheck/compare/v0.26.1...v0.27.0
[0.26.1]: https://github.com/asafelobotomy/gutcheck/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/asafelobotomy/gutcheck/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/asafelobotomy/gutcheck/compare/v0.24.2...v0.25.0
[0.24.2]: https://github.com/asafelobotomy/gutcheck/compare/v0.24.1...v0.24.2
[0.24.1]: https://github.com/asafelobotomy/gutcheck/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/asafelobotomy/gutcheck/compare/v0.23.0...v0.24.0
