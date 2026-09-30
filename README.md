# Kanon

> **κανών** (*kanōn*): a measuring rod; the rule that work is checked against.

Kanon is an **opinionated agentic development workflow**. AI agents file, triage, implement, review and ship the work on a GitHub project, and they do it under a fixed set of rules. The rules are enforced by guards that fail the build, not by good intentions.

**Kanon is not configurable, on purpose.** A project adopts Kanon by accepting its opinions and following its rules. If a rule doesn't fit your project, one of two things is true: the rule is wrong and Kanon should change it, or your project is outside what Kanon is for. Either way the answer is recorded, never worked around with a setting. See [ADR 0002](docs/decisions/0002-standardise-dont-parameterise.md).

## What Kanon is

Kanon's value is the **governance**, not the orchestration. Running agents in GitHub Actions is a solved problem. Deciding what they may do, what counts as done, and who has the last word is not. The opinions cover:

- **Work items:** one taxonomy of labels, severities and milestone kinds, and a clear line between what an agent may decide and what a human must.
- **Specs as acceptance criteria:** behaviour is stated once, as a numbered invariant, and every issue's acceptance criteria cite it.
- **Review until approval:** an adversarial reviewer agent, and a human who merges.
- **Isolation:** one issue, one worktree, one database.
- **Cost and signal discipline:** anything that raises spend is discussed first, and every operational signal has a recorded decision.
- **Guards on everything above**, including guards on the guards.

## Status

**Private draft.** Kanon is being extracted from the project where it grew up (the *reference adopter*). The order of work:

1. **Rulebook:** write every opinion down with its reason, and class it as framework opinion or project policy. See [`rulebook/`](rulebook/).
2. **Second adopter and extraction, together:** Kanon was installed on a second project from the rulebook alone, and every point of friction was logged. That project now continues with humans playing the agent roles, and each piece of Kanon's code (agent lanes, guards, playbooks, the operational store) lands on it first as it is extracted. See [ROADMAP.md](ROADMAP.md).
3. **Before going public:** choose a licence, build an installer, and publish real per-run cost data.

To adopt Kanon, start with [10 Adoption](rulebook/10-adoption.md).

## Layout

| Path | What |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | The phases of the extraction, and the decisions still needed. |
| [`rulebook/`](rulebook/) | The opinions. This is the product's specification. |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records: why Kanon is shaped the way it is. |
| [`actions/`](actions/) | Kanon's checks, each a versioned composite action an adopter uses by reference. [`pr-title`](actions/pr-title/README.md) checks the PR title, and [`dco`](actions/dco/README.md) checks every commit's sign-off. |
| [`tests/`](tests/) | Kanon's own unit tests, run by CI on every pull request. |
| [`.github/workflows/`](.github/workflows/) | Kanon's own CI, its PR-title check (using its own action), and the reusable [release workflow](docs/release.md) that adopters call and Kanon calls itself. |
| `package.json`, `release-please-config.json`, `.release-please-manifest.json` | Kanon's test harness (lint, type-check, Vitest) and its release configuration. |
| `CHANGELOG.md` | Written by the release workflow from the merged PR titles. It appears with the first release. |
