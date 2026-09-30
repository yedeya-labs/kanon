# The Kanon rulebook

This is the specification of Kanon. Adopting Kanon means accepting every rule in it that is classed **framework**. There is no configuration, and a rule is never switched off for one project ([ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md)).

## How a rule is written

Every rule has the same shape:

> ### `K-<AREA>-<n>` Short imperative title
>
> **Rule.** One or two sentences, imperative, project-neutral.
>
> **Why.** The reason. A rule an adopter can't opt out of has to say why it exists. Where a real incident taught the rule, describe the incident in general terms, without naming the project it happened in, its issues or its files.
>
> **Enforced by.** The guard that fails when the rule is broken, or **prose only**. A prose-only rule is a known weakness, and the list of them is Kanon's own backlog.
>
> **Class.** One of the following:
> - **framework**: every adopter follows it.
> - **split**: the mechanism is framework and the content is the project's. For example, "some paths need a human to merge" is framework; *which* paths is the project's. The rule names both halves.
> - **project policy**: an example from the reference adopter, kept because it shows a framework rule in action. Not binding on anyone else.

Rule ids are permanent. A retired rule keeps its id and is marked **retired**, with the reason and a pointer to what replaces it. A new rule takes the next number in its chapter.

## Chapters

| # | Chapter | Covers |
|---|---|---|
| 00 | [Principles](00-principles.md) | What Kanon is for and not for; standardise, don't parameterise; humans decide product intent; a guard must be able to fail |
| 01 | [Work items](01-work-items.md) | Issues, labels, severity, milestone kinds (buckets vs roadmap), what an agent may route and what a human decides |
| 02 | [Specs](02-specs.md) | Numbered behavioural invariants; acceptance criteria cite them rather than restating them |
| 03 | [Agents](03-agents.md) | Roles, identities, GitHub Apps and permissions, lanes, and what each agent may do |
| 04 | [Review and merge](04-review-and-merge.md) | Adversarial review until approval, severity on follow-ups, the human merge gate, escalation paths |
| 05 | [Workspace](05-workspace.md) | One issue, one worktree, one database; assigned ports |
| 06 | [Shipping](06-shipping.md) | PR titles, closing references, releases |
| 07 | [Projects](07-projects.md) | Briefs, decomposition, splitting, closure |
| 08 | [Observability and cost](08-observability-and-cost.md) | Every signal has a recorded decision; spend is discussed before it is incurred |
| 09 | [Self-maintenance](09-self-maintenance.md) | The pipeline auditing itself: the Overseer, telemetry, guards on the guards |
| 10 | [Adoption](10-adoption.md) | The installation checklist, the GitHub organisation and plan, bootstrap, credentials, how Kanon reaches an adopter's agents |
| 11 | [Repository layout](11-repository-layout.md) | Every fixed path and machine-read format: specs, registries, governance documents, the brief's syntax |

The brief template ships at [`templates/brief.md`](templates/brief.md).

## Assumptions Kanon makes about an adopter

Kanon is not for every project. It assumes:

- **a GitHub organisation** for code, issues, pull requests and Actions, never a personal account ([ADR 0008 §2](../docs/decisions/0008-installation-test-decisions.md), `K-ADOPT-2`);
- **GitHub's plan decides which platform features exist.** Kanon uses the merge queue and environment approval wherever the plan provides them, and a fixed, recorded fallback where it doesn't; rulesets have no fallback (`K-ADOPT-3`);
- **adoption starts in bootstrap.** An empty repository is inside the target: it adopts Kanon in a named bootstrap state, with every exception recorded, and leaves it once, when its Reviewer exists and approval is required (`K-ADOPT-4` to `K-ADOPT-6`);
- **Claude Code** as the agent runtime;
- a **test suite the agents can run**, locally and in CI;
- **a human who owns the merge.** Every merge is made either by a human (always, during bootstrap), or by a merger agent inside a green zone the project defines, and escalation paths always go to a human ([ADR 0004 §1](../docs/decisions/0004-disputed-rules.md)). An agent never widens its own authority.

The complete list, and what each assumption costs a project that doesn't meet it, belongs in [00 Principles](00-principles.md).
