# The hosted telemetry store

The store that [plan 0002](plans/0002-hosted-telemetry-store.md) designs: one DynamoDB table in the `kanon` account in Frankfurt, written only by a validating function behind an IAM-authenticated URL. This page is the Owner's runbook for it. The code is in [`infra/telemetry/`](../infra/telemetry/):

| File | What it is |
|---|---|
| `template.yaml` | The CloudFormation template: the table, the ingest function and its URL, its log group, the GitHub OIDC provider, and the importer and backfill roles. |
| `render.mjs` | Adds each registered repository's writer and reader roles to the template, from the private register. |
| `function/` | The ingest function. `schema.mjs` there is a link to [`actions/agent-telemetry/schema.mjs`](../actions/agent-telemetry/schema.mjs), so the function validates with the same file the lanes use. |
| `verify.mjs` | Step S3's checks, run against the deployed store. |
| `erase.mjs` | Deletes one adopter's rows (§10). |
| `register.example.json` | The register's shape, naming only Kanon. |

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
  - `kanon-telemetry-<key>-writer`, trusted only for `repo:<owner>/<repo>:environment:kanon-telemetry`, which may invoke the URL and nothing else;
  - `kanon-telemetry-<key>-reader`, trusted for the subjects the register lists, which may `Query` and `GetItem` only where `dynamodb:LeadingKeys` matches `<key>#*`.
- **Behind parameters, all off by default:**
  - `EnableImporter`: the importer role (§7, S5);
  - `EnableBackfill`: the backfill role (S7a);
  - `EnableVerify`: lets the Owner assume the writer and reader roles, and creates `kanon-telemetry-verify-probe`, which only the Owner can assume and whose own policy allows the four writes the table denies. Both are for `verify.mjs`.

  `CreateOidcProvider` creates GitHub's OIDC provider, so set it to false if the account already has one.

## Before the first deploy

Run these once, from a Kanon checkout at the release tag being deployed, after `npm ci`.

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

The outputs name the URL and each repository's two roles.

**If the first deploy fails,** the stack rolls back, but the table stays, because it is retained. The next deploy then fails because `kanon-telemetry` already exists. While the table holds no rows, delete the stack, then turn off the table's deletion protection, delete the table, and deploy again.

## Verify

Step S3's falsifiers. Deploy with `--verify`, which lets your role assume the writer and reader roles and creates the write probe. Run the script, then deploy without it, which deletes the probe:

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

1. Add an entry to the register:

   ```json
   { "key": "<openssl rand -hex 4>", "repository": "<owner>/<repo>", "readers": ["ref:refs/heads/main", "environment:<name>"] }
   ```

   `readers` lists the OIDC subjects the adopter's reading jobs run as: its default branch, plus each environment those jobs declare (§3, §6). A pattern is refused, and so is a repository already in the register.
2. Render, package and deploy, as above.
3. In the repository, create the `kanon-telemetry` environment and restrict it to the default branch. Only the collector job declares it (`K-OBS-13`). The writer role's ARN is in the stack's outputs.

A renamed repository fails closed: its `sub` stops matching, the collector turns red, and the register needs the new name.

## Erase an adopter

Plan 0002 §10. Deletion is immediate in the table, and complete in backups within 35 days, which is how long point-in-time recovery keeps them.

1. Remove the adopter's entry from the register, then render, package and deploy. That deletes both roles, so its writes and reads stop at once.
2. Count the rows, then delete them. The script walks `<key>#<lane>` for every lane in the schema's enum and `<key>#work`, so it needs no scan. It runs as your role, which is the one role besides the function's that the table lets delete.

   ```sh
   node infra/telemetry/erase.mjs --key <key> --profile kanon
   node infra/telemetry/erase.mjs --key <key> --profile kanon --apply
   ```

3. Remove the key's time from install to first review from the register, and record the date and the key there, not the repository.

## The importer and the backfill role

These roles are created only for their step and deleted after it (§7). Add `--importer` (S5) or `--backfill` (S7a) to `render.mjs`, package and deploy, and the function accepts that role. Such a caller names the adopter's key as `?key=<key>` on the URL, and the key must be in the register:
- the importer may send rows recorded up to 13 months ago;
- the backfill role may send work-item rows only, in the normal window.

When the step is done, render without the flag and deploy again.

## Cost and paging

Plan 0002 §9 estimates about $0.05 a month, under a $1 ceiling watched by the account's budget alert. The template creates nothing outside that estimate:
- on-demand DynamoDB, with the AWS-owned key;
- one function with no schedule, no VPC and no NAT;
- one log group kept 30 days;
- IAM roles and the OIDC provider, which are free.

The test that parses the template fails if any other resource type appears. The one addition is the artifacts bucket, a few kilobytes, which costs nothing measurable.

**No alarm** (`K-OBS-4`). A rejected or failed write turns the collector red, and that red run is the page. A collector that stops running is not paged, as the reference adopter decided.
