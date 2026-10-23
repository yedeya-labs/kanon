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
| `secrets` | The store's two secrets, `QA_STORE_ROLE_ARN` and `QA_STORE_BUCKET`, as JSON. The lane's caller maps them by name, and the lane's store step hands them on. A composite action can't read `secrets` itself, so this is where the hook finds its store's coordinates: read one with `fromJSON(inputs.secrets \|\| '{}').<NAME>`. Keep anything that names your cloud account here, never in the committed hook: the runner masks a secret in every log ([#433](https://github.com/yedeya-labs/kanon/issues/433)). |

The block reads the hook from a checkout of the commit the run is for, made without persisted credentials. It passes no repository variables: through v0.34.1 it also passed every one of them, as `variables`, which every store job's log printed ([#479](https://github.com/yedeya-labs/kanon/issues/479)). A hook that still reads its coordinates there reaches no store; [move them to secrets](#move-the-coordinates-to-secrets).

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
| `token-trend.md`, `cache-ttl.md`, `qa-clusters.md` | your own Overseer inputs, if your hook writes them (plan 0004 §3.2). Where your repository sends telemetry, the Overseer writes the first two itself ([#470](https://github.com/yedeya-labs/kanon/issues/470)), and yours stay only when its read didn't run | `overseer` |

An attribute a row doesn't carry is absent, never `false` or 0. The block leaves out any other file, with a warning, and adds `manifest.json`, which says whether the store was present, absent or degraded, lists the files the export holds, and, in an Overseer export, counts its raw reports as `reports`. A `reports/` directory that holds no report is removed, so the manifest never lists a path the export doesn't contain ([#467](https://github.com/yedeya-labs/kanon/issues/467)).

**No cost rows** (plan 0004 step 13). The telemetry store's per-run cost rows are not in any export. The Overseer reads cost as the week's token trend, `token-trend.md`, and the prompt-cache facts as `cache-ttl.md`, so its agent gets the arithmetic and never the raw rows, which plan 0002 owns (`K-OBS-13`). Since [#470](https://github.com/yedeya-labs/kanon/issues/470) the lane writes both itself, from your own rows in Kanon's hosted telemetry store, where your repository sends telemetry: a workflow on your default branch calls Kanon's collector. From vM it reads them with GitHub's OIDC token, so there is no role or secret to set ([The Overseer's cost view](telemetry.md#the-overseers-cost-view)). A hook that writes them from a store of its own still may: its files pass on whenever that read didn't run. The export's manifest says how the read went, as `telemetry`: `ran`, `not configured`, `not run on this trigger` (the runtime-version trigger, whose `pull_request_target` token the store refuses, so the read isn't tried) or `failed`.

### What the block does with the answer

- **A write that fails fails the store job.** That red run is the page (`K-OBS-6`).
- **A read that fails is degraded, and fails open:** `last-green` returns no commit, so the Explorer sweeps; `export` holds only its manifest, saying it is degraded; `cost-rows` holds no rows and an error, so the sweep charges every dispatch. A `last-green` that isn't a bare 40-character SHA, an export that lacks a file or holds a malformed one, and a malformed `cost-rows.json` are degraded too.
- **`cost-rows` is handed on as the block's `rows` output,** `{rows, error}` as one line of JSON, because the dispatch sweep reads it in a job of its own, with no credentials: its store job outputs each telemetry agent's `rows`. The sweep's step receives each answer as one environment variable, which Linux caps at 131,072 bytes, so an answer over 100,000 bytes (about 1,100 rows, far above a 14-day window's few hundred) is degraded, never truncated.
- **Without a hook,** every operation says the store is absent, in the job's summary, and does nothing: `last-green` returns no commit, `record-skip` and `put` are skipped, `export` holds only its manifest, and `cost-rows` holds no rows and the error `the QA store is absent`, on which the dispatch sweep reads run artifacts instead ([plan 0004 §3.3](plans/0004-move-the-remaining-lanes.md#33-the-dispatch-sweep-reads-the-store-and-run-artifacts-without-one)).

### Store jobs

Every store operation runs in a job of its own, which holds the store's credentials and does nothing else. No agent job holds them:

- **A store job** declares an explicit `permissions:` with `id-token: write`, and no environment. The store's role trusts the default branch's ref (below), and an environment would replace the ref in the job's OIDC subject, so the role would refuse it. Its steps are the `qa-store` block's, and, in a job that `put`s, the `actions/download-artifact` step that fetches the report: nothing else runs with the store's credentials (kanon#225). Neither the job nor a step sets `env:`, which could hand the block a `NODE_OPTIONS`, and the job has no `container:`, `services:` or `defaults:`. Work that reads a store job's answer, such as the Explorer's gate comparing `last-green` with the commit, runs in a job of its own after it, reading its outputs. Besides store jobs and the callers that grant them the token, the only jobs in Kanon's workflows that hold `id-token: write` are the AWS store's maintenance job, the telemetry collector's `collect` job, the telemetry Explorer's `aggregate` job, the Overseer's `telemetry` job and the metrics page's `aggregate` job in `metrics-page.yml`, each held to its exact shape ([telemetry](telemetry.md)). The store's role admits each of them too.
- **The agent job** declares an explicit `permissions:` without `id-token`. It still grants every read its telemetry step makes with the workflow token. It reads the store through the export, which it downloads as an artifact.
- **The export's delete job** deletes that artifact after the agent job, whatever happened to it: `if: always()`, `needs:` the export job and the agent job, and `actions: write` granted to it alone, and runs the block's `delete-export` step and nothing else. The export is kept one day at most.
- **A re-run of the agent job alone has no export** (kanon#224). "Re-run failed jobs" re-runs a failed agent job and the jobs after it, the delete job among them, but not the export job, which succeeded: it reuses the export job's outputs, and the earlier attempt's delete job has already deleted the artifact they name. So the agent job runs only on the export's own attempt, `if: needs.<export>.outputs.attempt == github.run_attempt`, and is skipped on such a re-run rather than run without the store. The delete job is handed the export's `attempt` and the agent job's `result`, and turns that re-run red with the remedy: **re-run all jobs**, which exports again. A re-run of the delete job alone, after an agent job that succeeded, deletes the export and stays green.

`tests/unit/helpers/store-jobs.ts` checks this shape, and each store-coupled lane's test applies it to the lane. `tests/unit/id-token-guard.test.ts` holds every workflow Kanon ships to the last rule: a job that holds `id-token: write`, by its own grant or by inheriting the workflow's, must run the `qa-store` block alone (or the AWS store's maintenance block alone), be the collector's `collect` job, the telemetry Explorer's `aggregate` job, the Overseer's `telemetry` job or the metrics page's `aggregate` job in `metrics-page.yml` in its exact shape, or call a lane that has such a job. Any other fails `npm test` by name.

### Who can reach the store

The store's role trusts, for each repository it serves, that repository's **default branch's ref**, `<prefix>:ref:refs/heads/<default branch>`, by exact match. One store usually serves one repository. It can serve several, and then it trusts each one's default branch and no other ref of any of them ([kanon#1339](https://github.com/yedeya-labs/kanon/issues/1339)). Every repository it serves can then read and write the others' QA data, though its lanes read only their own rows (below), so give one store only repositories that may share it. There is no GitHub Environment. The Owner dropped it on 2026-10-05 (plan 0004, decision 9): an environment's branch restriction needs a paid plan in a private repository, and the environment added a setup step without protecting anything the ref does not. What scopes the store is now which jobs hold `id-token: write`, which the guard above holds: the store jobs, and the few other holders it names.

**Each repository on a store reads and writes only its own rows.** Every row and raw report is keyed by the repository's id, so the Explorer's baseline, the coverage ledger, the area rotation, the cost rows and the export are each repository's own ([Rows by repository](#rows-by-repository)). That is the lanes' doing, not IAM's: the role still lets every repository it trusts reach every row, so share a store only between repositories that may share their QA data. A store written before [kanon#1346](https://github.com/yedeya-labs/kanon/issues/1346) keeps its unkeyed rows until the account owner migrates them ([Upgrade a store written before rows carried the repository](#upgrade-a-store-written-before-rows-carried-the-repository)).

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
- **Every job of yours that already holds `id-token: write` on the default branch is admitted too.** A push-to-main deploy that assumes a role in your cloud, say, holds the grant for its own reasons and runs its build's dependencies. Under the environment trust its subject was refused. Under the ref trust it can assume the store's role, and the store sits in your reference environment's account (`K-OBS-17`). Kanon's guard does not read your workflows. **Before you re-provision, list your default-branch jobs that hold `id-token: write`** (by their own `permissions:` or their workflow's), and accept each one as a holder of the store's credentials, or narrow its grant. [`kanon doctor`](doctor.md#the-id-token-holders) lists them, and you accept one with a bullet in the adoption record (`K-LAYOUT-10`). **On a store that serves several repositories, do this in each of them.** Every one's default-branch holders can assume the store's role, not only those of the repository whose operator runs `provision.mjs`. So list the holders, run `kanon doctor` and write the bullets in each repository's own checkout and adoption record ([kanon#1347](https://github.com/yedeya-labs/kanon/issues/1347)). The store's role can read and write QA data and delete `COVERAGE` rows; it cannot reach anything else in the account.

### Setting it up

1. **Write the hook.** For Kanon's AWS store it is one call of Kanon's AWS action (below), with the role and the bucket read from two repository secrets, so the account id they carry is never committed and never printed. For any other store, implement the five operations on the files above, and keep its account-specific values in the same two secrets.
2. **Map the two secrets in the caller** of each store-coupled lane: `QA_STORE_ROLE_ARN: ${{ secrets.QA_STORE_ROLE_ARN }}` and `QA_STORE_BUCKET: ${{ secrets.QA_STORE_BUCKET }}` under its job's `secrets:`. `kanon init` writes them. A caller of a repository with no store may leave them out.
3. **Grant `id-token: write` and `contents: read` in the caller** of each store-coupled lane. Kanon's lane uses `id-token` only in its store jobs, and in the Overseer's `telemetry` job, which reads your telemetry rows (not the QA store); their checkout needs `contents: read`. A lane that exports the store, such as the code audit, also needs `actions: write`, which only its delete job uses.

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
| `keys.mjs` | The keys every row and raw report carries: the repository's ([Rows by repository](#rows-by-repository)). |
| `migrate-to-repository-keys.mjs` | Copies a store's rows from before [#1346](https://github.com/yedeya-labs/kanon/issues/1346) under one repository's keys, for the account owner to run ([Upgrade a store written before rows carried the repository](#upgrade-a-store-written-before-rows-carried-the-repository)). |
| `maintenance/action.yml`, `purge-legacy-coverage.sh` | The store's upkeep, moved from the reference adopter, which [`.github/workflows/qa-store-aws-maintenance.yml`](../.github/workflows/qa-store-aws-maintenance.yml) runs. |

### What the template creates

- **The table, `kanon-qa-store`:** on demand, keyed `pk` and `sk`, with point-in-time recovery, deletion protection, and `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`. Every `pk` ends in the repository's id ([Rows by repository](#rows-by-repository)).
- **The bucket, `kanon-qa-store-<account>-<region>`:** versioned, private, encrypted with S3's own key, TLS only, and retained like the table. Each raw report is under `repository/<repository id>/`.
- **The role, `kanon-qa-store`:** trusted for exactly the subjects passed as the `Subjects` parameter, each `<prefix>:ref:refs/heads/<default branch>` ([Who can reach the store](#who-can-reach-the-store)), never a pattern. It may put and get objects, list the bucket, put, update, get and query items, and delete items only in the `COVERAGE` partitions, the ones a sweep re-derives: `COVERAGE#<repository id>`, and the unkeyed `COVERAGE` of a store written before rows carried the repository. Listing the bucket is what makes S3 answer a missing report with 404, which an export leaves out, rather than 403, which fails it.
- **GitHub's OIDC provider,** unless the account has one.

**No stage in its lifecycle** (`K-OBS-17`). Nothing in the stack is named for, conditioned on or parameterised by an application stage, and deleting the stack leaves the table and the bucket with their data. `provision.mjs` refuses a template that breaks this, and so does the unit test that parses it.

### Rows by repository

Every row and raw report carries the repository it belongs to ([#1346](https://github.com/yedeya-labs/kanon/issues/1346)), so repositories that share one store read and write only their own: each has its own Explorer baseline, coverage ledger, area rotation, cost rows and export.

| What | Key |
|---|---|
| The Explorer's runs, and the gate's skips | `RUN#explorer#<id>` / `<ts>` |
| The audit's runs | `RUN#audit#<id>` / `<ts>` |
| Route coverage | `COVERAGE#<id>` / `<route>` |
| The code-reading ledger | `AREAS#<id>` / `<area>` |
| Cost rows | `COST#<agent>#<id>` / `<ts>` |
| Raw reports | `repository/<id>/<kind>/<ts>.json`, and `repository/<id>/telemetry/<agent>/<ts>.json` |

`<id>` is the repository's numeric id, which the runner sets in every job as `GITHUB_REPOSITORY_ID`. The id, not the name, because it survives a rename and a transfer: a renamed repository keeps its history, and a repository deleted and created again under the same name starts clean. A store operation without a repository id fails: a write is refused, never written unkeyed, and a read is degraded. Because the repository is in the key, two repositories that `put` the same kind in the same second write two rows and two raw reports, not one over the other ([#1367](https://github.com/yedeya-labs/kanon/issues/1367)).

**The store still trusts every repository it serves with every row.** One role serves all of them, and its `dynamodb:LeadingKeys` condition can name only key patterns, not "the caller's own": the role's session carries no tag naming the repository, and no policy variable for GitHub's repository id has been verified on it. So the keys keep each repository's lanes to their own rows, and IAM does not: a job a store's role admits can still read or write another repository's keys. Give one store only repositories that may share it.

**Rows written before the keys carried the repository** have none: `RUN#explorer`, `RUN#audit`, `COVERAGE`, `AREAS`, `COST#<agent>`, and reports at `<kind>/<ts>.json`. A reader reads them only while the repository has **no row of its own** in that partition, and says so in its log: the gate, while `RUN#explorer#<id>` holds no sweep (nothing, or only a skip it recorded against an unkeyed baseline); the export and `cost-rows`, while the partition holds no row at all, at any time, so an empty window doesn't count. The repository's first row in a partition ends that partition's fallback, so its lanes keep working, with the history they had, from the pin that brings this until the migration below, and read only their own rows after it.

### Provision a store

The commands are the account owner's to run. Nothing costs anything until they do. A new store holds only rows keyed by repository, so it has nothing to migrate.

From a Kanon checkout at the release you pin, after `npm ci`:

```sh
node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> --profile <profile> --dry-run
node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> --profile <profile>
```

It needs `gh`, signed in with read access to each repository you name: it reads each one's default branch and subject prefix from GitHub's API and prints each subject it will trust. To serve several repositories from one store, repeat `--repository`, once for each: the script reads each one's default branch and prefix, and trusts each one's default-branch ref. Each one's lanes then read and write only its own rows, though the role lets each reach the others', as [Who can reach the store](#who-can-reach-the-store) says. With `--subject`, each subject must be the default-branch ref subject of one of the repositories named, at that repository's own default branch. Every repository named must be trusted by at least one subject, so one you named and forgot is refused, not quietly left out. A repository with a custom subject template (`use_default: false`) is refused, because its subject is not a branch ref; pass the exact subject with `--subject` instead. `--subject` may be repeated, to trust both prefix forms while a repository moves between them. The script reads each default branch from the API even then, and refuses a subject on any other branch: trusting another branch would let anyone who can push to it reach the store. Re-running it on an existing stack replaces the trust in place: an older stack that trusted the `kanon-qa-store` environment trusts the default branch's ref instead, and the environment can then be deleted.

Pass `--no-oidc-provider` if `aws iam list-open-id-connect-providers` already lists `token.actions.githubusercontent.com`. Put the store in the reference environment's account (`K-OBS-17`). The last command prints the stack's outputs, `RoleArn`, `TableName` and `BucketName`. Store the two that name your account as repository secrets, which the lanes hand the hook, never in a committed file or a variable. A variable would print in every store job's log, and the account id with it:

```sh
gh secret set QA_STORE_ROLE_ARN --body '<RoleArn>' -R <owner>/<repo>
gh secret set QA_STORE_BUCKET --body '<BucketName>' -R <owner>/<repo>
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
  secrets: { required: false, default: "" }
runs:
  using: composite
  steps:
    # An AWS error names the account in ARNs that are not these secrets, so the runner would not
    # mask it there: register the account id first (kanon#488).
    - name: Mask the store's account id
      shell: bash
      env:
        ROLE_ARN: ${{ fromJSON(inputs.secrets || '{}').QA_STORE_ROLE_ARN }}
        BUCKET: ${{ fromJSON(inputs.secrets || '{}').QA_STORE_BUCKET }}
      run: |
        printf '%s %s' "$ROLE_ARN" "$BUCKET" | grep -oE '[0-9]+' | grep -xE '[0-9]{12}' | sort -u | sed 's/^/::add-mask::/' || true
    - uses: yedeya-labs/kanon/infra/qa-store/aws@v0.42.0
      with:
        operation: ${{ inputs.operation }}
        kind: ${{ inputs.kind }}
        dir: ${{ inputs.dir }}
        from: ${{ inputs.from }}
        to: ${{ inputs.to }}
        role-arn: ${{ fromJSON(inputs.secrets || '{}').QA_STORE_ROLE_ARN }}
        region: <region>
        table: <TableName>
        bucket: ${{ fromJSON(inputs.secrets || '{}').QA_STORE_BUCKET }}
```

The hook reads its coordinates from the secrets alone. Its first step masks your AWS account id on its own: the runner masks each secret as a whole value, but an AWS error, such as an `AccessDenied` from S3 or DynamoDB, names the account inside other ARNs (the assumed role's, the table's), which the runner wouldn't mask ([#488](https://github.com/yedeya-labs/kanon/issues/488)). Kanon's `qa-store` block masks it too, before it runs the hook, and the AWS action asks `configure-aws-credentials` to mask the account it assumed. Keep the step if you write your own hook. With either secret unset, or not mapped by the lane's caller, the AWS action has no role or no bucket, and fails: a read is then `degraded` and a write fails its job.

<!-- x-release-please-end -->

### Move the coordinates to secrets

Kanon v0.33.0 told you to keep `QA_STORE_ROLE_ARN` and `QA_STORE_BUCKET` as repository **variables**, and its lanes passed every repository variable to the hook, so each store job's log printed them, and on a public repository anyone could read your AWS account id there ([#433](https://github.com/yedeya-labs/kanon/issues/433)). v0.34.0 and v0.34.1 took the coordinates as secrets, which the runner masks, and still passed the variables as a fallback. **The release after v0.34.1 passes no variables at all** ([#479](https://github.com/yedeya-labs/kanon/issues/479)): a hook that reads its coordinates from variables reaches no store, so its reads are `degraded` and its writes fail their jobs. The maintenance workflow likewise takes only the secret `QA_STORE_ROLE_ARN`, and GitHub refuses a caller that still passes its old `role-arn` input.

[`kanon doctor`](doctor.md), checking against that release or a later one, blocks on `secret.missing` while a store secret is unset, and its fix copies the variable where one still holds the value. It lists a variable left over once the secret is set as `qa-store.variables`, without blocking. Do steps 1 to 3 before or with the pin that moves past v0.34.1:

1. **Copy each variable into a secret of the same name.** The value goes through a pipe, never onto a command line or into the log.

   ```sh
   gh variable get QA_STORE_ROLE_ARN -R <owner>/<repo> | gh secret set QA_STORE_ROLE_ARN -R <owner>/<repo>
   gh variable get QA_STORE_BUCKET -R <owner>/<repo> | gh secret set QA_STORE_BUCKET -R <owner>/<repo>
   ```

2. **Map both secrets** in the caller of each store-coupled lane you run: the explore lane, the dispatch sweep, the code audit and the Overseer. GitHub refuses a secret the pinned lane doesn't declare, which v0.33.0 doesn't, so map them with a pin of v0.34.0 or later. In the maintenance caller, map `QA_STORE_ROLE_ARN` and drop `role-arn:` from its `with:` ([Maintenance](#maintenance)).

   ```yaml
       secrets:
         QA_STORE_ROLE_ARN: ${{ secrets.QA_STORE_ROLE_ARN }}
         QA_STORE_BUCKET: ${{ secrets.QA_STORE_BUCKET }}
   ```

3. **Make the hook read the secrets alone,** as the template above does: `secrets` among its inputs, `fromJSON(inputs.secrets || '{}').<NAME>` for each coordinate, and no `variables` input.
4. **Delete the variables** once a store job has run green on the secrets. Its log shows `***` where the role and the bucket were.

   ```sh
   gh variable delete QA_STORE_ROLE_ARN -R <owner>/<repo>
   gh variable delete QA_STORE_BUCKET -R <owner>/<repo>
   ```

The logs of runs before the move still hold the old values until GitHub's log retention removes them. Delete those runs if that matters to you.

**An existing store** of the same item model works the same way: name its table, bucket, region and role. Its role must trust the default branch's ref subject, `<prefix>:ref:refs/heads/<default branch>` with the prefix GitHub's API reports, and hold the template's grants, `s3:ListBucket` on the bucket included: without it, one run whose raw report is missing fails the whole export. Its grants must admit the keys of [Rows by repository](#rows-by-repository): a policy that holds writes to the unkeyed partitions by `dynamodb:LeadingKeys`, or objects to the `<kind>/` prefixes, refuses them, and every write fails its job.

**To delete the store,** delete the stack, then turn off the table's deletion protection and delete the table and the bucket by hand. The stack never takes the data with it.

### Upgrade a store written before rows carried the repository

A store that ran a Kanon release before [#1346](https://github.com/yedeya-labs/kanon/issues/1346) holds its history unkeyed. Nothing breaks when the pin moves: each partition is read unkeyed until the repository writes its first row there ([Rows by repository](#rows-by-repository)). But from then on that partition's history before the move is out of the repository's sight, until you copy it under the repository's keys. These steps are the account owner's, with their own credentials:

1. **Update the stack,** so the role may delete in the keyed `COVERAGE` partitions too: re-run `provision.mjs` as in [Provision a store](#provision-a-store), from a checkout of the release you pin. Until you do, only the maintenance purge of a keyed partition fails, with `AccessDenied`.
2. **Move the pin** to that release.
3. **Run the migration as a dry run.** It reads the repository's id from GitHub, scans the table and lists the bucket, and prints, for each unkeyed partition, how many rows it would copy and how many the repository already has, then the raw reports. It writes nothing:

   ```sh
   node infra/qa-store/aws/migrate-to-repository-keys.mjs --repository <owner>/<repo> --region <region> --bucket <BucketName> --table <TableName> --profile <profile>
   ```

4. **Run it again with `--apply`.** It copies each unkeyed row under `<partition>#<id>`, only where the repository has no row at that key (`attribute_not_exists`), so a row a lane wrote since the pin moved, which is newer, stays as the lane wrote it. It copies each raw report to `repository/<id>/`, only where none is there. It deletes nothing, so you can run it again at any time, and a second run copies only what the first did not.

The unkeyed rows and reports stay where they were. Once the repository's lanes read their own, they read none of them, and you may delete them by hand. Until you do, a repository added to the store later reads them as its own, in each partition, until it writes its first row there.

**A store that served several repositories before** holds their unkeyed rows mixed, with nothing to tell them apart. Name the one repository that should keep that history, or migrate none and let each start from its own first row.

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
    uses: yedeya-labs/kanon/.github/workflows/qa-store-aws-maintenance.yml@v0.42.0
    with:
      task: ${{ inputs.task }}
      apply: ${{ inputs.apply }}
      region: <region>
      table: <TableName>
    secrets:
      QA_STORE_ROLE_ARN: ${{ secrets.QA_STORE_ROLE_ARN }}
```

<!-- x-release-please-end -->

`purge-legacy-coverage` deletes `COVERAGE` rows whose key carries a prefix an earlier store writer used, in the calling repository's `COVERAGE#<id>` and in the unkeyed `COVERAGE`. A new store has none, so it reports itself clean.

### Cost and paging

On-demand DynamoDB and S3 at the lanes' volume: a few thousand writes and reads a month, and a few megabytes stored. That is well under $0.05 a month. Keying the rows by repository adds a query or two to a read only when the repository's own window is empty or its partition falls back to its unkeyed rows. The migration is a one-off scan and a write per unkeyed row, a few cents at most, and the copies it leaves double the few megabytes stored until you delete the unkeyed rows. The template creates nothing that bills while idle: no compute, no network, no customer-managed key and no alarm. Its unit test fails if any other resource type appears.

**No alarm** (`K-OBS-4`). A failed write turns the store job red, and that red run is the page. A degraded read says so in the run's summary and fails open.
