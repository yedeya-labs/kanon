# 0010. Kanon is licensed under Apache-2.0, and contributions are signed off

- **Status:** accepted
- **Date:** 2026-09-30
- **Supersedes:** [ADR 0003](0003-licence-deferred.md) (the licence deferred until before the first public release)

## Context

ADR 0003 deferred the licence to the last gate before Kanon's first public release. [ADR 0009](0009-move-dont-rewrite.md) brought that gate forward: the reference adopter can only call Kanon's lanes once Kanon is public, and the lanes are next to move.

The intended model is open source with opinions, possibly with consultancy, and possibly a hosted paid layer later (Kanon Cloud: the hosted telemetry, dashboards and improvement agents on the roadmap).

## Decision

1. **The core is licensed under Apache-2.0:** the rulebook, the ADRs, the actions, the lanes, the guards and the plugin. One licence covers text and code alike, for simplicity.
2. **Kanon Cloud is a separate, proprietary repository**, and is never part of the open core. The open-core boundary is a repository boundary, not a licence clause.
3. **Contributions are signed off under the Developer Certificate of Origin** (`Signed-off-by:` on every commit), not a contributor licence agreement. Contributors keep their own copyright and license their work under Apache-2.0.
4. **The copyright holder is Geoffry Nagy, personally.** It may be transferred to a company he owns later. Contributors hold the copyright in their own contributions.
5. **The name is protected separately from the code.** A short trademark policy says a fork or a modified distribution must not call itself Kanon. Registering the name is a later decision.

## Why

- **Apache-2.0 maximises adoption,** which a framework and any consultancy around it depend on. Its explicit patent grant is what companies' legal reviews ask for, and it is the permissive licence they approve most readily.
- **A proprietary Kanon Cloud needs nothing from the core's licence.** A permissive licence already allows the core, contributions included, to be used inside a proprietary product. So the paid layer doesn't need a copyleft core, dual licensing, or a time-delayed source-available licence (FSL, BSL). Those were considered and set aside: they deter the adoption the core exists for.
- **A DCO is enough without relicensing.** A contributor licence agreement is only needed to relicense the core itself later, and Apache-2.0 rules that out as a goal. A DCO adds no forms, which companies' contribution policies often forbid, and a pull-request check can enforce it.
- **A licence doesn't stop someone passing off a modified Kanon as Kanon. A trademark does.**

## Provenance

Kanon's code is being moved out of the reference adopter's repository (ADR 0009). The agreement that the agentic workflow is not the reference adopter's intellectual property, and may be released by its author, was made orally between the developer and the reference adopter's stakeholder on 2026-08-25. The Owner judges that agreement sufficient.

## Consequences

The public release needs:
- `LICENSE` (the Apache-2.0 text);
- `NOTICE` (copyright Geoffry Nagy);
- `CONTRIBUTING.md`, explaining the sign-off;
- a DCO check on pull requests;
- `TRADEMARK.md`;
- a repository **recreated without its private history**;
- the extraction's working files moved to a private repository first.

The public-release plan tracks these.
