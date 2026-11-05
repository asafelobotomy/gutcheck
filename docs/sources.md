# Where GutCheck's advice comes from

GutCheck's checks and fix steps were compared against GitHub's official documentation, the OpenSSF Scorecard and Best Practices criteria, the git documentation, and widely used community conventions. This page lists what each check is based on, where GutCheck chose a severity itself, and what it deliberately does not check.

Research was done in November 2026 with Context7 (`/github/docs`, `/ossf/scorecard`), docs.github.com, git-scm.com and the project pages linked below.

## Sources and the checks built on them

| Area | GutCheck check | Source |
| --- | --- | --- |
| Community files | README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, SUPPORT, PR template: found in `.github/`, root or `docs/`; owner defaults from the `.github` repository count | [Default community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file) |
| Licence | Error only for public repos: without one, nobody may legally reuse the code | [Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository), Scorecard *License* |
| Security policy | Warn on public repos without SECURITY.md (or an inherited policy) | [Adding a security policy](https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository), Scorecard *Security-Policy* |
| CODEOWNERS, issue templates, topics | Info on public repos | GitHub docs: [code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners), [issue templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository), [topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) |
| Branch protection | Classic protection **or an active ruleset** covering the default branch counts | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), Scorecard *Branch-Protection* |
| Actions: script injection | Error: `github.head_ref` or `github.event.*` values ending in body, title, ref, label, message, name, email, page_name, default_branch inside a `run:` script | [Secure use: script injection](https://docs.github.com/en/actions/reference/security/secure-use), Scorecard *Dangerous-Workflow* |
| Actions: privileged triggers | Error when `pull_request_target`/`workflow_run` also checks out the PR head; info otherwise | Same, plus GitHub Security Lab "Preventing pwn requests" |
| Actions: token permissions | Warn without a `permissions:` block, or with `write-all` | Scorecard *Token-Permissions* |
| Actions: pinning | Warn for any `uses:` not pinned to a 40-character SHA (local `./` actions and digest-pinned images pass) | [Secure use: third-party actions](https://docs.github.com/en/actions/reference/security/secure-use), Scorecard *Pinned-Dependencies* |
| Actions: self-hosted runners | Warn on public repos | GitHub secure-use guide |
| Dependabot | Config present; warn-level info when workflows exist but `github-actions` is not an ecosystem | [Dependabot options](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference), Scorecard *Dependency-Update-Tool* |
| Security features | Secret scanning, push protection, CodeQL default setup, private vulnerability reporting (public repos, where they are free); Dependabot security updates. Only read for repos you administer; "not visible" is never reported as "off" | GitHub REST: repos (`security_and_analysis`), code-scanning default setup, private vulnerability reporting |
| Large files and repo size | Tracked files: info from 5 MB, warn at 50 MB, error over 100 MB. Repo: warn over 1 GB, error over 5 GB. Deep scan: blobs of 50 MB+ anywhere in history | [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) |
| Secrets in history | Fix steps say: rotate first; history rewrites only with the owner | [Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) |
| Line endings | Info without `.gitattributes`; fix uses `* text=auto` and `git add --renormalize .` | [Configuring Git to handle line endings](https://docs.github.com/en/get-started/git-basics/configuring-git-to-handle-line-endings) |
| Git housekeeping | Stashes, upstream gone, prunable worktrees, submodules, loose objects (above git's `gc.auto` 6700), stray files | git docs: [stash](https://git-scm.com/docs/git-stash), [branch](https://git-scm.com/docs/git-branch), [worktree](https://git-scm.com/docs/git-worktree), [submodule](https://git-scm.com/docs/git-submodule), [gc](https://git-scm.com/docs/git-gc), [maintenance](https://git-scm.com/docs/git-maintenance) |
| Safe scanning | Every git call disables `core.fsmonitor` and hooks and takes no index lock, because a repo's own config can name programs to run | [git-config](https://git-scm.com/docs/git-config) (`core.fsmonitor` as a hook), Talos TALOS-2025-2243 |
| README | Info when nearly empty or without an install/usage/develop section | [Standard Readme](https://github.com/RichardLitt/standard-readme/blob/main/spec.md), [makeareadme](https://www.makeareadme.com/) |
| Changelog | Info when there are tags but neither a changelog nor GitHub releases | [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), OpenSSF Best Practices `release_notes` |
| Editor settings | Info without `.editorconfig` | [EditorConfig](https://editorconfig.org/) |
| Runtime version | Info when a Node or Python project pins no version (`.nvmrc`, `engines`, `.python-version`, `requires-python`, `.tool-versions`) | [npm engines](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines) |
| Workspace git config | Warn without a global `user.email` or with `credential.helper=store`; info without a global gitignore | [Commit email](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/setting-your-commit-email-address), [gitcredentials](https://git-scm.com/docs/gitcredentials), [core.excludesFile](https://git-scm.com/docs/git-config) |
| Disk space | Info: dependency folders (node_modules, target, venvs) of projects untouched for 90 days; fixes are previews only (`npkill --dry-run`, `cargo clean --dry-run`) | [npkill](https://github.com/voidcosmos/npkill), [cargo clean](https://doc.rust-lang.org/cargo/commands/cargo-clean.html) |

## Severities GutCheck chose

The sources describe risks, not severities. GutCheck uses **error** for things that expose secrets or code execution now (script injection, credentials in a remote URL, committed env files, files GitHub will reject), **warn** for weak defaults with real consequences (unpinned actions, missing permissions, no security policy on a public repo, large repos), and **info** for conventions (editorconfig, topics, changelog). Info findings cost one point of the health score each.

## Deliberately not checked

- **Commit message style** (Conventional Commits) and **SemVer tags**: conventions, not defects; projects choose them.
- **Signed commits and releases**, **SBOMs**, **fuzzing**, **contributor diversity**, **CII badge**: Scorecard checks that suit large open-source projects more than a personal workspace.
- **Webhook secrets**: needs extra admin API calls per repo for a rare problem.
- **Full secret scanning of git history**: use gitleaks or trufflehog; GitHub's own secret scanning covers pushes. GutCheck scans the working tree.
- **git fsck**: too slow to run on every scan; the fix steps suggest it when the object store looks damaged.
- **Performance settings** (`core.fsmonitor`, `feature.manyFiles`, partial clone): only worth it for very large repos; GutCheck suggests `git maintenance start` when loose objects pile up.
