# `agent-telemetry`: record what an agent run cost

Turns `claude-code-action`'s result file into one telemetry row (cost, turns, token usage, the configuration that ran, and the diff or issue size as a denominator), writes a summary, and uploads the row as an artifact. A separate collector stores it. This action writes to no store and needs no credentials (`K-OBS-13`).

`agent-finish` calls it. A lane that doesn't use `agent-finish` calls it directly, after the agent step.

## Use it

<!-- x-release-please-start-version -->

```yaml
- if: always()
  continue-on-error: true
  uses: yedeya-labs/kanon/actions/agent-telemetry@v0.15.0
  with:
    agent: reviewer
    execution_file: ${{ steps.agent.outputs.execution_file }}
    claude_args: ${{ env.CLAUDE_ARGS }}
    pr_number: ${{ env.PR_NUMBER }}
```

<!-- x-release-please-end -->

- **`always()`**, because a failed run is the one you most want measured.
- **`continue-on-error`**, because an observer must never turn a good run red. The upload step can't swallow its own failure, so the caller does.

| Input | Required | Meaning |
|---|---|---|
| `agent` | yes | Names the row. |
| `execution_file` | no | The agent step's `execution_file` output. |
| `claude_args` | no | The same flag block the agent ran with: the only source for the effort and the configuration fingerprint. |
| `pr_number` | no | The pull request under review. Its diff size is read and stored. |
| `issue_number` | no | The issue the run was for. Its size, and the lines the run committed, are stored. |
| `outcome_label`, `artifacts_filed`, `severities` | no | The lane's own result columns. Empty adds no column. |
| `lane` | no | Kanon's lane name (`LANES` in [`schema.mjs`](schema.mjs)). Set, the action also writes the version-2 row. |
| `tag` | no | `run` (the default), `smoke` or `test`. Every read and aggregate keeps only `run`. |
| `stages` | no | The lane's stages in the order it runs them, as `stage=conclusion` pairs (`token`, `checkout`, `hook`, `setup`, `agent`, `finish`). The row's `failed_stage` is the first that ended the run. A step the lane runs on past concludes `success`, so it is never blamed. |
| `kanon_error` | no | A code from Kanon's error list, when one of Kanon's steps failed and wrote one. |
| `job_status`, `job_started_at`, `timeout_minutes` | no | The job's status, start and timeout, for `job_status` and `timed_out`. A cancel within three minutes of the limit counts as the timeout, because the start stamp is the job's first step, not its start. |
| `retention_days` | no | How long the artifacts are kept for the collector. Default 7. |

## Two rows, two artifacts

- **Version 1,** `agent-telemetry-<agent>-<run id>-<attempt>`. Unchanged, because an existing collector reads it. It keeps the classifier's sentence and the free-text columns, so it stays inside the adopter.
- **Version 2,** `kanon-telemetry-<lane>-<run id>-<attempt>`, written only when the lane passes `lane` and the row passes `validate` in [`schema.mjs`](schema.mjs). It is the row a telemetry store accepts (`K-OBS-16`): flat, every string from a closed list or a strict pattern, a reason code instead of a sentence, and nothing the adopter wrote. An invalid row is not uploaded, and the warning names its fields, never their values. `kanon_version` is the release in `github.action_ref`, or `dev` at an untagged ref.

[`schema.mjs`](schema.mjs) holds both row kinds' field lists (the run row's 59 fields and the work-item row's 84), with their types, and `validate(row)`. It uses only Node's built-ins, so a collector or a store can run the same file at the same tag.
