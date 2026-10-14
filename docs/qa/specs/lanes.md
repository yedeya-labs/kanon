# Kanon's lanes

What Kanon's lanes do in an adopter's repository, where a project has needed a clause to cite. This area holds only the clauses projects have seeded so far; it is not a complete description of the lanes, whose contract is [`docs/lanes.md`](../../lanes.md) and the rulebook. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `LANE`

## Agent replay

- `[LANE-1]` `[seed]` With the adoption-record choice `Agent replay` set to `on`, `agent-run` runs no `claude-code-action` step and needs no Claude credential: it writes the recording's `execution_file` and applies the recording's effects with the minted App token.
- `[LANE-2]` `[seed]` `agent-run` refuses a recording made against a release other than the one it runs at.
- `[LANE-3]` `[seed]` Every comment a replayed run posts carries the replay marker, and the run's telemetry row is `tag: test`.

## Run ceiling and telemetry tag

- `[LANE-4]` `[seed]` With the adoption-record choice `Run ceiling`, every lane's agent job passes `--max-budget-usd` as the lower of its own ceiling and the declared one, so a declared ceiling above a lane's own changes nothing.
- `[LANE-5]` `[seed]` With the adoption-record choice `Telemetry tag` set to `test`, every row the repository's lanes write carries `tag: test`.
