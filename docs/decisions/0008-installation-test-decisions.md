# 0008. Decisions from the first installation test

- **Status:** accepted
- **Date:** 2026-09-29

## Context

Kanon was installed on its second adopter, Kolophon, by an agent that could read only Kanon's README, roadmap, rulebook and decisions. It logged 38 points of friction. Most are gaps in the rulebook that can be fixed without a new decision. Four changed Kanon's shape and needed one; this record settles them.

## Decisions

### 1. The second adopter is the extraction's first consumer

**Kolophon continues now, with humans playing the agent roles by hand. Each piece of Kanon's code, as it is extracted from the reference adopter, lands on Kolophon first.** The roadmap's phases 2 (second adopter) and 3 (extraction) run together, and the installation test's friction log is the extraction's list of requirements.

*Why:* the test showed that Kanon adopted from its rulebook alone is prose only. Every guard, the Reviewer and the Merger are code or GitHub Apps that don't exist yet, so nothing on the adopter can fail a build. Pausing Kolophon until the extraction is complete would lose the only adopter that is testing the extraction as it happens.

### 2. Kanon assumes a GitHub organisation

**An adopter's repositories live in a GitHub organisation, not a personal account.** Repositories may be private while they are prepared, and go public one at a time, each at its own gate.

GitHub's plans decide which of Kanon's platform features are available:

| Feature | Public repo, free organisation | Private repo, Team plan | Private repo, Enterprise Cloud |
|---|---|---|---|
| Rulesets, branch protection | yes | yes | yes |
| Merge queue | yes | **no** | yes |
| Required reviewers on an environment | yes | **no** | yes |

Kanon uses each feature wherever the plan provides it, with a defined fallback where it doesn't. It is one rule with two recorded outcomes, not a setting:

- **Merge queue** ([ADR 0004 §2](0004-disputed-rules.md), amended). Without one, "require branches to be up to date" stays **off**, and a stale base is caught by the release pipeline's own CI before anything deploys.
- **Production approval.** Without environment required reviewers, production promotion is a manually triggered workflow that only the Maintainer may run.
- **Rulesets.** There is no fallback. A private repository on a plan without rulesets is still in bootstrap (§3) and cannot leave it.

*Why:* on a personal account, a merge queue is impossible, and rulesets on a private repository need a paid plan. Most small teams run private repositories on the Team plan, which still lacks the merge queue and production approval. So the test's configuration is not an edge case; it is the common one.

### 3. Adoption starts with an explicit bootstrap phase

**A repository is in bootstrap from its first commit until its agent identities exist.** During bootstrap:
- the first commit and the installation commits may go directly to the main branch;
- humans may play agent roles, and every artifact records which role a human played;
- the rule requiring an approving review is **not** switched on, because GitHub won't let a solo Owner approve their own pull request.

**Bootstrap ends** when the Reviewer's App is installed and the required-review rule is switched on. That moment is recorded. A repository that has left bootstrap never returns to it.

*Why:* the rulebook described only a running project. An empty repository broke three of its rules on day one, and a silent exception is exactly what Kanon forbids. Naming bootstrap as a state, with a defined exit, turns those breaks into rules.

### 4. Kanon's rules are neutral about how a project deploys

Some adopters deploy one version of their code into many isolated environments (for example, one cloud account per customer). Several of Kanon's rules silently assumed one staging stage and one production stage. **Kanon does not add rules for fleets. It removes that assumption from the rules it already has:**

- **The definition of done** verifies acceptance criteria at *the project's reference environment*: the one environment the project names as where released behaviour is verified. By default it is the last environment before production, because agents never explore production. *(Amended 2026-09-29; the first version of this decision said production.)*
- **Cost estimates** are stated per environment, then multiplied by the number of environments the change is deployed to. That covers schedules and alarms as well as resources.
- **Where the stores live.** When an adopter has several cloud accounts, its QA store, and a self-hosted telemetry store, live in the reference environment's account. *(Added 2026-09-29.)*

**How a project rolls a release out to many environments is the project's own policy, not Kanon's.**

*Why:* a fleet is one project's deployment shape. It is not a governance opinion every adopter should share. But a rule that silently assumes one production stage gives the wrong answer for any adopter that doesn't have one, so the assumption is taken out rather than a special case added.

## Consequences

- **The roadmap.** Phases 2 and 3 are merged. The installation test is recorded as done, and its friction log drives the extraction.
- **The rulebook.**
  - The principles chapter's assumptions change: a GitHub organisation, and the plan table above.
  - The review-and-merge chapter gains the merge-queue fallback.
  - A bootstrap section is added, and the definition of done and the cost rules become neutral about how a project deploys.
  - The 27 rulebook fixes from the friction log go in the same change.
- **The reference adopter.** It is in an organisation and runs without a merge queue, so it already uses the merge-queue fallback. Nothing changes there.
