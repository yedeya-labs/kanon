# The QA store

The QA store holds what Kanon's store-coupled lanes remember between runs: the Explorer's and the code audit's run rows and raw reports, route coverage, and the code-reading ledger (`K-OBS-17`). It lives in the adopter's own account, and the lanes reach it only through a **contract**: a hook the adopter writes, at a fixed path, with five operations ([plan 0004 §3.2](plans/0004-move-the-remaining-lanes.md#32-the-decision-a-contract-with-hooks-and-aws-as-the-first-implementation)). Kanon ships the first implementation behind it, on AWS. An adopter with no hook gets every lane, without memory.

This page is the contract, then the AWS implementation and its runbook.

## The contract

### The hook

`.github/actions/qa-store/action.yml` is a composite action you write, when you run a store. Kanon's [`qa-store` block](../actions/qa-store/action.yml) calls it with five string inputs:

| Input | What |
|---|---|
| `operation` | `last-green`, `record-skip`, `put`, `export` or `cost-rows` |
| `kind` | `put`: `explorer` or `audit`. `export`: `audit` or `overseer`. `cost-rows`: the telemetry agent whose rows it reads, such as `implementer`. |
| `dir` | A directory the block made for this operation. The hook reads and writes only the files below. |
| `from` | `export` and `cost-rows`: the window's start, a store stamp such as `20260904T120245Z`, exclusive. |
| `to` | `cost-rows`: the window's end, a store stamp, inclusive. Empty means now. |

The block reads the hook from a checkout of the commit the run is for, made without persisted credentials.

### The operations

| Operation | Called by | The hook reads | The hook writes |
|---|---|---|---|
| `last-green` | the Explorer's change gate | nothing | `dir/last-green`: the commit of the newest green full sweep, or nothing |
| `record-skip` | the Explorer's change gate | `dir/skip.json`: `{commit, trigger, tier, reason}` | nothing |
| `put` | the code audit and the Explorer, after the agent | `dir/report.json`: the Explorer's sweep summary (plan 0004 §4) or the audit's report | nothing |
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

### What the block does with the answer

- **A write that fails fails the store job.** That red run is the page (`K-OBS-6`).
- **A read that fails is degraded, and fails open:** `last-green` returns no commit, so the Explorer sweeps; `export` holds only its manifest, saying it is degraded; `cost-rows` holds no rows and an error, so the sweep charges every dispatch. A `last-green` that isn't a bare 40-character SHA, an export that lacks a file or holds a malformed one, and a malformed `cost-rows.json` are degraded too.
- **Without a hook,** every operation says the store is absent, in the job's summary, and does nothing: `last-green` returns no commit, `record-skip` and `put` are skipped, `export` holds only its manifest, and `cost-rows` holds no rows and the error `the QA store is absent`, on which the dispatch sweep reads run artifacts instead ([plan 0004 §3.3](plans/0004-move-the-remaining-lanes.md#33-the-dispatch-sweep-reads-the-store-and-run-artifacts-without-one)).

### Store jobs

Every store operation runs in a job of its own, which holds the store's credentials and does nothing else. No agent job holds them:

- **A store job** declares the `kanon-qa-store` environment, and an explicit `permissions:` with `id-token: write`. That environment is the one OIDC subject the store's role trusts, so a job under any other name gets no credentials.
- **The agent job** declares an explicit `permissions:` without `id-token`, and no `environment:`. It still grants every read its telemetry step makes with the workflow token. It reads the store through the export, which it downloads as an artifact.
- **The export's delete job** deletes that artifact after the agent job, whatever happened to it: `if: always()`, `needs:` the export job and the agent job, and `actions: write` granted to it alone. The export is kept one day at most.

`tests/unit/helpers/store-jobs.ts` checks this shape, and each store-coupled lane's test applies it to the lane.

### Setting it up

1. **Create the `kanon-qa-store` environment** in the repository. Restrict it to the default branch: then a dispatch from any other branch can't reach the store.
2. **Write the hook.** For Kanon's AWS store it is one call of Kanon's AWS action (below). For any other store, implement the five operations on the files above.
3. **Grant `id-token: write` and `contents: read` in the caller** of each store-coupled lane. Kanon's lane uses `id-token` only in its store jobs, and their checkout needs `contents: read`.

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
- **The role, `kanon-qa-store`:** trusted for exactly `repo:<owner>/<repo>:environment:kanon-qa-store`. It may put and get objects, list the bucket, put, update, get and query items, and delete items only in the `COVERAGE` partition, the one a sweep re-derives. Listing the bucket is what makes S3 answer a missing report with 404, which an export leaves out, rather than 403, which fails it.
- **GitHub's OIDC provider,** unless the account has one.

**No stage in its lifecycle** (`K-OBS-17`). Nothing in the stack is named for, conditioned on or parameterised by an application stage, and deleting the stack leaves the table and the bucket with their data. `provision.mjs` refuses a template that breaks this, and so does the unit test that parses it.

### Provision a store

The commands are the account owner's to run. Nothing costs anything until they do.

From a Kanon checkout at the release you pin, after `npm ci`:

```sh
node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> --profile <profile> --dry-run
node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> --profile <profile>
```

Pass `--no-oidc-provider` if `aws iam list-open-id-connect-providers` already lists `token.actions.githubusercontent.com`. Put the store in the reference environment's account (`K-OBS-17`). The last command prints the stack's outputs, `RoleArn`, `TableName` and `BucketName`, which the hook names:

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
runs:
  using: composite
  steps:
    - uses: yedeya-labs/kanon/infra/qa-store/aws@v0.24.0
      with:
        operation: ${{ inputs.operation }}
        kind: ${{ inputs.kind }}
        dir: ${{ inputs.dir }}
        from: ${{ inputs.from }}
        to: ${{ inputs.to }}
        role-arn: <RoleArn>
        region: <region>
        table: <TableName>
        bucket: <BucketName>
```

<!-- x-release-please-end -->

**An existing store** of the same item model works the same way: name its table, bucket, region and role. Its role must trust `repo:<owner>/<repo>:environment:kanon-qa-store`, and hold the template's grants, `s3:ListBucket` on the bucket included: without it, one run whose raw report is missing fails the whole export.

**To delete the store,** delete the stack, then turn off the table's deletion protection and delete the table and the bucket by hand. The stack never takes the data with it.

### Maintenance

The upkeep runs from a caller of yours, by dispatch only, and is a dry run unless you tick `apply`:

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
    uses: yedeya-labs/kanon/.github/workflows/qa-store-aws-maintenance.yml@v0.24.0
    with:
      task: ${{ inputs.task }}
      apply: ${{ inputs.apply }}
      role-arn: <RoleArn>
      region: <region>
      table: <TableName>
```

<!-- x-release-please-end -->

`purge-legacy-coverage` deletes `COVERAGE` rows whose key carries a prefix an earlier store writer used. A new store has none, so it reports itself clean.

### Cost and paging

On-demand DynamoDB and S3 at the lanes' volume: a few thousand writes and reads a month, and a few megabytes stored. That is well under $0.05 a month. The template creates nothing that bills while idle: no compute, no network, no customer-managed key and no alarm. Its unit test fails if any other resource type appears.

**No alarm** (`K-OBS-4`). A failed write turns the store job red, and that red run is the page. A degraded read says so in the run's summary and fails open.
