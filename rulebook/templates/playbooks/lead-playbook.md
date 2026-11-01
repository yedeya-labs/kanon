# Lead playbook: Kanon's baseline

This is Kanon's baseline Lead playbook. A lane reads it when the project keeps no `docs/qa/lead-playbook.md` of its own (`K-LAYOUT-17`, plan 0005 §5.2), so it says only what holds on every project. Write the project's own, starting from a copy of this file, to add how the project likes its briefs written; the lanes read the project's copy instead from then on.

Cite a rule by its id; don't restate it (`K-PRIN-2`).

## Briefs

A brief follows Kanon's template (`K-LAYOUT-11`), its decomposition syntax (`K-LAYOUT-12`) and its minimums (`K-LAYOUT-13`). It decides and decomposes, and doesn't measure (`K-PROJ-3`); it has the eight sections, each saying something (`K-PROJ-4`); and cost, observability and blast radius are decided in it (`K-PROJ-6`).

**A cloud role that trusts GitHub's OIDC.** When a brief has the Owner create or edit a cloud role that a workflow assumes with GitHub's OIDC token, read the repository's own subject prefix first, with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (its `sub_claim_prefix`), and quote in the brief the exact subject the role must trust: for a deploy environment, `<prefix>:environment:<name>` (Kanon's `docs/lanes.md`, "The subject each role trusts"). Never build the prefix from the repository's name. A repository created since 2026-07-15 has the immutable `repo:<owner>@<owner id>/<repo>@<repo id>`, and a role trusting `repo:<owner>/<repo>:…` refuses every token it issues. If the call is refused, your token may lack Actions: read on a private repository: say so in the brief, give the Owner that command, and write the subject as `<sub_claim_prefix from that command>:environment:<name>`, never a guessed prefix.

## Ticks

The Lead runs as a stateless reconciler tick (`K-AGENT-29`), dispatches in dependency order under the work-in-progress caps (`K-AGENT-31`), and holds a stuck project for a human, but never on a transient failure (`K-AGENT-32`).
