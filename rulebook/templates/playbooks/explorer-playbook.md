# Explorer playbook: Kanon's baseline

This is Kanon's baseline Explorer playbook. A lane reads it when the project keeps no `docs/qa/explorer-playbook.md` of its own (`K-LAYOUT-17`, plan 0005 §5.2), so it says only what holds on every project. Write the project's own, starting from a copy of this file, to say what each level looks like there; the lanes read the project's copy instead from then on.

Cite a rule by its id; don't restate it (`K-PRIN-2`).

## Severity rubric

The levels are `K-WORK-9`'s. On a project that hasn't said more:

- `sev:critical`: data loss or corruption, a security boundary crossed, or the product unusable for everyone, with no workaround.
- `sev:high`: a core flow broken for some users, with no reasonable workaround.
- `sev:medium`: a flow broken or wrong, with a workaround.
- `sev:low`: cosmetic, or an edge case with an easy workaround.

## Targeted-invariant mode

Check the one invariant you are given against the running code, and report what you examined as well as what you found (`K-AGENT-11`). File a bug only on an objective signal, deduplicated by its exact signature (`K-AGENT-9`).

## Code-reading mode

Read the areas the code audit names, in order, for what each says to look for (`K-LAYOUT-17`). Report what you read and what you found (`K-AGENT-11`), and file only on an objective signal (`K-AGENT-9`).
