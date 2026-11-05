# GutCheck

A desktop dashboard that gives you a health check across every GitHub project in a folder. It is built on the [`gh` CLI](https://cli.github.com) and `git`, so it uses your existing GitHub login and never handles tokens itself.

## What it checks

- **CI**: failing workflow runs on the default branch
- **Pull requests**: conflicts, failing checks, stale PRs, approved and mergeable PRs
- **Branches**: uncommitted or unpushed work, behind upstream, merged and stale branches
- **Licence and docs**: LICENSE, README, `.gitignore`, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, PR template
- **Dependencies**: missing lockfiles, uninstalled packages, Dependabot alerts, outdated npm packages (Deep scan)
- **Repo settings**: missing remote, unprotected default branch, inactivity

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
| Files | add LICENSE, README, .gitignore, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, PR template, dependabot.yml, a Node CI workflow (optionally committed) |

Safety rails: a **Read-only** switch in the header disables every action, every change is recorded in **History**, many actions show an undo command, and GutCheck never deletes repos, changes visibility, force-pushes or rewrites history.

## Clutter & tidy-up

The **Clutter & tidy-up** view scans every repo (read-only) for things nothing needs:

- **Env files**: backups and copies (`.env.bak`, `.env (1)`, `.env.2024-01-02`), env files identical to another in the same folder, empty ones, and `.env.test` in repos with no tests. Templates such as `.env.example` are never flagged. Env files are only compared by checksum; their contents are never kept.
- **Caches and test output**: `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `coverage/`, `htmlcov/`, `test-results/` and similar.
- **Temp, backup and junk files**: `*.tmp`, `*.bak`, `*.orig`, swap files, `.DS_Store`, `Thumbs.db`, package-manager crash logs, and `name (1).ext` / `name copy.ext` copies (exact copies rate higher than diverged ones).
- **Organisation advice**: committed or un-ignored `.env` files, missing `.env.example`, clutter missing from `.gitignore` (one-click append), several lockfiles, split `test`/`tests` or `doc`/`docs` folders, loose files and media in the repo root, plus workspace-level hints (projects without git, `foo-old` next to `foo`, the same remote cloned twice, inconsistent naming).

Files tracked by git are never offered for removal. Removal shows every item first; env files need you to type the repo name, and anything that is not a regenerable cache goes to your trash rather than being deleted. Only high-confidence items are pre-selected.

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
- Actions are planned by the app, previewed, and then run exactly as previewed. They only target branches, PRs and runs found in the last scan.

## Develop

```bash
npm install
npm start      # run the app
npm test       # unit tests
npm run dist   # build the AppImage into dist/
```

Releases are built by GitHub Actions: pushing a tag like `v0.2.0` builds the AppImage and attaches it to a GitHub release.

## Licence

MIT
