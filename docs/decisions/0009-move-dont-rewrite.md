# 0009. The extraction moves the reference adopter's loop; it doesn't rewrite it

- **Status:** accepted
- **Date:** 2026-09-30
- **Supersedes:** the minimum-agent-loop plan (proposed and withdrawn the same day)

## Context

The first adopter was playing every agent role by hand during bootstrap, which proved heavy. A plan proposed to end that with a **minimum loop**: a small review lane of about 250 lines instead of the reference adopter's 2,036, and a stateless brief filer of about 300 lines instead of its roughly 3,750-line reconciler.

The Owner rejected that approach:
- **A minimum loop is a second implementation** of a loop that already exists, derived from it, and it would drift from it. That is the failure `K-PRIN-2` ("a rule has exactly one home") exists to prevent, applied to code.
- **A rewrite discards the edge cases** that the original's length encodes, each of them paid for by an incident.
- **Agents rewriting the loop invite exactly the discrepancy** the extraction must avoid.

## Decision

1. **There is one implementation: the loop the reference adopter runs today.** Kanon's lanes, guards and scripts are that loop, **moved**, not rewritten, and not reimplemented in a smaller form.
2. **Move, don't copy.** Each piece leaves the reference adopter and lands in Kanon **in the same step** that switches the reference adopter to calling it from Kanon at a pinned version (`K-ADOPT-11`). At no time do two live copies exist.
3. **A move is mechanically checkable.**
   - The change is a file move plus an **explicit list of literal substitutions**: the repository name, App slugs, milestone titles, and other names specific to the reference adopter.
   - Git's rename detection must show everything else unchanged.
   - The piece's existing tests move with it and stay green, in Kanon and in the reference adopter.

   Whoever performs the move, human or agent, cannot change behaviour without that showing in the diff.
4. **Where a piece is too coupled to move as it is,** the coupling is removed **in the reference adopter first**, as an ordinary change it reviews and tests, and the piece is moved afterwards. The reference adopter's own lane conversions onto its shared lane spine are that preparation for the lanes.
5. **Kanon goes public before any lane moves.** The reference adopter lives in a different GitHub organisation, and a private repository's actions and workflows can only be used within its own organisation. The alternatives were rejected:
   - GitHub Enterprise, only to share across organisations, costs about $21 per user per month;
   - moving the reference adopter into Kanon's organisation reverses the IP boundary Kanon was created to respect.

   Going public was always the destination, and it also removes the two one-time settings a private Kanon needs.
6. **The second adopter stays in manual bootstrap until the lanes arrive**, then installs them like any adopter. Its bootstrap ends by installing the real loop, not by waiting for a special one.

## Consequences

- **The order of work follows the reference adopter's lane-spine conversion:** finish converting every lane to a thin caller of the shared spine, then move the spine, then the lanes, one at a time.
- **The public release comes first.** A licence ([ADR 0010](0010-licence.md)), a repository recreated without the private history, and the extraction's working files moved to a private repository.
- **The second adopter's earlier answers stand:**
  - the Team plan, for rulesets and so that bootstrap can end;
  - Apps created from manifests, one per role of the full loop;
  - the subscription token, with one lane run at a time;
  - an Actions budget with a $0 spending limit;
  - the reference adopter's own 180-minute implement timeout;
  - the revise lane.
- **The withdrawn plan's cost measurements stay useful input:** about 65 Actions minutes and about $21 of API-equivalent usage per item, measured on the reference adopter's runs.
