# The QA store

The QA store holds what Kanon's store-coupled lanes remember between runs: the Explorer's and the code audit's run rows and raw reports, route coverage, and the code-reading ledger (`K-OBS-17`). It lives in the adopter's own account, and the lanes reach it only through a **contract**: a hook the adopter writes, at a fixed path, with five operations ([plan 0004 §3.2](plans/0004-move-the-remaining-lanes.md#32-the-decision-a-contract-with-hooks-and-aws-as-the-first-implementation)). Kanon ships the first implementation behind it, on AWS. An adopter with no hook gets every lane, without memory.

This page is the contract, then the AWS implementation and its runbook.

## The contract

### The hook

`.github/actions/qa-store/action.yml` is a composite action you write, when you run a store. Kanon's [`qa-store` block](../actions/qa-store/action.yml) calls it with six string inputs:

| Input | What |
|---|---|
| `operation` | `last-green`, `record-skip`, `put`, `export` or `cost-rows` |
| `kind` | `put`: `explorer` or `audit`. `export`: `audit` or `overseer`. `cost-rows`: the telemetry agent whose rows it reads, such as `implementer`. |
| `dir` | A directory the block made for this operation. The hook reads and writes only the files below. |
| `from` | `export` and `cost-rows`: the window's start, a store stamp such as `20260904T120245Z`, exclusive. |
| `to` | `cost-rows`: the window's end, a store stamp, inclusive. Empty means now. |
| `variables` | Your repository's Actions variables, as JSON (`toJSON(vars)`, read by the lane's store step). A composite action can't read `vars` itself, so this is where the hook finds its store's coordinates: read one with `fromJSON(inputs.variables \|\| '{}').<NAME>`. Keep anything that names your cloud account here, not in the committed hook. |

The block reads the hook from a checkout of the commit the run is for, made without persisted credentials.

### The operations

| Operation | Called by | The hook reads | The hook writes |
|---|---|---|---|
| `last-green` | the Explorer's change gate | nothing | `dir/last-green`: the commit of the newest green full sweep, or nothing |
| `record-skip` | the Explorer's change gate | `dir/skip.json`: `{commit, trigger, tier, reason}` | nothing |
| `put` | the code audit and the Explorer, after the agent | `dir/report.json`: the Explorer's sweep summary ([its format](explore-sweep.md#the-summary)) or the audit's report | nothing |
| `export` | the code audit and the Overseer, before the agent | nothing | `dir/export/`: the files below |
| `cost-rows` | the dispatch sweep, before its job | nothing | `dir/cost-rows.json`: `{rows, error}`, each row `{ts, issue_number, outcome, run_id}`, strings or null |

An **export** holds JSON arrays of objects, one per row, with each row's attributes as plain JSON and its sort key named for what it is:

| File | Rows | In which export |
|---|---|---|
| `areas.json` | the code-reading ledger: `{area, last_scanned_ts, commit, detail}` | `audit`, `overseer` |
| `runs-explorer.json` | the Explorer's runs after `from`, newest first: `{ts, commit, trigger, tier, …}` | `overseer` |
| `runs-audit.json` | the audit's runs after `from`, newest first: `{ts, commit, files_read, …}` | `overseer` |
| `coverage.json` | per route: `{route, last_status, last_seen_commit, ts}` | `overseer` |
| `reports/<kind>/<ts>.json` | each run's raw report, for the runs in the window | `overseer` |
| `token-trend.md`, `cache-ttl.md`, `qa-clusters.md` | your own Overseer inputs, if your hook writes them (plan 0004 §3.2) | `overseer` |

An attribute a row doesn't carry is absent, never `false` or 0. The block leaves out any other file, with a warning, and adds `manifest.json`, which says whether the store was present, absent or degraded, and lists the files.

**No cost rows** (plan 0004 step 13). The telemetry store's per-run cost rows are not in any export. The Overseer reads cost as the week's token trend, `token-trend.md`, which your hook writes from those rows, and the prompt-cache facts as `cache-ttl.md`, so its agent gets the arithmetic and never the raw rows, which plan 0002 owns (`K-OBS-13`). After plan 0002's S7 the lane reads both through that plan's `query` instead, and the two files go.

### What the block does with the answer

- **A write that fails fails the store job.** That red run is the page (`K-OBS-6`).
- **A read that fails is degraded, and fails open:** `last-green` returns no commit, so the Explorer sweeps; `export` holds only its manifest, saying it is degraded; `cost-rows` holds no rows and an error, so the sweep charges every dispatch. A `last-green` that isn't a bare 40-character SHA, an export that lacks a file or holds a malformed one, and a malformed `cost-rows.json` are degraded too.
- **`cost-rows` is handed on as the block's `rows` output,** `{rows, error}` as one line of JSON, because the dispatch sweep reads it in a job of its own, with no credentials: its store job outputs each telemetry agent's `rows`. The sweep's step receives each answer as one environment variable, which Linux caps at 131,072 bytes, so an answer over 100,000 bytes (about 1,100 rows, far above a 14-day window's few hundred) is degraded, never truncated.
- **Without a hook,** every operation says the store is absent, in the job's summary, and does nothing: `last-green` returns no commit, `record-skip` and `put` are skipped, `export` holds only its manifest, and `cost-rows` holds no rows and the error `the QA store is absent`, on which the dispatch sweep reads run artifacts instead ([plan 0004 §3.3](plans/0004-move-the-remaining-lanes.md#33-the-dispatch-sweep-reads-the-store-and-run-artifacts-without-one)).

### Store jobs

Every store operation runs in a job of its own, which holds the store's credentials and does nothing else. No agent job holds them:

- **A store job** declares an explicit `permissions:` with `id-token: write`, and no environment. The store's role trusts the default branch's ref (below), and an environment would replace the ref in the job's OIDC subject, so the role would refuse it. It is the only kind of job, in any of Kanon's workflows, that holds `id-token: write`. Its steps are the `qa-store` block's, and, in a job that `put`s, the `actions/download-artifact` step that fetches the report: nothing else runs with the store's credentials (kanon#225). Neither the job nor a step sets `env:`, which could hand the block a `NODE_OPTIONS`, and the job has no `container:`, `services:` or `defaults:`. Work that reads a store job's answer, such as the Explorer's gate comparing `last-green` with the commit, runs in a job of its own after it, reading its outputs.
- **The agent job** declares an explicit `permissions:` without `id-token`. It still grants every read its telemetry step makes with the workflow token. It reads the store through the export, which it downloads as an artifact.
- **The export's delete job** deletes that artifact after the agent job, whatever happened to it: `if: always()`, `needs:` the export job and the agent job, and `actions: write` granted to it alone, and runs the block's `delete-export` step and nothing else. The export is kept one day at most.
- **A re-run of the agent job alone has no export** (kanon#224). "Re-run failed jobs" re-runs a failed agent job and the jobs after it, the delete job among them, but not the export job, which succeeded: it reuses the export job's outputs, and the earlier attempt's delete job has already deleted the artifact they name. So the agent job runs only on the export's own attempt, `if: needs.<export>.outputs.attempt == github.run_attempt`, and is skipped on such a re-run rather than run without the store. The delete job is handed the export's `attempt` and the agent job's `result`, and turns that re-run red with the remedy: **re-run all jobs**, which exports again. A re-run of the delete job alone, after an agent job that succeeded, deletes the export and stays green.

`tests/unit/helpers/store-jobs.ts` checks this shape, and each store-coupled lane's test applies it to the lane. `tests/unit/id-token-guard.test.ts` holds every workflow Kanon ships to the last rule: a job that holds `id-token: write`, by its own grant or by inheriting the workflow's, must run the `qa-store` block alone (or the AWS store's maintenance block alone), or call a lane that has such a job. Any other fails `npm test` by name.

### Who can reach the store

The store's role trusts one OIDC subject per repository: **the default branch's ref**, `<prefix>:ref:refs/heads/<default branch>`, by exact match. There is no GitHub Environment. The Owner dropped it on 2026-10-05 (plan 0004, decision 9): an environment's branch restriction needs a paid plan in a private repository, and the environment added a setup step without protecting anything the ref does not. What scopes the store to its store jobs is now which jobs hold `id-token: write`, which the guard above holds.

`<prefix>` is the repository's own subject prefix, which GitHub's API reports at `repos/<owner>/<repo>/actions/oidc/customization/sub`. It is `repo:<owner>/<repo>` for an older repository, and the **immutable** `repo:<owner>@<owner id>/<repo>@<repo id>` for one created after 2026-07-15, which a role trusting the first form refuses. `provision.mjs` reads it, so you never type it.

What the trust admits and refuses, measured on a sandbox repository on 2026-10-05 where marked:

| A token from | Its subject | The store |
|---|---|---|
| A scheduled run, or a dispatch on the default branch | `<prefix>:ref:refs/heads/<default branch>` (measured) | admitted |
| A pull request, from any branch | `<prefix>:pull_request` (measured) | refused |
| `pull_request_target` | `<prefix>:pull_request` (measured, although the run's ref is the default branch) | refused: stricter than before, when a `pull_request_target` job that declared the environment was admitted |
| A dispatch or push on another branch, a tag, the merge queue | that ref (a branch dispatch measured) | refused |
| A job that declares any environment | `<prefix>:environment:<name>` | refused |
| A fork's pull request | no token: GitHub gives a fork's run none | refused |
| Any job of a default-branch workflow that holds `id-token: write`, **including your own jobs that already hold it for another cloud** | `<prefix>:ref:refs/heads/<default branch>` | **admitted**. With an environment, only a job edited to declare `kanon-qa-store` was; now every existing holder on the default branch is, with no change on your side |

The one thing the environment did that the ref does not is name the store jobs in the subject. Two things follow:

- **A Kanon job wrongly given `id-token: write` would be admitted.** The guard above fails such a job in Kanon's own workflows, and GitHub gives a job without the grant no `ACTIONS_ID_TOKEN_REQUEST_*` variables, so it cannot ask for a token at all.
- **Every job of yours that already holds `id-token: write` on the default branch is admitted too.** A push-to-main deploy that assumes a role in your cloud, say, holds the grant for its own reasons and runs its build's dependencies. Under the environment trust its subject was refused. Under the ref trust it can assume the store's role, and the store sits in your reference environment's account (`K-OBS-17`). Kanon's guard does not read your workflows. **Before you re-provision, list your default-branch jobs that hold `id-token: write`** (by their own `permissions:` or their workflow's), and accept each one as a holder of the store's credentials, or narrow its grant. [`kanon doctor`](doctor.md#the-id-token-holders) lists them, and you accept one with a bullet in the adoption record (`K-LAYOUT-10`). The store's role can read and write QA data and delete `COVERAGE` rows; it cannot reach anything else in the account.

### Setting it up

1. **Write the hook.** For Kanon's AWS store it is one call of Kanon's AWS action (below), with the role and the bucket read from two repository variables, so the account id they carry is never committed. For any other store, implement the five operations on the files above, reading anything account-specific from `variables` the same way.
2. **Grant `id-token: write` and `contents: read` in the caller** of each store-coupled lane. Kanon's lane uses `id-token` only in its store jobs, and their checkout needs `contents: read`. A lane that exports the store, such as the code audit, also needs `actions: write`, which only its delete job uses.

## Kanon's AWS implementation

The code is in [`infra/qa-store/aws/`](../infra/qa-store/aws/):

| File | What it is |
|---|---|
| `template.yaml` | The CloudFormation template: the table, the bucket, GitHub's OIDC provider, and the role the store jobs assume. |
| `provision.mjs` | Checks the template, deploys it, protects the stack from termination, and prints its outputs. |
| `action.yml`, `store.sh` | The action your hook calls. It assumes the store's role, then runs the operation. |
| `last-green.sh`, `record-skip.sh` | The Explorer gate's queries and its skip row, moved from the reference adopter. |
| `push-run.sh` | `put`, moved from the reference adopter. It also writes the telemetry rows of the reference adopter's collector, until plan 0002's S7. |
| `cost-rows.mjs` | The dispatch sweep's cost-row query, moved from the library. The sweep's own read calls it too. |
| `export.mjs` | `export`. New: before it, the agents queried the store themselves. |
| `maintenance/action.yml`, `purge-legacy-coverage.sh` | The store's upkeep, moved from the reference adopter, which [`.github/workflows/qa-store-aws-maintenance.yml`](../.github/workflows/qa-store-aws-maintenance.yml) runs. |

### What the template creates

- **The table, `kanon-qa-store`:** on demand, keyed `pk` and `sk`, with point-in-time recovery, deletion protection, and `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.
- **The bucket, `kanon-qa-store-<account>-<region>`:** versioned, private, encrypted with S3's own key, TLS only, and retained like the table.
- **The role, `kanon-qa-store`:** trusted for exactly the subjects passed as the `Subjects` parameter, each `<prefix>:ref:refs/heads/<default branch>` ([Who can reach the store](#who-can-reach-the-store)), never a pattern. It may put and get objects, list the bucket, put, update, get and query items, and delete items only in the `COVERAGE` partition, the one a sweep re-derives. Listing the bucket is what makes S3 answer a missing report with 404, which an export leaves out, rather than 403, which fails it.
- **GitHub's OIDC provider,** unless the account has one.

**No stage in its lifecycle** (`K-OBS-17`). Nothing in the stack is named for, conditioned on or parameterised by an application stage, and deleting the stack leaves the table and the bucket with their data. `provision.mjs` refuses a template that breaks this, and so does the unit test that parses it.

### Provision a store

The commands are the account owner's to run. Nothing costs anything until they do.

From a Kanon checkout at the release you pin, after `npm ci`:

```sh
node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> --profile <profile> --dry-run
node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> --profile <profile>
```

It needs `gh`, signed in with read access to the repository: it reads the default branch and the subject prefix from GitHub's API and prints the subject it will trust. A repository with a custom subject template (`use_default: false`) is refused, because its subject is not a branch ref; pass the exact subject with `--subject` instead. `--subject` may be repeated, to trust both prefix forms while a repository moves between them. The script reads the default branch from the API even then, and refuses a subject on any other branch: trusting another branch would let anyone who can push to it reach the store. Re-running it on an existing stack replaces the trust in place: an older stack that trusted the `kanon-qa-store` environment trusts the default branch's ref instead, and the environment can then be deleted.

Pass `--no-oidc-provider` if `aws iam list-open-id-connect-providers` already lists `token.actions.githubusercontent.com`. Put the store in the reference environment's account (`K-OBS-17`). The last command prints the stack's outputs, `RoleArn`, `TableName` and `BucketName`. Store the two that name your account as repository variables, which the hook reads, never in a committed file:

```sh
gh variable set QA_STORE_ROLE_ARN --body '<RoleArn>' -R <owner>/<repo>
gh variable set QA_STORE_BUCKET --body '<BucketName>' -R <owner>/<repo>
```

Then write the hook, with the table and the region in it:

<!-- x-release-please-start-version -->

```yaml
name: QA store
description: The QA store hook (Kanon plan 0004).
inputs:
  operation: { required: true }
  kind: { required: false, default: "" }
  dir: { required: true }
  from: { required: false, default: "" }
  to: { required: false, default: "" }
  variables: { required: false, default: "" }
runs:
  using: composite
  steps:
    - uses: yedeya-labs/kanon/infra/qa-store/aws@v0.34.0
      with:
        operation: ${{ inputs.operation }}
        kind: ${{ inputs.kind }}
        dir: ${{ inputs.dir }}
        from: ${{ inputs.from }}
        to: ${{ inputs.to }}
        role-arn: ${{ fromJSON(inputs.variables || '{}').QA_STORE_ROLE_ARN }}
        region: <region>
        table: <TableName>
        bucket: ${{ fromJSON(inputs.variables || '{}').QA_STORE_BUCKET }}
```

With either variable unset the AWS action has no role or no bucket, and fails: a read is then `degraded` and a write fails its job.

<!-- x-release-please-end -->

**An existing store** of the same item model works the same way: name its table, bucket, region and role. Its role must trust the default branch's ref subject, `<prefix>:ref:refs/heads/<default branch>` with the prefix GitHub's API reports, and hold the template's grants, `s3:ListBucket` on the bucket included: without it, one run whose raw report is missing fails the whole export.

**To delete the store,** delete the stack, then turn off the table's deletion protection and delete the table and the bucket by hand. The stack never takes the data with it.

### Maintenance

The upkeep runs from a caller of yours, by dispatch only, and is a dry run unless you tick `apply`. Dispatch it on the default branch: the store's role refuses a run of any other ref.

<!-- x-release-please-start-version -->

```yaml
name: QA store maintenance
on:
  workflow_dispatch:
    inputs:
      task: { type: choice, options: [purge-legacy-coverage], default: purge-legacy-coverage }
      apply: { type: boolean, default: false }
permissions:
  id-token: write
jobs:
  maintenance:
    uses: yedeya-labs/kanon/.github/workflows/qa-store-aws-maintenance.yml@v0.34.0
    with:
      task: ${{ inputs.task }}
      apply: ${{ inputs.apply }}
      role-arn: ${{ vars.QA_STORE_ROLE_ARN }}
      region: <region>
      table: <TableName>
```

<!-- x-release-please-end -->

`purge-legacy-coverage` deletes `COVERAGE` rows whose key carries a prefix an earlier store writer used. A new store has none, so it reports itself clean.

### Cost and paging

On-demand DynamoDB and S3 at the lanes' volume: a few thousand writes and reads a month, and a few megabytes stored. That is well under $0.05 a month. The template creates nothing that bills while idle: no compute, no network, no customer-managed key and no alarm. Its unit test fails if any other resource type appears.

**No alarm** (`K-OBS-4`). A failed write turns the store job red, and that red run is the page. A degraded read says so in the run's summary and fails open.
