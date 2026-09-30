# 0006. The Stakeholder decides in GitHub, or the Maintainer attests

- **Status:** accepted
- **Date:** 2026-09-28

## Context

On a team, product decisions (what goes on the roadmap, what gates the launch) belong to the Stakeholder, but the person who merges is the Maintainer. In the reference adopter, the Stakeholder and the Maintainer agree things in conversation, and the Maintainer's merge of a brief is the only trace of that agreement. Nothing in the repository shows whether the Stakeholder agreed, or was asked at all.

The question was how directly Kanon should involve the Stakeholder. The options considered:

| Level | What the Stakeholder does | Record |
|---|---|---|
| A. Represented (the reference adopter today) | Talks to the Maintainer outside the workflow | The Maintainer's merge only |
| B. Attested | Nothing new; the Maintainer writes down the agreement | Written in the brief or issue, not verified |
| C. Decides in GitHub | Approves the specific decisions that are theirs | Verified |
| D. Co-authors | Writes a brief's goals with the Lead agent | An intake feature rather than governance; not pursued here |

## Decision

**C is the rule, and B is the fallback.** This is written as [`K-PRIN-18`](../../rulebook/00-principles.md), with [`K-PROJ-14`](../../rulebook/07-projects.md) for briefs and [`K-WORK-22`](../../rulebook/01-work-items.md) for gate candidates.

- **Decision points only.** The Stakeholder never takes part in the flow of work, only in a fixed set of decisions:
  - placing work on a roadmap milestone;
  - whether a `gate-candidate` joins the launch gate;
  - a project's closure rule;
  - the priority of roadmap milestones.
- **Every such decision leaves a record in the repository.**
  - *Approved:* the Stakeholder decided in GitHub.
  - *Attested:* the Maintainer records the agreement, naming the Stakeholder and when or where it was agreed.

  The record always shows which of the two it is. It's one fixed rule with two recorded outcomes, not a setting.
- **The digest is the Stakeholder's interface.** The weekly digest leads with the decisions waiting for them. The Stakeholder doesn't need to use the issue tracker.

## Consequences

- The conversation outside the workflow still happens. Its outcome now enters the record, instead of being implied by a merge.
- Guards are planned for both places a Stakeholder decision is needed: a brief that places roadmap work, and a `gate-candidate` placed on the gate. Until they exist, these rules are prose only.
- **Later, in the Kanon Cloud phase:** approving from chat or email instead of GitHub. That would turn most attestations into approvals and remove the need for the Stakeholder to have a GitHub account.
- **The reference adopter changes too.** Its briefs name a roadmap milestone, and its Maintainer's merge is taken as the Stakeholder's approval. Under this rule, those briefs need an explicit approval or attestation.
