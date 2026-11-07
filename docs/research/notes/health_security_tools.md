# Tools that audit, govern and secure many GitHub repos (health/standards, dependency bots, secret scanners, dashboards) - state as of Nov 2026

Method note: ~35 fetches/searches. Fetch tool summarizes pages with a small model, so exact figures (e.g. star counts) are as reported by it. Issue-list fetches did NOT expose true reaction counts for most trackers (numbers shown may be comment counts); only the Renovate list gave reaction-style counts. Items I could not confirm are marked UNVERIFIED.

## 1. Repo health and standards (Scorecard, Repolinter, Allstar, Safe Settings, probot/settings, rulesets, org rules, custom properties)

### Takeaway
Scorecard is the live, well-maintained read-only scorer; Repolinter is archived (Feb 2026); Allstar, Safe Settings and probot/settings are the only settings enforcers and all need you to run a GitHub App yourself (Allstar's hosted app is retired). GitHub-native rulesets/custom properties are the lowest-friction enforcement, but org-wide rulesets are gated to paid plans (Team/Enterprise; sources conflict on which).

### Cited Findings
**OpenSSF Scorecard**
- Checks (19 listed): Binary-Artifacts, Branch-Protection, CI-Tests, CII-Best-Practices, Code-Review, Contributors, Dangerous-Workflow (Critical), Dependency-Update-Tool, Fuzzing, License, Maintained, Packaging, Pinned-Dependencies, SAST, Security-Policy, Signed-Releases, Token-Permissions, Vulnerabilities (OSV), Webhooks (Critical, experimental). - [ossf/scorecard](https://github.com/ossf/scorecard)
- Scoring: each check 0-10 (some return "?" inconclusive); aggregate is risk-weighted average (Critical=10, High=7.5, Medium=5, Low=2.5); README warns aggregate hides specifics and scores shift as heuristics change. - [ossf/scorecard](https://github.com/ossf/scorecard)
- Action vs CLI: Action is for repos you own (results in Security tab; `publish_results: true` enables REST API + badge); CLI is intended for projects you do not own (Docker/binary/Homebrew etc.; needs GitHub token; Linux/macOS, Windows may have issues). A `scorecard mcp` server exposes published results, needs no credentials, runs no scans. Weekly public scan covers >1.3M repos; BigQuery public dataset no longer available (issue #5208). - [ossf/scorecard](https://github.com/ossf/scorecard)
- Action details: triggers push/schedule on default branch (pull_request/workflow_dispatch experimental); forks and GitHub Enterprise repos not supported; private repos supported only with GitHub Advanced Security (otherwise use CLI); classic branch-protection settings need a fine-grained PAT as `repo_token`, but Repository Rules can be read with default GITHUB_TOKEN. - [ossf/scorecard-action](https://github.com/ossf/scorecard-action)
- Read-only: reports/alerts only, never fixes. Backlog: 250 open issues/97 PRs at capture. - [ossf/scorecard](https://github.com/ossf/scorecard)
- Issue-tracker themes (order by reactions, counts not exposed): #4080 use GitHub attestations for Signed-Releases; #3827 fork PR workflows; #4667 attestations for artifacts; #4333 "Managed GitHub App per org instead of Action per repo"; #3996 contributor scoring bug; #2189 unpinned third-party actions in local composite not penalized; #2904 remove CII-Best-Practices check; #3549 unclear value of hash-pinning. - [issues sorted by reactions](https://github.com/ossf/scorecard/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)

**Repolinter**
- Archived by owner (todogroup) on Feb 6, 2026, read-only; Releases section empty; lints file existence (README, LICENSE, CONTRIBUTING, CODE-OF-CONDUCT), file hashes, CI integration; rules can trigger fixes. - [todogroup/repolinter](https://github.com/todogroup/repolinter)

**Allstar** (OpenSSF)
- GitHub App (Scorecard subproject) monitoring orgs/repos for policy violations; hosted OpenSSF instance retired - you must create your own GitHub App and run it as a scheduled GitHub Action (recommended) or a service daemon; config in a `.allstar` control repo (opt-in/opt-out at org, optional repo overrides). - [ossf/allstar](https://github.com/ossf/allstar)
- Policies: Branch Protection (supports `fix`), Binary Artifacts, CODEOWNERS, Outside Collaborators, SECURITY.md, Dangerous Workflow, generic Scorecard check with threshold, GitHub Actions rules, Repo Administrators; Dependabot/pinning planned. Actions: log (default), issue (one per policy, commented every 24h, auto-closed after fix), fix (Branch Protection only); block/email/rpc proposed not implemented. - [ossf/allstar](https://github.com/ossf/allstar)
- Project stated as still maintained. Org-oriented ("monitors GitHub organizations"); personal-account use UNVERIFIED.

**Safe Settings** (github/safe-settings)
- Policy-as-code GitHub App: org/suborg/repo YAML in a central `admin` repo (`.github/settings.yml`, `suborgs/*.yml`, `repos/*.yml`; precedence repo > suborg > org); manages branch protections, teams, collaborators, labels, rulesets, custom properties, app installations; reverts UI drift; PRs on non-default branches run as dry-run checks. Runs as webhook service, cron job or Actions; Docker/Helm/Lambda. ISC licence. - [github/safe-settings](https://github.com/github/safe-settings)
- Limits: fixed directory structure; `disable_plugins`/`additive_plugins` quirks; app-installation management needs enterprise-level token and only corrected by full cron sync; suborg re-eval capped one hop; large PR diffs truncated. Active (1,433 commits, API version refs 2026-03-10; 187 open issues, 73 PRs). - [github/safe-settings](https://github.com/github/safe-settings)
- Issue themes: merge queues (#483), branch protection by pattern (#311), run as Action (#378), repo variables (#798), org/repo secret scanning + push protection (#583), crashes in CustomProperties plugin (#981). Counts shown were probably comments, not reactions. - [issues](https://github.com/github/safe-settings/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)

**probot/settings -> repository-settings/app**
- Syncs `.github/settings.yml` to repo settings via PRs; hosted app at github.com/apps/settings or self-host; ISC; ~1.1k stars. README warns it "inherently escalates anyone with push permissions to the admin role" (mitigate with CODEOWNERS + required code-owner review). - [repository-settings/app](https://github.com/repository-settings/app)
- Maintenance concern: issue #1138 (Apr 2025) asks who owns/maintains the app; long-open bugs: #95 .github repo changes not propagated, #150 and #227 branch protection not applied/wildcards, #732 add rulesets (open since Apr 2023). - [issues](https://github.com/repository-settings/app/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)
- No rulesets support evidenced (feature request #732 still open). Last commit/release date UNVERIFIED.

**GitHub rulesets / org rules**
- Rule types: branch/tag rules (signed commits, block force-push, etc.), push rulesets (file path, path length, extension, file size - private/internal repos), commit metadata; up to 75 rulesets per repo and 75 org-wide; rulesets layer (most restrictive wins); bypass by role/team/app; statuses Active/Disabled. - [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- Plan: the "about rulesets" page (as summarized) says rulesets are for Team and Enterprise and org-wide rulesets need Enterprise; the "creating rulesets in your organization" page says "For customers on GitHub Team or GitHub Enterprise plans you can create rulesets in your organization." - [org rulesets doc](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization). CONFLICT between the two; treat org rulesets as Team+ (UNVERIFIED whether Enterprise-only). Free-plan/public-repo availability not confirmed by fetched pages (UNVERIFIED).
- Org rulesets can target repos by property query (e.g. `visibility:private props.team:infra -language:java`). The fetched page lists no evaluate mode, only Active/Disabled (UNVERIFIED; GitHub has had an evaluate mode - check). - [org rulesets doc](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization)

**Repository custom properties**
- Org-level metadata: text, single select, multi select, true/false; names <=75 chars, values <=75 chars; visibility follows repo visibility; optional "allow repository actors to set"; usable to target rulesets. Plan availability not stated on the page (UNVERIFIED; requires an organization, so not applicable to personal accounts). - [custom properties doc](https://docs.github.com/en/organizations/managing-organization-settings/managing-custom-properties-for-repositories-in-your-organization)

### Inferences
- A personal account (no org) cannot use org rulesets, custom properties or Allstar-style org policy; solo devs would need per-repo rulesets or a settings-sync app, or move repos into a (free) org.
- Only Allstar (branch protection) and Safe Settings/probot-settings change settings; Scorecard/Repolinter only report. Safe Settings is the most capable and safest (dry-run PR checks, central review) but heaviest to host.
- probot/settings looks under-maintained and lacks ruleset support; Safe Settings supersedes it for rulesets.

### Gaps
- Exact plan availability of rulesets/org rulesets/custom properties on Free; Safe Settings and Allstar last-release dates; real reaction counts for issues.

## 2. Dependency bots (Renovate, Dependabot)

### Takeaway
Dependabot is zero-setup and built into GitHub (security + version updates, grouping, cooldown) but thin on features (no native automerge, long-standing requests). Renovate is far more configurable (presets, automerge, dashboard, many managers/platforms) and free via Mend's hosted app or self-hosted, at the cost of config complexity.

### Cited Findings
**Renovate**
- Run self-hosted (npm package, GHCR/Docker Hub image) or via the Mend Renovate hosted app; supports GitHub (.com and GHES), GitLab, Bitbucket Cloud/Server, Azure DevOps, Gitea, Forgejo, AWS CodeCommit, Gerrit (experimental). Shareable ESLint-style config presets. - [docs.renovatebot.com](https://docs.renovatebot.com/)
- Hosted app: "Renovate Community Cloud", free ($0), personal and org accounts, public and private repos; onboarding PR per repo; provided by Mend under separate ToS. - [GitHub Marketplace](https://github.com/marketplace/renovate). Mend Enterprise edition exists (custom pricing, UNVERIFIED; third-party aggregators give conflicting/unreliable paid figures like $25/mo - ignore).
- Automerge: merges after required checks pass; `automergeType=branch` pushes directly (fails if branch protection blocks pushes); platform-native automerge on by default; one merge per target branch per run; mandatory reviews/CODEOWNERS can block it; docs recommend automerging only what you would merge anyway, e.g. devDependencies. - [automerge docs](https://docs.renovatebot.com/key-concepts/automerge/)
- Dependency Dashboard: issue showing update status; can require approval via checkbox (`:dependencyDashboardApproval`), re-open closed/ignored updates via checkbox; vulnerability PRs bypass approval. - [dashboard docs](https://docs.renovatebot.com/key-concepts/dashboard/)
- Most-requested (Renovate issues, thumbs-up counts as reported): conda support #2213 (73); Helm chart.yaml bump #4728 (47); Rush monorepo #3681 (45); name regex managers #21760 (26); changelog retrieval overhaul #14138 (25); sync versions within group #9739 (25); roll up updates into single PR #4404 (20). - [Renovate issues](https://github.com/renovatebot/renovate/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)
- Grouping: via packageRules/groupName (not covered by fetched page; general knowledge, UNVERIFIED here).

**Dependabot**
- Two modes: security updates (PRs for vulnerable deps) and version updates (PRs to stay current; enabled via `dependabot.yml`); default 3-day cooldown for version updates (not security), customizable (1-90 days). Pauses updates if maintainers stop interacting with its PRs. - [about version updates](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/about-dependabot-version-updates)
- Grouped updates: per-ecosystem groups; `applies-to` (version-updates/security-updates), `dependency-type`, `patterns`/`exclude-patterns`, `update-types`; order-sensitive; `group-by: dependency-name` for monorepos; `*` pattern can make huge PRs. - [grouped updates doc](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/optimizing-pr-creation-version-updates)
- Auto-triage rules (alerts): auto-dismiss, snooze, choose which alerts get PRs; presets for all repos (dismiss low-impact dev-scoped npm; dismiss malware alerts - off by default); custom rules only on public repos and org-owned repos in Team with Code Security. - [auto-triage doc](https://docs.github.com/en/code-security/dependabot/dependabot-auto-triage-rules/about-dependabot-auto-triage-rules)
- No native automerge: use an Actions workflow with `dependabot/fetch-metadata` + `gh pr merge --auto`; Dependabot has separate secrets store; merge queue needs PAT/App token. - [Actions automation doc](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions)
- Top open requests (order by reactions; shown numbers likely comments): #12320 mise; #1164 full Gradle support; #2980 manually trigger update for a dependency; #2227 conda.env; #4605 validate config before it lands on main; #1778 multiple schedules per ecosystem/directory; #1973 auto merge (106 shown); #2224 always rebase; #2211 PR templates; #1291 draft PRs. 1,229 open issues. - [dependabot-core issues](https://github.com/dependabot/dependabot-core/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)

### Inferences
- For 10-50 repos, Dependabot needs a `dependabot.yml` per repo (no org-level shared config - general knowledge, UNVERIFIED here), while Renovate presets (shared repo config) give fleet-wide config; this is Renovate's main advantage.
- Both fix by opening PRs only; safe because humans merge, unless automerge is configured.

### Gaps
- Mend hosted-app limits and 2026 Enterprise pricing; Renovate manager count; Dependabot open-PR-limit default and org-level config status.

## 3. Secret scanning (gitleaks, trufflehog, GitHub, detect-secrets)

### Takeaway
GitHub secret scanning/push protection is free on public repos but private repos require paid Secret Protection ($19/active committer/mo). For private repos on free plans, gitleaks (pre-commit/CI) and trufflehog (live verification) are the free options. Gitleaks is now in maintenance mode with a successor, Betterleaks.

### Cited Findings
- **GitHub**: secret scanning alerts and push protection available by default on public repos; private repos require GitHub Secret Protection on Team/Enterprise Cloud; partner alerts to providers on all plans for public leaks. - [GitHub docs](https://docs.github.com/en/code-security/getting-started/github-security-features)
- Pricing (list, from 2025 launch; not re-verified on GitHub's pricing page): Secret Protection $19 and Code Security $30 per active committer per month (active in last 90 days); Team orgs can buy without Enterprise. - [GitHub changelog](https://github.blog/changelog/2025-03-25-introducing-github-secret-protection-and-github-code-security/) (price figures via search summary; UNVERIFIED on primary page).
- **gitleaks**: MIT; scans git history, dirs, stdin; `.gitleaks.toml` with extend/allowlists; baseline via `--baseline-path`; `.gitleaksignore`; decodes base64/hex/percent and scans archives; pre-commit, Docker, GitHub Action, SARIF. Maintainer states it is "feature complete" - security patches only - and is shifting to Betterleaks. - [gitleaks/gitleaks](https://github.com/gitleaks/gitleaks)
- **Betterleaks**: by gitleaks' author team, MIT, v2 in development; optional live validation (`--validate`, Expr HTTP rules), identity/permission analysis (`--analyze`); revocation defined but never run by scans; Docker latest may still ship v1 until stable v2. - [betterleaks/betterleaks](https://github.com/betterleaks/betterleaks)
- **trufflehog**: >700 detectors with active verification (README also says classifies >800 types); results verified/unverified/unknown by testing credentials against provider APIs; sources include git, GitHub, GitLab, Docker images, S3, filesystems, CI systems; AGPL-3.0 (CLA); ~28.9k stars; Action and pre-commit; separate paid Enterprise product (no public price). Custom regex detectors alpha. - [trufflesecurity/trufflehog](https://github.com/trufflesecurity/trufflehog)
- trufflehog top-requested: .trufflehogignore (#2687), --shallow-since (#628), suppress known test secrets (#1019), generic scanner (#716), multiple outputs (#1880). - [issues](https://github.com/trufflesecurity/trufflehog/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)
- **detect-secrets** (Yelp): Apache-2.0; baseline approach flags only new secrets; pre-commit hook; 28 plugins (regex, entropy, keyword); does not catch multi-line secrets; maintenance status/last release not shown (UNVERIFIED). - [Yelp/detect-secrets](https://github.com/Yelp/detect-secrets)

### Inferences
- Live verification (trufflehog) means the scanner makes network calls to providers with found secrets - a safety consideration for any "read-only, never runs code" tool; verification can be disabled (`--no-verification`, general knowledge UNVERIFIED here).
- Scanners report only; remediation (rotate/revoke) is manual by design.

### Gaps
- Primary-source confirmation of $19/$30 pricing; GitHub secret scanning for private repos on free plans (appears unavailable without purchase); gitleaks-action licence terms for orgs.

## 4. Dashboards and developer portals

### Takeaway
For personal/small-team use, gh-dash and GitHub Projects are free and light but do not score health; Backstage-based scorecards (Tech Insights, Soundcheck) and commercial portals target orgs with platform teams. SonarQube Cloud and CodeScene cover code quality, not repo hygiene.

### Cited Findings
- **gh-dash**: terminal UI over `gh` CLI; YAML config of per-repo PR/issue sections, custom actions; MIT; ~12.7k stars; 97 open issues. No health scoring. - [dlvhdr/gh-dash](https://github.com/dlvhdr/gh-dash)
- **GitHub Projects**: table/board/roadmap at user or org level; custom fields (up to 50), automation workflows, charts; cross-repo implied but not confirmed by page; plan availability not stated. - [Projects docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
- **Backstage**: open-source developer-portal framework, CNCF Incubation; software catalog + plugins; you host and maintain it. - [backstage.io](https://backstage.io/docs/overview/what-is-backstage)
- **Tech Insights** (community-plugins): define facts and checks over catalog entities; packages include JSON rules engine fact checker and maturity ranking. - [community-plugins](https://github.com/backstage/community-plugins/tree/main/workspaces/tech-insights)
- **Soundcheck** (Spotify): paid Backstage plugin bundle, annual subscription per developer, no public price; tracks/levels/checks via YAML or no-code UI; needs a running Backstage. - [Spotify FAQ](https://backstage.spotify.com/faqs), [Tracks doc](https://backstage.spotify.com/docs/plugins/soundcheck/core-concepts/tracks)
- **OpenSSF in Backstage**: no dedicated OpenSSF Scorecard plugin found in community-plugins; Red Hat Developer Hub's Scorecard plugin includes OpenSSF metrics (RHDH-packaged). - [RHDH docs](https://redhat-developer.github.io/red-hat-developers-documentation-rhdh/main/observability_evaluate-project-health-using-scorecards). Absence in community-plugins is UNVERIFIED (search-based).
- **SonarQube Cloud**: Free tier - private projects up to 50k LOC; Team from $34/month (100k LOC, <50 devs); Enterprise sales; free for OSS public repos. - [sonarsource pricing](https://sonarsource.com/plans-and-pricing/)
- **CodeScene**: per active author (committed in last 3 months) Standard EUR18/mo, Pro EUR27/mo (portfolio, team/delivery insights); Enterprise custom; free for open source; cloud or on-prem; no free individual plan stated. - [codescene.com/pricing](https://codescene.com/pricing)
- **Port**: free plan up to 5 seats, 10K entities, 400 workflow runs; Basic from $30/seat/mo (<=50 seats), Standard from $48/seat/mo, Enterprise custom; scorecards not listed on pricing page as a plan feature. - [port.io/pricing](https://www.port.io/pricing)
- **Cortex / OpsLevel**: aggregators say no free tier; OpsLevel quote-based with trial (aggregator data, not vendor-verified). - [aggregator comparison](https://toolradar.com/tools/opslevel/pricing); Cortex pricing UNVERIFIED.

### Inferences
- Portals are overbuilt for 10-50 personal/small-team repos; the closest match is a lightweight local/CLI view.

### Gaps
- Tech Insights/Soundcheck maintenance status 2026; Cortex pricing; GitHub Projects plan limits; SonarQube Community Edition limits; Backstage scorecards actually consuming Scorecard data.

## 5. Which work on personal/free plans; which can fix, and how safely (cross-cutting)

### Takeaway
Free/personal-friendly: Scorecard CLI, gitleaks, trufflehog, detect-secrets, Renovate (Mend free app or self-hosted), Dependabot, gh-dash, Projects, Sonar free (<=50k LOC private), Port free (5 seats). Org/paid-gated: org rulesets, custom properties, Allstar/Safe Settings (org-oriented), private-repo secret scanning, Dependabot custom auto-triage on private repos, Soundcheck, CodeScene Pro, Cortex/OpsLevel.

### Cited Findings
- Fixers: Dependabot/Renovate open PRs (and optionally automerge); Allstar `fix` (branch protection only) and issues; Safe Settings/probot-settings change settings (Safe Settings with dry-run PR checks; probot-settings escalates push access to admin). Everything else (Scorecard, scanners, dashboards) only reports. - sources above.

### Inferences
- Safest fix models are PR-based (bots, Safe Settings dry-run); riskiest are always-on settings reconciliation without review (probot/settings with push=admin escalation; Allstar fix auto-reverting branch protection).
- Coverage strengths: dependency freshness, secrets (history + pre-commit), supply-chain scoring (Scorecard). Weak spots for a solo dev with 10-50 repos: no single free fleet view that combines Scorecard + dependency-bot status + secret-scan status + stale branches/PRs/uncommitted work; org-level tools don't apply to personal accounts; settings enforcers are hosted-app-heavy; Scorecard Action must be added per repo (issue #4333 requests a managed per-org App); per-repo config drift for Dependabot/Gitleaks.

### Gaps
- No evidence found of a free, local, multi-repo "fleet health" tool beyond these; not exhaustively searched (e.g. newer 2026 entrants UNVERIFIED).
