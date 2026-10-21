# Overseer playbook: Kanon

How the Overseer audits Kanon's own pipeline ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), amended 2026-10-06 by [#423](https://github.com/yedeya-labs/kanon/issues/423)). It starts from Kanon's baseline (`rulebook/templates/playbooks/overseer-playbook.md`) and adds what is different here: Kanon's callers aren't at their lanes' file names, so the baseline's way of finding a lane's runs finds nothing on Kanon.

Cite a rule by its id; don't restate it (`K-PRIN-2`). The Overseer may only propose or restrict (`K-AGENT-35`), and marks every proposal unverified (`K-SELF-10`).

## Liveness queries

Tell a run that died from one that skipped by reading full run records, never a summary, and reach a renamed workflow's earlier runs by its workflow id (`K-SELF-12`).

**Kanon's lane callers are not at their lanes' file names.** On Kanon, `.github/workflows/agent-<lane>.yml` is the lane itself, a reusable workflow, so GitHub files no run under it. A lane's runs are filed under the caller that called it (`K-LAYOUT-18`'s exception, waived by name in the [adoption record](adoption.md)):

| Lane | Kanon's caller | Its triggers |
|---|---|---|
| Review | `review.yml` | CI finishing, a review label, a pull request opened, a dispatch |
| Implement | `implement.yml` | an `agent:implement` label, a dispatch |
| Implement, revise | `implement-revise.yml` | a changes-request, a label, a dispatch |
| Rebase (resolve a conflict) | `rebase.yml` | CI finishing on `main` (refused under the merge queue, [#79](https://github.com/yedeya-labs/kanon/issues/79)), a merged pull request (`pull_request_target` closed on `main`, [#484](https://github.com/yedeya-labs/kanon/issues/484)/[#512](https://github.com/yedeya-labs/kanon/issues/512)), daily (sporadic, [#397](https://github.com/yedeya-labs/kanon/issues/397)), a dispatch |
| Code audit | `code-audit.yml` | every three days, a dispatch |
| Overseer | `overseer.yml` | weekly, a dispatch, a merged pull request that moves its Kanon pin |
| Explore the telemetry | `explore-telemetry.yml` | weekly (Tuesday 06:30 UTC), a dispatch |
| Triage | `triage.yml` | an issue label (`qa:needs-triage`), a dispatch; since 2026-10-12 |
| Dispatch sweep | `dispatch-sweep.yml` | daily (04:30 UTC), a dispatch; since 2026-10-12 |
| Merge reconcile | `merge-reconcile.yml` | a review submitted, a pull request closed, a dispatch; since 2026-10-12 |
| Lead, brief | `lead.yml` | a dispatch only; since 2026-10-12 |
| Lead, revise | `lead-revise.yml` | a review submitted, a label, a dispatch; since 2026-10-12 |
| Lead, split | `lead-split.yml` | an issue label (`qa:needs-split`), a dispatch; since 2026-10-12 |
| Lead, reconcile | `lead-reconcile.yml` | hourly (minute 7), a pull request or issue closed, a dispatch; since 2026-10-12 |
| Verify acceptance criteria | `verify-acs.yml` | an issue label, a dispatch; since 2026-10-12 |
| Merge (the Merger) | `merge.yml` | CI finishing on `main`, a review submitted, hourly (minute 37), a dispatch; since 2026-10-12 |
| Daily project digest | `project-digest.yml` | daily (07:00 UTC), a dispatch; since 2026-10-14, for its health job ([#813](https://github.com/yedeya-labs/kanon/issues/813)), and with no `DIGEST_WEBHOOK` its digest posts nothing |
| Issue backstop | `issue-backstop.yml` | an issue opened (by anyone, an outsider included), a dispatch; since 2026-10-20 |

**Re-delivery finds these callers.** Since 2026-10-16, when Kanon's callers moved to v0.40.2, the library lists a lane's runs, and dispatches a re-review, through the lane's caller (`scripts/lib/lane-caller.mjs`, [#726](https://github.com/yedeya-labs/kanon/issues/726)), not by the lane's file name. It looks the caller up on the default branch, and on Kanon finds each one in the table above through its `caller.misplaced` waiver in [the adoption record](adoption.md) (its re-delivery row). So a re-delivery, or a failed re-review dispatch, on a Kanon pull request whose lane did run is not a known gap: judge it as you would on any adopter. Only when the default branch can't be read, or no workflow on it calls the lane, does the lookup fall back to the lane's file name, and the run's log then says so ("its runs are looked for under …"). Name that cause when you find it.

**A review that never landed is re-asked before it is a finding** ([#1197](https://github.com/yedeya-labs/kanon/issues/1197)). The dispatch sweep re-asks the review once per head for an open pull request that carries `review:please`, has CI done and has no Reviewer review on its head, and leaves a Lead comment carrying `<!-- qa:review-reask sha=<head> -->` ([the dispatch sweep](../lanes.md#the-dispatch-sweep)). So such a pull request is a finding only when its head already carries that comment and still has no review: the re-ask ran, and the review was dropped again.

Read them with `gh run list --workflow <caller> --json databaseId,event,status,conclusion,createdAt,headBranch` and `gh run view <id> --json jobs`. The runs filed under `agent-lanes-smoke.yml`, `agent-blocks-smoke.yml` and the other smoke workflows are tests of the lane code on a pull request, not the pipeline running: never count them as a lane's runs.

**A run whose gate job concluded `skipped`, or whose agent job never started, is a skip, not a death:** the membership gate turned the event away (a label other than the lane's, a stranger's act, a closed pull request that didn't merge), or the Overseer's runtime-version check found the runtime no newer than the watermark. A death is a run whose agent or filing job failed or was cancelled. **`explore-telemetry.yml` is the exception to "agent job never started":** its agent job (`explore`) needs the `aggregate` job, so a run whose `aggregate` job failed or was cancelled is a death (the role's trust, the function or the answer check broke), while a run that ended at `unconfigured`, or whose `aggregate` succeeded with nothing in it and so skipped `explore`, is a skip.

**Kanon's schedules fire only now and then** ([#397](https://github.com/yedeya-labs/kanon/issues/397), closed as not planned: GitHub started 3 scheduled runs in about 15 hourly slots). So a missing scheduled run of any scheduled caller in the table above (the code audit, the Overseer, the rebase lane, the telemetry Explorer, the dispatch sweep, the Lead's reconciler, the Merger or the project digest) is that, not a lane that died. Name it once, in the audit, and file nothing new for it. The rebase lane starts after every merge through the queue, on the merged pull request, and a dispatch is the immediate retry: a conflicting Implementer pull request that stays conflicting after a later merge's rebase run is a skip or a death to judge, and worth naming.

## Backlog dynamics

Measure the follow-up rate and the net open-issue rate, never set a target for them (`K-WORK-20`), and calibrate any threshold on the corpus it governs (`K-SELF-13`).

- **Net open-issue rate:** issues opened minus issues closed per ISO week, from `gh issue list --state all --limit 500 --json number,createdAt,closedAt,labels,milestone`.
- **Follow-up rate:** of the pull requests merged in the week (`gh pr list --state merged --search "merged:>=<monday>" --json number,body`), the share whose review filed a follow-up issue, which the Reviewer links from its review.
- **Kanon's corpus is small and young** (the repository was created 2026-09-30), so report the counts with the rates, and compare a week only with the weeks before it here.

## Capability review

Review the agent runtime's releases since the watermark, record each proposed disposition in the `Ledger delta`, and file capability issues sparingly, saying that the watch ran (`K-SELF-16`, `K-SELF-17`). The ledger is [`docs/qa/capability-ledger.md`](capability-ledger.md); the Owner keeps it.

- **Kanon turns the capability watch on:** its adoption record declares ``- **Capability watch:** `on` `` under `## Choices` (`K-LAYOUT-10`, [#477](https://github.com/yedeya-labs/kanon/issues/477)), because Kanon maintains the runtime pin every adopter runs. The choice is off by default, so an adopter's Overseer skips the review.
- **The runtime is the one the release Kanon's callers pin runs:** the `anthropics/claude-code-action` pin in that release's `actions/agent-run/action.yml`, and the Claude Code CLI it installs, which `.github/scripts/reviewer-grant-record.json` records. The watermark is not defined as that version: it is the last Claude Code CLI version the review went through, written as the CLI's changelog heads its releases, so it can be ahead of the CLI the pinned release installs. Never lower a delta's watermark to the installed CLI: that would review the versions between them again. The runtime-version trigger audits only when the installed CLI is newer than the watermark. A runtime bump merged on Kanon reaches Kanon's own lanes only when the release that carries it reaches the callers' pin, one release later (ADR 0011).
- **A run whose trigger is `pull_request_target` is the runtime-version trigger** (the prompt names the trigger): the lane only gets this far when the runtime of the release it runs is newer than the ledger's watermark, so the review is due whatever week it is. Its audit carries its `Ledger delta` and is the next run's anchor, so a weekly run later that week is not due.
- **On that trigger the QA store is `degraded`, and that is expected:** the store's role trusts only `main`'s ref, and a `pull_request_target` token names the pull request. Say so in one line; it isn't a finding. The weekly run and a dispatch on `main` read the store.
- **On Kanon, every capability the review raises is Kanon's to act on.** Its operation is a Kanon lane, block or script, so it is a finding with subject `lane`, `guard`, `rule` or `library`, and the adoption record's `Upstream findings: filed here` files it on Kanon.
