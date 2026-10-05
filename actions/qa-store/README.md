# `qa-store`: one QA store operation, through the adopter's hook

Kanon's store-coupled lanes call this block from their store jobs, each in the `kanon-qa-store` environment ([plan 0004 §3.2](../../docs/plans/0004-move-the-remaining-lanes.md), [`K-OBS-17`](../../rulebook/08-observability-and-cost.md)). It checks out the commit the run is for, runs one operation of the store contract through your hook, `.github/actions/qa-store/action.yml`, and turns what the hook wrote into its outputs and one line of the job's summary. You don't call this block yourself. You write the hook, or leave it out.

| Operation | What the lane gets |
|---|---|
| `last-green` | `commit`: the newest green full sweep's commit, or empty |
| `record-skip` | the skip recorded, or a red job |
| `put` | the report written, or a red job |
| `export` | an artifact, `artifact-name`, kept one day, holding the files the contract fixes and `manifest.json` |
| `cost-rows` | `cost-rows.json` in `dir`: `{rows, error}`, as the dispatch sweep's store read returns it; and the same answer as the `rows` output, one line of JSON, which the dispatch sweep's job reads from the store job's outputs |
| `delete-export` | the export's artifact deleted, by `artifact-id`; needs only `actions: write`. Given the export's `attempt` and the agent job's `result`, it turns red a re-run that skipped the agent job because its export was already deleted, and says to re-run all jobs |

`state` is `ok`, `absent` (no hook: the operation did nothing, and the summary says the store is absent) or `degraded` (a read failed or returned something malformed, and the lane fails open).

[The QA store](../../docs/qa-store.md) has the contract: each operation's files and formats, the store jobs' shape, and Kanon's AWS implementation, which is the hook's one `uses:` line.
