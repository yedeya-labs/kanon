# 0014. Who adopts Kanon, and which of them comes first

- **Status:** accepted
- **Date:** 2026-10-06
- **Decided in:** [#288](https://github.com/yedeya-labs/kanon/issues/288), by the Owner on 2026-10-06, building on [plan 0005](../plans/0005-lean-installation.md) and [ADR 0013](0013-personal-accounts-and-two-apps.md)

## Context

[Plan 0005](../plans/0005-lean-installation.md) makes the installation short: two Apps per owner, personal accounts first-class, `kanon init` to inspect a repository and write what it lacks, and `kanon doctor` to name what a release needs before the pin moves (§5.4, §5.5). It says *what* the installation does, but not *who runs it*, or through what. That choice shapes the commands: a command a person types once can prompt and print prose, while one that another program drives can't.

The Owner was asked who Kanon is for, and asked to have the answer recorded with the analysis behind it. This ADR records both. It positions Kanon; it specifies nothing that plan 0005 doesn't already, beyond the two properties in Decision 2.

## The audiences

### 1. Developers with an AI agent client

A developer who already works with an agent in their editor or terminal installs Kanon *from that agent*. Kanon ships a small set of skills, or agent instructions, that wrap `kanon init` and `kanon doctor`:
- **inspect** the repository and its owner, as `init` does;
- **explain each choice in plain words** before making it: which lanes, which defaults, what the plan can't enforce;
- **write the files**, and show the diff;
- **walk the person through the steps only a person can take**: creating the Apps through GitHub's App-manifest flow where possible (`kanon apps`, [docs/apps.md](../apps.md)), setting the secrets, and the ruleset where the plan has one.

This is #288's guided path, delivered as skills rather than as a longer interactive prompt. The agent does the reading and the explaining; the commands stay the source of truth.

### 2. Less technical builders, through a webapp

A builder who wants to describe *what they want to build* uses a webapp for that, and Kanon is one gear of its scaffolding. The webapp could absorb the mechanical steps a person takes today, such as the manifest clicks and the secrets.

**A caution, recorded because it is easy to lose.** Kanon is governance: people decide and agents propose (`K-PRIN-3`). A non-technical Owner is still the Owner. So such a webapp must translate every escalation into a *product* question (what should this do, what may it cost, where does it sit on the roadmap), never a code-review question the Owner can't answer. If it can't, the person isn't governing, and the escalation is a rubber stamp.

This may be a use case for **Kolophon**, the Owner's own product. Whether to build it, and how, is a separate and later decision, after plan 0005 is implemented. It is not decided here.

**A guardrail that holds whoever builds it, Kolophon included:** the webapp drives Kanon only through Kanon's public surfaces, which are `kanon init` run non-interactively, the requirements file each release ships (plan 0005 §5.5), and `kanon doctor`'s machine-readable output. If it needs a private hook, Kanon has become the webapp's internals, and the hook is the bug.

### 3. Further audiences

- **Teams and platform engineers** rolling Kanon across many repositories. They need org-level Apps reused across repositories (already plan 0005 §3.2, `kanon apps --repo a,b,c`), one policy applied consistently, cost and telemetry across the fleet, and an audit of what each repository runs.
- **Brownfield adopters.** Not a separate audience but a dimension of every other: a repository with its own CI, rulesets, labels and history. `init` must merge into what exists, and name what it would change, never assume an empty repository. Plan 0005 §5.4 already makes a re-run safe; the same property has to hold on a first run over somebody else's setup.
- **Open-source maintainers.** Fork pull requests, untrusted contributors and public logs mean a different security posture. Kanon already acts only on members' work (`K-AGENT-45`), and a stranger's PR is never a trigger for a paid run ([ADR 0011](0011-kanon-runs-its-own-lanes.md), decision 3), but what the lanes do on a fork's pull request is still being verified ([#285](https://github.com/yedeya-labs/kanon/issues/285)).
- **Integrators,** as a category: anyone, audience 2 included, who drives Kanon from another program. They need a stable machine interface and a versioned guarantee about it.
- **Evaluators,** deciding whether to adopt at all. They need a live demonstration repository and the public telemetry figures, which show what the loop costs and does, not what it claims.

## Decisions

1. **Build for audience 1 first.** The guided install is skills wrapping `kanon init` and `kanon doctor`, and it is the first thing built on top of plan 0005.
2. **`kanon init` and `kanon doctor` are scriptable from the day they ship.** Each has a non-interactive mode, where every question takes its default or a flag, and JSON output, beside the prose a person reads. Audience 2, integrators and fleet teams all build on those, and a command first shipped interactive-only gets its machine interface retrofitted around prompts. The skills of Decision 1 use the same interface, so the first integrator is Kanon's own.
3. **Personal accounts stay first-class; organisations and paid features are supported, never required.** This is [ADR 0013](0013-personal-accounts-and-two-apps.md) decision 1 and plan 0005 decision 1, restated because every audience above inherits it: the merge queue and organisation secrets are used where they exist, with `K-ADOPT-3`'s fallbacks where they don't.
4. **The webapp is deferred.** Audience 2 is recorded, with its caution and its guardrail, and decided later.

*Why:* audience 1 is the one that exists today and the one #288 was opened for, and serving it well needs nothing plan 0005 doesn't already build. Making the commands scriptable now costs a flag and a serialiser per command; adding it after integrators exist costs a breaking change to whatever they parsed.

## Consequences

- **Plan 0005's L9 and L10 gain one property each.** `kanon init` (L9) takes a non-interactive mode in which every question has a flag or its documented default, and `kanon doctor` (L10) prints its list as JSON as well as prose, with the same exit codes. Each step's acceptance test should exercise that mode, and the JSON's shape becomes part of what a release promises: a change to it is a breaking change, named in the release notes like any other.
- **#288 is delivered as skills on top of the commands,** not as a longer interactive prompt. The skills are written after L9 and L10, against their machine interface.
- **Brownfield is a requirement on `init`, not a later feature.** Its first run over an existing repository names every change it would make to labels, rulesets and callers before it makes one.
- **The open-source posture waits on #285.** Until it closes, Kanon makes no claim about how its lanes behave on a fork's pull request beyond `K-AGENT-45`.
- **No webapp work starts from this ADR,** Kolophon's included. When one is proposed, it is held to the guardrail above.
