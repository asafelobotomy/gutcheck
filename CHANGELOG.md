# Changelog

All notable changes to GutCheck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Add changes under **Unreleased**; `npm run bump -- patch|minor|major` turns that into a dated release, and CI publishes it with this section as the release notes.

## [Unreleased]

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

[Unreleased]: https://github.com/asafelobotomy/gutcheck/compare/v0.24.1...HEAD
[0.24.1]: https://github.com/asafelobotomy/gutcheck/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/asafelobotomy/gutcheck/compare/v0.23.0...v0.24.0
