# Contributing to GutCheck

Thanks for helping. GutCheck runs on Node 22 or newer, with `git` and the [`gh` CLI](https://cli.github.com) on your `PATH`.

1. Fork the repository and create a branch from `main`.
2. `npm install`, then `npm start` to run the app or `node src/cli.js --help` for the command line.
3. Make your change and add or update tests. Every false alarm you fix gets a test in `test/accuracy.test.js`, and every new check gets its source in `docs/sources.md`.
4. Run `npm test` (no network needed: the tests use temporary git repos).
5. Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
6. Open a pull request describing what changed and why.

[AGENTS.md](AGENTS.md) lists the layout and the rules every change follows: scans are read-only and never run a repo's code, every change goes plan, preview, apply, secret values never reach findings or reports, and files stay under 400 lines. Releases are made by the maintainer with `npm run bump`.
