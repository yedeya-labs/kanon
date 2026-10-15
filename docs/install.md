# Installing Kanon

The README's [quickstart](../README.md#quickstart) is the short path: install the plugin and run `/kanon:adopt`. This page is the long one: every way to install Kanon, what each command does, and how to pin Kanon's code by reference. [architecture.md](architecture.md) explains how the pieces fit together.

## Prerequisites

- **Node 24 or later**, **Claude Code**, and **`gh`** signed in as an admin of the repository, with a token that can write Actions secrets ([apps.md](apps.md#what-you-need)).
- **A browser on the same machine,** to click **Create** and **Install** for the GitHub Apps.
- **A CI workflow** at `.github/workflows/ci.yml`, which the review lane waits for, and one Claude credential: a `CLAUDE_CODE_OAUTH_TOKEN` secret from `claude setup-token`, or an Anthropic API key as `ANTHROPIC_API_KEY`, which a caller maps in the token's place ([lanes.md](lanes.md)).
- **A GitHub plan with rulesets** to leave bootstrap. A private repository on the Free plan has none, so it can never leave bootstrap ([`K-ADOPT-3`](../rulebook/10-adoption.md)).

Read [who Kanon is for](../rulebook/00-principles.md) first, and the [adoption checklist](../rulebook/10-adoption.md) for the order of the steps.

## Ways to install

Every way ends in the same place: Kanon's code used by reference, pinned to one exact release, with Dependabot proposing upgrades ([`K-ADOPT-11`](../rulebook/10-adoption.md)). The pieces are:

<!-- x-release-please-start-version -->

| What | Use it as |
|---|---|
| [PR-title check](../actions/pr-title/README.md) | `uses: yedeya-labs/kanon/actions/pr-title@v0.41.0` |
| [DCO sign-off check](../actions/dco/README.md) | `uses: yedeya-labs/kanon/actions/dco@v0.41.0` |
| [Release workflow](release.md) | `uses: yedeya-labs/kanon/.github/workflows/release.yml@v0.41.0` |
| [Agent lane: set up](../actions/agent-setup/README.md) | `uses: yedeya-labs/kanon/actions/agent-setup@v0.41.0` |
| [Agent lane: run the agent](../actions/agent-run/README.md) | `uses: yedeya-labs/kanon/actions/agent-run@v0.41.0` |
| [Agent lane: finish](../actions/agent-finish/README.md) | `uses: yedeya-labs/kanon/actions/agent-finish@v0.41.0` |
| [Agent lane: classify a red run](../actions/agent-classify/README.md) | `uses: yedeya-labs/kanon/actions/agent-classify@v0.41.0` |
| [Agent telemetry](../actions/agent-telemetry/README.md) | `uses: yedeya-labs/kanon/actions/agent-telemetry@v0.41.0` |
| [Agent lanes: review, triage, implement, implement-revise, lead, lead-revise, lead-reconcile, lead-split, merge, merge-reconcile, rebase, verify-acs, project-digest, weekly-digest, explore, dispatch-sweep, issue-backstop, code-audit, explore-telemetry, deploy-diagnose, overseer](lanes.md) | `uses: yedeya-labs/kanon/.github/workflows/agent-<lane>.yml@v0.41.0` in a job |
| [Lane check](../actions/lane-check/README.md) | `uses: yedeya-labs/kanon/actions/lane-check@v0.41.0` |
| [Kanon's scripts from a workflow step](../actions/kanon-path/README.md) | `uses: yedeya-labs/kanon/actions/kanon-path@v0.41.0` |

<!-- x-release-please-end -->

**Or let `kanon init` do the installation** ([plan 0005](plans/0005-lean-installation.md) §5.4, [plan 0007](plans/0007-guided-install.md)). Run from your repository's checkout, it inspects the repository and its owner and asks three questions: which feature you want (Review, Review + build, or the full pipeline), whether the repository holds sensitive material, and one consent question about sharing; the adopt skill also asks which environments your releases deploy to, in order, or none ([init.md](init.md#the-deploy-lane)). It infers everything else and shows it in one summary to confirm, the Claude credential among it: the subscription's token, or an API key when the repository holds `ANTHROPIC_API_KEY` and not the token, which `--claude-auth subscription|api-key` overrides ([init.md](init.md#the-claude-credential)). It then writes the lane callers, the declarations that differ from their defaults, `lane-check` in CI and the Dependabot entry, all pinned to the release it runs from, and, with the full pipeline, the Lead's brief template, `docs/projects/_template.md`, unless you have one (`K-LAYOUT-11`), and, for the deploy environments you declare, the deploy lane's caller and its three hook stubs; creates the labels, the bucket milestones and, where your plan has rulesets, the default branch's ruleset; and runs `kanon apps` for the Apps the lanes need. It commits nothing, prints as exact steps whatever your token or plan can't do, and changes nothing on a second run. A program can drive it too, with a flag per answer and `--json` ([init.md](init.md)). `--dry-run` shows it all first:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.41.0 kanon init --dry-run
```

<!-- x-release-please-end -->

Each release also ships [`requirements.json`](../requirements.json): what its lanes need of an adopter (secrets, the caller's grant, the documents and workflows they read, the hooks they call, the Apps they run as), built from the lanes and held to them by a test.

**Or let your agent do it, with Kanon's skills for Claude Code** ([docs/skills.md](skills.md)). Type `/kanon:adopt`, which runs `kanon init` for you (the agent can't start it on its own, so asking it to install Kanon won't): a dry run first, each choice explained and asked, the files written on a branch, and each step only you can take (clicking **Create** and **Install** for the Apps, typing a secret) walked through, then the pull request, which you merge. `/kanon:doctor` checks an installation and fixes what it can, and `/kanon:upgrade` moves your pins to a new release. Install them as a plugin, pinned to the same release as everything else:

<!-- x-release-please-start-version -->

```sh
claude plugin marketplace add yedeya-labs/kanon#v0.41.0
claude plugin install kanon@kanon
```

<!-- x-release-please-end -->

Or declare the plugin in the repository, in `.claude/settings.json`, which `kanon init` offers to write: everyone who uses Claude Code there then gets the skills at that release, moving to a new one is one edit, and `kanon doctor` says when it differs from your callers' pin ([docs/skills.md](skills.md#declare-it-in-the-repository)).

**Before you move the pin, run [`kanon doctor`](doctor.md)** (plan 0005 §5.5). From the checkout, `kanon doctor --to <release>` compares your installation with that release's requirements file and lists what it needs, in the order to do it, each with its exact fix: an App permission to widen, a declaration to add, a caller's grant or secret to change. It also lists every job of your workflows that holds `id-token: write`, which the QA store's role and the telemetry writer admit. It writes nothing, and `--json` prints the same result as a versioned document for scripts and agents.

**Create the bucket milestones with `kanon milestones`** (step 7 of the checklist). It creates *Product Backlog* and *Development Automation*, with no due date, when no milestone has that name, and reports one that has a due date or is closed without changing it. Running it again creates nothing:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.41.0 kanon milestones --repo <owner>/<repo>
```

<!-- x-release-please-end -->

**Create the Apps with [`kanon apps`](apps.md)** (step 12 of the checklist): two per owner, reused across its repositories, the **Author** (Implementer, Lead, Explorer, Overseer) and the **Judge** (Reviewer, Merger), and the optional **Releaser** for releases. It builds each App from a manifest with exactly its permissions, stores its id and key as Actions secrets with your own `gh`, and writes one App register row per role. You click **Create** and **Install** in GitHub for each App; the command never creates one itself. The owner may be a personal account or an organisation; the command asks GitHub which, and refuses to run anywhere but your repository's checkout. Run it straight from a Kanon release tag, inside that checkout:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.41.0 kanon apps --owner <owner> --repo <repo> --apps author,judge
```

<!-- x-release-please-end -->

Every lane in [`docs/lanes.md`](lanes.md) ships at this version ([plan 0001](plans/0001-move-the-agent-lanes.md), steps 1 to 5). **Start with the review lane:** it is the first an adopter installs, because its App is what ends bootstrap (`K-ADOPT-6`), on a plan with rulesets (`K-ADOPT-3`). [`docs/lanes.md`](lanes.md#your-first-lane-the-reviewer) walks through it. The Explorer's sweep (explore), the dispatch sweep, the code audit and the optional Overseer reach their memory through the QA store contract ([`docs/qa-store.md`](qa-store.md)); the dispatch sweep reads run artifacts without a store. That completes the store-coupled lanes ([plan 0004](plans/0004-move-the-remaining-lanes.md)).

## After merging

The pull request that installs the review lane leaves the repository in bootstrap: the ruleset `kanon init` creates requires no approving review, because no Reviewer could give one yet (`K-ADOPT-6`). **What ends bootstrap is requiring one,** once that pull request has merged and the review lane runs on the default branch, so the Reviewer can approve there: switch on one required approving review in the default branch's ruleset, dismissed when a new commit is pushed (`K-MERGE-6`), and write the date under `## Bootstrap` in the adoption record, as `ended YYYY-MM-DD` (`K-LAYOUT-10`). On a private repository whose plan has no rulesets, it can't end (`K-ADOPT-3`).

**How review starts,** once that pull request has merged: add `review:please` to a pull request when it opens, without waiting for its CI. The review lane waits for CI itself, and reviews a labelled pull request once CI has finished on its head ([lanes.md](lanes.md#your-first-lane-the-reviewer)). The pull request that installs the lane is never reviewed by it.

**[`kanon doctor`](doctor.md) reminds you.** Once the Judge App is installed and the review lane is on the default branch, it reports `ruleset.bootstrap-can-end` while the ruleset requires no approval, with the command that requires it. Once the adoption record says bootstrap ended, it fails a ruleset that stops requiring an approving review (`ruleset.approval-off`): bootstrap never returns.
