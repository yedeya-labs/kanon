# Plan 0010: a reusable deployment lane

- **Status:** proposed 2026-10-14. Nothing in this plan is built. The Owner captured the lane on 2026-10-08, with a design sketch, and queued it after the adoption wedge ([#610](https://github.com/yedeya-labs/kanon/issues/610)). This plan turns the sketch into steps; eighteen questions are left for the Owner ([Decisions for the Owner](#decisions-for-the-owner)), each with a recommendation.
- **Tracks:** [#610](https://github.com/yedeya-labs/kanon/issues/610). **Builds on:** [plan 0008](0008-self-service-registration.md) (the `v*` tag ruleset of its J5, and its J9, which removes the private register from the telemetry stack's deploy), [plan 0009](0009-release-channels-and-api-key.md) (candidates and stable releases on one commit), [plan 0003](0003-metrics.md) (the metrics module and its views) and [plan 0002](0002-hosted-telemetry-store.md) (the store and its collector). **Amends, once built:** plan 0003 §4 (a deploy view), plan 0008 §3.2 (a fourth row kind on `POST /v1/rows`), and the Owner's runbook in [`docs/telemetry.md`](../telemetry.md) ("Deploy"). **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), [ADR 0007](../decisions/0007-data-boundary.md), [ADR 0012](../decisions/0012-test-conventions-by-language.md), [ADR 0013](../decisions/0013-personal-accounts-and-two-apps.md), `K-AGENT-49`, `K-AGENT-50`, `K-SHIP-7` to `K-SHIP-10`, `K-PROJ-11`, `K-LAYOUT-10`, `K-MERGE-4`, `K-ADOPT-3`, `K-OBS-13`, `K-OBS-16` and `K-PRIN-11` (every guard can fail, and is mutation-checked).
- **Measured on** Kanon's `origin/main` at `680fffb`: the rulebook, `docs/lanes.md`, `docs/doctor.md`, `docs/telemetry.md`, `requirements.json`, `cli/doctor.mjs`, `actions/agent-telemetry/schema.mjs`, `scripts/lib/oidc-subject.mjs`, `scripts/lead-reconcile.mjs`, `.github/workflows/release.yml`, `release-please.yml`, `ci.yml`, `infra/telemetry/template.yaml`, and Kanon's adoption record. GitHub's and AWS's documentation was read on 2026-10-14 ([§14](#14-what-the-documentation-says)). Kanon's own repository settings were read on 2026-10-14 with `gh api` (its OIDC subject customization, its environments and its rulesets). The AWS CLI's `cloudformation deploy` help was read from CLI 2.36.8. No probe has run.

## The plan in one paragraph

**Today.** Kanon governs how a change is written, reviewed and merged, and how a release is cut, then stops. Its rules already say how a release becomes a deploy (`K-SHIP-7` to `K-SHIP-10`), and each one is "enforced by a deploy workflow" that Kanon doesn't ship, so on every adopter those rules are prose. Kanon's own adoption record says so: "Deploy, production approval and announcement workflows (Kanon deploys nothing): not yet installed". Kanon's one deployed system, its telemetry stack, is deployed by hand by the Owner: render, package, deploy, read the outputs, deploy again with the verify switches, run `verify.mjs`, deploy again without them ([`docs/telemetry.md`](../telemetry.md), "Deploy" and "Verify").

**Where it ends.**
- **A reusable workflow, `deploy.yml`**, called from a caller of the same name. It runs **only on a published release whose commit is on the default branch and whose CI is green**, never on pull-request code, so a cloud credential exists only where reviewed code runs.
- **Two GitHub Environments with fixed names, `staging` then `production`,** in one run, on one commit. Production waits for a required reviewer and runs only after staging and its smoke check succeeded on the same commit.
- **GitHub's OIDC token is the only cloud credential,** and the cloud role trusts the environment's subject, `…:environment:production`, which no other job in the repository can carry. The lane proves the binding on each run with a probe that expects a refusal.
- **One deploy per environment at a time, queued, never cancelled mid-run.**
- **The adopter keeps the command,** in two hooks at fixed paths, `.github/actions/deploy` and `.github/actions/smoke`, as it already keeps its toolchain in `.github/actions/project-setup`.
- **No model in the deploy path.** A failure is recorded as a `deploy` telemetry row, and one deduplicated issue, written by scripts. An optional, read-only diagnose lane may come later.
- **`kanon doctor`** checks the environments, their protection, the subject form, the hooks, and the probe's last answer.
- **Kanon dogfoods it:** its telemetry stack deploys through the lane, from a staging account to the production account, and the Owner's remaining steps shrink to one-time setup and a click to approve.

**How it gets there.** Probes in a sandbox first, because six behaviours the lane rests on are not stated in GitHub's documentation ([§14.2](#142-not-confirmed-and-how-each-is-handled)). Then the rules, the row, the lane and doctor, each with its tests and mutations; then the hosted store accepts the row and the metrics read it. The dogfood comes last: it needs plan 0008's J9, which takes the private register out of the telemetry stack's deploy, and three one-time Owner steps in AWS ([§15](#15-dogfood-kanons-telemetry-stack)).

## 1. Today, measured

| What | Where | What it costs |
|---|---|---|
| `K-SHIP-7`'s "release tags drive the deploy", `K-SHIP-8`'s CI gate on the release commit, `K-SHIP-9`'s human gate and `K-SHIP-10`'s announcement are each enforced by "a deploy workflow" | `rulebook/06-shipping.md` | Kanon ships none, so on every adopter they are prose; each adopter writes its own, or doesn't |
| The reconciler confirms a project's merges are deployed by reading the declared deploy workflow's run for the release that contains them, and the declared job's conclusion | `scripts/lead-reconcile.mjs` (`classifyDeploy`), `K-PROJ-11`, `K-LAYOUT-10` | It works against whatever workflow the adopter wrote; a deploy job skipped by its own gate reads as `gate-declined`, and a renamed job as `deploy-job-absent` |
| Kanon declares no reference environment and no deploy | `docs/qa/adoption.md`, `## Choices` and the mechanism table | No project on Kanon can close by `K-PROJ-11` |
| The telemetry stack's deploy is six manual commands and two extra deploys for verification, all the Owner's | `docs/telemetry.md`, "Deploy", "Verify" | Every change to `infra/telemetry/` waits on the Owner's terminal; plan 0008's step order (deploy intake before the release that writes a new row) is a checklist, not a mechanism |
| The deploy needs the private register (`render.mjs --register`) | `infra/telemetry/render.mjs`; `docs/telemetry.md`, "Where the register lives" | The register must never be in a repository where Kanon's lanes run, so **the deploy can't run in Kanon's CI until plan 0008's J9 deletes `render.mjs`** |
| The template names every resource (`kanon-telemetry`, `kanon-telemetry-register`, `kanon-telemetry-ingest`, the roles) | `infra/telemetry/template.yaml` | A second copy of the stack can't live in the same account: a staging stack needs its own account ([§15](#15-dogfood-kanons-telemetry-stack)) |
| Kanon's repository issues the immutable OIDC subject form | `gh api repos/yedeya-labs/kanon/actions/oidc/customization/sub`: `use_default: true`, `use_immutable_subject: true` | Any role trusting Kanon names the owner's and repository's ids, as `scripts/lib/oidc-subject.mjs` already reads them |
| Kanon has two environments, `github-pages` and `kanon-qa-store`, both with `can_admins_bypass: true`; the second is a leftover of plan 0004's decision 9 and protects nothing | `gh api repos/yedeya-labs/kanon/environments` | Admins can bypass by default; an environment with no rule is decoration |
| Kanon has one ruleset, on `main`; no tag ruleset yet | `gh api repos/yedeya-labs/kanon/rulesets` | Plan 0008's J5 adds the `v*` tag ruleset; this plan relies on it ([§3](#3-the-trigger)) |
| No row kind records a deploy; plan 0003 measures escapes by reverts and linked fixes, not deployment frequency or change-failure rate | `actions/agent-telemetry/schema.mjs`; plan 0003 §2 | The metrics can't say how often a project ships or how often a deploy fails |

## 2. What Kanon owns and what the adopter keeps

The sketch's split, which this plan keeps: **Kanon owns the governance; the adopter owns the command.** It is [ADR 0002](../decisions/0002-standardise-dont-parameterise.md)'s line, fixed shape and the project's content, and [ADR 0012](../decisions/0012-test-conventions-by-language.md)'s: Kanon never runs a tool the adopter didn't choose.

| Kanon owns: `deploy.yml` and its scripts | The adopter keeps |
|---|---|
| The trigger, and the gate that refuses anything but a released, green commit of the default branch ([§3](#3-the-trigger)) | Its release configuration, as today |
| The two environments' names, their order, and the rule that production follows staging on the same commit ([§4](#4-environments-staging-then-production-on-one-commit)) | Who approves production, and any wait timer |
| How the credential is obtained: OIDC only, inside the environment's job, and the probe that proves the binding ([§5](#5-credentials-oidc-bound-to-the-environment)) | The cloud, the account layout, the role and its permissions |
| Concurrency ([§6](#6-concurrency)) | — |
| Calling the hooks, recording each step's outcome, and what happens on failure ([§7](#7-the-adopters-command-and-smoke-check), [§8](#8-after-a-deploy)) | The deploy command and the smoke check's content, in two hooks |
| The `deploy` row ([§10](#10-the-deploy-row)) and doctor's checks ([§12](#12-doctors-checks)) | — |

## 3. The trigger

**The caller's triggers** (`K-LAYOUT-18`: the caller holds them; the lane names them):

```yaml
on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      release: { type: string, required: true }   # an existing release's tag, to deploy again
```

**`published`, not `released`.** GitHub's events page says to "subscribe to `published` instead of `released` and `prereleased`" to catch both stable and pre-releases, and that `prereleased` doesn't fire for a pre-release published from a draft. The lane then decides what a pre-release reaches (decision 4: staging only). For a `release` event, `GITHUB_SHA` is the "last commit in the tagged release" and `GITHUB_REF` is `refs/tags/<tag_name>`, so the lane's own workflow file is the caller **at the release's commit**, which is reviewed code.

**A release made with the workflow token deploys nothing.** GitHub: "With the exception of `workflow_dispatch` and `repository_dispatch`, other `GITHUB_TOKEN`-triggered events do not create workflow runs at all." `release.yml` creates the release with the Releaser's token when the caller maps it, and with the workflow token otherwise (`steps.releaser.outputs.token || github.token`), so **the deploy lane needs the Releaser** (decision 3). Doctor says so ([§12](#12-doctors-checks), `deploy.releaser-missing`). The alternative, a job chained after `release.yml` in the push run, needs no Releaser but runs on `refs/heads/main` and couples the deploy to the release workflow's run; it is weighed in decision 3.

**The gate job** runs first, holds no secret and no cloud credential (`contents: read`, `actions: read`, `deployments: read`), and runs `scripts/deploy-gate.mjs`. It refuses, by name, when any of these fails:

| # | Check | Refusal code |
|---|---|---|
| 1 | The release exists, is not a draft, and its tag resolves to `GITHUB_SHA` (for a dispatch: to the commit the `release` input's tag names) | `draft`, `no-release` |
| 2 | That commit is reachable from the default branch: `git merge-base --is-ancestor <sha> origin/<default>` on a blobless fetch | `not-default-branch` |
| 3 | `ci.yml`'s `push` run on the default branch at that commit completed with every job `success` (`K-SHIP-8`); while it runs, the gate polls every 60 seconds, up to a fixed 90 minutes (decision 9) | `ci-red`, `ci-timeout` |
| 4 | For a `release` trigger, the commit is not older than the environment's last successful deploy (the Deployments API's latest `success` status for `production`, compared by ancestry), so a queue that runs out of order ([§6](#6-concurrency)) never rolls production back unasked. A dispatch may roll back; its row says so ([§10](#10-the-deploy-row)) | `superseded` |

Check 2 matters because a release can be published on any existing tag, and a tag can point anywhere. Plan 0008's J5 restricts who creates `v*` tags on Kanon; an adopter's tag form is its own (a component tag, `<component>-vX.Y.Z`), so the gate checks the commit, not the tag's name. Check 3 is `K-SHIP-8` turned into a mechanism: the release is cut by the same push whose CI is still running, so the gate waits rather than refusing a green run that hasn't finished.

## 4. Environments: staging, then production, on one commit

**Fixed names.** The lane's jobs reference `staging` and `production`, nothing else (decision 2). An environment name that varied per adopter would be a setting, and a guard couldn't find it ([ADR 0002](../decisions/0002-standardise-dont-parameterise.md)). A fleet of production environments is the adopter's own policy ([ADR 0008 §4](../decisions/0008-installation-test-decisions.md)): its hook may fan out inside `production`.

**One run, one commit.** `staging` checks out `GITHUB_SHA` (with `persist-credentials: false`), runs the deploy hook, then the smoke hook. `production` `needs: staging`, is skipped for a pre-release (decision 4), checks out the same `GITHUB_SHA`, and does the same. Nothing is rebuilt from a different ref. Whether the two deploy **the same built artifact**, rather than the same commit, is the adopter's command's business in this version (decision 8): a hook can split into a build that needs no credential and a deploy that does only once the lane has a job for the first, which is a later step.

**Kanon's two-release flow fits without a special case.** Under plan 0009's channels a candidate is a pre-release (staging only), and its promotion publishes a stable release **on the same commit**, whose run deploys staging again (a no-op for an unchanged stack: `aws cloudformation deploy` exits 0 on an empty change set by default, measured from CLI 2.36.8's help) and then production.

**What GitHub gives the environments, as documented:**
- "All deployment protection rules must pass before a job referencing the environment is sent to a runner", and "a job cannot access environment secrets until one of the required reviewers approves it."
- Up to six required reviewers, of whom "only one … needs to approve"; an option to prevent self-review; a wait timer of 1 to 43,200 minutes; an option, on by default, to let administrators bypass the rules (Kanon's two environments both read `can_admins_bypass: true`).
- **Deployment branches and tags:** "No restriction", "Protected branches only", or "Selected branches and tags", with name patterns per branch or tag. The lane asks for selected refs: the release tags' pattern and the default branch (for a dispatch).
- A job that references an environment "creates a deployment object", which is what the gate's check 4 and doctor read.
- "A workflow may wait for up to 30 days on environment approvals", inside the 35-day limit on a whole run.

**Where the plan provides no environments, or no required reviewers,** see [§13](#13-the-fallback-where-the-plan-has-no-environments).

## 5. Credentials: OIDC bound to the environment

**The subject.** GitHub's OIDC reference: when a job references an environment, the subject is `repo:ORG-NAME/REPO-NAME:environment:ENVIRONMENT-NAME`, and "the environment specification takes precedence": the branch or tag is no longer in it. So a role whose trust condition is `StringEquals` on `token.actions.githubusercontent.com:sub` = `<prefix>:environment:production` and on `…:aud` = `sts.amazonaws.com` (AWS's GitHub example) can be assumed only by a job that references `production`, and that job runs only after its protection rules pass. **Three consequences:**
- **No pull request can reach it:** a pull request's token says `:pull_request`, and the deployment branch policy refuses the ref anyway.
- **The deploy jobs can't reach the QA store or the telemetry writer,** whose roles trust the default branch's ref subject (`docs/qa-store.md`, `docs/telemetry.md`, "an environment replaces the ref in the token's subject"). The binding works both ways.
- **The reusable workflow sets the environment.** GitHub: "To use an environment secret in a reusable workflow, set `environment` on the job in the reusable workflow. The job that calls the reusable workflow can't use the `environment` keyword." The subject is still the caller's repository (plan 0008 §4.1: in a reusable workflow, `repository` and `ref` describe the caller); that the environment is the called job's is measured in D0.

**The prefix** is what GitHub's API reports for the repository, classic or immutable, read by `scripts/lib/oidc-subject.mjs`, Kanon's one home for it (kanon#295). Kanon's own repository issues the immutable form ([§1](#1-today-measured)). GitHub's reference shows the immutable form only with a ref (`repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:…`); its environment form is measured in D0. A **custom subject template** (`use_default: false`) may leave the environment out of the subject entirely; doctor reports it ([§12](#12-doctors-checks)).

**AWS enforces part of this, and recommends the rest.** IAM's documentation: when GitHub's provider is the trusted principal, IAM rejects a trust policy whose `token.actions.githubusercontent.com:sub` condition is missing, null, or only a wildcard. It also says: "If you use GitHub environments in action workflows or in OIDC policies, we strongly recommend adding protection rules to the environment … Use deployment branches and tags to restrict which branches and tags can deploy to the environment." The lane is that recommendation as a mechanism.

**The trust probe** (decision 6). Kanon can't read an adopter's cloud trust policy, and doctor holds no cloud credential. So the lane proves the binding the only way GitHub allows: a `probe` job, **without** an environment and with `id-token: write`, calls the deploy hook with `probe: 'true'` before staging. The hook must try to obtain each environment's credential exactly as it would deploy, and **succeed only if it is refused**. It prints one line for doctor, `kanon-deploy-probe/v1 {"staging":"refused","production":"refused"}`, as `apps-check` prints its line for doctor (`docs/doctor.md`, "A private App"). A credential obtained outside the environment fails the run before anything deploys (`trust-unbound`). The probe proves only that a job outside the environment is refused; that a job inside it is admitted is the deploy itself.

**Kanon's AWS implementation** of the credential step (the hooks' first step, not the lane's) is `aws-actions/configure-aws-credentials` with the role from the environment's variables, as Kanon's QA store's action is the first implementation behind its contract (`K-OBS-17`). The lane names no cloud.

## 6. Concurrency

Each environment job declares:

```yaml
concurrency:
  group: kanon-deploy-${{ github.repository }}-staging   # and -production
  cancel-in-progress: false
  queue: max
```

GitHub's documentation, read 2026-10-14:
- **By default a newer pending run cancels the pending one:** "By default, any existing `pending` job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place." That is the default `queue: single`, "at most one … can be `pending`".
- **`queue: max`** keeps "up to 100 jobs or workflow runs" pending; "when the queue is full, any additional … are canceled", and it can't be combined with `cancel-in-progress: true`.
- **Order:** "first-in-first-out (FIFO) order according to the time each one started waiting", but "since the actual start time of a job or run may vary, ordering is not guaranteed." **That is why the gate's check 4 exists:** a release-triggered run never deploys a commit older than the environment's last success.

`cancel-in-progress: false` means a running deploy is never cancelled by a newer one. A deploy cancelled by a person, or by the run's limits, is recorded as `cancelled` ([§10](#10-the-deploy-row)), never as "not red" (`K-SHIP-8`'s reason). **Not documented:** whether a job waiting for a reviewer holds the group's slot. D0 measures it. Either answer is safe, since production's queue holds production only; it decides whether a second release waits behind an unapproved first one, which the run's summary then says.

## 7. The adopter's command and smoke check

**Two hooks at fixed paths** (decision 1), composite actions the adopter writes, like the project-setup hook (`docs/lanes.md`, "The project-setup hook"):

| Hook | Inputs, all strings | Must |
|---|---|---|
| `.github/actions/deploy/action.yml` | `environment` (`staging` or `production`), `release` (the tag), `sha`, `probe` (`'true'` or `'false'`) | Obtain the environment's cloud credential and deploy the checked-out commit; with `probe: 'true'`, only try to obtain each credential, and fail if it gets one ([§5](#5-credentials-oidc-bound-to-the-environment)) |
| `.github/actions/smoke/action.yml` | `environment`, `release` | Check the deployed system answers as the release expects, and fail otherwise |

**No outputs are read,** as for project-setup: the lane judges a hook only by whether it succeeded. **What the hooks receive** (decision 7): the job's environment variables, from the environment and the repository (`vars`), as `env:`; **no secrets** in this version. OIDC needs none, and a secret passed into a composite action is one more place a value can leak into a log. A deploy that needs a third-party secret is decision 7's question.

**Why hooks and not the stack document.** The issue's sketch says "declared once in the stack declaration like the test runner". The test runner works there because ADR 0012 gives Kanon a closed table of runners and the command per runner; the stack document only names one of them (`- `tests/` `vitest` — tests: …`). A deploy has no such table: CDK, CloudFormation, Terraform and SAM each take a different set of arguments per stack, and a free command in a markdown file would be a setting that a script then executes. A hook is the adopter's code at a fixed path, reviewed like any other: every file under `.github/` is on the pipeline's escalation path (`K-MERGE-4`), so a change to the deploy command always goes to a human. The stack document gains nothing; decision 1 weighs the two alternatives.

**K-AGENT-50.** The deploy job runs the adopter's code (the hook, and whatever build tool it calls) with a cloud credential. That is the one place a credential must meet code. What makes it acceptable is the code: the release's commit, on the default branch (gate check 2), reviewed and green (check 3). `K-AGENT-50`'s guard already names jobs that run the default branch's reviewed code as outside the rule; the deploy and probe jobs join that list by shape, and the guard holds them to: no secret referenced, no App token, `contents: read` and no other write, `persist-credentials: false`.

## 8. After a deploy

- **Every run writes its rows,** in a `record` job that runs `if: always()`, holds nothing but `actions: read`, reads the jobs' and steps' conclusions, and uploads one `deploy` row per environment the run reached as an artifact, `kanon-telemetry-deploy-<run id>-<attempt>` ([§10](#10-the-deploy-row)). The collector sends it, as it sends run rows (`K-OBS-13`).
- **A failure files one issue,** in a `report` job that runs on failure, with `issues: write` on the workflow token, no checkout and no cloud credential. One open issue per environment, found by a fixed title (`Deploy to production failed`) and updated with a comment on each later failure, closed by the next successful deploy to that environment. Labelled `bug`, and `sev:high` for production, `sev:medium` for staging (decision 10). Its body holds the release, the stage that failed and the run's link, never a log line. A refused gate files the same way, which is `K-SHIP-8`'s "announce a refusal".
- **No automatic rollback** (decision 10). A failed CloudFormation update already rolls back by itself, and its rollback triggers can watch alarms for up to 180 minutes after the resources deploy (AWS, "Roll back your CloudFormation stack on alarm breach"); that belongs in the adopter's stack. A rollback the lane would run is a second command, with its own failure. A person rolls back by dispatching the lane with an earlier release, which production's reviewer approves.
- **Announcement** (`K-SHIP-10`) stays out of this version ([Out of scope](#out-of-scope)).

## 9. No model in the deploy path

**`deploy.yml` runs no agent:** no `agent-run`, no `claude-code-action`, no Claude credential, no App key. A guard test holds it (D3), because the deploy path is where an instruction hidden in a release note, a commit message or a log would meet a cloud credential.

**The diagnose lane is optional, separate and read-only** (decision 13). `agent-deploy-diagnose.yml`, called on `workflow_run` of the deploy caller with `conclusion == failure`, runs as the Explorer App with `actions: read`, `contents: read` and `issues: write`, no `id-token`, no project-setup hook, and a shell allow-list that runs nothing from the tree, as the Lead's lanes do (`K-AGENT-50`'s last clause). It reads the failed run's log and the release's diff, and adds its diagnosis to the issue the `report` job filed. It never deploys, re-runs or dispatches anything. `workflow_run` runs the default branch's copy of the diagnose caller and "is able to access secrets and write tokens, even if the previous workflow was not" (GitHub's events page), so it adds no new path for the release's code to reach a token. A deploy log can hold resource names and account details, which the adoption record's `## Data` answer covers; the lane says so in its catalogue row.

## 10. The deploy row

A fourth row kind, `deploy`, version 1, in `actions/agent-telemetry/schema.mjs`, stored under `<key>#deploy`, a reserved partition like `work` and `finding` (decision 11). Every field is a number, a time, a boolean or a value from a closed list (ADR 0007, `K-OBS-16`):

| Field | Type | What |
|---|---|---|
| `schema_version`, `row_kind`, `tag`, `recorded_at` | as the run row | `row_kind: deploy` |
| `run_id`, `run_attempt` | as the run row | |
| `trigger` | `release` or `workflow_dispatch` | |
| `kanon_version` | as the run row | the lane's release |
| `environment` | `staging` or `production` | Kanon's two fixed names, so the field holds nothing of the adopter's |
| `outcome` | `ok`, `failed`, `smoke_failed`, `refused`, `rejected`, `cancelled` | `rejected`: a reviewer rejected, or the approval timed out |
| `failed_stage` | `gate`, `probe`, `approval`, `deploy`, `smoke` | absent when `ok` |
| `refusal` | the gate's codes (§3) and `trust-unbound` | only with `refused` |
| `prerelease`, `redeploy`, `rollback` | boolean | `redeploy`: this commit already succeeded in this environment; `rollback`: older than the environment's last success (a dispatch only, §3 check 4) |
| `wait_ms` | count | from the run's start to the environment job's start: queue and approval |
| `deploy_ms`, `smoke_ms`, `duration_ms` | count | the two hooks' steps, and the job |
| `since_release_ms` | count | from the release's `published_at` to the end of this deploy: the release's lead time to this environment |

**Never in it:** the commit, the tag, the version, a URL, the reviewer, the role or any name from the cloud. A tag or a commit would let anyone who can read the adopter's public repository say whose row it is, which the opaque key exists to prevent. The schema test fails on any field outside this list, as it does for the other kinds.

## 11. Metrics

Plan 0003 measures cost, efficiency and escapes; it defines **no deploy metric** (measured: nothing in plan 0003 names deployment frequency or change-failure rate). The deploy rows add four, as views in `scripts/metrics/views.mjs` beside plan 0003's, computed from `production` rows with `tag: run` (decision 12):

| Metric | Formula |
|---|---|
| **Deployment frequency** | production rows with `outcome: ok` and `rollback: false`, per week, as the median over the last 13 weeks |
| **Change-failure rate** | of production rows that reached the deploy stage (`ok`, `failed` at `deploy`, `smoke_failed`), the share that are `failed` or `smoke_failed`, or `ok` and followed by a `rollback` row before the next forward `ok` |
| **Time to restore** | from a failing production row to the next `ok` production row, median |
| **Release lead time** | `since_release_ms` of `ok` production rows, median |

**What they can't see:** a production fault found days later and fixed forward, with no rollback and no failed smoke. Plan 0003's explicit reverts and linked fixes see some of those on the work-item side; joining the two would need a commit on the row, which [§10](#10-the-deploy-row) refuses. The views say so in their notes. The hosted aggregate stores deploy rows from D6 and **publishes no cross-adopter deploy figure** until the Owner decides one (decision 11), under plan 0002's three-adopter rule.

## 12. Doctor's checks

In `cli/doctor.mjs`'s style: one id per finding, blocking or a note, a `fix` the person can run, `unchecked` with a reason when the token can't read it. They run only when a workflow calls `deploy.yml`. `requirements.json` gains a `deploy` entry (the hooks, the environments, the caller's grant), built from the lane by `tests/unit/requirements.test.ts`, so doctor reads the release's own copy.

| Id | Blocks | Holds when | Read from |
|---|---|---|---|
| `deploy.hook-missing` | yes | `.github/actions/deploy/action.yml` and `.github/actions/smoke/action.yml` exist, and declare the inputs [§7](#7-the-adopters-command-and-smoke-check) lists | the checkout |
| `deploy.releaser-missing` | yes | the release caller maps the Releaser's two secrets, so a release triggers the lane ([§3](#3-the-trigger)) | the checkout, and the secrets' names |
| `deploy.ci-push-missing` | yes | `ci.yml` runs on `push` to the default branch, which the gate waits for | the default branch's `ci.yml` |
| `deploy.environment-missing` | yes | `staging` and `production` exist | `GET repos/{o}/{r}/environments` |
| `deploy.reviewers-missing` | yes | `production` has a `required_reviewers` rule; on a plan without them, a note naming the fallback ([§13](#13-the-fallback-where-the-plan-has-no-environments)) | the same |
| `deploy.branch-policy` | yes | both environments restrict deployment refs (`deployment_branch_policy` not null) | the same |
| `deploy.self-review` | no | `production`'s reviewers rule prevents self-review | the same |
| `deploy.admin-bypass` | no | `can_admins_bypass` is false on `production` | the same (the field is in the answer, measured on Kanon's) |
| `deploy.subject-custom` | yes | the repository's subject template is the default (`use_default: true`), or a custom one that keeps `context`, so the environment is in the subject | `GET repos/{o}/{r}/actions/oidc/customization/sub` |
| `deploy.trust-unproven` | no, until the lane's first run; then yes | the latest completed run of the deploy caller printed `kanon-deploy-probe/v1` with both environments `refused` | the run's `probe` job log, as `app-permissions` reads `apps-check`'s line |
| `deploy.reference-undeclared` | no | the adoption record's reference deploy names `deploy.yml` and the staging job as the run lists it, or declares another on purpose | `scripts/lib/reference-deploy.mjs` |
| `deploy.tag-ruleset` | no | a ruleset restricts creating the release tags | `GET repos/{o}/{r}/rulesets` |

A caller of `deploy.yml` at the pinned release is a `kanon-lane` id-token holder, accepted as the store-coupled lanes are, once `tests/unit/id-token-guard.test.ts` holds the lane's `probe`, `staging` and `production` jobs to their exact shapes. `deploy.environment-missing`, `deploy.reviewers-missing` and `deploy.subject-custom` protect production, so they can't be waived (`docs/doctor.md`, "What can't be waived").

## 13. The fallback where the plan has no environments

[ADR 0013](../decisions/0013-personal-accounts-and-two-apps.md): "nothing in Kanon may require" environments. GitHub's documentation: required reviewers and wait timers are "only available for public repositories" on Free, Pro and Team, and environments exist for private repositories only on Pro, Team and Enterprise. `K-ADOPT-3`'s fallback for production approval already exists: "a manually triggered workflow that only the Maintainer may run" (`K-SHIP-9`).

**The fallback, as proposed** (decision 5):
- **No environment exists:** the jobs declare none, so the subject is the ref's. The roles trust the release tags' subject, `<prefix>:ref:refs/tags/<pattern>`, with `StringLike`. **Staging and production can't be told apart by the subject:** both run at a tag. So production runs only on `workflow_dispatch` at the release's tag (`--ref <tag>`), and the gate refuses unless `github.actor` is the Maintainer named in the adoption record. That check is the lane's code at the release's commit, not the platform's.
- **Environments exist but reviewers don't** (a private repository on Pro or Team): the environments and their subjects hold, and production's approval is the same Maintainer dispatch.
- **Doctor reports the fallback** as a note naming what is weaker: on the first form, any job running at a release tag with `id-token: write` can assume either role. The adoption record states it under `## Plan`, as `K-ADOPT-3` asks.

## 14. What the documentation says

### 14.1 Confirmed

Read on 2026-10-14.

| Fact | Where |
|---|---|
| `release` types include `published`, `released`, `prereleased`; subscribe to `published` for both; `GITHUB_SHA` is the release's last commit, `GITHUB_REF` its tag | docs.github.com, "Events that trigger workflows" |
| `GITHUB_TOKEN`-triggered events, but `workflow_dispatch` and `repository_dispatch`, create no runs | the same |
| `workflow_run` may use secrets and write tokens "even if the previous workflow was not"; no more than three levels | the same |
| A newer pending run cancels the pending one by default; `queue: max` keeps up to 100; FIFO, "ordering is not guaranteed"; `queue: max` can't combine with `cancel-in-progress: true` | "Workflow syntax", "Control workflow concurrency" |
| Protection rules pass before the job reaches a runner; environment secrets wait for approval; six reviewers, one approval; self-review prevention; wait timer 1 to 43,200 minutes; admin bypass option; deployment branches and tags | "Deployments and environments", "Workflow syntax" |
| Required reviewers and wait timers need a public repository on Free, Pro and Team; environments in private repositories need Pro, Team or Enterprise | "Deployments and environments", "Managing environments" |
| A job referencing an environment creates a deployment object | "Managing environments" |
| A reusable workflow's job sets `environment`; the caller's job can't | "Reuse workflows" |
| An environment job's subject is `repo:…:environment:<name>`, which replaces the ref; the immutable subject form exists | "OpenID Connect reference" |
| 30 days' wait on approvals; a run is cancelled at 35 days; a hosted job runs at most 6 hours | "Actions limits" |
| IAM rejects a GitHub trust without a `sub` condition, or with only a wildcard; AWS recommends environment protection rules and deployment branches and tags | docs.aws.amazon.com, "Create a role for OpenID Connect federation" |
| A CloudFormation service role's credentials are used for every operation on the stack; the caller needs `iam:PassRole`; it "is not possible to remove a service role attached to a stack"; grant least privilege | "CloudFormation service role" |
| Rollback triggers watch up to five alarms for up to 180 minutes | "Roll back your CloudFormation stack on alarm breach" |
| `cloudformation deploy` exits 0 on an empty change set unless `--fail-on-empty-changeset`; `--role-arn` is the role CloudFormation assumes | AWS CLI 2.36.8, `aws cloudformation deploy help` |

### 14.2 Not confirmed, and how each is handled

D0 measures each one in a sandbox repository before D3 relies on it.
- **The immutable subject with an environment:** the reference shows the immutable form only with a ref. D0 records a token's `sub` from an environment job in a repository created after 2026-07-15.
- **The environment job inside a reusable workflow:** that its `sub` is the caller's repository with the called job's environment. D0 records it.
- **Whether a job waiting for approval holds its concurrency group,** and how `queue: max` orders a waiting production job behind a second release ([§6](#6-concurrency)).
- **How a rejected approval, and a 30-day timeout, conclude the job,** so `record` can tell `rejected` from `failed`.
- **The job name a run of the caller lists** for a called workflow's job (expected `<caller job> / <called job>`), which the reference deploy declaration must match exactly (`K-LAYOUT-10`).
- **Self-review with a Releaser-triggered run:** the run's actor is the Releaser App, so the Owner can approve with self-review prevented; a dispatch the Owner starts can't be approved by the Owner. D0 records both.

## 15. Dogfood: Kanon's telemetry stack

**What moves.** Kanon gets a caller, `.github/workflows/deploy-telemetry.yml` (Kanon's own lanes live at the lane's file name in Kanon's tree, so its callers take another, as `telemetry.yml` calls `telemetry-collect.yml`; `K-LAYOUT-18`), and two hooks:
- **`.github/actions/deploy`:** assume the environment's role; `aws cloudformation package` the template and function into the environment's artifacts bucket; `aws cloudformation deploy` with `--role-arn` (the service role), `--capabilities CAPABILITY_NAMED_IAM` and the parameters from the environment's variables; a fresh `CursorKey` from `openssl rand -hex 32`, masked before it is used and never stored, which is what `docs/telemetry.md` already asks for on every deploy. In probe mode, only `sts:AssumeRoleWithWebIdentity` for each role, expecting `AccessDenied`.
- **`.github/actions/smoke`:** the stack is `UPDATE_COMPLETE` or `CREATE_COMPLETE`; a request with no `Authorization` gets 401 `token`; and plan 0008 §13's minted-token refusals (wrong audience 401 `aud`, the right audience from a job that isn't the collector 403 `workflow`), against the environment's URL and audience. All are refusals: the smoke writes no row and needs no Owner role.

**Preconditions.**
- **Plan 0008's J9.** Until it lands, the deploy renders from the private register, which must never be in a repository where Kanon's lanes run. After J9 the template has no per-adopter resource and deploys with parameters alone.
- **Plan 0008's J5,** the `v*` tag ruleset, so only the Releaser and the Owner create the tags the environments admit.
- **A staging account** (decision 14). The template names every resource and every IAM role, and IAM role names are unique per account, so a second stack can't share the production account. A second account in the same organisation, in Frankfurt, with the store's own audience, `kanon-telemetry-staging`, which plan 0008's decision 3 already foresees ("a future test store gets its own").

**What remains the Owner's, exactly.**

| Step | When | AWS write? |
|---|---|---|
| Create the staging account, and its $1 budget alert as the production account has | once | yes |
| Deploy `infra/deploy/aws-bootstrap.yaml` (D9) in each account with the Owner's profile: the deploy role trusting `<prefix>:environment:<name>`, the CloudFormation service role, the artifacts bucket, and the permissions boundary (decision 15); the OIDC provider only where none exists (`CreateOidcProvider`, as the store's template does). Any later change to it | once per account, and on change | yes |
| Request the Lambda concurrency quota in the staging account, as `docs/telemetry.md` step 4 does for production | once | yes (a quota request) |
| Create `staging` and `production` in Kanon's repository: production's reviewer the Owner, self-review prevented, admin bypass off, both restricted to `v*`, `candidate-v*` and `main`; set each environment's variables (the role ARN, the service role ARN, the bucket, `OwnerPrincipalArn`, `OperatorJobRoleArns`, `MinTokenVersion`, `ReservedConcurrency`); delete the unused `kanon-qa-store` environment | once | no |
| Approve each production deploy in GitHub | each stable release | no |
| `verify.mjs`, which needs `EnableVerify`, the Owner's own principal, and two deploys around it | after a release that changes the store's policies, as today | yes |
| `register.mjs`, `erase.mjs`, `import.mjs`, `backfill.mjs`, plan 0002's price checks | as today: they are data and accounts, not deploys | yes |
| A deploy by hand if GitHub Actions is down | break-glass | yes |

**What leaves the Owner's hands:** rendering, packaging, deploying, reading the outputs and the routine smoke, on every release that touches `infra/telemetry/`, and the ordering plan 0008 relies on ("deploy intake first, then the lanes' release"), which the lane now gives by construction: the store deploys when the release is published, and pins move to it later.

**What the deploy role can't do,** because the bootstrap stack is outside its reach: the GitHub-assumed role may create and execute change sets on `kanon-telemetry` alone, pass the service role alone, and write to the artifacts bucket alone. The service role may manage resources named `kanon-telemetry*`, and may create IAM roles only with the boundary attached, so a change to the template can't mint a role that escapes it (decision 15). The bootstrap stack's resources are named `kanon-deploy-*`, outside both patterns, so no CI run can widen its own trust. `infra/deploy/verify.mjs` (D9) checks that with `iam simulate-principal-policy`, run by the Owner. Plan 0008's J9 check, "no role in the store's template trusts GitHub's OIDC provider", still holds: the deploy role lives in the bootstrap template.

**Kanon declares no reference environment for it** (decision 16): the telemetry stack is not Kanon's product, so verifying a project's acceptance criteria "at the ref deployed there" (`K-PROJ-11`) would verify the wrong thing. The adoption record's mechanism row for `K-SHIP-8` to `K-SHIP-10` becomes installed for the telemetry stack only, and says so.

## 16. Security posture, stated plainly

- **Who can start a deploy:** whoever can publish a release (write access), and the Releaser. **What they can deploy:** a commit on the default branch with green CI. **Where:** staging at once; production only after a reviewer approves.
- **What the cloud credential can meet:** the release's own code, the hooks at the release's commit, and the actions they call. The job holds no App key, no App token, and a read-only workflow token. A compromised deploy command can damage the cloud account the role reaches; it can't push code, approve pull requests or move tags.
- **What a change to the deploy needs:** a human's approval of the pull request (every file under `.github/` escalates, `K-MERGE-4`), then a release, then, for production, a reviewer.
- **What is weaker, and where:** admin bypass is on by default (doctor's note); the fallback of [§13](#13-the-fallback-where-the-plan-has-no-environments) moves the staging/production split from the platform into the lane's code; the trust probe proves refusal outside the environment, not least privilege inside it.

## 17. Rules and docs that change

| Where | Change | Step |
|---|---|---|
| `K-SHIP-12`, new: "A deploy runs no model, and holds its cloud credential only in an environment's job" | Rule, why, enforced by the D3 guards; `RULE_IDS` gains `K-SHIP-12` | D1 |
| `K-SHIP-7`, `K-SHIP-8`, `K-SHIP-9`, `K-SHIP-10` | "Enforced by" names `deploy.yml` and its gate; `K-SHIP-10` still prose | D1 |
| `K-AGENT-50` | Its guard's list of jobs that run the default branch's reviewed code gains the deploy lane's `probe`, `staging` and `production` | D3 |
| `K-LAYOUT-1` | The two hooks' paths | D1 |
| `K-LAYOUT-10` | The reference deploy example names `deploy.yml` and the job as D0 measures it | D1 |
| `K-OBS-16`, ADR 0007 | A deploy row's allowed groups ([§10](#10-the-deploy-row)); ADR 0007 amended, as for the work-item and finding rows | D1, after decision 11 |
| `K-ADOPT-3` | The deploy fallback's line ([§13](#13-the-fallback-where-the-plan-has-no-environments)) | D1 |
| `docs/lanes.md`, `docs/lanes.json` | The lane, its caller, its hooks, its catalogue row | D3 |
| `docs/doctor.md` | [§12](#12-doctors-checks)'s rows | D4 |
| `docs/init.md`, `docs/install.md`, `README.md`, `docs/architecture.md` | The deploy lane as an opt-in, outside the three features | D5 |
| `skills/doctor`, `skills/upgrade` | Doctor's new rows; an upgrade that adds the lane says nothing changes until a caller exists | D5 |
| `docs/telemetry.md` | The deploy row in the ingest function; then "Deploy" rewritten as the lane, with the Owner's steps of [§15](#15-dogfood-kanons-telemetry-stack) | D6, D10 |
| `docs/metrics.md`, plan 0003 | The four deploy views | D7 |
| Kanon's adoption record | The caller's id-token holder bullets; the mechanism row; no reference environment | D10 |

## 18. Order of moves

**Touches** names each step's files, to show which steps may run at once.

| Step | Where | What | Touches | What must be true | Mutation |
|---|---|---|---|---|---|
| **D0** | a sandbox repository, by a maintainer | **The probes** of [§14.2](#142-not-confirmed-and-how-each-is-handled), with a throwaway reusable workflow that prints its token's claims (never the token) and two environments | none in Kanon; results in D0's issue | Each of §14.2's six answers is recorded, with the run's link. If the environment is not in a reusable workflow's subject, or the immutable form with an environment differs from §5's, D1 is amended before D3 | — (a measurement) |
| **D1** | Kanon | **The rules and the record** ([§17](#17-rules-and-docs-that-change)) | `rulebook/06-shipping.md`, `rulebook/10-adoption.md`, `rulebook/11-repository-layout.md`, `rulebook/08-observability-and-cost.md`, `docs/decisions/0007-data-boundary.md`, `actions/agent-telemetry/schema.mjs` (`RULE_IDS` only) | `tests/unit/rulebook-why.test.ts` and the rulebook's guards pass; `telemetry-schema.test.ts` holds `RULE_IDS` to the headings | removing `K-SHIP-12`'s heading turns `telemetry-schema.test.ts` red |
| **D2** | Kanon | **The deploy row** ([§10](#10-the-deploy-row)): its fields, `DEPLOY_STAGES`, `DEPLOY_OUTCOMES`, `DEPLOY_REFUSALS`, the reserved `deploy` partition | `actions/agent-telemetry/schema.mjs`, `tests/unit/telemetry-schema.test.ts` | a valid row validates; a row with a `sha`, `tag` or `url` field is rejected naming the field; `refusal` without `refused`, or `failed_stage` with `ok`, is rejected; no lane may be named `deploy` | dropping the outcome–refusal pairing turns its test red; adding `deploy` to `LANES` turns the reserved-partition test red |
| **D3** | Kanon, **a release** | **The lane:** `.github/workflows/deploy.yml` (gate, probe, staging, production, record, report), `scripts/deploy-gate.mjs`, `scripts/deploy-row.mjs`, `scripts/deploy-report.mjs`; `requirements.json`'s `deploy` entry | those files; `docs/lanes.md`, `docs/lanes.json`; `tests/unit/deploy-lane.test.ts` (new), `deploy-gate.test.ts` (new), `id-token-guard.test.ts`, `pr-code-token-isolation.test.ts`, `app-key-isolation.test.ts`, `requirements.test.ts`, `lanes-doc.test.ts` | The gate refuses each code of §3 on fixtures (a draft, a commit off the default branch, a red and a running CI, an older commit on a release trigger) and admits a dispatch rollback with `rollback: true`. The lane test: exactly two environment names; each environment job has `cancel-in-progress: false` and `queue: max`; `production` needs `staging` and is skipped for a pre-release; no job references `agent-run`, `claude-code-action`, a `CLAUDE_*`, `ANTHROPIC_*` or `*_PRIVATE_KEY` secret; only `probe`, `staging` and `production` hold `id-token: write`; the `report` job alone holds `issues: write` and checks nothing out; every checkout sets `persist-credentials: false`. `deploy-row.mjs` writes one valid row per environment reached, for each job conclusion | the gate without check 2 admits a commit off the default branch; `cancel-in-progress: true` on `production`; `queue` removed; `id-token: write` on `record`; an `agent-run` step in `report`; `production` without `needs: staging`: each turns its named test red |
| **D4** | Kanon | **Doctor's checks** ([§12](#12-doctors-checks)) | `cli/doctor.mjs`, `docs/doctor.md`, `tests/unit/kanon-doctor-deploy.test.ts` (new) | each id is reported on a stubbed GitHub answer and quiet on a healthy one; `unchecked` with its reason when the environments or the subject customization can't be read; the probe line is read only from a completed run of the default branch's caller, as `apps-check`'s is | `deploy.reviewers-missing` made a note; the probe line accepted from a branch run; the waiver list admitting `deploy.subject-custom`: each turns its test red |
| **D5** | Kanon | **`kanon init --deploy`** writes the caller and two hook stubs that fail by name until filled; the docs and skills of §17 | `cli/init.mjs` and its test, `docs/init.md`, `docs/install.md`, `README.md`, `docs/architecture.md`, `skills/doctor`, `skills/upgrade` | `kanon-init.test.ts`: the caller maps no secret and grants exactly the lane's permissions; the stubs exit non-zero naming the file; nothing is written without `--deploy`. The adopt skill asks no new question (the install questions are fixed) | a stub that exits 0 turns the test red |
| **D6** | Kanon | **The store takes the row:** the collector sends `kanon-telemetry-deploy-*` artifacts; the ingest function stores `row_kind: deploy` under `<key>#deploy` on both paths; the erasure walk includes it; the aggregate's projection excludes it | `scripts/telemetry-collect.mjs`, `infra/telemetry/function/rows.mjs`, `function/token.mjs`, `infra/telemetry/erase.mjs`, `docs/telemetry.md`, `tests/unit/telemetry-collect-lane.test.ts`, `telemetry-ingest.test.ts`, `telemetry-endpoints.test.ts` | a deploy row lands in `<key>#deploy`; an erasure leaves the partition empty; the aggregate's `Query` projection names no deploy field. **Deploy order:** the store's intake ships before the release whose lane writes the row, as `docs/telemetry.md` already requires for row changes | an erasure walk that skips `deploy` fails the erasure test |
| **D7** | Kanon | **The metrics** ([§11](#11-metrics)) | `scripts/metrics/views.mjs`, `scripts/metrics/indicators.mjs`, `docs/metrics.md`, `tests/unit/metrics-views.test.ts`, plan 0003 §4 | on fixture rows: frequency counts only production `ok` non-rollback rows; a rollback after an `ok` row counts that row as a failure; staging rows count nowhere | counting staging rows in the frequency turns its test red |
| **D8** | Kanon, **after decision 13** | **The diagnose lane** ([§9](#9-no-model-in-the-deploy-path)) | `.github/workflows/agent-deploy-diagnose.yml`, its prompt, `docs/lanes.md`, `docs/lanes.json`, `requirements.json`, `tests/unit/lead-shell.test.ts` | it holds no `id-token`, runs no hook, dispatches nothing; its allow-list runs nothing from the tree; it comments only on the `report` job's issue | `id-token: write` on its agent job, or `gh workflow run` in its allow-list, turns its test red |
| **D9** | Kanon, then **the Owner** | **The bootstrap template** `infra/deploy/aws-bootstrap.yaml` and `infra/deploy/verify.mjs` ([§15](#15-dogfood-kanons-telemetry-stack)); then the Owner deploys it in each account | those files, `tests/unit/deploy-bootstrap-template.test.ts` (new), `docs/telemetry.md` | the template test: the deploy role's trust is exactly one `StringEquals` `sub` naming an environment, plus `aud`; its policy allows change sets on `kanon-telemetry` only and `iam:PassRole` on the service role only; the service role's `iam:CreateRole` requires the boundary; no resource is named `kanon-telemetry*`. After the Owner's deploy, `verify.mjs` reports PASS for: a session without the environment refused (by the probe), the deploy role denied `iam:UpdateAssumeRolePolicy` on itself, the service role denied `iam:CreateRole` without the boundary | a trust with `StringLike` or a `ref` subject, or `iam:PassRole` on `*`, turns the template test red |
| **D10** | Kanon, **after plan 0008's J9 and J5** | **Kanon's caller and hooks,** the record's bullets, and the Owner's GitHub steps of §15 | `.github/workflows/deploy-telemetry.yml`, `.github/actions/deploy/action.yml`, `.github/actions/smoke/action.yml`, `docs/qa/adoption.md`, `docs/telemetry.md` | `lane-check` and doctor pass on Kanon with no waiver for a `deploy.*` id; `id-token-guard.test.ts` holds the caller | the caller's `production` job given a second environment name turns `deploy-lane.test.ts` red |
| **D11** | Kanon, live | **The first deploys:** the next release that touches `infra/telemetry/` | none | staging deploys and smokes green; production waits for the Owner, then deploys and smokes green; the probe line says `refused` twice; two `deploy` rows reach the store; a release published on a tag whose commit is off `main` (in the sandbox of D0, never on Kanon) is refused at the gate. Then `docs/telemetry.md`'s manual deploy becomes the break-glass section | — (live) |

**Why this order.**
- **Probes first:** six behaviours the lane rests on are not in GitHub's documentation, and one of them (the environment in a reusable workflow's subject) decides whether the design holds at all.
- **The row before the lane,** so the lane's first release already writes a valid row; **the store's intake before the release that writes it** (D6), as `docs/telemetry.md` requires of every row change.
- **Doctor right after the lane,** so the first adopter to call it is told what is missing before its first red run.
- **The dogfood last:** it needs plan 0008's J9, and it should run the lane as a released adopter would.

## 19. Cost

- **Actions minutes:** a gate that polls CI for up to 90 minutes is the largest part; on a public repository the minutes are free, on a private one a release waits about as long as its CI, so the gate costs about one CI run's wall time in minutes. The deploy jobs cost what the adopter's command costs.
- **The model:** nothing, until D8; then one Explorer run per failed deploy.
- **Kanon's staging account:** an idle copy of the store, on-demand DynamoDB with no traffic, two functions that run only for the smoke, a few kilobytes in S3, a log group. A few cents a month by the shape of plan 0002's estimate; **not run against the price list.** It is a new cloud cost, so it needs the Owner's yes first (`rulebook/08-observability-and-cost.md`, cost changes), which decision 14 asks for.

## Out of scope

- **Announcing a deploy** (`K-SHIP-10`). `scripts/announce-deploy.mjs` exists, from the reference adopter; wiring it into the lane is a step of its own, after this one.
- **Fleets:** many production environments are the adopter's hook's business ([ADR 0008 §4](../decisions/0008-installation-test-decisions.md)).
- **Clouds other than AWS** for Kanon's own implementation and the dogfood. The lane names no cloud; the hooks do.
- **Automatic rollback** by the lane ([§8](#8-after-a-deploy)).
- **Building once and promoting the artifact** (decision 8).
- **Publishing cross-adopter deploy figures** (decision 11).

## Decisions for the Owner

1. **How the adopter declares its command.** (a) Two composite-action hooks at fixed paths, `.github/actions/deploy` and `.github/actions/smoke`; (b) a `## Deploy` section in the stack document holding a command the lane executes; (c) a closed table of tools in Kanon, as ADR 0012 has for test runners. **Recommended: (a).** It is how the adopter already keeps its toolchain (project-setup), the command is reviewed code on an escalation path, and nothing executes text from a markdown file. (b) is a setting a script runs; (c) needs a row per tool and per argument shape and still can't cover them. [§7](#7-the-adopters-command-and-smoke-check).
2. **Environment names.** Fixed, `staging` and `production`, or declared in the adoption record. **Recommended: fixed** (ADR 0002); an adopter with `prod` renames or creates one. [§4](#4-environments-staging-then-production-on-one-commit).
3. **The trigger.** (a) `release: published`, which needs the Releaser, since a release made with the workflow token starts no run; (b) a job chained after `release.yml` in the push run, which needs no Releaser but runs on `main`'s ref and ties the deploy to the release workflow. **Recommended: (a),** with doctor's `deploy.releaser-missing`; the Releaser is already what lets CI run on the release pull request. [§3](#3-the-trigger).
4. **Pre-releases reach staging only.** **Recommended: yes.** It is also what makes Kanon's candidate and stable releases (plan 0009) map onto staging and production. [§4](#4-environments-staging-then-production-on-one-commit).
5. **Plans without environments or reviewers.** (a) The fallback of §13, weaker and said so; (b) the lane refuses to run there. **Recommended: (a),** since ADR 0013 says nothing may require environments and `K-SHIP-9` already has the Maintainer-dispatch fallback. [§13](#13-the-fallback-where-the-plan-has-no-environments).
6. **The trust probe on every run,** failing the run when a credential is obtained outside the environment, and read by doctor. **Recommended: yes.** It is the only way Kanon can see a trust policy it can't read. [§5](#5-credentials-oidc-bound-to-the-environment).
7. **What the hooks receive.** The environment's and repository's variables only, no secrets, in this version. **Recommended: yes;** a hook that needs a third-party secret is a later decision, with a fixed secret name rather than `toJSON(secrets)`, which would also blind doctor's stale-secret check. [§7](#7-the-adopters-command-and-smoke-check).
8. **Same commit, not yet the same artifact.** **Recommended: same commit in this version;** a build job without credentials, whose artifact both environments deploy, is a later step once one adopter needs it. [§4](#4-environments-staging-then-production-on-one-commit).
9. **The CI wait:** the gate polls the release commit's CI for up to a fixed 90 minutes, then refuses with `ci-timeout`. **Recommended: yes,** 90 minutes fixed, not a setting. [§3](#3-the-trigger).
10. **On failure:** one deduplicated issue per environment, `bug` with `sev:high` for production and `sev:medium` for staging, closed by the next success; no automatic rollback. **Recommended: yes.** [§8](#8-after-a-deploy).
11. **The deploy row:** a fourth row kind with §10's fields, no commit, tag or version; `K-OBS-16` and ADR 0007 amended; stored in the hosted store and never published across adopters until you decide a figure. **Recommended: yes.** [§10](#10-the-deploy-row).
12. **The metrics' definitions,** as §11 states them, change-failure rate counting rollbacks. **Recommended: yes,** with the stated blind spot for faults fixed forward. [§11](#11-metrics).
13. **The diagnose lane:** build it (D8) after four weeks of deploy rows show failures it would have read, opt-in, the Explorer App, read-only. **Recommended: defer to then.** [§9](#9-no-model-in-the-deploy-path).
14. **Kanon's staging:** (a) a second AWS account, same region, its own audience, at a few cents a month (needs your yes on the cost); (b) a name-suffix parameter on the template, so staging shares the production account, which changes every resource name and the store's lifecycle tests; (c) no staging for Kanon, which breaks the lane's own rule. **Recommended: (a).** [§15](#15-dogfood-kanons-telemetry-stack).
15. **A permissions boundary** on every role the telemetry stack creates, required by the service role, so the template can't mint a role that escapes it. It adds `PermissionsBoundary` to the template's roles. **Recommended: yes.** [§15](#15-dogfood-kanons-telemetry-stack).
16. **Kanon declares no reference environment for the telemetry stack.** **Recommended: yes;** the stack is not Kanon's product. [§15](#15-dogfood-kanons-telemetry-stack).
17. **Kanon's production environment:** you as the one reviewer, self-review prevented, admin bypass off. **Recommended: yes,** if D0 confirms that a Releaser-triggered run lets you approve with self-review prevented; otherwise self-review stays allowed, and the record says why. [§15](#15-dogfood-kanons-telemetry-stack).
18. **Re-deploys by dispatch** of an existing release, including an older one as a rollback, with production behind its reviewer and the row marked `rollback`. **Recommended: yes.** [§3](#3-the-trigger).
