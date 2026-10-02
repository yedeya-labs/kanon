# `agent-classify`: say why a red agent run went red

Block 4 of an agent lane (see [`agent-setup`](../agent-setup/README.md)). It reads the result file `claude-code-action` writes and says whether the model was unreachable, the run ran out of turns or dollars, or it genuinely failed. The advice differs: wait, change the budget or the work, or re-run.

`agent-finish` calls it. A lane that classifies outside `agent-finish` calls it directly.

## Use it

The block has no `if:` of its own, because the right gate depends on the lane. Gate it yourself:

<!-- x-release-please-start-version -->

```yaml
- id: classify
  if: failure()
  uses: yedeya-labs/kanon/actions/agent-classify@v0.9.1
  with:
    arm: review agent
```

<!-- x-release-please-end -->

| Input | Required | Meaning |
|---|---|---|
| `arm` | yes | A human name for the lane, used in the annotation. |
| `recover` | no | The command that recovers the run, printed where a re-run is the advice. |
| `non-fatal` | no | `"true"` for an agent step whose failure leaves the job green. The annotation is then a warning. |

| Output | Meaning |
|---|---|
| `kind` | `unavailable`, `exhausted`, `failed`, `ok` or `not-reached`. |
| `retry` | `unreachable` or `api_error` when waiting would help, empty otherwise. |

- **It never fails the run.** The script always exits 0: it explains a red run and must not cause one.
- **It reads `$RUNNER_TEMP/claude-execution-output.json`,** where `claude-code-action` writes its result.
- **The script runs from the action's own directory,** never from the checked-out tree, so a pull request under review can't change it.
