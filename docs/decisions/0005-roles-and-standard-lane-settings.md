# 0005. Human roles, and standard lane settings

- **Status:** accepted; §5 was settled by [ADR 0006](0006-stakeholder-decisions.md), and §6 by [ADR 0007](0007-data-boundary.md)
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
