# Cross-ecosystem project upkeep checks GutCheck could add (research as of 2026-11-10)

Scope note: baseline is docs/sources.md. Already covered, so NOT proposed: community files, Dependabot grouping/auto-merge, release tag vs manifest, changelog, Actions pinning/permissions, `.editorconfig`, "no runtime pin" (info), disk-space for node_modules/target/venvs untouched 90 days, pytest temp dirs, tests-in-CI. "Deliberately not checked" (Conventional Commits, SBOM, signing, full secret history) is respected. README was not separately skimmed; sources.md was the filter. Items marked "(unverified)" come from prior knowledge, not a fetched page.

## 1. End-of-life runtimes and toolchains

### Takeaway
GutCheck already notes "no runtime pin" but never asks "is the pinned runtime still supported?". An EOL check is feasible read-only from pins (`.nvmrc`, `engines.node`, `requires-python`, `go.mod`, `rust-version`, electron dep) against a bundled table or the endoflife.date v1 JSON API. Several 2026 schedule changes mean a hard-coded table must be data-driven.

### Cited Findings
- endoflife.date v1 product JSON (`/api/v1/products/<name>/`) returns per-release `isLts`, `isEol`, `eolFrom`, `isMaintained`, `isEoas`, `isEoes`, `latest{name,date}`. Node entry: 26 LTS eol 2029-04-30; 25 not maintained, eol 2026-06-01; 24 LTS eol 2028-04-30; 23 eol 2025-06-01 — [endoflife.date API](https://endoflife.date/api/v1/products/nodejs/) (Swagger docs page at [docs/api/v1](https://endoflife.date/docs/api/v1/) did not render for me; rate limits/CORS/auth not confirmed)
- Node.js moves to ONE major per year from 27: alpha Oct 2026, 27.0.0 April 2027, LTS Oct 2027, EOL ~April 2030; every release becomes LTS (odd/even split retired); Node 26 (April 2026) is the last two-per-year major. One secondary source (HeroDevs) says "odd-numbered become LTS", which conflicts with the official post; schedule "not final", `schedule.json` in the Release repo is authoritative — [Node.js blog](https://nodejs.org/blog/announcements/evolving-the-nodejs-release-schedule); [InfoQ](https://infoq.com/news/2026/06/nodejs-release-changes)
- Python status (devguide, fetched): 3.10 EOL 2026-10-01 (already EOL today); 3.9 EOL 2025-10-31; 3.11 EOL 2027-10; 3.12 2028-10; 3.13 2029-10; 3.14 2030-10; 3.15 first release 2026-10-09 (page lists as bugfix) — [devguide.python.org/versions](https://devguide.python.org/versions/)
- Go policy: each major supported until two newer majors exist. As of the release page: 1.27 (go1.27.3, released 2026-08-19) and 1.26 supported; 1.25 and older unsupported — [go.dev/doc/devel/release](https://go.dev/doc/devel/release)
- Go `go` line in go.mod is a minimum (mandatory since 1.21); `toolchain` line is a suggestion; GOTOOLCHAIN=auto downloads a newer toolchain when go.mod demands one. So go.mod `go` line is a requirement floor, not a "version in use": EOL detection should use the `toolchain` line if present, else CI `go-version`, else the `go` line, and say which — [go.dev/doc/toolchain](https://go.dev/doc/toolchain)
- Electron supports the latest THREE stable majors, majors every 8 weeks, only the latest minor of each; EOL dates track Chromium so use releases.electronjs.org/schedule, not static math — [Electron timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- Google Play: new apps and updates must target API 36 (Android 16) from 2026-08-31; Wear OS and Automotive need 35; TV/XR 34; existing apps need 35 to stay discoverable to newer-OS users (secondary reading; extension to 2026-11-01 reported only on forums, unverified); API 37 date not published — [Play target API requirement](https://developer.android.com/google/play/requirements/target-sdk); [Play Console help](https://support.google.com/googleplay/android-developer/answer/11926878)
- Gradle wrapper: `distributionUrl` in `gradle/wrapper/gradle-wrapper.properties` carries the Gradle version; Gradle 9.0.0+ requires full `X.Y.Z` there — [Gradle wrapper docs](https://docs.gradle.org/current/userguide/gradle_wrapper.html)
- Rust: `rust-version` (MSRV) is a bare version, enforced by Cargo >=1.56; Cargo docs advise documenting an MSRV policy and not letting it drift — [Cargo rust-version](https://doc.rust-lang.org/cargo/reference/rust-version.html). Rust has no official multi-version support window (only latest stable; unverified), so "EOL Rust" is better as "MSRV more than N releases (~6 weeks each) behind stable" (info).

### Candidate checks
| # | Detect | Read-only how | Fix | Risk |
|---|---|---|---|---|
| E1 | Pinned Node/Python/Go/Electron is EOL or <6 months from EOL | Parse `.nvmrc`, `.node-version`, `.tool-versions`, `engines.node` (take the max satisfiable major), `requires-python` lower bound + classifiers, `.python-version`, go.mod `go`/`toolchain`, `electron` in devDependencies/lockfile; compare with cached endoflife.date JSON (one GET per product, cache 24 h; offline fallback table shipped with a "table as of" date) | Report step: bump pin + CI matrix to the current LTS; never auto-edit | Low. Network call is to a fixed URL, no repo data sent. Lower bound of a range is not the version in use: label "pinned floor" |
| E2 | CI matrix/`setup-*` versions EOL | Parse `.github/workflows/*.yml` `node-version`, `python-version`, `go-version`, `java-version`, `matrix` lists; ignore expressions | Update matrix | Low; matrix may deliberately test old versions: info for lower end, warn only when the ONLY version is EOL |
| E3 | Local pin vs CI mismatch | Compare `.nvmrc`/`engines`/`requires-python`/`rust-toolchain.toml` channel against workflow versions | Align one to the other | Low; very common drift source |
| E4 | Electron more than 3 majors behind or on EOL major | `electron` version from package-lock/pnpm-lock; compare to releases.electronjs.org/schedule or endoflife.date `electron` | Plan bump; link breaking-changes doc | Low; bump itself is risky, so report only |
| E5 | Android `targetSdk`/`compileSdk` below Play requirement | Regex `targetSdk(Version)?`/`compileSdk` in `app/build.gradle(.kts)`, `variables.gradle` (Capacitor), `gradle.properties`; Tauri mobile `gen/android`; compare to a small table (36 now, 35 for Wear/Auto) | Raise to 36, read behavior-change page | Low to detect, medium to fix (behavior changes); also skip libraries (no `com.android.application`) |
| E6 | Gradle wrapper old or AGP/Gradle/JDK mismatch | Parse `distributionUrl` version vs latest from endoflife.date/Gradle `services.gradle.org/versions/current` | `./gradlew wrapper --gradle-version X` preview only (it runs project code: keep as a printed step, not run by scan) | Medium for the fix |
| E7 | Rust MSRV stale or missing for published crate | `[package] rust-version` absent in a lib crate with `publish` not false; or MSRV > N minor releases behind | Add `rust-version`; consider `resolver = "3"` (MSRV-aware resolution; Cargo docs page I fetched did not cover it, so details unverified) | Low |
| E8 | Edition outdated | `edition = "2018"/"2021"` vs latest 2024 (unverified date); missing `edition` means 2015 | `cargo fix --edition` as a suggested step | Low detect, medium fix |

### Inferences
- A tiny bundled JSON (name, eol date, "as of") refreshed by release plus optional live fetch avoids breaking the "no network in tests" rule. Node's new one-major-a-year cadence means next-LTS predictions should come from the data, not code.
- E1 is the single best value-for-effort item in this document.

### Gaps
- endoflife.date API rate limits, CORS and stability promises: docs page did not render.
- Whether Play's existing-app target rule (35) is still enforced as described: only secondary sources agreed; check the primary page at use time.
- Rust MSRV "N releases behind" threshold is my suggestion; no authoritative support policy found.
- Edition 2024 default-resolver facts came from the fetch tool's own general knowledge, flagged unverified by it.

## 2. Toolchain pinning and reproducibility

### Takeaway
Existing check says "no pin". Refinements: validate the pin is internally consistent, that Corepack-dependent `packageManager` pins still work on Node 25+, lockfiles exist and match, and Gradle wrapper integrity.

### Cited Findings
- Corepack is no longer distributed with Node.js 25+; Node 24 and earlier still ship it (experimental); npm still ships with Node. Users on 25+ must `npm install -g corepack`. The TSC vote concerns removal from distribution, not deprecation status. Verified via Node API docs snippets, secondary coverage; I did not open the final release notes — [Socket coverage of TSC vote](https://socket.dev/blog/node-js-tsc-votes-to-stop-distributing-corepack); [Node v25 corepack docs](https://r2.nodejs.org/dist/v25.9.0/docs/api/corepack.json)
- Node 25 is already EOL (2026-06-01), and Node 26 LTS is current, so a repo on Node 26 with `"packageManager": "pnpm@x"` has no Corepack unless it was installed — [endoflife.date Node](https://endoflife.date/api/v1/products/nodejs/)
- npm `devEngines` (`runtime`, `packageManager`, `cpu`, `os`, `libc`; `onFail` = warn/error/ignore, default error) is checked before install/ci/run; npm only accepts `node` for runtime and `npm` for packageManager, other names make the CLI fail — [npm package.json devEngines](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#devengines). Implication: a pnpm/yarn project must not copy `devEngines.packageManager.name = pnpm` expecting npm to cope (npm will fail).
- Gradle: commit `gradle-wrapper.jar`, `.properties`, `gradlew`, `gradlew.bat`; the JAR runs on dev/CI machines so verify its SHA-256 against gradle.org/release-checksums; a JAR hash matching a different version means wrapper not regenerated; unlisted hash = untrusted; `distributionSha256Sum` in properties makes the distribution download verified — [Gradle wrapper docs](https://docs.gradle.org/current/userguide/gradle_wrapper.html)
- Go: `go.work` has its own `go`/`toolchain` lines and the `go` line must be >= every `use`d module's — [go.dev/doc/toolchain](https://go.dev/doc/toolchain)
- pre-commit hooks pin `rev` (tag or SHA; branch names and HEAD unsupported) and `default_language_version` sets language defaults — [pre-commit.com](https://pre-commit.com/#pre-commit-autoupdate)

### Candidate checks
| # | Detect | Read-only how | Fix | Risk |
|---|---|---|---|---|
| T1 | `packageManager` field set but Node pin >= 25 (or CI Node >= 25) and no Corepack install step | Parse `package.json` `packageManager`; Node pin from `.nvmrc`/engines/CI; grep workflows/Dockerfile for `corepack enable`/`npm i -g corepack` | Add `npm install -g corepack` step, or move pin to `devEngines`/pnpm's own `manage-package-manager-versions` (unverified) | Low |
| T2 | `packageManager` disagrees with lockfile (pnpm@ vs only `package-lock.json`) | Names of lockfiles present vs field | Pick one manager; delete stale lockfile after owner OK | Low |
| T3 | `devEngines.packageManager.name` not `npm` with npm-only tooling | Parse JSON | Remove or change | Low |
| T4 | Two lockfiles in one JS project (package-lock + yarn.lock/pnpm-lock) | File listing | Remove one | Low |
| T5 | Binary/app Cargo project without tracked `Cargo.lock`; library without it is fine | Is `[[bin]]`/`src/main.rs` or `tauri` present and `git ls-files Cargo.lock` empty or `.gitignore`d? | Commit Cargo.lock | Low. Cargo FAQ guidance (unverified) |
| T6 | Python app with `pyproject.toml` `[tool.uv]` or `[tool.poetry]` and no tracked `uv.lock`/`poetry.lock`; or lock older than `pyproject.toml` | `git ls-files`; compare last-commit timestamps (git log -1 per file) as a drift hint; poetry.lock embeds `content-hash` of pyproject (unverified) so a hash mismatch needs poetry's algorithm: report only "pyproject newer than lock" | `uv lock` / `poetry lock` as step | Low (timestamps are a heuristic) |
| T7 | `package-lock.json` older than `package.json` deps (drift) | Compare dependency maps: package.json names/ranges vs lock `packages[""]` entry (it mirrors root deps), no install needed | `npm install` step | Low; precise and cheap |
| T8 | Gradle wrapper missing, JAR untracked, `distributionSha256Sum` absent, or JAR hash unknown | `git ls-files`; sha256 of the committed JAR against a bundled table of official hashes (gradle.org/release-checksums) | Re-run `./gradlew wrapper` (preview) | Low detect; the table must be refreshed from gradle.org |
| T9 | `rust-toolchain.toml` channel `stable`/`nightly` unpinned vs CI `dtolnay/rust-toolchain` differing | Parse both | Align | Low |
| T10 | `.python-version` vs `requires-python` conflict (pin below lower bound) | Parse | Fix one | Low |
| T11 | go.mod `go` older than a required module's or go.work mismatched | Parse go.mod/go.work | `go work use`/`go get go@x` | Low |
| T12 | pre-commit `rev` pointing at a stale tag, branch name or `HEAD`; `repo: local` hooks only | Parse `.pre-commit-config.yaml`; for staleness compare tag to remote latest via `git ls-remote --tags` (no clone, no hooks executed) or `pre-commit autoupdate` as printed step. `--freeze` writes SHA with `# frozen: tag` comment; pre-commit.ci can auto-update | `pre-commit autoupdate [--freeze]` step | Low. ls-remote is network but runs no repo code; note `pre-commit autoupdate` itself clones hook repos and is not run by scans |

### Inferences
- T7 and T5 are exact and cheap. T1 is time-sensitive (Node 25 already EOL, Node 26 LTS now widely adopted) and a genuine 2026 surprise.

### Gaps
- Did not fetch Corepack's own repo docs on its post-removal status or pnpm's `manage-package-manager-versions` behaviour.
- Cargo FAQ on Cargo.lock for libraries/binaries not fetched (relied on memory).
- poetry.lock `content-hash` algorithm not verified.

## 3. Deprecated/abandoned dependencies and advisories

### Takeaway
GutCheck has no dependency-vulnerability or deprecation layer. OSV.dev is a single no-auth API covering npm, PyPI, crates.io, Go, Maven; lockfiles give exact versions without running anything. Deprecation/yank flags come from each registry.

### Cited Findings
- OSV API: `POST /v1/querybatch` takes batched package+version (or commit) queries; per the docs page there are currently no rate limits; responses cap at 32 MiB on HTTP/1.1, uncapped on HTTP/2 — [OSV API docs](https://google.github.io/osv.dev/api/). Request body format and ecosystem names (`npm`, `PyPI`, `crates.io`, `Go`, `Maven`) are from my prior knowledge, unverified here.
- cargo-deny reads the RustSec advisory DB (default `db-urls` GitHub, cached at `$CARGO_HOME/advisory-dbs`, staleness limit P90D when offline); `yanked` defaults to `warn`; `unmaintained` defaults to `all` (any unmaintained crate fails) with an `ignore` list — [cargo-deny advisories config](https://embarkstudios.github.io/cargo-deny/checks/advisories/cfg.html)
- npm deprecation: `npm deprecate` writes a registry-side warning shown to anyone installing; works on version ranges; empty message un-deprecates — [npm-deprecate](https://docs.npmjs.com/cli/v11/commands/npm-deprecate). The packument `deprecated` per-version string is my prior knowledge (unverified).
- PyPI: Simple API marks yanked files via `data-yanked` (HTML) or `yanked` bool/string (JSON); PEP 792 project status markers (`archived`, `deprecated`, `quarantined`) via `project-status` in API 1.4. The page did not define the markers — [Simple repository API](https://packaging.python.org/en/latest/specifications/simple-repository-api/)
- Go: govulncheck/vuln DB not fetched (gap). Go vuln DB is also in OSV (unverified).

### Candidate checks
| # | Detect | Read-only how | Fix | Risk |
|---|---|---|---|---|
| D1 | Known vulnerabilities in locked versions, all ecosystems | Parse `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`, `Cargo.lock`, `uv.lock`/`poetry.lock`/`requirements*.txt` (only pinned), `go.sum`/go.mod, Gradle lockfiles; send (ecosystem, name, version) triples to OSV `querybatch`; show IDs and severity only | Suggest updating that dep; link advisory | Low code risk. Privacy: sends dependency names to Google; make it opt-in, and exclude private package names (scoped private npm, git/path deps). Noise: dev-only vs reachable; classify by dev/prod where the lock says |
| D2 | npm package versions flagged deprecated | Registry GET of each locked top-level (not transitive: too many) package's version metadata `deprecated` field (unverified field); cache | Replace dependency; show message | Medium load: batch top-level deps only; opt-in network |
| D3 | PyPI yanked or archived locked releases | `uv.lock` records sources; query PyPI JSON per direct dep (`yanked`), per Simple API | Pin a non-yanked version | Low-medium |
| D4 | Rust yanked / unmaintained crates | Read `Cargo.lock`; compare to RustSec DB clone (`git ls-remote`+shallow fetch, no execution) or OSV (RustSec IDs RUSTSEC-* are in OSV, unverified) | `cargo update -p x` or swap crate | Low; do not run cargo-audit/deny, scan only parses |
| D5 | Go modules with known vulns | go.mod/go.sum via OSV; govulncheck is deeper (call-graph) but builds code: offer as printed step only | `go get x@fixed` | Low |
| D6 | Typosquat / suspicious dependency names | Edit distance to top-N popular names in same ecosystem; new `postinstall` in lock (`hasInstallScript`) for unfamiliar packages | Review manually | High false-positive rate; recommend info only or skip. No authoritative source fetched |
| D7 | Install scripts present in dependency tree | `hasInstallScript: true` in package-lock `packages` entries (no install needed) | Consider `ignore-scripts`/pnpm `onlyBuiltDependencies` (unverified name) | Low; informational, supply-chain context |

### Inferences
- D1 via OSV gives most of the security value in one code path across five ecosystems; GitHub's Dependabot alerts (already readable via `gh` for repos you administer) cover repos with alerts enabled, so D1 can be framed as "works offline of GitHub, and for private repos on free plan".
- Respect "never run a repo's code": all of D1-D5 are parse-only plus HTTP to registries/OSV.

### Gaps
- OSV querybatch request schema, pagination (`next_page_token`), and ecosystem names need confirming on the dedicated pages.
- RustSec/OSV mapping, govulncheck, GitHub Advisory DB docs, typosquat literature not fetched.

## 4. Licences

### Takeaway
GutCheck only checks a LICENSE file exists on public repos. Cheap consistency checks (manifest vs file) add value; REUSE and dependency-licence conflict checks are heavier and probably overkill for a personal workspace.

### Cited Findings
- REUSE spec page (reuse.software/spec) did not render for me, so REUSE facts are unverified: per-file `SPDX-License-Identifier`/`SPDX-FileCopyrightText`, `LICENSES/<id>.txt`, `REUSE.toml`, `reuse lint` — [REUSE spec](https://reuse.software/spec/)
- Existing check cites GitHub licensing docs and Scorecard License; those stay the base — docs/sources.md.

### Candidate checks
| # | Detect | Read-only how | Fix | Risk |
|---|---|---|---|---|
| L1 | Manifest licence field missing: `package.json` `license`, `Cargo.toml` `license`/`license-file`, `pyproject.toml` `[project] license` (PEP 639 SPDX expression) | Parse manifests | Add SPDX id matching LICENSE | Low |
| L2 | Manifest SPDX id disagrees with LICENSE text | Fingerprint LICENSE with a small matcher (first lines, e.g. "MIT License", "Apache License Version 2.0", "GNU GENERAL PUBLIC LICENSE Version 3") vs manifest id | Edit one to match | Low-medium: keep matcher to ~10 common licences, else skip. Also flag non-SPDX strings (`"MIT/Apache"` instead of `MIT OR Apache-2.0`) |
| L3 | Copyright year/holder placeholder in LICENSE (`[yyyy] [name of copyright owner]`, `<year>`) | Regex | Fill in | Low |
| L4 | `UNLICENSED`/`proprietary` public repo or private repo with an open licence | manifest vs visibility | Info | Low |
| L5 | Dependency licence conflict (GPL/AGPL dep in MIT/proprietary project) | cargo-deny `licenses` or lockfile-derived metadata needs registry calls | Deferred: per-ecosystem metadata fetch; recommend skipping or opt-in | High effort, legal-advice risk |

### Inferences
- L1-L3 are pure file parsing and false-alarm-light. L5 is likely to give legal-sounding advice GutCheck should avoid.

### Gaps
- REUSE spec version and lint rules; PEP 639 text not fetched.

## 5. Developer tooling hygiene

### Takeaway
Refinements to existing Dependabot/Actions checks matter most: the Node 20 to Node 24 Actions runtime change in 2026 makes "outdated action versions" a concrete, detectable problem; Dependabot ecosystem coverage per manifest is a clear gap versus today's "github-actions present or not".

### Cited Findings
- GitHub moved runners' JavaScript-action runtime to Node 24 by default from June 16, 2026; Node 20 removal date was updated to September 23, 2026 per changelog (sources vary: June 2 / Sept 16; treat GitHub changelog as authoritative and re-check). `actions/checkout` v4 runs on Node 20; v5 and v6 on Node 24. Opt-outs `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true` / test with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`. ARM32 self-hosted runners unsupported on Node 24 — [GitHub changelog 2026-03-19](https://github.blog/changelog/2026-03-19-deprecation-of-node-20-on-github-actions-runners/); [2026-09-23 update](https://github.blog/changelog/2026-09-23-deprecation-of-node-20-on-github-actions-runners/) (search snippet only)
- pre-commit: `pre-commit autoupdate` moves `rev` to the latest tag (`--freeze` writes SHAs; `--bleeding-edge` uses latest commit); pre-commit.ci autoupdates PRs periodically. I found no `--cooldown` flag in the docs — [pre-commit.com](https://pre-commit.com/#pre-commit-autoupdate)
- Dependabot cooldown/groups are already templated by GutCheck — docs/sources.md.

### Candidate checks
| # | Detect | Read-only how | Fix | Risk |
|---|---|---|---|---|
| H1 | Workflow uses actions on runtimes older than Node 24 (e.g. `actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v3/v4` as applicable) | `uses:` refs parsed already by the pinning check; compare major to a small "min Node-24 major" table per popular action (checkout >=5, others to be sourced per action from their `action.yml` `runs.using`: `node20` vs `node24`). With SHA pins: resolve via `gh api repos/o/r/contents/action.yml?ref=<sha>` | Bump to latest SHA + comment tag (matches existing pin advice) | Low. Need a rule to avoid false alarms when action major changed inputs |
| H2 | Dependabot/Renovate does not cover every ecosystem present | Map manifests found (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`/`requirements.txt`, `build.gradle(.kts)`, `Dockerfile`, `.github/workflows`, `.pre-commit-config.yaml`) to `package-ecosystem` values in `.github/dependabot.yml` (check each `directory`), or `renovate.json` presence; note Dependabot lacks pre-commit support (Renovate/pre-commit.ci covers it; unverified) | Template stanza per missing ecosystem | Low. Extends existing "github-actions missing" check |
| H3 | Dependabot `directory` points to a path that no longer has the manifest | Compare to file tree | Fix path | Low |
| H4 | Linter/formatter config present but not run in CI or pre-commit (e.g. `.eslintrc*`, `eslint.config.*`, `ruff.toml`/`[tool.ruff]`, `rustfmt.toml`, `clippy.toml`, `.golangci.yml`, `.prettierrc`) | grep workflows and `package.json` scripts for the tool name; existing tests-in-CI check has the machinery | Add CI step | Low-medium; scripts invoked via `npm run lint` need a one-level script lookup |
| H5 | `.pre-commit-config.yaml` present but hooks not installed/ run in CI (no `pre-commit run` or pre-commit.ci config) | `.git/hooks/pre-commit` contents contains "pre-commit" marker; workflow grep | `pre-commit install` | Low; reading `.git/hooks` is read-only |
| H6 | `.editorconfig` exists but `root = true` missing, or conflicts with formatter config (indent style vs prettier/ruff) | Parse | Edit | Low; low value |
| H7 | `rust-toolchain.toml` pins `nightly` without date | Parse | Pin date | Low |

### Inferences
- H1 and H2 are direct extensions of existing logic (pinning and Dependabot checks) and so are cheapest to implement.

### Gaps
- Actual current Node-runtime of specific actions (`runs.using`) not looked up; GitHub's 2026-09-23 changelog read from search snippet only.
- Renovate vs Dependabot coverage matrix (what each cannot manage) not verified.

## 6. Storage and build hygiene

### Takeaway
Existing disk check is info-only for dependency folders untouched 90 days. New value is per-ecosystem artefacts (Gradle/Android, Tauri/Cargo target, Docker, release artefacts) and *global* caches, with fixes that are official prune commands.

### Cited Findings
- `uv cache prune` removes unused entries and centralized environments (safe, recreated on demand); `uv cache prune --ci` strips pre-built wheels and unzipped sdists, keeps source-built wheels, recommended at end of CI jobs; `uv cache clean [pkg]` removes everything or one package; cache at `$XDG_CACHE_HOME/uv` or `~/.cache/uv` — [uv cache docs](https://docs.astral.sh/uv/concepts/cache/)
- `pnpm store prune` removes unreferenced packages (those no registered project uses), also clears metadata cache; registered projects are symlinked under `$(pnpm store path)/projects`; running it too often causes re-downloads — [pnpm store](https://pnpm.io/cli/store)
- `cargo clean --dry-run` and `npkill --dry-run` already used — docs/sources.md.

### Candidate checks
| # | Detect | Read-only how | Fix | Risk |
|---|---|---|---|---|
| S1 | Cargo `target/` size per project (incl. Tauri `src-tauri/target`), with GB threshold | `du`-style stat of `target/` (not reading contents), also detect shared `CARGO_TARGET_DIR`/`build.target-dir` in `.cargo/config.toml` | `cargo clean`; or `cargo sweep --time 30` / `cargo sweep --installed` (cargo-sweep, unverified) preview | Low. Fix deletes rebuildable data; confirm project not mid-build |
| S2 | Gradle/Android: project `.gradle/`, `app/build/`, `build/`, `android/.gradle`, Capacitor `android/app/build` size | stat | `./gradlew clean` (runs project code: provide as printed step) or delete dirs (rebuildable) | Low; note keystores live elsewhere, never touch `key.properties` |
| S3 | Global caches: `~/.gradle/caches`, `~/.cargo/registry` + `~/.cargo/git`, `~/.npm/_cacache`, `~/.cache/uv`, `~/.cache/pip`, pnpm store, `~/.cache/sccache`, `~/.m2` | du of fixed paths (follow `CARGO_HOME`, `GRADLE_USER_HOME`, `UV_CACHE_DIR`, `XDG_CACHE_HOME`) | `uv cache prune`, `pnpm store prune`, `npm cache verify`/`clean --force`, `pip cache purge`, `cargo cache -a` (cargo-cache crate, unverified), sccache size limit env | Low; shared across projects, so say re-download cost; all printed commands only |
| S4 | Release artefacts left in repos: `*.AppImage`, `*.pkg.tar.zst`, `*.deb`, `*.rpm`, `*.apk`, `*.aab`, `dist/`, `release/`, `out/`, `*.dmg`, `*.msi` that are untracked/ignored | File name patterns in ignored+untracked lists (`git status --ignored`), size | Move to trash after confirm | Low-medium: user may need the last release build; keep newest by mtime. Overlaps "stray files" and large-file checks, so extend rather than add |
| S5 | Docker: images/volumes/containers labelled by Compose project (`com.docker.compose.project`) for projects in the workspace; dangling build cache | `docker system df -v` / `docker image ls --format json` (talks to the daemon; does not run repo code; skip when daemon absent) | `docker compose down -v` (destructive volumes), `docker builder prune`, `docker image prune` printed with warning | Medium: volumes hold data. Info only, never auto-apply volumes |
| S6 | `node_modules` count by lockfile age and duplicated pnpm vs hardlinked store | Existing 90-day check; add size ranking | Existing | n/a |
| S7 | `.venv`/`venv` for deleted Python version (python symlink broken) | readlink of `.venv/bin/python` | Recreate with `uv venv` | Low; very cheap, good false-alarm profile |
| S8 | Android SDK/AVD leftovers (`~/.android/avd`, `~/Android/Sdk/system-images`) old API levels | du | `sdkmanager --uninstall` | Medium; skip unless user opts in |

### Inferences
- S3 (global caches) is the best new item: one scan of fixed paths, each with an official one-line prune command. Sizes only, consistent with the "no contents" rule.
- S5 requires a daemon probe; weigh against "scans never run repo code" (Docker CLI is not repo code, but Compose files can specify builds, so never run `compose` subcommands in scan).

### Gaps
- No authoritative source fetched for cargo-sweep, cargo-cache, sccache, Gradle cache cleanup, `docker system df` label names (all prior knowledge, unverified).

## 7. Release hygiene

### Takeaway
GutCheck already compares highest tag to the root manifest and flags old releases with 5+ unreleased commits. Gaps are *cross-manifest* version consistency (Tauri/Electron/Cargo/pyproject together) and release-asset integrity.

### Cited Findings
- Existing: highest tag vs root manifest, changelog naming newest version, 5+ commits over 90 days — docs/sources.md ([semver.org](https://semver.org/), [Keep a Changelog](https://keepachangelog.com/)).
- Go modules, Rust `Cargo.toml` and Python `pyproject.toml` each carry their own version; Tauri carries `version` in `tauri.conf.json` and `Cargo.toml` (unverified specifics; Tauri docs not fetched).
- Gradle docs say a wrapper JAR hash should be checked against Gradle's published checksums, the same idea as release-asset checksums — [Gradle wrapper docs](https://docs.gradle.org/current/userguide/gradle_wrapper.html)

### Candidate checks
| # | Detect | Read-only how | Fix | Risk |
|---|---|---|---|---|
| R1 | Version mismatch across manifests in one repo: `package.json` vs `src-tauri/Cargo.toml` vs `src-tauri/tauri.conf.json` (`version`, or `package.json` reference in Tauri v2), `Cargo.lock` self-entry, `pyproject.toml` `[project] version` vs `__version__`/`importlib.metadata`; Android `versionName`/`versionCode` (vs package.json for Capacitor) | Parse JSON/TOML/gradle regex | Align to highest; fix via edit in plan/preview | Low-medium. `dynamic = ["version"]` in pyproject, Tauri's package.json reference and Cargo workspace-inherited versions are legitimate: skip them |
| R2 | `package-lock.json` root version != `package.json` version (common after hand-bumping) | Parse | `npm install --package-lock-only` step | Low; exact and well-known |
| R3 | Android `versionCode` not incremented since last tag | `git show <tag>:app/build.gradle` vs HEAD | Bump | Low-medium; Play rejects duplicate codes (unverified) |
| R4 | GitHub release has assets but no checksum file / attestations | `gh release view --json assets` (read-only API) for `*.sha256`, `SHA256SUMS`, `*.sig`, `*.intoto.jsonl`; `gh attestation` (unverified) | Add checksum step to release workflow | Low; contradicts "SBOM/signing not checked" slightly, so keep to info on repos that publish binaries |
| R5 | Tag exists but no GitHub release, or release is draft/prerelease for months | `gh api repos/o/r/releases` | Publish/delete | Low |
| R6 | CHANGELOG `[Unreleased]` empty while unreleased commits exist (reverse of existing), or compare links at bottom missing for Keep a Changelog | Parse markdown headers | Add entries | Low; subjective |
| R7 | Rust crate `publish` state: crate published version vs local (crates.io API) | HTTP GET | Info | Low; niche |

### Inferences
- R1 and R2 are the high-signal ones for Electron/Tauri/Capacitor users, who always have two or three version fields to keep in step.

### Gaps
- Tauri v2 config schema for version, Keep a Changelog 1.1 compare-link rules, GitHub release attestation CLI not fetched.

## Priority shortlist (my ranking, inference)
1. E1/E2/E3 EOL runtimes from pins and CI (endoflife.date, Node 25 EOL since 2026-06-01, Python 3.10 EOL since 2026-10-01, Go 1.25 unsupported).
2. D1 OSV vulnerability scan from lockfiles, opt-in network.
3. T1 Corepack/`packageManager` on Node 25+, plus T5/T6/T7 lockfile presence and drift.
4. H1 Actions Node-runtime age, H2 Dependabot ecosystem coverage.
5. S3 global cache sizes with official prune commands, S1/S2 build dirs.
6. R1/R2 cross-manifest version sync.
7. L1-L3 licence field consistency.
Skip or deprioritise: D6 typosquats, L5 dependency licence conflicts, S8, REUSE.

## Fetch/verification limits
Tool budget used about 15 calls. endoflife.date Swagger page and REUSE spec rendered empty; the rest of the "unverified" items above are explicitly marked. Search-result summaries (Corepack, Node schedule, Play, GitHub Node 20) came with secondary sources; the Node blog and Play requirement pages are the primary sources to re-open before shipping rules.
