# The hosted telemetry store

The store that [plan 0002](plans/0002-hosted-telemetry-store.md) designs: one DynamoDB table in the `kanon` account in Frankfurt, written only by a validating function behind an IAM-authenticated URL. This page is the Owner's runbook for it. The code is in [`infra/telemetry/`](../infra/telemetry/):

| File | What it is |
|---|---|
| `template.yaml` | The CloudFormation template: the table, the ingest function and its URL, its log group, the GitHub OIDC provider, and the importer and backfill roles. |
| `render.mjs` | Adds each registered repository's writer and reader roles to the template, from the private register and GitHub's API. |
| `function/` | The ingest function. `schema.mjs` there is a link to [`actions/agent-telemetry/schema.mjs`](../actions/agent-telemetry/schema.mjs), so the function validates with the same file the lanes use. |
| `verify.mjs` | Step S3's checks, run against the deployed store. |
| `erase.mjs` | Deletes one adopter's rows (§10). |
| `import.mjs` | The reference adopter's history import (§7, S5): its transform, dry run and send. |
| `register.example.json` | The register's shape, naming only Kanon. |

The collector that writes to it is [`telemetry-collect.yml`](../.github/workflows/telemetry-collect.yml) ([Collect the rows](#collect-the-rows)).

Every AWS command here is the Owner's to run. Agents run none (§5).

## What the template creates

- **The table, `kanon-telemetry`:** on demand, keyed `pk` and `sk`. It has point-in-time recovery, TTL on `expires_at`, deletion protection, and `DeletionPolicy: Retain`, so deleting the stack never deletes it (`K-OBS-17`). Its resource policy denies `PutItem`, `UpdateItem`, `DeleteItem` and `BatchWriteItem` to every principal except the function's role and the Owner's role.
- **The ingest function, `kanon-telemetry-ingest`:** Node 24, 128 MB, no VPC. Its URL has `AuthType: AWS_IAM`. For each row it:
  - validates the row with the schema module, and rejects it with the offending field names if it fails;
  - takes the key from the caller's role, never from the row (a row that sends `pk`, `sk`, `source`, `received_at` or `expires_at` fails validation);
  - checks that `recorded_at` is between 8 days ago and 10 minutes ahead;
  - stamps `received_at`, `expires_at` and `source`, and writes the row with `PutItem`.

  It takes up to 25 rows a request and 256 KB, and answers per row: 200 when every row is stored, 422 when any is rejected, and 502 when a write fails.
- **Its log group:** 30-day retention. It holds keys and field names, never a value.
- **Per registered repository** (from `render.mjs`):
  - `kanon-telemetry-<key>-writer`, trusted only for the repository's default-branch ref, `<prefix>:ref:refs/heads/<default branch>`, which may invoke the URL and nothing else;
  - `kanon-telemetry-<key>-reader`, trusted for the branch refs the register lists, under the same prefix, which may `Query` and `GetItem` only where `dynamodb:LeadingKeys` matches `<key>#*`.

  No role trusts a GitHub Environment (the Owner's decision of 2026-10-05). `<prefix>` is what the repository's tokens carry, and `render.mjs` reads it from GitHub's API, with the default branch, every time it runs ([Who can write](#who-can-write)).
- **Behind parameters, all off by default:**
  - `EnableImporter`: the importer role (§7, S5);
  - `EnableBackfill`: the backfill role (S7a);
  - `EnableVerify`: lets the Owner assume the writer and reader roles, and creates `kanon-telemetry-verify-probe`, which only the Owner can assume and whose own policy allows the four writes the table denies. Both are for `verify.mjs`.

  `CreateOidcProvider` creates GitHub's OIDC provider, so set it to false if the account already has one.

## Before the first deploy

Run these once, from a Kanon checkout at the release tag being deployed, after `npm ci`. `render.mjs` calls `gh api` for each registered repository (`repos/<owner>/<repo>` and `repos/<owner>/<repo>/actions/oidc/customization/sub`), so `gh` must be signed in as someone who can read those repositories' Actions settings. These are GitHub calls only; no AWS command runs before the deploy.

1. **Keep the register outside the public tree** (§5). For example, in `~/kanon-private/telemetry/register.json`, copied from `register.example.json`. Generate each key with `openssl rand -hex 4`. The key is opaque: it is what every row and role carries, so it must say nothing about the repository.
2. **Fill in `owner_principal_arn`:** your SSO role's ARN **with its path**. That is the role, not the `assumed-role` session that `sts get-caller-identity` prints:

   ```sh
   aws iam list-roles --profile kanon --path-prefix /aws-reserved/sso.amazonaws.com/ --query 'Roles[].Arn' --output text
   ```

3. **Check for an OIDC provider.** If this prints one for `token.actions.githubusercontent.com`, set `"create_oidc_provider": false`:

   ```sh
   aws iam list-open-id-connect-providers --profile kanon
   ```

4. **Reserved concurrency.** Plan 0002 §4 reserves a concurrency of 2. A new account's concurrency quota is 10, and Lambda can't reserve any concurrency while fewer than 10 would stay unreserved. So the example register sets `"reserved_concurrency": 0`, which means no reservation. The account's own quota of 10 still bounds the function. The quota increase is free. Once it is granted, set the value to 2 and redeploy:

   ```sh
   aws lambda get-account-settings --profile kanon --region eu-central-1 --query AccountLimit
   aws service-quotas request-service-quota-increase --profile kanon --region eu-central-1 \
     --service-code lambda --quota-code L-B99A9384 --desired-value 1000
   ```

5. **Create a bucket for the packaged function.** `aws cloudformation package` uploads the function's zip, a few kilobytes, to S3:

   ```sh
   aws s3api create-bucket --profile kanon --region eu-central-1 --bucket <artifacts bucket> \
     --create-bucket-configuration LocationConstraint=eu-central-1
   ```

## Deploy

`$REG` is the register, and `$OUT` is a directory beside it. The rendered files hold the register's contents, so they stay outside the public tree too.

```sh
REG=$HOME/kanon-private/telemetry/register.json
OUT=$HOME/kanon-private/telemetry/build

node infra/telemetry/render.mjs --register "$REG" --out "$OUT"
# prints, per key: "<key>: writer trusts <subject>; reader trusts <subjects>"
aws cloudformation package --profile kanon --region eu-central-1 \
  --template-file "$OUT/template.json" --s3-bucket <artifacts bucket> \
  --use-json --output-template-file "$OUT/packaged.json"
aws cloudformation deploy --profile kanon --region eu-central-1 \
  --stack-name kanon-telemetry --template-file "$OUT/packaged.json" \
  --parameter-overrides "file://$OUT/parameters.json" \
  --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-stacks --profile kanon --region eu-central-1 \
  --stack-name kanon-telemetry --query 'Stacks[0].Outputs'
```

Before packaging, read the subjects `render.mjs` printed: each writer's must be `<prefix>:ref:refs/heads/<default branch>`, where the prefix is `repo:<owner>/<repo>` for a repository created before 2026-07-15 and `repo:<owner>@<id>/<repo>@<id>` for one created after. It refuses to render when GitHub doesn't answer for a repository, when a repository customizes its subject template and its entry names no exact subjects, and when an exact subject fails the checks below.

The outputs name the URL and each repository's two roles.

**If the first deploy fails,** the stack rolls back, but the table stays, because it is retained. The next deploy then fails because `kanon-telemetry` already exists. While the table holds no rows, delete the stack, then turn off the table's deletion protection, delete the table, and deploy again.

## Verify

Step S3's falsifiers. Deploy with `--verify`, which lets your role assume the writer and reader roles and creates the write probe. This path doesn't touch the OIDC subjects: your role assumes the writer and reader through their second trust statement, which names your role's ARN and exists only while `EnableVerify` is on. So a PASS shows the store and its policies, not that a workflow's token is accepted; that is S4's first collector run (and, for Kanon, S7's). Run the script, then deploy without it, which deletes the probe:

```sh
node infra/telemetry/render.mjs --register "$REG" --out "$OUT" --verify
# package and deploy, as above
node infra/telemetry/verify.mjs --key <Kanon's key> --profile kanon
node infra/telemetry/render.mjs --register "$REG" --out "$OUT"
# package and deploy, as above
```

It sends `tag: test` rows, which expire in 30 days, and prints PASS or FAIL for each check:
- a valid row gets 200;
- a row with an extra field gets 422 naming that field;
- a row naming a partition gets 422;
- the reader querying another key gets `AccessDeniedException`;
- a direct `PutItem` with the writer role is denied;
- the stored row's `expires_at` is 30 days out;
- the probe's `PutItem`, `UpdateItem`, `DeleteItem` and `BatchWriteItem` are each denied, and IAM says the denial came from a resource-based policy ([#101](https://github.com/yedeya-labs/kanon/issues/101)).

The writer holds no DynamoDB action, so IAM denies its `PutItem` before the table's policy is read. On its own, that check would pass against a table with no resource policy. The probe is allowed every write by its own policy, so only the table's deny can stop it. Its writes aim at `verify-probe#none`, a partition no register holds, and carry an expiry an hour out, so a write that lands (a FAIL) is removed by TTL.

It exits 1 on any FAIL, and never prints a credential, a row or a response body.

## Add a repository

An adopter opts in when it installs Kanon: `kanon init --telemetry`, or a yes to its question, writes the caller below and asks for registration with an issue from Kanon's [telemetry registration template](https://github.com/yedeya-labs/kanon/issues/new?template=telemetry-registration.yml), which names the repository, its default branch and its reader refs ([`docs/init.md`](init.md#telemetry), #428). Telemetry is off without that yes. Until the two variables are set, `kanon init` reports `telemetry.register` and `kanon doctor` reports `telemetry.unconfigured`, neither blocking. Then:

1. Add an entry to the register:

   ```json
   { "key": "<openssl rand -hex 4>", "repository": "<owner>/<repo>", "readers": ["ref:refs/heads/<default branch>"] }
   ```

   `readers` lists the branch refs the adopter's reading jobs run on, usually just the default branch (§3, §6). An environment is refused, and so are a pattern and a repository already in the register. The writer's subject is not listed: `render.mjs` derives it.

   **A repository with a custom OIDC subject template** (`use_default: false`) is refused, because its subject is not `<prefix>:ref:refs/heads/<branch>`. Name its subjects exactly instead, as GitHub issues them:

   ```json
   { "key": "…", "repository": "<owner>/<repo>",
     "writer_subjects": ["<exact subject of the collector job on the default branch>"],
     "reader_subjects": ["<exact subject of each reading job>"] }
   ```

   Each must still be a branch ref subject of that repository with no environment or pull request, and the writer's must name the default branch, which is read from GitHub even then. `writer_subjects` can also list both forms while a repository moves to the immutable subject.
2. Render, package and deploy, as above.
3. In the repository, install the collector ([Collect the rows](#collect-the-rows)). It holds `id-token: write` in its collect job alone (`K-OBS-13`), and declares no environment, because an environment replaces the ref in the token's subject and the writer refuses it. Before the deploy, list the repository's default-branch jobs that already hold `id-token: write`, Kanon's QA-store jobs included. Each of them can assume the writer role (below).

**The time from install to first review** (plan 0003, group 9) goes in the entry once the Owner's aggregate script has computed it, as `"first_review": { "minutes": <n>, "review_recorded_at": "<the review row's recorded_at>" }`, copying `recorded_at` as the row holds it, milliseconds and all. It is kept for 13 months after `review_recorded_at`, then removed (plan 0002 decision 18). `render.mjs` refuses a register that still holds one past that date, naming only the entry's index.

A renamed repository fails closed: its `sub` stops matching, the collector turns red, and the register needs the new name. `render.mjs` refuses an entry whose `repository` differs from the name GitHub reports, a rename or a different case, so the next render says so before a deploy.

## Collect the rows

Plan 0002 S7. The lanes hold no store credentials. Each run uploads its version-2 row as a `kanon-telemetry-<lane>-<run id>-<attempt>` artifact. One job sends the rows on: Kanon's reusable workflow [`telemetry-collect.yml`](../.github/workflows/telemetry-collect.yml), which runs [`scripts/telemetry-collect.mjs`](../scripts/telemetry-collect.mjs). Each run:

- **reaches back to the start of the last run whose collect job succeeded,** and overlaps by at least 90 minutes. However many scheduled runs GitHub drops, the next one covers them. A re-sent row overwrites itself, because the function builds its key from the row.
- **stops at 7 days, or at the repository's artifact retention when that is shorter** (S1a, [#212](https://github.com/yedeya-labs/kanon/issues/212)). The function refuses a row older than 8 days, and an expired artifact is gone. When the last successful run is older than that, the run warns that the rows before it are lost.
- **sends only this repository's own runs' rows.** A fork's run can upload any row under any name, so its artifacts are counted and ignored.
- **checks each row with `validate`, and against its artifact's lane, run and attempt,** then sends the rows 25 to a signed `POST`.
- **turns red on anything it couldn't send:** an unreadable artifact, a row that fails the schema, a row the store rejects, or a listing that fails. The errors name the artifact and the field, never a value. That red run is the page (§9). The next run re-covers the same span, so nothing is lost by failing.

**Cadence and cost.** The caller schedules it hourly, at minute 40 (§1.2), so 24 runs a day. It touches no database, and nothing it calls scales to zero. On a public repository its Actions minutes are free. On a private one it is about a minute a run. Each run calls the function only when it has rows, once per 25 rows. For Kanon that is at most 720 calls a month, inside Lambda's free tier, plus 2 DynamoDB write units per row. That is inside §9's estimate of about $0.05 a month.

**The caller.** `kanon init --telemetry` writes it as `.github/workflows/telemetry.yml`, byte for byte as below; `tests/unit/kanon-init.test.ts` holds the two to each other. Written by hand, it is a trigger-only workflow. Pin it to the Kanon version every other Kanon reference uses, and pass the two values as repository variables. Neither is a credential: the role can be assumed only by the repository's own default-branch token. Name the caller as you like; the collector finds its own runs from `GITHUB_WORKFLOW_REF`.

<!-- x-release-please-start-version -->

```yaml
# Sends this repository's agent-run rows to Kanon's hosted telemetry store (docs/telemetry.md).
# Delete this file to stop; the operator erases what was sent on request.
name: Telemetry
on:
  schedule:
    - cron: "40 * * * *"
  workflow_dispatch:
    inputs:
      window_minutes:
        description: Force an exact sweep span, in minutes. Leave empty to sweep back to the last successful sweep.
        required: false
        default: ""
permissions:
  actions: read
  id-token: write
jobs:
  collect:
    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v0.33.0
    with:
      url: ${{ vars.KANON_TELEMETRY_URL }}
      writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}
      window_minutes: ${{ inputs.window_minutes }}
```

<!-- x-release-please-end -->

Give `window_minutes` no default. Empty means "no operator instruction", and a default would make every scheduled run an override and switch the watermark off. A run with an override never becomes the watermark either: its collect job is named `Collect telemetry rows (window override)`, and the next scheduled sweep still reaches back to the last full one, so a short override can't hide the rows before its span.

**The variables.** The Owner reads them from the stack's outputs. `IngestUrl` is the URL. `WriterRole<key>` is the repository's writer role, with the register key's non-alphanumeric characters dropped (`render.mjs`):

```sh
aws cloudformation describe-stacks --stack-name kanon-telemetry --profile kanon --region eu-central-1 \
  --query 'Stacks[0].Outputs'
gh variable set KANON_TELEMETRY_URL -R <owner>/<repo> --body '<the IngestUrl output>'
gh variable set KANON_TELEMETRY_WRITER_ROLE -R <owner>/<repo> --body '<the WriterRole<key> output>'
```

Until both are set, the collector skips with a warning and stays green.

**The check.** Dispatch the caller on the default branch. The run is green, and its summary says how many rows the store accepted. The rows are under `<key>#<lane>`, and the reader role can query them.

**Kanon's own caller** is [`telemetry.yml`](../.github/workflows/telemetry.yml). It is pinned like Kanon's other callers ([ADR 0011](decisions/0011-kanon-runs-its-own-lanes.md)). It runs hourly at minute 40, from the change after its pin reached v0.27.0, the first release that ships the collector it calls ([#304](https://github.com/yedeya-labs/kanon/issues/304)).

## Who can write

The writer trusts the default branch's ref. What a token's subject is decides whether it is admitted:

| A token from | Subject | Writer |
|---|---|---|
| A schedule, or a dispatch on the default branch | `<prefix>:ref:refs/heads/<default branch>` | admitted |
| A pull request, including `pull_request_target` | `<prefix>:pull_request` | refused |
| Another branch, a tag, the merge queue | that ref | refused |
| A job that declares any environment | `<prefix>:environment:<name>` | refused |
| A fork | no token | refused |
| Any job of a default-branch workflow that holds `id-token: write` | the default branch's ref | **admitted** |

The last row is what the environment used to narrow, and nothing narrows it now: **every default-branch job that holds `id-token: write` can assume the writer.** That includes:
- **Kanon's own QA-store jobs**, in every adopter that runs those lanes and in Kanon: the store jobs of explore, the code audit, the Overseer and the dispatch sweep, and the AWS maintenance job. Several run on a schedule, so on the default branch. While they declare `environment: kanon-qa-store`, their subject names that environment and the writer refuses them; once the QA store drops its environment ([#291](https://github.com/yedeya-labs/kanon/pull/291)), each carries the default branch's ref and is admitted.
- **The adopter's own jobs** that hold it for another cloud, such as a deploy on push to the default branch.

Each can write rows under its own adopter's key that pass the function's validation. None can read, name a partition, or reach another adopter's key. A job without `id-token: write` gets no token to ask with, so the set is exactly the jobs that hold it. What is guarded is that set's size in Kanon's own workflows, not that the collector is its only member: the id-token guard #291 added fails any Kanon job holding `id-token: write` that doesn't run a store block alone or isn't the collector's `collect` job in its exact shape (Kanon's path, the credentials and the collector script, and nothing beside them). The adopter's own holders are the adopter's to check.

## Erase an adopter

Plan 0002 §10. Deletion is immediate in the table, and complete in backups within 35 days, which is how long point-in-time recovery keeps them.

1. Remove the adopter's entry from the register, and in the same edit its time from install to first review, which sits beside the key (plan 0003). Record the date and the key there, not the repository. Then render, package and deploy. That deletes both roles, so its writes and reads stop at once.
2. Count the rows, then delete them. The script walks `<key>#<lane>` for every lane in the schema's enum and `<key>#work`, so it needs no scan. It runs as your role, which is the one role besides the function's that the table lets delete.

   ```sh
   node infra/telemetry/erase.mjs --key <key> --profile kanon
   node infra/telemetry/erase.mjs --key <key> --profile kanon --apply
   ```


## The importer and the backfill role

These roles are created only for their step and deleted after it (§7). Add `--importer` (S5) or `--backfill` (S7a) to `render.mjs`, package and deploy, and the function accepts that role. Such a caller names the adopter's key as `?key=<key>` on the URL, and the key must be in the register:
- the importer may send rows recorded up to 13 months ago, with no `kanon_version` (decision 17);
- the backfill role may send work-item rows only, in the normal window.

When the step is done, render without the flag and deploy again.

**The history import (S5)** reads the reference adopter's `COST#` items from a read-only export, prints its dry run, and with `--apply` sends the rows as the importer:

```sh
aws dynamodb scan --table-name <table> --region us-east-2 --output json \
  --filter-expression 'begins_with(pk, :c)' --expression-attribute-values '{":c":{"S":"COST#"}}' > "$OUT/cost-rows.json"
node infra/telemetry/import.mjs --export "$OUT/cost-rows.json"
node infra/telemetry/import.mjs --export "$OUT/cost-rows.json" --key <key> --apply --profile kanon
```

The export holds the adopter's rows, so it stays beside the register, outside the public tree. The dry run prints counts, field names and enum values only, and exits non-zero while any row stops; plan 0002 §7 lists what stops a row.

## Cost and paging

Plan 0002 §9 estimates about $0.05 a month, under a $1 ceiling watched by the account's budget alert. The template creates nothing outside that estimate:
- on-demand DynamoDB, with the AWS-owned key;
- one function with no schedule, no VPC and no NAT;
- one log group kept 30 days;
- IAM roles and the OIDC provider, which are free.

The test that parses the template fails if any other resource type appears. The one addition is the artifacts bucket, a few kilobytes, which costs nothing measurable.

**No alarm** (`K-OBS-4`). A rejected or failed write turns the collector red, and that red run is the page. A collector that stops running is not paged, as the reference adopter decided.
