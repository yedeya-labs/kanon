# Adoption record

Kanon adopts Kanon ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)). This is its adoption record, in the format of `K-LAYOUT-10`. It says what state this repository is in, so that a reader doesn't have to reconstruct it. Every date can be checked against git history, the ruleset's history, or GitHub. [`tests/unit/adoption-record.test.ts`](../../tests/unit/adoption-record.test.ts) checks the format, and that the mechanism list names every rule whose "Enforced by" line names something.

## People

| Role | Who |
|---|---|
| Owner | Geoffry Nagy (`@yedeya`) |
| Maintainer | Geoffry Nagy (`@yedeya`) |
| Stakeholder | Geoffry Nagy (`@yedeya`) |

One person holds all three roles, which chapter 03 allows.

## Plan

`yedeya-labs/kanon` is a **public repository in a GitHub organisation** (`K-ADOPT-2`), created 2026-09-30. On a public repository every platform feature of `K-ADOPT-3` is available, so **no fallback is in use**:

- **Rulesets:** the `main` ruleset (id 24259403).
- **Merge queue:** on since 2026-09-30, so the merge-queue fallback of `K-MERGE-7` doesn't apply.
- **Required reviewers on an environment:** available, but Kanon has no production environment. A release is a tag and a GitHub release, and nothing deploys (step 9 below).

## Bootstrap

`ended 2026-10-02`

Bootstrap ended when both conditions of `K-ADOPT-6` held: the Reviewer's App, `kanon-reviewer`, was installed (2026-10-02), and the `main` ruleset's required approving review count went from 0 to 1 (ruleset history, 2026-10-02 19:30 UTC). The Reviewer gave its first approval on #71.

### Bootstrap exceptions (`K-ADOPT-5`)

- **Straight to the main branch:** one commit, `2571869` (2026-09-30), the first commit. The ruleset was created after it, the same day. Every later change came through a pull request.
- **Merged with no approving review,** as bootstrap allows: 43 of the 53 pull requests merged before the required review was switched on. Of the other ten, eight carry the Reviewer's approval (#71, #76, #80, #82, #83, #84, #87 and #94) and two, both release pull requests, carry the Owner's (#31 and #43).
- **Humans playing agent roles:** none. No human review stood in for the Reviewer, and on Kanon the Owner merges every pull request as the Maintainer, which is not an agent role here, because no agent ever merges on Kanon (ADR 0011).

### Installation steps (`K-ADOPT-1`)

| Step | State |
|---|---|
| 1. Account | Done 2026-09-30: a repository in the `yedeya-labs` organisation. |
| 2. People | Done 2026-10-02, in this record. |
| 3. Installer credential | Not done: no credential scoped to `K-ADOPT-7` is recorded. |
| 4. First commit | Done 2026-09-30 (`2571869`), in part. The fixed layout is incomplete: the `.gitignore` (2026-09-30), the App register (2026-10-02) and this record (2026-10-02) exist. The agent instruction files, `docs/projects/_template.md`, the spec directory, the observability document and the escalation file don't. The capability ledger was added 2026-10-06, with the Overseer. |
| 5. Repository settings | Done 2026-09-30: squash merge only, the PR title as the subject and the PR body as the message. The release workflow's merge-settings guard checks them on every push to `main`. |
| 6. Labels | Not done: the taxonomy is partial, and GitHub's default labels are still there. |
| 7. Milestones | Done 2026-10-02: *Product Backlog* and *Development Automation*, with no due date. |
| 8. Rules on the main branch | Done 2026-09-30: pull request required, no force-push or deletion, squash only, and the merge queue. The required approving review was switched on at step 14. |
| 9. Production approval | Not done: Kanon has no production environment. |
| 10. Chat channel | Not done: none yet (see Choices). |
| 11. The first tracking issue | Not done as written: the first issues were filed 2026-09-30, before the milestones existed, and got their bucket milestones later. |
| 12. Agent identities | Done: `kanon-reviewer`, created 2026-10-02 with `kanon apps`, installed on this repository only, and listed in the [App register](agent-identities.md). `apps-check` passed (run 37023855771, 2026-10-02). `kanon-implementer` (ADR 0011's stage 2) and `kanon-explorer` (for the code audit, plan 0004 step 11a) were created 2026-10-05 with `kanon apps`, and their secrets are set. `apps-check` passed for all three Apps (run 37321684369, 2026-10-05, on the branch that registered the two). Plan 0005's L5 (2026-10-06) replaced them with the lean model's three Apps, created with `kanon apps --apps author,judge,releaser` and installed on this repository only: the Author `yedeya-labs-author` (Implementer, Lead, Explorer, Overseer), the Judge `yedeya-labs-judge` (Reviewer, Merger) and the Releaser `yedeya-labs-releaser`, each with its two secrets and its register rows. The three per-role Apps are uninstalled after a week of green runs. |
| 13. Kanon's code | In progress: see Mechanisms. The checks, the review lane, the implement lanes, the code audit and the Overseer are pinned to one exact release, the one their callers under `.github/workflows/` name (this record doesn't repeat it, because every Dependabot bump would leave a copy here stale, [#298](https://github.com/yedeya-labs/kanon/issues/298)), and Dependabot's `kanon` group proposes each release to them, exempt from the cooldown ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md); the hold below v0.28.0 ended at plan 0005's L5). Until 2026-10-04 the entry set no `cooldown`, so Dependabot's default of 3 days held every release back and none was proposed ([#233](https://github.com/yedeya-labs/kanon/issues/233)). |
| 14. End bootstrap | Done 2026-10-02 (above). Dropping the installer credential's Administration permission is not recorded, because step 3 made no such credential. |

## Mechanisms

Every mechanism a rule's "Enforced by" line names (`K-ADOPT-9`), each with the rules that name it. A mechanism that is not yet installed leaves those rules prose only on this repository, and nothing here describes them as enforced. Releases since v0.7.0 (2026-10-02) are immutable, which is what makes an exact pin to a Kanon release mean one thing.

| Mechanism | Rules | Status |
|---|---|---|
| The `main` ruleset: pull request required, no force-push or deletion, squash only | `K-MERGE-6`, `K-SPEC-1` | installed 2026-09-30 |
| The ruleset's required approving review (1) | `K-MERGE-1`, `K-MERGE-6`, `K-ADOPT-6` | installed 2026-10-02 |
| The merge queue, with every required check reporting on `merge_group` | `K-MERGE-7` | installed 2026-09-30 |
| The repository's merge settings, and the release workflow's merge-settings guard | `K-SHIP-3` | installed 2026-09-30 |
| The reusable release workflow (merge-settings guard, then release-please) | `K-SHIP-7` | installed 2026-09-30 |
| The `pr-title` action, and the test of its type table | `K-SHIP-4` | installed 2026-09-30 |
| The `dco` action, reading the App register from the default branch, and its parser's tests | `K-AGENT-44`, `K-LAYOUT-14`, `K-MERGE-17` | installed 2026-09-30 |
| `tests/unit/workflows.test.ts`, which pins the `permissions:` block of Kanon's own checks | `K-AGENT-46` | installed 2026-09-30 |
| `tests/unit/workflow-security.test.ts`, on Kanon's own workflows and actions | `K-PRIN-19`, `K-ADOPT-12`, `K-AGENT-47`, `K-AGENT-48` | installed 2026-10-02 |
| `tests/unit/app-key-isolation.test.ts`, on Kanon's own workflows, with no exception since #279: every lane's key-holding `mint` job, and its agent's job in a called workflow of its own, held to the spine's handoff | `K-AGENT-49` | installed 2026-10-04 |
| `tests/unit/pr-code-token-isolation.test.ts` and `tests/unit/lead-shell.test.ts`, on Kanon's own lanes ([#243](https://github.com/yedeya-labs/kanon/issues/243)): the verify-acs lane's criteria in a job with no token; the Lead's lanes with no hook and a shell allow-list; implement-revise and the rebase lane as exceptions the Owner accepted on 2026-10-05, with their residual risk (the same App wrote the code it runs, with the same grant; another App with contents write can plant code on its branch; the Claude token is beside the pull request's code) recorded on the rule. Kanon has no Lead caller and its implement callers pin a release from before this | `K-AGENT-50` | installed 2026-10-05 |
| `kanon apps`, and the test that the roles table and `agent-permissions.json` agree | `K-ADOPT-1`, `K-ADOPT-8`, `K-SELF-5` | installed 2026-10-02 |
| The Reviewer App's permission grants | `K-AGENT-7`, `K-AGENT-46` | installed 2026-10-02 |
| The review lane, called by `review.yml` at a released version: the membership gate, the per-role token and slug assertion, the scope probe, the judging-input restore, the filter job and incremental scope, the trigger label, the verdict check, the outcome step, the shared classifier, and the telemetry row | `K-AGENT-1`, `K-AGENT-2`, `K-AGENT-5`, `K-AGENT-22`, `K-AGENT-25`, `K-AGENT-28`, `K-AGENT-42`, `K-AGENT-43`, `K-AGENT-45`, `K-LAYOUT-9`, `K-MERGE-14`, `K-MERGE-17`, `K-PRIN-9` | installed 2026-10-02 |
| The Reviewer, through its playbook and instructions, including its review of briefs and specs and the follow-ups it files | `K-PRIN-3`, `K-WORK-15`, `K-SPEC-11`, `K-AGENT-20`, `K-SPEC-5`, `K-SPEC-9`, `K-SPEC-10`, `K-PROJ-6`, `K-PROJ-7`, `K-PROJ-18` | installed 2026-10-02 |
| Unit tests on Kanon's own lanes: every arm's flags, the implement lanes' turn cap and ceiling, and blocks that use Node built-ins only | `K-AGENT-37`, `K-OBS-12`, `K-SELF-8` | installed 2026-10-02 |
| The brief guard's test against the shipped template, and its exemption of the pre-standard briefs an adopter declares | `K-PRIN-11`, `K-PROJ-4`, `K-PROJ-10`, `K-LAYOUT-11` | installed 2026-10-02 |
| `tests/unit/adoption-record.test.ts`, on this record | `K-LAYOUT-10`, `K-ADOPT-9` | installed 2026-10-02 |
| The other agent lanes and their App tokens (Implementer, Lead, Explorer, Merger; the Implementer's callers and App are in place, waiting for its first `agent:implement` label; the Explorer's App and its code-audit caller are in place), with their crash handlers, round caps, split lane and quiet-runner settings | `K-AGENT-2`, `K-AGENT-14`, `K-AGENT-18`, `K-AGENT-30`, `K-AGENT-33`, `K-AGENT-41`, `K-MERGE-16` | not yet installed |
| The conflict lane, called by `rebase.yml` at a released version: it resolves a conflict on the Implementer's pull request as the Author App, by a merge commit, and carries the `kanon/role: implementer` status to the head it pushed, so a conflict doesn't take the pull request out of the Implementer's chain ([#448](https://github.com/yedeya-labs/kanon/issues/448)). On Kanon a merge doesn't start it (the merge queue, [#79](https://github.com/yedeya-labs/kanon/issues/79)) and its cron fires only now and then ([#397](https://github.com/yedeya-labs/kanon/issues/397)), so a conflict on an Implementer pull request is resolved by dispatching `rebase.yml` for it (`gh workflow run rebase.yml -f pr_number=N`), never by a person's rebase | `K-AGENT-34` | installed 2026-10-07 |
| The test-database block in the lanes, and `lane-check`'s reading of the declaration. Kanon declares `none` in `docs/qa/test-database.md`, so its lanes start no database | `K-LAYOUT-16` | installed 2026-10-04 |
| `lane-check`'s reading of the project documents the lanes read, and the lane-literal test over the prompts. Kanon's stack document holds its gates and its code areas, its Implementer playbook is `docs/qa/triage-fix-playbook.md`, and its explorer playbook says what the code audit looks for on Kanon | `K-LAYOUT-17` | installed 2026-10-04 |
| `lane-check`'s caller file names, and its check that `ci.yml` exists for the lanes that read it. Kanon's callers are `review.yml`, `implement.yml`, `implement-revise.yml`, `rebase.yml`, `code-audit.yml` and `overseer.yml`, because `agent-<lane>.yml` here is the lane itself, which the rule exempts | `K-LAYOUT-18` | installed 2026-10-04 |
| The review lane running none of the pull request's code, and the test that holds its steps to that ([#185](https://github.com/yedeya-labs/kanon/issues/185)), the Reviewer's shell allow-list and its test ([#248](https://github.com/yedeya-labs/kanon/issues/248)), and the Reviewer loading no project settings ([#277](https://github.com/yedeya-labs/kanon/issues/277)). Kanon's `review.yml` has pinned a release that includes all three since 2026-10-05, when it moved to v0.25.0 | `K-AGENT-24` | installed 2026-10-05 |
| The Reviewer's and the Lead's user settings in a directory their own job made, so a reused runner's `~/.claude` doesn't join their flags ([#283](https://github.com/yedeya-labs/kanon/issues/283)). It installs when Kanon's callers first pin a release that includes it | `K-AGENT-24` | not yet installed |
| Re-delivery and retry logic that reads run history for the head | `K-PRIN-13` | not yet installed |
| The merge gate: the Merger's verdict function, its merge step, its escalation markers and post-merge checks | `K-PRIN-4`, `K-PRIN-5`, `K-PRIN-10`, `K-MERGE-1`, `K-MERGE-3`, `K-MERGE-4`, `K-MERGE-5`, `K-MERGE-9`, `K-MERGE-10`, `K-MERGE-11`, `K-MERGE-12`, `K-AGENT-4`, `K-AGENT-13`, `K-AGENT-26`, `K-LAYOUT-8` | not yet installed |
| A ruleset bypass list naming only the release bot. Today it holds the repository admin role, for pull requests only. The Owner decided that it stays until the Releaser App exists ([#49](https://github.com/yedeya-labs/kanon/issues/49)), and is then replaced by a bypass for the Releaser only | `K-MERGE-5`, `K-MERGE-8` | not yet installed |
| The red-test check on agent-authored pull requests | `K-PRIN-4`, `K-MERGE-13`, `K-AGENT-15` | not yet installed |
| The watching agent (Overseer): read-only permissions, tool allow-list and prompt, called by `overseer.yml` at a released version, with the QA store through Kanon's store hook and its own playbook, `docs/qa/overseer-playbook.md` ([#423](https://github.com/yedeya-labs/kanon/issues/423)) | `K-PRIN-6`, `K-AGENT-35`, `K-SELF-9`, `K-SELF-11` | installed 2026-10-06 |
| The Explorer: exploration and sweep workflows on an isolated stage, its run-report writer and its filing gate. Kanon runs no sweep, having no app; its code audit runs from `code-audit.yml` | `K-AGENT-9`, `K-AGENT-10`, `K-AGENT-11`, `K-SPEC-8`, `K-OBS-7` | not yet installed |
| The issue-opened automation (the milestone backstop and severity defaults) | `K-WORK-1`, `K-WORK-4`, `K-WORK-5`, `K-WORK-9`, `K-WORK-10` | not yet installed |
| The shared milestone classifier | `K-WORK-3`, `K-SHIP-11` | not yet installed |
| The label guard | `K-WORK-5`, `K-WORK-11`, `K-WORK-12`, `K-SELF-2`, `K-SELF-16` | not yet installed |
| The re-dispatch sweep and the capability interlock | `K-WORK-13`, `K-PRIN-10`, `K-SELF-17` | not yet installed |
| The project reconciler and its closure module | `K-PRIN-12`, `K-WORK-19`, `K-AGENT-29`, `K-AGENT-31`, `K-AGENT-32`, `K-PROJ-2`, `K-PROJ-9`, `K-PROJ-11`, `K-PROJ-12` | not yet installed |
| The intake path's single-label test | `K-WORK-21` | not yet installed |
| The spec guard, the id allocator and its test, and the locked-set ratchet | `K-SPEC-2`, `K-SPEC-3`, `K-SPEC-7`, `K-LAYOUT-2`, `K-LAYOUT-3`, `K-LAYOUT-4`, `K-SELF-6` | not yet installed |
| The coverage and acceptance-criteria tools | `K-SPEC-5`, `K-SPEC-6`, `K-PROJ-11` | not yet installed |
| The brief guard on this repository's briefs (Kanon has no `docs/projects/`) | `K-PRIN-8`, `K-PRIN-14`, `K-SPEC-4`, `K-PROJ-1`, `K-PROJ-3`, `K-PROJ-5`, `K-PROJ-16`, `K-PROJ-17`, `K-OBS-1`, `K-OBS-9`, `K-WORK-23`, `K-LAYOUT-12`, `K-LAYOUT-13` | not yet installed |
| The worktree script | `K-WS-2`, `K-WS-3`, `K-WS-5`, `K-WS-6`, `K-WS-7`, `K-WS-8` | not yet installed |
| The ship command, its advisory-review path check and its allowlist test | `K-WS-1`, `K-SHIP-1`, `K-SHIP-2`, `K-MERGE-15` | not yet installed |
| The guard on tracked environment files and test artifacts | `K-WS-4` | not yet installed |
| The closing-references check | `K-SHIP-5` | not yet installed |
| Deploy, production approval and announcement workflows (Kanon deploys nothing) | `K-SHIP-8`, `K-SHIP-9`, `K-SHIP-10` | not yet installed |
| The digest job | `K-PROJ-13`, `K-SHIP-11` | not yet installed |
| The observability document's guards: paging parity, signal disposition, hand-created resources | `K-PRIN-2`, `K-OBS-2`, `K-OBS-3`, `K-OBS-8`, `K-LAYOUT-5` | not yet installed |
| The workflow-health check | `K-OBS-6` | not yet installed |
| The hosted telemetry store: the collector, quality columns, the cost-trend report, the cache-TTL detector and the row schema (plan 0002) | `K-OBS-13`, `K-OBS-14`, `K-OBS-15`, `K-OBS-16` | not yet installed |
| The fallback-model test and the fallback lists | `K-AGENT-38`, `K-OBS-15` | not yet installed |
| The lint chain runner, the path guard, the flag guard and the permissions guard | `K-SELF-1`, `K-SELF-3`, `K-SELF-4`, `K-AGENT-37` | not yet installed |
| The citation guard on Kanon's own `docs/`, the `Citation guard` job of `ci.yml`, which runs the base's copy and is meant to be a required check, and `citation-shift` on every pull request, advisory as for adopters (`citation-shift.yml`, [#377](https://github.com/yedeya-labs/kanon/issues/377), [#343](https://github.com/yedeya-labs/kanon/pull/343)). Both also read `rulebook/` and the READMEs, passed with `--path` ([#388](https://github.com/yedeya-labs/kanon/issues/388)) | `K-SELF-3` | installed 2026-10-06 |
| The calibration record, the run-record writer, and the capability ledger's watermark reader. The ledger exists (2026-10-06), and the reader, which the Overseer's runtime-version trigger runs, installs when `overseer.yml` first pins a release that includes it | `K-SELF-13`, `K-SELF-15`, `K-SELF-17`, `K-LAYOUT-7` | not yet installed |
| The installer, beyond `kanon apps` and `kanon milestones` | `K-ADOPT-1`, `K-ADOPT-2`, `K-ADOPT-3`, `K-ADOPT-7`, `K-OBS-18` | not yet installed |
| Planned guards the rules name but Kanon hasn't built | `K-PRIN-2`, `K-PRIN-18`, `K-WORK-22`, `K-SPEC-9`, `K-SPEC-10`, `K-MERGE-8`, `K-PROJ-14`, `K-PROJ-18`, `K-OBS-16`, `K-OBS-17`, `K-SELF-14`, `K-ADOPT-6`, `K-ADOPT-10`, `K-ADOPT-11`, `K-LAYOUT-10` | not yet installed |
| The sign-off delegation record (`docs/qa/sign-off-delegation.md`), naming the Owner, and Kanon's project-setup hook adding its sign-off to the Implementer's commits | `K-AGENT-44`, `K-LAYOUT-14` | installed 2026-10-04 |
| The exemptions file (`docs/qa/exemptions.md`), read by the brief guard and the doc-path guard; Kanon runs neither guard on itself yet | `K-LAYOUT-15` | not yet installed |

These rules' lines are prose only with a note, and name nothing to install: `K-PRIN-1`, `K-PRIN-7`, `K-PRIN-20`, `K-AGENT-3`, `K-PROJ-8`, `K-PROJ-15`, `K-OBS-4`, `K-SELF-7`, `K-LAYOUT-1`, `K-LAYOUT-6`.

**Not yet installed, and why:**

- **The Implementer** is not yet on. Its App, callers, register row and sign-off delegation are in place, and its pins include [#234](https://github.com/yedeya-labs/kanon/issues/234) since 2026-10-05 (ADR 0011, stage 2); what remains is the first `agent:implement` label.
- **The Explorer** runs only its code audit of Kanon's own code (`code-audit.yml`, plan 0004 step 11a). Kanon has no app for its sweep.
- **The Lead** waits for the Owner's decision (ADR 0011).
- **No hosted telemetry yet:** the store is plan 0002, in progress.
- **The admin bypass on the `main` ruleset** stays until Kanon's `dco` caller pins a release that exempts the Releaser's release commits (#337), by the Owner's decision (#49). The Releaser, `yedeya-labs-releaser`, has been a bypass actor, for pull requests only, since plan 0005's L5 (2026-10-06); once the pin lands on `main`, the admin's bypass is removed, which installs `K-MERGE-8`'s bypass list.
- **No agent ever merges on Kanon** (ADR 0011), so the merge gate and the Merger are not planned here.

## Choices

- **Chat channel:** not yet decided. None is configured.
- **Who merges:** the Owner, always (ADR 0011).
- **Which pull requests are reviewed:** members' only (ADR 0011).
- **Overseer:** `installed`
- **Upstream findings:** `filed here`
- **Who records a signal's outcome:** whoever closes an Explorer-, Reviewer- or Overseer-filed issue without a merged fix labels it `qa:false-positive` or `qa:reproduced` at close, since no triage lane runs here. A signal a merged pull request closed counts as confirmed with no label, and the Overseer's weekly audit lists any closed signal that has neither ([#466](https://github.com/yedeya-labs/kanon/issues/466)).
- **A QA store, since 2026-10-06.** The Owner provisioned the `kanon-qa-store` stack in eu-central-1 with `infra/qa-store/aws/provision.mjs`, trusting the default branch's ref, and Kanon's store hook (`.github/actions/qa-store`) names its table and region, and reads its role and bucket, which carry the account id, from the repository secrets `QA_STORE_ROLE_ARN` and `QA_STORE_BUCKET`, so the account id is never committed, and the runner masks it in every log (the Owner's decision on [#433](https://github.com/yedeya-labs/kanon/issues/433), 2026-10-07; [the QA store](../qa-store.md)). Until Kanon's callers pin a release after v0.33.0 and map the two secrets, the hook falls back to the repository variables of the same names, which v0.33.0's lanes pass it ([#423](https://github.com/yedeya-labs/kanon/issues/423)) and its store jobs' logs print; with neither, the hook fails by name, so a read is `degraded` and a write fails its job.
- **No reference environment.** Kanon deploys nothing: a release is a tag and a GitHub release. So this record declares none of `K-LAYOUT-10`'s reference-deploy bullets, and no project on Kanon can close by `K-PROJ-11` until it does. Kanon doesn't run the reconciler yet (see Mechanisms).
- **Accepted id-token holder:** `agent-code-audit.yml` job `export` (its QA store job: Kanon's own lane definition; the id-token guard test holds which of its jobs may hold the grant)
- **Accepted id-token holder:** `agent-code-audit.yml` job `put` (its QA store job: Kanon's own lane definition; the id-token guard test holds which of its jobs may hold the grant)
- **Accepted id-token holder:** `agent-dispatch-sweep.yml` job `store` (its QA store job: Kanon's own lane definition; the id-token guard test holds which of its jobs may hold the grant)
- **Accepted id-token holder:** `agent-explore.yml` job `last-green` (its QA store job: Kanon's own lane definition; the id-token guard test holds which of its jobs may hold the grant)
- **Accepted id-token holder:** `agent-explore.yml` job `record-skip` (its QA store job: Kanon's own lane definition; the id-token guard test holds which of its jobs may hold the grant)
- **Accepted id-token holder:** `agent-explore.yml` job `put` (its QA store job: Kanon's own lane definition; the id-token guard test holds which of its jobs may hold the grant)
- **Accepted id-token holder:** `agent-lanes-smoke.yml` job `explore` (grants it to the explore lane's store jobs alone, which the id-token guard test holds)
- **Accepted id-token holder:** `agent-lanes-smoke.yml` job `dispatch-sweep` (grants it to the dispatch-sweep lane's store job alone, which the id-token guard test holds)
- **Accepted id-token holder:** `agent-lanes-smoke.yml` job `code-audit` (grants it to the code-audit lane's store jobs alone, which the id-token guard test holds)
- **Accepted id-token holder:** `agent-lanes-smoke.yml` job `overseer` (grants it to the overseer lane's store job alone, which the id-token guard test holds)
- **Accepted id-token holder:** `agent-overseer.yml` job `export` (its QA store job: Kanon's own lane definition; the id-token guard test holds which of its jobs may hold the grant)
- **Accepted id-token holder:** `qa-store-aws-maintenance.yml` job `maintenance` (runs the QA store's hygiene scripts under the store's role; Kanon's own reusable workflow, held by the id-token guard test)
- **Accepted id-token holder:** `telemetry-collect.yml` job `collect` (writes to the telemetry store as its writer; Kanon's own reusable workflow, held by the id-token guard test)
- **Accepted id-token holder:** `telemetry.yml` job `collect` (Kanon's telemetry caller: grants it to telemetry-collect.yml at the pinned release, whose one job holds it)
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/review.yml` (Kanon hosts the lanes it calls: `agent-review.yml` is the lane itself, so its caller can't take that name; ADR 0011)
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/implement.yml` (Kanon hosts the lanes it calls: `agent-implement.yml` is the lane itself, so its caller can't take that name; ADR 0011)
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/implement-revise.yml` (Kanon hosts the lanes it calls: `agent-implement-revise.yml` is the lane itself, so its caller can't take that name; ADR 0011)
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/rebase.yml` (Kanon hosts the lanes it calls: `agent-rebase.yml` is the lane itself, so its caller can't take that name; ADR 0011)
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/code-audit.yml` (Kanon hosts the lanes it calls: `agent-code-audit.yml` is the lane itself, so its caller can't take that name; ADR 0011)
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/overseer.yml` (Kanon hosts the lanes it calls: `agent-overseer.yml` is the lane itself, so its caller can't take that name; ADR 0011)
