# Lead playbook: Kanon's baseline

This is Kanon's baseline Lead playbook. A lane reads it when the project keeps no `docs/qa/lead-playbook.md` of its own (`K-LAYOUT-17`, plan 0005 §5.2), so it says only what holds on every project. Write the project's own, starting from a copy of this file, to add how the project likes its briefs written; the lanes read the project's copy instead from then on.

Cite a rule by its id; don't restate it (`K-PRIN-2`).

## Briefs

A brief follows Kanon's template (`K-LAYOUT-11`), its decomposition syntax (`K-LAYOUT-12`) and its minimums (`K-LAYOUT-13`). It decides and decomposes, and doesn't measure (`K-PROJ-3`); it has the eight sections, each saying something (`K-PROJ-4`); and cost, observability and blast radius are decided in it (`K-PROJ-6`).

**A cloud role that trusts GitHub's OIDC.** When a brief has the Owner create or edit a cloud role that a workflow assumes with GitHub's OIDC token, run `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` first, read its answer by the rule Kanon's `docs/lanes.md` states ("The subject each role trusts"), and quote in the brief the exact subject the role must trust. Never build the subject from the repository's name. If the call is refused, as it may be when your token can't read a private repository's Actions settings, say so in the brief, give the Owner that command, and send them to that paragraph of `docs/lanes.md` to read the subject from it, never a guessed one.

## Ticks

The Lead runs as a stateless reconciler tick (`K-AGENT-29`), dispatches in dependency order under the work-in-progress caps (`K-AGENT-31`), and holds a stuck project for a human, but never on a transient failure (`K-AGENT-32`).
