# 0003. The licence is chosen before the first public release, not now

- **Status:** superseded by [ADR 0010](0010-licence.md) on 2026-09-30 (Apache-2.0, with a DCO)
- **Date:** 2026-09-27

## Context

Kanon is meant for other developers and teams. The business model is still open. The current lean is **open source with opinions, possibly with consultancy**; commercialising it as a product is not ruled out.

## Decision

The repository stays **private, with no licence file**, until the licence is chosen. The choice is made before the first public release, and is the last gate before it.

The options as understood today:

| Option | Suits | Cost |
|---|---|---|
| Apache-2.0 | Open source plus consultancy; includes a patent grant | Anyone may resell it or host it |
| Open core (Apache-2.0 core, paid hosted parts) | Keeps a commercial path open | Deciding where the line goes, and keeping it honest |
| Source-available (e.g. BSL, FSL) | Strongest commercial position | Deters adoption and contribution; "not really open source" |

## Consequences

- **Going from permissive to restrictive is effectively one-way.** Once a version is released under Apache-2.0 it stays available under Apache-2.0, so the decision has to be made once, deliberately.
- **Contributions.** No outside contributions are accepted before the licence exists, so no contributor-agreement question arises in the meantime.
