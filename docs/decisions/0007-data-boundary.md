# 0007. The data boundary

- **Status:** accepted
- **Date:** 2026-09-28

## Context

Kanon's pipeline produces two kinds of data:

- **Telemetry:** what each agent run cost, how long it took and how it ended.
- **QA data:** run reports and findings, route coverage, signal precision, the code-reading ledger, and the embeddings used to deduplicate findings.

In the reference adopter, both live in one store inside that project's staging environment. Kanon is meant for other teams, and will offer a hosted telemetry service. So before any other team's data arrives, three things had to be decided: what may leave a project, where each kind of data is kept, and who may see it.

## Decision

Written as rules `K-OBS-16`, `K-OBS-17` and `K-OBS-18` in [chapter 08](../../rulebook/08-observability-and-cost.md).

1. **Telemetry is metadata, never content.**
   - **Allowed:** the repository, issue and PR numbers, the agent *role*, lane, model, tokens, cost, duration, outcome, and a reason from a fixed list of codes.
   - **Never:** code, prompts, issue or PR text, file paths, error messages, other free text, or GitHub usernames.
2. **QA data stays in the adopter's own cloud account.** Kanon's infrastructure code creates it there. Its lifecycle is independent of any application stage, so an environment teardown can never delete it.
3. **Sending telemetry to the Kanon-hosted service is opt-in.** By default the same collector writes to the adopter's own store.
4. **Hosted telemetry is kept in the EU, in Frankfurt (`eu-central-1`), for thirteen months**, and an adopter's data is deleted on request.
5. **Each adopter sees only their own data.** Anything shared across adopters, including published cost figures, is aggregated and anonymised.

## Why

- **Telemetry must be safe to leave a project by construction, not by review.** Free text is how content leaks: a bail reason or an error message can quote code, and a file path reveals a project's structure. A fixed schema with reason codes closes that route.
- **Without usernames, telemetry holds no personal data.** That keeps hosted telemetry almost entirely outside GDPR. The EU region covers the rest, and suits Kanon's starting point.
- **QA data describes the adopter's application.** It is their content, not Kanon's. Keeping it in their account means Kanon never holds another team's code findings.
- **Opt-in protects trust.** An open-source tool that sends data home by default loses the trust it depends on. The cost is that the cross-adopter improvement work learns only from adopters who opt in, so the benefit of opting in has to be visible to them.
- **Thirteen months** is long enough for year-on-year comparisons, and no longer.

## Consequences

- **The roadmap's operational-store step splits the reference adopter's store.**
  - *Telemetry* moves to the Kanon account; the reference adopter opts in.
  - *QA data* stays in the reference adopter's account, but moves out of its staging stage.
  - Migrated telemetry rows are cleaned to meet rule 1: roles replace usernames, and codes replace free-text reasons.
- **The reason codes need defining** before the collector can validate rows. The reference adopter's existing bail and failure reasons are the starting list.
- **Every adopter needs cloud infrastructure** for its QA store, even if it never opts in to hosted telemetry. That is recorded in the principles chapter as part of what Kanon assumes about an adopter.
