# 0011. Kanon runs its own agent lanes, from its last release

- **Status:** accepted
- **Date:** 2026-10-02
- **Decided in:** [#22](https://github.com/yedeya-labs/kanon/issues/22)

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
   - **After step 5,** the Lead and the Implementer follow, once their preconditions are in the rulebook: delegated sign-off for the repository's own agents ([#23](https://github.com/yedeya-labs/kanon/issues/23)), and security as a principle, with its rules for untrusted content, least privilege and pinning ([#24](https://github.com/yedeya-labs/kanon/issues/24)).
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
- **The same bootstrap applies to the checks that judge a Kanon PR** ([#47](https://github.com/yedeya-labs/kanon/issues/47)). The required DCO and PR-title checks call `yedeya-labs/kanon/actions/dco@vX.Y.Z` and `…/actions/pr-title@vX.Y.Z`, never `$/`, so a PR can't weaken the check that passes it. The self-pinning test exempts exactly those two calls, `tests/unit/workflows.test.ts` fails if a required check other than a smoke run calls anything through `$/`, and Dependabot proposes each release to them in a group of their own, with no cooldown. The PR's own copies run in `judging-actions-smoke.yml`, which isn't required, so a broken change still turns CI red. A change to either action judges PRs from the release after it merges.
- **The Lead and Implementer wait for #23 and #24.** Without delegated sign-off, an Implementer's commits can't pass Kanon's own DCO check. Without the security rules, an agent on a public repository can act on a stranger's text.
