# 0004. How the disputed rules are decided

- **Status:** accepted
- **Date:** 2026-09-27

## Context

When the reference adopter's rules were first inventoried, 11 of its 319 rules were classed as **disputed**: they could reasonably be framework opinions or one project's choices. Kanon has no configuration ([ADR 0002](0002-standardise-dont-parameterise.md)), so "let each project choose" is not an available answer. Each one has to be decided.

Several of them turned out to be one question asked in different places, which is why eleven items produce seven decisions.

## Decisions

### 1. Merge authority: a human, or a green zone the project defines

*Decides who may merge, and replaces the old rule that a human approves every merge.*

**Every merge to the main branch is made either by a human, or by a merger agent acting inside a green zone the project defines. A change that touches an escalation path always goes to a human.**

- **The mechanism is framework:** the merger agent, the green-zone checks and escalation. **The content is the project's:** which paths escalate, and how wide the zone is.
- **"A human merges everything" is still a valid adoption.** It is simply an empty green zone, so a team that must have a human review all AI-written code adopts Kanon as it is, with no special case.
- A reviewer agent's approval is enough to satisfy the repository's rules **inside** the zone. Outside it, a human merges.
- **Widening the zone is a human decision**, made on evidence (false merges measured at zero). An agent never widens its own authority.

*Why:* the reference adopter's documents still said "a human approves every merge, no auto-merge ever" after an agent merger had been running for weeks. So the old rule described nothing real. The new rule describes what actually happens, and still gives the strictest teams exactly what they need.

### 2. Stale branches: use the platform's merge queue

*Decides how a stale branch is handled, and replaces the old rule that branches must be up to date before merging.*

**Use GitHub's native merge queue.** Don't require branches to be up to date before merging.

*Amended by [ADR 0008 §2](0008-installation-test-decisions.md):* where the GitHub plan provides no merge queue, "require branches to be up to date" stays off, and a stale base is caught by the release commit's own CI before anything deploys.

*Why:* requiring an up-to-date branch, combined with dismissing approvals on every push, made the cost of review grow quadratically. It once deadlocked merging for a day. A merge queue tests each change against the real result of merging without re-reviewing it. Kanon prefers a native platform feature to its own mechanism wherever one exists, because tools that duplicate the platform get absorbed by it.

### 3. A rule has exactly one home

*Retires two workarounds for copied rules: checking every copy before renumbering, and changing every copy in the same edit.*

**Every rule is stated in one place.** Agents apply a rule by calling the shared skill or script that implements it, never by carrying their own copy in a prompt.

*Why:* in the reference adopter, the milestone-routing rule is restated in at least 13 places. Two copies each claim to be the canonical one, and the instruction for changing it names four prompts where seven actually carry the rule. The two retired rules ("check every positional reference before renumbering", "change every copy in the same edit") were workarounds for copying. Remove the copies and the workarounds are no longer needed.

### 4. Measure the backlog, never set a target for it

*Confirms that measuring the backlog without a target is a framework rule.*

**Report how fast work arrives (follow-ups per PR, issues opened minus closed per week), but never set a target for it, and never propose a fix whose effect is simply "file less".**

*Why:* a follow-up that isn't filed is a defect nobody sees. A filing target makes the numbers look better by hiding problems (Goodhart's law). Whether a reviewer should hold a higher bar for filing at all is a different question, about quality, and is decided on its own merits in the review chapter.

### 5. Billing is not a Kanon rule

*Moves the choice of billing out of the rules and into documentation.*

Kanon works whether agents run on a Claude subscription or on API billing. The rulebook documents the trade-off and does not prescribe either.

*Why:* for Claude Code users the real constraint is usually rate-limit quota rather than money. But how a team pays is a commercial decision, and not one Kanon can make for them.

### 6. Standard cache and fallback settings, guarded against drift

*Makes the cache and fallback settings framework rules.*

**Kanon ships a standard prompt-cache TTL and a standard fallback-model policy for each kind of agent run, and a guard fails when any lane silently departs from them.**

- **Runs that produce a verdict** (review, audit, oversight) have **no fallback model**. A missing verdict is loud; a verdict from a different model than intended is silent.
- **Runs whose output is checked by something else** (implementation, fixes) may fall back to a model of the same tier or cheaper.
- **Cache TTL follows how long each kind of run sits idle.** A run that never idles past five minutes uses the five-minute TTL, because the one-hour TTL costs twice as much to write.

*Why:* letting each project set these would reopen the configuration question (ADR 0002). Silent drift in them has already cost the reference adopter money once.

### 7. Red-test verification applies to agent-written PRs only

*Confirms that red-test verification is a framework rule, and scopes it.*

**A red test (a test that fails before the fix and passes after it) is required on agent-written PRs, not on PRs written by humans.**

*Why:* only agents claim to work test-first. Applied to human PRs, the check was measured blocking about half of them wrongly, because many real changes aren't observable by a test. A team that also wants it for humans can adopt that as its own practice. It is not a Kanon rule.

## Consequences

- The **review-and-merge**, **work-items**, **observability-and-cost** and **agents** chapters write these decisions as rules. Rule ids cite this ADR.
- **The reference adopter has to catch up.** Its documents still describe the old merge rule, and several restated copies still exist. That work is tracked on the reference adopter's side.
- **Decision 3 is a design constraint on the extraction:** an agent prompt in Kanon may not contain a copy of any rule.
