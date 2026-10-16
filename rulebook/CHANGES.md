# How the rules changed

A rule says what holds now, and why. How it came to say that is recorded here, not in the rule: each change that a decision, an issue or a pull request made to a rule, under the rule's id, with its date, what changed and a link. A rule keeps the links that say where it came from, such as an ADR or a plan, and nothing else about its history. `tests/unit/rulebook-why.test.ts` fails a rule that carries a dated decision note, an issue link or a "Premise changed" paragraph, and an entry here that names a rule the chapters don't have.

Rules are listed in chapter order, and each rule's changes oldest first. A rule with no entry has not changed since it was written, or changed only in ways its own ADR or plan records.

## `K-PRIN-13`

- **2026-10-12.** The Owner decided that a run which exits silently, with no verdict, is retried once like a run that died of its cause, and that the retry counts as an attempt, so a second silent exit is reported. [#759](https://github.com/yedeya-labs/kanon/pull/759)

## `K-PRIN-16`

- **2026-10-14.** The Owner decided that a rule records no history of its own: a rule whose premise changed is rewritten so its Why states the premise that holds now, and the change is recorded here, not in a "Premise changed" note beside the rule. [#578](https://github.com/yedeya-labs/kanon/issues/578), [#859](https://github.com/yedeya-labs/kanon/pull/859)

## `K-AGENT-2`

- **2026-10-15.** The Owner decided that the Releaser may open a candidate's pin pull request, the one exception to its touching no file outside the release file set, where the adoption record declares the Workflows write that pull request needs. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)

## `K-AGENT-3`

- **2026-10-15.** The Owner decided that a repository widens one of its Apps beyond Kanon's shared grant only by declaring it, as an `Extra App permission` bullet under the adoption record's `## Choices`, which `kanon apps`, `apps-check` and doctor honour for that repository alone; the shared grant stays. Kanon declares Workflows write for its Releaser, for a candidate's pin pull request. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)

## `K-AGENT-24`

- **2026-10-12.** The Reviewer's token mint asks for Checks, Commit statuses and Actions read again, after a narrowing of its permissions dropped the reads this rule depends on; a test now fails a mint that drops any of the three. [#691](https://github.com/yedeya-labs/kanon/issues/691)

## `K-AGENT-37`

- **2026-10-15.** The Owner decided that a person may raise one lane's turn cap for one dispatched run, with a reason, up to a ceiling Kanon fixes per lane at twice the cap; nothing in an adopter's repository sets it. `agent-run`'s turn-limit step and `lane-check` enforce it, held by `tests/unit/agent-run-turn-budget.test.ts`. [ADR 0005](../docs/decisions/0005-roles-and-standard-lane-settings.md) §2, amended 2026-10-15; [#891](https://github.com/yedeya-labs/kanon/issues/891)

## `K-AGENT-42`

- **2026-10-15.** The classifier may read the turn count in one case: a run past its turn cap is exhausted when the step that ran it failed, which is the agent action's own check, since that action fails such a step while the run still reports itself completed. [#1008](https://github.com/yedeya-labs/kanon/issues/1008), [#1012](https://github.com/yedeya-labs/kanon/pull/1012)

## `K-AGENT-44`

- **2026-10-15.** The Owner decided that the sign-off delegation covers only the repository's agent Apps: a commit by an App on an `Other App` row, or by the Intake App, is checked like any other bot's commit and needs a person's sign-off. The `dco` check leaves those rows' slugs out. [#998](https://github.com/yedeya-labs/kanon/issues/998)

## `K-AGENT-45`

- **2026-10-14.** The Owner decided that the issue backstop admits whoever opens an issue, on `issues: opened` alone, with no permission check, since it runs no model, reads no issue text and writes only a bucket and labels. [#768](https://github.com/yedeya-labs/kanon/issues/768), [#840](https://github.com/yedeya-labs/kanon/pull/840)

## `K-AGENT-47`

- **2026-10-07.** `lane-check` holds every job that calls a Kanon workflow, the spine `agent-lane.yml` included, to mapping each secret by name or passing none, and fails `secrets: inherit`. Releases before this one let it through on a call to the spine. [#500](https://github.com/yedeya-labs/kanon/issues/500)
- **2026-10-14.** The Owner's plan for the deploy lane amended the rule: a Kanon workflow may read an environment secret only by a fixed name, in a job that sets `environment:`, and only where its own guard test names it, since GitHub can't pass an environment secret from a caller to a called workflow; today that is `KANON_DEPLOY_SECRET` in `deploy.yml`'s `deploy` job. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-AGENT-49`

- **2026-10-15.** The guard counts Kanon's `notify` block, `actions/notify`, as running someone else's code, since it runs the adopter's notify hook from the checkout, so a job that runs the block and holds an App's private key fails it. [Plan 0011](../docs/plans/0011-notifications.md) N6, [#1018](https://github.com/yedeya-labs/kanon/pull/1018)

## `K-AGENT-50`

- **2026-10-06.** The shared lane job turns git's `core.symlinks` off for a lane with project setup off, so the Lead's `Edit(/docs/**)` has no symlink in the tree to write through. [#327](https://github.com/yedeya-labs/kanon/issues/327)
- **2026-10-07.** The grant probe battery covers both Lead lanes' flags, and the Owner decided the deny list that refuses a program handed to `git push` or `git fetch` for the far end. [#405](https://github.com/yedeya-labs/kanon/issues/405)
- **2026-10-14.** The Owner decided that the `notify` job of `K-OBS-19` joins the guard's named exceptions in that rule's exact shape, and that it runs the adopter's notify hook at the run's commit on any branch, accepting that whoever can push a branch and dispatch a notifying lane can read that lane's chat secret. [Plan 0011](../docs/plans/0011-notifications.md), [#839](https://github.com/yedeya-labs/kanon/issues/839)

## `K-MERGE-4`

- **2026-10-12.** The Owner decided that the project's own pipeline code may be declared as single files as well as directories. [#728](https://github.com/yedeya-labs/kanon/issues/728)
- **2026-10-14.** The Owner decided that a library the project's own lanes run only at a pinned release is product, not pipeline code, since it reaches those lanes only through the release and the pin bump, which both escalate. [#728](https://github.com/yedeya-labs/kanon/issues/728)

## `K-MERGE-7`

- **2026-10-07.** `kanon init` doesn't require `Lane check` under a merge queue until its workflow runs on `merge_group`, and `kanon doctor` reports the check unreported (`ruleset.check-unreported`). [#459](https://github.com/yedeya-labs/kanon/issues/459)

## `K-MERGE-8`

- **2026-10-06.** `kanon apps` adds the optional Releaser App to the default branch's ruleset's bypass list, and `kanon doctor` reports a ruleset that lacks it or lets another actor bypass. [#49](https://github.com/yedeya-labs/kanon/issues/49)

## `K-MERGE-13`

- **2026-10-12.** The Owner decided that a pull request with no behaviour change proves itself with a characterization test: the red-test check concludes skipped, never failed, and the pull request states the mutations that turn its test red. [#666](https://github.com/yedeya-labs/kanon/issues/666)

## `K-MERGE-17`

- **2026-10-02.** Kanon's own DCO and PR-title checks run the last release, and the pull request's copy runs beside them as a test that isn't required. [#47](https://github.com/yedeya-labs/kanon/issues/47)

## `K-SHIP-7`

- **2026-10-12.** The Owner decided that a project whose releases other repositories pin may declare a release cadence, and that a project which declares none releases on every merge. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md), [#760](https://github.com/yedeya-labs/kanon/pull/760)
- **2026-10-14.** Release tags drive the deploy through the stages the project declares, not to a pre-production stage alone, and that deploy is Kanon's deploy lane: a published release runs `deploy-release.yml`, then `deploy.yml` for each environment the adoption record declares, in order. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-SHIP-8`

- **2026-10-14.** The deploy lane's gate is what holds a red main back: it deploys a release only once the release commit's `ci.yml` push run is green, and files the refusal as a deploy issue. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-SHIP-9`

- **2026-10-14.** Production is the last environment of the declared chain, its required reviewer gates `deploy.yml`'s job, and `kanon doctor` blocks without one; the fallback is a dispatch the Maintainer starts. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-SHIP-12`

- **2026-10-15.** The deploy lane holds one more secret, the announcement's `KANON_CHAT_DEPLOY`, declared by `deploy.yml` as optional and read by its `notify` job alone, which holds no cloud credential; the guard admits exactly that. [Plan 0011](../docs/plans/0011-notifications.md) N9, [#972](https://github.com/yedeya-labs/kanon/issues/972)

## `K-SHIP-10`

- **2026-10-14.** The rule is prose only: Kanon's deploy lane announces nothing, so the announcement stays the project's own step. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-14.** The rule is enforced by the `notify` job of `K-OBS-19`: a deploy's announcement is a `deploy` message posted by a job of its own, so a failed post never reads as a failed deploy, and the announced version moves only after the post. [Plan 0011](../docs/plans/0011-notifications.md), [#839](https://github.com/yedeya-labs/kanon/issues/839)
- **2026-10-15.** The Owner decided that each environment announces its own deploy, that a failure posts too (`critical` for production), and that what was announced is read from the environment's previous successful deployment rather than kept in a variable moved after the post. The deploy lane runs the announcement. [Plan 0011](../docs/plans/0011-notifications.md) N9, [#972](https://github.com/yedeya-labs/kanon/issues/972)
- **2026-10-16.** The range holds only releases of the deployed tag's line, so a prefixed tag (`widgets-v1.2.3`) is announced, and under the `no-environments` fallback, with no deployment to read, each deploy announces its own release alone. [#1038](https://github.com/yedeya-labs/kanon/issues/1038), [#1039](https://github.com/yedeya-labs/kanon/issues/1039)

## `K-PROJ-16`

- **2026-10-02.** A test runs the brief guard on the brief template, whose example measurement item it must accept. [#55](https://github.com/yedeya-labs/kanon/issues/55)

## `K-OBS-12`

- **2026-10-15.** A run whose turn cap a person raised for one dispatch gets its dollar ceiling derived from the raised cap at the same per-turn rate, by `agent-run`'s turn-limit step, held by `tests/unit/agent-run-turn-budget.test.ts`. [ADR 0005](../docs/decisions/0005-roles-and-standard-lane-settings.md) §2, amended 2026-10-15; [#891](https://github.com/yedeya-labs/kanon/issues/891)

## `K-OBS-16`

- **2026-10-07.** [ADR 0007](../docs/decisions/0007-data-boundary.md) was amended so that an upstream-finding row sent with evidence may carry the finding's evidence and suggested fix as scrubbed text. [#573](https://github.com/yedeya-labs/kanon/pull/573)
- **2026-10-14.** The Owner decided a fourth row kind, the deploy row, which records an environment's role and position in the declared chain, never its name, and no release tag or commit; [ADR 0007](../docs/decisions/0007-data-boundary.md) was amended to match. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-14.** The rule names a fifth row kind, the notify row, which records one `notify` job's outcome and the hook's kind, never a URL, a channel, a host, text, a status body or a secret, and is stored but not published; [ADR 0007](../docs/decisions/0007-data-boundary.md) was amended to match. [Plan 0011](../docs/plans/0011-notifications.md), [#943](https://github.com/yedeya-labs/kanon/issues/943)

## `K-ADOPT-1`

- **2026-10-14.** Step 10 names the adoption record's `- **Chat channel:**` bullet under `## Choices`, and the answers it records: Kanon's Slack hook, Kanon's generic JSON webhook hook, the project's own hook, or none yet. [Plan 0011](../docs/plans/0011-notifications.md), [#839](https://github.com/yedeya-labs/kanon/issues/839)

## `K-ADOPT-3`

- **2026-10-14.** The deploy lane's fallback: where the plan provides no environments or no required reviewers, the adoption record marks it in `## Deploy`, production deploys only in the Maintainer's dispatch, and under `no-environments` the trust probe is skipped. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-ADOPT-8`

- **2026-10-15.** The Owner decided that an App may hold, beyond its roles' rows, an extra permission its repository's adoption record declares, for that repository alone, and that `apps-check` and doctor hold each App to its grant plus that declaration. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)

## `K-ADOPT-11`

- **2026-10-06.** The Skill's pin, declared in the repository's `.claude/settings.json`, moves with the other pins, and `kanon doctor` reports one that differs from the release the callers pin. [#376](https://github.com/yedeya-labs/kanon/issues/376)
- **2026-10-12.** The Owner decided that a reference may pin a candidate, `candidate-vX.Y.Z`, as well as a stable release, and that a candidate beside its own stable release counts as two versions. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md), [#760](https://github.com/yedeya-labs/kanon/pull/760)
- **2026-10-14.** The Owner decided that a prebuilt notify hook's pin of its Kanon action follows the callers' pin, and that a hook behind them works while it declares a contract version their release still writes. So that pin isn't counted toward the one version: it may be behind the callers', never ahead of them or on a contract version their release no longer writes. `lane-check` and `kanon doctor` both leave it out of the one version. [Plan 0011](../docs/plans/0011-notifications.md) decision 18, [#955](https://github.com/yedeya-labs/kanon/issues/955)

## `K-OBS-19`

- **2026-10-15.** The guards the rule names are built: Kanon's `notify` block, `actions/notify`, with `tests/unit/helpers/notify-jobs.ts`, `tests/unit/notify-guard.test.ts` and `tests/library/notify-block.test.ts`, `K-AGENT-50`'s guard admitting the `notify` job only in its exact shape, and `K-AGENT-49`'s counting the block as running the adopter's code. The block publishes its outcome, `posted`, `failed` or `skipped`, as an output, since a skip leaves the job green. No lane runs it until the digests move. [Plan 0011](../docs/plans/0011-notifications.md) N6, [#839](https://github.com/yedeya-labs/kanon/issues/839), [#972](https://github.com/yedeya-labs/kanon/issues/972)

## `K-LAYOUT-1`

- **2026-10-14.** The deploy lane's three hooks, `.github/actions/build`, `.github/actions/deploy` and `.github/actions/smoke`, and the adoption record's `## Deploy` section, joined the fixed paths. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-14.** The notify hook, `.github/actions/notify/action.yml`, joined the fixed paths. [Plan 0011](../docs/plans/0011-notifications.md), [#839](https://github.com/yedeya-labs/kanon/issues/839)

## `K-LAYOUT-6`

- **2026-10-15.** The Maintainer decided that the register holds every App installed on the repository that isn't an agent, under one generic role, so an adopter can register any such App. The role is `Other App`, with one row per App, each naming an App no other row names; the readers that map a role to a login, the membership gate among them, never read those rows. [#990](https://github.com/yedeya-labs/kanon/issues/990)
- **2026-10-15.** The Owner decided that the sign-off check reads no `Other App` row, nor the Intake row, so the sign-off delegation never covers an App that isn't an agent. [#998](https://github.com/yedeya-labs/kanon/issues/998)

## `K-LAYOUT-8`

- **2026-10-12.** The Owner decided that `## Pipeline code` may name a single file, which covers exactly that file, as well as a directory. [#728](https://github.com/yedeya-labs/kanon/issues/728)

## `K-LAYOUT-10`

- **2026-10-07.** The Owner decided that, under `drafted`, the telemetry Explorer writes each upstream finding into its run's step summary, rendered as it would be filed. [#471](https://github.com/yedeya-labs/kanon/pull/471)
- **2026-10-12.** The Owner decided the release cadence choice: `every merge`, or `weekly, ` and a weekday. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md), [#760](https://github.com/yedeya-labs/kanon/pull/760)
- **2026-10-14.** The Owner decided that the adoption record has a `## Deploy` section of its own, holding the deploy lane's environments, its CI wait and the fallback's marker, and that the reference deploy's three bullets move there from `## Choices` at once, with no period of reading both places. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-15.** The gate never waits longer than 345 minutes for the release commit's CI, whatever the record declares, so a CI that never finishes ends in `ci-timeout`, which is filed, inside the gate job's 360-minute limit, not in a cancellation, which files nothing. [#912](https://github.com/yedeya-labs/kanon/issues/912), [#961](https://github.com/yedeya-labs/kanon/pull/961)
- **2026-10-15.** The Owner decided the extra App permission choice: one bullet per App and permission under `## Choices`, with its reason, which widens that repository's App alone. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)

## `K-LAYOUT-16`

- **2026-10-03.** The Owner chose the contract, a project-declared database the lanes find in `DATABASE_URL`, over a Kanon-maintained standard database. [#139](https://github.com/yedeya-labs/kanon/pull/139)

## `K-LAYOUT-18`

- **2026-10-12.** The rule's premise changed: Kanon's scripts look a lane's caller up on the default branch and list and dispatch that, so a caller under another name is found where the default branch can be read. They fall back to the lane's file name only when it can't be read or no caller is found. The rule stands. [#726](https://github.com/yedeya-labs/kanon/issues/726)
