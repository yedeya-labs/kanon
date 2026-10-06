# `agent-classify`: say why a red agent run went red

Block 4 of an agent lane (see [`agent-setup`](../agent-setup/README.md)). It reads the result file `claude-code-action` writes and says whether the model was unreachable, the run ran out of turns or dollars, or it genuinely failed. The advice differs: wait, change the budget or the work, or re-run.

`agent-finish` calls it. A lane that classifies outside `agent-finish` calls it directly.

## Use it

The block has no `if:` of its own, because the right gate depends on the lane. Gate it yourself:

<!-- x-release-please-start-version -->

```yaml
- id: classify
  if: failure()
  uses: yedeya-labs/kanon/actions/agent-classify@v0.32.0
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

- **The reason code is not an output of this block** (#314). The classifier returns one beside each kind — `none` (ok), `model_never_ran` or `no_model_ran` (unavailable), `turn_cap` or `budget_cap` (exhausted), `did_not_finish` (failed), `no_result_file` (not-reached) — and it is what the telemetry row's `reason` column stores, but [`agent-telemetry`](../agent-telemetry/README.md) imports [`classify-agent-result.mjs`](classify-agent-result.mjs) and reads the code off the return. It has to: it records a green run's code too, and this block runs only on a red run. So there is one expression for that column, not two.

- **The code, not the sentence, is what telemetry stores** (`K-OBS-16`). The sentence names the model and the numbers, so it stays in the annotation and the step summary.

- **It never fails the run.** The script always exits 0: it explains a red run and must not cause one.
- **It reads `$RUNNER_TEMP/claude-execution-output.json`,** where `claude-code-action` writes its result.
- **The script runs from the action's own directory,** never from the checked-out tree, so a pull request under review can't change it.
