# Stack: Kanon

Kanon's stack document (`K-LAYOUT-17`): what its lanes' prompts read about Kanon's own stack. Kanon is a Node library of scripts, actions and workflows, with no app and no database.

## Gates

Run these before every push, in this order, from the repository root:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`, which runs every Vitest project, the library and unit tests together
4. `bash .github/scripts/actionlint.sh`, when a workflow or an action changed

There is no build and no E2E tier.

## Schema changes

None: Kanon has no database and no schema. It declares no test database (`K-LAYOUT-16`).

## Data isolation

Nothing to isolate: Kanon stores no data. The isolation Kanon cares about is between a pull request and the instructions that judge it (`K-MERGE-17`), which the reviewer playbook covers.

## Generated files

- `package-lock.json`: take the default branch's, then run `npm install` so the lock is derived rather than merged.
- `CHANGELOG.md`: release-please's. Take the default branch's and drop your side's entry.
