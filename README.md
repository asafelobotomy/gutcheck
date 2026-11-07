# GutCheck

<p align="center"><img src="src/assets/logo.svg" width="128" alt="GutCheck logo: a check mark made of intestine"></p>

A desktop dashboard that gives you a health check across every GitHub project in a folder. It is built on the [`gh` CLI](https://cli.github.com) and `git`, so it uses your existing GitHub login and never handles tokens itself.

## What it checks

- **CI**: failing workflow runs on the default branch
- **Pull requests**: conflicts, failing checks, stale PRs, approved and mergeable PRs. A Dependabot PR the default branch has already overtaken (every package it bumps is at or past its target in the lockfiles, same ecosystem) is reported as superseded, with a close instead of a rebase. A failed CI run says when a newer run is already queued
- **Branches**: uncommitted or unpushed work, behind upstream, merged and stale branches
- **Licence and docs**: LICENSE (an error only for public repos), README (and whether it says how to install or use the project), `.gitignore`, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, PR template. Files are found where GitHub looks (`.github/`, the root, `docs/`), and defaults from your account's `.github` repository count.
- **Project setup**: CHANGELOG or GitHub releases for tagged versions, `.gitattributes`, `.editorconfig`, pinned Node/Python version, and for public repos CODEOWNERS, issue templates and topics
- **Actions security**: script injection (`${{ github.event... }}` inside `run:`), `pull_request_target`/`workflow_run` that check out PR code, missing or `write-all` permissions, actions not pinned to a commit SHA, self-hosted runners on public repos, Dependabot not updating actions. Workflow files are read as text, never run.
- **Git hygiene**: credentials or `http://` in the remote URL, stash pile-ups, branches whose upstream was deleted, stale worktrees, uninitialised submodules, repos nested inside repos, repository size (GitHub's 1 GB / 5 GB guidance), loose objects, and with Deep scan files of 50 MB+ anywhere in history. For a repo over 1 GB, Deep scan also shows where the space is: current files, older versions, deleted files and unreferenced objects. It says whether rewriting history would actually help, and gives the safe steps (Git LFS for new versions, archives out of git) before any rewrite. GutCheck never rewrites history itself; a rewrite is listed only as an option for the owner, with a backup first
- **Security features** (repos you administer): secret scanning, push protection, CodeQL default setup (only suggested where CodeQL has a supported language, or workflows to analyse) and private vulnerability reporting on public repos; Dependabot security updates everywhere
- **Dependencies**: missing lockfiles, uninstalled packages (with the right package manager), Dependabot alerts, outdated npm packages (Deep scan). Dependabot alerts show the true total (not only the first page GitHub returns), a severity breakdown, the packages with the most alerts and the fixed versions, with commands for the ecosystems the repo uses
- **Dependency automation**: a workflow that auto-merges Dependabot or Renovate PRs without checking the update type (so majors merge unreviewed), and Dependabot updates that are not grouped once five or more of their PRs are open at once. The Dependabot file GutCheck adds groups minor and patch updates and waits seven days before proposing a new release (`cooldown`); security updates are never delayed
- **Releases**: the newest version tag (`v1.2.3` or `1.2.3`, pre-releases ignored) compared with the version in `package.json`, `Cargo.toml` or `pyproject.toml` (behind a release, or bumped and never tagged once pushed; GitHub's latest release counts, so a tag CI made but you have not fetched is not reported), five or more commits on a release older than 90 days, and a versioned changelog that skips the newest release
- **Repo settings**: missing remote, unprotected default branch (branch protection or an active ruleset both count), auto-delete of merged branches, inactivity. Private repos on a free plan are not told to protect their branch: GitHub only offers that on a paid plan or public repos (checked once per owner with a read-only call). A failed GitHub "Dependabot Updates" run is a warning, not a broken build
- **AI coding agents** (when Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI or Copilot is installed): per repo, a committed `.claude/settings.local.json`, credentials written into `.mcp.json`, CLAUDE.md or AGENTS.md over 200 lines, CLAUDE.md and AGENTS.md drifting apart, rules only one tool reads, and repos agents work in without instructions. For the machine: how much session history is kept, how much of it is older than 7 and 14 days, and the `cleanupPeriodDays` value that would clear it (set it from the advice or **Settings > AI agents**, previewed like any other change), the KDE file indexer watching agent folders, no cap on parallel subagents on a small machine, and many enabled plugins. Transcripts are only measured, never opened, and no setting value appears in a finding.
- **Workspace**: loose files, projects without git (code, or folders of notes), copies and duplicate clones, naming, missing global git email or gitignore, plain-text credential storage, and disk used by dependency folders of projects untouched for 90 days

Where the advice comes from (GitHub docs, OpenSSF Scorecard, git documentation and community conventions) is listed in [docs/sources.md](docs/sources.md). The Copy for LLM report links the source next to each fix.

Each repo gets a grade (A to D). A workspace overview groups the same issue across repos into ranked recommendations.

## Actions

Everything is done from the repo view, or in bulk from the workspace overview ("Fix all N"). Before anything runs, GutCheck shows the **exact commands** in a review dialog, and only those commands run. Dangerous actions make you type the repo name.

| Area | Actions |
|---|---|
| Branches | create, switch, merge (fast-forward only or merge commit), delete merged, delete (force needs confirmation), delete on GitHub, push, pull, fetch & prune |
| Commits | commit all changes (with a preview of the files) |
| Pull requests | open, merge (squash / merge / rebase, optionally delete the branch), close, mark ready |
| CI | re-run failed jobs |
| Protection and security | protect the default branch (Basic or Strict preset), remove protection, enable Dependabot alerts, security updates, secret scanning |
| Repo settings | edit description, auto-delete merged branches, archive |
| Clutter | move detected clutter to the trash (regenerable caches are deleted), append known-safe rules to `.gitignore` |
| Files | add LICENSE, README, .gitignore, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, PR template, dependabot.yml, a Node CI workflow for npm projects with a lockfile, on the repo's default branch (optionally committed) |

Safety rails: a **Read-only** switch in the header disables every action, every change is recorded in **History**, many actions show an undo command, and GutCheck never deletes repos, changes visibility, force-pushes or rewrites history.

## Dashboard

After a scan GutCheck opens on a **Dashboard**: KPI cards (average health, errors, warnings, open PRs, failing CI, uncommitted and unpushed work, high-severity alerts, merged and stale branches, local-only repos, missing licences, reclaimable clutter) and charts for grade distribution, issues by category, repo activity, open PR age, health per repo and clutter size per repo. Click a repo bar, an attention row or a card to drill in. It is computed from the scan you already have, so it makes no extra GitHub calls; the clutter numbers appear once you run a clutter scan from the dashboard.

An **issue heatmap** shows repos against problem categories (darker means more issues, colour is the worst severity). **Trends** show average health, errors and warnings, and clutter size across scans, and the cards show the change since the previous scan, plus the repos whose score moved most. GutCheck keeps one small snapshot per scan (scores and totals only, no paths or file names) in `trend.json` in its app data folder, scoped per workspace folder, capped at 365 snapshots; scans within 10 minutes of each other replace one another. Delete the file to reset the history.

## Code quality

The **Code quality** view runs read-only checks on the source of every scanned repo (it respects `.gitignore` and skips `node_modules`, build output, lockfiles, minified and generated files):

- **File length (LOC)**: files over your limit (HTML under `docs/` is treated as documentation and not flagged). The default is **400 lines**; change it, choose to count all lines or only code lines (no blanks or comments), and add ignore rules (`legacy/`, `*.generated.ts`, or part of a path) in the form at the top of the view. Settings are validated (20 to 20000) and saved.
- **Magic numbers**: bare numeric literals in non-test code for JavaScript/TypeScript, Python, Go, Rust, Java, Kotlin, C/C++, C#, PHP, Swift, Ruby and shell. Strings, comments and regexes are ignored, as are `0, 1, 2, 10, 100, 0.5`, constant definitions (`MAX_X = 5`), array indices, imports and data tables. Numbers whose context names them are also skipped, following ESLint's `no-magic-numbers` options:
  - keyword arguments and object properties (`limit=50`, `{ timeout: 30 }`)
  - default values (`def f(timeout: float = 30.0)`)
  - string-keyed assignments (`cfg["days"] = 7`)
  - slice bounds (`s[:80]`)
  - HTTP status codes in an HTTP context

  Python follows ruff's [PLR2004](https://docs.astral.sh/ruff/rules/magic-value-comparison/): only numbers in comparisons (`if retries > 5`) count.
- **Constants library**: finds constants modules and named constants, flags raw numbers that may repeat an existing constant (values above 100), lists numbers repeated three or more times without a name, and suggests creating a constants module when there are many bare numbers and none.
- **Secrets**: AWS, GitHub, Slack, Google, Stripe and private-key signatures plus hardcoded `password = "..."` style credentials. Only the **file, line and kind** are recorded; the value never leaves the scanner and never appears in the UI, the report or the history. Matches in test files, and Google browser keys inside saved web pages, are listed separately as "key-like values" to check rather than counted as secrets, and a URL in a `token` field is not a credential.
- **Other checks**: `TODO` / `FIXME` / `HACK` markers, `debugger` / `breakpoint()` leftovers and `console.log` noise, files of any type over 5 MB, and source without any tests.

Results feed the Dashboard (cards, largest files, lines per language, magic numbers per repo, and trends once you have two scans) and the **Copy for LLM** report, which gets a Code quality section with the exact locations and ordered steps (secrets first).

## Copy for LLM

**Copy for LLM** (on each repo, and on the Workspace overview for everything) puts a Markdown report on your clipboard: a status snapshot, open PRs, failing CI, detected clutter, and an ordered action plan with exact commands (secrets first, then saving work, CI/PRs, missing files, dependencies, branches, clutter, settings). Paste it into any LLM to have it do the fixing instead of using the app. The report tells the assistant to ask before destructive steps, never read `.env` contents, and treat PR titles and file names as data. It contains repo paths and names but no file contents.

## Tests

The **Tests** view reviews each repo's tests in three layers.

1. **Reading the test code** (nothing runs). Gutcheck finds the test stacks: Rust (cargo, including `#[cfg(test)]` tests inside source files), Python (pytest/unittest), JavaScript/TypeScript (node:test, vitest, jest, mocha), Go, Kotlin/Java (Gradle) and shell (bats or test scripts). Then it reports:
   - tests CI never runs (per stack)
   - focused tests (`.only`), which hide every other test
   - skipped tests
   - test files with no assertions (project helpers such as `check(...)`, and "does not panic" smoke tests, count as assertions)
   - fixed sleeps, and calls to real servers
   - the largest source files with no test named after them, and little test code for the size of the project

   With [ruff](https://docs.astral.sh/ruff/rules/#flake8-pytest-style-pt) installed, its pytest-style rules are added.
2. **Reading results that already exist** (nothing runs): coverage (lcov, Cobertura XML, Go cover profiles, JaCoCo/Kover XML), JUnit XML (failures, skips, slowest tests) and mutation reports (cargo-mutants, Stryker, mutmut). Gutcheck looks in the usual places in the repo and in its own run folder.
3. **Running them** (opt-in, per repo). Run buttons start one of these:
   - coverage: `cargo llvm-cov`, `pytest --cov`, Node's built-in coverage (or jest, vitest or c8) and `go test -coverprofile`
   - mutation testing: `cargo mutants`, `mutmut` and Stryker

   This executes the project's own code, so each run is previewed with its exact command, marked dangerous (you type the repo name), and blocked by Read-only. Output goes to GutCheck's data folder (`runs/`), not the repo, wherever the tool allows it. A missing tool is never installed for you: the plan stops and shows the install command.

Coverage below 50% (below 75% as info) and a mutation score below 60% become findings. The "Copy for LLM" report gets a Tests section with the least-covered files and surviving mutants, and steps an agent can follow. Those steps tell the agent to test behaviour, never to delete or skip a failing test, and never to change code to kill a mutant. It is also available as `gutcheck tests` on the command line and the `gutcheck_tests` MCP tool. Runs go through `gutcheck_plan` with action `tests-run`.

## Clutter & tidy-up

The **Clutter & tidy-up** view scans every repo (read-only) for things nothing needs:

- **Env files**: backups and copies (`.env.bak`, `.env (1)`, `.env.2024-01-02`), env files identical to another in the same folder, empty ones, and `.env.test` in repos with no tests. Templates such as `.env.example` are never flagged. Env files are only compared by checksum; their contents are never kept.
- **Caches and test output**: `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `coverage/`, `htmlcov/`, `test-results/` and similar.
- **Build output** (listed with its real size, never pre-selected because it takes time to rebuild): folders tagged with `CACHEDIR.TAG` (the [Cache Directory Tagging](https://bford.info/cachedir/) marker that cargo writes into `target/`), Rust `target/` beside a `Cargo.toml`, pytest temp folders under `.tmp/`, and electron-builder `dist/`/`build/` output. Virtualenvs are left to the disk-space advice.
- **Temp, backup and junk files**: `*.tmp`, `*.bak`, `*.orig`, swap files, `.DS_Store`, `Thumbs.db`, package-manager crash logs, and `name (1).ext` / `name copy.ext` copies (exact copies rate higher than diverged ones). Logs, temp files and backups that git ignores are judged by age: untouched for 14 days (30 for backups) is high confidence, newer ones may still be in use. Logs git does not ignore stay low confidence, because they may be kept on purpose.
- **Organisation advice**: committed or un-ignored `.env` files, missing `.env.example`, clutter missing from `.gitignore` (one-click append), several lockfiles, split `test`/`tests` or `doc`/`docs` folders, loose files and media in the repo root, plus workspace-level hints (projects without git, `foo-old` next to `foo`, the same remote cloned twice, inconsistent naming).

Files tracked by git are never offered for removal. Removal shows every item first; env files need you to type the repo name, and anything that is not a regenerable cache goes to your trash rather than being deleted. Only high-confidence items are pre-selected.

## Command line and MCP server (for AI agents)

GutCheck also runs without its window, so any coding agent (Claude Code, Claude Desktop, Cursor, Codex and others) can use its scans, report and actions through one set of tools instead of piecing together `git` and `gh` commands.

**Connect from the app.** Open **Settings > Connect an AI agent…**. GutCheck lists Claude Code, Codex CLI, Claude Desktop, Cursor, VS Code (Copilot) and Gemini CLI, shows which are installed and already connected, and connects each with that tool's own method:

- Claude Code and Codex: their `mcp add` command. Claude Code is found on your PATH, or inside Claude Desktop if it is bundled there.
- The others: a merge into their MCP config file. Other servers and settings are kept, and the original is backed up once as `<file>.gutcheck.bak`.

The exact command or JSON is shown before anything runs, the change is recorded in History, and **Disconnect** removes only GutCheck's entry. A config file that is not plain JSON (VS Code allows comments) is never rewritten; you get the snippet to paste instead. **Copy** puts the command or snippet on the clipboard for any agent, and the switch at the top chooses read-only or `--allow-actions`.

**Why it unpacks itself.** Agents started by Claude Desktop (and other sandboxed hosts) run with `NoNewPrivs`, which blocks `fusermount`, so an AppImage cannot mount there. Its runtime's FUSE-free mode prints file names to standard output, which breaks MCP. So when you connect from the AppImage, GutCheck first unpacks itself once into its data folder (`mcp-app/<version>/`, about 400 MB) and registers that copy. After updating GutCheck, the agent shows **Update needed**: press **Update** to unpack the new version and repoint the agent. Agents need a new session to see a newly added server.

**MCP server.** To set it up by hand, add GutCheck to your agent as a stdio MCP server. It starts **read-only**; add `--allow-actions` to let the agent plan and apply fixes. If your agent runs under `NoNewPrivs` (Claude Desktop does), point it at an unpacked copy (`GutCheck.AppImage --appimage-extract`, then `squashfs-root/gutcheck --mcp`) rather than the AppImage.

```bash
claude mcp add --transport stdio --scope user gutcheck -- /path/to/GutCheck.AppImage --mcp                    # Claude Code, read-only
claude mcp add --transport stdio --scope user gutcheck -- /path/to/GutCheck.AppImage --mcp --allow-actions    # Claude Code, can fix
```

For other clients, add the same command to their MCP config. For Claude Desktop (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`) and Gemini CLI (`~/.gemini/settings.json`):

```json
{ "mcpServers": { "gutcheck": { "command": "/path/to/GutCheck.AppImage", "args": ["--mcp"] } } }
```

For VS Code, the user `mcp.json` uses `servers` and needs a type: `{ "servers": { "gutcheck": { "type": "stdio", "command": "...", "args": ["--mcp"] } } }`.

For Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.gutcheck]
command = "/path/to/GutCheck.AppImage"
args = ["--mcp"]
```

From a source checkout, use `node /path/to/gutcheck/src/cli.js mcp` as the command instead.

| Tool | What it does |
|---|---|
| `gutcheck_overview` | Scan a folder (or reuse the last scan) and list repos worst first, with grade, score, error and warning counts and git state. Scans on first use; sends progress per repo. |
| `gutcheck_findings` | Every finding, filtered by repo, minimum severity or category, each with its automatic fix if it has one |
| `gutcheck_repo` | One repo in full: branches, PRs, failed CI runs, findings |
| `gutcheck_report` | The "Copy for LLM" fix plan in Markdown, for one repo or the workspace |
| `gutcheck_clutter`, `gutcheck_quality` | The clutter and code-quality scans |
| `gutcheck_workspace` | Workspace and machine advice, including AI agent settings |
| `gutcheck_actions` | Every action and its parameters |
| `gutcheck_plan` | Turn `{ repo, finding }` (the finding's own fix) or `{ repo, action }` into exact commands, with a single-use token. Changes nothing. |
| `gutcheck_apply` | Run planned tokens exactly as previewed; dangerous plans also need the repo name |
| `gutcheck_history` | Changes GutCheck has made, from the app, the CLI or an agent |
| `gutcheck_new` | Findings that were not there at the previous scan |
| `gutcheck_drift` | Every repo compared with your baseline, per rule |
| `gutcheck_ignore` | Ignore a finding with the user's reason, or stop ignoring it (needs `--allow-actions`) |

The same safety rails apply as in the app. Changes always go plan, then apply, and only the previewed commands run. Tokens are single use and expire after 5 minutes. The app's **Read-only** switch stops the server too, and the server never changes it. GutCheck never deletes repos, changes visibility, force-pushes or rewrites history. Secret values and `.env` contents never appear in results, and every change is recorded in **History**.

**Command line.** Run `GutCheck.AppImage --cli <command>` (or `node src/cli.js <command>` from a checkout, or `npm link` for a `gutcheck` command):

```bash
gutcheck scan ~/Projects                 # repos worst first
gutcheck findings --severity warn        # warnings and errors, with the fix command for each
gutcheck report my-repo                  # the Markdown fix plan
gutcheck fix my-repo git-dirty message="Save work"         # preview the exact commands
gutcheck fix my-repo git-dirty message="Save work" --yes   # run them
gutcheck new --notify                    # only what is new since the last scan, as a desktop notification
gutcheck ignore my-repo no-topics "internal tool"           # accept a finding, with the reason
gutcheck baseline init && gutcheck drift                    # what every repo should have, and who differs
gutcheck --help
```

The CLI and the server share the app's data folder, so they use the same settings (workspace folder, Read-only switch, quality settings), History and trends. Each CLI command scans again, but the MCP server keeps its scan between calls.

## Ignoring findings

Not every finding fits every repo. **Ignore…** on a finding (or `gutcheck ignore <repo> <finding> <reason>`) asks why, then takes it out of the score, the dashboard and the report; it stays listed under **Ignored** with your reason, and **Stop ignoring** brings it back. Tick **Ignore it in every repo** (`--all`) for findings you never want. A finding id ending in `*` covers a family (`pr-stale-*`). Ignores live in `ignores.json` in GutCheck's data folder, keyed by `owner/name`, so they survive a fresh clone. A repo can also carry its own in `.gutcheck.json` (`{ "ignore": { "no-topics": "internal tool" } }`), which everyone who scans it shares. The "Copy for LLM" report lists ignored findings and their reasons so an agent does not suggest them again. Every ignore is recorded in History, and agents can only ignore through an MCP server started with `--allow-actions`.

## Baseline

A baseline says what every repo should have. **Baseline** in the sidebar (or `gutcheck baseline init`) writes a starting `baseline.json` in GutCheck's data folder; edit its `require` list (add `:public` to a rule for public repos only) and `skip` (repos exempt from a rule). Rules: `license`, `readme`, `gitignore`, `security-policy`, `contributing`, `code-of-conduct`, `codeowners`, `editorconfig`, `gitattributes`, `changelog`, `ci`, `actions-pinned`, `dependabot`, `dependabot-groups`, `dependabot-cooldown`, `agents-file`, `branch-protection`, `auto-delete`, `secret-scanning`, `private-reporting`, `description`. Each repo that differs gets one "Baseline" finding, and the view (or `gutcheck drift`) shows each rule with the repos missing it. Rules that cannot apply (protection on a free private repo, Dependabot without manifests) are not counted.

## Startup, tray and scheduled scans

**Settings** (top bar) has these startup, tray and schedule options, all off by default:

- **Launch when I log in**: starts GutCheck at login, straight into the tray with no window. On Linux this writes `~/.config/autostart/gutcheck.desktop` (pointing at the AppImage you ran, so keep it in a stable place); on Windows and macOS it uses the system login items. Turning it off removes the entry.
- **Minimise to the system tray**: minimising hides the window; click the tray icon to bring it back.
- **Closing the window keeps GutCheck running in the tray**: use **Quit** in the tray menu to exit.
- **Scan on a schedule**: while GutCheck runs (in the tray is enough), it rescans the last workspace every hour to every week, and shows a desktop notification only when warnings or errors appear that the previous scan did not have. Without the app, run `gutcheck new --notify` from cron or a systemd timer: it prints only new findings and notifies through `notify-send`. Only finding ids are stored between scans (`seen.json`).

The tray icon toggles the window on click and has Show and Quit. Only one copy runs: launching GutCheck again shows the existing window. If your desktop has no system tray (some GNOME setups need a tray extension), GutCheck never hides its window, so it can't get lost.

## Install

Download the AppImage from the [latest release](../../releases/latest), then:

```bash
chmod +x GutCheck-*.AppImage
./GutCheck-*.AppImage
```

Requires `gh` and `git` on your `PATH`, and `gh auth login` completed.

## API usage and privacy

- GitHub data for all repos in a scan is fetched with batched GraphQL queries (10 repos per query), plus one REST call per repo that has workflows. Results are cached in memory for 2 minutes and never written to disk.
- Remaining quota is shown in the header. When it runs low, GutCheck stops making calls instead of hitting the limit.
- The only network access is through your own `gh` CLI. There is no telemetry, no updater and no other server. The UI is sandboxed with a strict Content Security Policy.
- Scans run read-only `git` commands with hooks and `core.fsmonitor` disabled, so opening an untrusted repo does not run its code.
- Actions are planned by the app, previewed, and then run exactly as previewed. They only target branches, PRs and runs found in the last scan, or (for clutter) items found by a fresh scan at plan time. Right before removing anything GutCheck checks it is still unchanged and not tracked by git.
- Files GutCheck keeps on your machine, in its app data folder: `settings.json` (workspace folder, read-only switch, tray options; written atomically, and a damaged copy is kept as `settings.json.bad`), `audit.log` (every change it made; trimmed to the latest 500 entries once it passes 1 MB) and `trend.json` (scores and totals per scan). Nothing is uploaded.

## Develop

```bash
npm install
npm start      # run the app
npm test       # unit tests
npm run dist   # build the AppImage into dist/
```

`package.json` has an `overrides` entry that lifts only the vulnerable `minimatch` versions (7.0.0 to 11.0.3, a glob-pattern DoS in build tooling) to a patched 11.x. Older majors that `glob` and `asar` need are left alone, because they are not affected and 11.x is not API-compatible with them. Remove it once `electron-builder` updates; `npm audit` should stay at 0 and `npm ls minimatch` should show nothing invalid.

### Releasing

Note each change under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) as you go. To release, run `npm run bump -- patch` (or `minor`, `major`, or an exact `1.2.3`): it turns Unreleased into a dated section for the new version and updates `package.json` and `package-lock.json` together. It refuses when Unreleased is empty. Commit and push to `main`. CI then runs the tests (which fail if the version has no changelog section, or the two package files disagree), builds the AppImage with a `SHA256SUMS.txt`, creates the tag `v<version>` at that commit and publishes a GitHub release whose notes are that changelog section plus GitHub's list of changes. `node scripts/version.js notes 0.23.0` prints any version's notes. The app shows its version in the header and in Settings; `gutcheck --version` prints it. Nothing is released if the tests or the build fail, if that version already has a release or tag, or on pull requests. Versions with a suffix (such as `1.0.0-beta.1`) are published as pre-releases.

You can still release by pushing a tag yourself (`git tag v0.9.0 && git push origin v0.9.0`); the build fails if the tag does not match `package.json`.

## Licence

MIT
