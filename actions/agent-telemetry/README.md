# `agent-telemetry`: record what an agent run cost

Turns `claude-code-action`'s result file into one telemetry row (cost, turns, token usage, the configuration that ran, and the diff or issue size as a denominator), writes a summary, and uploads the row as an artifact. A separate collector stores it. This action writes to no store and needs no credentials (`K-OBS-13`).

`agent-finish` calls it. A lane that doesn't use `agent-finish` calls it directly, after the agent step.

## Use it

<!-- x-release-please-start-version -->

```yaml
- if: always()
  continue-on-error: true
  uses: yedeya-labs/kanon/actions/agent-telemetry@v0.8.1
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
| `retention_days` | no | How long the artifact is kept for the collector. Default 7. |

The artifact is named `agent-telemetry-<agent>-<run id>-<attempt>`.
