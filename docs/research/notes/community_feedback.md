# Community feedback on managing many git repos and the tools for it

Method note: WebFetch returns summaries from a small model, so quotes below are as that tool reported them; each has an HN comment/item id so it can be re-checked at https://news.ycombinator.com/item?id=ID. Reddit (all subreddits) was blocked for the search tool and lobste.rs returned an Anubis "Access Denied" page. Everything Reddit/lobste.rs-related is therefore UNVERIFIED / not covered. HN Algolia and GitHub Discussions were the main sources. Volume of evidence is modest (about 10 threads), so "how widespread" judgments are rough.

## 1. How do people with dozens of personal repos track uncommitted/unpushed work, stale branches, failing CI and open PRs?

### Takeaway
The only consistent "answer" found is DIY scripts/TUIs (mgitstatus, myrepos) plus a steady stream of new Show HN dashboards; I found no HN/GitHub thread where people described a satisfying existing workflow. GitHub's own cross-repo views are partial.

### Cited Findings
- mgitstatus is the standard shell answer: scans repos N folders deep, reports uncommitted/untracked/unpushed, `-e` hides clean repos, `-f` fetches remotes (not by default). The docs say it makes no guarantee that all repo states are covered. — [mgitstatus man page](https://www.mankier.com/1/mgitstatus) (web search summary; not a community opinion)
- myrepos ("mr") has had HN threads, but both are 2020, outside the date window: [Myrepos – tool to manage all your version control repos](https://news.ycombinator.com/item?id=24635066), [Maintaining Multiple Python Projects with Myrepos](https://news.ycombinator.com/item?id=24388668). HN Algolia searches for "mgitstatus", "ghq/gita/myrepos" in 2023+ returned zero comment hits.
- Ask HN, Oct 2022 (outside window): aliqot: "I don't get much use from the dash and usually just want to see a list of my repos." — [Ask HN: Is there a way for github.com to send me to my repos instead of my dash?](https://news.ycombinator.com/item?id=33146789)
- GitHub repository dashboard preview (github.com/repos), 11 Dec 2025, drew requests: cdce8p "It would be awesome if we could create custom lists with repositories."; jsoref "I need a way to say 'please ignore this repository'" and "None of these are useful to me" (22 Dec 2025); tonglil (27 Feb 2026) "I can't believe you can't filter by organization teams!" The view only counts activity within one year, so older stale repos vanish. — [community/discussions/181683](https://github.com/orgs/community/discussions/181683)
- 30 Sep 2022 request: user amyAMeQ wanted a screen of PRs from others across all repos she can access, with review counts and whether she already reviewed; the built-in link only showed her own PRs. A reply pointed to a filter workaround. — [community/discussions/34709](https://github.com/orgs/community/discussions/34709)
- Other open GitHub requests (titles only seen in search, not opened): [#4165 View all open pull requests](https://github.com/orgs/community/discussions/4165), [#192952 Unified Discussions Dashboard Across Multiple Repositories](https://github.com/orgs/community/discussions/192952).
- Show HN dashboards exist for exactly this and mostly got near-zero feedback (see section 5): Repo Linked, Git-Scope, Gitwig, RepoFlock, GitPersona.

### Inferences
- The personal-repo audience seems served by home-grown scripts; discussion is sparse because people do not post about it, not because there is no pain.
- GitHub's repos view being activity-windowed (1 year) is a concrete gap for "stale repo" hygiene.

### Gaps
- Reddit r/git, r/github, r/selfhosted, r/ExperiencedDevs threads: UNVERIFIED, inaccessible to the tool. lobste.rs: inaccessible.
- No direct first-person accounts of tracking unpushed work/stale branches found.

## 2. Dependabot vs Renovate noise, and automerge

### Takeaway
Strong, recent, high-engagement view (HN 647 points) that Dependabot is noisy and its alerts are mostly irrelevant, especially for Go; Renovate is the commonly recommended alternative for grouping, language coverage and automerge; automerge is popular among some but another poster reported it missed security fixes. Cooldowns are the new 2025-26 theme.

### Cited Findings
- Filippo Valsorda, "Turn Dependabot off", 20 Feb 2026: "False positive alerts are not only a waste of time, they also reduce security by causing alert fatigue". He proposes scheduled govulncheck plus a test run against latest deps. — [words.filippo.io/dependabot](https://words.filippo.io/dependabot/); HN 647 pts / 185 comments: [item 47094192](https://news.ycombinator.com/item?id=47094192)
- Same thread: nfm: "The number of ReDoS vulnerabilities we see in Dependabot alerts" (id 47094795); mook: "Too bad dependabot cooldowns are brain-dead." (id 47095192); seattle_spring: "RenovateBot supports a ton of languages, and ime works much better for the npm ecosystem than Dependabot." (id 47095196); operator-name: "I can personally recommend Renovate, which supports far more ecosystems and customisation options" (id 47095986); tracker1: "The emails are annoying and I mostly filter" (id 47095058); mechsy: "I have found a reliable way to keep things up-to-date is enabling dependabot and merging relentlessly" (id 47098897); adamdecaf: "We also let renovate[bot] (similar to dependabot) merge non-major dep updates if tests pass." (id 47095427). All 20-21 Feb 2026.
- Counterpoints in same thread: solatic: Dependabot/Renovate are "language-agnostic", useful when you cannot add custom CI to every repo; andrewaylett: Renovate lock file maintenance "makes update a whole load safer" and he auto-merges when tests pass (21 Feb 2026). — [item 47094192](https://news.ycombinator.com/item?id=47094192)
- indiekitai: "Alert fatigue is a real attack surface." and "The irony is that Dependabot's noise makes teams less secure, not more." (21 Feb 2026) — [comment 47096281](https://news.ycombinator.com/item?id=47096281)
- The Register (24 Feb 2026) reported Valsorda calling Dependabot a "noise machine", criticising a "nonsensical made up CVSS v4 score"; an unnamed HN commenter said customers "won't accept 'we never call that function' as an answer". — [The Register](https://www.theregister.com/2026/02/24/github_dependabot_noise_machine/)
- Ask HN, 20 Nov 2025, nrig: "Dependabot opens 20-30 PRs per week across my repos."; manual review "takes 5-10 hours/week"; auto-merging patch versions "missed a few important security fixes". Only one reply (stevepike, plugging a Dependabot-alert app: "Some ignore the problem entirely until there's a fire drill"). — [Ask HN: How do you prioritize dependency updates?](https://news.ycombinator.com/item?id=45997568)
- "Reducing Dependabot Noise" (nesbitt.io, Jan 2026), HN 64 pts: swisniewski: "The answer to dependabot, or snyk prs is to automatically merge them once all the status checks pass." (id 46664090). Several commenters initially read the article as serious and others noted it appears to be satire; I did not independently confirm the satire claim. Do not cite the article itself as advice. — [HN 46583914](https://news.ycombinator.com/item?id=46583914)
- Cooldowns: eranation: "Dependabot (and renovate) do have 'cooldowns' supported, just need to set them up." (6 Jun 2026) [comment](https://news.ycombinator.com/item?id=48420579); jamietanna: "Both Renovate and Dependabot will raise PRs for a security fix, regardless of minimumReleaseAge/cooldown config" (3 May 2026) [comment](https://news.ycombinator.com/item?id=47994554); leosarev "Cooldown should be feature of dependabot/renovate/etc" (9 Mar 2026) [comment](https://news.ycombinator.com/item?id=47309824).
- Maintainer-side tooling: mxmehl, Show HN "PRoctr – doctor/triage for your renovate/dependabot PRs" (30 Jul 2026): "it's a hell of a noise if you're maintaining projects on multiple platforms" (comment id 49109247); a TUI to triage bot PRs. — [HN 49109246](https://news.ycombinator.com/item?id=49109246). Also Schnitz, 11 Jan 2026: "The other day I vibe coded a bespoke dependabot/renovate replacement in an hour." [comment](https://news.ycombinator.com/item?id=46572140); TurboHaskal (5 Nov 2026) complaining about "spending my whole workday merging renovate/dependabot pull requests" [comment](https://news.ycombinator.com/item?id=50381811).
- Secondary (blog, not community; single anecdote): a write-up claims Dependabot opens 40-60 PRs/month on a medium Next.js project vs 8-15 with Renovate grouping — [tianpan.co](https://tianpan.co/forum/t/renovate-vs-dependabot-in-2026-we-switched-and-heres-why-renovate-won/611) (UNVERIFIED, snippet only).

### Inferences
- Wide view (hundreds of upvotes): per-update PRs plus irrelevant alerts = fatigue. Renovate preferred by power users; Dependabot kept for zero-config. Automerge is accepted only with strong CI; no consensus.

### Gaps
- Reddit r/devops / r/github Renovate-vs-Dependabot threads: UNVERIFIED.

## 3. Frustrations with OpenSSF Scorecard, CodeQL, secret scanning

### Takeaway
Scorecard draws recurring complaints about false positives, unfitness for solo/small projects, and "unpaid work" pressure; secret-scanning complaints centre on placeholder/example values. I found no strong community thread specifically on CodeQL.

### Cited Findings
- systemd Scorecard thread: evverx (4 May 2023) "scorecard project isn't particularly interested in fixing its false positives"; (7 May 2023) "the same alerts pop up over and over again (regardless of whether they are dismissed or not)." — [systemd/systemd#25042](https://github.com/systemd/systemd/issues/25042)
- OpenSSF itself admits heuristics, introducing maintainer annotations to correct scores. — [OpenSSF blog, 5 Mar 2024](https://openssf.org/blog/2024/03/05/openssf-scorecard-evaluating-and-improving-the-health-of-critical-oss-projects/) (via search summary)
- runningmike (22 Jun 2025): many Scorecard checks don't fit single-maintainer projects that don't use GitHub Actions (paraphrase; tool declined to reproduce full text). — [comment 44350218](https://news.ycombinator.com/item?id=44350218)
- cs702 (16 Oct 2025) summarised a view that frameworks like OpenSSF Scorecards are a way for big tech to push open-source maintainers into unpaid work (paraphrase). — [comment 45606076](https://news.ycombinator.com/item?id=45606076); a similar 6 May 2024 comment criticises OpenSSF promoting its Scorecard action and says maintainers should be paid ([comment 40272824](https://news.ycombinator.com/item?id=40272824), UNVERIFIED beyond the Algolia snippet).
- abhisek (7 Jan 2026): package metadata like stars/downloads is "easy to fake" (paraphrase); another HN comment says Scorecard has maintainer adoption but little use in security decisions (comment 46521981 snippet). — [comment 46521981](https://news.ycombinator.com/item?id=46521981)
- woodruffw on Show HN shouldiuse.dev (27 Jun 2025): Scorecard-style heuristics "can be wrong (at best) or maliciously gamed (at worst)"; FlyingAvatar: a stable simple dependency looks unmaintained for lacking recent commits. — [HN 44399666](https://news.ycombinator.com/item?id=44399666)
- Secret scanning: Aunnar, 16 Oct 2026: push protection blocks placeholder values in `.env.example`; excluding via secret_scanning.yml did not stop the push-time block. Suggested answer: obviously fake values, or mark "False positive" from the link. — [community/discussions/210435](https://github.com/orgs/community/discussions/210435). Related: [#201153](https://github.com/orgs/community/discussions/201153) (template private key flagged; search summary only). GitHub says LLM verification cut false positives 75.76% — [GitHub blog](https://github.blog/security/making-secret-scanning-more-trustworthy-reducing-false-positives-at-scale/) (search summary).
- Dependabot's reachability problem (cross-cutting): see Valsorda above; recommended reachability analysis (govulncheck).

### Gaps
- No CodeQL-specific complaint thread located. Reddit/lobste.rs unverified. Scorecard comments mostly paraphrased, not verbatim.

## 4. AI coding agents in repos (instruction files, messy commits, clutter)

### Takeaway
Discussion is about instruction-file upkeep (short, nested, often ignored) rather than clutter per se; I found no strong first-person HN thread on agents leaving clutter (comment searches returned no relevant hits). Clutter evidence comes from secondary sources.

### Cited Findings
- Ask HN, 16-17 May 2026, "Do you still spend time maintaining Claude.md / AGENTS.md files?" (10 comments): bisonbear "AGENTS.md is extremely important - it's probably the highest leverage thing"; poster david_d8912 "my own experience is they're constantly not followed."; bisonbear: "telling the agent NOT to do something sometimes primes it to do that exact thing"; verdverm keeps only "a table of contents and some highlights"; luodaint "Rules made from scratch are usually not followed." — [HN 48160604](https://news.ycombinator.com/item?id=48160604)
- Secondary: preprint found "smells" in AGENTS.md/CLAUDE.md of 100 popular repos (lint leakage 62%, context bloat 42%, skill leakage 35%) — [arxiv 2606.15828](https://arxiv.org/html/2606.15828) (search summary, UNVERIFIED). Linux kernel maintainers resisted a generic AGENTS.md; an agent added a Signed-off-by line itself — [mindstudio](https://www.mindstudio.ai/blog/linux-kernel-agents-md-debate) (secondary, UNVERIFIED). Claimed MSR 2026 study of 302,579 AI commits (22.7% of introduced issues persist) — [codex.danielvaughan.com](https://codex.danielvaughan.com/2026/06/23/silent-technical-debt-ai-generated-code-empirical-evidence-codex-cli-quality-defence-patterns/) (secondary, UNVERIFIED).
- Related Show HNs for agent sprawl: Clash (conflicts between parallel agents) [HN 46887382](https://news.ycombinator.com/item?id=46887382); LynxPrompt (AI config rules manager, "stop maintaining the same workflow in five places" theme, also [Skillful](https://news.ycombinator.com/item?id=48932688)); robin_reala, 1 Oct 2026: "Due to AI, I have disabled external pull requests on all my repos" (title only) [HN 49927780](https://news.ycombinator.com/item?id=49927780).

### Gaps
- Agent messy-commit/stray-file complaints: no primary thread found; Reddit unverified.

## 5. Show HN / similar dashboard and health tools and their feedback

### Takeaway
At least six multi-repo or repo-health Show HNs in 2025-26 got 1-7 points and almost no discussion; the only substantive critique concerned tokens/trust and metric validity (shouldiuse.dev).

### Cited Findings
- Repo Linked, "Manage 100 Git Repositories from One Dashboard" (23 Oct 2025, 3 pts): Electron/Angular, macOS only; author asked what features would help; one comment, asking the language used. — [HN 45678928](https://news.ycombinator.com/item?id=45678928)
- Git-Scope TUI dashboard (11 Dec 2025, 3 pts, 0 comments) — [HN 46233834](https://news.ycombinator.com/item?id=46233834); Gitwig multi-repo TUI (27 Jul 2026, 2 pts, 0) — [HN 49066882](https://news.ycombinator.com/item?id=49066882); RepoFlock fleet dashboard (28 Aug 2026, 1 pt, 0) — [HN 49475771](https://news.ycombinator.com/item?id=49475771); GWZ multi-repo workspace (15 Jul 2026, 5 pts, 0) — [HN 48915923](https://news.ycombinator.com/item?id=48915923). Titles/stats only.
- GitPulse (24 Jan 2026): only comments were about a typo in the URL; author says built to check maintainers are still active before paying for software. — [HN 46744519](https://news.ycombinator.com/item?id=46744519)
- GitPersona (7 Mar 2026): one comment, "Very handy tool". — [HN 47285084](https://news.ycombinator.com/item?id=47285084)
- shouldiuse.dev (27 Jun 2025, 13 pts): users objected to being asked for a GitHub PAT even for public repos (SCUSKU "does not inspire confidence"), asked for OAuth, and questioned closed source; heuristic scores gameable (see section 3). — [HN 44399666](https://news.ycombinator.com/item?id=44399666)
- DepsGuard (1 Jun 2026, 40 pts): positive; one bug (missed project-level configs) fixed; craftedcode: "The problem with security tooling is exactly this — you never see the attack you prevented." — [HN 48359478](https://news.ycombinator.com/item?id=48359478)
- PatchWave "Add static analysis and automerge to Dependabot" (20 Oct 2026, 10 pts, 0 comments) — [HN 50166699](https://news.ycombinator.com/item?id=50166699)
- Git Web Manager (27 Mar 2026): no outside feedback. — [HN 47542975](https://news.ycombinator.com/item?id=47542975)
- Other nonmainstream tools surfaced: mgitstatus, myrepos, govulncheck (recommended by Valsorda and ImJasonH "one of the Go ecosystem's best features"), depsguard, cooldowns.dev (named by DepsGuard author), PRoctr, [git-pull-request-dashboard](https://github.com/AKharytonchyk/git-pull-request-dashboard), Renovate.

### Inferences
- Lessons for GutCheck: local-first (no tokens/SaaS) is a trust point; avoid single opaque scores; reachability/relevance filtering matters; HN low engagement means demand signals must come from pain threads (Dependabot) rather than dashboard launches.

### Gaps
- Reddit launch posts and feedback: UNVERIFIED. Wishes/feature requests are only visible via GitHub Discussions (custom repo lists, ignore list, org/team filters, org-level views, query docs).
