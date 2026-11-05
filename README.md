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

Re-run failed CI jobs, squash-merge a PR, push, pull (fast-forward only), fetch and prune, delete merged branches, `npm install`, and create a missing LICENSE, README or `.gitignore`. Destructive actions ask for confirmation first.

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
- Actions only act on branches, PRs and runs found in the last scan, and destructive ones ask first.

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
