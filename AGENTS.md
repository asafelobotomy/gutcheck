# AGENTS.md

GutCheck is an Electron app (plus a CLI and an MCP server) that checks the health of every git repo in a folder, using `git` and the `gh` CLI.

## Commands

- `npm install`: install dependencies (Node 22 or newer)
- `npm test`: run every unit test (`node --test test/*.test.js`; no network needed, temp git repos only)
- `npm start`: run the app
- `npm run dist`: build the AppImage into `dist/`
- `node src/cli.js --help`: the command line; `node src/cli.js mcp` runs the MCP server

## Layout

- `src/main.js`: Electron wiring only (IPC, window, tray). `src/entry.js` picks app, `--cli` or `--mcp`.
- `src/service.js`, `src/engine.js`: the logic behind the IPC handlers and the headless CLI/MCP, with dependencies injected so it runs without Electron. `src/workspace-scan.js` is the one workspace scan all three use (it owns the `known` map).
- Checks: `scanner.js` collects, `checks.js` and `checks-hygiene.js` turn it into findings, `report.js` and `report-fixes.js` write the "Copy for LLM" plan.
- Upkeep checks: `dep-automation.js` (Dependabot grouping, auto-merge), `release.js` (tags vs manifest, changelog).
- The user's rules: `policy.js` (ignores with reasons, baseline drift), `schedule.js` (new-since-last-scan, scheduled scans). Report steps for these are in `report-upkeep.js`.
- AI agent context: `agent-context.js` (instruction size, LSP plugins, permission rules; redacted), `actions-agent.js` (split, prune, LSP set-up), `agent-tidy.js` (stale config files and machine-level fixes), `agent-usage.js` (the opt-in usage and health check).
- Other scans: `clutter.js` (+ `clutter-rules.js`), `quality/`, `tests/`, `agents.js`, `history.js`.
- Actions: `actions.js` plans, `apply.js` runs exactly the planned steps. `renderer/fix-all.js` (shared with the CLI and MCP) builds a repo's "Fix all issues" plan and its run order; `renderer/fixall-view.js` is the wizard.
- `scripts/version.js`: changelog sections, `npm run bump`, release notes. `scripts/demo/`: the made-up workspace and Electron capture behind `npm run screenshots` (README images in `docs/images/`).
- `src/renderer/`: plain DOM scripts loaded in order by `index.html`, sharing globals. `test/helpers/dom.js` loads them in the same order in jsdom.

## Rules

- Scans are read-only and never run a repo's code: every git call goes through `exec.git` (hooks and fsmonitor disabled). Only the opt-in `tests-run` action executes project code.
- Every change goes plan, preview, apply. Nothing deletes repos, changes visibility, force-pushes or rewrites history.
- Never put secret values, `.env` contents or settings values into findings, reports or logs.
- Keep files under 400 lines; GutCheck checks itself.
- Explain each new rule's source in `docs/sources.md`, and add a test for each false alarm you fix (`test/accuracy.test.js`).
- Changes go under `## [Unreleased]` in `CHANGELOG.md`.
- Releasing: `npm run bump -- patch|minor|major` (moves Unreleased into a dated version and updates `package.json` and `package-lock.json`; tests check all three agree), commit, push to `main`. CI tags `v<version>` and publishes the release with that changelog section as its notes.
