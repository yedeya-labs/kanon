# The hosted telemetry store

The store that [plan 0002](plans/0002-hosted-telemetry-store.md) designs: one DynamoDB table in the `kanon` account in Frankfurt, written only by a validating function behind an IAM-authenticated URL. This page is the Owner's runbook for it. The code is in [`infra/telemetry/`](../infra/telemetry/):

| File | What it is |
|---|---|
| `template.yaml` | The CloudFormation template: the table, the ingest function and its URL, the aggregate function and its URL, their log groups, the GitHub OIDC provider, and the importer and backfill roles. |
| `render.mjs` | Adds each registered repository's writer and reader roles to the template, from the private register and GitHub's API. |
| `function/` | The ingest function (`index.mjs`) and the aggregate function (`aggregate.mjs`), one package with two handlers. `schema.mjs` there is a link to [`actions/agent-telemetry/schema.mjs`](../actions/agent-telemetry/schema.mjs), so the function validates with the same file the lanes use; `scrub.mjs` and `public-words.mjs` are links too, the scrub that schema runs on a finding's text (plan 0006 §4.2). |
| `verify.mjs` | Step S3's checks, run against the deployed store. |
| `erase.mjs` | Deletes one adopter's rows (§10). |
| `aggregate.mjs` | The aggregate (§6, §6.1), run by you: what the aggregate function answers, plus the totals only you see. |
| `import.mjs` | The reference adopter's history import (§7, S5): its transform, dry run and send. |
| `register.example.json` | The register's shape, naming only Kanon. |

The collector that writes to it is [`telemetry-collect.yml`](../.github/workflows/telemetry-collect.yml) ([Collect the rows](#collect-the-rows)).

**What an adopter gets by opting in** ([#41](https://github.com/yedeya-labs/kanon/issues/41), ADR 0007). Kanon notices failures that Kanon caused in your runs, from the same stage and error at several adopters or a failure that starts at a release, and often fixes them before you would have had to report anything ([Kanon's own bugs](#kanons-own-bugs)). You also get cross-adopter cost and reliability baselines, each combining at least three adopters ([The aggregate function](#the-aggregate-function)). What leaves your project is exactly the schema's fixed fields ([`actions/agent-telemetry/schema.mjs`](../actions/agent-telemetry/schema.mjs), plan 0002 §2.1): never code, prompts, text, file paths or usernames. To opt in, answer yes to `kanon init`'s telemetry question, or write the caller in [Collect the rows](#collect-the-rows); to leave, delete it and ask for erasure, which completes within 35 days ([Erase an adopter](#erase-an-adopter)). With telemetry on, you may also opt in to sending the Overseer's and the telemetry Explorer's upstream findings, the ones only Kanon can act on, by your adoption record's `Upstream findings:` choice, `sent` or `sent with evidence`, which `kanon init` asks after telemetry ([plan 0006](plans/0006-upstream-findings.md) §3, [`docs/init.md`](init.md#upstream-findings)): Kanon then hears of its own bugs from your findings without your filing anything. The collector sends them and the ingest function stores them ([Collect the rows](#collect-the-rows), plan 0006 F4); the lanes write them and upload them as `kanon-finding-*` artifacts (plan 0006's F3).

Every AWS command here is the Owner's to run. Agents run none (§5).

## What the template creates

- **The table, `kanon-telemetry`:** on demand, keyed `pk` and `sk`. It has point-in-time recovery, TTL on `expires_at`, deletion protection, and `DeletionPolicy: Retain`, so deleting the stack never deletes it (`K-OBS-17`). Its resource policy denies `PutItem`, `UpdateItem`, `DeleteItem` and `BatchWriteItem` to every principal except the function's role and the Owner's role.
- **The ingest function, `kanon-telemetry-ingest`:** Node 24, 128 MB, no VPC. Its URL has `AuthType: AWS_IAM`. For each row it:
  - validates the row with the schema module, and rejects it with the offending field names if it fails;
  - takes the key from the caller's role, never from the row (a row that sends `pk`, `sk`, `source`, `received_at` or `expires_at` fails validation);
  - checks that `recorded_at` is between 8 days ago and 10 minutes ahead;
  - for an upstream-finding row ([plan 0006](plans/0006-upstream-findings.md) §5, step 4), stores it only from a writer, never the importer or the backfill role, and only when, beyond `validate`, its text passes the scrub's `verify` against the sender's own name hashes (`NAME_HASHES`, below), and no field holds a registered key, checked with the aggregate's `assertNoKey` and, in the text, as a word. A refusal names the field and the rule, such as `evidence (url)`, `evidence (name)` or `evidence (key)`, never the text. A key with no name hashes stores no finding;
  - stamps `received_at`, `expires_at` and `source`, and writes the row with `PutItem`, a finding under `<key>#finding`.

  It takes up to 25 rows a request and 256 KB, and answers per row: 200 when every row is stored, 422 when any is rejected, and 502 when a write fails.
- **Its log group:** 30-day retention. It holds keys and field names, never a value.
- **Its environment** (from `render.mjs`): `WRITER_KEYS`, every registered key, and `NAME_HASHES`, for each key the SHA-256 of each word of its repository's owner and name but Kanon's own vocabulary (the scrub's `KANON_WORDS`), never the words, which a finding's text is checked against (plan 0006 §4.2). Lambda holds a function's environment to 4 KB, so `render.mjs` refuses a register too large for it before any deploy.
- **The aggregate function, `kanon-telemetry-aggregate`** (plan 0002 §6.1, decided by the Owner on 2026-10-07): Node 24, 256 MB, no VPC, the same package as the ingest function. Its URL has `AuthType: AWS_IAM`. A `GET` answers only what may be published ([The aggregate function](#the-aggregate-function)). Its role may `Query` the table and nothing else, and only with exactly the aggregate's projection: `dynamodb:Attributes` lists those attributes, and `dynamodb:Select` must be `SPECIFIC_ATTRIBUTES`, so a request for whole items is refused. Its log group keeps counts only, 30 days.
- **Per registered repository** (from `render.mjs`):
  - `kanon-telemetry-<key>-writer`, trusted only for the repository's default-branch ref, `<prefix>:ref:refs/heads/<default branch>`, which may invoke the URL and nothing else;
  - `kanon-telemetry-<key>-reader`, trusted for the branch refs the register lists, under the same prefix, which may `Query` and `GetItem` only where `dynamodb:LeadingKeys` matches `<key>#*`.

  - for an entry that sets `"aggregate_invoker": true`, `kanon-telemetry-<key>-aggregates`, trusted only for the default-branch ref, like the writer, which may call the aggregate function's URL and nothing else.

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
# prints, per repository: "<owner>/<repo>: writer trusts <subject>; reader trusts <subjects>"
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

Before packaging, read the subjects `render.mjs` printed: each writer's must be `<prefix>:ref:refs/heads/<default branch>`, where the prefix is `repo:<owner>/<repo>` for a repository created before 2026-07-15 and `repo:<owner>@<id>/<repo>@<id>` for one created after. It prints each entry by its repository and never by its key, and a refusal names an entry by its index, so its output can sit in a terminal's scrollback or a log without pairing a key with its repository ([#628](https://github.com/yedeya-labs/kanon/issues/628)). It refuses to render when GitHub doesn't answer for a repository, when a repository customizes its subject template and its entry names no exact subjects, and when an exact subject fails the checks below.

The outputs name the ingest URL and each repository's two roles, and the aggregate function's URL and each invoker role ([The aggregate function](#the-aggregate-function)).

**If the first deploy fails,** the stack rolls back, but the table stays, because it is retained. The next deploy then fails because `kanon-telemetry` already exists. While the table holds no rows, delete the stack, then turn off the table's deletion protection, delete the table, and deploy again.

## Verify

Step S3's falsifiers, and plan 0006 F4's. Deploy with `--verify`, which lets your role assume the writer and reader roles and creates the write probe, and with `--importer`, which lets it assume the importer, so the script can show the importer is refused a finding. This path doesn't touch the OIDC subjects: your role assumes the writer and reader through their second trust statement, which names your role's ARN and exists only while `EnableVerify` is on. So a PASS shows the store and its policies, not that a workflow's token is accepted; that is S4's first collector run (and, for Kanon, S7's). Run the script, then deploy without it, which deletes the probe:

```sh
node infra/telemetry/render.mjs --register "$REG" --out "$OUT" --verify --importer
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
- the probe's `PutItem`, `UpdateItem`, `DeleteItem` and `BatchWriteItem` are each denied, and IAM says the denial came from a resource-based policy ([#101](https://github.com/yedeya-labs/kanon/issues/101));
- a valid `test` finding gets 200 and lands in `<key>#finding` (plan 0006 F4);
- a finding with a URL in its evidence gets 422 naming `evidence (url)`;
- a finding holding the key in its evidence gets 422 naming `evidence (key)`;
- the importer sending a finding gets 422 naming `row_kind (not-allowed)`;
- the aggregate you compute for the key, as `aggregate.mjs` does, is the same before and after the finding is stored;
- a dry run of `erase.mjs` for the key counts the stored finding in `<key>#finding`. It erases nothing; the erasure itself is held by the erase test.

The writer holds no DynamoDB action, so IAM denies its `PutItem` before the table's policy is read. On its own, that check would pass against a table with no resource policy. The probe is allowed every write by its own policy, so only the table's deny can stop it. Its writes aim at `verify-probe#none`, a partition no register holds, and carry an expiry an hour out, so a write that lands (a FAIL) is removed by TTL.

It exits 1 on any FAIL, and never prints a credential, a row or a response body.

## Add a repository

An adopter opts in when it installs Kanon: `kanon init --telemetry`, or a yes to its question, writes the caller below and asks for registration with an issue from Kanon's [telemetry registration template](https://github.com/yedeya-labs/kanon/issues/new?template=telemetry-registration.yml), which names the repository, its default branch and its reader refs ([`docs/init.md`](init.md#telemetry), #428). Telemetry is off without that yes. Until the two variables are set, `kanon init` reports `telemetry.register` and `kanon doctor` reports `telemetry.unconfigured`, neither blocking. Then:

1. Add an entry to the register:

   ```json
   { "key": "<openssl rand -hex 4>", "repository": "<owner>/<repo>", "readers": ["ref:refs/heads/<default branch>"] }
   ```

   `readers` lists the branch refs the adopter's reading jobs run on, usually just the default branch (§3, §6). An environment is refused, and so are a pattern and a repository already in the register. The writer's subject is not listed: `render.mjs` derives it.

   Two optional fields, both off by default, are the adopter's to ask for (§6.1):
   - `"publish_own_figures_as": "<label>"`: the adopter declares its **own** figures publishable, under that label. The aggregate then answers its own lane-and-model figures, labelled as its own and never with its key, and leaves its rows out of every cross-adopter cell, so subtracting one from the other can't recover a figure of fewer than three adopters. The label must match the key's pattern, must not be any key, and must be unique. Without it, the adopter's rows reach the public only in cells with at least three such adopters, and in failure signals as one of the adopters affected.
   - `"aggregate_invoker": true`: creates `kanon-telemetry-<key>-aggregates`, the role a default-branch job of that repository assumes to call the aggregate function. Kanon's own entry sets it for the Explorer's lane.

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
- **sends upstream findings at the level your adoption record declares** ([plan 0006](plans/0006-upstream-findings.md) §3.1 and §5, step 3). The Overseer's and the telemetry Explorer's filing jobs upload them as `kanon-finding-<reporter>-<run id>-<attempt>`, holding `kanon-finding.json`, a list of at most 20 finding rows. Before it sends any, the run reads `docs/qa/adoption.md` from the default branch: `drafted` or `filed here` sends none, `sent` sends each row as codes only, without its evidence or suggested fix, and `sent with evidence` sends each row as the lane built it. So turning the level down stops the text at the next sweep, even for artifacts written before. A record it can't read, or a malformed one, sends no finding and turns the run red. Each row must name its artifact's reporter, run and attempt. A text the scrub still finds something in, with this repository's name as its context, is sent as codes only, with a warning naming the field and the rule.
- **turns red on anything it couldn't send:** an unreadable artifact, a row that fails the schema, a row the store rejects, or a listing that fails. The errors name the artifact and the field, never a value. That red run is the page (§9). The next run re-covers the same span, so nothing is lost by failing.

**Cadence and cost.** The caller schedules it hourly, at minute 40 (§1.2), so 24 runs a day. It touches no database, and nothing it calls scales to zero. On a public repository its Actions minutes are free. On a private one it is about a minute a run. Each run calls the function only when it has rows, once per 25 rows. For Kanon that is at most 720 calls a month, inside Lambda's free tier, plus 2 DynamoDB write units per row. That is inside §9's estimate of about $0.05 a month.

**The caller.** It grants `actions: read` for the runs and artifacts, `contents: read` for the adoption record's upstream-findings level (plan 0006 F4), and `id-token: write` for the writer role. A caller written before F4 lacks `contents: read`, and GitHub refuses to start a called workflow that asks for more than its caller grants, so add it before moving the pin to a release with F4: `kanon doctor` reports it as `caller.grant-missing`. `kanon init --telemetry` writes it as `.github/workflows/telemetry.yml`, byte for byte as below; `tests/unit/kanon-init.test.ts` holds the two to each other. Written by hand, it is a trigger-only workflow. Pin it to the Kanon version every other Kanon reference uses, and pass the two values as repository variables. Neither is a credential: the role can be assumed only by the repository's own default-branch token. The role's ARN still names the account, so the collect job masks the ARN, and the account id on its own, before its first AWS call, and has `configure-aws-credentials` mask the account it assumed: only the masking step's own header prints the ARN, once per run ([#514](https://github.com/yedeya-labs/kanon/issues/514)). Name the caller as you like; the collector finds its own runs from `GITHUB_WORKFLOW_REF`.

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
  contents: read
  id-token: write
jobs:
  collect:
    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v0.38.0
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
- **Kanon's own QA-store jobs**, in every adopter that runs those lanes and in Kanon: the store jobs of explore, the code audit, the Overseer and the dispatch sweep, and the AWS maintenance job. Several run on a schedule, so on the default branch. They declare no environment, since the QA store dropped its own ([#291](https://github.com/yedeya-labs/kanon/pull/291)), so each carries the default branch's ref and is admitted.
- **The Explorer's telemetry mode's `aggregate` job**, in a repository that runs that lane ([The Explorer's lane](#the-explorers-lane)). It holds the grant to assume the aggregate invoker role, on a schedule, so on the default branch.
- **The Overseer's `telemetry` job**, in a repository that maps a telemetry reader role to that lane ([The Overseer's cost view](#the-overseers-cost-view)). It holds the grant to assume the reader role, on the weekly schedule or a dispatch, so on the default branch.
- **The adopter's own jobs** that hold it for another cloud, such as a deploy on push to the default branch.

Each can write rows under its own adopter's key that pass the function's validation. None can read, name a partition, or reach another adopter's key. A job without `id-token: write` gets no token to ask with, so the set is exactly the jobs that hold it. What is guarded is that set's size in Kanon's own workflows, not that the collector is its only member: the id-token guard #291 added fails any Kanon job holding `id-token: write` that doesn't run the `qa-store` block or the AWS store's maintenance block alone, or isn't the collector's `collect` job, the telemetry Explorer's `aggregate` job or the Overseer's `telemetry` job in its exact shape (Kanon's path, the masking step, the credentials and the one script, with the upload too for the last two, and nothing beside them). The adopter's own holders are the adopter's to check.

## Erase an adopter

Plan 0002 §10. Deletion is immediate in the table, and complete in backups within 35 days, which is how long point-in-time recovery keeps them.

1. Remove the adopter's entry from the register, and in the same edit its time from install to first review, which sits beside the key (plan 0003). Record the date and the key there, not the repository. Then render, package and deploy. That deletes both roles, so its writes and reads stop at once.
2. Count the rows, then delete them. The script walks `<key>#<lane>` for every lane in the schema's enum, `<key>#work` and `<key>#finding`, so it needs no scan. It runs as your role, which is the one role besides the function's that the table lets delete.

   ```sh
   node infra/telemetry/erase.mjs --key <key> --profile kanon
   node infra/telemetry/erase.mjs --key <key> --profile kanon --apply
   ```


## The aggregate function

Plan 0002 §6 and §6.1, as the Owner decided on 2026-10-07 (#443). From `tag = run` run rows only, never a row past its `expires_at`, it answers:

```json
{
  "computed_at": "2026-10-07T12:00:00.000Z",
  "min_adopters": 3,
  "signal_days": 7,
  "cross_adopter": [{ "lane": "review", "model": "…", "runs": 0, "median_cost_usd": 0, "p90_cost_usd": 0 }],
  "own": [{ "label": "kanon", "cells": [{ "lane": "review", "model": "…", "runs": 0, "median_cost_usd": 0, "p90_cost_usd": 0 }] }],
  "signals": [{ "lane": "review", "reason": "did_not_finish", "failed_stage": "agent", "kanon_error": null, "kanon_version": "0.32.0", "adopters_affected": 1 }]
}
```

- **`cross_adopter`:** one cell per lane and model: the run count, and the median and 90th-percentile cost per run (nearest rank, so always a cost some run had). **A cell comes from the rows of adopters that did not declare their own figures, and is answered only when at least three distinct such adopters contribute to it** (decision 7). A declaring adopter's rows are in `own` only, so the two never overlap. A run with no model or no cost is in no cell.
- **`own`:** for each adopter whose entry sets `publish_own_figures_as`, the same cells from its rows alone, under its label. They are that adopter's figures, not cross-adopter ones.
- **`signals`:** the last 7 days' runs that did not end `ok`, by lane, reason, failed stage, Kanon error and Kanon version, with how many adopters each affected. No cost and no run count.

Nothing names an adopter or carries a key; the function refuses to answer output that holds one. It takes no input, so a caller can't narrow a figure to one adopter, and it answers only a registered invoker role in this account (403 otherwise). A failed read answers 502 and logs only DynamoDB's status.

**You can compute the same thing yourself,** with your role, plus the totals only you see (`notes`: the cells withheld under the threshold, and the runs left out for no model or no cost). The totals cover every adopter, so they never leave you:

```sh
node infra/telemetry/aggregate.mjs --register "$REG" --profile kanon
```

It walks `<key>#<lane>` for every key in the register and every lane in the enum, so it needs no scan. Plan 0003's indicators per complexity band, and the time from install to first review, are not in it yet.

### Deploy the aggregate function

The Owner's to run; agents run none. It costs about a cent a month (plan 0002 decision 10's terms, below).

1. **In the register,** on Kanon's entry, add `"publish_own_figures_as": "kanon"` and `"aggregate_invoker": true`. Any other adopter may ask for either, the same way.
2. **Render, and read what it prints.** Besides each writer and reader, it prints `<owner>/<repo>: aggregate invoker trusts <subject>`, which must be the default-branch ref, like the writer's, and `<owner>/<repo>: own figures publishable as <label>` for each declaring adopter. Check that only the adopters that asked are listed:

   ```sh
   node infra/telemetry/render.mjs --register "$REG" --out "$OUT"
   ```

3. **Package and deploy,** exactly as in [Deploy](#deploy). One package holds both functions.
4. **Read the outputs.** `AggregateUrl` is the function's URL, and `AggregateInvokerRole<id>` the invoker role's ARN; the Explorer's lane takes both ([The Explorer's lane](#the-explorers-lane)):

   ```sh
   aws cloudformation describe-stacks --profile kanon --region eu-central-1 \
     --stack-name kanon-telemetry --query 'Stacks[0].Outputs'
   ```

5. **Call it once yourself.** A direct invoke needs `lambda:InvokeFunction` outside the URL, which only your role holds, and the function answers it. Expect `statusCode` 200, and a body with exactly the keys above:

   ```sh
   aws lambda invoke --profile kanon --region eu-central-1 \
     --function-name kanon-telemetry-aggregate "$OUT/aggregate-check.json"
   node -e 'const r=require(process.argv[1]);console.log(r.statusCode, Object.keys(JSON.parse(r.body)))' "$OUT/aggregate-check.json"
   ```

   A 502 means the read failed: the function's log says `aggregate: failed (Query <status>)`. A 400 there most likely means the role's projection condition refused the request, so compare `dynamodb:Attributes` in the template with `PROJECTION` in `function/aggregate.mjs`.
6. **Check that no one else can call it.** An unsigned request to the URL gets 403 from Lambda:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' "<AggregateUrl>"
   ```

### The Overseer's cost view

The Overseer's weekly token trend and its prompt-cache facts are computed from a repository's own rows (plan 0002 §6; the Owner's decision on [#470](https://github.com/yedeya-labs/kanon/issues/470)). Its lane, `agent-overseer.yml`, has a `telemetry` job, the only one of the lane besides its QA store job that holds `id-token: write`. It assumes the repository's reader role, `kanon-telemetry-<key>-reader`, which the template already creates for every registered repository, trusted for the branch refs its register entry lists and allowed to `Query` only partitions under `<key>#`. It reads each of Kanon's lanes' partitions for the last 14 days, projected to the fields the two reports use, and writes `token-trend.md` and `cache-ttl.md` (`scripts/overseer-telemetry.mjs`, with the reports in `scripts/lib/token-trend.mjs` and `scripts/lib/cache-ttl.mjs`, moved from the reference adopter's two readers of §1.4). Only the two files reach the agent, as an artifact kept one day; no row is printed or handed on. The id-token guard holds the job to its exact steps (`tests/unit/helpers/store-jobs.ts`).

The lane reads the role's ARN from a repository secret its caller maps by name, `KANON_TELEMETRY_READER_ROLE`: the stack's `ReaderRole<key>` output, with the register key's non-alphanumeric characters dropped, as for the writer. It is optional: without it the read is `not configured`, which the audit reports as such and never as a missing store. The Owner reads the output and stores it in the repository without printing it, since it holds the account id:

```sh
aws cloudformation describe-stacks --stack-name kanon-telemetry --profile kanon --region eu-central-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ReaderRole<key>'].OutputValue" --output text \
  | gh secret set KANON_TELEMETRY_READER_ROLE -R <owner>/<repo>
```

then map it in the Overseer's caller, under the job's `secrets:`, once the caller pins a release that declares it: `KANON_TELEMETRY_READER_ROLE: ${{ secrets.KANON_TELEMETRY_READER_ROLE }}`. The job masks the account id and the key in the role's name before any other step names them. A run on a ref the role doesn't trust, such as a dispatch from another branch, reads nothing, and the audit says the read `failed`. On the runtime-version trigger, whose `pull_request_target` token the role refuses, the job doesn't try: the audit says the read was `not run on this trigger` (the Owner's decision on [#499](https://github.com/yedeya-labs/kanon/pull/499)).

**A self-hosted telemetry store** is read the same way. The table and region default to the hosted store's, `kanon-telemetry` in `eu-central-1`. A repository reading its own stack sets two optional repository variables, which are coordinates, not credentials (the Owner's decision on [#499](https://github.com/yedeya-labs/kanon/pull/499)):

```sh
gh variable set KANON_TELEMETRY_TABLE -R <owner>/<repo> --body '<its table>'
gh variable set KANON_TELEMETRY_REGION -R <owner>/<repo> --body '<its region>'
```

The job's first script step resolves them once: a variable that is unset or empty is the hosted store's value. It checks the table against DynamoDB's table-name shape and the region against an AWS region code, and stops the read by name on one that isn't. The credentials step and the read then use that step's resolved values, never the variables themselves.

### The Explorer's lane

The function's one caller is the Explorer's telemetry mode, `agent-explore-telemetry.yml` (plan 0004 step 14, [docs/lanes.md](lanes.md#explore-the-telemetry)). Any repository whose entry sets `aggregate_invoker` can install it. Its `aggregate` job, the only job of the lane that holds `id-token: write`, assumes the invoker role with `aws-actions/configure-aws-credentials`, calls the URL with a SigV4-signed `GET` (`scripts/aggregate-read.mjs`), and refuses an answer with any key the function never answers, or a threshold under three. It hands the checked answer to the agent's job, which holds no credentials, as an artifact kept one day. Like the writer, the invoker role trusts every default-branch job of the repository that holds `id-token: write`, so Kanon's id-token guard holds that job to its exact steps (`tests/unit/helpers/store-jobs.ts`).

The lane reads the URL from a repository variable and the role's ARN from a repository secret, which its caller maps by name (the Owner's decision on [#471](https://github.com/yedeya-labs/kanon/pull/471)). Set them from the outputs above, in the repository that runs the lane:

```sh
gh variable set KANON_AGGREGATE_URL --repo <owner>/<repo> --body "<AggregateUrl>"
gh secret set KANON_AGGREGATE_ROLE --repo <owner>/<repo> --body "<the AggregateInvokerRole<id> output>"
```

The role's ARN holds the account id, which stays out of the public tree and, as a secret, out of the run logs. The lane masks the URL, and the account id on its own, before any other step names them, so only the masking step's own header prints the URL, once per run ([#433](https://github.com/yedeya-labs/kanon/issues/433)).

**Deploy from the release that ships the lane, before any repository's pin reaches it.** The lane's rows carry a new `lane`, `explore-telemetry`, and the ingest function refuses a lane its schema doesn't know: deployed from an earlier release, it answers 422 and the collector turns red. Render, package and deploy from that release's tag, as in [Deploy](#deploy).

## Kanon's own bugs

[#41](https://github.com/yedeya-labs/kanon/issues/41), as the Owner scoped it on 2026-10-07: Kanon notices its own bugs in adopters' runs and files them, before an adopter has to. The detection logic is public, [`scripts/telemetry/kanon-bugs.mjs`](../scripts/telemetry/kanon-bugs.mjs): pure, with no network and no AWS. A private scheduled job in the Owner's operations repository reads the run rows, runs it, and files what it returns. Its configuration, its credentials and everything it files below the threshold stay private.

```sh
node scripts/telemetry/kanon-bugs.mjs --rows <rows.json> [--known <signatures.json>] [--tag test] --json
```

**A signal** is every run that did not end `ok`, grouped by lane, `failed_stage`, `kanon_error`, `reason` and `kanon_version` (the aggregate's signal), with its run count, the number of distinct adopters, first and last seen, and the `api_error_status` codes its runs carried. Only `tag = run` rows are read unless a seeded test asks for `test`, and never a row without a `kanon_version` (an imported one, decision 17). Each signal is classified by plan 0002 §2.6's table, in this order:

| Classification | When |
|---|---|
| `platform` | **Every** run in it carries a platform code: `api_error_status` 429 (rate limits, usage caps) or 5xx, or the reason `model_never_ran` or `no_model_ran` (an unreachable model). A signal that is only partly platform is read as the rest, because a human triages it and a hidden Kanon bug costs more than noise. |
| `kanon` | At **two adopters or more**, or **starting at a release**: absent on the release **each adopter affected** last ran that lane on before (its own, since adopters pin different releases, [#562](https://github.com/yedeya-labs/kanon/issues/562)), on which together they ran it at least `RISE.minRuns` times. Other adopters' runs don't count, so a new adopter whose first runs fail at its hook is `adopter`, not `kanon`. Which release an adopter ran before is a fact about that adopter, so neither the signal nor its issue names one. |
| `adopter` | Everything else: one adopter only, such as a `failed_stage: hook`. |

A signal is **new** when its signature is not in the `--known` list. The signature is a hash of the five identifying fields, never a count, so as the counts grow the job updates the open issue, found by the `kanon:bug-signature` marker in its body, instead of filing another.

**Rising after a release.** A lane whose failure rate on one release exceeds its rate on the release before by `RISE.points` or more, with at least `RISE.minRuns` runs on each, is a rise. The release before is the lane's own: the most recent earlier release on which that lane ran at least `RISE.minRuns` times across its adopters, skipping any it barely ran or never ran, and with none there is no rise (the Owner's decision of 2026-10-10, #569). Runs that failed on a platform code don't count as failures there, so an outage just after a release isn't read as a regression. `RISE` is one exported constant: **ten percentage points over at least twenty runs per release**, the same minimum gating "starts at a release", as the Owner decided on 2026-10-07 (#554), to be revisited once three adopters send rows.

**Public or private.** A signal is `public` only when at least three distinct adopters contributed to it: the aggregate's three-adopter rule (#449, plan 0002 decision 7), imported from [`aggregate.mjs`](../infra/telemetry/function/aggregate.mjs), never restated. A rise is `public` only when both of its rates combine three adopters. Everything else is `private`, filed only in the Owner's private repository. Signals at any number of adopters are detected; public filing stays inert until three adopters send rows.

**What an issue holds.** Counts, Kanon's codes, Kanon versions, dates to the day, and the number of adopters. Never an adopter key, a repository, a run id, a login or a path. That is structural: a row's lane, stage, error, reason and outcome are read only when they are in the schema's closed lists, and its version only when it matches the schema's pattern, so a row with anything else is skipped and counted, and every string in a signal is one of Kanon's codes, a version or a time. The output is also checked against every adopter key the input held, and refused whole if one appears. `tests/unit/kanon-bugs.test.ts` proves it with rows that carry keys, a repository, a login, paths and run ids.

### Upstream findings, filed privately beside the signals

[Plan 0006](plans/0006-upstream-findings.md) §6 (step F5). The same private job also reads the finding rows (`<key>#finding`) and runs [`scripts/telemetry/kanon-findings.mjs`](../scripts/telemetry/kanon-findings.mjs), which is pure like `kanon-bugs.mjs`: rows in, a plan of private issues out.

```sh
node scripts/telemetry/kanon-findings.mjs --rows <run and finding rows> [--known <signatures.json>] [--tag test] \
  --trees <trees.json> --register <register.json> --json
```

- **One issue per signature.** It runs `detect` over the run rows, unchanged, and groups the findings by the signals' own `signature()` (§2.4). A finding with a signal's signature goes on that signal's issue, below its counts, so the job updates the one issue and files no second. Every later finding with the signature is one more entry on it. A finding with no signal gets an issue of its own, with a title built from its codes. Each issue is labelled `kanon-bug` and `finding`, plus the signal's class label (`platform` or `adopter`) when it has one.
- **The gate.** Each finding is checked again at the release the job pins:
  - `validate`;
  - the scrub's `verify` on its text, with that key's name hashes (from the register, as `render.mjs` builds them for intake) and the release's tree;
  - an adopter key, as a field's value or as a word in it;
  - each `kanon_paths` entry against the file list of its `kanon_version`.

  A finding that fails is still filed privately, marked `gate: failed` with the field and rule, and labelled `gate-failed`. Its text, and any path outside the tree, are left out of the issue.
- **The tree.** `--trees` maps each release to its file list, as `git ls-tree -r --name-only v<version>` prints it from a Kanon clone. A release with no list, `dev` included, fails any finding of it that carries a path or a text.
- **What leaves.** Signals and rises come out exactly as `kanon-bugs.mjs` returns them, so a public issue never holds a finding. The evidence and suggested fix appear only in the private issue, and only for a finding that passed the gate. The whole output is checked for every key in the rows and the register, as a value and as a word, and refused whole if one appears. `tests/unit/kanon-findings.test.ts` proves each check.

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
- two functions, ingest and aggregate, with no schedule, no VPC and no NAT;
- two log groups kept 30 days;
- IAM roles and the OIDC provider, which are free.

The aggregate function adds about a cent a month (§6.1): a weekly call reads every run row in full, because DynamoDB bills a projected query by the size of the items it reads, which at §9's 52,000 held rows is about 9,000 read units a call. Its compute stays inside the free tier.

The test that parses the template fails if any other resource type appears. The one addition is the artifacts bucket, a few kilobytes, which costs nothing measurable.

**No alarm** (`K-OBS-4`). A rejected or failed write turns the collector red, and that red run is the page. A collector that stops running is not paged, as the reference adopter decided.
