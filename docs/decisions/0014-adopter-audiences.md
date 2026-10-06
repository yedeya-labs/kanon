# 0014. Who adopts Kanon, and which of them comes first

- **Status:** accepted
- **Date:** 2026-10-06
- **Decided in:** [#288](https://github.com/yedeya-labs/kanon/issues/288), by the Owner on 2026-10-06, building on [plan 0005](../plans/0005-lean-installation.md) and [ADR 0013](0013-personal-accounts-and-two-apps.md)

## Context

[Plan 0005](../plans/0005-lean-installation.md) makes the installation short: two Apps per owner, personal accounts first-class, `kanon init` to inspect a repository and write what it lacks (merged in #328, step L9, and released in v0.28.0, with the [`requirements.json`](../../requirements.json) each release now carries), and `kanon doctor` to name what a release needs before the pin moves (§5.4, §5.5). It says *what* the installation does, but not *who runs it*, or through what. That choice shapes the commands: a command a person types once can prompt and print prose, while one that another program drives can't.

The Owner was asked who Kanon is for, and asked to have the answer recorded with the analysis behind it. This ADR records both. It positions Kanon; beyond plan 0005 it adds only the order and dogfooding in Decision 1, the two properties in Decision 2, and the promise that their JSON shape is versioned (Consequences).

## The audiences

### 1. Developers with an AI agent client

A developer who already works with an agent in their editor or terminal installs Kanon *from that agent*. Kanon ships a small set of skills, or agent instructions, that wrap `kanon init` and `kanon doctor`:
- **inspect** the repository and its owner, as `init` does;
- **explain each choice in plain words** before making it: which lanes, which defaults, what the plan can't enforce;
- **write the files**, and show the diff;
- **walk the person through the steps only a person can take**: creating the Apps through GitHub's App-manifest flow where possible (`kanon apps`, [docs/apps.md](../apps.md)), setting the secrets, and the ruleset, where the plan has one and `init`'s token can't create it.

This is #288's guided path, delivered as skills rather than as a longer interactive prompt. The agent does the reading and the explaining; the commands stay the source of truth.

### 2. Less technical builders, through a webapp

A builder who wants to describe *what they want to build* uses a webapp for that, and Kanon is one gear of its scaffolding. The webapp could absorb the mechanical steps a person takes today, such as the manifest clicks and the secrets.

**A caution, recorded because it is easy to lose.** Kanon is governance: people decide and agents propose (`K-PRIN-3`). A non-technical Owner is still the Owner. So such a webapp must translate every escalation into a *product* question (what should this do, what may it cost, where does it sit on the roadmap), never a code-review question the Owner can't answer. If it can't, the person isn't governing, and the escalation is a rubber stamp.

This may be a use case for **Kolophon**, the Owner's own product. Whether to build it, and how, is a separate and later decision, after plan 0005 and audience 1's skills. It is not decided here.

**A guardrail that holds whoever builds it, Kolophon included:** the webapp drives Kanon only through Kanon's public surfaces, which are `kanon init` run non-interactively, the [`requirements.json`](../../requirements.json) each release ships (plan 0005 §5.5), and `kanon doctor`'s machine-readable output. If it needs a private hook, Kanon has become the webapp's internals, and the hook is the bug.

### 3. Further audiences

- **Teams and platform engineers** rolling Kanon across many repositories. They need org-level Apps reused across repositories (already plan 0005 §3.2, `kanon apps --repo a,b,c`), one policy applied consistently, cost and telemetry across the fleet, and an audit of what each repository runs.
- **Brownfield adopters.** Not a separate audience but a dimension of every other: a repository with its own CI, rulesets, labels and history. `init` must merge into what exists, never assume an empty repository. It already has what that needs: plan 0005 §5.4 makes a re-run safe, and `init --dry-run` reads everything and names every change without making one, so a first run over somebody else's setup starts with it.
- **Open-source maintainers.** Fork pull requests, untrusted contributors and public logs mean a different security posture. Kanon already acts only on members' work (`K-AGENT-45`), and a stranger's PR is never a trigger for a paid run ([ADR 0011](0011-kanon-runs-its-own-lanes.md), decision 3), but how the lanes behave on an adopter's fork pull request has not been verified ([#368](https://github.com/yedeya-labs/kanon/issues/368)). ([#285](https://github.com/yedeya-labs/kanon/issues/285) asks something narrower: whether Kanon's own required `Agent lanes smoke` check starts on a fork pull request.)
- **Integrators,** as a category: anyone, audience 2 included, who drives Kanon from another program. They need a stable machine interface and a versioned guarantee about it.
- **Evaluators,** deciding whether to adopt at all. They need a live demonstration repository and the public telemetry figures, which show what the loop costs and does, not what it claims.

## Decisions

1. **Build for audience 1 first, soon, and use it ourselves.** The guided install is skills wrapping `kanon init` and `kanon doctor`. The Owner (2026-10-06): *"Whatever we build for the agent-client audience first, we need to use ourselves. I would prioritize it to be done soon."* So:
   - **They come next after L10** (`kanon doctor`), ahead of the rest of plan 0005, not after it.
   - **They are dogfooded.** Kanon's own migration to the two Apps (plan 0005 L5) and the migrations of the Owner's own projects (L6) run through these skills, not by hand. A step the skills can't do is a gap in the skills, fixed there, not worked around.
2. **`kanon init` and `kanon doctor` are scriptable.** Each has a non-interactive mode, where every question takes its default or a flag, and JSON output, beside the prose a person reads. `init`, released in v0.28.0, already has half of this: `--yes` takes every default, it refuses rather than prompts when standard input isn't a terminal, and `--dry-run` changes nothing; it lacks JSON output ([#365](https://github.com/yedeya-labs/kanon/issues/365)) and a flag per answer ([#367](https://github.com/yedeya-labs/kanon/issues/367)). `doctor` has both from the day it ships. Audience 2, integrators and fleet teams all build on those, and a command first shipped interactive-only gets its machine interface retrofitted around prompts. The skills of Decision 1 use the same interface, so the first integrator is Kanon's own.
3. **Personal accounts stay first-class; organisations and paid features are supported, never required.** This is [ADR 0013](0013-personal-accounts-and-two-apps.md) decision 1 and plan 0005 decision 1, restated because every audience above inherits it: the merge queue and organisation secrets are used where they exist, with `K-ADOPT-3`'s fallbacks where they don't.
4. **The webapp is deferred.** Audience 2 is recorded, with its caution and its guardrail, and decided later.

*Why:* audience 1 is the one that exists today and the one #288 was opened for, and serving it well needs only Decision 2's two properties beyond plan 0005. Running Kanon's and the Owner's own migrations through the skills is what tests them: a path nobody walks is a path that rots, and the migrations are the installs that happen anyway. Making the commands scriptable now costs a flag and a serialiser per command; adding it after integrators exist costs a breaking change to whatever they parsed.

## Consequences

- **`kanon doctor` (L10) ships with JSON output,** beside its prose and with the same exit codes, and its acceptance test exercises it. **`kanon init` shipped in v0.28.0 without JSON output,** so until [#365](https://github.com/yedeya-labs/kanon/issues/365) lands it falls short of Decision 2; a flag per answer follows in [#367](https://github.com/yedeya-labs/kanon/issues/367). Each JSON shape becomes part of what a release promises, as `requirements.json` already is: a change to it is a breaking change, named in the release notes like any other.
- **#288 is delivered as skills on top of the commands,** not as a longer interactive prompt, written against their machine interface. L9 is done, so they wait only for L10, and are the next step after it (plan 0005 L11).
- **L5 and L6 wait for the skills.** L6 already waits for M2; both now wait for the skills, because they run through them. That moves L5 from early in plan 0005's order to after L11, and its run is the skills' first real use. Until L5, Kanon's own callers stay pinned below v0.28.0, L4's release ([ADR 0011](0011-kanon-runs-its-own-lanes.md), amended 2026-10-06), so the lane changes of L4 to L11 reach Kanon's own lanes only at L5; plan 0005 §7 records the order and that cost.
- **Brownfield is a property `init` already has, and the skills use it.** On an existing repository they run `init --dry-run` first, show the person every change it names to labels, rulesets and callers, and only then run it.
- **The open-source posture is not yet verified** ([#368](https://github.com/yedeya-labs/kanon/issues/368)). Until something verifies how the lanes behave on an adopter's fork pull request, Kanon makes no claim about it beyond `K-AGENT-45` and ADR 0011 decision 3. Closing #285 doesn't lift this.
- **No webapp work starts from this ADR,** Kolophon's included. When one is proposed, it is held to the guardrail above.
