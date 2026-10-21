# Plan 0013: the smoke lifecycle, outside a deploy, one run per environment at a time

- **Status:** decided 2026-10-20. **S0, the probes, is done except items 9, 10 and 11** (2026-10-20, [#1166's results](https://github.com/yedeya-labs/kanon/issues/1166#issuecomment-6299720674)): items 1, 2, 3, 4, 5 and 8 hold, item 6 is answered yes (`deployment: false`), and item 7 measured `error`; [§12](#12-what-is-not-confirmed-and-how-each-is-probed) records each answer with its run. S1, the rules, S2, the rows, S3, the store taking them, and **S4, "live, smoke failed" and the reset hook in the existing lane**, were built on 2026-10-20; S5 to S10 are not built. It answers [#1147](https://github.com/yedeya-labs/kanon/issues/1147), which asks for four things the deploy lane lacks once an adopter's smoke check writes real data: smoke runs outside a deploy, one smoke run per environment at a time across every trigger, a reset hook before the smoke hook, and "live, smoke failed" as an outcome of its own. The draft asked the Owner thirteen questions. The Owner answered all thirteen on 2026-10-20, each as the draft recommended ([Owner decisions (2026-10-20)](#owner-decisions-2026-10-20)). **S0 and S4 come first:** the probes, then "live, smoke failed" in the existing lane. **S5 to S10 wait** until the adopter's own smoke runs outside a deploy have run for a few weeks, and what they teach is folded in here first (decision 1). `K-SHIP-13` is added (decision 9). **Amended 2026-10-21** for two more Owner decisions, on a scheduled run that finds no caller and on how `via` reaches `declare` ([Owner decisions (2026-10-21)](#owner-decisions-2026-10-21)).
- **Tracks:** [#1147](https://github.com/yedeya-labs/kanon/issues/1147). **Builds on:** [plan 0010](0010-deployment-lane.md) (the deploy lane: its hooks in §7, its concurrency in §6, what runs after a deploy in §8, the `deploy` row in §10, doctor's checks in §12), [plan 0011](0011-notifications.md) (the `deploy` message kind and its secret, `KANON_CHAT_DEPLOY`) and [plan 0012](0012-end-to-end-tests.md) (the harness's `deploy-rehearsal` scenario, which a new scenario extends). **Amends, once built:** plan 0010 §7 (a fourth hook and a smoke secret), §8 (a smoke failure no longer fails the deploy job) and §10 (the row's `reset` stage), and plan 0011 §3.2 (what a `smoke_failed` announcement says). **Offloads:** the end-to-end scenario, to the harness repository as an issue (S10). **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), [ADR 0007](../decisions/0007-data-boundary.md), `K-SHIP-9`, `K-SHIP-10`, `K-SHIP-12`, `K-AGENT-47`, `K-AGENT-50`, `K-OBS-16` and `K-PRIN-11` (every guard can fail, and is mutation-checked).
- **Measured on** Kanon's `origin/main` at `6d9edec4`: `.github/workflows/deploy.yml`, `.github/workflows/deploy-release.yml`, `.github/workflows/agent-deploy-diagnose.yml`, `scripts/deploy-row.mjs`, `scripts/deploy-report.mjs`, `scripts/announce-deploy.mjs`, `scripts/deploy-gate.mjs`, `scripts/lib/deploy-declaration.mjs`, `actions/agent-telemetry/schema.mjs`, `cli/init.mjs` (`deployCallerFile` and the hook stubs), `cli/doctor.mjs` (`deploy.hook-missing`), `requirements.json` (`deploy`), `rulebook/06-shipping.md` (`K-SHIP-7` to `K-SHIP-12`), `rulebook/agent-permissions.json`, `docs/lanes.md` ("The deploy lane"), `docs/notifications.md` ("The deploy announcement"), and plans 0010, 0011 and 0012. The two `actions/agent-telemetry/schema.mjs` coordinates [§2](#2-today-measured) cites, for `DEPLOY_OUTCOMES` and `DEPLOY_STAGES`, were read later than the rest: not at `6d9edec4`, but on `origin/main` at `742badd1` (2026-10-21). The last change to move them was #1195's (`48ca7110`); #1155, S2 and S3 had moved them before, and nothing has since. The issue was read on 2026-10-20 with its one comment. **GitHub's documentation was not read for this draft.** What the plan says GitHub does is quoted from plan 0010 §6 and §3, which read it on 2026-10-14, or is listed in [§12](#12-what-is-not-confirmed-and-how-each-is-probed) to be probed. No probe has run.

## The plan in one paragraph

**Today.** The deploy lane runs the adopter's smoke hook in one place: inside `deploy.yml`'s `deploy` job, as its last step, right after the deploy hook. Nothing else runs it. A smoke failure fails that job. So GitHub marks the deployment failed, the next environment doesn't start, and the row says `smoke_failed` at the `smoke` stage. The issue it files is titled "Deploy to `<environment>` failed". The announcement says the release "failed its smoke check", at `critical` on production, but not that the release is live, and it lists none of the release's changes. That is fine for a smoke check that only reads. It is not enough for one that writes real data, because that data needs a reset before each run, a run needs to happen between deploys too, and two runs must never overlap.

**Where it ends.**
- **A second reusable workflow, `deploy-smoke.yml`,** runs the smoke check outside a deploy. A caller of its own, `.github/workflows/smoke.yml`, written by `kanon init`, starts it in two ways. **On demand:** a person dispatches it at the environment's live release, and the job that smokes references the environment, so its protection rules apply. **On a schedule:** an optional cron per environment, declared in the adoption record. The scheduled run dispatches the on-demand path at the live release, so both paths are one.
- **One smoke or deploy per environment at a time, across every trigger.** Every job that resets or smokes an environment joins the deploy job's concurrency group, with `queue: max`. A waiting smoke run then queues behind a deploy, or a deploy behind it. Nothing pending is cancelled.
- **A reset hook,** `.github/actions/smoke-reset`, optional, runs in the same job as the smoke hook, just before it, with the same credential.
- **"Live, smoke failed" is its own outcome.** Once the deploy hook succeeds, the deploy job succeeds, so GitHub marks the release deployed. The smoke result is read from the step, and a small `verdict` job fails the call so the chain still stops. The announcement says the release is live and flags the failed smoke. A smoke issue of its own is filed. Nothing rolls back.
- **A failed scheduled or on-demand run files the same smoke issue and posts the same alert,** so the diagnose lane covers it too.

**How it gets there.** Probes first, in the sandbox, because the design rests on platform behaviours nobody has measured, eleven of them listed in §12, two of which (items 1 and 2) decide whether it holds as drawn. Then the "live, smoke failed" outcome in the existing lane, which an adopter is waiting for and which stands on its own. Those two come first. The smoke workflow, its caller, doctor's checks and the diagnose lane's reach wait until the adopter's own smoke runs outside a deploy have run for a few weeks (decision 1), then ship in one release, followed by a rehearsal and an end-to-end scenario.

## 1. The problem

A smoke check that only reads the deployed system can run at any time, any number of times at once, and leaves nothing behind. An adopter's smoke check that writes real data cannot. The issue describes one: it signs a fake tenant up on production, takes a sandbox payment, sends a sandbox email and checks the results. Four things follow.

1. **It needs to run between deploys.** A production system breaks without a deploy: a provider changes, a certificate expires, data drifts. The adopter wants to run the check on demand, behind the environment's protection, and on a schedule, nightly on pre-production and never on production.
2. **Two runs must never overlap.** Each run resets the shared fixtures first. A second run that starts while the first is mid-check wipes the first's data, and both fail for no fault of the release. That holds across every trigger: the deploy's own smoke step, an on-demand run and a scheduled run. A waiting smoke run must also never cancel a pending deploy.
3. **Each run must start from a known state.** That is a reset of the fake tenant or the fixtures, before the check, with the same credential.
4. **A failed smoke check after a deploy is not a failed deploy.** The release is live. Saying "deploy failed" misleads whoever reads it. Skipping the announcement hides a live release. The right report is: live, smoke failed; file or update an issue; alert at `critical` on production; never roll back by itself.

**What stays the adopter's** (the issue's own list): what the check exercises, the fake tenant and its exclusions, the payment and email sandboxes, and the reset's implementation. **Kanon owns** the triggers, the concurrency, the outcome model and the reporting.

## 2. Today, measured

| What | Where | What it means for this plan |
|---|---|---|
| The smoke hook runs only as the last step of the `deploy` job, after the deploy hook, with `environment`, `role` and `release` | `.github/workflows/deploy.yml`, the `deploy` job's `Smoke` step | No other trigger runs it. Nothing runs before it but the deploy |
| The `deploy` job holds one concurrency group per environment, `kanon-deploy-<repo>-<environment>`, `cancel-in-progress: false`, `queue: max` | `deploy.yml`, the `deploy` job's `concurrency` | The group already queues up to 100 pending jobs rather than one ([plan 0010 §6](0010-deployment-lane.md#6-concurrency)). The issue's "only one pending run" is GitHub's default, `queue: single`, which the lane doesn't use |
| A job waiting for a reviewer holds the group's slot (measured in plan 0010's D0) | [plan 0010 §6](0010-deployment-lane.md#6-concurrency), [#890](https://github.com/yedeya-labs/kanon/issues/890) | A smoke run in the same group waits behind an unapproved production deploy, and the reverse |
| The smoke step has no `continue-on-error`, so a smoke failure fails the `deploy` job | `deploy.yml`, the `Smoke` step | GitHub's deployment for that job is not `success` (assumed, §12 item 1). The next environment's call `needs:` this one, so it doesn't start |
| The deploy job exposes `deploy-outcome` and `smoke-outcome` | `deploy.yml`, the `deploy` job's `outputs` | The record can already tell the two apart |
| `classifyEnvironment` returns `smoke_failed` at stage `smoke` when the job failed and `smoke-outcome` is `failure`; a cancel after the deploy ended is `cancelled` at `smoke` | `classifyEnvironment` (`scripts/deploy-row.mjs:135-162`) | **The issue's "to verify first" holds for the row:** it tells a smoke failure from a deploy failure. The row's lists already hold both values: `DEPLOY_OUTCOMES` (`actions/agent-telemetry/schema.mjs:237`) and `DEPLOY_STAGES` (`actions/agent-telemetry/schema.mjs:243`) |
| `report` files `smoke_failed` like a failure, on the issue titled `Deploy to <environment> failed`, with the body "deployed, but its smoke check failed" | `scripts/deploy-report.mjs`: the outcomes that file, `FILES`; the body's words, `WHAT`; and the title, `issueTitle` (`scripts/deploy-report.mjs:47`) | **Half holds:** the body tells them apart, the title doesn't. The next successful deploy closes it; nothing else does |
| `announce` reads the record's outcome. For `smoke_failed` it writes a failure message, "`<version>` failed its smoke check on `<environment>`", `critical` on production, `warning` elsewhere | `deploy.yml`, the `announce` job's `OUTCOME`; the `FAILED` list, `failureSeverity` (`scripts/announce-deploy.mjs:212`), `buildFailureMessage` (`scripts/announce-deploy.mjs:221-244`) | **Half holds:** it isn't "Deploy to production failed", and it isn't skipped. But it doesn't say the release is live, and it lists none of the release's changes, which only the `ok` message does: `buildDeployMessage` (`scripts/announce-deploy.mjs:147`). The issue's comment says an adopter's own announcement script takes only stage, version and SHA; Kanon's already takes `OUTCOME` |
| The supersede check and the announcement's range read the environment's last deployment whose latest status is `success` | `supersede` in `scripts/deploy-gate.mjs`; `previousRelease` (`scripts/announce-deploy.mjs:290`) | A release that is live but failed its smoke check isn't "last success" today. So a dispatch back to the release before it isn't flagged `rollback`, and the next deploy's announcement lists the smoke-failed release again |
| The deploy hook's step alone receives `KANON_DEPLOY_SECRET`; the smoke step receives no secret, and a guard test fails if it does | `deploy.yml`, the `Deploy` step's `env:`; `tests/unit/deploy-lane.test.ts`, "the hooks get the inputs plan 0010 §7 lists, and the smoke hook never the secret" | A smoke check that needs anything beyond the job's OIDC credential has no way to get it |
| `requirements.json`'s `deploy` entry lists three hooks; the smoke hook's inputs are `environment`, `release`, `role` | `requirements.json` (`deploy.hooks`) | Doctor checks these three, as `deploy.hook-missing` in `cli/doctor.mjs`. No reset hook exists |
| `kanon init` writes the deploy caller from the declared list, with `release` and `workflow_dispatch` triggers only | `deployCallerFile` (`cli/init.mjs:2104-2146`) | No caller has a schedule, and the dispatch means "deploy this release again" |
| `init`'s smoke stub says only "Checks the deployed system answers as the release expects" | `DEPLOY_HOOK_DOES` (`cli/init.mjs:2203-2207`) | — |
| The diagnose lane finds the issues a failed run filed by the title `Deploy to <environment> failed` and runs on `workflow_run` of the deploy caller | `.github/workflows/agent-deploy-diagnose.yml`, its header and its `gate` job | A smoke issue with another title, or a run of another caller, isn't diagnosed until the lane learns both |
| The Judge App holds `actions: write` | `rulebook/agent-permissions.json`, the `judge` App's permissions | An agent's token can dispatch a workflow. A smoke dispatch must say who may start it (§11) |
| `K-SHIP-10` is "Announce each deploy once, and never confuse the two failures" (a failed announcement and a failed deploy) | `rulebook/06-shipping.md` | A third confusion, a failed smoke check read as a failed deploy, belongs in the same rule |

## 3. What Kanon owns and what the adopter keeps

The split of plan 0010 §2 holds: Kanon owns the governance, the adopter owns the command.

| Kanon owns | The adopter keeps |
|---|---|
| The smoke workflow, its caller, and its triggers: on demand and on a schedule ([§4](#4-smoke-outside-a-deploy)) | Which environments get a schedule, and the cron |
| One run per environment at a time, across the deploy and every smoke trigger ([§5](#5-one-run-per-environment-at-a-time)) | — |
| When the reset runs, with what, and what its failure means ([§6](#6-the-reset-hook)) | The reset itself, in `.github/actions/smoke-reset` |
| The outcome model: "live, smoke failed" apart from a failed deploy ([§7](#7-live-smoke-failed)) | — |
| The row, the issue, the announcement and the alert ([§7.2](#72-what-each-job-says), [§8](#8-telemetry)) | Where the alert goes, through its notify hook |
| Doctor's checks on all of it ([§9](#9-doctor-and-init)) | What the smoke check exercises, the fake tenant and its exclusions, the payment and email sandboxes |

## 4. Smoke outside a deploy

### 4.1 The caller and the workflow

A new reusable workflow in Kanon, `.github/workflows/deploy-smoke.yml`, and a new caller in the adopter's repository, `.github/workflows/smoke.yml`, which `kanon init` writes when the record declares a chain ([§9](#9-doctor-and-init)). The caller holds the triggers (`K-LAYOUT-18`):

```yaml
on:
  workflow_dispatch:
    inputs:
      environment: { type: string, required: true }   # a declared environment
      via: { type: string, required: false }          # set by the scheduler alone: its run's id
  schedule:
    - cron: '0 3 * * *'   # staging, from the record's Smoke schedule
jobs:
  smoke:
    uses: yedeya-labs/kanon/.github/workflows/deploy-smoke.yml@<the deploy caller's release>
    permissions: { actions: write, contents: read, deployments: read, id-token: write, issues: write }
    with:
      environments: 'staging production'
      environment: ${{ github.event.inputs.environment }}   # empty on a schedule, where route picks it
      via: ${{ github.event.inputs.via }}                   # empty unless the scheduler dispatched this run
    secrets:
      KANON_SMOKE_SECRET: ${{ secrets.KANON_SMOKE_SECRET }}
      KANON_CHAT_DEPLOY: ${{ secrets.KANON_CHAT_DEPLOY }}
```

The caller maps both dispatch inputs, `environment` and `via`, into `deploy-smoke.yml`'s inputs, and `declare` reads them only from there, never from `github.event`, so S5's `declare` and S6's caller test agree on one path (decision 15). **`deploy-smoke.yml` declares `via` as an optional `string` input,** `required: false`, beside `environments` and `environment`: GitHub refuses a call that passes an input the called workflow doesn't declare, and on a person's dispatch or a schedule `via` arrives empty. `declare` reads it through a step's `env:`, never in a `run:` line. **The guards allow the mapping.** `actions/lane-check`'s rule that a caller passes only its own input, as `${{ inputs.<name> }}` (ADR 0002), holds only the callers of `agent-*` lanes; `deploy-smoke.yml` isn't one, so its caller is held, as the deploy caller is, to the release pin and to mapping its secrets by name, never `secrets: inherit`. `tests/unit/workflows.test.ts`'s "no workflow interpolates github.event into a run line" reads `run:` lines, not a caller's `with:`, and the credential-reach guard (`tests/unit/helpers/credential-reach.ts`) follows a called workflow's inputs only for the credentials they carry, which `via` doesn't. So no guard objects, and S6 needs no exception; doctor's `deploy.smoke-caller-mismatch` holds the mapping ([§9](#9-doctor-and-init)). A separate caller, not two more triggers on the deploy caller (decision 2). The deploy caller's dispatch means "deploy this release again", its gate refuses any other dispatch, and doctor's `deploy.caller-mismatch` allows no other job in it.

`deploy-smoke.yml` has these jobs:

```
schedule run (default branch):   route → dispatch
dispatched run (at a release tag): route → declare → smoke (environment, shared group) → record → report → announce → notify
```

- **`route`**, `contents: read` and `actions: read`, no credential. On a schedule, it reads the record's `Smoke schedule` at the run's commit and matches `github.event.schedule` to one environment. On a dispatch, it passes the workflow's `environment` input through, which the caller maps from the dispatch's input.
- **`dispatch`**, scheduled runs only, `actions: write` and `deployments: read` alone. It finds the environment's live release ([§4.4](#44-which-release-a-smoke-run-checks)) and dispatches the same caller at that tag with `environment` and `via` set to its own run id. It dispatches nothing when a smoke run for that environment is already pending or running, and says so in the summary, so a stuck queue doesn't fill with one run a night. GitHub starts a run for a `workflow_dispatch` the workflow token makes, as plan 0010 §3 quotes: "With the exception of `workflow_dispatch` and `repository_dispatch`, other `GITHUB_TOKEN`-triggered events do not create workflow runs at all."
- **`declare`**, `contents: read`, `deployments: read`, `actions: read`, no credential. It refuses, by code, before any reviewer is asked:

| # | Check | Refusal |
|---|---|---|
| 1 | The run is at a release tag, `GITHUB_REF` = `refs/tags/<tag>`, and the release exists and isn't a draft | `no-release` |
| 2 | The environment is in the record's `## Deploy` list at the tag's commit, and the caller's `environments` input is that list | `declaration-mismatch` |
| 3 | The tag is the environment's live release ([§4.4](#44-which-release-a-smoke-run-checks)) | `not-live` |
| 4 | Whoever started the attempt is a person, or the workflow token with a `via` (the workflow's `via` input) that names a `schedule` run of this caller on the default branch, started within the last hour ([§11](#11-threat-model)) | `not-person` |
| 5 | Under a fallback marker, on production: the Maintainer the record names started it, as `deploy.yml`'s `declare` checks today | `not-maintainer` |

- **`smoke`** sets `environment:`, so GitHub runs it only after the environment's protection rules pass, and its OIDC subject is the environment's. It joins the deploy's concurrency group ([§5](#5-one-run-per-environment-at-a-time)). Once it holds its slot, it checks again that its tag is still the live release, and refuses `superseded` if a deploy landed while it waited ([§5.3](#53-what-a-queued-run-does-when-it-starts)). Then it checks out the tag with no credential persisted, runs the reset hook if present, then the smoke hook.
- **`record`, `report`, `announce` and `notify`** do what `deploy.yml`'s do, for a smoke run ([§7.3](#73-a-smoke-only-runs-outcomes)).

### 4.2 On demand, behind the environment's protection

A person runs `gh workflow run smoke.yml --ref <live tag> -f environment=<name>`. **At the tag, not the default branch,** for two reasons. Plan 0010 requires each environment's deployment refs to admit the release tags alone (doctor's `deploy.branch-policy`), so a run at the default branch can't enter the environment. And the smoke hook at the live tag is the check that matches the system that is live. The run summary names the command with the live tag filled in, for the next person.

**The run uses the smoke caller at the live tag,** since GitHub runs a dispatched workflow from the file at the ref it is dispatched at. Three things follow.
- **No smoke run outside a deploy works on an environment until a release that contains `smoke.yml` is deployed there.** After S6, `kanon init` writes the caller on the default branch, but each environment's live tag holds no caller until the next release reaches it. The deploy's own smoke step works throughout. Scheduled runs are routed from the default branch, so they start, and `dispatch` fails by name (`no-caller`) when the live tag has no caller. **That run goes red with a summary naming the environment and the missing release** (the live tag that holds no caller). It files no issue, posts no alert and writes no row (decision 14), since the same failure repeats every night until the next deploy ([§7.3](#73-a-smoke-only-runs-outcomes)).
- **After a Kanon upgrade, the smoke workflow in effect on an environment is the one the live tag's caller pins,** not the default branch's, until a release with the new pin is deployed there. The scheduler's own jobs (`route`, `dispatch`) run at the default branch's pin.
- **`deploy.smoke-caller-mismatch` reads the default branch,** so it can't see the live tag's caller. A second check, `deploy.smoke-caller-live` ([§9](#9-doctor-and-init)), reads the caller at each environment's live tag.

**The environment's protection applies** because the `smoke` job references it: production's required reviewer approves each on-demand production run, or, under the `no-reviewers` fallback, only the Maintainer's dispatch runs it (check 5). A pre-production environment with no reviewer runs as soon as a person dispatches it.

### 4.3 A schedule per environment

An optional bullet in the record's `## Deploy` section, one code span per environment, its name and then a five-field cron:

```markdown
- **Smoke schedule:** `staging 0 3 * * *`
```

`kanon init` writes one `schedule:` entry per span into the caller. GitHub runs a schedule only from the default branch's copy of a workflow, so the scheduled run is a router: it never smokes anything itself, it dispatches the on-demand path at the live tag ([§4.1](#41-the-caller-and-the-workflow)). One path then holds every check of §4.1.

**Production may have a schedule** (decision 8). Doctor notes it, since it writes to production on a timer. **An environment with required reviewers may not:** each run would wait for a person and hold the deploy's slot while it waits ([§5](#5-one-run-per-environment-at-a-time)), so doctor blocks it (`deploy.smoke-schedule-reviewers`). Two environments may not share one cron string, because `github.event.schedule` is how `route` tells them apart.

### 4.4 Which release a smoke run checks

**The live release** of an environment is the release of its newest GitHub deployment whose latest status is `success`, read as the supersede check and the announcement already read it (`supersede` in `scripts/deploy-gate.mjs`, `previousRelease` in `scripts/announce-deploy.mjs`). With [§7.1](#71-the-deploy-job-succeeds-when-the-deploy-hook-does)'s change, a release that deployed and failed its smoke check is live, which is true. A smoke run's own deployment, if the platform makes one (§12 item 6), is of the live release already, so it doesn't change the answer.

**Under the `no-environments` fallback,** GitHub records no deployment, so the live release can't be read, and no job can be held to an environment's protection. Smoke runs outside a deploy aren't offered there (decision 13). The deploy's own smoke step runs as today.

## 5. One run per environment at a time

### 5.1 What GitHub's concurrency does

From plan 0010 §6, which read GitHub's documentation on 2026-10-14:
- **By default** at most one job or run is pending in a group, and a newer pending one cancels it. That is `queue: single`, and it is what the issue warns about.
- **`queue: max`** keeps up to 100 pending, and cancels any beyond that. It can't be combined with `cancel-in-progress: true`.
- **Order** is first in, first out by the time each started waiting, but "ordering is not guaranteed".
- **Measured in D0:** a job waiting for a reviewer holds the group's slot.

What is not known: whether two jobs of **different workflows** that name the same group share one queue under `queue: max`, and what happens when a job with `queue: single` joins a group whose others use `queue: max` (§12 items 2 and 3).

### 5.2 The mechanism: one shared, queued group

**Every job that resets or smokes an environment joins the deploy job's group:**

```yaml
# deploy.yml's deploy job, as today:
concurrency:
  group: kanon-deploy-${{ github.repository }}-${{ inputs.environment }}
  cancel-in-progress: false
  queue: max
# deploy-smoke.yml's smoke job:
concurrency:
  group: kanon-deploy-${{ github.repository }}-${{ needs.declare.outputs.environment }}
  cancel-in-progress: false
  queue: max
```

That is `deploy.yml`'s `deploy` job, whose `environment` input is the one the deploy caller passes, and `deploy-smoke.yml`'s `smoke` job, whose environment is `declare`'s `environment` output: the workflow's `environment` input once `declare` has checked it is declared, never empty (check 2 refuses an empty or undeclared one). Both are the environment's name exactly as the record's `## Deploy` list spells it, so both jobs resolve to one key, `kanon-deploy-<repo>-<environment>`. The `smoke` job's `environment:` key reads the same output. **The reset and the smoke hook run inside a job that holds the slot,** in both workflows, so no reset starts while another run is mid-check. No other job of either workflow holds a group: `route`, `dispatch`, `declare`, `record`, `report`, `announce` and `notify` touch nothing of the environment's.

**A guard test holds the shape** (S5): rendered for one environment, both jobs' groups resolve to the same `kanon-deploy-<repo>-<environment>` key, each with `queue: max` and `cancel-in-progress: false`, and no job anywhere in Kanon's workflows names a `kanon-deploy-` group with any other setting. A `queue: single` job that joined could cancel a pending deploy, which is the one thing the issue forbids.

### 5.3 What a queued run does when it starts

- **A smoke run queued behind a deploy** starts after the deploy, at a tag that is no longer live. It refuses `superseded` once it holds the slot. The deploy's own smoke step just checked the new release, so nothing is lost. The row says so ([§8](#8-telemetry)), and nothing is filed or announced.
- **A deploy queued behind a smoke run** starts once the smoke run ends. It waits at most the smoke job's limit (`timeout-minutes`, 60 by default, which the record may change, decision 3), plus its approval wait if the smoke run is on an environment with reviewers.
- **Two smoke runs** run one after the other. Each resets first, so neither sees the other's data.
- **A queue that runs out of order** changes nothing. Each holder resets first, and the deploy's supersede check already covers a deploy that runs before an older one.

### 5.4 What a waiting run blocks, stated plainly

- **An on-demand production smoke run waiting for its reviewer holds production's slot.** A production deploy queued behind it waits until the reviewer approves or rejects the smoke run. The deploy's own run summary says what it waits behind. That is the same behaviour D0 measured between two deploys, and the same reviewer decides both.
- **A production deploy waiting for its reviewer holds the slot against smoke runs.** A smoke run behind it waits. The scheduler adds no second one meanwhile ([§4.1](#41-the-caller-and-the-workflow)).
- **How long a job may stay pending in a group** is not documented. S0 measured at least 11 hours: a job pending behind a waiting one was not cancelled in that time (§12 item 4). If GitHub cancels a pending job after some longer time, a smoke run cancelled while pending records `cancelled` and files nothing.

### 5.5 The fallback, if the probes fail

If two workflows' jobs don't share one `queue: max` queue (§12 item 2), the plan changes to this, before S5 is built:
- **Smoke runs get a group of their own,** `kanon-smoke-<repo>-<environment>`, `queue: single`. A newer pending smoke run then cancels an older pending one, which is harmless: they check the same release. It never cancels a deploy, which is in another group.
- **A smoke run defers to a deploy.** Once it holds its slot, it refuses `deploy-running` when the environment has a deployment that is queued, waiting or in progress, read with `deployments: read`.
- **A deploy defers to a smoke run, for a while.** Before the reset step, the deploy job waits while a smoke run of that environment is in progress, polling the smoke caller's runs with `actions: read`, up to the smoke job's limit, then goes on and says so.

This is weaker: the check and the start are two reads, so a race of seconds remains, and a run that loses it may fail for no fault of the release. The row can't tell that failure from a real one. That is why the shared group comes first.

## 6. The reset hook

**`.github/actions/smoke-reset/action.yml`,** a composite action the adopter writes, with the smoke hook's inputs, `environment`, `role` and `release`. **Optional:** when the file is absent, the lane skips the step and says so in the summary. Doctor notes its absence wherever a smoke run can happen outside a deploy ([§9](#9-doctor-and-init)).

**Where it runs:** in the same job as the smoke hook, just before it, in both workflows. In `deploy.yml` that is after the deploy hook. **With what:** the job's OIDC credential, which the hook obtains itself as the deploy hook does, and the smoke secret, `KANON_SMOKE_SECRET` (decision 6). Nothing else.

**What its failure means:** the smoke hook doesn't run, since its data is in an unknown state. The outcome is the smoke check's failure, at a stage of its own, `reset` (decision 12): after a deploy, "live, smoke failed" at `reset`; in a smoke-only run, `failed` at `reset`. A reset failure on production is as urgent as a smoke failure, because the fixtures may now be visible to the product.

**What Kanon passes it, as environment variables, beside its inputs:** `KANON_SMOKE_TRIGGER`, one of `deploy`, `schedule` or `dispatch`, so the adopter can run a lighter tier on a schedule. Both hooks get it. It is an environment variable, not an input, so smoke hooks written before this plan stay valid: doctor's `deploy.hook-missing` checks declared inputs.

## 7. Live, smoke failed

### 7.1 The deploy job succeeds when the deploy hook does

In `deploy.yml`'s `deploy` job, the reset and smoke steps get `continue-on-error: true`. So:
- **The `deploy` job concludes `success` when the deploy hook did,** whatever the smoke check said, and GitHub marks the environment's deployment `success` (§12 item 1). The release is live, and the platform's record now says so. The supersede check and the announcement's range then count it as live, which fixes both readings in [§2](#2-today-measured).
- **The steps' own outcomes still say what happened:** `steps.smoke.outcome` and a new `reset-outcome` output are `failure`, while each step's conclusion is `success`.
- **A new `verdict` job** in `deploy.yml`, `needs: deploy`, no permissions, runs `if: always()` and fails when the reset or the smoke outcome is `failure`. A failed job fails the call, so the next environment's call, which `needs:` this one, doesn't start. **The chain stops on a failed smoke check, as today.** A smoke failure on pre-production still keeps the release out of production.

**A re-run.** Plan 0010's D12 retried a failed smoke check with "Re-run failed jobs", which re-ran the whole `deploy` job. After this change that re-runs only `verdict`, which fails again. **The way to retry a smoke check is the on-demand smoke run** ([§4.2](#42-on-demand-behind-the-environments-protection)), and the failed run's summary names its command. Its pass closes the smoke issue ([§7.2](#72-what-each-job-says)). It doesn't restart the chain: to carry the release on to the next environment, a person dispatches the deploy caller at the tag, which redeploys the first environment and goes on.

**A cancel during the smoke step** still cancels the job, so the row says `cancelled` at `smoke`, as today, or at `reset` during the reset. **Measured (§12 item 7):** GitHub then marks the deployment `error`, not `success`. So a release whose deploy hook passed and whose run was cancelled during the reset or the smoke check isn't read as live by the supersede check or the announcement's range, which fall back to the release before it, although the new one is deployed. The row already says `cancelled`, and only that reading is affected; the plan accepts it as measured.

### 7.2 What each job says

| Who | A deploy that failed (`failed` at `deploy`) | Live, smoke failed (`smoke_failed` at `reset` or `smoke`) |
|---|---|---|
| **GitHub's deployment** | not `success` | `success` (§12 item 1) |
| **The chain** | stops | stops, through `verdict` |
| **`record`, the `deploy` row** | `outcome: failed`, `failed_stage: deploy` | `outcome: smoke_failed`, `failed_stage: smoke`, or `reset` (new), with `smoke_ms` and the new `reset_ms` ([§8](#8-telemetry)) |
| **`report`, the issue** | files or comments on `Deploy to <environment> failed` | files or comments on **`Smoke check on <environment> failed`**, a title of its own (decision 4), and **closes** `Deploy to <environment> failed` if one is open, since the deploy succeeded. Labels as today: `bug`, and `sev:high` on production, `sev:medium` elsewhere. Body: the release, "is live on `<environment>`, but its smoke check failed at the `<stage>` stage", the run, and the on-demand command to run it again |
| **`announce`, the message** | `critical` on production, `warning` elsewhere: "`<version>` failed to deploy to `<environment>`" | **One message, the landed one, flagged.** The title "`<version>` is live on `<environment>`, and its smoke check failed". The same Features, Fixes and Maintenance sections an `ok` deploy gets, so nobody misses what went live. A field "Smoke check: failed at `<stage>`" and the smoke issue's link. `critical` on production, `warning` elsewhere. It is never skipped, and never reads "failed to deploy" |
| **`notify`** | posts through the hook with `KANON_CHAT_DEPLOY` | the same |
| **Rollback** | none | none. A person decides, and a dispatch of the release before it is flagged `rollback: true`, since the smoke-failed release is now the environment's last success |
| **Metrics** (plan 0010 §11) | counts as a change failure; restored by the next `ok` | the same, as today: `smoke_failed` is already in the change-failure rate and time to restore |
| **The diagnose lane** | diagnoses the run | the same, once it learns the smoke issue's title (S8) |

**An `ok` deploy whose smoke check passed** closes both issues for its environment: the deploy issue and the smoke issue.

### 7.3 A smoke-only run's outcomes

| Outcome | When | Issue | Message | Row |
|---|---|---|---|---|
| `ok` | the reset, if present, and the smoke hook passed | closes `Smoke check on <environment> failed` if open | none, unless it closed an issue: then `info`, "The smoke check on `<environment>` passes again" | `smoke_check`, `ok` |
| `failed` at `reset` or `smoke` | either hook failed | files or comments on `Smoke check on <environment> failed` | `critical` on production, `warning` elsewhere: "The smoke check on `<environment>` failed", naming the live release, the stage, the trigger, the run and the issue | `smoke_check`, `failed` |
| `refused` | `declare`'s checks, or `superseded` once the slot was held | `not-person` and `not-maintainer` comment on the smoke issue, as a deploy's refusal does (`K-SHIP-8`); `superseded`, `not-live` and `no-release` file nothing | none | `smoke_check`, `refused`, with the code |
| `no-caller` | a scheduled run's `dispatch` finds no `smoke.yml` at the environment's live tag ([§4.2](#42-on-demand-behind-the-environments-protection)): expected on each scheduled environment until a release with the caller reaches it | none | none | none: the run ends red with a summary naming the environment and the missing release (its live tag, which holds no caller), and writes no row, since nothing was checked (decision 14). Doctor's `deploy.smoke-caller-live` says the same on the next doctor run |
| `rejected` | a reviewer rejected the `smoke` job | none | none | `smoke_check`, `rejected` |
| `cancelled` | a person, or the run's limits | none | none | `smoke_check`, `cancelled` |

**Only a dispatched run reaches `record`, `report`, `announce` and `notify`.** The scheduled run's job graph is `route → dispatch` ([§4.1](#41-the-caller-and-the-workflow)), with none of them, which is why its one failure, `no-caller`, files, posts and writes nothing: the outcome asks for no job the graph lacks. Every other outcome in the table is a dispatched run's.

**The message kind** a smoke-only run posts is the `deploy` kind and its secret, `KANON_CHAT_DEPLOY` (decision 5), so the people who get the deploy announcements get its alerts, and the adopter stores no new secret. Plan 0011's contract gains one `source.lane` value, `deploy-smoke`, and the `notify` row's lane `smoke-announce`, since `deploy` is the deploy rows' partition.

## 8. Telemetry

**The `deploy` row** (plan 0010 §10) gains the stage `reset` in `DEPLOY_STAGES` and a `reset_ms` count. By the schema's own rule for a new field ([plan 0002](0002-hosted-telemetry-store.md) §2.2), that is version 2 of the row: version 1's fields and `reset_ms`, with `reset` among its stages. Version 1 is unchanged, and a row is written at version 2 only when it carries either (built in S2). The store's intake ships first (`docs/telemetry.md`, as plan 0010's D9 did).

**A new row kind, `smoke_check`,** version 1, for runs of `deploy-smoke.yml` (decision 7), stored under `<key>#smoke_check`. Every field is a number, a time, a boolean or a value from a closed list (ADR 0007, `K-OBS-16`):

| Field | Type | What |
|---|---|---|
| `schema_version`, `row_kind`, `tag`, `recorded_at`, `run_id`, `run_attempt`, `kanon_version` | as the `deploy` row | `row_kind: smoke_check`. The name isn't `smoke`, which is already a value of `tag`, in the `TAGS` list of `actions/agent-telemetry/schema.mjs` |
| `trigger` | `schedule` or `workflow_dispatch` | a scheduled run's own dispatch records `schedule`, read from the workflow's `via` input, as `declare` reads it ([§4.1](#41-the-caller-and-the-workflow)) |
| `role`, `position` | as the `deploy` row | never the environment's name |
| `outcome` | `ok`, `failed`, `refused`, `rejected`, `cancelled` | |
| `failed_stage` | `approval`, `reset`, `smoke` | absent when `ok` |
| `refusal` | `no-release`, `declaration-mismatch`, `not-live`, `not-person`, `not-maintainer`, `superseded` | only with `refused` |
| `reset_ran` | boolean | whether a reset hook exists and ran |
| `wait_ms`, `reset_ms`, `smoke_ms`, `duration_ms` | count | `wait_ms` is the queue and the approval, from the run's start to the job's |

**No row for `no-caller`.** A scheduled run whose environment's live tag holds no smoke caller writes no `smoke_check` row ([§7.3](#73-a-smoke-only-runs-outcomes), decision 14): nothing was checked, and its job graph has no `record`. So `refusal`'s list, and `K-OBS-16`'s, stay as above, without `no-caller`.

**Never in it:** the release's tag, the commit, the environment's name, a URL, the reviewer, or anything the hooks print.

**Its artifact** is named as the deploy row's is: `kanon-smoke-row-<run id>-<attempt>-<position>`, holding one row in `kanon-smoke-row.json`, outside the `kanon-telemetry-` prefix that only a lane's run row carries (kanon#826). The name and the file are `SMOKE_ARTIFACT_PREFIX`, `SMOKE_ARTIFACT_FILE` and `smokeArtifactName` in `scripts/lib/telemetry-artifacts.mjs` (built in S3), so S5's `record` job and the collector can't disagree. The partition's name is `SMOKE_CHECK_PARTITION` in `actions/agent-telemetry/schema.mjs`, which no lane may take.

**The metrics don't change.** Smoke-only rows count in none of plan 0010's four deploy views, which read `deploy` rows only. A view of the smoke pass rate, or of time to restore counted to a passing smoke run rather than the next deploy, is a later choice, not this plan's.

## 9. Doctor and init

**`kanon init`** (S6):
- writes `.github/workflows/smoke.yml` whenever it writes the deploy caller, pinned at the same release, with the dispatch trigger and one `schedule:` entry per span of the record's `Smoke schedule` (always, decision 2);
- writes no stub for the reset hook. An optional hook with a stub that fails would force every adopter to write one. Doctor's note says when one matters;
- maps `KANON_SMOKE_SECRET` (decision 6) and `KANON_CHAT_DEPLOY` by their names, as `deployCallerFile` maps the deploy job's;
- asks no new install question. The schedule is the adopter's later edit to the record, then `kanon init` again, which rewrites the caller as it rewrites the deploy caller. That keeps the Owner's install-questions decision of 2026-10-10 as plan 0010 left it;
- gets a `--smoke-schedule '<environment> <cron>'` flag, repeated per environment, which writes the bullet.

**`kanon doctor`** (S7), in the style of plan 0010 §12, running only where a chain is declared:

| Id | Blocks | Holds when | Read from |
|---|---|---|---|
| `deploy.smoke-caller-mismatch` | yes | the smoke caller exists, calls `deploy-smoke.yml` at the deploy caller's release with the declared list, maps the dispatch's `environment` and `via` inputs as `${{ github.event.inputs.<name> }}`, maps no secret but its two, and its crons are exactly the record's `Smoke schedule`. The fix is `kanon init` | the checkout |
| `deploy.smoke-caller-live` | no | each declared environment's live tag holds a smoke caller, and it pins the same Kanon release as the default branch's. A note naming the environment when it holds none (no smoke run outside a deploy works there until a release with the caller is deployed) or pins another release (that release's smoke workflow is the one in effect there) ([§4.2](#42-on-demand-behind-the-environments-protection)) | `GET repos/{o}/{r}/contents/.github/workflows/smoke.yml?ref=<live tag>`, the live tag read as [§4.4](#44-which-release-a-smoke-run-checks) says |
| `deploy.smoke-schedule` | yes | the bullet parses: each span names a declared environment, once, with a five-field cron, and no two spans share a cron string | `scripts/lib/deploy-declaration.mjs` |
| `deploy.smoke-schedule-reviewers` | yes | no scheduled environment has a required-reviewers rule ([§4.3](#43-a-schedule-per-environment)) | `GET repos/{o}/{r}/environments` |
| `deploy.smoke-schedule-production` | no | production has no schedule; with one, the note says it writes to production on a timer | the declaration |
| `deploy.smoke-noop` | no | the smoke hook does something: it isn't `init`'s stub, and not every step is a `run:` of only `true`, `exit 0`, `:` or `echo`. A note, never a block: doctor reads the shape, not what the check checks (the issue's item 6) | the checkout |
| `deploy.reset-missing` | no | a reset hook exists wherever a smoke caller exists; without one, the note says each run starts from whatever the last left | the checkout |
| `deploy.hook-missing` | yes, as today | now also: a reset hook, when present, declares `environment`, `role` and `release` | the checkout |
| `deploy.smoke-disabled` | no | the smoke caller isn't `disabled_inactivity` (§12 item 8) | `GET repos/{o}/{r}/actions/workflows/smoke.yml` |
| `deploy.smoke-secret-repository` | no | `KANON_SMOKE_SECRET`, if used, is an environment secret only, as `deploy.secret-repository` says of the deploy secret | the secrets' names |

`requirements.json`'s `deploy` entry gains the fourth hook (optional), the smoke workflow, its grants and its secrets, built from the lane by `tests/unit/requirements.test.ts` as today.

## 10. Rules and docs that change

| Where | Change | Step |
|---|---|---|
| `K-SHIP-10` | The rule's title and text name a third confusion: a failed smoke check after a landed deploy is announced as live and flagged, never as a failed deploy, and never skipped. "Enforced by" names `announce-deploy.mjs`'s test | S1, S4 |
| `K-SHIP-12` | Names `deploy-smoke.yml` beside the two deploy workflows: no model, the cloud credential only in its `smoke` job, which references the environment. The secrets list gains `KANON_SMOKE_SECRET`, to the reset and smoke steps alone (decision 6) | S1, S5 |
| `K-AGENT-47` | Plan 0010's one-sentence exception for `KANON_DEPLOY_SECRET` names the second fixed environment secret, `KANON_SMOKE_SECRET` (decision 6) | S1 |
| `K-AGENT-50` | Its guard's list of jobs that run the default branch's reviewed code gains `deploy-smoke.yml`'s `smoke` job, which runs the release tag's hooks with a credential. `route`, `dispatch` and `declare` run no hook | S5 |
| `K-LAYOUT-1` | The reset hook's path, the smoke caller's path | S1 |
| `K-LAYOUT-10`, the `## Deploy` section | The optional `Smoke schedule` bullet | S1 |
| `K-OBS-16`, ADR 0007 | The `smoke_check` row's allowed fields; the `deploy` row's `reset` stage and `reset_ms` | S2 |
| **`K-SHIP-13`, new** (decision 9) | "A production deploy is followed by a smoke check, and smoke data lives where the product can't see it." Class split: the lane runs the check, doctor notes a no-op hook; the project supplies the check and the fixtures' isolation, which stays prose | S1 |
| plan 0010 | §7 (four hooks, the smoke secret), §8 (a smoke failure leaves the deploy job green and stops the chain through `verdict`; the smoke issue), §10 (the `reset` stage), D12 (retry by an on-demand run, not "Re-run failed jobs"). A line at the top points here | S4 |
| plan 0011 | §3.2: what a `smoke_failed` message says; the `deploy-smoke` lane value | S4, S5 |
| `docs/lanes.md`, `docs/lanes.json` | "The deploy lane": the reset hook in the hooks table, "live, smoke failed", how to retry a smoke check; a new section, "Smoke runs outside a deploy": the caller, the two triggers, the shared group, the refusals | S4, S5 |
| `docs/notifications.md` | "The deploy announcement": the flagged landed message; smoke-only alerts | S4, S5 |
| `docs/doctor.md`, `skills/doctor` | [§9](#9-doctor-and-init)'s rows | S7 |
| `docs/init.md`, `docs/install.md`, `README.md`, `docs/architecture.md` | The smoke caller, the `Smoke schedule` bullet and `--smoke-schedule`; the reset hook as optional | S6 |
| `skills/upgrade` | An upgrade to S4's release: a smoke failure no longer turns the deploy job red, and the retry is an on-demand run; to S5's: run `kanon init` to get the smoke caller, and know that smoke runs outside a deploy work on an environment only once a release containing it is deployed there, and that after each later Kanon upgrade an environment runs the smoke workflow its live tag's caller pins until the next deploy (`deploy.smoke-caller-live` says which) | S4, S6 |
| `docs/telemetry.md` | The `smoke_check` row in the ingest function | S3 |

## 11. Threat model

- **Who can start a smoke run.** Anyone who can dispatch a workflow: write access, or an App token with `actions: write`. **Kanon's Judge App holds `actions: write`** (the `judge` App in `rulebook/agent-permissions.json`), so an agent could dispatch one. `declare` admits only a person, read from the attempt's triggering actor's account type, or the workflow token with a `via`, the workflow's `via` input, naming a scheduled run of this caller on the default branch (check 4, decisions 10 and 15). An App's dispatch is refused `not-person`. **The `via` check is not a secret:** another workflow in the repository with `actions: write` on the workflow token could copy a recent `via`. It can only start a smoke run that a schedule had just started, at the live release, behind the environment's rules, so the worst it buys is a second check of the same release.
- **What protects production.** Production's required reviewer approves every on-demand production run, as it approves every deploy. Under `no-reviewers`, only the Maintainer's dispatch passes (check 5). A schedule on an environment with reviewers is blocked ([§4.3](#43-a-schedule-per-environment)), so a schedule never waits for a reviewer.
- **What is weaker.** A pre-production environment with no reviewer runs a smoke check, and so writes data, for any person with write access who dispatches one. That is the same reach they have over a deploy to it today, through a release. Doctor's `deploy.reviewers-missing` already notes which environments have no reviewer.
- **What the credential meets.** The `smoke` job holds `id-token: write` and the environment's OIDC subject, so the smoke and reset hooks can obtain **the same cloud role the deploy hook does.** That is true today inside the deploy job too. The hooks are the release tag's code, on the default branch, reviewed (`K-MERGE-4` escalates every file under `.github/`). A smoke role narrower than the deploy role would have to be told apart from it by something other than the subject, since both jobs carry the same one; whether a trust policy can read the workflow claim for that is §12 item 9, and the docs would suggest it only if it can.
- **Secrets in the smoke job.** Today the smoke step gets none, and a guard test in `tests/unit/deploy-lane.test.ts` holds that. A smoke check that signs up a fake tenant may need a sandbox key or a test account's password the cloud role can't give. Decision 6 adds one fixed name, `KANON_SMOKE_SECRET`, an environment secret, passed as `env:` to the reset and smoke steps alone, never to the deploy hook. `KANON_DEPLOY_SECRET` never reaches them. The chat secret reaches `notify` alone, as today. The guard test is extended to all three in both workflows.
- **No model.** `deploy-smoke.yml` runs no agent, holds no Claude credential and no App key: `K-SHIP-12`'s guard covers it. The diagnose lane runs separately, after a failure, read-only, as today.
- **What the logs hold.** A smoke log can name the fake tenant and sandbox details. The issue, the message and the row hold none of it: the issue links the run, it doesn't quote it. The diagnose lane reads logs only where the adopter's `## Data` answer allows it, as today.

## 12. What is not confirmed, and how each is probed

S0 probes each in the sandbox repository, as plan 0010's D0 did, and records the answers in S0's issue. A step that rests on an item is amended before it is built if the answer differs. **S0 ran on 2026-10-20** ([#1166's results](https://github.com/yedeya-labs/kanon/issues/1166#issuecomment-6299720674)); the last column is each answer, with its run. Item 4 was read 11 hours on and holds; items 9, 10 and 11 are still open.

| # | Assumed | Rests on it | Probe | If it doesn't hold | Measured (S0, 2026-10-20) |
|---|---|---|---|---|---|
| 1 | A job whose deploy step succeeded and whose smoke step failed under `continue-on-error: true` concludes `success`, and GitHub marks its environment's deployment `success` | [§7.1](#71-the-deploy-job-succeeds-when-the-deploy-hook-does), the live release in [§4.4](#44-which-release-a-smoke-run-checks) | a job with an environment, a passing step and a failing one under `continue-on-error`; read the deployment's statuses | the live release is read from the `deploy` rows' outcomes, through a new `scripts/lib/live-release.mjs`, not from the Deployments API | **Holds.** The job and the run concluded `success`, the smoke step's outcome `failure` and its conclusion `success`, and the deployment's statuses read `in_progress`, then `success` ([run 39483057968](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39483057968)). §7.1 stands as drawn |
| 2 | Jobs of two different workflows, from two different callers, that name one group under `queue: max` share one queue, and neither cancels the other's pending job | [§5.2](#52-the-mechanism-one-shared-queued-group) | two workflows; start a long job in one, then two pending in each; read which run, which wait, which are cancelled | [§5.5](#55-the-fallback-if-the-probes-fail)'s fallback, before S5 is built | **Holds.** Five runs of two workflows in one `queue: max` group ran one at a time, first in, first out, across both workflows, and none was cancelled ([A1](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39483429383), [B1](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39483495240), [A2](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39483513987), [B2](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39483533068), [A3](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39483552629)). §5.2 stands; §5.5 isn't needed |
| 3 | A job waiting for a reviewer in one workflow holds the slot against a job of the other workflow, as D0 measured within one | [§5.4](#54-what-a-waiting-run-blocks-stated-plainly) | as 2, with the first job waiting for a reviewer | the plan's statement changes; if a smoke run could start beside a waiting deploy, nothing breaks, since the deploy hasn't started | **Holds.** A job of another workflow stayed `pending` while the reviewer-waiting job held the slot, and started once that job was cancelled ([3a, run 39484161849](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484161849); [3b, run 39484217782](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484217782)). §5.4 stands |
| 4 | A job pending in a group isn't cancelled by GitHub for some hours at least | [§5.4](#54-what-a-waiting-run-blocks-stated-plainly) | leave a job pending behind a waiting one for 6 hours; read its state | the summary names the limit; a cancelled pending smoke run records `cancelled` already | **Holds:** a job pending in a group behind a waiting one was still pending, not cancelled, after 11 hours ([4a, run 39484167049](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484167049); [4b, run 39484222864](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484222864)) |
| 5 | A `workflow_dispatch` made with the workflow token's `actions: write`, at a tag ref, starts a run (plan 0010 §3 quotes the rule), and its triggering actor reads `github-actions[bot]` | `dispatch`, check 4 | dispatch from a scheduled job; read the new run's `event`, `head_branch` and `triggering_actor` | the scheduler uses the Releaser's token, which `K-AGENT-47` would have to name, or the schedule smokes from the default branch with an environment rule that admits it, which weakens `deploy.branch-policy` | **Holds,** from a dispatched parent: the child run's `event` is `workflow_dispatch`, its `head_branch` the tag, and both `actor` and `triggering_actor` read `github-actions[bot]` ([parent, run 39484370429](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484370429); [child, run 39484387962](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484387962)). A scheduled parent is untested; item 10's probe can confirm it |
| 6 | Whether a job can reference an environment without GitHub creating a deployment | the Deployments API's reading in [§4.4](#44-which-release-a-smoke-run-checks) and the announcement's range | read GitHub's documentation for the `environment` key; if it offers an option, try it | if every `smoke` job creates a deployment of the live release, the supersede check and the announcement's range pass over deployments whose status links a smoke caller's run, read from the status's run link | **Yes:** `environment: { name, deployment: false }` creates no deployment, while the reviewers, the branch policy and the environment's OIDC subject still apply ([at the tag, run 39484774207](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484774207); [at a branch, refused, run 39484779826](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484779826); [with a reviewer, run 39484981960](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39484981960)). It is incompatible with custom deployment protection rules. For S5 |
| 7 | What GitHub marks a deployment whose job was cancelled during a `continue-on-error` step | [§7.1](#71-the-deploy-job-succeeds-when-the-deploy-hook-does) | cancel during the smoke step; read the statuses | the row already records `cancelled`; only the live-release reading needs the answer | **`error`.** Cancelled during a `continue-on-error` step, the job concluded `cancelled` and the deployment read `in_progress`, then `error` ([run 39483063105](https://github.com/yedeya-labs/kanon-sandbox/actions/runs/39483063105)). Accepted in §7.1: the row records `cancelled`, and the live-release reading falls back to the release before |
| 8 | GitHub disables a public repository's scheduled workflows after 60 days with no activity, and reports the workflow `disabled_inactivity` | `deploy.smoke-disabled` | read GitHub's documentation on scheduled workflows | the check is dropped or renamed to what the documentation says | **Holds** for public repositories, from GitHub's documentation, and the workflow `state` enum holds `disabled_inactivity`. The documentation says nothing of private repositories, so the check's text mustn't claim it |
| 9 | An AWS role's trust policy can require the OIDC token's workflow claim, so a smoke role trusts `deploy-smoke.yml`'s job and not the deploy job, in one environment | the docs' advice in [§11](#11-threat-model) | read AWS's list of condition keys for GitHub's OIDC provider; try one in the sandbox account | the docs say the smoke hooks reach the deploy role, and nothing narrower | **Open:** not probed |
| 10 | `github.event.schedule` holds the cron string exactly as the caller writes it | `route` | one schedule; print the field | `route` normalises both strings before it compares them | **Open:** not measured, since a schedule runs only from the default branch; the documentation compares the field with the cron string as written |
| 11 | "Re-run failed jobs" after a live smoke failure re-runs `verdict` alone, not the `deploy` job | [§7.1](#71-the-deploy-job-succeeds-when-the-deploy-hook-does)'s re-run text | in S9's rehearsal | the docs say what it does | **Open:** S9's rehearsal |

## 13. Order of moves

**Touches** names each step's files, to show which steps may run at once. **S0 and S4 come first** (decision 1), with S1 to S3 only as far as S4 needs them: the probes, then "live, smoke failed" and the reset hook in the existing lane, which ships on its own, in the first release it is ready for. **S5 to S10 wait** until the adopter's own smoke runs outside a deploy have run for a few weeks; what they teach is folded into this plan before S5 starts. **S5 to S8 then ship in one release,** so no adopter pins a smoke workflow without its caller and its checks.

| Step | Where | What | Touches | What must be true | Mutation |
|---|---|---|---|---|---|
| **S0** | the sandbox repository, by a maintainer, **first** (decision 1) | **The probes** of [§12](#12-what-is-not-confirmed-and-how-each-is-probed), with throwaway workflows and trivial hooks, no cloud | none in Kanon; results in S0's issue | each of §12's answers is recorded with the run's link. If item 1 or 2 fails, this plan is amended before S4 or S5 is built | — (a measurement) |
| **S1** | Kanon | **The rules and the declaration:** `K-SHIP-10`, `K-SHIP-12`, `K-AGENT-47`, `K-LAYOUT-1`, `K-LAYOUT-10` and `K-SHIP-13` (decision 9); the `Smoke schedule` bullet in `scripts/lib/deploy-declaration.mjs` | `rulebook/06-shipping.md`, `rulebook/03-agents.md`, `rulebook/11-repository-layout.md`, `actions/agent-telemetry/schema.mjs` (`RULE_IDS` only, for `K-SHIP-13`), `scripts/lib/deploy-declaration.mjs`, `tests/unit/deploy-declaration.test.ts` | `rulebook-why.test.ts` passes; the parser reads one and two spans, refuses an undeclared environment, an environment twice, a cron of four or six fields, two equal crons, and an empty span, each by line | dropping the undeclared-environment check turns its test red |
| **S2** | Kanon, **built 2026-10-20** | **The rows:** `reset` in `DEPLOY_STAGES` and `reset_ms`; the `smoke_check` kind; the ingest function refuses `smoke_check` until S3 | `actions/agent-telemetry/schema.mjs`, `infra/telemetry/function/rows.mjs` (`STORED_KINDS`), `tests/unit/telemetry-schema.test.ts`, `tests/unit/telemetry-ingest.test.ts` | a valid `smoke_check` row validates; one with an `environment`, `release`, `sha` or `url` field is rejected naming it; `refusal` without `refused`, or `failed_stage` with `ok`, is rejected; the ingest function answers it with 422 until S3 | admitting an `environment` field turns its test red |
| **S3** | Kanon, **a release, then the Owner deploys intake from it**, **built 2026-10-20** | **The store takes the rows:** `smoke_check` in `STORED_KINDS` and `PARTITIONS`; the erasure walk; the collector's artifact family | `infra/telemetry/function/rows.mjs`, `infra/telemetry/erase.mjs`, `infra/telemetry/function/token.mjs` (its header), `actions/agent-telemetry/schema.mjs` (`SMOKE_CHECK_PARTITION` only), `scripts/telemetry-collect.mjs`, `scripts/lib/telemetry-artifacts.mjs`, `docs/telemetry.md`, their tests: `tests/unit/telemetry-ingest.test.ts`, `telemetry-store-scripts.test.ts`, `telemetry-endpoints.test.ts`, `telemetry-schema.test.ts`, `telemetry-intake-first.test.ts`, `tests/library/telemetry-collect.test.ts` | S2 is merged. A `smoke_check` row lands in its partition; an erasure leaves it empty; `intake-first.mjs` names the change, so the intake deploy precedes the release that writes the rows | an erasure walk that skips the partition fails the erasure test |
| **S4** | Kanon, **its own release, first** (decision 1), **built 2026-10-20** | **Live, smoke failed, and the reset hook, in the existing lane** ([§6](#6-the-reset-hook), [§7.1](#71-the-deploy-job-succeeds-when-the-deploy-hook-does), [§7.2](#72-what-each-job-says)): `continue-on-error` on the reset and smoke steps; the reset step, skipped when the hook is absent; `reset-outcome`; the `verdict` job; `classifyEnvironment` reads the step outcomes before `ok`; the smoke issue's title and the deploy issue's close; the flagged landed message; `KANON_SMOKE_TRIGGER`; the diagnose lane finds the smoke issue's title. **As built:** `requirements.json` lists the reset hook under `deploy.optionalHooks`, apart from the three, so neither `kanon init` (no stub) nor a `kanon doctor` from before it (no `deploy.hook-missing`) asks for it; the reset step runs `if: hashFiles(...) != ''`; the diagnose gate reads a failed `verdict`'s environment's `deploy` job log, and its prompt (`agent-deploy-diagnose.yml`) names the verdict; the smoke issue's retry is a dispatch of the release until S5's on-demand run exists; `KANON_SMOKE_SECRET` is not passed yet (S5) | `.github/workflows/deploy.yml`, `scripts/deploy-row.mjs`, `scripts/deploy-report.mjs`, `scripts/announce-deploy.mjs`, `scripts/deploy-diagnose.mjs`, `requirements.json` (the optional fourth hook), `tests/unit/deploy-lane.test.ts`, `tests/library/announce-deploy.test.ts`, `tests/unit/deploy-diagnose.test.ts`, `requirements.test.ts`, `docs/lanes.md`, `docs/notifications.md`, plans 0010 and 0011, `skills/upgrade` | S0's items 1 and 7 hold, or §7.1 is amended; S3's intake is deployed, since the row's `reset` stage is new. The lane test: the `deploy` job concludes success with a failed smoke step, and `verdict` fails the call; a later environment doesn't start; the row is `smoke_failed` at `smoke`, or at `reset` with the smoke step not run; `report` files on `Smoke check on <environment> failed` and closes `Deploy to <environment> failed`; the message is the landed one with its sections, titled "is live … and its smoke check failed", `critical` on production; no reset step runs when the hook is absent; neither hook's step references `KANON_DEPLOY_SECRET` | leaving `continue-on-error` off the smoke step turns the success test red; dropping `verdict` turns the chain test red; classifying `ok` before reading the smoke outcome turns the row test red; announcing a `smoke_failed` with the failure template turns the message test red |
| **S5** | Kanon, the smoke release, **waits** (decision 1) | **The smoke workflow** ([§4](#4-smoke-outside-a-deploy), [§5](#5-one-run-per-environment-at-a-time), [§7.3](#73-a-smoke-only-runs-outcomes)): `deploy-smoke.yml` with `route`, `dispatch`, `declare`, `smoke`, `record`, `report`, `announce`, `notify`; `scripts/smoke-gate.mjs` (the route, the scheduler, the five checks, `superseded`); the smoke-only row, issue and message; the shared group's guard | `.github/workflows/deploy-smoke.yml` (new), `scripts/smoke-gate.mjs` (new), `scripts/deploy-row.mjs`, `scripts/deploy-report.mjs`, `scripts/announce-deploy.mjs`, `scripts/lib/notify-contract.mjs` (the lane value), `requirements.json`, `docs/lanes.md`, `docs/lanes.json`, `docs/notifications.md`, `rulebook/03-agents.md` (`K-AGENT-50`'s list), `tests/unit/deploy-smoke.test.ts` (new), `smoke-gate.test.ts` (new), `id-token-guard.test.ts`, `app-key-isolation.test.ts`, `pr-code-token-isolation.test.ts`, `requirements.test.ts`, `lanes-doc.test.ts` | S0's items 2, 5 and 6 hold, or §5.5 and §4.4 are applied first; S1 to S4 are merged. On fixtures: each refusal of §4.1 by its code; a scheduled run dispatches at the live tag and nothing when a run is pending; a run whose tag stopped being live refuses `superseded` after the slot; `smoke`'s group and `deploy.yml`'s `deploy` group, rendered for one environment, resolve to the same `kanon-deploy-<repo>-<environment>` key, each with `queue: max`; `deploy-smoke.yml` declares `via` as an optional input, and `declare`'s check 4 and the row's `trigger` read it from `inputs.via` alone, never from `github.event` (decision 15); `dispatch` fails `no-caller` when the live tag holds no smoke caller, red, with a summary naming the environment and the missing release, filing no issue, posting no alert and writing no row (decision 14); `id-token: write` on `smoke` alone; no agent, no App key; `dispatch` holds `actions: write` and nothing else | a `queue: single` job in a `kanon-deploy-` group turns the guard red; an empty environment term in `smoke`'s group, or one read from anything but `declare`'s `environment` output, turns the same-key test red; admitting an App's dispatch turns the `not-person` test red; a `via` read from `github.event` instead of the input turns the check-4 test red; a `no-caller` run that files an issue or writes a row turns its test red; `id-token` on `route` turns `id-token-guard` red |
| **S6** | Kanon, the smoke release, **waits** | **`kanon init` writes the smoke caller** and `--smoke-schedule` ([§9](#9-doctor-and-init)) | `cli/init.mjs`, `tests/unit/kanon-init.test.ts`, `docs/init.md`, `docs/install.md`, `README.md`, `docs/architecture.md`, `skills/upgrade` | S5 is merged. The caller pins the deploy caller's release, has the dispatch trigger and one cron per span, maps the dispatch's `environment` and `via` inputs, each as `${{ github.event.inputs.<name> }}` (decision 15), and only its two secrets, and is rewritten when the bullet changes; no declaration writes no caller; no reset stub is written. `init`'s closing step and `skills/upgrade` say that smoke runs outside a deploy start working on an environment only once a release containing the caller is deployed there, and that after an upgrade the live tag's pin is the one in effect ([§4.2](#42-on-demand-behind-the-environments-protection)) | a caller written with `secrets: inherit` turns its test red; a caller that drops `via`, so every scheduled run would reach `declare` with it empty and be refused `not-person`, turns its test red |
| **S7** | Kanon, the smoke release, **waits** | **Doctor's checks** ([§9](#9-doctor-and-init)) | `cli/doctor.mjs`, `docs/doctor.md`, `skills/doctor`, `tests/unit/kanon-doctor-deploy.test.ts` | S6 is merged. Each id is reported on a stubbed answer and quiet on `init`'s own output; `deploy.smoke-schedule-reviewers` blocks a schedule on an environment with reviewers; `deploy.smoke-noop` notes `init`'s stub and an `exit 0` hook, and is quiet on a hook that runs a script | a `smoke-noop` that blocks turns its test red |
| **S8** | Kanon, the smoke release, **waits** | **The diagnose lane follows the smoke caller** | `.github/workflows/agent-deploy-diagnose.yml`, `cli/init.mjs` (its caller's `workflows:`), `tests/unit/deploy-diagnose.test.ts`, `docs/lanes.md` | S5 is merged. A failed smoke caller's run is diagnosed on its smoke issue; by decision 11, only when the run filed the issue, not when it commented | a diagnosis on every comment turns its test red |
| **S9** | the sandbox repository, by a maintainer, **waits** | **The rehearsal:** the released lane, two environments, trivial hooks with a reset that writes a file and a smoke check that reads it | none in Kanon; the runs' links in S9's issue | S5 to S8 are released. A deploy whose pre-production smoke fails is announced live and flagged, files the smoke issue, and stops before production; an on-demand run passes and closes it; a scheduled run dispatches at the live tag; an on-demand production run queued behind a waiting production deploy waits, then refuses `superseded`; a deploy queued behind a running smoke run waits for it and cancels nothing; doctor reports no blocking `deploy.*` finding | — (live) |
| **S10** | **offloaded to the harness repository as an issue**, **waits** | **An end-to-end scenario,** `smoke-lifecycle`, repeating S9 on every candidate, without production's approval (plan 0012 decision 9) | none in Kanon | S9 is green | — |

**Why this order.**
- **Probes first:** items 1 and 2 decide whether the design holds as drawn, and no one has measured either.
- **The rows and the store's intake before the lane that writes them,** as `docs/telemetry.md` requires of every row change.
- **"Live, smoke failed" alone and early,** because it fixes a wrong reading in today's lane (a live release marked failed), it needs nothing from the smoke workflow, and an adopter has said it will switch to it as soon as it ships.
- **The smoke workflow after the adopter's own has run** (decision 1), as other lanes were proven in one install before they were generalised.
- **The smoke workflow, its caller, doctor and the diagnose lane together,** so the first adopter with a smoke caller is told what's missing before its first scheduled run.

## 14. Cost

- **Actions minutes:** one scheduled run per declared cron, which routes and dispatches in under a minute, plus the smoke run itself, which costs what the adopter's check costs. On-demand runs cost the same. Free on a public repository. On a private one, a nightly check of ten minutes is about 300 minutes a month per environment.
- **Waiting:** a deploy may wait behind a smoke run, for up to the smoke job's limit. That is wall time, not minutes, since a queued job holds no runner.
- **The model:** only the diagnose lane, for an adopter that opted in. A check that fails every night would cost one Explorer run a night if each failed run were diagnosed, which is why only the run that filed the issue is diagnosed (decision 11).
- **The hosted store:** two small rows per smoke run at most, in an existing table. No new resource.
- **Kanon's maintainers:** S0's probes and S9's rehearsal, by hand, in the sandbox. Then the harness repeats it on every candidate.

## Out of scope

- **What the smoke check exercises, the fake tenant, its exclusions, the sandboxes and the reset's implementation.** They stay the adopter's.
- **Automatic rollback** after a failed smoke check (plan 0010 §8).
- **Smoke runs outside a deploy under the `no-environments` fallback** (decision 13).
- **A smoke check at a release other than the live one,** such as a candidate checked against production before its deploy.
- **A smoke-pass metric, or time to restore counted to a passing smoke run.** The rows allow both later ([§8](#8-telemetry)).
- **Fan-out:** one smoke run checks one environment. Several targets inside one environment are the hook's business, as the deploy's are.
- **Kanon's own repository.** It declares no environment, so it gets no smoke caller. The operator's repository, which deploys the hosted store, may adopt it as any adopter does, through an issue filed there.

## Owner decisions (2026-10-20)

The draft asked thirteen questions. The Owner answered all of them on 2026-10-20, each as the draft recommended. The options are kept below, the chosen one marked **(chosen)**, and the sections above are written to the answers.

1. **When to build it.** The issue suggests letting an adopter's own implementation land first, then extracting it. That adopter is waiting for "live, smoke failed" in Kanon's announcement.
   - (a) Build all of it now.
   - (b) **(chosen)** Run S0 and build S4 now; build S5 to S10 after the adopter's own smoke runs outside a deploy have run for a few weeks, and fold what they taught into this plan first.
   - (c) Wait for the adopter for all of it.
   - Why: S4 fixes a wrong reading in today's lane and unblocks the adopter. The smoke workflow is where one install's experience is worth the most. [§13](#13-order-of-moves).
2. **Where the triggers live.**
   - (a) **(chosen)** A separate caller, `.github/workflows/smoke.yml`, always written with the deploy caller.
   - (b) A separate caller, written only when the record has a `Smoke schedule` or `init` is asked.
   - (c) More triggers on the deploy caller.
   - Why: on-demand runs are useful without a schedule, and the deploy caller's dispatch already means "deploy again". (c) would loosen `deploy.caller-mismatch`. [§4.1](#41-the-caller-and-the-workflow), [§9](#9-doctor-and-init).
3. **The shared queue, and the smoke job's limit.**
   - (a) **(chosen)** One group for deploys and smoke runs, `queue: max`, with a 60-minute limit on the `smoke` job, which the record may change with a `Smoke limit` bullet; the separate groups and soft lock of [§5.5](#55-the-fallback-if-the-probes-fail) if S0's item 2 fails.
   - (b) The same, with a fixed 60 minutes.
   - (c) Separate groups and the soft lock of §5.5, from the start.
   - Why: a real check with payments and emails can need more than 60 minutes, and a deploy waits at most that long. [§5](#5-one-run-per-environment-at-a-time).
4. **The smoke issue's title.**
   - (a) **(chosen)** A new issue per environment, `Smoke check on <environment> failed`, for deploy smoke failures and smoke-only failures alike, closed by the next passing check from any trigger.
   - (b) Keep `Deploy to <environment> failed` for both, with the body telling them apart.
   - Why: the title is what people read in a list, and a smoke-only run's pass can close it without a deploy. [§7.2](#72-what-each-job-says).
5. **The message kind for smoke-only runs.**
   - (a) **(chosen)** The `deploy` kind and `KANON_CHAT_DEPLOY`, with a new `source.lane`, `deploy-smoke`.
   - (b) A new `smoke` kind with its own secret, `KANON_CHAT_SMOKE`, so alerts can go to another channel than announcements.
   - Why: no new secret to store or check, and the stakeholders who see a release go live are the ones who need to know it broke. (b) can follow if an adopter asks. [§7.3](#73-a-smoke-only-runs-outcomes).
6. **A secret for the smoke and reset hooks.**
   - (a) **(chosen)** A new fixed name, `KANON_SMOKE_SECRET`, an environment secret, to the reset and smoke steps alone.
   - (b) Pass `KANON_DEPLOY_SECRET` to them as well.
   - (c) None: the hooks use the cloud role, and read anything else through it.
   - Why: a sandbox key or a test account's password isn't the deploy's secret, and the deploy's secret shouldn't reach a check that runs on a timer. [§11](#11-threat-model).
7. **Telemetry for smoke-only runs.**
   - (a) **(chosen)** A `smoke_check` row from the start (S2, S3).
   - (b) No row in the first release; add one when a metric needs it.
   - Why: the store's intake has to ship first either way for the `reset` stage, and without a row nobody can tell how often a schedule finds something. [§8](#8-telemetry).
8. **A schedule on production.**
   - (a) **(chosen)** Allowed, with doctor's note; blocked on any environment with required reviewers.
   - (b) Refused by doctor.
   - Why: it is the adopter's call, and the note makes the choice visible. [§4.3](#43-a-schedule-per-environment).
9. **A rule, `K-SHIP-13`.**
   - (a) **(chosen)** Add it: "A production deploy is followed by a smoke check, and smoke data lives where the product can't see it", class split, with doctor's no-op note as its only check.
   - (b) No rule; say it in `docs/lanes.md` as advice.
   - Why: the lane already runs a smoke check after every deploy, so the first half is true of every adopter of the lane, and the second half is the reason the reset hook exists. [§10](#10-rules-and-docs-that-change).
10. **Who may start a smoke run.**
    - (a) **(chosen)** A person, or the scheduler with a valid `via`; an App's token is refused.
    - (b) Anyone who can dispatch, Apps included.
    - Why: a smoke run writes to an environment. No lane needs to start one, and an agent that could would hold a write path to production's data that no reviewer saw. [§11](#11-threat-model).
11. **Diagnosing smoke failures.**
    - (a) **(chosen)** Only the run that filed the smoke issue.
    - (b) Every failed run.
    - Why: a check that fails every night until someone fixes it would otherwise cost a model run a night and add the same diagnosis to one issue again and again. [§14](#14-cost).
12. **A reset failure's outcome.**
    - (a) **(chosen)** The smoke check's outcome (`smoke_failed` after a deploy, `failed` in a smoke-only run) at a new stage, `reset`.
    - (b) An outcome of its own, `reset_failed`.
    - Why: for whoever reads the alert, the meaning is the same: the live release is unchecked. The stage says where. [§6](#6-the-reset-hook).
13. **Smoke runs under the `no-environments` fallback.**
    - (a) **(chosen)** Not offered; the deploy's own smoke step runs as today.
    - (b) Offered at the newest published release, with no protection and a doctor note.
    - Why: nothing there can hold a run to an environment's rules, or tell which release is live, which are the two things a smoke run outside a deploy rests on. [§4.4](#44-which-release-a-smoke-run-checks).

## Owner decisions (2026-10-21)

Two points the 2026-10-20 text left unstated, raised by the Reviewer in [#1162](https://github.com/yedeya-labs/kanon/issues/1162). The Owner decided both on 2026-10-21; they are numbered on from the thirteen above.

14. **A scheduled run that finds no caller (`no-caller`).** Until a release with `smoke.yml` is deployed to an environment, each scheduled run there finds no caller at the live tag ([§4.2](#42-on-demand-behind-the-environments-protection)).
    - (a) **(chosen)** The run goes red with a summary naming the environment and the missing release. It files no issue, posts no alert and writes no row. `K-OBS-16`'s refusal list is unchanged.
    - (b) The same, and a `smoke_check` row `refused` with a new refusal, `no-caller`.
    - (c) A smoke issue and an alert, as a failed check gets.
    - Why: decision 11's reasoning. The failure repeats every night until the next deploy, so an issue, an alert or a row a night is noise, and nothing was checked. Doctor's `deploy.smoke-caller-live` names it, and the scheduled run's graph, `route → dispatch`, needs no `record` job for it. [§4.2](#42-on-demand-behind-the-environments-protection), [§7.3](#73-a-smoke-only-runs-outcomes), [§8](#8-telemetry).
15. **How `via` reaches `declare`.**
    - (a) **(chosen)** A mapped input: the caller `kanon init` writes passes `via: ${{ github.event.inputs.via }}`, `deploy-smoke.yml` declares `via` as an optional input, and S5's `declare` (check 4) and the row's `trigger` read `inputs.via`. S6's caller test fails a caller that drops it.
    - (b) The called workflow reads the caller's event, `github.event.inputs.via`, as `deploy.yml` reads `release` today.
    - Why: one path that the caller, doctor's `deploy.smoke-caller-mismatch` and S6's test can each hold. Checked first against `actions/lane-check`, `tests/unit/workflows.test.ts` and the credential-reach guard: none objects ([§4.1](#41-the-caller-and-the-workflow)).

## Open questions

None open.
