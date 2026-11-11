# Local git repository maintenance and health checks GutCheck could add (as of Nov 2026)

Scope note: docs/sources.md says GutCheck already covers stashes, upstream gone, prunable worktrees, submodules, loose objects over gc.auto 6700 (suggesting `git maintenance start`), stray files, a missing .gitattributes (`* text=auto`), file/repo size thresholds (5/50/100 MB files, 1/5 GB repo, deep scan for 50 MB+ blobs), global user.email / credential.helper=store / global gitignore. It deliberately skips git fsck (slow), performance settings, and signed commits. Everything below is meant to be NEW or a refinement. Items marked [memory] come from the fetch tool answering from general knowledge rather than the page; verify before shipping.

## 1. git maintenance, pack/loose-object/commit-graph health

### Takeaway
GutCheck's loose-object check is only one of several auto-maintenance triggers git itself uses. Git's own `--auto` thresholds (commit-graph lag 100, loose objects 100 per task, packs outside the MIDX 10, gc.autoPackLimit 50 packs) plus `count-objects -v` fields (packs, garbage, prune-packable) and the registration state in global `maintenance.repo` give cheap, read-only signals. Since git 2.54 manual `git maintenance run` defaults to the geometric strategy, and `maintenance start` (strategy=incremental) is still the recommended always-on setup.

### Cited Findings
- `git maintenance register` adds the repo to global `maintenance.repo`, sets `maintenance.strategy=incremental` if unset, and sets `maintenance.auto=false` in that repo; `start` runs register and installs hourly/daily/weekly schedules (systemd user timers `git-maintenance@{hourly,daily,weekly}.timer` on Linux where available, else crontab). — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- Incremental strategy schedule: commit-graph and prefetch hourly, loose-objects and incremental-repack daily, pack-refs weekly; gc is NOT scheduled. Default for scheduled maintenance without a strategy is none. — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- `--auto` thresholds: commit-graph 100 reachable commits not in graph; loose-objects 100 loose; incremental-repack 10 packs not in the multi-pack-index; geometric-repack 6700 (loose objects, or packs needing merge); reflog-expire 100 expired entries; rerere-gc 512 stale entries; worktree-prune more than 1 prunable worktree. Keys are `maintenance.<task>.auto`; 0 disables, negative forces. — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- `git maintenance is-needed --auto` exits 0 if maintenance is needed (documented), a ready-made read-only probe. — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- `prefetch` writes to `refs/prefetch/` and does not move remote-tracking branches; `remote.<name>.skipFetchAll` excludes a remote. Scheduled runs take the object DB lock and can skip overlapping tasks. — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- Git 2.54 (Apr 2026): `git maintenance run` now defaults to the geometric strategy instead of gc; `maintenance.strategy=gc` restores the old behaviour. Geometric was introduced as opt-in in 2.52 and falls back to a full gc if the geometric repack would consolidate everything into one pack. — [Highlights 2.54](https://github.blog/open-source/git/highlights-from-git-2-54/), [Highlights 2.52](https://github.blog/open-source/git/highlights-from-git-2-52/). The docs describe geometric as recommended for large repos and the default for manual maintenance. — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- Git 2.55 (Jun 2026): incremental MIDX layers (`git repack --write-midx=incremental --geometric=2 -d`, `repack.midxSplitFactor`, `repack.midxNewLayerThreshold`), faster bitmap generation, `--path-walk` with filters. — [Highlights 2.55](https://github.blog/open-source/git/highlights-from-git-2-55/)
- git-gc defaults: `gc.auto` 6700 loose objects; `gc.autoPackLimit` 50 packs (not `*.keep`); `gc.pruneExpire` 2 weeks; `gc.reflogExpire` 90 days; `gc.reflogExpireUnreachable` 30 days; `gc.cruftPacks` true; `gc.worktreePruneExpire` 3 months; `gc.logExpiry` 1 day. — [git-gc](https://git-scm.com/docs/git-gc)
- If `.git/gc.log` exists, `git gc --auto` prints it and exits 0 without doing housekeeping unless the file is older than `gc.logExpiry`. Typical trigger is the "There are too many unreachable loose objects" warning (recent unreachable objects survive the 2-week prune window). Reported workaround: `git prune` then delete gc.log. Version behaviour varies ("gc: ignore old gc.log files" changed it; release not confirmed). — [git-gc](https://git-scm.com/docs/git-gc), [search summary of git mailing-list threads](https://public-inbox.org/git/20180716203847.GE25189@sigill.intra.peff.net/)
- `git count-objects -v` fields: count, size (loose), in-pack, packs, size-pack, prune-packable (loose objects also in a pack, removable by `git prune-packed`), garbage and size-garbage (files in the object DB that are neither valid loose objects nor packs), alternate. The manual says it helps decide when to repack. — [git-count-objects](https://git-scm.com/docs/git-count-objects)

### Candidate checks
| Check | Detect (read-only) | Fix | Risk | Source |
|---|---|---|---|---|
| Pack pile-up | `git count-objects -v`: `packs` > 50 (gc.autoPackLimit) or > 10 with no MIDX | `git maintenance run --task=incremental-repack` or `git gc` | low (gc rewrites packs; no history change) | git-gc, git-maintenance |
| Garbage in object DB | `count-objects -v`: `garbage` > 0 / `size-garbage` | list files with `find .git/objects -name 'tmp_*'` then `git gc`; investigate manually | low | git-count-objects |
| Redundant loose objects | `prune-packable` > 0 | `git prune-packed` | low | git-count-objects |
| Blocked auto-gc | `.git/gc.log` exists and is newer than `gc.logExpiry` (stat + read first lines) | read log; `git prune` then remove gc.log (plan step shows the log text) | low-medium (prune drops unreachable objects; reflog-only commits would go if gc.pruneExpire=now) | git-gc |
| Missing/stale commit-graph | `test -f .git/objects/info/commit-graph` or `commit-graphs/`; `git rev-list --count --all` large (e.g. > 10k commits) with none; check `core.commitGraph`/`fetch.writeCommitGraph` | `git commit-graph write --reachable --changed-paths` or maintenance | low | git-maintenance |
| Not registered for maintenance | `git config --global --get-all maintenance.repo` lacks repo path; also `git config --get maintenance.strategy` | `git maintenance register` (writes global config + this repo's maintenance.auto=false; show both) | low; changes persistent global config so needs explicit preview. `register` and `start` install timers (user-level only) | git-maintenance |
| Scheduler not installed | `systemctl --user list-timers 'git-maintenance@*'` or `crontab -l \| grep 'git for-each-repo'` | `git maintenance start` | low | git-maintenance |
| Maintenance enabled but strategy missing/old | `maintenance.strategy` unset on git >= 2.54 | set `maintenance.strategy=geometric` (large) or leave | low | Highlights 2.54 |
| Loose refs bloat | count files under `.git/refs` vs size of `packed-refs`; `git for-each-ref \| wc -l` | `git pack-refs --all` / `git refs optimize --auto` (alias, added by git 2.5x; docs list it, release not stated) | low | git-refs |
| Reflog / rerere / worktree prune pending | thresholds above (reflog-expire.auto 100, rerere-gc 512) | `git maintenance run --task=...` | low; reflog expiry removes the ability to recover old amended commits (after 30/90 days) | git-maintenance |

### Inferences
- A "Maintenance" finding could aggregate the signals above into one info-level item with a single `git maintenance register` + `start` fix, instead of the current loose-object-only advice.
- `git maintenance is-needed --auto` may not exist on older git; fall back to the count-objects heuristics. (The docs page lists it with no version.)
- The scheduled-maintenance `maintenance.repo` list is global config; a scan can read `git config --global --get-all maintenance.repo` safely and compare with each repo path (watch trailing slashes and symlinks).

### Gaps
- Exact git release that added `is-needed`, `geometric` task, `git refs optimize` could not be confirmed (git-scm pages say "last updated 2.56.0" but do not tag versions).
- No benchmark data on how many packs/loose objects hurt real-world performance beyond git's own defaults.

## 2. Repo size and structure: git-sizer and GitHub thresholds

### Takeaway
git-sizer's readme limits are: whole repo ideally < 1 GiB (unwieldy above 5 GiB), refs "a few tens of thousands at most", trees under "a couple of thousand" entries, path length 100-200 chars. Its source gives per-asterisk scales for every metric that GutCheck could replicate without running git-sizer (e.g. via `git for-each-ref | wc -l`, `git cat-file --batch-all-objects --batch-check`, `git ls-tree -r -t --long`).

### Cited Findings
- git-sizer limits: overall < 1 GiB ideal, > 5 GiB unwieldy; refs few tens of thousands at most; avoid trees with more than a couple of thousand entries; a few blobs in the MB range OK; path length one or two hundred characters; avoid octopus merges with dozens of parents. Level of concern is shown as asterisks (`!` = more than 30); `--threshold=<n>` hides values under n and `--critical` = 30. — [git-sizer README](https://github.com/github/git-sizer)
- git-sizer source scale per asterisk: refs 25,000; tags 25,000; max tree entries 1,000; max blob 10 MB (decimal); max commit size 50 KB; max parents 10; history depth 500,000; checkout path depth 10; path length 100 B; checkout tree count 2,000; checkout file count 50,000; checkout size 1 GB; symlinks 25,000; submodules 100; unique blobs 1.5 M, unique blob size 10 GB; unique trees 1.5 M; unique commits 500,000. A value of N scale units shows N asterisks (cap 30). — [git-sizer sizes/output.go](https://raw.githubusercontent.com/github/git-sizer/master/sizes/output.go) (extracted by the fetch tool; spot-check against source before hard-coding)
- GitHub: files over 50 MiB warn on push, over 100 MiB are blocked, browser uploads 25 MiB, repo recommended < 1 GB and strongly < 5 GB. (GutCheck already encodes these.) — [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github). The page gives no number for ref count or push size.
- Git 2.52 adds experimental `git repo structure` (ref counts by branch/tag/remote/other and reachable object counts) and `git repo info` (`layout.bare`, `layout.shallow`, `object.format`, `references.format`). — [Highlights 2.52](https://github.blog/open-source/git/highlights-from-git-2-52/)

### Candidate checks
| Check | Detect | Fix | Risk | Source |
|---|---|---|---|---|
| Too many refs | `git for-each-ref --format=x \| wc -l` > 25,000 (1 asterisk); `refs/` subtree counts for `refs/remotes`, `refs/tags`, `refs/pull`, `refs/prefetch`, `refs/stash` | prune remote-tracking (`git remote prune`), delete merged local branches, `fetch.pruneTags`; refs/pull from mirror clones are not removable | low-medium | git-sizer |
| Wide tree | `git ls-tree -r -t HEAD` grouped by dir > 1,000 entries (or `git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectsize)'`) | restructure (advice only) | none (advisory) | git-sizer |
| Deep or long paths | max `git ls-files` path depth > 10, length > 100 (200+ breaks Windows 260-char limit) | advice | none | git-sizer |
| Many parents / huge commit | `git rev-list --all --parents` fields > 10 | advice | none | git-sizer |
| Checkout size | sum of `git ls-tree -r -l HEAD` sizes > 1 GB | sparse-checkout / LFS | none | git-sizer |

### Inferences
- GutCheck's existing 50 MB file warning aligns with GitHub; git-sizer's 10 MB-per-asterisk scale means an info tier at 10 MB would be much earlier than GutCheck's current 5 MB info tier, so no change needed there.
- Refs count is a cheap, new signal; the main practical offender is mirrored/forked clones with `refs/pull/*` and bot branches, not personal repos.

### Gaps
- No authoritative published GitHub limit on ref count or tree entries found on the fetched page.
- Output.go figures came from an LLM-summarised fetch; treat as approximate.

## 3. Stale and in-progress local state

### Takeaway
Unfinished operations are detectable by marker files (git-prompt.sh is the canonical reference) and are high-value, low-risk "attention" findings. Worktree prunable/locked state is in `git worktree list --porcelain`.

### Cited Findings
- git-prompt.sh recognises: `rebase-merge/` (interactive/merge backend), `rebase-apply/` (with `rebasing` = rebase, `applying` = am), `MERGE_HEAD`, `CHERRY_PICK_HEAD` or `sequencer/todo` first line starting `pick`, `REVERT_HEAD` or `sequencer/todo` starting `revert`, `BISECT_LOG`. Detached HEAD: `HEAD` file not starting with `ref: `. Sparse checkout via `core.sparseCheckout`. — [git-prompt.sh](https://raw.githubusercontent.com/git/git/master/contrib/completion/git-prompt.sh) (paths are relative to `git rev-parse --git-dir`; with reftable or worktrees use `--git-path`)
- `git worktree list --porcelain` emits `locked [reason]` and `prunable <reason>` lines (stable format; `-z` for odd paths). A worktree is prunable when its admin entry is stale (checkout deleted or moved without `git worktree move`); locked worktrees are never prunable. `git worktree prune --dry-run` previews; `git worktree repair` fixes moved ones; `gc.worktreePruneExpire` default 3 months. — [git-worktree](https://git-scm.com/docs/git-worktree)
- Git 2.54 adds `status.compareBranches` (`@{upstream} @{push}`) so `git status` can show divergence from the push remote as well as upstream. — [Highlights 2.54](https://github.blog/open-source/git/highlights-from-git-2-54/)

### Candidate checks
| Check | Detect | Fix | Risk |
|---|---|---|---|
| Operation left in progress | any of the marker paths above, plus `.git/AUTO_MERGE`, `.git/REBASE_HEAD` [memory, unconfirmed]; age by mtime (> 7 days = stale) | show `git status`; user runs `--continue` / `--abort` (GutCheck should offer only `--abort` preview, never auto) | medium: abort discards conflict resolutions in progress |
| Detached HEAD with unreferenced commits | `git symbolic-ref -q HEAD` fails and `git rev-list HEAD --not --branches --tags --remotes \| head` non-empty | `git switch -c rescue-<date>` | low |
| Branches whose upstream is gone (non-current) | `git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads \| grep '\[gone\]'` (GutCheck already warns for the current branch only) | `git branch -d` for merged ones; show unmerged | low for `-d`; `-D` only after preview |
| Stale remote-tracking refs | `git remote prune <r> --dry-run` (does not contact? it DOES contact remote; scans must be offline), so use `git for-each-ref refs/remotes` compared with `git ls-remote` only in opt-in mode | `fetch.prune=true` | low |
| Stale rerere cache | count dirs in `.git/rr-cache` older than gc thresholds (rerere-gc auto 512) | `git rerere gc` | low |
| Old stashes (refinement) | `git stash list --format='%gd %ct'`; flag > 90 days (matches gc.reflogExpire 90 days: older stash entries are not auto-expired because stash reflog is kept) | none destructive; export `git stash show -p` before drop | medium |
| Locked worktree with missing path | porcelain `locked` plus path missing | `git worktree unlock` then prune | low-medium |
| Orphaned `.git/index.lock` / `shallow.lock` / `HEAD.lock` | stat files named `*.lock` under `.git`, check no git process via `/proc` (`pgrep -f 'git '`) | remove lock after confirm | medium (removing a live lock corrupts work) |

### Inferences
- GutCheck already tracks "uncommitted work"; an "operation in progress" state is the most common cause of agents/scripts misbehaving and is not listed in sources.md, so it is a likely gap (not confirmed from GutCheck source code, only from docs/sources.md).
- Stale remote-tracking pruning must be computed offline: compare `refs/remotes/origin/*` against the last fetch time (`.git/FETCH_HEAD` mtime) and warn when `fetch.prune` is unset and gone-count is high.

### Gaps
- Did not verify `AUTO_MERGE`/`REBASE_HEAD` behaviour; did not find a primary source on stash reflog expiry semantics (stash entries are in `refs/stash` reflog; the claim that they are exempt from age-based expiry is from memory).

## 4. Config hygiene

### Takeaway
Recommendations below are widely agreed but the fetch of git-config returned values from memory, not the page ([memory]). Git 3.0's planned changes (BreakingChanges doc) are the authoritative reason to set several explicitly now.

### Cited Findings
- Planned Git 3.0 breaking changes: default hash sha256; `init.defaultRefFormat=reftable` (opt in now); default branch `main` (`init.defaultBranch`); Rust mandatory (2.55 enables by default in builds); `safe.bareRepository` changes from `all` to `explicit`; removal of grafts (`info/grafts`, replaced by `git replace`), `git pack-redundant`, `.git/branches/` and `.git/remotes/` shorthands, `git name-rev --stdin`, `git whatchanged`, `core.commentString=auto`, `core.preferSymlinkRefs=true`. `WITH_BREAKING_CHANGES` builds preview 3.0. Check an existing repo's hash with `git rev-parse --show-object-format`. — [BreakingChanges](https://git-scm.com/docs/BreakingChanges)
- `git refs migrate --ref-format=reftable [--dry-run]`: repos with worktrees cannot be migrated; no write blocking; unregister from maintenance first. — [git-refs](https://git-scm.com/docs/git-refs)
- Git 2.54: config-defined hooks via `[hook "<name>"]` (`event`, `command`), `hook.<name>.enabled=false`, `git hook list <event>`; 2.55 adds `hook.<name>.parallel`, `hook.jobs`. Hooks in config can live in a repo's local config, which for GutCheck means a repo can define hooks the scan must still never run (existing hook-disabling needs to cover config hooks, see Gaps). — [Highlights 2.54](https://github.blog/open-source/git/highlights-from-git-2-54/), [Highlights 2.55](https://github.blog/open-source/git/highlights-from-git-2-55/)
- Git 2.55: built-in `core.fsmonitor` daemon now works on Linux via inotify; very large repos may need a higher `fs.inotify.max_user_watches`; network mounts remain opt-in. — [Highlights 2.55](https://github.blog/open-source/git/highlights-from-git-2-55/) (note: relevant to GutCheck's "no fsmonitor in scans" rule, which already disables it).
- git-config documents `includeIf` conditions `gitdir:`, `gitdir/i:`, `worktree:`, `onbranch:`, `hasconfig:remote.*.url:`. — [git-config](https://git-scm.com/docs/git-config)
- [memory] Common recommendations: `fetch.prune=true`, `pull.rebase=true` (or `pull.ff=only`), `init.defaultBranch=main`, `rerere.enabled=true`, `push.autoSetupRemote=true`, `merge.conflictStyle=zdiff3`, `diff.algorithm=histogram`, `branch.sort=-committerdate`, `user.useConfigOnly=true`, `transfer.fsckObjects=true`, never `safe.directory=*`, `core.untrackedCache`/`feature.manyFiles`/fsmonitor only for big worktrees. These come from the fetch tool's unattributed summary; the git-scm page was truncated (first 100k of 448k chars read). Cite git-config per key when implementing.

### Candidate checks
| Check | Detect | Fix | Risk | Source |
|---|---|---|---|---|
| Wrong identity in repo (work vs personal) | `git config user.email` effective vs remote host/owner: e.g. repo with github.com remote owner X but email domain matches employer list; compare with the author email of the last N commits `git log -n 20 --format=%ae`; flag if repo's commits use 2+ emails or local email unset (falls back to hostname-derived `user@host.localdomain`: `git var GIT_AUTHOR_IDENT`) | `includeIf "gitdir:~/work/"` with a path file; set `user.email` locally; `user.useConfigOnly=true` | low; config only. History rewrite (mailmap) is out of scope | git-config |
| Autogenerated identity | `git var GIT_COMMITTER_IDENT` shows `localdomain`/`(none)` | set identity | low | git-config |
| `safe.directory='*'` or broad entries | `git config --global --get-all safe.directory` | remove `*` | low (security hardening) [memory] | git-config |
| Unsafe `core.hooksPath` / config hooks in repo-local config | `git config --local --get-regexp '^(core\.hooksPath\|hook\..*)'` | report only | none | Highlights 2.54 |
| Missing `fetch.prune` | `git config --get fetch.prune` unset while gone upstream branches exist | `git config --global fetch.prune true` | low | git-config [memory] |
| Reftable / sha256 awareness | `git rev-parse --show-object-format`, `git rev-parse --show-ref-format` [memory], `git config extensions.refStorage` | info only; migration is advisory (no worktrees) | high if migrated while tools lack support | BreakingChanges, git-refs |
| Removed-in-3.0 usage | `.git/info/grafts` exists; `.git/remotes/` or `.git/branches/` exists; `core.preferSymlinkRefs=true`; `core.commentString=auto` | `git replace --graft`, `git remote add` equivalents | low-medium (grafts: `git replace --convert-graft-file`) [memory on command] | BreakingChanges |
| Commit signing half-configured | `commit.gpgSign=true` with `gpg.format` unset and `user.signingkey` unset, or signing key absent | set/unset | low | [memory] |
| `transfer.fsckObjects` | unset | set true (costs CPU) | low | [memory] |

### Inferences
- Config hygiene findings should be workspace-level (global config), listed once, since GutCheck's workspace git config check already exists; extend it rather than adding per-repo noise.
- `core.untrackedCache`, `feature.manyFiles` and fsmonitor are only worth surfacing when `git ls-files | wc -l` exceeds ~50-100k (threshold is my inference, no source found).

### Gaps
- The git-config page was only partially read; defaults per key are not individually cited. No source found for a "work vs personal email" convention beyond includeIf docs and GitHub's commit-email page (already cited in sources.md).
- Not verified: whether existing GutCheck hook-disabling (`core.hooksPath` blanking) also covers the new config-based hooks (`hook.<name>.command`). Worth testing since 2.54+ git will run those on commit/push events. Needs checking in src/exec.js (not done here).

## 5. Integrity: fsck, shallow/partial clones, LFS

### Takeaway
A full `git fsck` stays too slow for every scan, but `--connectivity-only --no-dangling --no-reflogs`-style runs, `git commit-graph verify`, and `git refs verify` are cheaper opt-in "deep check" candidates. LFS pointer problems are detectable without running filters by reading blobs directly.

### Cited Findings
- fsck severities: most problems are ERROR (missingObject, badTree, badParentSha1, badRefOid, gitmodules*/gitattributes* checks ...); WARN includes hasDotgit, largePathname, zeroPaddedFilemode, nullSha1; INFO includes badFilemode, symlinkRef. `--connectivity-only` skips blob reads (misses blob corruption); `--no-dangling` omits dangling output; `--lost-found` is the only option that writes into the repo; `--full` is now default; commit-graph is verified via `git commit-graph verify` when `core.commitGraph` is true; ref DB verified via `git refs verify` by default. `fsck.<msg-id>`, `fsck.skipList`, `receive.fsck.*` and `fetch.fsck.*` do not inherit from one another. — [git-fsck](https://git-scm.com/docs/git-fsck)
- `git refs verify [--strict] [--verbose]` verifies the ref database; the docs do not state read-only explicitly. — [git-refs](https://git-scm.com/docs/git-refs)
- git-lfs pointer spec: UTF-8, first line `version https://git-lfs.github.com/spec/v1`, then `oid sha256:<hex>` and `size <bytes>`, whole pointer under 1024 bytes; smudge checks the first 100 bytes. — [Git LFS spec](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
- `git lfs fsck` checks LFS files at HEAD (`--objects`: hash and existence; `--pointers`: canonical pointers and files that should be LFS). A normal run moves corrupt files to `.git/lfs/bad`, so it is not strictly read-only; `--dry-run` avoids that. The page does not say whether it runs filters. — [git-lfs-fsck](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-fsck.adoc)
- `git repo info` reports `layout.shallow`; (shallow-detection alternative: `git rev-parse --is-shallow-repository`, [memory]). — [Highlights 2.52](https://github.blog/open-source/git/highlights-from-git-2-52/)

### Candidate checks
| Check | Detect | Fix | Risk |
|---|---|---|---|
| Opt-in "Verify integrity" deep action | `git fsck --connectivity-only --no-dangling --no-progress`; add `git commit-graph verify`, `git refs verify` (when git has it) with `GIT_NO_LAZY_FETCH=1` for partial clones | on failure: `git fetch` to restore missing objects, delete+rewrite commit-graph (`git commit-graph write`), never `gc --prune=now` | low; fsck takes no write locks except lost-found |
| Missing objects in a partial clone | `git config remote.<r>.promisor`, `extensions.partialClone`; `git rev-list --objects --missing=print HEAD` lists missing blobs (does not fetch when `GIT_NO_LAZY_FETCH=1`) [memory on flag combo] | `git fetch`; `git backfill` (experimental in 2.5x partial clones) | medium, hits network |
| Accidental shallow clone | `git rev-parse --is-shallow-repository` or `.git/shallow` exists | `git fetch --unshallow` (network, grows repo) | medium: size growth |
| LFS pointers not smudged in working tree | tracked paths matching `filter=lfs` (`git ls-files --eol`, or `git check-attr filter -- <paths>` reads attributes only) whose worktree file starts with `version https://git-lfs.github.com/spec/v1` and size < 1024 | `git lfs pull` / `git lfs checkout` (network) | low |
| Large files that should be LFS | tracked blobs > 5-50 MB not under `filter=lfs` (existing large-file check) and `.gitattributes` has no lfs rule; `git lfs` installed? | `git lfs track` + `git lfs migrate import` (rewrites history: preview only, owner-approved) | high (history rewrite) |
| LFS object store missing | `git lfs ls-files` (reads index; may invoke lfs binary, which GutCheck already runs as trusted global filter) vs `.git/lfs/objects` | `git lfs fetch` | low |
| LFS hooks missing | `.git/hooks/pre-push` lacks `git lfs pre-push` when repo has `filter=lfs` attributes | `git lfs install --local` (writes hooks: weigh against "never run repo code"; it only writes) | low-medium |
| Dangling work worth rescuing | `git fsck --lost-found` is a write; instead `git fsck --no-reflogs --unreachable \| grep commit` | advisory | none |

### Inferences
- sources.md already refuses full fsck on every scan; a per-repo opt-in "Check integrity" action in the same style as opt-in `tests-run` fits GutCheck's rules.
- Pointer detection is best done with `git cat-file --batch` on `HEAD:<path>` for small blobs (< 1024 B) beginning with the version line, which finds committed-as-pointer files; for the worktree, read the first 100 bytes of the file directly (no filter involved).

### Gaps
- Unconfirmed whether `git lfs fsck --dry-run` runs any smudge/clean filters; treat as not safe under scan rules until confirmed from source.
- No authoritative source found on fsck wall-time per GB.

## 6. Line endings and attributes

### Takeaway
GutCheck only checks for the presence of `.gitattributes`. `git ls-files --eol` can detect mixed/CRLF content and mismatches between index and attributes, enabling a precise "renormalize" finding.

### Cited Findings
- `text` normalizes to LF on add; `text=auto` lets git detect (and skips files already CRLF in the index); `-text` disables; `eol=lf|crlf` sets working-tree style; `binary` macro = `-diff -merge -text`; unspecified falls back to `core.autocrlf`. To adopt normalization: write `* text=auto`, `git add --renormalize .`, review `git status`, commit. — [gitattributes](https://git-scm.com/docs/gitattributes)
- `git ls-files --eol` prints `i/<eol> w/<eol> attr/<attrs> <path>` with values lf, crlf, mixed, -text; `i/mixed` or `i/crlf` under `text=auto` indicate files needing renormalization. — [gitattributes page text](https://git-scm.com/docs/gitattributes) (attributed to git-ls-files manual by the fetch tool; format from that manual)
- `core.safecrlf` (true/warn) flags irreversible conversions; `core.autocrlf=true` normalizes only files added from now on. — [gitattributes](https://git-scm.com/docs/gitattributes)

### Candidate checks
| Check | Detect | Fix | Risk |
|---|---|---|---|
| Mixed line endings in index | `git ls-files --eol \| awk '$1=="i/mixed"'` | per-file fix + `* text=auto`, `git add --renormalize .` (creates a large noisy commit) | medium: rewrites blame; touches many files |
| CRLF committed in LF-first repo | `i/crlf` on shell scripts (`*.sh`), Makefile, Dockerfile, shebang files (CRLF in shebang breaks Linux execution) | `*.sh text eol=lf` | low-medium |
| Working tree diverges from attributes | `w/crlf` with `attr/` `eol=lf` or `text=auto` and `core.autocrlf` unset on Linux | `git add --renormalize .`/re-checkout | low |
| Missing binary rules | `.gitattributes` has `text=auto` but binary-like tracked files (images, `.pdf`, `.zip`) lacking `-text`/`binary` | add `*.png binary` | low |
| Safecrlf | `git config core.safecrlf` unset but `core.autocrlf` set | info | low |

### Inferences
- Because `ls-files --eol` inspects content and attributes, it should not execute filters (`text`/`eol` are built-in conversions), but I did not confirm that it ignores `filter=` drivers, and it reads the worktree files, so run it through `ctx.safeGit`.

### Gaps
- Did not research `.gitattributes` `export-ignore`, `merge=` drivers, `linguist-*` (out of scope).

## 7. What is new in Git 2.45 to 2.55 (2024-2026)

### Cited Findings
- Release dates (GitHub Blog "Highlights" posts): 2.45 Apr 29 2024; 2.46 Jul 29 2024; 2.47 Oct 7 2024; 2.48 Jan 10 2025; 2.49 Mar 14 2025; 2.50 Jun 16 2025; 2.51 Aug 18 2025; 2.52 Nov 17 2025; 2.54 Apr 20 2026; 2.55 Jun 29 2026 (no 2.53 post listed; 2.53 exists per git-scm docs "latest 2.53.0" on one page; git-maintenance/git-refs pages already show 2.56.0). — [GitHub Blog git archive](https://github.blog/open-source/git/)
- 2.52: `git repo info/structure` (experimental), `git refs exists/list`, `git last-modified`, `maintenance` geometric task, `git sparse-checkout clean`, Rust build auto-detect. — [Highlights 2.52](https://github.blog/open-source/git/highlights-from-git-2-52/), [BreakingChanges](https://git-scm.com/docs/BreakingChanges)
- 2.54: geometric strategy default for manual maintenance; config hooks; `git history reword/split` (experimental); `git backfill` ranges; `status.compareBranches`; HTTP 429 retries (`http.maxRetries`...); incremental MIDX compaction. — [Highlights 2.54](https://github.blog/open-source/git/highlights-from-git-2-54/)
- 2.55: incremental MIDX layers, bitmap speedups, parallel hooks, Linux inotify fsmonitor, `remotes.<name>` groups for push, sideband control-character masking. — [Highlights 2.55](https://github.blog/open-source/git/highlights-from-git-2-55/)
- Reftable: opt-in via `init.defaultRefFormat=reftable` and `git refs migrate`; planned default in Git 3.0. — [BreakingChanges](https://git-scm.com/docs/BreakingChanges), [git-refs](https://git-scm.com/docs/git-refs)

### Inferences
- Version-gating matters: GutCheck should read `git --version` and only offer `maintenance.strategy=geometric`, `git refs optimize`, `git repo structure`, config hooks on versions that have them (2.52+, 2.54+).
- Reftable repos have no `.git/refs/heads/*` files and no `packed-refs`; any scanner reading loose refs, `HEAD` text (git-prompt notes the `files`-backend assumption) or `.git/refs` directly must use `git for-each-ref` / `git rev-parse --git-path` instead.

### Gaps
- Did not read the 2.45 to 2.51 posts or 2.53; items there (e.g. 2.47 `git maintenance` / `--refs-snapshot`, 2.49 name-hash v2, 2.50 cruft pack merge) were not verified and are omitted.
- Outdated/flag: the common advice "run `git gc` weekly" is superseded by `maintenance.strategy=incremental|geometric` per git-maintenance; `core.autocrlf` global setting is superseded by `.gitattributes` per git docs.

## Prioritised shortlist for GutCheck (my ranking, inference)
1. Operation in progress (rebase/merge/cherry-pick/revert/bisect, stale > N days) and detached HEAD with unreferenced commits.
2. Maintenance health bundle: pack count, garbage, prune-packable, blocked gc.log, missing commit-graph, not registered, one fix `git maintenance register` + `start`.
3. LFS pointer not smudged / LFS objects missing; mixed or CRLF line endings via `ls-files --eol`.
4. Wrong or autogenerated identity per repo (`git var GIT_AUTHOR_IDENT`, commit-email diversity), with includeIf fix.
5. Shallow and partial clone notices (info), reftable/sha256 awareness and Git-3.0 removals (grafts, `.git/remotes`).
6. Opt-in integrity check (`fsck --connectivity-only`, `commit-graph verify`, `refs verify`).
7. Ref-count, wide-tree, path-length advisories from git-sizer scales.
