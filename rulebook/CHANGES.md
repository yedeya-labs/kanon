# How the rules changed

A rule says what holds now, and why. How it came to say that is recorded here, not in the rule: each change that a decision, an issue or a pull request made to a rule, under the rule's id, with its date, what changed and a link. A rule keeps the links that say where it came from, such as an ADR or a plan, and nothing else about its history. `tests/unit/rulebook-why.test.ts` fails a rule that carries a dated decision note, an issue link or a "Premise changed" paragraph, and an entry here that names a rule the chapters don't have.

Rules are listed in chapter order, and each rule's changes oldest first. A rule with no entry has not changed since it was written, or changed only in ways its own ADR or plan records.

## `K-PRIN-13`

- **2026-10-12.** The Owner decided that a run which exits silently, with no verdict, is retried once like a run that died of its cause, and that the retry counts as an attempt, so a second silent exit is reported. [#759](https://github.com/yedeya-labs/kanon/pull/759)

## `K-PRIN-16`

- **2026-10-14.** The Owner decided that a rule records no history of its own: a rule whose premise changed is rewritten so its Why states the premise that holds now, and the change is recorded here, not in a "Premise changed" note beside the rule. [#578](https://github.com/yedeya-labs/kanon/issues/578), [#859](https://github.com/yedeya-labs/kanon/pull/859)

## `K-WORK-3`

- **2026-10-21.** The Owner decided that a roadmap milestone may be created for a single project's work, its title and due date the Stakeholder's decision whoever creates it. [#853](https://github.com/yedeya-labs/kanon/issues/853)

## `K-WORK-4`

- **2026-10-20.** The filing skill's `plan` takes the filer's judgment of the subject, so pipeline work reaches the platform bucket without the `pipeline-improvement` label. Replaying the backstop's shadow over a week of filings found filers routing review follow-ups about the pipeline there, rightly, where a label-only `plan` sent them to the product bucket. [#164](https://github.com/yedeya-labs/kanon/issues/164)
- **2026-10-21.** The planning module's `plan` refuses pipeline work on the product bucket, even when a brief names it, so the Lead's reconcile tick stops on such a brief item and the brief guard reports it on the brief's pull request. [#1161](https://github.com/yedeya-labs/kanon/issues/1161)

## `K-WORK-7`

- **2026-10-21.** No longer prose only: the issue backstop takes the milestone off a pull request when one is set, on `pull_request_target`, so a fork's pull request is covered too, and a test fails when a search Kanon sends can count pull requests with issues. Sixty-seven of Kanon's pull requests had been put on a bucket, and nothing caught it. [#1242](https://github.com/yedeya-labs/kanon/issues/1242)

## `K-WORK-8`

- **2026-10-20.** No longer prose only: the filing skill runs the planning module's `plan`, and a test fails when the skill stops running it or when a lane that files through it restates the routing in its prompt. The Explorer's sweep is the first lane moved. [#164](https://github.com/yedeya-labs/kanon/issues/164)
- **2026-10-20.** The code audit moved onto the filing skill, and the test holds its playbook's "Code-reading mode" section to restating no routing too. [#164](https://github.com/yedeya-labs/kanon/issues/164)
- **2026-10-20.** Verify-acs moved onto the filing skill, and the test holds the baseline playbook's "Targeted-invariant mode" section to restating no routing too. [#164](https://github.com/yedeya-labs/kanon/issues/164)
- **2026-10-20.** Merge reconcile moved onto the filing skill. It reads the Reviewer's "Capturing follow-ups" section, which still routes until the Reviewer moves, so the test holds its prompt to saying the skill replaces that section's milestone lines. [#164](https://github.com/yedeya-labs/kanon/issues/164)
- **2026-10-20.** The Reviewer moved onto the filing skill, and its playbook's "Capturing follow-ups" names no milestone, in Kanon's own playbook and in the baseline, so the test holds that section to restating no routing for both the Reviewer and merge reconcile, and merge reconcile's prompt no longer says the skill overrides it. [#164](https://github.com/yedeya-labs/kanon/issues/164)
- **2026-10-20.** The Lead's reconcile tick, last, files a brief's issues with the labels and milestone `plan` gives, the brief's milestone transcribed, and stops on an item `plan` refuses. The test now holds every lane prompt that files an issue to the skill, not only the lanes it lists. [#164](https://github.com/yedeya-labs/kanon/issues/164)
- **2026-10-21.** The Overseer's filer and the workflow-health check call `plan` for their routing, and `tests/unit/script-filers-plan.test.ts` fails when either names a bucket or passes a milestone of its own. [#1194](https://github.com/yedeya-labs/kanon/issues/1194)
- **2026-10-21.** The telemetry Explorer's filer calls `plan` for its routing too, naming its findings product work, in place of the backstop's `decide()`, and the same test holds it to naming no bucket and passing no milestone of its own. [#1220](https://github.com/yedeya-labs/kanon/issues/1220)

## `K-WORK-9`

- **2026-10-20.** The planning module's `plan` refuses a reviewer follow-up with no severity, so the Lead's reconcile tick stops on such a brief item, and the brief guard reports it on the brief's pull request. [#164](https://github.com/yedeya-labs/kanon/issues/164)

## `K-WORK-11`

- **2026-10-20.** No longer prose only for pipeline work: `plan`, which the filing skill runs, refuses it on a roadmap milestone and never makes it a candidate, so the Lead's reconcile tick stops on such a brief item, and the brief guard reports it on the brief's pull request. [#164](https://github.com/yedeya-labs/kanon/issues/164), [#1163](https://github.com/yedeya-labs/kanon/issues/1163)
- **2026-10-21.** `plan` refuses pipeline work on the product bucket too, where the backstop, which reads labels and not the filer's subject, would have added `gate-candidate` to a gate-severity reviewer follow-up that `plan` filed without it. [#1161](https://github.com/yedeya-labs/kanon/issues/1161)

## `K-WORK-12`

- **2026-10-20.** The Merger applies `agent:revise` too, to hand an approved head whose checks failed back to the Implementer's revise lane; the label's description says so. [#1100](https://github.com/yedeya-labs/kanon/issues/1100)
- **2026-10-20.** The taxonomy gained `lead:file-only`, which a person puts on a project's tracking issue so that the Lead files and reconciles the project's issues but dispatches none of them; `needs:human` keeps its meaning as the escalation that stops the whole tick. [#1113](https://github.com/yedeya-labs/kanon/issues/1113)
- **2026-10-21.** Deleting GitHub's defaults is no longer prose only: `kanon init` already deleted them with the person's consent, and `kanon doctor` now reports each one a repository still has, without blocking. Kanon itself still had all seven. [#1246](https://github.com/yedeya-labs/kanon/issues/1246)

## `K-WORK-23`

- **2026-10-21.** No longer prose only for the tracking issue: the brief guard reads issue `<n>` for each `docs/projects/<n>.md` and fails when it lacks a kind label, isn't on the bucket that matches it, or carries `project:<n>`. Kanon's one brief's tracking issue had no kind label. [#1245](https://github.com/yedeya-labs/kanon/issues/1245)

## `K-AGENT-2`

- **2026-10-15.** The Owner decided that the Releaser may open a candidate's pin pull request, the one exception to its touching no file outside the release file set, where the adoption record declares the Workflows write that pull request needs. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)

## `K-AGENT-3`

- **2026-10-15.** The Owner decided that a repository widens one of its Apps beyond Kanon's shared grant only by declaring it, as an `Extra App permission` bullet under the adoption record's `## Choices`, which `kanon apps`, `apps-check` and doctor honour for that repository alone; the shared grant stays. Kanon declares Workflows write for its Releaser, for a candidate's pin pull request. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)

## `K-AGENT-24`

- **2026-10-12.** The Reviewer's token mint asks for Checks, Commit statuses and Actions read again, after a narrowing of its permissions dropped the reads this rule depends on; a test now fails a mint that drops any of the three. [#691](https://github.com/yedeya-labs/kanon/issues/691)
- **2026-10-20.** The Reviewer's flags also grant the filing skill's plan command, as `kanon-plan`, a wrapper the job puts on the agent's PATH that runs Kanon's planning script and nothing else; the test runs the wrapper, and the probe battery gains a probe that it is allowed and two that a command chained or redirected after it is refused. [#164](https://github.com/yedeya-labs/kanon/issues/164)

## `K-AGENT-37`

- **2026-10-15.** The Owner decided that a person may raise one lane's turn cap for one dispatched run, with a reason, up to a ceiling Kanon fixes per lane at twice the cap; nothing in an adopter's repository sets it. `agent-run`'s turn-limit step and `lane-check` enforce it, held by `tests/unit/agent-run-turn-budget.test.ts`. [ADR 0005](../docs/decisions/0005-roles-and-standard-lane-settings.md) §2, amended 2026-10-15; [#891](https://github.com/yedeya-labs/kanon/issues/891)

## `K-AGENT-42`

- **2026-10-15.** The classifier may read the turn count in one case: a run past its turn cap is exhausted when the step that ran it failed, which is the agent action's own check, since that action fails such a step while the run still reports itself completed. [#1008](https://github.com/yedeya-labs/kanon/issues/1008), [#1012](https://github.com/yedeya-labs/kanon/pull/1012)

## `K-AGENT-44`

- **2026-10-15.** The Owner decided that the sign-off delegation covers only the repository's agent Apps: a commit by an App on an `Other App` row, or by the Intake App, is checked like any other bot's commit and needs a person's sign-off. The `dco` check leaves those rows' slugs out. [#998](https://github.com/yedeya-labs/kanon/issues/998)
- **2026-10-16.** The Why says what passes such an App's commit: a person re-authoring it and signing it off, since a sign-off counts only when it is the author's, so a person's sign-off added to a bot's commit never passes it. The check is unchanged. [#1036](https://github.com/yedeya-labs/kanon/issues/1036)

## `K-AGENT-45`

- **2026-10-14.** The Owner decided that the issue backstop admits whoever opens an issue, on `issues: opened` alone, with no permission check, since it runs no model, reads no issue text and writes only a bucket and labels. [#768](https://github.com/yedeya-labs/kanon/issues/768), [#840](https://github.com/yedeya-labs/kanon/pull/840)

## `K-AGENT-47`

- **2026-10-07.** `lane-check` holds every job that calls a Kanon workflow, the spine `agent-lane.yml` included, to mapping each secret by name or passing none, and fails `secrets: inherit`. Releases before this one let it through on a call to the spine. [#500](https://github.com/yedeya-labs/kanon/issues/500)
- **2026-10-14.** The Owner's plan for the deploy lane amended the rule: a Kanon workflow may read an environment secret only by a fixed name, in a job that sets `environment:`, and only where its own guard test names it, since GitHub can't pass an environment secret from a caller to a called workflow; today that is `KANON_DEPLOY_SECRET` in `deploy.yml`'s `deploy` job. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-16.** A measurement in the sandbox showed that GitHub evaluates a caller's secret mapping in the called job's scope, the environment's secret first, and that a secret the caller doesn't map is empty there. The rule now says the caller maps `KANON_DEPLOY_SECRET` by that one name, and `deploy.yml` declares it optional; the amendment of 2026-10-14 had said no caller could map it. [#1049](https://github.com/yedeya-labs/kanon/issues/1049)
- **2026-10-20.** The Owner's plan for the smoke lifecycle fixed a second environment-secret name, `KANON_SMOKE_SECRET`, which the project's reset and smoke hooks read in the job that runs them, and which the deploy hook never sees, because a sandbox key or a test account's password isn't the deploy's secret. Nothing reads it yet: the guard admits it once the lane passes it. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) §11, [#1165](https://github.com/yedeya-labs/kanon/issues/1165)

## `K-AGENT-48`

- **2026-10-20.** The Owner decided that a `pull_request_target` workflow may check out a head on the base repository, never a fork's, when it refuses a fork's head before any checkout and no step runs the head's tree, and that only the agent of a lane `K-AGENT-50` accepts may run that tree. The review lane's checkout and fetch of the head it reviews and the rebase lane's full-history checkout are the named exceptions. The rebase lane now refuses a fork's head itself. The guard now follows every call into Kanon's workflows and actions, counts a head handed down as an input, and fails when it reads no step, where before it read only the steps of a file that declares the trigger, and Kanon's three such files have none. [#1128](https://github.com/yedeya-labs/kanon/issues/1128)

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

## `K-MERGE-9`

- **2026-10-20.** A check that fails on an approved head of the Implementer's own PR is a recover, not an escalation: the Merger hands the head back to the revise lane once, with the failed checks named, and escalates `checks-failed` only when that head is still red afterwards. Before, it escalated at once, and nothing else in the pipeline acted on an approved head. [#1100](https://github.com/yedeya-labs/kanon/issues/1100)

## `K-MERGE-13`

- **2026-10-12.** The Owner decided that a pull request with no behaviour change proves itself with a characterization test: the red-test check concludes skipped, never failed, and the pull request states the mutations that turn its test red. [#666](https://github.com/yedeya-labs/kanon/issues/666)
- **2026-10-20.** The red-test check reads which files are tests, and their runners, from the default branch's stack document instead of the pull request's, and fails a pull request that changes them instead of skipping it. It runs its verifier with Kanon's Node by absolute path, after the pull request's setup hook. The Owner decided that refusing is right, so a new tests tree or runner lands first in its own pull request, and that the rule states what the check guards against: a test that proves nothing, not a pull request built to defeat it. [#761](https://github.com/yedeya-labs/kanon/issues/761)

## `K-MERGE-17`

- **2026-10-02.** Kanon's own DCO and PR-title checks run the last release, and the pull request's copy runs beside them as a test that isn't required. [#47](https://github.com/yedeya-labs/kanon/issues/47)
- **2026-10-20.** The red-test check, which both judges a pull request and runs it, reads the stack document's code areas from the default branch. [#761](https://github.com/yedeya-labs/kanon/issues/761)

## `K-SHIP-7`

- **2026-10-12.** The Owner decided that a project whose releases other repositories pin may declare a release cadence, and that a project which declares none releases on every merge. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md), [#760](https://github.com/yedeya-labs/kanon/pull/760)
- **2026-10-14.** Release tags drive the deploy through the stages the project declares, not to a pre-production stage alone, and that deploy is Kanon's deploy lane: a published release runs `deploy-release.yml`, then `deploy.yml` for each environment the adoption record declares, in order. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-SHIP-8`

- **2026-10-14.** The deploy lane's gate is what holds a red main back: it deploys a release only once the release commit's `ci.yml` push run is green, and files the refusal as a deploy issue. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-SHIP-9`

- **2026-10-14.** Production is the last environment of the declared chain, its required reviewer gates `deploy.yml`'s job, and `kanon doctor` blocks without one; the fallback is a dispatch the Maintainer starts. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-SHIP-12`

- **2026-10-15.** The deploy lane holds one more secret, the announcement's `KANON_CHAT_DEPLOY`, declared by `deploy.yml` as optional and read by its `notify` job alone, which holds no cloud credential; the guard admits exactly that. [Plan 0011](../docs/plans/0011-notifications.md) N9, [#972](https://github.com/yedeya-labs/kanon/issues/972)
- **2026-10-16.** `deploy.yml` declares `KANON_DEPLOY_SECRET` optional too, which the caller maps by that name so that GitHub resolves it in the deploy job's environment; the guard admits exactly the two optional declarations. [#1049](https://github.com/yedeya-labs/kanon/issues/1049)
- **2026-10-20.** The deploy path gained the workflow that checks a deployed environment outside a deploy, `deploy-smoke.yml`, which runs no model either and obtains the cloud credential only in its one job that resets or smokes an environment; and a second secret, `KANON_SMOKE_SECRET`, which reaches the reset and smoke hooks' steps alone, never the deploy hook's. Neither the workflow nor the secret ships yet, so that half is prose only. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) §10, [#1165](https://github.com/yedeya-labs/kanon/issues/1165)
- **2026-10-20.** The guard holds the reset hook's step, new in `deploy.yml`, and the smoke hook's to no secret: each gets `KANON_SMOKE_TRIGGER` alone. The smoke secret still reaches nothing. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) S4, [#1147](https://github.com/yedeya-labs/kanon/issues/1147)

## `K-SHIP-13`

- **2026-10-20.** The reset step is no longer prose only: the deploy lane runs the project's reset hook just before the smoke hook when the project has one, and skips the check when the reset fails. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) S4, [#1147](https://github.com/yedeya-labs/kanon/issues/1147)

## `K-SHIP-10`

- **2026-10-14.** The rule is prose only: Kanon's deploy lane announces nothing, so the announcement stays the project's own step. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-14.** The rule is enforced by the `notify` job of `K-OBS-19`: a deploy's announcement is a `deploy` message posted by a job of its own, so a failed post never reads as a failed deploy, and the announced version moves only after the post. [Plan 0011](../docs/plans/0011-notifications.md), [#839](https://github.com/yedeya-labs/kanon/issues/839)
- **2026-10-15.** The Owner decided that each environment announces its own deploy, that a failure posts too (`critical` for production), and that what was announced is read from the environment's previous successful deployment rather than kept in a variable moved after the post. The deploy lane runs the announcement. [Plan 0011](../docs/plans/0011-notifications.md) N9, [#972](https://github.com/yedeya-labs/kanon/issues/972)
- **2026-10-16.** The range holds only releases of the deployed tag's line, so a prefixed tag (`widgets-v1.2.3`) is announced, and under the `no-environments` fallback, with no deployment to read, each deploy announces its own release alone. [#1038](https://github.com/yedeya-labs/kanon/issues/1038), [#1039](https://github.com/yedeya-labs/kanon/issues/1039)
- **2026-10-20.** The title and the rule name a third confusion, which the Owner's plan for the smoke lifecycle found in the announcement an adopter was reading: a failed smoke check after a deploy that landed is a failed check of a live release, never a failed deploy, and never skipped. The message already told the two apart; that it also says the release is live, and lists its changes, is prose only until it does. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) §7.2, [#1165](https://github.com/yedeya-labs/kanon/issues/1165)
- **2026-10-20.** No longer prose only for the live release: a `smoke_failed` deploy is announced as the landed message, flagged, with the changes an `ok` deploy lists, and its test holds that it never reads "failed to deploy" and is never skipped. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) S4, [#1147](https://github.com/yedeya-labs/kanon/issues/1147)
- **2026-10-21.** The Owner decided that a failed announcement never blocks a deploy: the deploy lane's `notify` job continues on error, so a failed post still turns it red but leaves its environment's call green and the next environment deploys. A sandbox run measured that a re-run of the failed `notify` job, by job or with the failed jobs, re-runs the next environment's deploy too, so the repair is no longer a re-run of the deploy run. [#1048](https://github.com/yedeya-labs/kanon/issues/1048)

## `K-PROJ-11`

- **2026-10-20.** The dispatch phase can be withheld on its own: with `lead:file-only` on the tracking issue every other phase runs, each tick names the issues it did not dispatch, and removing the label resumes dispatch. Before, the only stop was `needs:human`, which also stopped the filing. [#1113](https://github.com/yedeya-labs/kanon/issues/1113)
- **2026-10-21.** The Owner decided that a roadmap milestone created for, and filled by, one project is allowed: what stays forbidden is a milestone kind or a bucket of a project's own. Before, the rule forbade a project any milestone of its own, which also ruled out a dated roadmap milestone the Stakeholder created for it. [#853](https://github.com/yedeya-labs/kanon/issues/853)

## `K-PROJ-16`

- **2026-10-02.** A test runs the brief guard on the brief template, whose example measurement item it must accept. [#55](https://github.com/yedeya-labs/kanon/issues/55)

## `K-OBS-12`

- **2026-10-15.** A run whose turn cap a person raised for one dispatch gets its dollar ceiling derived from the raised cap at the same per-turn rate, by `agent-run`'s turn-limit step, held by `tests/unit/agent-run-turn-budget.test.ts`. [ADR 0005](../docs/decisions/0005-roles-and-standard-lane-settings.md) §2, amended 2026-10-15; [#891](https://github.com/yedeya-labs/kanon/issues/891)

## `K-OBS-16`

- **2026-10-07.** [ADR 0007](../docs/decisions/0007-data-boundary.md) was amended so that an upstream-finding row sent with evidence may carry the finding's evidence and suggested fix as scrubbed text. [#573](https://github.com/yedeya-labs/kanon/pull/573)
- **2026-10-14.** The Owner decided a fourth row kind, the deploy row, which records an environment's role and position in the declared chain, never its name, and no release tag or commit; [ADR 0007](../docs/decisions/0007-data-boundary.md) was amended to match. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-14.** The rule names a fifth row kind, the notify row, which records one `notify` job's outcome and the hook's kind, never a URL, a channel, a host, text, a status body or a secret, and is stored but not published; [ADR 0007](../docs/decisions/0007-data-boundary.md) was amended to match. [Plan 0011](../docs/plans/0011-notifications.md), [#943](https://github.com/yedeya-labs/kanon/issues/943)
- **2026-10-20.** The Owner decided (plan 0009 decision 10) that a run row may name the kind of Claude credential it ran on, `subscription` or `api-key`, chosen by which secret the caller mapped and never from anything the secret holds. [Plan 0009 §12](../docs/plans/0009-release-channels-and-api-key.md#12-cost-what-was-paid), [#579](https://github.com/yedeya-labs/kanon/issues/579)
- **2026-10-20.** The Owner decided (plan 0013 decisions 7 and 12) a sixth row kind, the smoke-check row, which records one smoke run outside a deploy by the environment's role and position, never its name, a release, a commit, a URL or anything the hooks print; and that the deploy row records the reset hook's stage and duration. [ADR 0007](../docs/decisions/0007-data-boundary.md) was amended to match. [Plan 0013 §8](../docs/plans/0013-smoke-lifecycle.md#8-telemetry), [#1147](https://github.com/yedeya-labs/kanon/issues/1147)

## `K-ADOPT-1`

- **2026-10-14.** Step 10 names the adoption record's `- **Chat channel:**` bullet under `## Choices`, and the answers it records: Kanon's Slack hook, Kanon's generic JSON webhook hook, the project's own hook, or none yet. [Plan 0011](../docs/plans/0011-notifications.md), [#839](https://github.com/yedeya-labs/kanon/issues/839)

## `K-ADOPT-3`

- **2026-10-14.** The deploy lane's fallback: where the plan provides no environments or no required reviewers, the adoption record marks it in `## Deploy`, production deploys only in the Maintainer's dispatch, and under `no-environments` the trust probe is skipped. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)

## `K-ADOPT-8`

- **2026-10-15.** The Owner decided that an App may hold, beyond its roles' rows, an extra permission its repository's adoption record declares, for that repository alone, and that `apps-check` and doctor hold each App to its grant plus that declaration. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)

## `K-ADOPT-9`

- **2026-10-21.** The Owner decided that a mechanism the repository has nothing for, such as a deploy lane where nothing deploys, is marked **not applicable** rather than not yet installed, with the repository's reason under `## Choices`, so the list keeps the work still to do apart from what never applies; `kanon doctor` fails a not-applicable row without its reason. [#1236](https://github.com/yedeya-labs/kanon/issues/1236)
- **2026-10-21.** On Kanon's own record, whether each status is true is no longer prose only: a test holds each row to what Kanon's workflows run, and names the row to flip when they disagree. [#1236](https://github.com/yedeya-labs/kanon/issues/1236)

## `K-ADOPT-11`

- **2026-10-06.** The Skill's pin, declared in the repository's `.claude/settings.json`, moves with the other pins, and `kanon doctor` reports one that differs from the release the callers pin. [#376](https://github.com/yedeya-labs/kanon/issues/376)
- **2026-10-12.** The Owner decided that a reference may pin a candidate, `candidate-vX.Y.Z`, as well as a stable release, and that a candidate beside its own stable release counts as two versions. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md), [#760](https://github.com/yedeya-labs/kanon/pull/760)
- **2026-10-14.** The Owner decided that a prebuilt notify hook's pin of its Kanon action follows the callers' pin, and that a hook behind them works while it declares a contract version their release still writes. So that pin isn't counted toward the one version: it may be behind the callers', never ahead of them or on a contract version their release no longer writes. `lane-check` and `kanon doctor` both leave it out of the one version. [Plan 0011](../docs/plans/0011-notifications.md) decision 18, [#955](https://github.com/yedeya-labs/kanon/issues/955)
- **2026-10-18.** The Dependabot entry reaches every file that pins Kanon: its `directories` name `/` and the directory of each composite action holding a counted reference, `/.github/actions/*` for the hooks, since from `/` Dependabot reads only `.github/workflows/`. An adopter's project-setup hook pinning Kanon had stayed at the old release on every upgrade pull request, which then failed the one-version rule. `lane-check` fails an entry that doesn't reach such a file, and a reference in a file Dependabot never updates; `kanon doctor` reports the first as `pin.dependabot-unreached`; and `kanon init` writes the entry for both directories. [#1105](https://github.com/yedeya-labs/kanon/issues/1105)
- **2026-10-18.** The reach binds every `github-actions` entry that would propose Kanon, not only the one with Kanon's group, `ci` prefix and cooldown exemption: one that reaches a file pinning Kanon and neither leaves Kanon out of its `allow` nor ignores every Kanon update. A second entry without them still opens its own upgrade pull request. `lane-check` and `kanon doctor` hold the same entries, and name the one that doesn't reach a pin. [#1111](https://github.com/yedeya-labs/kanon/issues/1111)
- **2026-10-20.** Every entry that would propose Kanon also groups it: one group takes in every update to Kanon's actions and its lanes' workflows. Dependabot opens an update no group takes in as a pull request of its own, per dependency and per directory, and names each reusable workflow by its repository and path, so an ungrouped entry split one Kanon upgrade into several pull requests, each failing the one-version rule, which the reach alone couldn't cure. `lane-check` fails such an entry, naming the `kanon` group `kanon init` writes, and `kanon doctor` reports it as `pin.dependabot-ungrouped`. An `ignore` of only `yedeya-labs/kanon` no longer counts as leaving Kanon out, since it leaves the lanes' workflows in. [#1126](https://github.com/yedeya-labs/kanon/issues/1126)

## `K-OBS-19`

- **2026-10-15.** The guards the rule names are built: Kanon's `notify` block, `actions/notify`, with `tests/unit/helpers/notify-jobs.ts`, `tests/unit/notify-guard.test.ts` and `tests/library/notify-block.test.ts`, `K-AGENT-50`'s guard admitting the `notify` job only in its exact shape, and `K-AGENT-49`'s counting the block as running the adopter's code. The block publishes its outcome, `posted`, `failed` or `skipped`, as an output, since a skip leaves the job green. No lane runs it until the digests move. [Plan 0011](../docs/plans/0011-notifications.md) N6, [#839](https://github.com/yedeya-labs/kanon/issues/839), [#972](https://github.com/yedeya-labs/kanon/issues/972)
- **2026-10-20.** A fourth kind, `release`, posted by the release announcement's lane with `KANON_CHAT_RELEASE`, joins the contract's lanes and the `notify` job's secrets; the rule's lists name it. [#1190](https://github.com/yedeya-labs/kanon/issues/1190)

## `K-LAYOUT-1`

- **2026-10-14.** The deploy lane's three hooks, `.github/actions/build`, `.github/actions/deploy` and `.github/actions/smoke`, and the adoption record's `## Deploy` section, joined the fixed paths. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-14.** The notify hook, `.github/actions/notify/action.yml`, joined the fixed paths. [Plan 0011](../docs/plans/0011-notifications.md), [#839](https://github.com/yedeya-labs/kanon/issues/839)
- **2026-10-20.** The smoke check's optional reset hook, `.github/actions/smoke-reset/action.yml`, and the caller that runs the check outside a deploy, `.github/workflows/smoke.yml`, joined the fixed paths. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) §4.1, [#1165](https://github.com/yedeya-labs/kanon/issues/1165)

## `K-LAYOUT-6`

- **2026-10-15.** The Maintainer decided that the register holds every App installed on the repository that isn't an agent, under one generic role, so an adopter can register any such App. The role is `Other App`, with one row per App, each naming an App no other row names; the readers that map a role to a login, the membership gate among them, never read those rows. [#990](https://github.com/yedeya-labs/kanon/issues/990)
- **2026-10-15.** The Owner decided that the sign-off check reads no `Other App` row, nor the Intake row, so the sign-off delegation never covers an App that isn't an agent. [#998](https://github.com/yedeya-labs/kanon/issues/998)
- **2026-10-16.** The Why says the sign-off check takes no delegated slug from those rows, rather than that it doesn't read them: it still parses them, so a malformed slug on one still refuses the register, and their slugs still count as another role's for the Releaser. The check is unchanged. [#1036](https://github.com/yedeya-labs/kanon/issues/1036)

## `K-LAYOUT-8`

- **2026-10-12.** The Owner decided that `## Pipeline code` may name a single file, which covers exactly that file, as well as a directory. [#728](https://github.com/yedeya-labs/kanon/issues/728)

## `K-LAYOUT-10`

- **2026-10-07.** The Owner decided that, under `drafted`, the telemetry Explorer writes each upstream finding into its run's step summary, rendered as it would be filed. [#471](https://github.com/yedeya-labs/kanon/pull/471)
- **2026-10-12.** The Owner decided the release cadence choice: `every merge`, or `weekly, ` and a weekday. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md), [#760](https://github.com/yedeya-labs/kanon/pull/760)
- **2026-10-14.** The Owner decided that the adoption record has a `## Deploy` section of its own, holding the deploy lane's environments, its CI wait and the fallback's marker, and that the reference deploy's three bullets move there from `## Choices` at once, with no period of reading both places. [Plan 0010](../docs/plans/0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)
- **2026-10-15.** The gate never waits longer than 345 minutes for the release commit's CI, whatever the record declares, so a CI that never finishes ends in `ci-timeout`, which is filed, inside the gate job's 360-minute limit, not in a cancellation, which files nothing. [#912](https://github.com/yedeya-labs/kanon/issues/912), [#961](https://github.com/yedeya-labs/kanon/pull/961)
- **2026-10-15.** The Owner decided the extra App permission choice: one bullet per App and permission under `## Choices`, with its reason, which widens that repository's App alone. [Plan 0009](../docs/plans/0009-release-channels-and-api-key.md) S4, [#575](https://github.com/yedeya-labs/kanon/issues/575)
- **2026-10-20.** The `## Deploy` section gained an optional `Smoke schedule` bullet: one code span per environment, its name and then a five-field cron, no environment twice and no two environments sharing a cron string, since the cron is what tells one scheduled run from another. [Plan 0013](../docs/plans/0013-smoke-lifecycle.md) §4.3, [#1165](https://github.com/yedeya-labs/kanon/issues/1165)

- **2026-10-21.** The mechanism list takes a third status, `not applicable`, and `## Choices` its reason, one `Mechanism not applicable` bullet per such mechanism, naming its row's rules. [#1236](https://github.com/yedeya-labs/kanon/issues/1236)

## `K-LAYOUT-16`

- **2026-10-03.** The Owner chose the contract, a project-declared database the lanes find in `DATABASE_URL`, over a Kanon-maintained standard database. [#139](https://github.com/yedeya-labs/kanon/pull/139)

## `K-LAYOUT-18`

- **2026-10-12.** The rule's premise changed: Kanon's scripts look a lane's caller up on the default branch and list and dispatch that, so a caller under another name is found where the default branch can be read. They fall back to the lane's file name only when it can't be read or no caller is found. The rule stands. [#726](https://github.com/yedeya-labs/kanon/issues/726)
- **2026-10-21.** The dispatch sweep reads `ci.yml`'s runs too, to re-ask a review that never landed only once CI has completed on the head, so a project that runs it keeps its CI at `ci.yml` as well; the rule now names every lane whose workflow carries `# READS WORKFLOW: ci.yml`. [#1214](https://github.com/yedeya-labs/kanon/issues/1214)
