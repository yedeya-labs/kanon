# 0005. Human roles, and standard lane settings

- **Status:** accepted; §5 was settled by [ADR 0006](0006-stakeholder-decisions.md), and §6 by [ADR 0007](0007-data-boundary.md); §2 amended 2026-10-15
- **Date:** 2026-09-28

## Context

The first draft of the rulebook left several questions for a product decision rather than guessing. This record settles them.

## Decisions

### 1. Owner and Maintainer

The reference adopter has one person doing both jobs. For teams, they split like this:

- **The Owner** administers the repository (GitHub Apps and their keys, App permissions, rulesets), agrees any change that raises spend, and is the only person who widens the Merger's green zone.
- **The Maintainer** merges anything outside the green zone, answers escalations, approves project briefs by merging them, promotes spec clauses, curates the Overseer's output, and approves production promotion.

One person may hold both roles. The roles still exist separately, so a team can split them without the rules changing.

### 2. Kanon fixes each lane's model, effort, turn cap and budget

Each lane's settings come from **Kanon's standard lane table**, which ships with Kanon's code and is the table's only home. Adopters don't edit it. Changing a value is a change to Kanon, argued from telemetry across adopters.

*Why:* this is [ADR 0002](0002-standardise-dont-parameterise.md) applied to the lanes. A per-project setting could not be compared across adopters, and every guard that checks lanes against their settings would have a second opinion to agree with. It also makes cost data from different adopters comparable, which is the point of the telemetry.

*Consequence:* an adopter on a plan that can't use a model in the table is outside Kanon's target until Kanon supports that plan. That is recorded as friction, not solved with a setting.

**Amended 2026-10-15, by the Owner's decision on [#891](https://github.com/yedeya-labs/kanon/issues/891): a turn cap raised for one dispatched run.** Adopters still don't edit the turn cap. A person may raise one lane's turn cap for **one dispatched run**, with a reason, up to a ceiling Kanon fixes per lane at twice the cap; the run's dollar ceiling is derived from the raised cap at §3's rate. Tests hold it: `agent-run` refuses, before any model call, a raise above the ceiling, not a whole number, without a reason or on a run that wasn't dispatched; `lane-check` fails a caller that passes `max_turns` as anything but its own dispatch input; and `tests/unit/agent-run-turn-budget.test.ts` holds every lane's cap and ceiling. The cap and ceilings are in [docs/lanes.md, "The turn budget"](../lanes.md#the-turn-budget).

*Why this isn't configuration:* nothing is stored in the repository. The raise lives in one dispatch's inputs, chosen by a person for one run that stopped at its cap on work that can't be divided, and gone when that run ends; every other run of the lane, on every adopter, runs the table's cap. So the lanes still have one setting each, and ADR 0002 holds. A raised run's configuration fingerprint differs from its lane's other runs; that is accepted, because the run records it: its telemetry row carries the cap that bound it, and its step summary the raise and the reason, so cost comparisons can tell it apart.

### 3. Kanon ships the per-turn rate behind the dollar ceilings

Each agent run's dollar ceiling is derived from its turn cap at a per-turn rate. That rate is part of the standard lane table, so every adopter's ceilings are derived the same way.

### 4. Project briefs live in `docs/projects/`

The file name is the tracking issue's number. Files whose names start with an underscore are apparatus (for example the template), not briefs.

### 5. Stakeholder involvement: settled by ADR 0006

**Settled:** the Stakeholder decides whether a `gate-candidate` joins the launch gate. It's roadmap placement, and roadmap placement is the Stakeholder's.

**Open:** a brief that places work on a roadmap milestone often reflects a discussion the Stakeholder and the Maintainer had outside the workflow. Today the Maintainer's merge of the brief is the only record of it. What remains to decide is how directly Kanon involves the Stakeholder: whether that agreement is recorded or approved inside the workflow, and more broadly how much of the workflow the Stakeholder touches at all.

### 6. The data boundary: settled by ADR 0007

**Settled:** what telemetry may contain, where each kind of data is kept, and who may see it are decided in [ADR 0007](0007-data-boundary.md), and written as rules `K-OBS-16` to `K-OBS-18`. When this record was accepted, the question was still open.

## Consequences

The following were updated to match:
- `K-AGENT-37` (lane settings) and `K-OBS-12` (dollar ceilings) are now framework, not split.
- `K-WORK-10` names the Stakeholder.
- `K-PROJ-2` names the brief directory.
- The roles table in chapter 03 gives the Stakeholder the `gate-candidate` decision.
