# Agent lanes

Kanon ships each agent lane as a **reusable workflow** ([plan 0001](plans/0001-move-the-agent-lanes.md), decision 1). An adopter writes, per lane, a short **caller** that holds the lane's triggers, and one **project-setup hook** that holds everything specific to its project. Kanon holds the rest: the admission rules, the round caps, the prompts and the model settings.

## Which lanes are available

| Lane | File | Role (App) | Caller's triggers |
|---|---|---|---|
| Triage and fix | `agent-triage.yml` | Implementer | `issues: [labeled]`; `workflow_dispatch` with `issue_number` |
| Implement | `agent-implement.yml` | Implementer | `issues: [labeled]`; `workflow_dispatch` with `issue_number` |
| Implement, revise | `agent-implement-revise.yml` | Implementer | `pull_request_review: [submitted]`; `pull_request: [labeled]`; `workflow_dispatch` with `pr_number` and `reset` |
| Lead, revise | `agent-lead-revise.yml` | Lead | `pull_request_review: [submitted]`; `pull_request: [labeled]`; `workflow_dispatch` with `pr_number` and `reset` |
| Merge reconcile | `agent-merge-reconcile.yml` | Reviewer | `pull_request: [closed]`; `pull_request_review: [submitted]`; `workflow_dispatch` with `pr_number` |
| Review | `agent-review.yml` | Reviewer | `workflow_run` of your `CI` workflow, `types: [completed]`; `pull_request_target: [opened, labeled]`; `workflow_dispatch` with `pr_number` |
| Verify acceptance criteria | `agent-verify-acs.yml` | Explorer | `workflow_dispatch` with `project` and `ref`; `issues: [labeled]` |
| Lead, brief | `agent-lead.yml` | Lead | `workflow_dispatch` with `mandate` and `context` |
| Lead, split | `agent-lead-split.yml` | Lead | `issues: [labeled]`; `workflow_dispatch` with `issue` |
| Rebase (resolve a conflict) | `agent-rebase.yml` | Implementer | `workflow_run` of your `CI` workflow, `types: [completed]`, `branches` your default branch; `schedule` (a daily floor); `workflow_dispatch` with `pr_number` |

Most lanes call the shared lane workflow, `agent-lane.yml`, which is not called by an adopter directly; merge reconcile calls the blocks itself and installs nothing, so it never calls your hook, and review, verify-acs, lead-split and rebase call the blocks around steps of their own.

**The review lane** has three things the others don't:
- **Its caller sets `run-name`,** ending with `${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }}`. A called workflow's `run-name` is ignored, and the review-run evidence finds a head's reviews by the last token of the run's title. `lane-check` holds the caller to it.
- **It reads your CI from `.github/workflows/ci.yml`.** A review label added while CI is still running defers to CI's completion, and the lane asks Actions about the runs of that file for the head. Your caller's `workflow_run` names that workflow.
- **It never reviews under the pull request's own instructions** (`K-MERGE-17`). Before any of the PR's code runs, it restores every input on the rule's list from your default branch: `AGENTS.md`, `CLAUDE.md`, `.claude/`, every markdown file directly inside `docs/qa/`, your project-setup hook, and every markdown document those link to or import. The PR's own copies are set aside under `.qa-pr/`, so the Reviewer still reads them as part of the diff, and a push that touches one re-opens an approved review. The specs under `docs/qa/specs/` come from the PR. Your own tests that read one of those files should read the `.qa-pr/` copy when there is one, or they will fail in the Reviewer's tree on a PR that changes it.

**Grant a lane's job-level permissions too.** The implement lane's crash recovery writes issues, reads pull requests and reads its own run on the workflow token, so its caller grants `contents: read`, `issues: write`, `pull-requests: read` and `actions: read`. The rebase lane's filter reads pull requests and its earlier runs' jobs on the workflow token, so its caller grants `contents: read`, `actions: read` and `pull-requests: read`; the split lane's gate edits the issue's labels, so its caller grants `issues: write` and `pull-requests: read`.

## Asking the review lane again

One commit gets one verdict. The lane skips a head the Reviewer has already reviewed, and a run that waited behind another review of the same head stands down when that review posts ([#88](https://github.com/yedeya-labs/kanon/issues/88)). A new verdict on an unchanged commit comes only from a request made *after* the last one:

- **Push.** A new commit is reviewed when CI finishes on it. This is how a fix gets its review, so there is nothing to re-request.
- **A person re-applies `review:please`** after the verdict, to ask for another look at the same commit (for example after editing the PR body). The lane treats a label applied by a person as an explicit request. A label applied before the verdict landed is answered by that verdict.
- **Tooling dispatches the lane:** `gh workflow run <your review caller> -f pr_number=N`. A dispatch reviews regardless of labels, and its run records who asked. Like a label, it is answered by a verdict on the head that lands while it waits, so dispatch after the verdict, not during the review.

**Tooling must not churn the label.** Removing and re-applying `review:please` through a person's token is indistinguishable from that person asking. A churn that lands after the verdict spends a second full review on the same commit, and one that lands before it is wasted. A script that acts for a person dispatches instead, or waits for the push to do the asking. Apps can re-apply the label (the recovery in `K-MERGE-14` does), because a label applied by an App is never an explicit request.

## Only members start a lane

Every lane starts real work only when the actor of its triggering event is a member: GitHub's `author_association` of `OWNER`, `MEMBER` or `COLLABORATOR`, or one of your agent Apps listed in the App register (`K-AGENT-45`). The check is the first step of the lane's first job, [`scripts/lane-gate.mjs`](../scripts/lane-gate.mjs), before any token is minted, so it runs on a private repository exactly as on a public one (`K-PRIN-20`).

| Event | The actor | How it is checked |
|---|---|---|
| A review | the reviewer | the review's `author_association` |
| A label | whoever applied it | their permission on the repository: triage or more |
| A merge (`pull_request: closed`) | whoever merged it | the same |
| A dispatch | whoever ran it, re-runs included | the same; only write access can dispatch, so this refuses only an unregistered App |
| A pull request opened (`pull_request_target`) | whoever opened it | the same |
| A finished workflow (`workflow_run`) | whoever pushed the commit it ran on | the same |
| A finished CI run, on the review lane | whoever last applied a review label (`review:please`, `agent:triage` or `agent:implement`) that the head's open pull request carries now, read from its issue events | the same. With no such pull request or label, refused. A label added while CI runs waits for CI, so this is that label's actor, not the pusher, who on a dependency bot's PR is the bot ([#81](https://github.com/yedeya-labs/kanon/issues/81)). A fork's head is refused separately |
| A schedule | the user GitHub runs it as: whoever last changed the cron, or the default branch | the same, so a schedule set by someone who has since lost access is refused |
| Anything else | none | refused: no lane acts on it |

A login ending in `[bot]` is judged by the App register alone, read from your default branch, never from the pull request. A refused event leaves the lane's later steps and jobs skipped, with a notice and a step-summary line naming who was refused and why; it does not turn the run red. A failed API call or a malformed register does.

**Every lane carries the gate.** [`tests/unit/lane-gate.test.ts`](../tests/unit/lane-gate.test.ts) fails for a lane in Kanon without it, or with a step or job that can run past a refusal, and for a lane whose triggers it doesn't list.

**A dispatch made with the workflow token is refused.** Its actor is `github-actions[bot]`, which is not in your App register. So no lane starts another that way. When an implement run hits its turn or budget cap, its crash recovery adds `qa:needs-split` with the Implementer's App token, narrowed to Issues write, and that label's own event starts the split lane through the gate as a registered App. Its comment stays on the workflow token, so it never reads as the Implementer's.

## The caller

A caller holds `name`, `on`, `permissions` and one job, and nothing else (and `run-name`, which the review lane asks for):

<!-- x-release-please-start-version -->

```yaml
name: Implement — revise

on:
  pull_request_review:
    types: [submitted]
  pull_request:
    types: [labeled]
  workflow_dispatch:
    inputs:
      pr_number:
        description: PR to revise
        required: true
      reset:
        description: Clear the round cap for this run.
        type: boolean
        default: false

permissions:
  contents: read
  pull-requests: read
  issues: read

jobs:
  revise:
    uses: yedeya-labs/kanon/.github/workflows/agent-implement-revise.yml@v0.14.0
    with:
      pr_number: ${{ inputs.pr_number }}
      reset: ${{ inputs.reset }}
    secrets:
      IMPLEMENTER_APP_ID: ${{ secrets.IMPLEMENTER_APP_ID }}
      IMPLEMENTER_APP_PRIVATE_KEY: ${{ secrets.IMPLEMENTER_APP_PRIVATE_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

<!-- x-release-please-end -->

- **Triggers are yours.** A reusable workflow can't declare its caller's events. The `github` context in a called workflow is the caller's, so the lane reads the triggering event exactly as it would in your own file.
- **Inputs pass through, by name.** `with:` passes your `workflow_dispatch` inputs as `${{ inputs.<name> }}`, and nothing else. On the other triggers they arrive empty, which the lane expects.
- **`permissions:` is the ceiling.** Each lane declares the permissions it needs, and a called workflow can only narrow what its caller grants. Grant at least what the lane declares, or the run fails to start.
- **Secrets are mapped explicitly, by their fixed names** ([plan 0001 §8](plans/0001-move-the-agent-lanes.md)): `<ROLE>_APP_ID`, `<ROLE>_APP_PRIVATE_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. Never `secrets: inherit`, which would hand every secret in your repository to Kanon's code.
- **No `concurrency:`.** Each lane holds its own concurrency group. The same group on the caller would have the caller wait for itself.
- **One version.** Every Kanon reference in your repository pins the same exact version, and Dependabot proposes upgrades (`K-ADOPT-11`).

## Kanon's scripts

The lanes run Kanon's pipeline library (`scripts/`) from the runner's action cache, at the version you pinned, never from your checkout: a step finds it with [`kanon-path`](../actions/kanon-path/README.md) and runs `node "$KANON/scripts/<name>.mjs"`. The scripts read your repository's files at the paths in [chapter 11](../rulebook/11-repository-layout.md), relative to the working directory, so they run in your checkout. A workflow of your own that runs one of them does the same, which is how Kanon's guards reach your CI: `kanon-path` at the pinned tag, then `node "$KANON/scripts/<guard>.mjs"`, with Dependabot proposing the upgrades. The scripts use only Node's built-in modules, so neither your repository nor the step needs a `package.json`, an install or a package manager, whatever your project's language. Node is Kanon's runtime, not your project's, and `kanon-path` sets it up: the version in `engines` in Kanon's own manifest, pinned, rather than whichever Node the runner image carries. Its [README](../actions/kanon-path/README.md) says where to call it relative to your own toolchain.

## The project-setup hook

`.github/actions/project-setup/action.yml` is a composite action you write ([plan 0001 §5](plans/0001-move-the-agent-lanes.md)). Every lane that checks out calls it after the checkout and before the agent, with these inputs, all strings: `lane`, `install`, `database`, `browsers`, `issue-number`, `app-slug` and `github-token`. It installs your toolchain and dependencies, and, when `database` is `'true'`, sets up your schema against Kanon's standard database (`DATABASE_URL=postgres://kanon:kanon@localhost:5432/kanon`, `pgvector/pgvector:pg17`). It is read from the checked-out tree, so on a lane that checks out a pull request it is that branch's copy, except on the review lane, which restores your default branch's copy first (`K-MERGE-17`). The verify-acs lane loads it from your caller's commit, because the release it verifies may predate it.

The contract defines no outputs, and no lane reads any: a lane judges your hook only by whether it succeeded. The review lane still reviews a pull request whose setup failed, and notes it on the run ([#77](https://github.com/yedeya-labs/kanon/issues/77)).

## The App register

The revise lanes find their own App's login in the App register, and the scripts the lanes run read every role's login from it, `docs/qa/agent-identities.md` (`K-LAYOUT-6`), read from your default branch. Each role a lane runs as needs one row there with its App slug in backticks.

## Checking it

Run [`lane-check`](../actions/lane-check/README.md) in CI. It fails on a caller that holds more than the above or a review caller whose `run-name` doesn't end with the head SHA, passes a setting instead of an input, maps the wrong secrets, grants too little, or pins a second version; on a missing or incomplete hook; on a role missing from the App register; and on a missing Dependabot entry.
