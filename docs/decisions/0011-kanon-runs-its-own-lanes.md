# 0011. Kanon runs its own agent lanes, from its last release

- **Status:** accepted
- **Date:** 2026-10-02
- **Decided in:** [#22](https://github.com/yedeya-labs/kanon/issues/22)
- **Amended:** 2026-10-04, stage 2 ([#195](https://github.com/yedeya-labs/kanon/issues/195))

## Context

Kanon runs its own PR-title check, DCO check and release workflow, but none of its agent lanes. The lanes are being moved into Kanon from the reference adopter ([ADR 0009](0009-move-dont-rewrite.md), [plan 0001](../plans/0001-move-the-agent-lanes.md)). Once they are here, nothing yet runs them on the repository that ships them.

Kanon should be its own first adopter, because:
- **every lane change then runs on Kanon** before a release reaches any other adopter;
- **Kanon has no database and no app,** so its own runs test the stack-neutral path that every lane must support;
- **"this repository is maintained by the workflow it ships"** is the strongest evidence a public repository can give.

If Kanon can't adopt Kanon, then either a rule is wrong or Kanon is narrower than it claims ([ADR 0002](0002-standardise-dont-parameterise.md)).

## Decision

1. **The rollout is staged, and starts during the extraction.**
   - **After step 4 of plan 0001,** when the review lane is in Kanon, the Reviewer runs on Kanon's own PRs. The Reviewer makes no commits, so sign-off doesn't arise yet. From then on, each remaining extraction PR is reviewed by the lane it extracts. This is plan 0001's step 4b, and its App is created with `kanon apps` at step 4a ([#39](https://github.com/yedeya-labs/kanon/issues/39)).
   - **Stage 2, the Implementer.** Its preconditions are in the rulebook: delegated sign-off for the repository's own agents ([#23](https://github.com/yedeya-labs/kanon/issues/23), `K-AGENT-44`), and security as a principle, with its rules for untrusted content, least privilege and pinning ([#24](https://github.com/yedeya-labs/kanon/issues/24)). So Kanon calls the implement and implement-revise lanes from `implement.yml` and `implement-revise.yml`. A member starts it by labelling an issue `agent:implement`; it opens a pull request that the Reviewer reviews, answers the Reviewer's changes-requests on it, and the Owner merges. It needs the Implementer's App, which the Owner creates with `kanon apps`; until then the callers are inert (see Consequences).
   - **The Lead later, by the Owner's decision.** It isn't scheduled. Its App doesn't exist, and the Lead's reconciler finds the Implementer's runs by the caller's file name, `agent-implement-revise.yml` (`K-LAYOUT-18`), which on Kanon is the lane itself. Turning the Lead on needs an answer to that first.
   - **No agent ever merges on Kanon.** The repository is public and it is the product, so the Owner merges.
2. **Kanon calls its own lanes at its last release tag, never through `$/`.** A PR that changes the Reviewer is then reviewed by the released Reviewer, not by itself. This is the bootstrap: the stable compiler builds the next one. It is the Kanon-specific case of a general rule, that a pull request never chooses the rules it is judged by ([#25](https://github.com/yedeya-labs/kanon/issues/25), `K-MERGE-17`). An adopter meets that rule through the lane's *inputs*; Kanon also meets it for the lane's *code*.
3. **Only members' PRs are reviewed.** Kanon is public, so a stranger's PR is input, never a trigger for a paid agent run (#24).
4. **Agent usage is out of Kanon's scope.** Whether an adopter shares one Claude subscription across its repositories or keeps them separate is the adopter's choice.

## Why the last release, and what it costs

- **What it costs:** a lane change is first exercised one release later, not on its own PR.
- **What bounds that cost:** Kolophon takes every release through Dependabot, so it runs each release first, and Kanon's next PR runs it too. A broken release therefore shows up within one PR, and is rolled back by pinning the previous tag.
- **Why not `$/`:** through `$/`, a PR's lane code would review that same PR. A PR that weakened the Reviewer would be reviewed by the weakened Reviewer, with only the Owner's merge left to catch it.

## Consequences

- **Plan 0001 gains step 4b:** turn the Reviewer on for Kanon's own PRs, pinned to the previous release, members' PRs only. Its falsifier: a review of a Kanon PR posts a verdict and its cost row.
- **Kanon's lane callers, CI's `lane-check` step, and the two checks below, are the only places in Kanon that name `yedeya-labs/kanon/…@vX.Y.Z`.** Everywhere else, Kanon reaches its own files through `$/` (plan 0001 §4). When step 4b adds the lane callers, the self-pinning test exempts them by name, and Dependabot proposes each new release to them, as it does for any adopter. Step 4b also runs `lane-check` in CI at the same release, for the same reason as the two checks below: it judges the caller, so a PR can't bring its own.
- **The same bootstrap applies to the checks that judge a Kanon PR** ([#47](https://github.com/yedeya-labs/kanon/issues/47)). The required DCO and PR-title checks call `yedeya-labs/kanon/actions/dco@vX.Y.Z` and `…/actions/pr-title@vX.Y.Z`, never `$/`, so a PR can't weaken the check that passes it. The self-pinning test exempts exactly those two calls, `tests/unit/workflows.test.ts` fails if a required check other than a smoke run calls anything through `$/`, and Dependabot proposes each release to them in a group of their own, exempt from its cooldown. The exemption is written out, because an entry with no `cooldown` gets Dependabot's default of 3 days, which held 13 releases back ([#233](https://github.com/yedeya-labs/kanon/issues/233)). The PR's own copies run in `judging-actions-smoke.yml`, which isn't required, so a broken change still turns CI red. A change to either action judges PRs from the release after it merges.
- **The Explorer follows, in two modes** ([plan 0004](../plans/0004-move-the-remaining-lanes.md), decision 13, decided by the Owner on 2026-10-03). Once the code-audit lane moves, Kanon audits its own code with it, through a caller pinned to the previous release like the Reviewer's. Once the hosted telemetry store is live, the Explorer also reads its aggregates for anomalies. Both file on Kanon.
- **#23 and #24 no longer hold the Implementer back.** Both were closed on 2026-10-02. With them:
  - **Its commits pass Kanon's own DCO check.** The Owner records the delegation in [`docs/qa/sign-off-delegation.md`](../qa/sign-off-delegation.md) (`K-LAYOUT-14`). `claude-code-action` writes its own default bot into git config and adds no sign-off, so the lanes' [`agent-setup`](../../actions/agent-setup/README.md) block does both, for Kanon as for any adopter ([#234](https://github.com/yedeya-labs/kanon/issues/234)): it authors each commit as the minted App and adds the delegate's `Signed-off-by:`. `tests/unit/agent-commits.test.ts` judges such a commit with the `dco` action's own check. Kanon's project-setup hook did this for the Implementer alone until then, and no longer does.
  - **It acts on members' work only** (`K-AGENT-45`): the lanes' membership gate admits an `agent:implement` label or a dispatch from a member, and a review from a member or a registered App, so a stranger's issue is never built until a member labels it.
- **The Implementer was inert until its App existed.** Until the Owner created it, `IMPLEMENTER_APP_ID` and `IMPLEMENTER_APP_PRIVATE_KEY` were unset, which GitHub passes to the lanes as empty strings without failing the run (verified 2026-10-04 on a throwaway branch): every other event ended in the lanes' first job, which mints nothing, and an `agent:implement` label or a dispatch failed at the token mint, by name, before any model run. The Owner created `kanon-implementer` with `kanon apps` on 2026-10-05, and its row in the [App register](../qa/agent-identities.md) is live; `apps-check` passed the same day. Activation, the steps that remain: move Kanon's pins to the first release that includes [#234](https://github.com/yedeya-labs/kanon/issues/234), whose lanes sign the Implementer's commits off (before it, they are authored `claude[bot]` and fail `dco`); then label an issue `agent:implement`.
- **What it costs.** Kanon is public, so its Actions minutes are free. The model runs on `CLAUDE_CODE_OAUTH_TOKEN`, the Claude subscription the Reviewer already uses, so a run spends that pool's quota and adds no bill (decision 4). An implement run is capped at 300 turns, as for any adopter.
