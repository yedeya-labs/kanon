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

**What each caller maps, grants and needs.** Every caller maps its role's two App secrets and `CLAUDE_CODE_OAUTH_TOKEN`, by name. It grants at least the permissions below, which are the most any of the lane's jobs declares, and it needs the project documents below on your default branch (`K-LAYOUT-17`). A lane that reads no document still needs the project-setup hook if it checks out. [`tests/unit/lanes-doc.test.ts`](../tests/unit/lanes-doc.test.ts) fails when this table and the lanes disagree.

<!-- lane-contract:table -->

| Lane | App secrets | Grant at least | Reads |
|---|---|---|---|
| `agent-triage.yml` | `IMPLEMENTER_APP_ID`, `IMPLEMENTER_APP_PRIVATE_KEY` | `contents: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |
| `agent-implement.yml` | `IMPLEMENTER_APP_ID`, `IMPLEMENTER_APP_PRIVATE_KEY` | `contents: read`, `issues: write`, `pull-requests: read`, `actions: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |
| `agent-implement-revise.yml` | `IMPLEMENTER_APP_ID`, `IMPLEMENTER_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |
| `agent-lead-revise.yml` | `LEAD_APP_ID`, `LEAD_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: write` | none |
| `agent-merge-reconcile.yml` | `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY` | `contents: read`, `pull-requests: read` | `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` |
| `agent-review.yml` | `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: write`, `actions: read` | `docs/qa/stack.md`, `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` |
| `agent-verify-acs.yml` | `EXPLORER_APP_ID`, `EXPLORER_APP_PRIVATE_KEY` | `contents: read`, `issues: read` | `docs/qa/explorer-playbook.md` |
| `agent-lead.yml` | `LEAD_APP_ID`, `LEAD_APP_PRIVATE_KEY` | `contents: read` | `docs/qa/lead-playbook.md` |
| `agent-lead-split.yml` | `LEAD_APP_ID`, `LEAD_APP_PRIVATE_KEY` | `contents: read`, `issues: write`, `pull-requests: read` | `docs/qa/lead-playbook.md` |
| `agent-rebase.yml` | `IMPLEMENTER_APP_ID`, `IMPLEMENTER_APP_PRIVATE_KEY` | `contents: read`, `pull-requests: read`, `actions: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |

<!-- /lane-contract:table -->

Most lanes call the shared lane workflow, `agent-lane.yml`, which is not called by an adopter directly; merge reconcile calls the blocks itself and installs nothing, so it never calls your hook, and review, verify-acs, lead-split and rebase call the blocks around steps of their own.

**The review lane** has three things the others don't:
- **Its caller sets `run-name`,** ending with `${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }}`. A called workflow's `run-name` is ignored, and the review-run evidence finds a head's reviews by the last token of the run's title. `lane-check` holds the caller to it.
- **It reads your CI from `.github/workflows/ci.yml`.** A review label added while CI is still running defers to CI's completion, and the lane asks Actions about the runs of that file for the head. Your caller's `workflow_run` names that workflow.
- **It never reviews under the pull request's own instructions** (`K-MERGE-17`). Before any of the PR's code runs, it restores every input on the rule's list from your default branch: `AGENTS.md`, `CLAUDE.md`, `.claude/`, every markdown file directly inside `docs/qa/`, your project-setup hook, and every markdown document those link to or import. The PR's own copies are set aside under `.qa-pr/`, so the Reviewer still reads them as part of the diff, and a push that touches one re-opens an approved review. The specs under `docs/qa/specs/` come from the PR. Your own tests that read one of those files should read the `.qa-pr/` copy when there is one, or they will fail in the Reviewer's tree on a PR that changes it.

**Why a caller grants more than `contents: read`.** "Grant at least" includes the permissions a lane's jobs use on the workflow token, not only the lane's top level. The implement lane's crash recovery writes issues, reads pull requests and reads its own run. The rebase lane's filter reads pull requests and its earlier runs' jobs. The split lane's gate edits the issue's labels. The review lane reads CI's runs for the head, and comments on a pull request opened without a review label.

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

**A lane refuses a caller that pins another Kanon version than your default branch** ([#69](https://github.com/yedeya-labs/kanon/issues/69), `K-MERGE-17`). On `pull_request_target`, GitHub runs the base branch's copy of your caller. On a stacked pull request that base is another pull request's branch, and its caller can pin another version. On `pull_request` and `pull_request_review`, it runs the pull request's own merge of your caller. So when the caller ran from anywhere but the default branch (another branch, a tag from a dispatch with `--ref`, or a pull request's merge ref), the gate reads that caller at the commit that ran and at your default branch, and compares every Kanon reference in them (each `uses:` of a `yedeya-labs/kanon` path, with its version). If your caller reaches the lane through a reusable workflow of your own repository (`uses: ./.github/workflows/lanes.yml`, or `$/…`), the gate follows it, to any depth, and compares the Kanon references of every workflow it reaches ([#118](https://github.com/yedeya-labs/kanon/issues/118)). If they differ, if the default branch has no such caller or lacks a workflow it calls, or if neither side holds any Kanon reference (the lane was reached through something the gate can't read, such as another repository's workflow), the lane is refused with a `Kanon pin: refused.` summary line. A run from the default branch reads nothing. A pull request never chooses the Kanon version that acts on it. **So on a pull request that bumps the pin, Dependabot's for example, the lanes it triggers on `pull_request` and `pull_request_review` (the revise and merge-reconcile lanes) refuse, visibly, until it merges. Merge reconcile on that pull request's own merge runs, because by then your default branch carries the new pin too.** Its review is unaffected, because the review lane runs from the base. **This holds only between versions that have the check.** The gate is Kanon at the version the running caller pins, so a base whose caller pins a release from before it runs a gate without it. Enforcing it from outside the lane is [#114](https://github.com/yedeya-labs/kanon/issues/114).

**A dispatch made with the workflow token is refused.** Its actor is `github-actions[bot]`, which is not in your App register. So no lane starts another that way. When an implement run hits its turn or budget cap, its crash recovery adds `qa:needs-split` with the Implementer's App token, narrowed to Issues write, and that label's own event starts the split lane through the gate as a registered App. Its comment stays on the workflow token, so it never reads as the Implementer's.

## The caller

A caller holds `name`, `on`, `permissions` and one job, and nothing else (and `run-name`, which the review lane asks for):

<!-- x-release-please-start-version -->

```yaml
name: Implement (Implementer) — revise

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
    uses: yedeya-labs/kanon/.github/workflows/agent-implement-revise.yml@v0.18.0
    with:
      pr_number: ${{ inputs.pr_number }}
      reset: ${{ inputs.reset }}
    secrets:
      IMPLEMENTER_APP_ID: ${{ secrets.IMPLEMENTER_APP_ID }}
      IMPLEMENTER_APP_PRIVATE_KEY: ${{ secrets.IMPLEMENTER_APP_PRIVATE_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

<!-- x-release-please-end -->

- **Four callers have fixed names** ([#53](https://github.com/yedeya-labs/kanon/issues/53)). GitHub reports a called lane's checks under its caller's `name:`, and the merge gate tells its own checks, and the review event's, from the rest by that name. Name the review lane's caller `Review (Reviewer)`, the merge-reconcile lane's `Merge Reconcile (Reviewer)`, the implement-revise lane's `Implement (Implementer) — revise` and your Merger's workflow `Merge (Merger)`, and give the revise and merge-reconcile callers' one job the ids `revise` and `reconcile`. Under another name the Merger waits on itself.
- **Triggers are yours.** A reusable workflow can't declare its caller's events. The `github` context in a called workflow is the caller's, so the lane reads the triggering event exactly as it would in your own file.
- **Inputs pass through, by name.** `with:` passes your `workflow_dispatch` inputs as `${{ inputs.<name> }}`, and nothing else. On the other triggers they arrive empty, which the lane expects.
- **`permissions:` is the ceiling.** Each lane declares the permissions it needs, and a called workflow can only narrow what its caller grants. Grant at least what the lane declares, or the run fails to start.
- **Secrets are mapped explicitly, by their fixed names** ([plan 0001 §8](plans/0001-move-the-agent-lanes.md)): `<ROLE>_APP_ID`, `<ROLE>_APP_PRIVATE_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. Never `secrets: inherit`, which would hand every secret in your repository to Kanon's code. [`kanon apps`](apps.md) stores the two App secrets. `CLAUDE_CODE_OAUTH_TOKEN` is the token of the Claude subscription the agents run on. Make it with `claude setup-token`, signed in to that subscription, and store it yourself with `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/<repo>`, pasting it on standard input.
- **No `concurrency:`.** Each lane holds its own concurrency group. The same group on the caller would have the caller wait for itself.
- **One version.** Every Kanon reference in your repository pins the same exact version, and Dependabot proposes upgrades (`K-ADOPT-11`).

## Old spellings

Some strings are read by another program by their exact text: the Merger's comment marker (`<!-- merger:<rule>:<sha> -->`) and escalation header, the split lane's branch (`lead/split-<n>`), the Lead's adoption sentence, the four caller names above, and the retry steps' names. Kanon writes them with role names. Until [#53](https://github.com/yedeya-labs/kanon/issues/53) they carried the reference adopter's agent names, caller names and issue numbers, and a pull request, branch, issue or run from then still carries them, so the readers accept both spellings. [`scripts/lib/protocol-spellings.mjs`](../scripts/lib/protocol-spellings.mjs) holds both.

The old spellings are read until a measurement says nothing live carries them. [`scripts/protocol-census.mjs`](../scripts/protocol-census.mjs), run in your checkout with `GITHUB_REPOSITORY` set, lists every caller, open pull request (its comments, its checks and the failed runs on its head), open issue and branch that still carries one, and exits 0 only when there are none. When it exits 0 in every adopter Kanon knows of, a release drops the old spellings.

## Your first lane: the Reviewer

Install the review lane first. Its App is the one that ends bootstrap, on a plan with rulesets (`K-ADOPT-3`, `K-ADOPT-6`), and it needs no other lane. On one branch, add:

1. **The project-setup hook** (below), and `docs/qa/test-database.md` if your tests need a database.
2. **The documents the review lane reads**: `docs/qa/stack.md`, `docs/qa/reviewer-playbook.md` and `docs/qa/explorer-playbook.md`, with the sections `K-LAYOUT-17` names.
3. **The caller**:

<!-- x-release-please-start-version -->

```yaml
name: Review (Reviewer)

run-name: Review ${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }}

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  pull_request_target:
    types: [opened, labeled]
  workflow_dispatch:
    inputs:
      pr_number:
        description: PR number to review
        required: true

permissions:
  contents: read
  pull-requests: write
  actions: read
  issues: read

jobs:
  review:
    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.18.0
    with:
      pr_number: ${{ inputs.pr_number }}
    secrets:
      REVIEWER_APP_ID: ${{ secrets.REVIEWER_APP_ID }}
      REVIEWER_APP_PRIVATE_KEY: ${{ secrets.REVIEWER_APP_PRIVATE_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

<!-- x-release-please-end -->

4. **[`lane-check`](../actions/lane-check/README.md) in CI**, and the Dependabot entry it asks for.
5. **The Reviewer's App:** run [`kanon apps --roles reviewer`](apps.md) from that branch's checkout, and commit the register row it writes. `lane-check` fails a caller whose role has no row in the App register, so create the App before you push, or the branch is red until you do. If you must push first, a row for the role with the slug `kanon apps` will give it (`<repo>-reviewer`) passes `lane-check`. `kanon apps` rewrites an existing row for its role in place, so mark that row as a placeholder and never merge it.
6. **`CLAUDE_CODE_OAUTH_TOKEN`**, as above.

Then merge. **The first review comes on the next pull request, not this one.** Both automatic triggers run the default branch's copy of the caller (`pull_request_target` runs the base's, `workflow_run` the default branch's), so a pull request that adds the caller is never reviewed by it. In bootstrap, a human merges that one (`K-ADOPT-4`). Then apply `review:please` to any open pull request whose CI has finished, or dispatch the lane (`gh workflow run <your caller> -f pr_number=N`), and the Reviewer's App posts a verdict.

## Kanon's scripts

The lanes run Kanon's pipeline library (`scripts/`) from the runner's action cache, at the version you pinned, never from your checkout: a step finds it with [`kanon-path`](../actions/kanon-path/README.md) and runs `node "$KANON/scripts/<name>.mjs"`. The scripts read your repository's files at the paths in [chapter 11](../rulebook/11-repository-layout.md), relative to the working directory, so they run in your checkout. A workflow of your own that runs one of them does the same, which is how Kanon's guards reach your CI: `kanon-path` at the pinned tag, then `node "$KANON/scripts/<guard>.mjs"`, with Dependabot proposing the upgrades. The scripts use only Node's built-in modules, so neither your repository nor the step needs a `package.json`, an install or a package manager, whatever your project's language. Node is Kanon's runtime, not your project's, and `kanon-path` sets it up: the version in `engines` in Kanon's own manifest, pinned, rather than whichever Node the runner image carries. Its [README](../actions/kanon-path/README.md) says where to call it relative to your own toolchain.

## The project-setup hook

`.github/actions/project-setup/action.yml` is a composite action you write ([plan 0001 §5](plans/0001-move-the-agent-lanes.md)). Every lane that checks out calls it after the checkout and before the agent, with these inputs, all strings: `lane`, `install`, `database`, `browsers`, `issue-number`, `app-slug` and `github-token`. It installs your toolchain and dependencies, and, when `database` is `'true'`, sets up your schema against the database in `DATABASE_URL`. It is read from the checked-out tree, so on a lane that checks out a pull request it is that branch's copy, except on the review lane, which restores your default branch's copy first (`K-MERGE-17`). The verify-acs lane loads it from your caller's commit, because the release it verifies may predate it.

**The starting map.** When a lane passes an `issue-number`, your hook may write `.agent/starting-map.md` (`K-AGENT-41`). The implement lane's prompt reads it first if it exists, and nothing fails without it. Kanon's [`scripts/starting-map.mjs`](../scripts/starting-map.mjs) `--issue <n>` writes one from the issue and the spec clauses it cites.

The contract defines no outputs, and no lane reads any: a lane judges your hook only by whether it succeeded. The review lane still reviews a pull request whose setup failed, and notes it on the run ([#77](https://github.com/yedeya-labs/kanon/issues/77)).

## The test database

A lane gets a database only when your project declares one, in `docs/qa/test-database.md` (`K-LAYOUT-16`). With no file, your hook gets `database: 'false'` and `DATABASE_URL` stays unset. Declare `hook`, and your hook gets `database: 'true'`: it starts your database, whatever the engine, and writes `DATABASE_URL` before it returns. Kanon starts none and names no engine. The [`test-database`](../actions/test-database/README.md) block reads the declaration. Its README has the format and a worked example, a hook that starts Postgres. Add the declaration before, or with, the upgrade that brings it, then rebase your open pull requests: a lane that checks out a branch reads that branch's copy.

## The stack document and the playbooks

The lanes' prompts state the process and never your stack. What your stack decides, they read from files you own, at fixed paths (`K-LAYOUT-17`): the **stack document**, `docs/qa/stack.md`, with its four sections (`## Gates`, `## Schema changes`, `## Data isolation`, `## Generated files`), and the **playbooks**, `docs/qa/triage-fix-playbook.md`, `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` and `docs/qa/lead-playbook.md`. The rule says what each section holds. `lane-check` fails when a lane you call reads a document you don't have, or the stack document lacks a section.

## The App register

The revise lanes find their own App's login in the App register, and the scripts the lanes run read every role's login from it, `docs/qa/agent-identities.md` (`K-LAYOUT-6`), read from your default branch. Each role a lane runs as needs one row there with its App slug in backticks.

## Checking it

Run [`lane-check`](../actions/lane-check/README.md) in CI. It fails on a caller that holds more than the above or a review caller whose `run-name` doesn't end with the head SHA, passes a setting instead of an input, maps the wrong secrets, grants too little, or pins a second version; on a missing or incomplete hook; on a missing stack document or playbook, or a stack document without its four sections; on a malformed test-database declaration; on a role missing from the App register; and on a missing Dependabot entry.
