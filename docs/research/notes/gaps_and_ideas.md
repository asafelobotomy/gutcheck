# Capability gaps for GutCheck (local multi-repo health tool): landscape and ratings

Method note: about 21 web searches, no page-level fetches. Many claims come from search summaries of docs, blogs and vendor pages. Anything not confirmed on a primary source is marked UNVERIFIED. No HN/Reddit threads with reaction counts were retrieved, so "demand" evidence is mostly qualitative. Nothing was run in the background.

## 1. Policy as code across repos, and drift detection

### Takeaway
Safe Settings (org-level GitHub App) and Allstar (OpenSSF GitHub App) are the real offerings, both aimed at orgs and server-hosted. Nothing local and personal-scale was found. A small declared baseline file (settings, files, workflows) checked locally with a drift report is a genuine gap. Rating: HIGH value, MEDIUM effort.

### Cited Findings
- Safe Settings is a GitHub App for policy-as-code across an organization. It uses webhook detection for immediate response and scheduled syncs for periodic convergence. Settings live in a central admin repo and it can be limited to a subset of repos — [Mintlify Safe Settings drift docs](https://mintlify.com/github/safe-settings/advanced/drift-prevention); [repo](https://www.github.com/github/safe-settings)
- Allstar monitors orgs/repos for security-policy adherence. On a violation it can log, open an issue, or revert the setting. Initial policies: branch protection, SECURITY.md, outside-collaborator admin, binary artifacts. Policies are YAML and opt-in — [OpenSSF blog](https://openssf.org/blog/2021/08/11/introducing-the-allstar-github-app/); [Help Net Security](https://www.helpnetsecurity.com/2021/08/11/security-github-projects/)
- Port, Cortex and OpsLevel ship scorecards (rules with Bronze/Silver/Gold levels, e.g. "README exists") as core features. Backstage has no native scorecards (plugins only). These are internal-developer-portal products for orgs, and the sources are vendor-heavy — [Port scorecards docs](https://docs.backstage-plugin.port.io/features/scorecards); [OpsLevel comparison](https://opslevel.com/resources/port-vs-cortex-whats-the-best-internal-developer-portal)
- OpenSSF Scorecard CLI can be run on a repo, with checks such as Maintained (90-day activity) and Pinned-Dependencies (Medium risk). Policy-file format not confirmed — [pkg.go.dev scorecard v5](https://beta.pkg.go.dev/github.com/ossf/scorecard/v5)
- Repolinter: last push in the ecosyste.ms snapshot is 2024-05-13; its dashboard repo is archived. Main repo archive status UNVERIFIED — [ecosyste.ms repolinter](https://awesome.ecosyste.ms/projects/github.com%2Ftodogroup%2Frepolinter); [dashboard](https://awesome.ecosyste.ms/projects/github.com%2Ftodogroup%2Frepolinter-dashboard)

### Inferences
- All server-side tools need an org and an installed App. A single dev with ~20 personal repos has no tool. GutCheck already runs per-repo checks, so a `baseline.yml` (required files, required settings, required workflows, per-repo exemptions) reusing existing collectors is incremental.
- Drift = diff between last-scan state and baseline, which GutCheck's history module could supply. Reverting is out of scope (its rules forbid unplanned changes); plan/preview/apply fits.
- Repolinter's apparent stagnation suggests the local rule-file niche is under-served (UNVERIFIED).

### Gaps
- No user-demand numbers (issue reactions, HN threads) for Safe Settings/Allstar were retrieved.
- Backstage scorecard plugin status not checked.

## 2. Fleet-wide batch changes delivered as PRs

### Takeaway
multi-gitter and git-xargs do this well and free, driven by a script plus a token. Sourcegraph Batch Changes is enterprise/paid. GutCheck already has plan/preview/apply for local fixes. The gap is only "open PRs instead of committing locally". Rating: MEDIUM value, MEDIUM-HIGH effort (needs push, branches, PR creation, rollback story).

### Cited Findings
- multi-gitter runs a script in each repo; if it exits 0 and changes files, the changes are committed and pushed as a PR. `--dry-run` (with `--log-level=debug`) skips push/PR; `--interactive` shows diffs for acceptance — [DEV.to intro](https://dev.to/lindell/make-bulk-changes-over-multiple-repositories-27i9); [Coopdevs handbook](https://handbook.coopdevs.org/ca/Sysadmin/Git/Resources/multi-gitter)
- git-xargs (Gruntwork, Apache-2.0, Go) clones each repo, runs a command, commits, opens PRs, produces a report; concurrent via goroutines; needs a PAT — [repo](https://www.github.com/gruntwork-io/git-xargs); [launch post](https://www.gruntwork.io/blog/introducing-git-xargs-an-open-source-tool-to-update-multiple-github-repos)
- Sourcegraph: free plan for Batch Changes was limited to 10 changesets (v4.0 era). 2025-2026 trackers show free/Starter plans removed, a $16K+ credit-based enterprise model, and per-merged-changeset pricing for "Agentic Batch Changes". Sourcegraph's own pricing page was not retrieved, so treat as UNVERIFIED — [pricingsaas](https://pricingsaas.com/companies/sourcegraph/diffs/2026Q2); [Sourcegraph free tier FAQ](https://5.1.sourcegraph.com/admin/free-tier)
- Renovate presets, Turbolift, microplane: not researched in this pass.

### Inferences
- The free tools are script-runners with no knowledge of what needs fixing. GutCheck knows which repos need which fix, which is a differentiator ("fix everything GutCheck found, as one PR per repo").
- Safer MVP: create branch + commit locally, then open a draft PR via `gh pr create`, keeping the no-force-push rule.

### Gaps
- No evidence on actual demand/complaints; Renovate presets, Turbolift, microplane unsearched.

## 3. Scheduled scans, notifications, trend history

### Takeaway
Local multi-repo dashboards exist (TUIs, one macOS menubar app) but almost none notify. GutCheck already has history and a tray; scheduled scans with a desktop notification on new regressions plus a digest is a cheap win. Rating: MEDIUM-HIGH value, LOW-MEDIUM effort.

### Cited Findings
- git-scope (TUI with file-watcher refresh, read-only), Git Vision/gv (polling, flags conflicts), CodeBoard (branch/dirty/unpushed), gitmoni, p-mon (one-shot table) are terminal tools — [git-scope](https://pkg.go.dev/github.com/echaouchna/git-scope); [gv](https://pkg.go.dev/github.com/jackchuka/gv); [CodeBoard](https://pypi.org/project/codeboard/); [p-mon](https://pypi.org/project/pmon-cli/)
- gitbar is a macOS menubar app showing dirty files, ahead/behind plus PR and CI status; the only result with notification-like behaviour — [gitbar](https://pypi.org/project/gitbar/)
- Scorecard-style vendor tools (Port/Cortex/OpsLevel) are criticised by a competitor for limited compliance trends over time (vendor claim) — [OpsLevel](https://opslevel.com/resources/port-vs-cortex-whats-the-best-internal-developer-portal)

### Inferences
- Notification-on-change (not on every scan) is the valuable part; avoid noise, same lesson as stale bots (section 9).
- A systemd user timer or the existing tray can drive it; chat webhooks/email are optional and add secret-handling burden, so rate them low.

### Gaps
- No Linux desktop-notification tool found; gita/mgitstatus/ghq not covered by results. No trend-history products found beyond vendors.

## 4. Safe auto-merge of dependency updates

### Takeaway
The pattern is well established (Dependabot + fetch-metadata + `gh pr merge --auto`, or Renovate automerge), and since the 2025 npm worm incidents the consensus is: add a cooldown, restrict to patch/minor, require CI. GutCheck can audit whether repos have this safely configured rather than do merges itself. Rating: MEDIUM value, LOW effort (as a check), HIGH effort (as an actor).

### Cited Findings
- Common workflow: `pull_request_target`, `dependabot/fetch-metadata`, gate on `version-update:semver-patch`, run `gh pr merge --auto`; needs write permissions in the workflow and "Allow auto-merge" enabled; `--auto` waits for required checks — [DEV.to guide](https://dev.to/hidev1977/automatically-merge-dependabot-patch-updates-with-github-actions-316g); [Lethain](https://lethain.com/dependabot-auto-merge/)
- Renovate `minimumReleaseAge` adds a pending "stability-days" status so automerge waits; gaps: transitive deps, lockfile maintenance, missing timestamps (Renovate 42 now requires them) — [Renovate docs](https://docs.renovatebot.com/key-concepts/minimum-release-age/); [discussion 38115](https://github.com/renovatebot/renovate/discussions/38115)
- Dependabot `cooldown` (mid-2025) delays version updates, not security updates; suggested 3-7 days — [Schneider](https://christian-schneider.net/blog/dependency-cooldowns-supply-chain-defense)
- Reported case of upgrade-to-merge in ~16 minutes via Dependabot plus auto-merge during Shai-Hulud (Sept and Nov 2025); figures not independently verified — [GitGuardian on DEV](https://dev.to/gitguardian/renovate-dependabot-the-new-malware-delivery-system-4g8c)

### Inferences
- A GutCheck check "auto-merge workflow present without cooldown/patch-only gating" and "no `cooldown:` in dependabot.yml" is a high-signal, read-only finding. GutCheck already generates a Dependabot template (commit history), so adding cooldown to the template is trivial.
- Pull_request_target auto-merge workflows are an Actions-security risk GutCheck already audits; combine.

### Gaps
- GitHub merge queue not researched (queues matter mainly for busy repos; likely low for solo users).

## 5. Actions usage and cost

### Takeaway
GitHub exposes per-repo usage only via the new billing usage endpoints (line items with repository name, grouped client-side) and per-workflow timing endpoints. Pricing churned in 2026. A personal-account cost view is feasible but access/endpoint details are shaky. Rating: LOW-MEDIUM value, MEDIUM effort.

### Cited Findings
- Old summary billing endpoints return totals and per-OS breakdown, not per repo. New `/usage` endpoints (enterprise, org, user variants) return line items including repository name; filter Actions + minutes and sum — [REST billing docs](https://docs.github.com/enterprise-cloud@latest/rest/billing/billing); [automating usage reporting](https://docs.github.com/en/enterprise-cloud@latest/billing/managing-your-billing/automating-usage-reporting)
- `/repos/{owner}/{repo}/actions/workflows/{id}/timing` reports usage per workflow (third-party reference says no multipliers); retirement status of older workflow usage endpoints UNVERIFIED — [REST billing docs](https://docs.github.com/enterprise-cloud@latest/rest/billing/billing)
- Dec 16 2025: GitHub announced a $0.002/min platform charge on self-hosted runners from 1 March 2026; hosted-runner prices cut 20-39% from Jan 2026. Reports say the self-hosted fee was postponed after backlash; current status UNVERIFIED — [GitHub changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/); [Socket](https://socket.dev/blog/github-actions-pricing-whiplash)
- Free plan private-repo allowance quoted as 2,000 min/month from secondary sites; verify on GitHub's pricing page (UNVERIFIED) — [thepricer](https://www.thepricer.org/how-much-does-github-actions-cost/)

### Inferences
- Most solo devs use public repos (free), so value is real only for private-repo owners. A cheaper proxy that needs no billing scope: wasted runs (failed/cancelled/duplicate runs, missing `concurrency:`/`paths:` filters, cron schedules that run on archived repos). GutCheck likely already sees runs through `gh`.

### Gaps
- Whether user-level `/users/{u}/settings/billing/usage` works with a normal gh token (scope) not confirmed.

## 6. Forks, archived and abandoned repos

### Takeaway
GitHub offers per-fork "Sync fork" and `gh repo sync`; no tool found that audits all forks for staleness. Abandoned-repo detection exists as Scorecard's Maintained check. For a personal account this is a cheap, useful finding set. Rating: MEDIUM value, LOW effort.

### Cited Findings
- `gh repo sync owner/fork -b BRANCH` updates a fork from parent; fails on conflicts; `--force` overwrites — [GitHub docs: syncing a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork)
- Web UI "Sync fork" needs write access — same source.
- Scorecard "Maintained" check uses 90-day activity — [pkg.go.dev scorecard](https://beta.pkg.go.dev/github.com/ossf/scorecard/v5)
- No dedicated stale-fork cleanup tool surfaced in search — absence of evidence only.

### Inferences
- Findings: fork N commits behind upstream, fork with no own commits (deletable, but GutCheck never deletes repos: report only), repo not pushed in 12+ months and not archived, archived repo with live Actions schedules or open PRs.

### Gaps
- GitHub "repository insights" not researched in detail; no demand evidence.

## 7. Licence compliance and SBOM

### Takeaway
`gh api repos/{o}/{r}/dependency-graph/sbom` gives an SPDX JSON SBOM with licence fields on github.com, free, for repos with the dependency graph on. Checks like "repo has a LICENSE" and "dependency licence conflicts with repo licence" are doable from it. Rating: MEDIUM value, MEDIUM effort.

### Cited Findings
- `GET /repos/{owner}/{repo}/dependency-graph/sbom` exports SPDX; needs contents:read; unauthenticated for public repos — [GitHub REST SBOM docs](https://docs.github.com/en/rest/dependency-graph/sboms)
- Newer API version (2026-03-10) docs describe an async flow: POST `generate-report` returns 201 with `sbom_url`, then a 302 to a temporary download, retained up to one week. Whether sync endpoint remains is UNVERIFIED — [same page](https://docs.github.com/en/rest/dependency-graph/sboms)
- On GHES the endpoint does not populate dependency licences; github.com sample shows `licenseConcluded`/`licenseDeclared` — [GHES 3.12 docs](https://docs.github.com/enterprise-server@3.12/rest/dependency-graph/sboms)
- ScanCode: open-source file-level licence/copyright detection, strong at detection, not policy (accuracy ~95% is from a vendor blog); FOSSA is commercial with policy engine, free tier reported as 5 projects (UNVERIFIED, pricing sources conflict) — [kjellkod blog](https://kjellkod.github.io/blog/last-mile-of-license-compliance/); [fitgap](https://us.fitgap.com/products/fossa)
- Dependabot has no licence compliance features — [appsecsanta](https://appsecsanta.com/fossa)

### Inferences
- Because SBOM licences are declared, not detected, expect many NOASSERTION entries. Limit to flagging copyleft (GPL/AGPL) dependencies in permissive or proprietary repos and missing LICENSE. Do not claim legal compliance.
- Also gives a free "dependency count / SBOM available" finding.

### Gaps
- Rate limits and size of SBOM calls for many repos not checked; licensee not researched.

## 8. Release health

### Takeaway
"Commits since last tag", "no release in N months despite activity", and "CHANGELOG not updated" are computable locally from git alone, with no tool dedicating itself to a multi-repo view (release-please/changesets/semantic-release act per repo). Rating: HIGH value for maintainers who publish, LOW effort.

### Cited Findings
- Release tooling typically uses `<last-tag>..HEAD` to list unreleased commits — [skillsmp release-check](https://skillsmp.com/creators/flagrare/agent-skills/plugins-flagrare-skills-release-check)
- cargo-semver-checks `check-release` verifies API compatibility against the last published version; fails if baseline missing/unpublished. Rust-only — [borsh-rs PR 143](https://github.com/near/borsh-rs/pull/143)
- release-plz had a bug where the changelog included commits older than the last tag (fixed upstream) — same PR
- release-please, changesets, semantic-release: nothing retrieved (UNVERIFIED).

### Inferences
- Findings: N unreleased commits older than X days; tag/package.json version mismatch; CHANGELOG lacks the latest tag; releases with no notes. Semver checks are ecosystem-specific; skip.
- Fits GutCheck's existing "release/versioning" mindset (its own release rule).

### Gaps
- No demand data; release-please behaviour not researched.

## 9. Issue and PR triage, and stale bots

### Takeaway
Cross-repo "unanswered issues / PRs awaiting me / PRs awaiting review" is a dashboard feature. GutCheck already covers PRs; issues likely partially. Stale bots are controversial, so GutCheck should report staleness and never auto-close. Rating: MEDIUM value, LOW effort.

### Cited Findings
- Criticism of auto-closing: closes valid reports, discourages reporters, creates duplicates, loses community problem-solving (Django, Kata Containers, Gitpod, Gutenberg threads; Drew DeVault essay) — [Django-developers](https://groups.google.com/g/django-developers/c/RAGuVJhT_3M/m/i2h1k-U-AAAJ); [Kata list](https://lists.katacontainers.io/archives/list/kata-dev@lists.katacontainers.io/message/J4RQESGRYYYIEN75TNCORRDKHKQJG5BB); [Gutenberg/WPTavern](https://wptavern.com/gutenberg-contributors-consider-implementing-a-bot-to-close-stale-issues); [DeVault](https://hacktivis.me/git/mirror/drewdevault.com.git/file/content/blog/stalebot.md.html)
- Defences: sustainable working set (opam), label exemptions; middle view: labelling stale is fine, auto-closing is debatable — [opam thread](https://discuss.ocaml.org/t/opam-repository-experimenting-with-closing-stale-issues/5581); [Joplin](https://discourse.joplinapp.org/t/stale-bot/3680)

### Inferences
- Solo maintainers rarely need a stale bot; value is a cross-repo list of issues with no maintainer reply and PRs from others older than N days. Do not add a "install stale bot" fix.

### Gaps
- Labels hygiene tools not researched.

## 10. Bus factor and contributor signals

### Takeaway
Defined in CHAOSS (Bus Factor added March 2021; Elephant Factor earlier) and computed by Augur, GrimoireLab, git-fame etc., aimed at community/enterprise analytics. For a single developer, bus factor is trivially 1 for most repos, so low value. Rating: LOW value, LOW-MEDIUM effort.

### Cited Findings
- Elephant Factor: minimum number of companies accounting for a threshold share of commits; bus factor in CHAOSS from the March 2021 release; naming debated ("key maintainer risk") — [CHAOSS elephant factor](https://github.com/chaoss/wg-risk/blob/main/focus-areas/business-risk/elephant-factor.md); [chaoss/community#632](https://www.github.com/chaoss/community/issues/632); [arXiv 2309.12120](https://arxiv.org/pdf/2309.12120)
- Truck factor via git blame line shares discussed in Augur — [augur#27](https://github.com/chaoss/augur/issues/27)
- A paper finds individual community-health indicators fail to identify OSS sustainability (so single metrics mislead) — [arXiv 2309.12120](https://arxiv.org/pdf/2309.12120)
- git-fame, hercules, git-truck, GrimoireLab: not retrieved (UNVERIFIED).

### Inferences
- Useful only for small teams: "one author wrote >90% of a repo's commits" as an informational note. Skip otherwise.

### Gaps
- Tool capabilities beyond CHAOSS docs not confirmed.

## 11. Privacy and offline

### Takeaway
Local-first is a recognised selling point (compliance burden of sending code to third parties, "privacy tax"), but evidence here is general, not specific to repo-health tools. GutCheck's local/no-SaaS stance is a positive to state plainly, along with the "never run repo code" rule. Rating: n/a as a gap; keep as positioning.

### Cited Findings
- Local-first advocates argue cloud services cede control to a third party, and routing development through third-party infrastructure creates a security-review "privacy tax"; main counterpoints are sync/collaboration and setup cost — [Ink & Switch](https://inkandswitch.com/essay/local-first/local-first.pdf); [Heavybit](https://www.heavybit.com/library/article/local-first-development); [DEV.to offline-first dev tools](https://dev.to/phlx0/the-case-for-offline-first-developer-tools-4fec)
- A 2025 HN thread on the local-first paper reportedly had 883 points / 297 comments — [HN item 44473135](https://news.ycombinator.com/item?id=44473135) (figure from a search summary, UNVERIFIED)
- Safe Settings, Allstar, Port/Cortex/OpsLevel require installed GitHub Apps or SaaS — sections 1 sources.

### Inferences
- Any new feature touching the network (notifications webhooks, billing, SBOM) should be opt-in and say what leaves the machine.

### Gaps
- No HN/Reddit threads specifically about code leaving the machine for repo-health SaaS; no 2026 AI-code-privacy data collected.

## 12. Other capabilities in this space

### Takeaway
Not much surfaced beyond the list; these are reasoned candidates, mostly UNVERIFIED as to demand. Tooling-version drift and duplicated CI config are the strongest.

### Cited Findings
- Backstage/Port/Cortex/OpsLevel scorecards cover service maturity, ownership, docs, deploy info for orgs — [Port docs](https://docs.backstage-plugin.port.io/features/scorecards)
- gitbar surfaces PR and CI status in a menubar — [gitbar](https://pypi.org/project/gitbar/)
- No sources retrieved on GitHub Pages status, monorepo/polyrepo consistency, runtime version drift or duplicated CI config.

### Inferences
- Tooling-version drift (HIGH-MEDIUM value, LOW effort): read `.nvmrc`/`engines`/`rust-toolchain`/`.python-version`/`go.mod` plus workflow `node-version` and report mismatches and EOL runtimes across repos.
- Duplicated CI config (MEDIUM value, LOW-MEDIUM effort): hash workflow files across repos and suggest reusable workflows or a template repo; pairs with item 1.
- GitHub Pages / deploy status (LOW-MEDIUM, LOW effort): `gh api repos/.../pages` and latest deployment; flag Pages enabled but failing build or custom-domain issues.
- Monorepo consistency: LOW for the target user.

### Gaps
- All items need demand evidence.

---

## Summary ranking (inferred; effort relative to GutCheck's current architecture)
| Capability | Value | Effort |
|---|---|---|
| 1 Baseline policy + drift report | High | Medium |
| 12 Tool-version drift | High-Med | Low |
| 8 Release health (unreleased commits, changelog) | High | Low |
| 4 Auto-merge safety audit (cooldown, gating) | Medium | Low |
| 3 Scheduled scan + desktop notify on change | Med-High | Low-Med |
| 6 Fork/abandoned repo findings | Medium | Low |
| 9 Issue/PR waiting lists (no stale-bot) | Medium | Low |
| 7 SBOM licence check | Medium | Medium |
| 2 Fleet PRs from findings | Medium | Med-High |
| 12 Duplicated CI config | Medium | Low-Med |
| 5 Actions cost | Low-Med | Medium |
| 10 Bus factor | Low | Low-Med |

I did not inspect GutCheck's source to confirm which of these it already covers; check before building.
