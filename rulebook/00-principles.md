# 00 Principles

This chapter holds the opinions every other chapter is built on: why Kanon has no configuration, who decides what, where an agent's authority comes from, how a check proves it ran, how a claim is backed by evidence, and how Kanon treats input it didn't write. The later chapters apply these principles to one area each. When a later rule seems arbitrary, its reason is usually here. The chapter ends by saying plainly who Kanon is for and who it is not for, because a framework that cannot be configured has to name its target.

## Kanon's stance

### `K-PRIN-1` Standardise, don't parameterise

**Rule.** Adopt Kanon's opinions whole. Kanon has no configuration: every adopter uses the same labels, milestone kinds, spec-id scheme, document paths and agent roles, and a rule is never switched off for one project. When a rule doesn't fit, record whether the rule changes for everyone or the project is outside Kanon's target.

**Why.** Kanon's guards work by scanning the project's source for fixed literals. A configuration file would be a second source of truth that both the code and the guard read, and a guard that checks the code against a config the code also reads can no longer fail. A framework for "any project" also cannot say no to anything, and the product is the governance, not the flexibility. See [ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md).

**Enforced by.** Prose only. There is no configuration surface to misuse, which is the enforcement by construction.

**Class.** framework

### `K-PRIN-2` A rule has exactly one home

**Rule.** State every rule in one place. Anything else that needs the rule points to that place, or calls the one shared skill, script or module that implements it. An agent prompt never carries its own copy of a rule, and two consumers of the same concept (conflict state, closure, milestone kind) share one module rather than each deriving it.

**Why.** Restatements drift. In the reference adopter one routing rule was restated in at least thirteen places; two copies each claimed to be canonical, and the instruction for changing it named four prompts where seven carried it. Two lanes that each computed the same state once sized one project two different ways. The workarounds ("check every copy before renumbering", "change every copy in the same edit") are only needed because copies exist. See [ADR 0004 §3](../docs/decisions/0004-disputed-rules.md).

**Enforced by.** Prose only; a guard is planned. Where a restatement cannot be avoided (a doc and the config it describes), a parity test fails when the two disagree (see `K-OBS-2`).

**Class.** framework

### `K-PRIN-3` Humans decide product intent; agents solve code questions

**Rule.** Escalate to a human only for product intent: what the product should do, what it may cost, where work sits on the roadmap. Resolve every code question agentically, merge conflicts included. A script's list of refusals is an agent's list of instructions, not a human's inbox. Treat every new entry on an escalation list as a cost, and widen one only on evidence.

**Why.** A lane that escalates every awkward merge re-creates the bottleneck it was built to remove. Each over-broad escalation entry interrupts a human and trains them to ignore the surface: the reference adopter's first merge-escalation list declined the pilot's own first PR.

**Enforced by.** Prose only, carried by the agent instructions for conflict resolution and review.

**Class.** framework

## Authority

### `K-PRIN-4` Authority comes from a mechanism, never a prompt

**Rule.** Derive every agent's authority from a mechanism it can verify but cannot waive: platform permissions, a ruleset, a pure function over repository state. Never grant or limit authority with prompt text alone.

**Why.** A prompt-only gate is a gate a model can talk itself past. Once an agent can merge, no amount of cleverness in a supervising prompt restores the property that it can only propose.

**Enforced by.** The merge gate: a pure function over the PR's labels, paths, checks and reviews that the merging agent calls but cannot edit, and a red-test check that reverts the fix and requires the new test to fail.

**Class.** framework

### `K-PRIN-5` Author, reviewer and merger are three identities

**Rule.** Keep the author, the reviewer and the merger of a change as three distinct identities. No agent both plans and approves its own work, or approves and merges it.

**Why.** An agent reviewing its own output is marking its own homework. The platform agrees: it already refuses self-approval.

**Enforced by.** A separate platform identity per role, and a merge gate that refuses when the author or approver identity is wrong.

**Class.** framework

### `K-PRIN-6` Watchers only propose or restrict

**Rule.** Any component that watches the pipeline has zero blast radius: it may only propose (file an issue, open a PR for review) or only restrict (hold, revoke). Automate the observation and leave the judgement (approve, prioritise, declare healthy) with a human.

**Why.** A component that can only propose needs no overseer of its own, which dissolves "who watches the watcher". Surfacing without deciding is what keeps self-auditing safe.

**Enforced by.** Read-only repository permissions and a tool allow-list on the watching agent's workflow.

**Class.** framework

### `K-PRIN-7` Every handoff is a gate, and a guess is never ground truth

**Rule.** Make every handoff between agents a gate that also promotes knowledge: a claim moves from structural contract, to behavioural invariant, to executable test only when it is confirmed, and each step makes it cheaper and stricter to check. Treat specs in the repository as authoritative and operational memory (recall, embeddings, past runs) as hints to verify. Let similarity only surface candidates; an exact match decides a duplicate.

**Why.** The same checks that protect the codebase curate the oracle, so the oracle compounds without laundering an agent's guess into ground truth. Trading exact matching for a similarity threshold would quietly corrupt the precision record.

**Enforced by.** Prose only; the gates themselves are described in `K-SPEC-9` and chapter 04.

**Class.** framework

## Silence is not health

### `K-PRIN-8` A detector reports what it examined, and a quiet check proves it ran

**Rule.** Every detector reports a coverage figure (what it examined), not only what it found. Any check whose healthy state is silence emits a positive signal that it ran. A guard that fails open is the worst case of this failure.

**Why.** A detector that finds nothing is indistinguishable from a healthy system. The reference adopter re-discovered this "silent absence" at least six times, including twice in one guard, and two fail-open guards were found only because a person read them.

**Enforced by.** Per component only (for example, a code audit that writes a synthesised "what was scanned" row, a brief guard that requires a "not examined" section). No general guard.

**Class.** framework

### `K-PRIN-9` Absent means unknown

**Rule.** Record a missing measurement as absent, never as zero or false. Never infer that a run failed from a missing record: know the store's write order first, and name the workflow and its gate before generalising a liveness rule.

**Why.** Collapsing "cost money", "was capped" and "telemetry lost" into `cost: 0` hides two of the three states. Two retracted audit findings in the reference adopter were both "missing record, so the run died".

**Enforced by.** The telemetry writer's contract, which keeps absent fields absent; the liveness half is prose only.

**Class.** framework

### `K-PRIN-10` Fail closed on an unreadable answer

**Rule.** A read that errors, is forbidden or returns something unparseable must refuse, wait, or keep the current state. It never proceeds as "clear".

**Why.** Permission-denied response bodies were read as data three times, and a negated search that silently returns zero results would have unlocked an interlock.

**Enforced by.** Each gate individually: the merge gate waits when it cannot read run history, the dispatch sweep and the capability interlock refuse on an unreadable read. No general guard.

**Class.** framework

## Guards

### `K-PRIN-11` A guard must be able to fail

**Rule.** Mutation-check every guard assertion: break the thing it protects and confirm it goes red, separately for each assertion. When a mutation passes, decide whether it is equivalent or the assertion is dead. Scope a documentation guard to the line or block that makes the claim, and make it throw when its anchor moves. Sweep prose by a mechanical pairing of predicate and name, not by a query. Restore a mutated file from a copy, never by reverting it to the committed version.

**Why.** A check that cannot fail is worse than none, because it gives assurance nobody earned. A section-wide text match binds nothing. Keyed and paragraph sweeps each looked clean and were wrong. Reverting a mutated file to the committed version reverts the fix too, and the next run goes green on unfixed code.

**Enforced by.** Partly. The brief template is run against the brief guard with a mutation test; elsewhere prose only.

**Class.** framework

## State and delivery

### `K-PRIN-12` Derive state from the queue, and back every event with a reconciler

**Rule.** Derive orchestration state from the issue tracker on every tick; keep no checkpoint file, and make every tick idempotent. Back every event-driven lane with a scheduled reconciler that re-derives state.

**Why.** Actions jobs have a time cap, and a stored checkpoint can drift or corrupt where derived state cannot. Events get dropped, and an event-driven system cannot recover from an event that never arrived; the reference adopter lost work to dropped events at least seven times.

**Enforced by.** Prose only. The reference adopter has a reconciler for each lane, but nothing fails when a new lane lacks one.

**Class.** framework

### `K-PRIN-13` Re-deliver on evidence, retry once

**Rule.** Bound every automatic re-delivery by evidence of an attempt, not by a counter: re-fire only when no run of that workflow attempted this head, and count a failed run as an attempt. Retry a run automatically at most once, after a cool-down, and only when it died of its cause (the model was unreachable, or the API failed mid-run). A run that ran and failed is not retried.

**Why.** A usage cap or an outage must be reported, not repeated. "A run exists" was the wrong test once. When every in-flight run died on a session limit, PRs sat for hours until someone re-dispatched them by hand.

**Enforced by.** The re-delivery and retry logic itself, which reads run history for the head and refuses when an attempt exists; unit tests pin that behaviour.

**Class.** framework

## Evidence

### `K-PRIN-14` Every number carries its command

**Rule.** Attach the command that reproduces every recorded number, and re-measure rather than quote a figure from a document. A number whose command was written but not run is marked as not run, never presented as measured. When claiming a change, show before-and-after evidence and explain every number that did not move.

**Why.** A baseline nobody can re-measure can't be compared later; a recorded coverage figure once disagreed with the tool that supposedly produced it. A defect once produced byte-identical output by coincidence while the predicate it depended on was dead, and only an unexplained unchanged number would have shown it.

**Enforced by.** The brief guard, for briefs only. Otherwise prose only.

**Class.** framework

### `K-PRIN-15` Test a setting live, against everything it touches

**Rule.** Before enabling a setting, multiply it against every setting it interacts with, and measure the combination live. When testing a permission or ruleset change, force a fresh evaluation rather than trusting a cached result. Treat evidence that fits two theories as evidence for neither, and separate them by intervention.

**Why.** Two individually sensible branch-protection settings made re-review quadratic and deadlocked merging for a day. A review decision cached at submission time produced three wrong conclusions in one session.

**Enforced by.** Prose only.

**Class.** framework

### `K-PRIN-16` Record a changed premise where the rule lives

**Rule.** When a premise behind a rule stops being true, say so next to the rule. Don't silently repair the conclusion.

**Why.** Otherwise a later reader sees a rule whose reason no longer holds and concludes the guard is unnecessary.

**Enforced by.** Prose only.

**Class.** framework

### `K-PRIN-17` Grow from evidence, not in advance

**Rule.** Build a capability as an inert primitive first, gate its wiring on a measured threshold, and be willing to say "not yet". Derive a required format from the intersection of real instances, not before they exist.

**Why.** A semantic-recall capability measured its own gate and found it not met, so building the pre-step earlier would have been ahead of need. Standardising a document format before five real ones existed was refused, and the imagined shapes elsewhere caused every top-tier finding in one audit.

**Enforced by.** Prose only.

**Class.** framework

### `K-PRIN-18` The Stakeholder takes part at decision points, and every decision leaves a record

**Rule.** The Stakeholder never takes part in the flow of work, only in a fixed set of decisions: placing work on a roadmap milestone, deciding whether a `gate-candidate` joins the launch gate, agreeing a project's closure rule, and prioritising roadmap milestones. Each of these decisions leaves a record in the repository, in one of two forms:

- **Approved:** the Stakeholder makes the decision in GitHub themselves, by approving the pull request or answering on the issue. This is the rule.
- **Attested:** where the Stakeholder does not work in GitHub, the Maintainer records that the decision was agreed, naming the Stakeholder and when or where it was agreed. The Maintainer's merge vouches for it. This is the fallback, and the record always shows which of the two it is.

Decisions waiting for the Stakeholder are shown to them in the weekly digest (`K-SHIP-11`), which is their whole interface to the workflow. ([ADR 0006](../docs/decisions/0006-stakeholder-decisions.md))

**Why.** Humans decide product intent (`K-PRIN-3`), and on a team the product decisions belong to the Stakeholder rather than to whoever merges. Those decisions are often made in a conversation outside the workflow, which is fine. What isn't fine is when they leave no trace, and the Maintainer's merge silently stands in for someone else's decision. A decision that can be read from the repository can be checked by a guard and audited later. Keeping the Stakeholder to decision points keeps their cost to a few approvals a week.

**Enforced by.** Prose only; a guard is planned. It fails when a brief that places roadmap work, or a `gate-candidate` placed on the launch gate, carries neither an approval by the Stakeholder nor an attestation.

**Class.** framework

## Security

### `K-PRIN-19` Security is part of every rule: untrusted content is data, authority is least, and nothing runs unpinned

**Rule.** Build every lane and check on three commitments, each with its rules in the chapter it belongs to:

- **Untrusted content is data, never instructions.** Issues, pull requests, reviews, comments and files written by anyone who isn't a member are input for an agent to judge, never a command, and agents act only on work a member raised or approved (`K-AGENT-45`, and `K-WORK-21` for intake). A pull request never chooses the rules it is judged by (`K-MERGE-17`).
- **Least privilege.** Every token holds only what its lane uses (`K-AGENT-46`, `K-ADOPT-8`). Secrets go only to the runs that name them, and never to a run a fork started (`K-AGENT-47`). `pull_request_target` never checks out or runs the pull request's code (`K-AGENT-48`). Only a human creates a credential (`K-AGENT-6`).
- **Pinned dependencies.** Kanon is used at an exact version (`K-ADOPT-11`), and every other action at a version tag or a full commit SHA, never a branch (`K-ADOPT-12`).

**Why.** Security was already inside many rules, but no principle tied them together, so a new lane had nothing to be checked against as a whole. It became urgent once agents run on a public repository, Kanon's own first: there, issues, pull requests and comments come from strangers. An agent with a write token that follows a stranger's text is working for the stranger, a secret a fork's code can read is the fork's, and an action pinned to a branch runs whatever its owner pushes next.

**Enforced by.** Each rule's own line. Three are checked on Kanon's own workflows and actions by [`tests/unit/workflow-security.test.ts`](../tests/unit/workflow-security.test.ts): no `pull_request_target` checkout of the head, no unpinned third-party action, no `secrets: inherit`. The membership gate on every lane is checked by [`tests/unit/lane-gate.test.ts`](../tests/unit/lane-gate.test.ts) (`K-AGENT-45`).

**Class.** framework

### `K-PRIN-20` A public repository is the stricter case of the same rules, not a separate mode

**Rule.** Apply the security rules the same way on a private repository and a public one. Making a repository public changes who can write an issue, a comment or a pull request; it switches no rule on or off.

**Why.** A private repository meets fewer strangers, but it still has members whose accounts can be compromised, Apps whose tokens can leak, and dependencies that can be hijacked. Adopters' repositories also go public one at a time (`K-ADOPT-2`), and a rule that started to hold only at that moment would be a setting (`K-PRIN-1`), off on the day it is first needed.

**Enforced by.** Prose only. None of the checks under `K-PRIN-19` reads the repository's visibility.

**Class.** framework

## Who Kanon is for, and not for

Kanon cannot be configured, so it has to say whom it fits. Each assumption below is one Kanon makes about an adopter, with what it costs a project that doesn't meet it. "Outside the target" means the project should not adopt Kanon as it is; the answer is recorded, not worked around (`K-PRIN-1`).

| Kanon assumes | What it costs a project that doesn't meet it |
|---|---|
| **A GitHub organisation owns the repository** ([ADR 0008 §2](../docs/decisions/0008-installation-test-decisions.md), `K-ADOPT-2`). Repositories may be private while prepared and go public one at a time. | Outside the target. A personal account has no merge queue, and needs a paid personal plan for rulesets on a private repository. |
| **GitHub's plan decides which platform features exist**, and Kanon uses each where the plan provides it, with a fixed fallback where it doesn't (`K-ADOPT-3`): the merge queue and environment approval are missing on private repositories on the Team plan. | A fallback, recorded, not a setting. The one feature with no fallback is rulesets: a private repository on a plan without them stays in bootstrap. |
| **GitHub is the queue and the store.** Issues, labels, milestones, PR links and review verdicts hold all execution state; GitHub Issues (not Projects), rulesets, required checks, closing references and squash merge are used. | Outside the target. State is derived from the queue on every tick (`K-PRIN-12`); on another forge there is no queue to derive it from. |
| **GitHub Actions is the runtime.** Every lane is a workflow, event triggers are load-bearing, and hourly and daily schedules are the heartbeat. | Outside the target. Another CI system means rewriting every lane and every reconciler. |
| **One platform identity per agent role, created by a human admin** who can edit rulesets and app permissions (`K-ADOPT-8`). | Without an admin, identities can't be separated, so `K-PRIN-5` can't hold and the merge gate has nothing to check. Onboarding cost is real: several apps, keys and secrets. Until they exist, the repository is in bootstrap. |
| **Claude Code is the agent runtime,** with its CLI flags and model tiers. | Outside the target. Cost ceilings, fallback and cache policy (chapter 08) are written against it. |
| **A running project, reached through bootstrap.** Several assumptions below (a test suite, a toolchain, a verified environment, releases) describe a running project. An empty repository adopts Kanon by starting in **bootstrap** (`K-ADOPT-4` to `K-ADOPT-6`), with every exception recorded, and meets them as it grows. | None. Day zero is inside the target. Until a mechanism is installed, its rule is prose only on that repository, and the adoption record says so (`K-ADOPT-9`). |
| **A test suite the agents can run and revert against,** locally and in CI, with test titles able to carry spec ids, a lint chain, and source separable from tests. Its language has a row in Kanon's table of test conventions (`K-SPEC-6`): JavaScript or TypeScript, Python, or Go. | Without it there is no red-test check, no verified acceptance criterion (`K-SPEC-6`), and agents can only be trusted by reading their output. That is outside the target. |
| **Node in CI, as Kanon's own runtime.** Kanon's checks, lanes and guards are Node code that runs in GitHub Actions, never a dependency of the product: its guards need no `package.json`, package manager or Node toolchain in the adopter's repository, whatever its language (`K-ADOPT-11`). | One `actions/setup-node` step before a step that runs a guard, which Kanon's lanes already take for themselves. Nothing in the product's own toolchain. The `kanon` command an installer runs once (`kanon apps`, `kanon milestones`) needs Node on that machine. Tests are found, read and run by a fixed convention for each language, never through `npx` (`K-SPEC-6`, [ADR 0012](../docs/decisions/0012-test-conventions-by-language.md)). The lane prompts still name `npm` commands, tracked in #36. |
| **A seedable pre-production environment for the agents, a reference environment where released behaviour is verified, and releases that drive deploys.** By default the reference environment is the last environment before production. | Project closure verifies acceptance criteria at the reference environment's deployed ref (`K-PROJ-11`). Without one, a project cannot close by Kanon's definition of done. |
| **A spec corpus of behavioural invariants,** in a behaviour-driven application. | Acceptance criteria have nothing to cite (chapter 02). A project with very few behaviours pays for the spec layer anyway, with a small corpus. |
| **A web application,** for the Explorer's objective signals (routes, console errors, status codes). | The Explorer's runtime sweep has no surface. Its code-reading and targeted-verification modes still apply. |
| **An Owner, a Maintainer and a Stakeholder** (chapter 03), who administer the repository, merge what escapes the green zone, answer brief decisions and curate audits, and who are not nagged about their own backlog. One person may hold all three. | A solo project gives all three roles to one person. That works, but the separation of "who merges" from "who plans the roadmap" is lost, and the record of each decision still names the role that made it. |
| **A cloud account of its own, with cost discipline**, for the QA store (`K-OBS-17`) and, unless it opts in to hosted telemetry, its telemetry store (`K-OBS-18`). Kanon's infrastructure code creates both. | Without it there are no run reports, no cost rows, no liveness reads, and no evidence for any capability gate (`K-PRIN-17`). |
| **A chat channel** for announcements, digests and cost alerts. Which service, and how it is wired, is the project's decision, recorded in the adoption record. | Digests and alerts go unread. The cost is visibility, not correctness. |
| **A pre-launch posture,** where a filing rate above one follow-up per PR is treated as healthy hardening, and at most one launch-gate milestone exists. Adoption needs no roadmap milestone at all: creating one is the Stakeholder's decision, made when they choose. | A mature product will read the filing rate as noise. Measure it anyway, and never set a target for it (ADR 0004 §4). |
| **English, markdown-heavy docs** that agents read by path, with section anchors other docs cite. | Agents and guards read by fixed path and anchor; documentation elsewhere (a wiki, another language) is invisible to them. |
| **Kanon's files at Kanon's fixed paths** (chapter 11), with agent instructions restored from the base branch on PR runs. | Instructions elsewhere can be rewritten by the PR under review, and a guard can't find a file at a path it doesn't know. Outside the target. |
| **One repository.** Ids, labels and projects are repository-scoped. | A multi-repository product gets no cross-repository projects, specs or bundles. Outside the target. |
| **A local machine** with a database server, a POSIX shell and an authenticated GitHub CLI. | Worktree isolation (chapter 05) can't provision per-worktree databases without it. |
| **Throughput high enough that per-PR human decisions are the bottleneck.** | The lead and merger layers exist to remove that bottleneck. A low-throughput project pays their setup cost for little gain; it can still adopt with an empty green zone (ADR 0004 §1). |

## Examples from the reference adopter

- **Read the framework's own docs first.** The reference adopter pins a fast-moving web framework whose APIs differ from any model's training data, so its top-level agent instructions require reading the vendored documentation for that version, and heeding its deprecations, before writing code. It is project policy, and it shows `K-PRIN-14` in action: re-read the source instead of quoting memory.
