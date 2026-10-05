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

## Code areas

Kanon's own source and tests (`K-LAYOUT-17`). `citation-shift` reads comments in each, `doc-path-guard` reads no test tree's files as claims, and the spec-id reference corpus walks them all.

- `scripts/` — code: the library's scripts, which the lanes and the guards run
- `actions/` — code: the composite actions and their scripts
- `cli/` — code: the `kanon` command
- `infra/` — code: the QA store's AWS implementation
- `.github/scripts/` — code: the scripts Kanon's own workflows run
- `tests/` — tests: the library and unit tests, and their fixtures

What the code audit reads, in this order (plan 0004 step 11a). Kanon's product is its rules and the machinery that holds a project to them, so the audit looks for objective contradictions between the two, as the [explorer playbook](explorer-playbook.md)'s "Code-reading mode" says.

- `rulebook/` — audit: the rules, each with its **Why** and its "Enforced by" line, and `agent-permissions.json`, the roles table's twin
- `docs/` — audit: the decisions, the plans, the lane and store documents, and this repository's own adoption record and App register, each of which says what the code does
- `actions/` — audit: the composite actions, including the checks that judge a pull request (`dco`, `pr-title`, `lane-check`) and the agent-lane blocks
- `.github/workflows/` — audit: the lanes, and Kanon's own workflows and callers
- `tests/` — audit: the guards, which hold the rules and the docs to the code
- `scripts/` — audit: the library's scripts, which the lanes and the guards run
- `cli/` — audit: the `kanon` command, which installs what the rules require
