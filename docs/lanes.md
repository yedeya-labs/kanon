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
| Lead, reconcile | `agent-lead-reconcile.yml` | Lead | `workflow_dispatch` with `project` and `apply`; `pull_request: [closed]`; `issues: [closed]`; `schedule` (an hourly heartbeat) |
| Merge | `agent-merge.yml` | Merger | `pull_request_review: [submitted]`; `workflow_run` of your `CI` workflow, `types: [completed]`, `branches` your default branch; `schedule` (an hourly floor); `workflow_dispatch` with `pr_number` and `apply` |
| Daily project digest | `agent-project-digest.yml` | none | `schedule` (daily); `workflow_dispatch` with `dry_run` |
| Weekly digest | `agent-weekly-digest.yml` | none | `schedule` (weekly); `workflow_dispatch` with `week_end` and `dry_run` |

**What each caller maps, grants and needs.** Every caller maps its role's two App secrets, by name, and so does every lane that runs a model with `CLAUDE_CODE_OAUTH_TOKEN`. The Merger and the reconciler run no model, so their callers map only the two. The digests run as no App, so their callers map `CLAUDE_CODE_OAUTH_TOKEN` and `DIGEST_WEBHOOK`. It grants at least the permissions below, which are the most any of the lane's jobs declares for the workflow token (the App token's permissions are the App's, narrowed per lane by `K-AGENT-46`, and need nothing from the caller), and it needs the project documents below on your default branch (`K-LAYOUT-17`). A lane that reads no document still needs the project-setup hook if it checks out. [`tests/unit/lanes-doc.test.ts`](../tests/unit/lanes-doc.test.ts) fails when this table and the lanes disagree.

<!-- lane-contract:table -->

| Lane | Secrets, besides the Claude token | Grant at least | Reads |
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
| `agent-merge.yml` | `MERGER_APP_ID`, `MERGER_APP_PRIVATE_KEY` | `contents: read` | none |
| `agent-lead-reconcile.yml` | `LEAD_APP_ID`, `LEAD_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: read`, `checks: read`, `statuses: read`, `actions: read` | none |
| `agent-project-digest.yml` | `DIGEST_WEBHOOK` | `contents: read`, `issues: write`, `pull-requests: read`, `actions: read` | none |
| `agent-weekly-digest.yml` | `DIGEST_WEBHOOK` | `contents: read`, `issues: read`, `pull-requests: read` | none |

<!-- /lane-contract:table -->

Most lanes call the shared lane workflow, `agent-lane.yml`, which is not called by an adopter directly; merge reconcile and the two digests call the blocks themselves and install nothing, so they never call your hook, and review, verify-acs, lead-split and rebase call the blocks around steps of their own. The Merger and the reconciler call no block and install nothing: each runs Kanon's scripts in your checkout, with its role's App token, and never calls your hook.

**The review lane** has three things the others don't:
- **Its caller sets `run-name`,** ending with `${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }}`. A called workflow's `run-name` is ignored, and the review-run evidence finds a head's reviews by the last token of the run's title. `lane-check` holds the caller to it.
- **It reads your CI from `.github/workflows/ci.yml`.** A review label added while CI is still running defers to CI's completion, and the lane asks Actions about the runs of that file for the head. Your caller's `workflow_run` names that workflow.
- **It never reviews under the pull request's own instructions** (`K-MERGE-17`). Before any of the PR's code runs, it restores every input on the rule's list from your default branch: `AGENTS.md`, `CLAUDE.md`, `.claude/`, every markdown file directly inside `docs/qa/`, your project-setup hook, and every markdown document those link to or import. The PR's own copies are set aside under `.qa-pr/`, so the Reviewer still reads them as part of the diff, and a push that touches one re-opens an approved review. The specs under `docs/qa/specs/` come from the PR. Your own tests that read one of those files should read the `.qa-pr/` copy when there is one, or they will fail in the Reviewer's tree on a PR that changes it.

**The Reviewer's shell is an allow-list** ([#248](https://github.com/yedeya-labs/kanon/issues/248), `K-AGENT-24`). The Reviewer may run named `gh` subcommands, and otherwise only the commands Claude Code itself treats as read-only (`cat`, `grep`, `sed -n`, `jq`, read-only `git`), and may write only `qa-review-*.md` files in the runner's temp directory. Anything else is refused, including every interpreter, package manager and script in the tree. So a reviewer playbook of yours that asks the Reviewer to run a command outside that set gets a refusal: read the result from a CI check instead. **That list is the whole grant, because the Reviewer loads none of your project's Claude Code settings** ([#277](https://github.com/yedeya-labs/kanon/issues/277)). It runs with `--setting-sources user`, so your `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` don't apply to it: no permission rule, `defaultMode`, `env`, hook or MCP server from them. A hook or an MCP server command runs without any permission check, so a formatter hook of yours would otherwise run the pull request's `package.json` beside the Reviewer's token. The same switch stops `CLAUDE.md`, project skills and project subagents from loading on their own, so the prompt tells the Reviewer to read `CLAUDE.md` and `AGENTS.md` itself. Put what the Reviewer must know in those files or in your reviewer playbook, not in a skill or an MCP server. Your other lanes still load your settings.

**Why a caller grants more than `contents: read`.** "Grant at least" includes the permissions a lane's jobs use on the workflow token, not only the lane's top level. The implement lane's crash recovery writes issues, reads pull requests and reads its own run. The rebase lane's filter reads pull requests and its earlier runs' jobs. The split lane's gate edits the issue's labels. The review lane reads CI's runs for the head, and comments on a pull request opened without a review label.

## Asking the review lane again

One commit gets one verdict. The lane skips a head the Reviewer has already reviewed, and a run that waited behind another review of the same head stands down when that review posts ([#88](https://github.com/yedeya-labs/kanon/issues/88)). A new verdict on an unchanged commit comes only from a request made *after* the last one:

- **Push.** A new commit is reviewed when CI finishes on it. This is how a fix gets its review, so there is nothing to re-request.
- **A person re-applies `review:please`** after the verdict, to ask for another look at the same commit (for example after editing the PR body). The lane treats a label applied by a person as an explicit request. A label applied before the verdict landed is answered by that verdict.
- **Tooling dispatches the lane:** `gh workflow run <your review caller> -f pr_number=N`. A dispatch reviews regardless of labels, and its run records who asked. Like a label, it is answered by a verdict on the head that lands while it waits, so dispatch after the verdict, not during the review.

**Tooling must not churn the label.** Removing and re-applying `review:please` through a person's token is indistinguishable from that person asking. A churn that lands after the verdict spends a second full review on the same commit, and one that lands before it is wasted. A script that acts for a person dispatches instead, or waits for the push to do the asking. Apps can re-apply the label (the recovery in `K-MERGE-14` does), because a label applied by an App is never an explicit request.

## Only members start a lane

Every lane starts real work only when the actor of its triggering event is a member: GitHub's `author_association` of `OWNER`, `MEMBER` or `COLLABORATOR`, or one of your agent Apps listed in the App register (`K-AGENT-45`). The check is the first step of the lane's first job, [`scripts/lane-gate.mjs`](../scripts/lane-gate.mjs), before any token is minted (the Merger, whose review and sweep start different jobs, runs it first in each), so it runs on a private repository exactly as on a public one (`K-PRIN-20`).

| Event | The actor | How it is checked |
|---|---|---|
| A review | the reviewer | the review's `author_association` |
| A label | whoever applied it | their permission on the repository: triage or more |
| A merge (`pull_request: closed`) | whoever merged it | the same |
| A closed issue (`issues: closed`) | whoever closed it | the same |
| A dispatch | whoever ran it, re-runs included | the same; only write access can dispatch, so this refuses only an unregistered App |
| A pull request opened (`pull_request_target`) | whoever opened it | the same |
| A finished workflow (`workflow_run`) | whoever pushed the commit it ran on | the same |
| A finished CI run, on the review lane | whoever last applied a review label (`review:please`, `agent:triage` or `agent:implement`) that the head's open pull request carries now, read from its issue events | the same. With no such pull request or label, refused. A label added while CI runs waits for CI, so this is that label's actor, not the pusher, who on a dependency bot's PR is the bot ([#81](https://github.com/yedeya-labs/kanon/issues/81)). A fork's head is refused separately |
| A schedule | the user GitHub runs it as: whoever last changed the cron, or the default branch | the same, so a schedule set by someone who has since lost access is refused |
| Anything else | none | refused: no lane acts on it |

A login ending in `[bot]` is judged by the App register alone, read from your default branch, never from the pull request. A refused event leaves the lane's later steps and jobs skipped, with a notice and a step-summary line naming who was refused and why; it does not turn the run red. A failed API call or a malformed register does.

**With a merge queue, a merge does not start the rebase lane or the merge lane's sweep** ([#79](https://github.com/yedeya-labs/kanon/issues/79)). The queue pushes the merge to your default branch, so the CI run on that push has `github-merge-queue[bot]` as both its `actor` and its `triggering_actor`, not the member who queued the pull request (measured on Kanon's own `main`). That is an App outside your register, so the gate refuses it with a notice, and the run stays green. Both lanes still run on their schedules: the merge sweep within the hour, and a conflict a merge caused is resolved by the rebase lane's daily floor, up to a day later. If a conflict needs resolving sooner, dispatch the rebase lane for that pull request (`gh workflow run <your caller> -f pr_number=N`). Don't add the queue to your App register to admit it: the register lists your agents, and the queue would then be admitted on every push it makes. Without a merge queue, the push is made by whoever merged, and the gate judges them as usual.

**Every lane carries the gate.** [`tests/unit/lane-gate.test.ts`](../tests/unit/lane-gate.test.ts) fails for a lane in Kanon without it, or with a step or job that can run past a refusal, and for a lane whose triggers it doesn't list.

**A lane refuses a caller that pins another Kanon version than your default branch** ([#69](https://github.com/yedeya-labs/kanon/issues/69), `K-MERGE-17`). On `pull_request_target`, GitHub runs the base branch's copy of your caller. On a stacked pull request that base is another pull request's branch, and its caller can pin another version. On `pull_request` and `pull_request_review`, it runs the pull request's own merge of your caller. So when the caller ran from anywhere but the default branch (another branch, a tag from a dispatch with `--ref`, or a pull request's merge ref), the gate reads that caller at the commit that ran and at your default branch, and compares every Kanon reference in them (each `uses:` of a `yedeya-labs/kanon` path, with its version). If your caller reaches the lane through a reusable workflow of your own repository (`uses: ./.github/workflows/lanes.yml`, or `$/…`), the gate follows it, to any depth (though `K-LAYOUT-18` refuses that shape, because the lane's runs are then filed under the top-level workflow's name), and compares the Kanon references of every workflow it reaches ([#118](https://github.com/yedeya-labs/kanon/issues/118)). If they differ, if the default branch has no such caller or lacks a workflow it calls, or if neither side holds any Kanon reference (the lane was reached through something the gate can't read, such as another repository's workflow), the lane is refused with a `Kanon pin: refused.` summary line. A run from the default branch reads nothing. A pull request never chooses the Kanon version that acts on it. **So on a pull request that bumps the pin, Dependabot's for example, the lanes it triggers on `pull_request` and `pull_request_review` (the revise and merge-reconcile lanes) refuse, visibly, until it merges. Merge reconcile on that pull request's own merge runs, because by then your default branch carries the new pin too.** Its review is unaffected, because the review lane runs from the base. **This holds only between versions that have the check.** The gate is Kanon at the version the running caller pins, so a base whose caller pins a release from before it runs a gate without it. Enforcing it from outside the lane is [#114](https://github.com/yedeya-labs/kanon/issues/114).

**A dispatch made with the workflow token is refused.** Its actor is `github-actions[bot]`, which is not in your App register. So no lane starts another that way. When an implement run hits its turn or budget cap, its crash recovery adds `qa:needs-split` with the Implementer's App token, narrowed to Issues write, and that label's own event starts the split lane through the gate as a registered App. Its comment stays on the workflow token, so it never reads as the Implementer's. Only that label needs the App: if the token cannot be minted (a rotated key, an uninstalled App, an unset secret), crash recovery still retries the issue or stops it to a human on the workflow token, and only a due split fails, by name, with nothing changed ([#78](https://github.com/yedeya-labs/kanon/issues/78)).

**An implement run that ends green but leaves nothing turns red** ([#181](https://github.com/yedeya-labs/kanon/issues/181)). After a successful implement job, the lane checks what the run left: an open pull request that closes the issue, a `<type>/<number>-` branch pushed during the run, or a comment from the Implementer since the run started. If there is none, the run fails with the error `implement run left nothing`, and crash recovery takes over. For a project member that means a retry, posted as `github-actions` and capped like a crash's. An issue outside a project keeps its label and gets no comment, and the dispatch sweep retries it ([#254](https://github.com/yedeya-labs/kanon/issues/254)): it reads the jobs of the issue's latest implement run, and when that run failed its empty check and went on to crash recovery, it reports the issue as `ran-empty` and re-dispatches it within its usual attempt cap, even if the Implementer commented on an earlier run. That read needs the issue's cost rows, so a sweep that cannot read them treats the issue as before. A run that commented is never treated as empty, because the comment explains why the agent stopped. The revise lane turns a green run red too, if it pushed nothing and left no reply marker. Nothing retries that run.

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
    uses: yedeya-labs/kanon/.github/workflows/agent-implement-revise.yml@v0.24.0
    with:
      pr_number: ${{ inputs.pr_number }}
      reset: ${{ inputs.reset }}
    secrets:
      IMPLEMENTER_APP_ID: ${{ secrets.IMPLEMENTER_APP_ID }}
      IMPLEMENTER_APP_PRIVATE_KEY: ${{ secrets.IMPLEMENTER_APP_PRIVATE_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

<!-- x-release-please-end -->

- **Each caller has its lane's file name** (`K-LAYOUT-18`, [#207](https://github.com/yedeya-labs/kanon/issues/207)): the caller of `agent-implement-revise.yml` is `.github/workflows/agent-implement-revise.yml`, and so on. Kanon's scripts find a lane's runs, and start it, by that file name: the Merger dispatches your review caller, the reconciler lists the runs of your revise callers, and the health check watches every `agent-*.yml`. Under another name those reads come back empty and read as "nothing to do", so `lane-check` fails a caller at any other path. GitHub files a run under the top-level workflow, so the caller holds the triggers itself: `lane-check` also fails a caller that is a reusable workflow another of yours calls. A project that runs the review lane or the reconciler also keeps its CI at `.github/workflows/ci.yml`, whose runs both read.
- **Four callers have fixed names** ([#53](https://github.com/yedeya-labs/kanon/issues/53)). GitHub reports a called lane's checks under its caller's `name:`, and the merge gate tells its own checks, and the review event's, from the rest by that name. Name the review lane's caller `Review (Reviewer)`, the merge-reconcile lane's `Merge Reconcile (Reviewer)`, the implement-revise lane's `Implement (Implementer) — revise` and the Merger's caller `Merge (Merger)`, and give the revise and merge-reconcile callers' one job the ids `revise` and `reconcile`. Under another name the Merger waits on itself, so `lane-check` fails a Merger caller under any other name.
- **Triggers are yours.** A reusable workflow can't declare its caller's events. The `github` context in a called workflow is the caller's, so the lane reads the triggering event exactly as it would in your own file.
- **Inputs pass through, by name.** `with:` passes your `workflow_dispatch` inputs as `${{ inputs.<name> }}`, and nothing else. On the other triggers they arrive empty, which the lane expects.
- **`permissions:` is the ceiling.** Each lane declares the permissions it needs, and a called workflow can only narrow what its caller grants. Grant at least what the lane declares, or the run fails to start.
- **Secrets are mapped explicitly, by their fixed names** ([plan 0001 §8](plans/0001-move-the-agent-lanes.md)): `<ROLE>_APP_ID`, `<ROLE>_APP_PRIVATE_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. Never `secrets: inherit`, which would hand every secret in your repository to Kanon's code. [`kanon apps`](apps.md) stores the two App secrets. `CLAUDE_CODE_OAUTH_TOKEN` is the token of the Claude subscription the agents run on. Make it with `claude setup-token`, signed in to that subscription, and store it yourself with `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/<repo>`, pasting it on standard input.
- **No `concurrency:`.** Each lane holds its own concurrency group. The same group on the caller would have the caller wait for itself.
- **One version.** Every Kanon reference in your repository pins the same exact version, and Dependabot proposes upgrades (`K-ADOPT-11`). Write the `cooldown` out with `yedeya-labs/kanon*` excluded: an entry with none still gets Dependabot's default of 3 days, which holds back every release made in the last 3 days, and `lane-check` fails it ([#233](https://github.com/yedeya-labs/kanon/issues/233)).
- **An agent's commits pass your `dco` check with no hook code of yours** (`K-AGENT-44`). The lanes author each one as the lane's App, and add the `Signed-off-by:` of the person your default branch's `docs/qa/sign-off-delegation.md` names (`K-LAYOUT-14`). Recording that delegation is your decision; with none, an agent's commits fail the check ([`agent-setup`](../actions/agent-setup/README.md), [#234](https://github.com/yedeya-labs/kanon/issues/234)).

## Old spellings

Some strings are read by another program by their exact text: the Merger's comment marker (`<!-- merger:<rule>:<sha> -->`) and escalation header, the split lane's branch (`lead/split-<n>`), the Lead's adoption sentence, the four caller names above, and the retry steps' names. Kanon writes them with role names. Until [#53](https://github.com/yedeya-labs/kanon/issues/53) they carried the reference adopter's agent names, caller names and issue numbers, and a pull request, branch, issue or run from then still carries them, so the readers accept both spellings. [`scripts/lib/protocol-spellings.mjs`](../scripts/lib/protocol-spellings.mjs) holds both.

The old spellings are read until a measurement says nothing live carries them. [`scripts/protocol-census.mjs`](../scripts/protocol-census.mjs), run in your checkout with `GITHUB_REPOSITORY` set, lists every caller, open pull request (its comments, its checks and the failed runs on its head), open issue and branch that still carries one, and exits 0 only when there are none. When it exits 0 in every adopter Kanon knows of, a release drops the old spellings.

## Your first lane: the Reviewer

Install the review lane first. Its App is the one that ends bootstrap, on a plan with rulesets (`K-ADOPT-3`, `K-ADOPT-6`), and it needs no other lane. On one branch, add:

1. **The project-setup hook** (below), and `docs/qa/test-database.md` if your tests need a database. The review lane doesn't call the hook: it runs none of your pull request's code ([#185](https://github.com/yedeya-labs/kanon/issues/185)), and takes test results from your CI's required checks. [`lane-check`](../actions/lane-check/README.md) requires the hook anyway, because the lanes that install call it.
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
    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.24.0
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

The contract defines no outputs, and no lane reads any: a lane judges your hook only by whether it succeeded. The review lane doesn't call your hook at all ([#185](https://github.com/yedeya-labs/kanon/issues/185)).

## The test database

A lane gets a database only when your project declares one, in `docs/qa/test-database.md` (`K-LAYOUT-16`). With no file, your hook gets `database: 'false'` and `DATABASE_URL` stays unset. Declare `hook`, and your hook gets `database: 'true'`: it starts your database, whatever the engine, and writes `DATABASE_URL` before it returns. Kanon starts none and names no engine. The [`test-database`](../actions/test-database/README.md) block reads the declaration. Its README has the format and a worked example, a hook that starts Postgres. Add the declaration before, or with, the upgrade that brings it, then rebase your open pull requests: a lane that checks out a branch reads that branch's copy.

## The QA store

The code audit, the Explorer, the Overseer and the dispatch sweep remember earlier runs in a QA store in your own account (`K-OBS-17`). They reach it only through a hook you write, `.github/actions/qa-store/action.yml`, with five operations, each run in a store job of its own in the `kanon-qa-store` environment, so no agent job holds the store's credentials. Kanon's AWS implementation provisions a store and is the hook's one `uses:` line. Without a hook, each lane runs without memory and says the store is absent. [The QA store](qa-store.md) has the contract, the setup and the AWS runbook.

## The stack document and the playbooks

The lanes' prompts state the process and never your stack. What your stack decides, they read from files you own, at fixed paths (`K-LAYOUT-17`): the **stack document**, `docs/qa/stack.md`, with its four sections (`## Gates`, `## Schema changes`, `## Data isolation`, `## Generated files`), and the **playbooks**, `docs/qa/triage-fix-playbook.md`, `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` and `docs/qa/lead-playbook.md`. The rule says what each section holds. `lane-check` fails when a lane you call reads a document you don't have, or the stack document lacks a section.

## The App register

The revise lanes find their own App's login in the App register, and the scripts the lanes run read every role's login from it, `docs/qa/agent-identities.md` (`K-LAYOUT-6`), read from your default branch. Each role a lane runs as needs one row there with its App slug in backticks.

## The reference environment's deploy

A project closes only once its merges are deployed to your reference environment (`K-PROJ-11`), and the reconciler confirms that by the deploy job itself, not the workflow's conclusion. Declare which workflow deploys there, and which job's success is the deploy, under `## Choices` in your adoption record, `docs/qa/adoption.md` (`K-LAYOUT-10`):

```markdown
- **Reference environment:** `staging`
- **Reference deploy workflow:** `deploy-staging.yml`
- **Reference deploy job:** `deploy`
```

The reconciler reads it from your default branch, through [`scripts/lib/reference-deploy.mjs`](../scripts/lib/reference-deploy.mjs). Without it, the reconciler names the missing declaration when a project reaches its deploy phase, and that project can't close. A step of your own that needs the same names, such as a probe that your Lead's App can read Actions, prints one with `node "$KANON/scripts/reference-deploy.mjs" workflow` (or `job`, or `environment`), with `GITHUB_REPOSITORY` and a `gh` token in its environment. Add the declaration before, or with, the upgrade that brings it.

## The Merger

The merge lane merges a pull request with no person in the loop only inside the green zone (`K-MERGE-4`): an `agent:implement` or `agent:triage` pull request the Implementer authored, approved by the Reviewer on its current head, with every check green, no escalating path or label, and no invariant promoted to `[confirmed]` (`K-SPEC-9`). It merges through the front door with the Merger's App, never as a ruleset bypass actor, and runs no model. Its caller:

- **Is named `Merge (Merger)`.** `lane-check` fails it under any other name, because the lane would wait on its own check.
- **Keeps four triggers.** A review is what it acts on. CI completing on your default branch is its sweep, because a merge there changes every other open pull request's mergeability. The hourly `schedule` is a floor for the day nothing merges. A dispatch with `pr_number` and `apply` is the only dry run: without `apply`, it reports each verdict and changes nothing.
- **Grants `contents: read`.** Every write is the Merger's App token's.

On a review, the lane first reads the Merger's and the Implementer's logins from the App register on your default branch, in a job of their own. That job starts no runner for a review on a pull request that is closed, a draft or carries neither lane label. The sweep needs no login, so CI's completion, the schedule and a dispatch start the Merger's own job alone, and bill one runner each.

## The reconciler

The Lead's reconcile lane drives an approved brief to done (`K-PROJ-*`): each tick files the issues the brief proposes, labels them for the Implementer in the brief's order, and closes the project once its merges are deployed to your reference environment. It also re-delivers a review that never landed and a brief pull request's unanswered changes-request, and reports a pull request that is red and unreviewed. It runs no model. Its caller:

- **Keeps four triggers:** `pull_request: [closed]` and `issues: [closed]`, so a merge starts the next tick; an hourly `schedule`, the heartbeat that recovers an event that never arrived; and a dispatch with `project` and `apply`, which without `apply` is a dry run.
- **Grants the reads its pre-filters use** on the workflow token: `issues`, `pull-requests`, `checks`, `statuses` and `actions`, all `read`. Without one, a read fails and the tick goes red rather than reading as idle.
- **Passes no budget.** A tick takes at most six chargeable actions across every open project, a constant of the lane.

It needs the Lead's App, with `Actions: Read` on the installation (the tick probes it before the deploy phase), and your reference environment's deploy declaration (above).

## The digests

Two lanes post a summary to a chat channel, as a `{"text": …}` body to the webhook in your `DIGEST_WEBHOOK` secret (Slack's incoming webhooks take that body). Without the secret, a digest posts nothing and its run stays green. Each writes a few sentences with a model first, and posts its numbers without them if that step fails. Neither mints an App token: they read with the workflow token.

- **The daily project digest** (`agent-project-digest.yml`) is for the developer: where each open project in `docs/projects/` has got to, and what is stopped and why. Its caller keeps a daily `schedule` and a dispatch with `dry_run`. Schedule it after the reconciler's hourly tick, so it reads the freshest state.
- **Its health job** rides the same tick. It files one `pipeline-improvement` issue in *Development Automation* naming every lane caller (`.github/workflows/agent-*.yml`) that is red on every recent run, and keeps it until they recover, because GitHub's own failure notification goes to a run's actor, which on a schedule is nobody who reads it. Where an Overseer is installed (`agent-overseer.yml`), it also files one when no weekly Overseer audit has landed in nine days. It needs `actions: read` and `issues: write`, which the caller grants. A dry run prints its table and files nothing.
- **The weekly digest** (`agent-weekly-digest.yml`) is for a stakeholder outside the day-to-day work: the week's milestone burndown and what was delivered, in plain language, and nothing pending. Name its reader with a `- **Weekly digest audience:** …` bullet under `## Choices` in your adoption record (`K-LAYOUT-10`), read from your default branch; without it, the narrative is written for "a stakeholder who follows the project from outside the day-to-day work". Its caller keeps a weekly `schedule` and a dispatch with `week_end` (the end of the 7-day window, an ISO date) and `dry_run`.

## Checking it

Run [`lane-check`](../actions/lane-check/README.md) in CI. It fails on a caller that holds more than the above, a caller that isn't at its lane's file name, a review or reconciler caller without `.github/workflows/ci.yml`, a review caller whose `run-name` doesn't end with the head SHA, or a Merger caller not named `Merge (Merger)`, passes a setting instead of an input, maps the wrong secrets, grants too little, or pins a second version; on a missing or incomplete hook; on a missing stack document or playbook, or a stack document without its four sections; on a malformed test-database declaration, escalation file, exemptions file or reference-deploy declaration; on a role missing from the App register; and on a missing Dependabot entry.
