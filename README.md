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
