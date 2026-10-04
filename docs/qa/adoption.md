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
| 4. First commit | Done 2026-09-30 (`2571869`), in part. The fixed layout is incomplete: the `.gitignore` (2026-09-30), the App register (2026-10-02) and this record (2026-10-02) exist. The agent instruction files, `docs/projects/_template.md`, the spec directory, the observability document, the capability ledger and the escalation file don't. |
| 5. Repository settings | Done 2026-09-30: squash merge only, the PR title as the subject and the PR body as the message. The release workflow's merge-settings guard checks them on every push to `main`. |
| 6. Labels | Not done: the taxonomy is partial, and GitHub's default labels are still there. |
| 7. Milestones | Done 2026-10-02: *Product Backlog* and *Development Automation*, with no due date. |
| 8. Rules on the main branch | Done 2026-09-30: pull request required, no force-push or deletion, squash only, and the merge queue. The required approving review was switched on at step 14. |
| 9. Production approval | Not done: Kanon has no production environment. |
| 10. Chat channel | Not done: none yet (see Choices). |
| 11. The first tracking issue | Not done as written: the first issues were filed 2026-09-30, before the milestones existed, and got their bucket milestones later. |
| 12. Agent identities | Done for the Reviewer only: `kanon-reviewer`, created 2026-10-02 with `kanon apps`, installed on this repository only, and listed in the [App register](agent-identities.md). `apps-check` passed (run 37023855771, 2026-10-02). `kanon-implementer` (ADR 0011's stage 2) and `kanon-explorer` (for the code audit, plan 0004 step 11a) were created 2026-10-05 with `kanon apps`, and their secrets are set. `apps-check` passed for all three Apps (run 37321684369, 2026-10-05, on the branch that registered the two). The other roles have no App and no row. |
| 13. Kanon's code | In progress: see Mechanisms. The checks, the review lane and the implement lanes are pinned to one exact release (v0.23.0 since 2026-10-04), and Dependabot's `kanon` group proposes each release to them, exempt from the cooldown. Until 2026-10-04 the entry set no `cooldown`, so Dependabot's default of 3 days held every release back and none was proposed ([#233](https://github.com/yedeya-labs/kanon/issues/233)). |
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
| `tests/unit/app-key-isolation.test.ts`, on Kanon's own workflows, and the spine's key-holding `mint` job. The lanes that call the blocks directly are listed exceptions until #279 | `K-AGENT-49` | installed 2026-10-04 |
| `kanon apps`, and the test that the roles table and `agent-permissions.json` agree | `K-ADOPT-1`, `K-ADOPT-8`, `K-SELF-5` | installed 2026-10-02 |
| The Reviewer App's permission grants | `K-AGENT-7`, `K-AGENT-46` | installed 2026-10-02 |
| The review lane, called by `review.yml` at a released version: the membership gate, the per-role token and slug assertion, the scope probe, the judging-input restore, the filter job and incremental scope, the trigger label, the verdict check, the outcome step, the shared classifier, and the telemetry row | `K-AGENT-1`, `K-AGENT-2`, `K-AGENT-5`, `K-AGENT-22`, `K-AGENT-25`, `K-AGENT-28`, `K-AGENT-42`, `K-AGENT-43`, `K-AGENT-45`, `K-LAYOUT-9`, `K-MERGE-14`, `K-MERGE-17`, `K-PRIN-9` | installed 2026-10-02 |
| The Reviewer, through its playbook and instructions, including its review of briefs and specs and the follow-ups it files | `K-PRIN-3`, `K-WORK-15`, `K-SPEC-11`, `K-AGENT-20`, `K-SPEC-5`, `K-SPEC-9`, `K-SPEC-10`, `K-PROJ-6`, `K-PROJ-7`, `K-PROJ-18` | installed 2026-10-02 |
| Unit tests on Kanon's own lanes: every arm's flags, the implement lanes' turn cap and ceiling, and blocks that use Node built-ins only | `K-AGENT-37`, `K-OBS-12`, `K-SELF-8` | installed 2026-10-02 |
| The brief guard's test against the shipped template, and its exemption of the pre-standard briefs an adopter declares | `K-PRIN-11`, `K-PROJ-4`, `K-PROJ-10`, `K-LAYOUT-11` | installed 2026-10-02 |
| `tests/unit/adoption-record.test.ts`, on this record | `K-LAYOUT-10`, `K-ADOPT-9` | installed 2026-10-02 |
| The other agent lanes and their App tokens (Implementer, Lead, Explorer, Merger, Overseer; the Implementer's callers and App are in place, waiting for the pin bump in ADR 0011; the Explorer's App exists, with no caller yet), with their crash handlers, round caps, split and conflict lanes and quiet-runner settings | `K-AGENT-2`, `K-AGENT-14`, `K-AGENT-18`, `K-AGENT-30`, `K-AGENT-33`, `K-AGENT-34`, `K-AGENT-41`, `K-MERGE-16` | not yet installed |
| The test-database block in the lanes, and `lane-check`'s reading of the declaration. Kanon declares `none` in `docs/qa/test-database.md`, so its lanes start no database | `K-LAYOUT-16` | installed 2026-10-04 |
| `lane-check`'s reading of the project documents the lanes read, and the lane-literal test over the prompts. Kanon's stack document holds its gates, and its Implementer playbook is `docs/qa/triage-fix-playbook.md` | `K-LAYOUT-17` | installed 2026-10-04 |
| `lane-check`'s caller file names, and its check that `ci.yml` exists for the lanes that read it. Kanon's callers are `review.yml`, `implement.yml` and `implement-revise.yml`, because `agent-<lane>.yml` here is the lane itself, which the rule exempts | `K-LAYOUT-18` | installed 2026-10-04 |
| The review lane running none of the pull request's code, and the test that holds its steps to that ([#185](https://github.com/yedeya-labs/kanon/issues/185)), the Reviewer's shell allow-list and its test ([#248](https://github.com/yedeya-labs/kanon/issues/248)), and the Reviewer loading no project settings ([#277](https://github.com/yedeya-labs/kanon/issues/277)). Kanon's `review.yml` pins a release from before them | `K-AGENT-24` | not yet installed |
| Re-delivery and retry logic that reads run history for the head | `K-PRIN-13` | not yet installed |
| The merge gate: the Merger's verdict function, its merge step, its escalation markers and post-merge checks | `K-PRIN-4`, `K-PRIN-5`, `K-PRIN-10`, `K-MERGE-1`, `K-MERGE-3`, `K-MERGE-4`, `K-MERGE-5`, `K-MERGE-9`, `K-MERGE-10`, `K-MERGE-11`, `K-MERGE-12`, `K-AGENT-4`, `K-AGENT-13`, `K-AGENT-26`, `K-LAYOUT-8` | not yet installed |
| A ruleset bypass list naming only the release bot. Today it holds the repository admin role, for pull requests only. The Owner decided that it stays until the Releaser App exists ([#49](https://github.com/yedeya-labs/kanon/issues/49)), and is then replaced by a bypass for the Releaser only | `K-MERGE-5`, `K-MERGE-8` | not yet installed |
| The red-test check on agent-authored pull requests | `K-PRIN-4`, `K-MERGE-13`, `K-AGENT-15` | not yet installed |
| The watching agent (Overseer): read-only permissions, tool allow-list and prompt | `K-PRIN-6`, `K-AGENT-35`, `K-SELF-9`, `K-SELF-11` | not yet installed |
| The Explorer: exploration and sweep workflows on an isolated stage, its run-report writer and its filing gate | `K-AGENT-9`, `K-AGENT-10`, `K-AGENT-11`, `K-SPEC-8`, `K-OBS-7` | not yet installed |
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
| The lint chain runner, the path and citation guards, the flag guard and the permissions guard | `K-SELF-1`, `K-SELF-3`, `K-SELF-4`, `K-AGENT-37` | not yet installed |
| The calibration record, the run-record writer, and the capability ledger's watermark reader | `K-SELF-13`, `K-SELF-15`, `K-SELF-17`, `K-LAYOUT-7` | not yet installed |
| The installer, beyond `kanon apps` and `kanon milestones` | `K-ADOPT-1`, `K-ADOPT-2`, `K-ADOPT-3`, `K-ADOPT-7`, `K-OBS-18` | not yet installed |
| Planned guards the rules name but Kanon hasn't built | `K-PRIN-2`, `K-PRIN-18`, `K-WORK-22`, `K-SPEC-9`, `K-SPEC-10`, `K-MERGE-8`, `K-PROJ-14`, `K-PROJ-18`, `K-OBS-16`, `K-OBS-17`, `K-SELF-14`, `K-ADOPT-6`, `K-ADOPT-10`, `K-ADOPT-11`, `K-LAYOUT-10` | not yet installed |
| The sign-off delegation record (`docs/qa/sign-off-delegation.md`), naming the Owner, and Kanon's project-setup hook adding its sign-off to the Implementer's commits | `K-AGENT-44`, `K-LAYOUT-14` | installed 2026-10-04 |
| The exemptions file (`docs/qa/exemptions.md`), read by the brief guard and the doc-path guard; Kanon runs neither guard on itself yet | `K-LAYOUT-15` | not yet installed |

These rules' lines are prose only with a note, and name nothing to install: `K-PRIN-1`, `K-PRIN-7`, `K-PRIN-20`, `K-AGENT-3`, `K-PROJ-8`, `K-PROJ-15`, `K-OBS-4`, `K-SELF-7`, `K-LAYOUT-1`, `K-LAYOUT-6`.

**Not yet installed, and why:**

- **The Implementer** is not yet on. Its App, callers, register row and sign-off delegation are in place (ADR 0011, stage 2); what remains is moving Kanon's pins to the first release that includes [#234](https://github.com/yedeya-labs/kanon/issues/234).
- **The Explorer** has an App and a register row, and no caller yet: the code-audit caller comes with plan 0004's step 11a.
- **The Lead** waits for the Owner's decision (ADR 0011).
- **No hosted telemetry yet:** the store is plan 0002, in progress.
- **The admin bypass on the `main` ruleset** stays until the Releaser App exists (#49), by the Owner's decision. It is then replaced by a bypass for the Releaser only, which installs `K-MERGE-8`'s bypass list.
- **No agent ever merges on Kanon** (ADR 0011), so the merge gate and the Merger are not planned here.

## Choices

- **Chat channel:** not yet decided. None is configured.
- **Who merges:** the Owner, always (ADR 0011).
- **Which pull requests are reviewed:** members' only (ADR 0011).
- **Overseer:** `not installed`
- **No reference environment.** Kanon deploys nothing: a release is a tag and a GitHub release. So this record declares none of `K-LAYOUT-10`'s reference-deploy bullets, and no project on Kanon can close by `K-PROJ-11` until it does. Kanon doesn't run the reconciler yet (see Mechanisms).
