# `agent-finish`: explain and record a run

Block 3 of an agent lane (see [`agent-setup`](../agent-setup/README.md)). It explains a red run with [`agent-classify`](../agent-classify/README.md), optionally counts the pull requests the run opened, and records the run's cost row with [`agent-telemetry`](../agent-telemetry/README.md). It never fails the lane.

## Use it

Call it with `id: finish`, `if: always()` and `continue-on-error: true`, and hand it the job's status:

```yaml
- id: finish
  if: always()
  continue-on-error: true
  uses: yedeya-labs/kanon/actions/agent-finish@vX.Y.Z
  with:
    arm: lead agent
    agent: lead
    job-status: ${{ job.status }}
    claude_args: ${{ env.CLAUDE_ARGS }}
    execution_file: ${{ steps.agent.outputs.execution_file }}
```

- **`always()`**, because a failed run is the one you most want explained and measured.
- **`continue-on-error`**, because an observer must never turn a good run red, including when the block itself fails to load.
- **`job-status`**, because inside a composite action `failure()` reads the action's own status, not the job's. The block classifies when `job-status` is `failure`.

| Input | Required | Meaning |
|---|---|---|
| `arm` | yes | A human name for the lane, for the classifier's annotation. |
| `agent` | yes | The telemetry agent name: the row's `agent` column. |
| `job-status` | yes | `${{ job.status }}`. |
| `claude_args` | yes | The same flag block `agent-run` was given. |
| `execution_file` | no | `agent-run`'s `execution_file` output. |
| `issue-number`, `pr-number` | no | The issue or pull request the run was for, recorded on the row. |
| `quality-pr-label`, `started-at`, `github-token` | no | Opt-in: count the pull requests with this label that reference `issue-number` and were opened after `started-at`. |
| `classify` | no | `"false"` for a lane that calls `agent-classify` itself. Default `"true"`. |
| `outcome-label`, `artifacts-filed`, `severities` | no | Result columns a lane computes itself. Empty adds no column. |

| Output | Meaning |
|---|---|
| `kind` | The classifier's verdict for a red run, empty otherwise. |
| `retry` | `unreachable` or `api_error` when waiting would help, empty otherwise. |
