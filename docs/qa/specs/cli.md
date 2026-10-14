# Kanon's CLI

What `kanon init` and `kanon doctor` do for an adopter, where a project has needed a clause to cite. This area holds only the clauses projects have seeded so far; it is not a complete description of the CLI, whose contract is [`docs/init.md`](../../init.md), [`docs/doctor.md`](../../doctor.md) and [`docs/cli-json.md`](../../cli-json.md). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `CLI`

## init

- `[CLI-1]` `[seed]` `kanon init` pins `vX.Y.Z` when that tag exists on Kanon, else `candidate-vX.Y.Z` when that tag exists, and otherwise refuses, saying which tags it looked for.

## Retired

- `[CLI-2]` `[retired]` `kanon doctor` reports the blocking finding `replay.on` when the adoption record's `Agent replay` choice is `on`, unless the record waives it. Seeded by project #902's draft brief, and retired with the `Agent replay` choice under the Owner's no-leak rule (plan 0012, decision 6).
