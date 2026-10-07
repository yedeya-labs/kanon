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
| Explore (the sweep) | `agent-explore.yml` | Explorer | `schedule` (daily); `workflow_dispatch` with `tier` |
| Dispatch sweep | `agent-dispatch-sweep.yml` | Lead | `schedule` (daily); `workflow_dispatch` with `apply` |
| Code audit | `agent-code-audit.yml` | Explorer | `schedule` (every few days); `workflow_dispatch` |
| Explore the telemetry | `agent-explore-telemetry.yml` | Explorer | `schedule` (weekly); `workflow_dispatch` |
| Overseer (optional) | `agent-overseer.yml` | Overseer | `schedule` (weekly); `workflow_dispatch`; `pull_request_target: [closed]`, `branches` your default branch, `paths` this caller (the runtime-version trigger) |

**What each caller maps, grants and needs.** Every caller maps its App's two secrets, by name (the Author's for the Implementer's, the Lead's, the Explorer's and the Overseer's lanes, the Judge's for the Reviewer's and the Merger's), and so does every lane that runs a model with `CLAUDE_CODE_OAUTH_TOKEN`. The Merger, the reconciler and the dispatch sweep run no model, so their callers map only the two. The digests run as no App, so their callers map `CLAUDE_CODE_OAUTH_TOKEN` and `DIGEST_WEBHOOK`. It grants at least the permissions below, which are the most any of the lane's jobs declares for the workflow token (the App token's permissions are the App's, narrowed per lane by `K-AGENT-46`, and need nothing from the caller), and it needs the project documents below on your default branch (`K-LAYOUT-17`). A lane that reads no document still needs the project-setup hook if it checks out. [`tests/unit/lanes-doc.test.ts`](../tests/unit/lanes-doc.test.ts) fails when this table and the lanes disagree.

<!-- lane-contract:table -->

| Lane | Secrets, besides the Claude token | Grant at least | Reads |
|---|---|---|---|
| `agent-triage.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |
| `agent-implement.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: write`, `pull-requests: read`, `actions: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |
| `agent-implement-revise.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: read`, `statuses: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |
| `agent-lead-revise.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: write` | none |
| `agent-merge-reconcile.yml` | `JUDGE_APP_ID`, `JUDGE_APP_PRIVATE_KEY` | `contents: read`, `pull-requests: read` | `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` |
| `agent-review.yml` | `JUDGE_APP_ID`, `JUDGE_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: write`, `actions: read` | `docs/qa/stack.md`, `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` |
| `agent-verify-acs.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: read` | `docs/qa/explorer-playbook.md` |
| `agent-lead.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read` | `docs/qa/lead-playbook.md` |
| `agent-lead-split.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: write`, `pull-requests: read` | `docs/qa/lead-playbook.md` |
| `agent-rebase.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `pull-requests: read`, `actions: read`, `statuses: read` | `docs/qa/stack.md`, `docs/qa/triage-fix-playbook.md` |
| `agent-merge.yml` | `JUDGE_APP_ID`, `JUDGE_APP_PRIVATE_KEY` | `contents: read` | none |
| `agent-lead-reconcile.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `pull-requests: read`, `checks: read`, `statuses: read`, `actions: read` | none |
| `agent-project-digest.yml` | `DIGEST_WEBHOOK` | `contents: read`, `issues: write`, `pull-requests: read`, `actions: read` | none |
| `agent-weekly-digest.yml` | `DIGEST_WEBHOOK` | `contents: read`, `issues: read`, `pull-requests: read` | none |
| `agent-explore.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `actions: read`, `id-token: write` | `docs/qa/explorer-playbook.md` |
| `agent-dispatch-sweep.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `id-token: write` | none |
| `agent-code-audit.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `actions: write`, `id-token: write` | `docs/qa/stack.md`, `docs/qa/explorer-playbook.md` |
| `agent-explore-telemetry.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY`, `KANON_AGGREGATE_ROLE` | `contents: read`, `issues: read`, `actions: read`, `id-token: write` | `docs/qa/explorer-playbook.md` |
| `agent-overseer.yml` | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` | `contents: read`, `issues: read`, `actions: write`, `id-token: write` | `docs/qa/capability-ledger.md`, `docs/qa/overseer-playbook.md` |

<!-- /lane-contract:table -->

Most lanes call the shared lane workflow, `agent-lane.yml`, which is not called by an adopter directly. It runs as two jobs ([#274](https://github.com/yedeya-labs/kanon/issues/274)): `mint` uses your App's private key to mint the lane's token and runs nothing else, and `run` (`lane-agent-job.yml`) checks out, runs your hook and the agent with that token, never the key, and revokes the token when it ends. So the job running the agent can't reach the key, whatever it does to the runner (`K-AGENT-49`). Two things follow. To re-run a spine lane, use **Re-run all jobs**: **Re-run failed jobs** re-runs the agent's job alone, with the earlier attempt's token, which was revoked when that attempt ended, and its token step stops with that message. And the token is revoked as the job's last step, before any post step, so a post step of your project-setup hook can't use the `github-token` it was given. In the Actions UI a spine lane's agent job is therefore one level deeper: its name ends `… / run / run`, beside a `… / mint` job. The lanes that call the blocks themselves (review, rebase, lead-split, merge reconcile, verify-acs, the Explorer's sweep, the code audit, the Explorer's telemetry mode and the Overseer) run the same way since [#279](https://github.com/yedeya-labs/kanon/issues/279): the lane's agent job calls `<lane>-run.yml`, whose `mint` job holds the key and whose other job, `<lane>-agent-job.yml`, runs the agent with the token. So each of their agent jobs is two levels deeper in the Actions UI too: the review lane's ends `… / review / review / review`, beside `… / review / mint`, and the rebase lane's `… / resolve (<PR>) / resolve / resolve`, beside `… / resolve (<PR>) / mint`. **Re-run all jobs** applies to them as to the spine lanes. Of the other lanes, merge reconcile and the two digests call the blocks themselves and install nothing, so they never call your hook, and review, verify-acs, lead-split and rebase call the blocks around steps of their own. The Merger and the reconciler call no block and install nothing: each runs Kanon's scripts in your checkout, with its role's App token, and never calls your hook. The dispatch sweep does the same, after a store job that calls only the `qa-store` block. The code audit calls the blocks itself and installs nothing, between store jobs that call only the `qa-store` block. The Overseer calls the blocks itself and installs nothing, after a store job that calls only the `qa-store` block. The Explorer's telemetry mode calls the blocks itself and installs nothing, after a job that reads the aggregate function and nothing else.

**The review lane** has three things the others don't:
- **Its caller sets `run-name`,** ending with `${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }}`. A called workflow's `run-name` is ignored, and the review-run evidence finds a head's reviews by the last token of the run's title. `lane-check` holds the caller to it.
- **It reads your CI from `.github/workflows/ci.yml`.** A review label added while CI is still running defers to CI's completion, and the lane asks Actions about the runs of that file for the head. Your caller's `workflow_run` names that workflow.
- **It never reviews under the pull request's own instructions** (`K-MERGE-17`). Before any of the PR's code runs, it restores every input on the rule's list from your default branch: `AGENTS.md`, `CLAUDE.md`, `.claude/`, every markdown file directly inside `docs/qa/`, your project-setup hook, and every markdown document those link to or import. The PR's own copies are set aside under `.qa-pr/`, so the Reviewer still reads them as part of the diff, and a push that touches one re-opens an approved review. The specs under `docs/qa/specs/` come from the PR. Your own tests that read one of those files should read the `.qa-pr/` copy when there is one, or they will fail in the Reviewer's tree on a PR that changes it.

**The Reviewer's shell is an allow-list** ([#248](https://github.com/yedeya-labs/kanon/issues/248), `K-AGENT-24`). The Reviewer may run named `gh` subcommands, and otherwise only the commands Claude Code itself treats as read-only (`cat`, `grep`, `sed -n`, `jq`, read-only `git`), and may write only `qa-review-*.md` files in the runner's temp directory. Anything else is refused, including every interpreter, package manager and script in the tree. So a reviewer playbook of yours that asks the Reviewer to run a command outside that set gets a refusal: read the result from a CI check instead. **That list is the whole grant, because the Reviewer loads none of your project's Claude Code settings** ([#277](https://github.com/yedeya-labs/kanon/issues/277)). It runs with `--setting-sources user`, so your `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` don't apply to it: no permission rule, `defaultMode`, `env`, hook or MCP server from them. A hook or an MCP server command runs without any permission check, so a formatter hook of yours would otherwise run the pull request's `package.json` beside the Reviewer's token. The same switch stops `CLAUDE.md`, project skills and project subagents from loading on their own, so the prompt tells the Reviewer to read `CLAUDE.md` and `AGENTS.md` itself. Put what the Reviewer must know in those files or in your reviewer playbook, not in a skill or an MCP server. Your other lanes still load your settings. **Its user settings start empty in every run, too** ([#283](https://github.com/yedeya-labs/kanon/issues/283)). `--setting-sources user` still loads the runner's own Claude Code settings in its home directory, and on a persistent self-hosted runner an earlier job could have left a hook, a permission rule or an MCP server there. So in a lane whose flags load no project settings (the Reviewer's and the Lead's), `agent-run` points the agent's user settings at a new directory under the runner's temp directory before the agent starts, and a hook or server in `~/.claude` or `~/.claude.json` doesn't reach it. **Run the agent lanes on GitHub-hosted or ephemeral runners anyway.** Kanon's agent jobs ask for `ubuntu-latest`, and a persistent runner that takes them keeps far more between jobs than Claude Code's settings: a job that ran a pull request's code before could leave `~/.gitconfig`, a replaced tool or a running process, and the next lane's token would be beside it. Nothing in a workflow can undo that.

**Why a caller grants more than `contents: read`.** "Grant at least" includes the permissions a lane's jobs use on the workflow token, not only the lane's top level. The implement lane's crash recovery writes issues, reads pull requests and reads its own run. The rebase lane's filter reads pull requests and its earlier runs' jobs. The split lane's gate edits the issue's labels. The review lane reads CI's runs for the head, and comments on a pull request opened without a review label.

## The lane catalogue

What each lane does, what it needs, what it costs and when it is worth installing, by group, in the order the adopt skill (`/kanon:adopt`) asks about them ([#428](https://github.com/yedeya-labs/kanon/issues/428)). The review lane is the one recommended for every repository, and comes first; a lane already called is recommended too, and so is one recommended with a lane you choose. The words are [`lanes.json`](lanes.json), the one source `kanon init --help`, its JSON's `catalogue` ([`docs/init.md`](init.md#the-lane-catalogue)) and the adopt skill read, and the rest comes from each lane through the requirements file. [`tests/unit/lanes-doc.test.ts`](../tests/unit/lanes-doc.test.ts) fails when this table and the catalogue disagree, and [`tests/unit/requirements.test.ts`](../tests/unit/requirements.test.ts) when a lane has no entry.

<!-- lane-catalogue:table -->

| Group | Lane | What it does | Needs | Cost | Recommended |
|---|---|---|---|---|---|
| Review | `agent-review.yml` | Reviews each pull request once CI finishes on its head, and approves it or requests changes. | the Judge App; `CLAUDE_CODE_OAUTH_TOKEN`; your CI at `.github/workflows/ci.yml`, whose runs it reads | A model run per reviewed head. | Always, and first: its App's approval is what ends bootstrap (`K-ADOPT-6`). |
| Review | `agent-merge-reconcile.yml` | After a reviewed pull request merges, files a follow-up issue for each review suggestion it didn't apply. | the Judge App; `CLAUDE_CODE_OAUTH_TOKEN` | A model run per merged pull request the Reviewer reviewed. | When the Reviewer's suggestions that a merge left out should become issues rather than be lost. |
| Implement and revise | `agent-implement.yml` | Builds a feature or resolves a spec delta from an issue labelled `agent:implement`, and opens a pull request. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN` | A model run per labelled issue. | When you want agents to write code from the issues you label, once the Reviewer runs green. |
| Implement and revise | `agent-implement-revise.yml` | Revises the Implementer's own pull request when the Reviewer requests changes. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN` | A model run per change request, capped in rounds. | With implement: without it, a change request on the Implementer's pull request waits for a person. |
| Explore and code audit | `agent-explore.yml` | Sweeps your running product with a sweep hook you write, and files what it finds. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; the QA store, if you have one; `.github/actions/explore-sweep/action.yml`; a schedule (`0 3 * * *`); a sweep hook you write (docs/explore-sweep.md) | A model run daily, skipped on a commit the QA store already holds a green sweep of. | When you can write a sweep hook that exercises your product, such as a Playwright run. |
| Explore and code audit | `agent-code-audit.yml` | Reads your code and specs every few days, and files a bug only on an objective contradiction. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; the QA store, if you have one; a schedule (`30 7 */3 * *`) | A model run every three days. | When you want a periodic second reading of the code, guided by `## Code areas` in your stack document. |
| Explore and code audit | `agent-explore-telemetry.yml` | Reads Kanon's hosted telemetry aggregate weekly, never a row, and files or drafts the anomalies it finds in Kanon's lanes: failures by lane, stage, error and Kanon version, and costs per lane and model. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; `KANON_AGGREGATE_ROLE`; a schedule (`30 6 * * 2`); an aggregate invoker role from Kanon's telemetry register (`aggregate_invoker`), whose ARN is the secret `KANON_AGGREGATE_ROLE`, and the repository variable `KANON_AGGREGATE_URL` (docs/telemetry.md) | A model run weekly, skipped when the aggregate holds no cell and no signal. | When your telemetry register entry has an aggregate invoker role, so you can read the aggregate. |
| Triage | `agent-triage.yml` | Reproduces a bug labelled `qa:needs-triage`, rates it, and proposes a fix as a pull request. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN` | A model run per labelled issue. | When you file bugs for the agents to fix, or with explore or the code audit, whose findings it triages. |
| The Lead's briefs | `agent-lead.yml` | Turns a mandate you dispatch into a project brief, opened as a pull request. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; project briefs under `docs/projects/`, from the brief template (`K-PROJ-1`) | A model run per dispatch. | When you want agents to plan work that spans several issues. |
| The Lead's briefs | `agent-lead-revise.yml` | Revises the Lead's own brief pull request when the Reviewer requests changes. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN` | A model run per change request, capped in rounds. | With the Lead's brief: without it, a change request on a brief waits for a person. |
| The Lead's briefs | `agent-lead-split.yml` | Proposes splitting a project issue too big for one Implementer run, as a pull request against its brief. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; project briefs under `docs/projects/` | A model run per labelled issue. | With the Lead's brief, so an issue too big for one run is split rather than stalled. |
| Projects | `agent-lead-reconcile.yml` | Drives an approved brief to done: files its issues, labels them for the Implementer in order, and closes the project once its merges are deployed. | the Author App; a schedule (`7 * * * *`); project briefs under `docs/projects/`; your reference environment's deploy declaration (docs/lanes.md) | No model; a short job on each merge and an hourly heartbeat. | With the Lead's brief: it is what turns an approved brief into work. |
| Projects | `agent-verify-acs.yml` | Runs the tests that cite a project's acceptance criteria, and has the Explorer file what fails. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; project briefs under `docs/projects/` | A model run per project verified. | With the reconciler, which asks it to verify a project before closing it. |
| Overseer and digests | `agent-overseer.yml` | Audits the pipeline weekly from its aggregate, and again when a Kanon upgrade moves the agent runtime past its capability ledger's watermark, and files what you can act on as `pipeline-improvement` issues. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; the QA store, if you have one; a schedule (`0 6 * * 1`) | A model run weekly, plus one when a Kanon upgrade moves the agent runtime forward. Every other merged Kanon upgrade runs only a short gate job. | Once several lanes have run for a few weeks, so it has something to audit. |
| Overseer and digests | `agent-project-digest.yml` | Posts each open project's progress to a chat channel daily, and files an issue for a lane caller that keeps failing. | no App; `CLAUDE_CODE_OAUTH_TOKEN`; `DIGEST_WEBHOOK`; a schedule (`0 7 * * *`) | A model run daily. | With the reconciler, when you have a chat channel for the developers. |
| Overseer and digests | `agent-weekly-digest.yml` | Posts the week's burndown and deliveries in plain language to a chat channel, for a stakeholder outside the day-to-day work. | no App; `CLAUDE_CODE_OAUTH_TOKEN`; `DIGEST_WEBHOOK`; a schedule (`0 8 * * 1`) | A model run weekly. | When the Stakeholder is not the Owner and follows the project from outside, through a chat channel. |
| Merge | `agent-merge.yml` | Merges, with no person, an Implementer pull request the Reviewer approved with every check green, inside the green zone (`K-MERGE-4`). | the Judge App; a schedule (`37 * * * *`) | No model; a short job per review, per CI run on the default branch, and hourly. | Once you have merged the Implementer's approved pull requests by hand for a while, and trust the green zone. |
| Rebase and sweeps | `agent-rebase.yml` | Resolves a merge conflict on an agent's pull request, so its CI and review can resume. | the Author App; `CLAUDE_CODE_OAUTH_TOKEN`; a schedule (`17 5 * * *`) | A model run per conflicting agent pull request, checked on each CI run and daily. | With implement or triage, whose pull requests otherwise wait for a person when they conflict: a person's rebase takes one out of the Implementer's chain, so the revise lane refuses it. |
| Rebase and sweeps | `agent-dispatch-sweep.yml` | Re-dispatches, once a day, an implement or triage run that never happened, and reports what waits on a person. | the Author App; the QA store, if you have one; a schedule (`30 4 * * *`) | No model; a short job daily. | With implement or triage, so a label whose event never arrived still starts its run. |

<!-- /lane-catalogue:table -->

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
  statuses: read

jobs:
  revise:
    uses: yedeya-labs/kanon/.github/workflows/agent-implement-revise.yml@v0.33.0
    with:
      pr_number: ${{ inputs.pr_number }}
      reset: ${{ inputs.reset }}
    secrets:
      AUTHOR_APP_ID: ${{ secrets.AUTHOR_APP_ID }}
      AUTHOR_APP_PRIVATE_KEY: ${{ secrets.AUTHOR_APP_PRIVATE_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

<!-- x-release-please-end -->

- **Each caller has its lane's file name** (`K-LAYOUT-18`, [#207](https://github.com/yedeya-labs/kanon/issues/207)): the caller of `agent-implement-revise.yml` is `.github/workflows/agent-implement-revise.yml`, and so on. Kanon's scripts find a lane's runs, and start it, by that file name: the Merger dispatches your review caller, the reconciler lists the runs of your revise callers, and the health check watches every `agent-*.yml`. Under another name those reads come back empty and read as "nothing to do", so `lane-check` fails a caller at any other path. GitHub files a run under the top-level workflow, so the caller holds the triggers itself: `lane-check` also fails a caller that is a reusable workflow another of yours calls. A project that runs the review lane or the reconciler also keeps its CI at `.github/workflows/ci.yml`, whose runs both read.
- **Four callers have fixed names** ([#53](https://github.com/yedeya-labs/kanon/issues/53)). GitHub reports a called lane's checks under its caller's `name:`, and the merge gate tells its own checks, and the review event's, from the rest by that name. Name the review lane's caller `Review (Reviewer)`, the merge-reconcile lane's `Merge Reconcile (Reviewer)`, the implement-revise lane's `Implement (Implementer) — revise` and the Merger's caller `Merge (Merger)`, and give the revise and merge-reconcile callers' one job the ids `revise` and `reconcile`. Under another name the Merger waits on itself, so `lane-check` fails a Merger caller under any other name.
- **Triggers are yours.** A reusable workflow can't declare its caller's events. The `github` context in a called workflow is the caller's, so the lane reads the triggering event exactly as it would in your own file.
- **Inputs pass through, by name.** `with:` passes your `workflow_dispatch` inputs as `${{ inputs.<name> }}`, and nothing else. On the other triggers they arrive empty, which the lane expects. Every lane also declares `smoke`, which your caller never passes, and `lane-check` fails a caller that does: Kanon's lanes smoke sets it so that its runs take concurrency groups of their own and never queue behind, or cancel, your real runs.
- **`permissions:` is the ceiling.** Each lane declares the permissions it needs, and a called workflow can only narrow what its caller grants. Grant at least what the lane declares, or the run fails to start.
- **Secrets are mapped explicitly, by their fixed names** ([plan 0001 §8](plans/0001-move-the-agent-lanes.md)): the App's `AUTHOR_APP_ID` and `AUTHOR_APP_PRIVATE_KEY` (the Implementer's, the Lead's, the Explorer's and the Overseer's lanes) or `JUDGE_APP_ID` and `JUDGE_APP_PRIVATE_KEY` (the Reviewer's and the Merger's), and `CLAUDE_CODE_OAUTH_TOKEN` (plan 0005 §3.5). The role-named secrets of earlier releases (`IMPLEMENTER_APP_ID`, `REVIEWER_APP_ID`, …) are gone: `lane-check` fails a caller that maps one, naming the secret it takes instead. Never `secrets: inherit`, which would hand every secret in your repository to Kanon's code. [`kanon apps`](apps.md) stores the two App secrets. `CLAUDE_CODE_OAUTH_TOKEN` is the token of the Claude subscription the agents run on. Make it with `claude setup-token`, signed in to that subscription, and store it yourself with `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/<repo>`, pasting it on standard input.
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
    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.33.0
    with:
      pr_number: ${{ inputs.pr_number }}
    secrets:
      JUDGE_APP_ID: ${{ secrets.JUDGE_APP_ID }}
      JUDGE_APP_PRIVATE_KEY: ${{ secrets.JUDGE_APP_PRIVATE_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

<!-- x-release-please-end -->

4. **[`lane-check`](../actions/lane-check/README.md) in CI**, and the Dependabot entry it asks for.
5. **The Apps:** run [`kanon apps --apps author,judge`](apps.md) from that branch's checkout, and commit the register rows it writes, one per role, each App's rows sharing its slug. The Reviewer is a role of the Judge. `lane-check` fails a caller whose role has no row in the App register, so create the Apps before you push, or the branch is red until you do. If you must push first, rows with the slugs `kanon apps` will give them (`<owner>-author`, `<owner>-judge`) pass `lane-check`. `kanon apps` rewrites an existing row for its role in place, so mark those rows as placeholders and never merge them.
6. **`CLAUDE_CODE_OAUTH_TOKEN`**, as above.

Then merge. **The first review comes on the next pull request, not this one.** Both automatic triggers run the default branch's copy of the caller (`pull_request_target` runs the base's, `workflow_run` the default branch's), so a pull request that adds the caller is never reviewed by it. In bootstrap, a human merges that one (`K-ADOPT-4`). Then apply `review:please` to any open pull request whose CI has finished, or dispatch the lane (`gh workflow run <your caller> -f pr_number=N`), and the Reviewer's App posts a verdict.

## Kanon's scripts

The lanes run Kanon's pipeline library (`scripts/`) from the runner's action cache, at the version you pinned, never from your checkout: a step finds it with [`kanon-path`](../actions/kanon-path/README.md) and runs `node "$KANON/scripts/<name>.mjs"`. The scripts read your repository's files at the paths in [chapter 11](../rulebook/11-repository-layout.md), relative to the working directory, so they run in your checkout. A workflow of your own that runs one of them does the same, which is how Kanon's guards reach your CI: `kanon-path` at the pinned tag, then `node "$KANON/scripts/<guard>.mjs"`, with Dependabot proposing the upgrades. The scripts use only Node's built-in modules, so neither your repository nor the step needs a `package.json`, an install or a package manager, whatever your project's language. Node is Kanon's runtime, not your project's, and `kanon-path` sets it up: the version in `engines` in Kanon's own manifest, pinned, rather than whichever Node the runner image carries. Its [README](../actions/kanon-path/README.md) says where to call it relative to your own toolchain.

## The project-setup hook

`.github/actions/project-setup/action.yml` is a composite action you write ([plan 0001 §5](plans/0001-move-the-agent-lanes.md)). Every lane that checks out calls it after the checkout and before the agent, with these inputs, all strings: `lane`, `install`, `database`, `browsers`, `issue-number`, `app-slug` and `github-token`. It installs your toolchain and dependencies, and, when `database` is `'true'`, sets up your schema against the database in `DATABASE_URL`. It is read from the checked-out tree, so on a lane that checks out a pull request it is that branch's copy, except on the review lane, which restores your default branch's copy first (`K-MERGE-17`). The verify-acs lane loads it from your caller's commit, because the release it verifies may predate it, and calls it in a job that holds no App token and no Claude token: that job runs the hook and the acceptance criteria and uploads the report, and the agent's job, which receives the token, runs none of the code it verifies ([#243](https://github.com/yedeya-labs/kanon/issues/243), `K-AGENT-50`). So on that lane the hook gets no `github-token` and no `app-slug`, and its post steps run in that job. **The Lead's lanes (`agent-lead.yml`, `agent-lead-revise.yml`) don't call your hook at all** (`project-setup: false` on the shared lane workflow, [#243](https://github.com/yedeya-labs/kanon/issues/243)): the Lead runs none of your code. Its shell is an allow-list like the Reviewer's: it writes only under `docs/`, runs Kanon's `kanon-brief-guard`, `kanon-spec-ids` and `kanon-spec-coverage`, commits and pushes to `origin`, and calls named `gh` subcommands, and it loads none of your project's Claude Code settings. On those lanes git checks each symlink in your tree out as a plain file holding the link's target, so the Lead can't write outside `docs/` through one ([#327](https://github.com/yedeya-labs/kanon/issues/327)); a link the Lead reads shows as its target's path, and a commit keeps it a link. So a Lead playbook of yours that asks the Lead to run your lint, tests or a package script gets a refusal; take those results from CI. The implementer's revise and conflict-resolution lanes still run your hook from the pull request's branch beside their token, an exposure the Owner accepted (`K-AGENT-50`).

**The starting map.** When a lane passes an `issue-number`, your hook may write `.agent/starting-map.md` (`K-AGENT-41`). The implement lane's prompt reads it first if it exists, and nothing fails without it. Kanon's [`scripts/starting-map.mjs`](../scripts/starting-map.mjs) `--issue <n>` writes one from the issue and the spec clauses it cites.

The contract defines no outputs, and no lane reads any: a lane judges your hook only by whether it succeeded. The review lane doesn't call your hook at all ([#185](https://github.com/yedeya-labs/kanon/issues/185)).

## The test database

A lane gets a database only when your project declares one, in `docs/qa/test-database.md` (`K-LAYOUT-16`). With no file, your hook gets `database: 'false'` and `DATABASE_URL` stays unset. Declare `hook`, and your hook gets `database: 'true'`: it starts your database, whatever the engine, and writes `DATABASE_URL` before it returns. Kanon starts none and names no engine. The [`test-database`](../actions/test-database/README.md) block reads the declaration. Its README has the format and a worked example, a hook that starts Postgres. Add the declaration before, or with, the upgrade that brings it, then rebase your open pull requests: a lane that checks out a branch reads that branch's copy.

## The QA store

The code audit, the Explorer, the Overseer and the dispatch sweep remember earlier runs in a QA store in your own account (`K-OBS-17`). They reach it only through a hook you write, `.github/actions/qa-store/action.yml`, with five operations, each run in a store job of its own, the only kind of job that holds `id-token: write`, so no agent job holds the store's credentials. The store trusts your default branch's ref, and no GitHub Environment. Kanon's AWS implementation provisions a store and is the hook's one `uses:` line. Without a hook, each lane runs without memory and says the store is absent. [The QA store](qa-store.md) has the contract, the setup and the AWS runbook.

## The stack document and the playbooks

The lanes' prompts state the process and never your stack. What your stack decides, they read from files you own, at fixed paths (`K-LAYOUT-17`): the **stack document**, `docs/qa/stack.md`, with `## Gates` and, when you have something to say there, `## Schema changes`, `## Data isolation` and `## Generated files`, and the **playbooks**, `docs/qa/triage-fix-playbook.md`, `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` and `docs/qa/lead-playbook.md`, with `docs/qa/overseer-playbook.md` and the capability ledger, `docs/qa/capability-ledger.md`, when you install the Overseer. The rule says what each section holds.

**What you leave out is a documented default** ([plan 0005](plans/0005-lean-installation.md) §5.2). A stack-document section you omit, other than `## Gates`, means none: no schema, nothing to isolate, no generated files. A playbook you don't write is Kanon's baseline for the role, [`rulebook/templates/playbooks/`](../rulebook/templates/playbooks/) at the release you pin: the lane's `agent-setup` block puts it in place before the agent starts, keeps it out of the agent's commits, and says so in the job summary and in the agent's prompt, so an agent asked to write that playbook stages it with `git add -f`. Write your own, starting from a copy, when you want the Reviewer to check your project's own risks. `lane-check` fails when the stack document or a capability ledger a lane you call reads is missing, or the stack document has no `## Gates`, and names each default it takes.

**Your code areas.** The stack document may also say where your code and tests are, under `## Code areas`, one bullet per area: a path in backticks, an em dash, its kind, a colon, and what it holds.

```markdown
## Code areas

- `src/` — code: the application
- `tests/` — tests: unit and integration tests
- `src/server/services/` — audit: the service layer, where tenant scope and authorisation live
```

A `code` tree is your own source: `citation-shift` reads its comments, and the spec-id sweeps read its references. A `tests` tree holds tests and their fixtures: `doc-path-guard` doesn't read its files as claims. An `audit` area is what the code audit reads first. Without the section, the guards read the whole repository, a test is what its language's convention calls one, and the audit reads your `code` trees, or the whole repository. So an undeclared tree is read, never skipped: declare the trees once a guard reads something it shouldn't. `lane-check` fails a malformed section by name, and so does each guard that reads it.

## The App register

The revise lanes find their own App's login in the App register, and the scripts the lanes run read every role's login from it, `docs/qa/agent-identities.md` (`K-LAYOUT-6`), read from your default branch. Each role a lane runs as needs one row there with its App slug in backticks. Since plan 0005's L4 the rows of one App's roles name that App's slug: the Author's four one, the Judge's two another, and the Releaser's, if you have one, a third. `lane-check` fails a register in which one App's roles name two slugs, or two of those Apps share one (§3.4). Each lane says which role it runs as on a `# KANON ROLE:` line, which `lane-check` reads.

Every post a lane writes as one of your Apps opens with a persona header and a hidden role marker, `**Implementer** <!-- kanon:role=implementer -->`, and every agent commit has the persona as its author name (plan 0005 §3.3). The Implementer's lanes also set a `kanon/role: implementer` commit status, from a job after the agent's, with a token narrowed to Commit statuses write. To have it set, grant your Implementer App **Commit statuses: Read & write** and record that broadened permission in the register (`K-AGENT-3`). Until then the job says so in the run's summary and changes nothing.

**Since plan 0005's step L4 both are required.** Every reader that tells two roles apart needs the role's marker beside the App's login. The agent is asked to write the header; for a review the lane does not rely on it. The review lane's stamp step signs the Reviewer's verdict with the header when the agent left it off, and when it can't, the run goes red by name rather than leaving a verdict no reader counts. Where an Implementer comment on an issue carries no marker, crash recovery says so in a warning. A lane whose role `agent-setup` can't resolve fails that step by name before its agent runs, instead of running an agent whose posts no reader would count. The Merger merges only a pull request whose head carries a `success` `kanon/role: implementer` status created by the Implementer's App, and otherwise skips it as `not-the-implementer`; an unreadable status list waits. The revise and rebase lanes act only on a pull request whose head carries that status, and refuse any other by name, so a person's push takes a pull request out of the green zone and a person merges it. Both callers now grant `statuses: read`. Grant the permission to your Author App (the Implementer's) before you move the pin to this release, or every Implementer pull request waits for a person.

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

**If your production promotion is human-gated, you may let the Merger merge your high-risk paths** ([#158](https://github.com/yedeya-labs/kanon/issues/158), `K-MERGE-4`). Where every production deploy already waits for a person's approval, say so under `## Choices` in your adoption record, and name what holds the approval:

```markdown
- **Production promotion:** human-gated (the `production` environment's required reviewer)
```

The Merger reads it from your default branch, so the pull request that adds it is judged without it, and escalates anyway, because it changes `docs/qa/`. Once merged, a pull request that touches only your `## Escalation paths` merges in the green zone. Everything else still escalates: `.github/`, the `docs/qa/` documents, `AGENTS.md`, `CLAUDE.md`, `.claude/`, your `## Pipeline code`, and a high-risk path that is also a judging input (a document your instructions link to). Without the bullet, which is the default, every escalation path escalates, and every sweep says so. If code outside `.github/` keeps the promotion gated, such as infrastructure that manages the environment's required reviewers, list it under `## Pipeline code`, or a pull request that removes the gate can merge in the green zone ([#344](https://github.com/yedeya-labs/kanon/issues/344)). Kanon doesn't check that the environment really has a required reviewer, or that no deploy can skip it: make the declaration only if both hold. The human gate moves to the promotion, where one approval covers every change in the deploy.

On a review, the lane first reads the Merger's and the Implementer's logins from the App register on your default branch, in a job of their own. That job starts no runner for a review on a pull request that is closed, a draft or carries neither lane label. The sweep needs no login, so CI's completion, the schedule and a dispatch start the Merger's own job alone, and bill one runner each.

## The reconciler

The Lead's reconcile lane drives an approved brief to done (`K-PROJ-*`): each tick files the issues the brief proposes, labels them for the Implementer in the brief's order, and closes the project once its merges are deployed to your reference environment. It also re-delivers a review that never landed and a brief pull request's unanswered changes-request, and reports a pull request that is red and unreviewed. It runs no model. Its caller:

- **Keeps four triggers:** `pull_request: [closed]` and `issues: [closed]`, so a merge starts the next tick; an hourly `schedule`, the heartbeat that recovers an event that never arrived; and a dispatch with `project` and `apply`, which without `apply` is a dry run.
- **Grants the reads its pre-filters use** on the workflow token: `issues`, `pull-requests`, `checks`, `statuses` and `actions`, all `read`. Without one, a read fails and the tick goes red rather than reading as idle.
- **Passes no budget.** A tick takes at most six chargeable actions across every open project, a constant of the lane.

It needs the Lead's App, with `Actions: Read` on the installation (the tick probes it before the deploy phase), and your reference environment's deploy declaration (above).

## The rebase lane

The rebase lane resolves a merge conflict on the Implementer's pull request, so its CI, review and revision can resume (`K-AGENT-34`). Its agent merges your default branch into the pull request's branch as the Author App, resolves what conflicts and pushes a merge commit, never a force-push. A fixed job after the agent's then carries the `kanon/role: implementer` status to the head it pushed, when the head it started from carried one and every commit on the first-parent path between them is the App's ([The App register](#the-app-register)). Its caller keeps three triggers: CI completing on your default branch, a daily `schedule` as a floor, and a dispatch with `pr_number`. It acts only on a pull request whose head carries the status, and refuses any other by name.

**Leave a conflict on an Implementer pull request to the lane.** The status is bound to the head the Implementer's run pushed ([#324](https://github.com/yedeya-labs/kanon/issues/324)), so a person's rebase, or a person's merge of the default branch, gives the pull request a head without it. The pull request then leaves the Implementer's chain: the revise lane refuses its next changes-request, the Merger skips it as `not-the-implementer`, and this lane refuses it too, so a person finishes it ([#448](https://github.com/yedeya-labs/kanon/issues/448)). Install the rebase lane with implement or triage, and dispatch it for the pull request when a conflict can't wait for the next run.

## The dispatch sweep

The Lead's dispatch sweep reconciles the two lanes that a label starts, implement and triage (`agent:implement`, `qa:needs-triage`). An event that never arrived starts nothing, so once a day it re-derives each open labelled issue's state from GitHub: it re-dispatches an issue whose run never happened, or whose question a person answered, up to two attempts; stops one whose latest run hit its turn or budget cap; and reports what waits on a person. On the same run it takes `gate-candidate` off each open issue the Stakeholder has decided, placed on a roadmap milestone or labelled `gate:declined` (`K-WORK-10`). It runs no model. Its caller:

- **Keeps two triggers:** a daily `schedule` (the reference adopter's is `40 4 * * *`), which applies, and a dispatch with `apply`, which without `apply` is a dry run.
- **Grants `contents: read` and `id-token: write`.** The OIDC token is for the lane's store job alone, which reads the cost rows through your store hook. The sweep's own job declares no `id-token`, and no job declares an environment: the store trusts your default branch's ref ([Who can reach the store](qa-store.md#who-can-reach-the-store)). GitHub refuses to start a called job that asks for more than its caller grants, so the grant is needed with or without a store hook; without one, nothing uses it.

**Its cost rows.** An attempt is charged per re-dispatch it made, so it reads 14 days of the two lanes' cost rows to discount a dispatch whose run never reached the model, and to find a run that hit its cap.
- **With a store hook** ([The QA store](qa-store.md)), it reads them through the hook's `cost-rows` operation, and its summary says "Cost rows from the QA store" and "Cost rows read" with a count per lane.
- **Without one**, it reads the lanes' run artifacts (each run of a Kanon lane uploads its telemetry row), and its summary says so. Your repository's artifact retention caps how far back that reaches, and when it is shorter than the 14 days the summary says how much of the window it covered. Settings, Actions, General, "Artifact and log retention" sets it.
- **A read that fails** charges every dispatch, and the summary's line says why.

It needs the Lead's App, with `Issues: write`, `Pull requests: read` and `Actions: read` on the installation. Until the App's secrets are set, the sweep skips with a warning instead of going red.

## The code audit

The Explorer's code-reading mode reads your code and your specs every few days, and files a bug only on an objective contradiction: a consumer that can't work, a security anti-pattern, a bypassable contract, or code that contradicts a promoted invariant (`K-WORK-9`'s rubric rates it). It reads what your stack document declares under `## Code areas` (above), and the playbook's "Code-reading mode" section. Its caller:

- **Keeps two triggers:** a `schedule` (the reference adopter's is `30 7 */3 * *`) and a dispatch with no inputs.
- **Grants `contents: read`, `issues: read`, `actions: write` and `id-token: write`.** The OIDC token is for the lane's two store jobs alone, and `actions: write` for the job that deletes the store's export after the audit. The audit job itself declares neither, and no job declares an environment ([Who can reach the store](qa-store.md#who-can-reach-the-store)). GitHub refuses to start a called job that asks for more than its caller grants, so the grants are needed with or without a store hook.

**Its memory.** With a store hook ([The QA store](qa-store.md)), the audit widens its coverage from the store's code-reading ledger, read through the hook's `export` before the agent, and its report is written through `put` after it, red run or green. Without one, it runs without memory: the export says the store is absent, the agent chooses areas from the history alone, and `put` is skipped with a notice.

**Its report.** The agent writes `qa-audit-summary.json` on its first turn and re-writes it after each area. The workflow stamps the measured duration, the trigger and the commit, and counts the lines cited itself. A run that wrote no report, or one that doesn't parse, is recorded as such and then turns red; a run whose agent exited non-zero after a complete report stays green with a warning.

It needs the Explorer's App, with `Contents: Read` and `Issues: Write` on the installation.

## Explore the telemetry

The Explorer's telemetry mode (`agent-explore-telemetry.yml`, plan 0004 step 14) reads Kanon's hosted telemetry once a week, through the aggregate function ([The aggregate function](telemetry.md#the-aggregate-function)), and never a row. The function answers only what may be published (plan 0002 §6.1): cross-adopter cells of at least three adopters, the own figures of each adopter that declared them publishable, and the last week's failure signals, by lane, reason, stage, Kanon error and Kanon version, with how many adopters each affected. The agent looks for anomalies the fixed rules of [#41](https://github.com/yedeya-labs/kanon/issues/41) would miss, and "no findings" is a good run.

**Who can install it.** A repository whose entry in Kanon's telemetry register sets `aggregate_invoker`, which the Owner adds on request. That creates the role `kanon-telemetry-<key>-aggregates`, trusted for your default branch's ref, which may call the function's URL and nothing else. Set the repository variable `KANON_AGGREGATE_URL` to the stack's `AggregateUrl` output, and the repository secret `KANON_AGGREGATE_ROLE` to your `AggregateInvokerRole<id>` output, the role's ARN. Without both, the lane says so in a notice and stops after its gate, green.

Its caller:

- **Maps four secrets by name:** the Author App's two, `CLAUDE_CODE_OAUTH_TOKEN` and `KANON_AGGREGATE_ROLE`, never `secrets: inherit`. A repository without a role still maps it, to a secret it doesn't have, and the lane stops after its gate.
- **Keeps two triggers:** a weekly `schedule` (Kanon's is `30 6 * * 2`) and a dispatch with no inputs. A dispatch from a branch other than your default one is skipped, because the role trusts only the default branch's ref.
- **Grants `contents: read`, `issues: read`, `actions: read` and `id-token: write`.** The OIDC token is for the lane's `aggregate` job alone, which assumes the role, calls the function with a signed `GET`, checks the answer, and hands it to the agent's job as an artifact kept one day. The agent's job declares no `id-token`, and no job declares an environment.

**What the log shows** ([#433](https://github.com/yedeya-labs/kanon/issues/433)). The role's ARN holds your AWS account id, so it is a secret, which GitHub masks wherever it appears. The lane reads one variable, the URL, never every variable. The `aggregate` job's first step after Kanon's path masks the URL, and the account id inside the ARN on its own, so every later step prints `***` for them. That step's own environment is printed before it can mask anything, so on a public repository the URL appears once per run, in that step's header. The URL is not a credential: an unsigned or unregistered caller gets 403.

**Who files what.** The agent's token reads only. It writes its findings to `qa-telemetry-findings.json`, each naming the signals and cells it rests on, and a job of its own with no agent checks each finding against the same aggregate and files or drafts it (`scripts/telemetry-file.mjs`):
- **Drafted, unless you file them yourself.** Every finding is about Kanon's lanes, so it goes by your adoption record's ``- **Upstream findings:** `filed here` `` choice under `## Choices` (`K-LAYOUT-10`), as the Overseer's do. The lane's gate job reads it from your default branch before the agent runs, so the agent can't change it. With `filed here`, the job mints a filing token and files each finding in your repository. Without it, each checked finding is written into the run's summary, rendered exactly as it would be filed, and nothing is filed or minted; you may file one on Kanon by hand. Nothing is ever filed in another repository.
- **The figures come from the aggregate, not the agent.** Each finding must name entries of the aggregate exactly, and the step renders their figures into the issue. The agent's title and body may hold no digit other than an issue reference, a rule id, or a model or Kanon version the aggregate names, and nothing shaped like an adopter key or a stored partition. A finding that breaks a rule is refused by name, never filed or drafted, and the job turns red after the rest.
- **The Explorer's filing gate** (`K-AGENT-9`): a finding that rests on a failure signal is a `bug` (`agent:explorer`, `qa:needs-triage` and its `sev:*`), and one that rests on cost cells alone is a `spec-delta` (`agent:explorer`), each in the bucket your milestone routing gives its labels (`K-WORK-4`; *Product Backlog* for these labels). An open `agent:explorer` issue with the same signature (what it rests on, without the figures) gets a comment with the week's figures instead of a second issue. At most three new issues a run.

It needs the Explorer's App, with `Contents: Read`, and `Issues: Write` to file.

## The digests

Two lanes post a summary to a chat channel, as a `{"text": …}` body to the webhook in your `DIGEST_WEBHOOK` secret (Slack's incoming webhooks take that body). Without the secret, a digest posts nothing and its run stays green. Each writes a few sentences with a model first, and posts its numbers without them if that step fails. Neither mints an App token: they read with the workflow token.

- **The daily project digest** (`agent-project-digest.yml`) is for the developer: where each open project in `docs/projects/` has got to, and what is stopped and why. Its caller keeps a daily `schedule` and a dispatch with `dry_run`. Schedule it after the reconciler's hourly tick, so it reads the freshest state.
- **Its health job** rides the same tick. It files one `pipeline-improvement` issue in *Development Automation* naming every lane caller (`.github/workflows/agent-*.yml`) that is red on every recent run, and keeps it until they recover, because GitHub's own failure notification goes to a run's actor, which on a schedule is nobody who reads it. Where an Overseer is installed (`agent-overseer.yml`), it also files one when no weekly Overseer audit has landed in nine days. It needs `actions: read` and `issues: write`, which the caller grants. A dry run prints its table and files nothing.
- **The weekly digest** (`agent-weekly-digest.yml`) is for a stakeholder outside the day-to-day work: the week's milestone burndown and what was delivered, in plain language, and nothing pending. Name its reader with a `- **Weekly digest audience:** …` bullet under `## Choices` in your adoption record (`K-LAYOUT-10`), read from your default branch; without it, the narrative is written for "a stakeholder who follows the project from outside the day-to-day work". Its caller keeps a weekly `schedule` and a dispatch with `week_end` (the end of the 7-day window, an ISO date) and `dry_run`.

## The Explorer's sweep

The explore lane (`agent-explore.yml`) has the Explorer triage a sweep of your running product and file what it finds. What it sweeps, with which tool and in which tiers, is your product, so the sweep is yours: a composite action at `.github/actions/explore-sweep/action.yml`, the **sweep hook** (plan 0004 decision 5). The lane sets the project up through your project-setup hook, with `lane: explorer`, `browsers: 'true'` and the database your test-database declaration gives, then calls the sweep hook with one input, `tier`, and reads one file it writes, `qa-explore-summary.json`. [The Explorer's sweep](explore-sweep.md) has the hook's contract and the summary's format. A summary that is missing, malformed, or for another commit or tier is no sweep: the run goes red by name, the agent doesn't run, and nothing is recorded.

Its caller:

- **Keeps two triggers:** a daily `schedule`, and a dispatch with `tier`, passed through. Blank sweeps every tier.
- **Grants `id-token: write`,** for the lane's store jobs alone, and `issues: read` and `actions: read` for the quality and telemetry reads. The Explorer's App token files the issues.

**The change gate.** A scheduled run on a commit your QA store already holds a green full sweep of is skipped, and the skip is recorded, so a quiet day costs one short job, not a sweep. A dispatch always sweeps. The store's answer is read in a store job, through your store hook (`last-green`), and the run's summary is recorded the same way (`put`). Without a store hook the lane always sweeps, says the store is absent, and records nothing.

## The Overseer

The Overseer is optional. It audits your pipeline once a week from the aggregate: precision per signal, follow-up leakage, backlog dynamics, the QA store's runs and coverage, workflow history, and the capability ledger (`K-SELF-9`). It keeps one rolling audit issue, titled `[pipeline] audit-summary — Overseer audit #N`, and closes the one before it (`K-SELF-11`). Say whether you install it with one bullet under `## Choices` in your adoption record (`K-LAYOUT-10`):

```markdown
- **Overseer:** `installed`
```

or `not installed`. `lane-check` fails a record that doesn't say, or that says `installed` with no `agent-overseer.yml` caller, or `not installed` with one. Its caller:

- **Keeps two triggers:** a weekly `schedule` (the reference adopter's is `0 7 * * 1`) and a dispatch with no inputs.
- **May add the runtime-version trigger** ([#423](https://github.com/yedeya-labs/kanon/issues/423)), which `kanon init` writes: a merged pull request on your default branch that changes the caller file itself, written `pull_request_target: types: [closed]` with `branches:` your default branch and `paths:` the caller's own path. Your agent runtime is the Claude Code CLI that the Kanon release you pin installs, so it moves only when Dependabot moves that pin. On that merge the lane's gate job compares the runtime of the release it now runs with your capability ledger's watermark (`K-LAYOUT-7`), read from your default branch, and audits only when the runtime is newer, compared part by part as numbers; the same version or an older one (a rollback) skips the audit, and the run says so in its summary. When it audits, the agent is told the trigger, and the capability review is due whatever the week. **The QA store isn't read on this trigger:** your store's role trusts only your default branch's ref, and a `pull_request_target` token's subject names the pull request, so the export is `degraded`, which the audit expects and doesn't report as a finding. The weekly run reads the store. Anything it can't read, such as a ledger with no bare watermark, makes the audit run. The membership gate judges the member who merged, `pull_request.merged_by` (on a merge-queue merge, the member who queued it); a pull request closed unmerged is turned away. Keep the ledger's watermark folded in from the audits' `Ledger delta`, or each later upgrade with the same runtime audits again.
- **Grants `contents: read`, `issues: read`, `actions: write` and `id-token: write`.** The OIDC token is for the lane's store job alone, and `actions: write` for the job that deletes the store's export after the audit. The audit job itself declares neither, and no job declares an environment ([Who can reach the store](qa-store.md#who-can-reach-the-store)).

**Who files what** (plan 0004 decision 12). The agent's token reads only. It writes its audit and its findings to a file, each finding naming its subject, and a job of its own, on a fresh runner that runs no agent and checks out nothing, files them on a token of its own (`scripts/overseer-file.mjs`), then deletes the file's artifact:
- **A finding you can act on** (a declaration, a playbook, a hook, an App or its permissions, cost, a schedule, labels, milestones, test or spec coverage) is filed in your repository as a `pipeline-improvement` issue, in *Development Automation*.
- **A finding only Kanon can act on** (a lane's behaviour, a guard, a rule, Kanon's library) is never filed in your repository. It goes under the audit issue's `## Upstream` heading, as a draft you may file on Kanon by hand, after checking it names nothing of your project (ADR 0007). The heading is there every week, empty or not.
- **Unless your adoption record says they are filed in your repository:** ``- **Upstream findings:** `filed here` `` under `## Choices` (`K-LAYOUT-10`) files each of them in your repository instead, for a repository that can act on them itself. It never files in another repository. A finding whose subject the step doesn't know stays a draft. The lane's gate job reads the choice from your default branch before the agent runs, so the agent can't change it; without the bullet they are drafts.
- **A capability investigation** is filed only while the capability interlock is clear, counted by `scripts/capability-interlock.mjs`, and at most one a week (`K-SELF-17`).

**What it reads.** Its playbook, `docs/qa/overseer-playbook.md`, with the sections `K-LAYOUT-17` names; the capability ledger; and, with a store hook, the store's `overseer` export ([The QA store](qa-store.md)), including the token trend, the cache-TTL facts and the recall clusters your hook writes. Without a store it audits from GitHub alone, and says the store is absent.

It needs the Overseer's App, with `Contents: Read`, `Issues: Read & write`, `Pull requests: Read` and `Actions: Read` on the installation: the workflow history is the one place a run that died writing nothing is visible.

## Checking it

Run [`lane-check`](../actions/lane-check/README.md) in CI. It fails on a caller that holds more than the above, a caller that isn't at its lane's file name, a review or reconciler caller without `.github/workflows/ci.yml`, a review caller whose `run-name` doesn't end with the head SHA, or a Merger caller not named `Merge (Merger)`, passes a setting instead of an input, maps the wrong secrets, grants too little, or pins a second version; on a missing or incomplete hook, or a missing sweep hook for an explore caller; on a missing stack document or capability ledger, or a stack document without `## Gates` or with a section twice; on a malformed test-database declaration, escalation file, exemptions file, reference-deploy declaration or production-promotion declaration; on an adoption record whose Overseer bullet, or its default `not installed`, the callers contradict; on a role missing from the App register, a register whose Apps' roles name two slugs or share one, or a caller that maps a role-named App secret; and on a missing Dependabot entry.
