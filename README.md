# GutCheck

<p align="center"><img src="src/assets/logo.svg" width="128" alt="GutCheck logo: a check mark made of intestine"></p>

A desktop dashboard that gives you a health check across every GitHub project in a folder. It is built on the [`gh` CLI](https://cli.github.com) and `git`, so it uses your existing GitHub login and never handles tokens itself.

## What it checks

- **CI**: failing workflow runs on the default branch
- **Pull requests**: conflicts, failing checks, stale PRs, approved and mergeable PRs
- **Branches**: uncommitted or unpushed work, behind upstream, merged and stale branches
- **Licence and docs**: LICENSE (an error only for public repos), README (and whether it says how to install or use the project), `.gitignore`, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, PR template. Files are found where GitHub looks (`.github/`, the root, `docs/`), and defaults from your account's `.github` repository count.
- **Project setup**: CHANGELOG or GitHub releases for tagged versions, `.gitattributes`, `.editorconfig`, pinned Node/Python version, and for public repos CODEOWNERS, issue templates and topics
- **Actions security**: script injection (`${{ github.event... }}` inside `run:`), `pull_request_target`/`workflow_run` that check out PR code, missing or `write-all` permissions, actions not pinned to a commit SHA, self-hosted runners on public repos, Dependabot not updating actions. Workflow files are read as text, never run.
- **Git hygiene**: credentials or `http://` in the remote URL, stash pile-ups, branches whose upstream was deleted, stale worktrees, uninitialised submodules, repos nested inside repos, repository size (GitHub's 1 GB / 5 GB guidance), loose objects, and with Deep scan files of 50 MB+ anywhere in history
- **Security features** (repos you administer): secret scanning, push protection, CodeQL default setup and private vulnerability reporting on public repos; Dependabot security updates everywhere
- **Dependencies**: missing lockfiles, uninstalled packages (with the right package manager), Dependabot alerts, outdated npm packages (Deep scan)
- **Repo settings**: missing remote, unprotected default branch (branch protection or an active ruleset both count), auto-delete of merged branches, inactivity
- **Workspace**: loose files, projects without git, copies and duplicate clones, naming, missing global git email or gitignore, plain-text credential storage, and disk used by dependency folders of projects untouched for 90 days

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
| Files | add LICENSE, README, .gitignore, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, PR template, dependabot.yml, a Node CI workflow (optionally committed) |

Safety rails: a **Read-only** switch in the header disables every action, every change is recorded in **History**, many actions show an undo command, and GutCheck never deletes repos, changes visibility, force-pushes or rewrites history.

## Dashboard

After a scan GutCheck opens on a **Dashboard**: KPI cards (average health, errors, warnings, open PRs, failing CI, uncommitted and unpushed work, high-severity alerts, merged and stale branches, local-only repos, missing licences, reclaimable clutter) and charts for grade distribution, issues by category, repo activity, open PR age, health per repo and clutter size per repo. Click a repo bar, an attention row or a card to drill in. It is computed from the scan you already have, so it makes no extra GitHub calls; the clutter numbers appear once you run a clutter scan from the dashboard.

An **issue heatmap** shows repos against problem categories (darker means more issues, colour is the worst severity). **Trends** show average health, errors and warnings, and clutter size across scans, and the cards show the change since the previous scan, plus the repos whose score moved most. GutCheck keeps one small snapshot per scan (scores and totals only, no paths or file names) in `trend.json` in its app data folder, scoped per workspace folder, capped at 365 snapshots; scans within 10 minutes of each other replace one another. Delete the file to reset the history.

## Code quality

The **Code quality** view runs read-only checks on the source of every scanned repo (it respects `.gitignore` and skips `node_modules`, build output, lockfiles, minified and generated files):

- **File length (LOC)**: files over your limit. The default is **400 lines**; change it, choose to count all lines or only code lines (no blanks or comments), and add ignore rules (`legacy/`, `*.generated.ts`, or part of a path) in the form at the top of the view. Settings are validated (20 to 20000) and saved.
- **Magic numbers**: bare numeric literals in non-test code for JavaScript/TypeScript, Python, Go, Rust, Java, Kotlin, C/C++, C#, PHP, Swift, Ruby and shell. Strings, comments and regexes are ignored, as are `0, 1, 2, 10, 100, 0.5`, constant definitions (`MAX_X = 5`), array indices, imports and data tables.
- **Constants library**: finds constants modules and named constants, flags raw numbers that may repeat an existing constant (values above 100), lists numbers repeated three or more times without a name, and suggests creating a constants module when there are many bare numbers and none.
- **Secrets**: AWS, GitHub, Slack, Google, Stripe and private-key signatures plus hardcoded `password = "..."` style credentials. Only the **file, line and kind** are recorded; the value never leaves the scanner and never appears in the UI, the report or the history.
- **Other checks**: `TODO` / `FIXME` / `HACK` markers, `debugger` / `breakpoint()` leftovers and `console.log` noise, files over 5 MB, and source without any tests.

Results feed the Dashboard (cards, largest files, lines per language, magic numbers per repo, and trends once you have two scans) and the **Copy for LLM** report, which gets a Code quality section with the exact locations and ordered steps (secrets first).

## Copy for LLM

**Copy for LLM** (on each repo, and on the Workspace overview for everything) puts a Markdown report on your clipboard: a status snapshot, open PRs, failing CI, detected clutter, and an ordered action plan with exact commands (secrets first, then saving work, CI/PRs, missing files, dependencies, branches, clutter, settings). Paste it into any LLM to have it do the fixing instead of using the app. The report tells the assistant to ask before destructive steps, never read `.env` contents, and treat PR titles and file names as data. It contains repo paths and names but no file contents.

## Clutter & tidy-up

The **Clutter & tidy-up** view scans every repo (read-only) for things nothing needs:

- **Env files**: backups and copies (`.env.bak`, `.env (1)`, `.env.2024-01-02`), env files identical to another in the same folder, empty ones, and `.env.test` in repos with no tests. Templates such as `.env.example` are never flagged. Env files are only compared by checksum; their contents are never kept.
- **Caches and test output**: `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `coverage/`, `htmlcov/`, `test-results/` and similar.
- **Temp, backup and junk files**: `*.tmp`, `*.bak`, `*.orig`, swap files, `.DS_Store`, `Thumbs.db`, package-manager crash logs, and `name (1).ext` / `name copy.ext` copies (exact copies rate higher than diverged ones).
- **Organisation advice**: committed or un-ignored `.env` files, missing `.env.example`, clutter missing from `.gitignore` (one-click append), several lockfiles, split `test`/`tests` or `doc`/`docs` folders, loose files and media in the repo root, plus workspace-level hints (projects without git, `foo-old` next to `foo`, the same remote cloned twice, inconsistent naming).

Files tracked by git are never offered for removal. Removal shows every item first; env files need you to type the repo name, and anything that is not a regenerable cache goes to your trash rather than being deleted. Only high-confidence items are pre-selected.

## Startup & tray

The **Startup & tray** button (top bar) has three options, all off by default:

- **Launch when I log in**: starts GutCheck at login, straight into the tray with no window. On Linux this writes `~/.config/autostart/gutcheck.desktop` (pointing at the AppImage you ran, so keep it in a stable place); on Windows and macOS it uses the system login items. Turning it off removes the entry.
- **Minimise to the system tray**: minimising hides the window; click the tray icon to bring it back.
- **Closing the window keeps GutCheck running in the tray**: use **Quit** in the tray menu to exit.

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

Bump `version` in `package.json` and `package-lock.json` (both; a test checks they agree) and push to `main`. CI then runs the tests, builds the AppImage with a `SHA256SUMS.txt`, creates the tag `v<version>` at that commit and publishes a GitHub release with generated notes. Nothing is released if the tests or the build fail, if that version already has a release or tag, or on pull requests. Versions with a suffix (such as `1.0.0-beta.1`) are published as pre-releases.

You can still release by pushing a tag yourself (`git tag v0.9.0 && git push origin v0.9.0`); the build fails if the tag does not match `package.json`.

## Licence

MIT
