# Implementer playbook: Kanon's baseline

This is Kanon's baseline Implementer playbook. A lane reads it when the project keeps no `docs/qa/triage-fix-playbook.md` of its own (`K-LAYOUT-17`, plan 0005 §5.2), so it says only what holds on every project. Write the project's own, starting from a copy of this file, to add what its code asks for; the lanes read the project's copy instead from then on.

Cite a rule by its id; don't restate it (`K-PRIN-2`).

## Implementer mode

1. Re-measure the issue's claims before scoping work from them (`K-WORK-16`), and assess the scope first: a change on the bail list stops, with a plan (`K-AGENT-13`).
2. Build to the acceptance criteria, and treat a prescribed remedy as a hypothesis (`K-AGENT-17`).
3. Write the failing test first, and say so honestly when something can't be tested (`K-AGENT-15`).
4. Run the gates in the stack document's `## Gates` before you push, and follow its `## Schema changes` and `## Generated files` when the change touches them.
5. Sweep a claim before changing it, and state the blast radius (`K-AGENT-20`).
6. When you fix a bug and find the pull request whose change caused it, write `Introduced by #<n>` in your pull request's body: GitHub records it as a cross-reference on #<n>, the link Kanon's metrics count an escaped defect by. Name it on evidence, never a guess.

## Follow-ups: branch off the open parent

A follow-up whose parent pull request is still open is built on the parent's branch (`K-AGENT-19`).
