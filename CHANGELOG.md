# Changelog

All notable changes to GutCheck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Add changes under **Unreleased**; `npm run bump -- patch|minor|major` turns that into a dated release, and CI publishes it with this section as the release notes.

## [Unreleased]

### Security

- Scanning a repo whose `.git/config` someone else wrote can no longer run their programs. A filter (`clean`, `process`) or diff (`textconv`) driver set in the repo's own config, or in a file it includes, is switched off for every git call a scan or a plan makes; a driver your own global config sets to the same value, such as git-lfs, still runs, while ones only the repo sets, such as git-crypt's, are off during scans. Scans also no longer check commit signatures (which ran `gpg.program`), `git blame` skips textconv, never look inside submodules (whose own config could run a filter), never fetch missing objects in a partial clone (which ran the repo's `uploadpack` or `sshCommand`; on git older than 2.44 a partial clone is refused), and never fall back to a repo alias for `git lfs`. The `ext::` and `fd::` transports are blocked for scans and actions. If GutCheck cannot read a repo's drivers, it refuses the git call instead of running it unprotected. A submodule with uncommitted edits inside it no longer counts as a change in its parent; new commits in it still do.
- The deep scan's `npm outdated` no longer sees your environment: a repo's `.npmrc` could put a token such as `GH_TOKEN` into the registry URL, or route the request through its own proxy. npm now gets only PATH, HOME, locale, TMPDIR and `NODE_EXTRA_CA_CERTS`, the public registry, your own `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (or no proxy), and no scripts or logs.
- Push pushes only the current branch, to its upstream branch or `origin`, with one explicit refspec and no tags or submodules. Repo config can no longer turn it into a mirror push that deletes the remote's other branches, a forced push through `remote.origin.push`, or a push of tags (`push.followTags`) or submodules (`push.recurseSubmodules`), and a branch whose name looks like an option (`--mirror`) is refused.

### Added

- Secrets view: finds local dev secrets that have no backup anywhere else (untracked or ignored `.env` files, keys and credential files in your repos, loose `.env` files in the workspace folder, and dev credentials in your home folder such as SSH keys, `.npmrc`, `.aws/credentials` and `~/.kube/config`) and saves them to a password manager you link in the app: Proton Pass, 1Password, Bitwarden, KeePassXC, pass or gopass. Each file is `unbacked`, `changed`, `backed`, `skipped`, `missing` or `mismatch`; Verify checks the vault still holds them, and SSH keys are compared by fingerprint. Backup is plan, preview, apply, with the content sent on stdin only. GutCheck never deletes a file or a vault item and never handles a master password. Items are titled `gutcheck: <repo path>/<file>`; pass and gopass names (and KeePassXC entries) percent-encode the title, so no two files share one. A plan is refused when two files would get the same item, and when the vault CLI sits inside a repo or the workspace; vault CLIs run from the home folder with a PATH that leaves out relative and workspace entries. A changed file is saved again: a new item in Proton Pass, 1Password and Bitwarden (the old one stays), the same item overwritten in pass and gopass, the attachment replaced in KeePassXC. Home credentials that are symlinks into a dotfiles folder are backed up from their target. `gutcheck secrets [--backup [--yes] | --verify | --skip <path> <reason>]` on the command line; over MCP, `gutcheck_secrets` is read-only and backups are refused. `~/.gnupg/private-keys-v1.d` is reported but must be exported by hand with `gpg`. Only Proton Pass has been tried against a live vault; the others are marked "untested with a live vault". Sources in `docs/sources.md`.
- The Tests review now looks after the test suite itself. It recommends consolidating near-identical tests into one parameterized test, test bodies copied between files, setup repeated across tests (a fixture or `beforeEach`), and many tiny test files for one module. It flags stale tests (skips and xfails left in for over 6 months, unless their reason names a platform or tool; non-strict xfail; tests untouched while their code changed a lot), unused ones (helpers and fixtures nothing uses, test files the runner never collects, imports of modules that no longer exist) and legacy ones (nose, APIs removed in Python 3.12 and Jest 30, Enzyme, golang/mock, two test runners in one project, snapshots left by deleted tests). Node, Python, Rust and Go. Each finding has a "Copy for LLM" step, and all of it shows in `gutcheck_tests` and the CLI. Ages come from `git blame` and `git log`; nothing runs.

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
