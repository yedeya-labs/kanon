# 0002. Standardise, don't parameterise

- **Status:** accepted
- **Date:** 2026-09-27 (the principle dates from 2026-09-19, in the reference adopter)

## Context

A framework meant for many projects is usually expected to be configurable: label names, milestone names, paths, severity levels, all in a config file.

Kanon's guards work by **scanning the project's source for string literals** and checking them against the rules: every label a workflow applies, every operational signal a log line emits, every spec id an issue cites. The reference adopter put the reason in the source of its label guard: *a declared list is checkable offline and drifts silently. It becomes a third opinion about what a label is. The repo is the only authority.*

A configuration layer would give every guard a second source of truth to agree with, and a guard that checks the code against a config the code also reads can no longer fail. **A config file would make the guards vacuous.** The reference adopter designed one (`forge.config.ts`) and rejected it for this reason.

## Decision

Kanon is **standardised, not parameterised**. Every adopter uses the same label taxonomy, the same milestone kinds, the same spec-id scheme, the same document paths and the same agent roles. Guards scan for those fixed literals and keep working unmodified on every project.

A project's own content is still its own: its specs, its domain guards, its list of paths that need a human. What is fixed is the *shape* that content takes, not the content.

## Consequences

- **Adoption is a yes/no decision per rule, not a settings exercise.** When a rule doesn't fit a project, the outcome is recorded as either "the rule changes for everyone" or "this project is outside Kanon's target". A rule is never switched off for one project.
- **Kanon must say what it is not for.** A framework that cannot be configured has to name its target adopter plainly (see the rulebook's principles chapter).
- **Each rule has to be defended.** Every rule in the rulebook carries its reason, because an adopter cannot opt out of a rule and deserves to know why it exists.
