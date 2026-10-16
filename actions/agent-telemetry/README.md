# `agent-telemetry`: record what an agent run cost

Turns `claude-code-action`'s result file into one telemetry row (cost, turns, token usage, the configuration that ran, and the diff or issue size as a denominator), writes a summary, and uploads the row as an artifact. A separate collector stores it. This action writes to no store and needs no credentials (`K-OBS-13`).

`agent-finish` calls it. A lane that doesn't use `agent-finish` calls it directly, after the agent step.

## Use it

<!-- x-release-please-start-version -->

```yaml
- if: always()
  continue-on-error: true
  uses: yedeya-labs/kanon/actions/agent-telemetry@v0.40.0
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
| `pr_number` | no | The pull request under review. Its diff size is read and stored. On a revise lane, the open items the Reviewer's latest changes-request declares are stored too, as `review_open_items` (run row version 4, [#173](https://github.com/yedeya-labs/kanon/issues/173)). |
| `issue_number` | no | The issue the run was for. Its size, the number of acceptance criteria it states (`issue_ac_count`, run row version 4: each top-level bullet under an "Acceptance criteria" or "What must be true" line, including the bullets after an intro sentence, or one for a label that states its criterion in prose with no bullets, plus each distinct `[ID-n]` clause cited elsewhere) and the lines the run committed are stored. |
| `outcome_label`, `artifacts_filed`, `severities` | no | The lane's own result columns. Empty adds no column. |
| `lane` | no | Kanon's lane name (`LANES` in [`schema.mjs`](schema.mjs)). Set, the action also writes the version-2 row. |
| `tag` | no | `run` (the default), `smoke` or `test`. Every read and aggregate keeps only `run`. |
| `stages` | no | The lane's stages in the order it runs them, as `stage=conclusion` pairs (`token`, `checkout`, `hook`, `setup`, `agent`, `finish`). The row's `failed_stage` is the first that ended the run. A step the lane runs on past concludes `success`, so it is never blamed. |
| `kanon_error` | no | A code from Kanon's error list, when one of Kanon's steps failed and wrote one. |
| `prompt_cache_ttl` | no | The TTL the run was pinned at, as `agent-run`'s `prompt-cache-ttl` output says it: `5m`, `1h` or `default`. Recorded as the row's `prompt_cache_ttl`, from run row version 3. Empty, or any other value, records nothing. |
| `job_status`, `job_started_at`, `timeout_minutes` | no | The job's status, start and timeout, for `job_status` and `timed_out`. A cancel within three minutes of the limit counts as the timeout, because the start stamp is the job's first step, not its start. |
| `agent_outcome` | no | The agent step's `outcome`, for a lane that runs it `continue-on-error`. With the `agent` stage's conclusion and the job's status, it says whether the step failed, which a run past its turn cap needs to be recorded as one ([#1014](https://github.com/yedeya-labs/kanon/issues/1014)). It is not a stage and never moves `failed_stage`. |
| `retention_days` | no | How long the version-1 artifact is kept for the collector. Default 7. The version-2 artifact is always kept 90 days, below. |

## Two rows, two artifacts

- **Version 1,** `agent-telemetry-<agent>-<run id>-<attempt>`. Unchanged, because an existing collector reads it. It keeps the classifier's sentence and the free-text columns, so it stays inside the adopter.
- **Version 2,** `kanon-telemetry-<lane>-<run id>-<attempt>`, kept 90 days whatever `retention_days` says, so a store can import rows written long before it existed (plan 0002's S1a). Written only when the lane passes `lane` and the row passes `validate` in [`schema.mjs`](schema.mjs). It is the row a telemetry store accepts (`K-OBS-16`): flat, every string from a closed list or a strict pattern, a reason code instead of a sentence, and nothing the adopter wrote. An invalid row is not uploaded, and the warning names its fields, never their values. `kanon_version` is the release in `github.action_ref`, or, for a lane's `$/` call, whose `action_ref` is a commit, the release tag in `job.workflow_ref` when `job.workflow_sha` is that same commit ([#454](https://github.com/yedeya-labs/kanon/issues/454)). Any other ref, a branch, a pull request or a SHA pin, is `dev`. Since [#546](https://github.com/yedeya-labs/kanon/issues/546) a row that records its TTL is run row version 3, `schema_version: 3`: version 2's fields and `prompt_cache_ttl`. A row that records none is still version 2, and a store keeps accepting version 2, which older releases write. Since [#173](https://github.com/yedeya-labs/kanon/issues/173) a row that carries `review_open_items` or `issue_ac_count` is version 4, `schema_version: 4`: version 3's fields and the two counts. Each row is written at the lowest version that holds it.

[`schema.mjs`](schema.mjs) holds the five row kinds' field lists (the run row's 59 fields at version 2, 60 at version 3, which adds `prompt_cache_ttl`, the TTL the run was pinned at, [#546](https://github.com/yedeya-labs/kanon/issues/546), and 62 at version 4, which adds the counts `review_open_items` and `issue_ac_count`, [#173](https://github.com/yedeya-labs/kanon/issues/173); the work-item row's 84, the upstream-finding row's 21, [plan 0006](../../docs/plans/0006-upstream-findings.md) §2, and the deploy row's 22, one environment's deploy of one release, which names the environment by its role, `production` or `pre-production`, and its position in the chain, never by its name, [plan 0010](../../docs/plans/0010-deployment-lane.md) §10, and the notify row's 16, one `notify` job's outcome and the hook's kind, never a URL, a channel or any text, [plan 0011](../../docs/plans/0011-notifications.md) §11), with their types, and `validate(row)`. It uses only Node's built-ins and its own directory's files, so a collector or a store can run the same files at the same tag. [`scrub.mjs`](scrub.mjs) is the scrub of a finding's evidence text (plan 0006 §4.2): `redact` for the lane that writes the row, and `verify`, which `validate` runs on every text field. Its `name` rule is `namesForbiddenWord` from [`public-words.mjs`](public-words.mjs), the reference adopter's hashed names, which lives here as a real file because the `kanon` CLI loads it at startup and npm drops symbolic links when it installs the CLI from GitHub; `.github/scripts/public-words.mjs`, the PR-text check, re-exports it, and the ingest function's directory links to it.
