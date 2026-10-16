# The hosted telemetry store

The store that [plan 0002](plans/0002-hosted-telemetry-store.md) designs: one DynamoDB table in the `kanon` account in Frankfurt, written only by a validating function behind an IAM-authenticated URL. This page is the Owner's runbook for it. The code is in [`infra/telemetry/`](../infra/telemetry/):

| File | What it is |
|---|---|
| `template.yaml` | The CloudFormation template: the table, the register table (unused until plan 0008's token path), the ingest function and its URL, the aggregate function and its URL, their log groups, the GitHub OIDC provider, and the importer and backfill roles. |
| `render.mjs` | Adds each registered repository's writer and reader roles to the template, from the private register and GitHub's API. |
| `function/` | The ingest function (`index.mjs`) and the aggregate function (`aggregate.mjs`), one package with two handlers. `schema.mjs` there is a link to [`actions/agent-telemetry/schema.mjs`](../actions/agent-telemetry/schema.mjs), so the function validates with the same file the lanes use; `scrub.mjs` and `public-words.mjs` are links too, the scrub that schema runs on a finding's text (plan 0006 §4.2). `oidc.mjs` is plan 0008's token verifier, which nothing calls yet ([The token verifier](#the-token-verifier-plan-0008-j1)). |
| `verify.mjs` | Step S3's checks, run against the deployed store. |
| `intake-first.mjs` | Whether a release's lanes can write a row the deployed ingest function refuses, so intake must be deployed from it first, and whether intake deployed from it would refuse a row an older pin writes ([`docs/release.md`](release.md#intake-first)). |
| `erase.mjs` | Deletes one adopter's rows (§10). |
| `aggregate.mjs` | The aggregate (§6, §6.1), run by you: what the aggregate function answers, plus the totals only you see. |
| `import.mjs` | The reference adopter's history import (§7, S5): its transform, dry run and send. |
| `backfill.mjs` | The work-item backfill ([plan 0003](plans/0003-metrics.md) M5, §7 S7a): M5's check as a dry run, and the send as the backfill role. |
| `register.example.json` | The register's shape, naming only Kanon. |
| `register.mjs` | Your CLI for the register table of [plan 0008](plans/0008-self-service-registration.md) §5: `list`, `suspend`, `resume`, `set`, `erase` and `import` ([The register table](#the-register-table)). Nothing else uses the table yet. |

The collector that writes to it is [`telemetry-collect.yml`](../.github/workflows/telemetry-collect.yml) ([Collect the rows](#collect-the-rows)). From vM it sends with GitHub's OIDC token to the token path's endpoints ([The token path's endpoints](#the-token-paths-endpoints-plan-0008-j3)); the SigV4 path, the writer roles and `render.mjs` stay beside it for one release, for callers still pinned below vM and the Owner's importer and backfill role, and go at vM+1 (plan 0008 §9, J9).

**What an adopter gets by opting in** ([#41](https://github.com/yedeya-labs/kanon/issues/41), ADR 0007). Kanon notices failures that Kanon caused in your runs, from the same stage and error at several adopters or a failure that starts at a release, and often fixes them before you would have had to report anything ([Kanon's own bugs](#kanons-own-bugs)). You also get cross-adopter cost and reliability baselines, each combining at least three adopters ([The aggregate function](#the-aggregate-function)). What leaves your project is exactly the schema's fixed fields ([`actions/agent-telemetry/schema.mjs`](../actions/agent-telemetry/schema.mjs), plan 0002 §2.1): never code, prompts, text, file paths or usernames, except that upstream findings, which you opt into on their own below, add Kanon's own file paths and, at `sent with evidence`, each finding's evidence and suggested fix, as scrubbed text. To opt in, answer yes to `kanon init`'s telemetry question, or write the caller in [Collect the rows](#collect-the-rows): from the release that ships [plan 0008](plans/0008-self-service-registration.md)'s token path (its vM), the caller's first run registers the repository, with no issue, no variable and nothing for the operator to do. To leave, delete the caller; to erase what was sent, first dispatch it with `erase: yes`, an erasure, which completes within 35 days ([Erase an adopter](#erase-an-adopter), [`docs/sharing.md`](sharing.md#stop-and-erase)). With telemetry on, you may also opt in to sending the Overseer's and the telemetry Explorer's upstream findings, the ones only Kanon can act on, by your adoption record's `Upstream findings:` choice, `sent` or `sent with evidence`, which `kanon init` asks after telemetry ([plan 0006](plans/0006-upstream-findings.md) §3, [`docs/init.md`](init.md#upstream-findings)): Kanon then hears of its own bugs from your findings without your filing anything. The collector sends them and the ingest function stores them ([Collect the rows](#collect-the-rows), plan 0006 F4); the lanes write them and upload them as `kanon-finding-*` artifacts (plan 0006's F3).

Every AWS command here is the Owner's to run. Agents run none (§5).

## What the template creates

- **The table, `kanon-telemetry`:** on demand, keyed `pk` and `sk`. It has point-in-time recovery, TTL on `expires_at`, deletion protection, and `DeletionPolicy: Retain`, so deleting the stack never deletes it (`K-OBS-17`). Its resource policy denies `PutItem`, `UpdateItem`, `DeleteItem` and `BatchWriteItem` to every principal except three: the function's role, the Owner's role, and `kanon-telemetry-self-read`, which only the function assumes, for the erasure walk's deletes under a session held to one key (plan 0008 J3).
- **The register table, `kanon-telemetry-register`** ([plan 0008](plans/0008-self-service-registration.md) §5): KMS-encrypted, retained and deletion-protected, with point-in-time recovery. The ingest function reads it on both of its paths, and writes registrations, erasures and quota counters on the token path; you write the operator's fields with `register.mjs` ([The register table](#the-register-table)).
- **The ingest function, `kanon-telemetry-ingest`:** Node 24, 128 MB, no VPC. Its unqualified URL has `AuthType: AWS_IAM`, and its `live` alias has a second, public URL for the token path ([The token path's endpoints](#the-token-paths-endpoints-plan-0008-j3)). For each row it:
  - validates the row with the schema module, and rejects it with the offending field names if it fails;
  - takes the key from the caller's role, never from the row (a row that sends `pk`, `sk`, `source`, `received_at` or `expires_at` fails validation), and refuses it unless the register table holds an `active` registration under that key: 403 `suspended` for a suspended one, 410 `erased` for an erased one;
  - checks that `recorded_at` is between 8 days ago and 10 minutes ahead;
  - for an upstream-finding row ([plan 0006](plans/0006-upstream-findings.md) §5, step 4), stores it only from a writer, never the importer or the backfill role, and only when, beyond `validate`, its text passes the scrub's `verify` against the sender's own name hashes (its registration's `name_hashes`), and no field holds a registered key, checked with the aggregate's `assertNoKey` and, in the text, joined to its neighbours by anything but a letter or a digit (`scripts/telemetry/holds-key.mjs`, which the #41 job and Jev's request read too, so `k3f9a2-prod` holds the key `k3f9a2`). A refusal names the field and the rule, such as `evidence (url)`, `evidence (name)` or `evidence (key)`, never the text. A key with no name hashes stores no finding;
  - for a deploy row ([plan 0010](plans/0010-deployment-lane.md) §10, step D9), stores it from a writer or the importer, never the backfill role. Its fields are numbers, times, booleans and closed words only, the environment named by its `role` and `position`, never its name, so `validate` is all its intake needs. Any `refusal` the schema's `DEPLOY_REFUSALS` lists is stored;
  - for a notify row ([plan 0011](plans/0011-notifications.md) §11, step N5), one `notify` job's outcome (`posted`, `failed` or `skipped`, with its skip reason or failure) and the hook's kind (`slack`, `webhook` or `custom`), stores it from a writer or the importer, never the backfill role. It holds no URL, channel, host, text, status body or secret: its fields are numbers, times and closed words only, and `validate` refuses any other field, so `validate` is all its intake needs;
  - stamps `received_at`, `expires_at` and `source`, and writes the row with `PutItem`, a finding under `<key>#finding`, a deploy row under `<key>#deploy`, sorted by time, then run, attempt and the environment's position, and a notify row in its lane's partition, `<key>#<lane>`, under a sort key that begins `notify#`, then time, run and attempt, so it never takes the key of the run row of the same run, and falls outside every time window a read of the lane's run rows asks for.

  It takes up to 25 rows a request and 256 KB, and answers per row: 200 when every row is stored, 422 when any is rejected, and 502 when a write fails.

  **The deploy row is stored, never published.** The aggregate function reads no `<key>#deploy` partition, and its `Query` projection names no deploy field, so no cross-adopter deploy figure exists until the Owner decides one ([plan 0010](plans/0010-deployment-lane.md) decision 11). Erasure walks the partition with the others ([Erase an adopter](#erase-an-adopter)). **Deploy order: deploy intake from the release that ships D9 before any repository's pin reaches a release whose deploy lane writes the row.** An intake from an earlier release answers each deploy row 422 `row_kind (not-allowed)`, and the collector turns red. The release procedure's [intake-first step](release.md#intake-first) flags it, though the deploy row's schema shipped earlier, with D3: it compares the kinds each release's function stores (`STORED_KINDS`) as well as the schema, and names `deploy` as a kind the deployed intake knows but does not store ([#918](https://github.com/yedeya-labs/kanon/issues/918)).

  **The notify row is stored, never read yet.** The aggregate skips any `row_kind` but `run`, and the page view's rows pass through `prepareRows`, which counts a notify row as another kind, never as a run, so no figure counts one. The first reader, a `notify` cell in the aggregate, is a follow-up built against real rows ([plan 0011](plans/0011-notifications.md) decision 19). Erasure walks the lane's partition, and the notify row with it. **Deploy order: deploy intake from the release that ships N5 before any repository's pin reaches the release whose `notify` block writes the row (N6).** An intake from an earlier release answers each notify row 422 `row_kind` `enum`, since its schema doesn't know the kind, and the collector turns red. The release procedure's [intake-first step](release.md#intake-first) names it, `notify: a row kind the deployed intake does not know`, when the release that carries N5 is checked.

  **A finding's `scrub_version`** is the version of the scrub's rules that redacted its text (plan 0006 §4.2). Version 2 ([#724](https://github.com/yedeya-labs/kanon/issues/724)) changed one rule: `name` no longer removes a word wholly inside a Kanon path the `path` rule kept ([#603](https://github.com/yedeya-labs/kanon/issues/603)), so `scripts/merge-gate.mjs` stays whole. The function accepts every version from 1 to its own release's, and refuses any other with 422 `scrub_version` `range`. A version-1 row still passes, because version 2's `verify` only leaves more alone. **So deploy intake first, then the lanes' release:** render, package and deploy from the release that writes version 2 before any repository's pin reaches it. An intake from an earlier release refuses each version-2 row, and the collector turns red. The #41 job validates each finding again at the release it pins ([Kanon's own bugs](#kanons-own-bugs)), so move its pin with the deploy. The release procedure's [intake-first step](release.md#intake-first) checks every such widening, `scrub_version`'s among them, against the release intake was deployed from.
- **Its log group:** 30-day retention. It holds keys and field names, never a value.
- **Its environment** (from `render.mjs`): `WRITER_KEYS`, every registered key, and `NAME_HASHES`, for each key the SHA-256 of each word of its repository's owner and name but Kanon's own vocabulary (the scrub's `KANON_WORDS`), never the words (plan 0006 §4.2). **Since plan 0008 J3 the function reads neither:** the keys and the name hashes come from the register table instead, and both variables go with `render.mjs` at J9. Lambda holds a function's environment to 4 KB, so `render.mjs` refuses a register too large for it before any deploy. Beside them, the token path's settings: `REGISTER_TABLE`, `AUDIENCE` (the `Audience` parameter, default `kanon-telemetry`), `MIN_TOKEN_VERSION` (`MinTokenVersion`, empty by default, which admits no token), `SELF_READ_ROLE` and `CURSOR_KEY` (`CursorKey`, empty by default, which refuses `GET /v1/rows/self`).
- **The token path's resources** (plan 0008 J3): the `live` and `erase` aliases, on `$LATEST`; the `live` alias's URL, with `AuthType: NONE` and the two public permissions a URL needs, bounded by the reserved concurrency; and `kanon-telemetry-self-read`, which only the ingest function's role may assume, and which may only `Query` and `BatchWriteItem` the rows table, under a session policy the function narrows to one key. The rows table's resource policy admits it beside the function's role and yours, for the erasure walk's deletes.
- **The aggregate function, `kanon-telemetry-aggregate`** (plan 0002 §6.1, decided by the Owner on 2026-10-07): Node 24, 256 MB, no VPC, the same package as the ingest function. Its URL has `AuthType: AWS_IAM`. A `GET` answers only what may be published ([The aggregate function](#the-aggregate-function)). Its role may `Query` the table and nothing else, and only with exactly the aggregate's projection, run rows' and work-item rows' fields together ([The page view](#the-page-view)): `dynamodb:Attributes` lists those attributes, and `dynamodb:Select` must be `SPECIFIC_ATTRIBUTES`, so a request for whole items is refused. Its log group keeps counts only, 30 days.
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
- **A permissions boundary, none by default** ([plan 0010](plans/0010-deployment-lane.md) decision 15): `PermissionsBoundaryArn`, an IAM managed policy's ARN, empty by default. When it is set, every role in the stack carries it as its `PermissionsBoundary`: the ingest, self-read, aggregate, importer, backfill and verify-probe roles, and each repository's writer, reader and invoker role that `render.mjs` adds. When it is empty, no role has a boundary, and the stack is what it was before the parameter existed. It is for a deploy through the deployment lane. That lane's CloudFormation service role may create a role only with the boundary attached, so the bootstrap stack that holds the service role holds the boundary policy too ([plan 0010](plans/0010-deployment-lane.md) §15). The lane's deploy hook renders until plan 0008's J9, so the rendered roles need the boundary as well. `render.mjs` doesn't write the parameter, so a deploy from its `parameters.json` keeps the stack's value (`UsePreviousValue`), and an Owner's deploy sets it by adding `"PermissionsBoundaryArn=<policy ARN>"` to that file.

## Where the register lives

The register, `register.json`, pairs each adopter's opaque key with its repository, which is the one pairing the key exists to hide (plan 0002 §5). **It never lives in a repository where Kanon's lanes run, public or private.** A private repository is no safer than a public one. If the register is tracked there, a pull request that touches it sends the keys and the pairing to the Reviewer's model, and the lanes' agents can read any file in their checkout. Watch for this if you're an operator who is also an adopter: your private operations repository is the natural home for the register, and it's also where you install Kanon.

Keep it in one of these, and render from there:

- **An untracked file** on your own machine, outside every checkout, such as `~/kanon-private/telemetry/register.json`.
- **A repository with no Kanon lanes**, private, which none of Kanon's workflows run in.
- **A secrets store**, copied to an untracked file outside every checkout when you render, and deleted afterwards.

The same holds for what is made from it: `render.mjs`'s output, `template.json` and `parameters.json` ([Deploy](#deploy)), and the history export of the reference adopter's import ([The importer and the backfill role](#the-importer-and-the-backfill-role)). Each holds the register's contents or its keys. [The register table](#the-register-table) is in the `kanon` account, out of every repository; this section is about the file `render.mjs` and `register.mjs import` read.

**If a register is already tracked in a repository where Kanon's lanes run,** move it to one of the places above first. Then delete it from that repository in a pull request with no review label (`review:please`, `agent:triage` or `agent:implement`), so the Reviewer doesn't read it: the deletion's diff is the register, line by line. Add its path to that repository's `.gitignore` in the same pull request. Its history still holds every version, so treat each key there as paired with its repository for anyone who can read that history.

## Before the first deploy

Run these once, from a Kanon checkout at the release tag being deployed, after `npm ci`. `render.mjs` calls `gh api` for each registered repository (`repos/<owner>/<repo>` and `repos/<owner>/<repo>/actions/oidc/customization/sub`), so `gh` must be signed in as someone who can read those repositories' Actions settings. These are GitHub calls only; no AWS command runs before the deploy.

1. **Keep the register out of every repository where Kanon's lanes run** ([Where the register lives](#where-the-register-lives)), public or private. For example, in `~/kanon-private/telemetry/register.json`, an untracked file outside every checkout, copied from `register.example.json`. Generate each key with `openssl rand -hex 4`. The key is opaque: it is what every row and role carries, so it must say nothing about the repository.
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

**The store is deployed by the operator's repository, through Kanon's deploy lane** ([The deploy lane](lanes.md#the-deploy-lane), [plan 0010](plans/0010-deployment-lane.md) §15). Kanon's own repository has no deploy caller, no deploy hooks and no declared environment. The operator's repository adopts the lane as any adopter does: it pins a released Kanon, declares one environment, `production`, in its adoption record's `## Deploy` section, and holds the account's private inputs as that environment's secrets and variables. Its three hooks do what the commands below do by hand:
- **build,** with no credential: copies the template, the function directory with its links resolved and the scripts the deploy needs from `infra/telemetry/` at the pinned tag;
- **deploy:** assumes the environment's role, renders from the register held as the environment secret `KANON_DEPLOY_SECRET` (until plan 0008's J9, when rendering goes), packages into the artifacts bucket and deploys `kanon-telemetry` through a CloudFormation service role, with a fresh `CursorKey` each time. It prints no stack output and no key;
- **smoke:** the stack is `UPDATE_COMPLETE` or `CREATE_COMPLETE`, a request with no `Authorization` gets 401 `token`, and the token path refuses a wrong audience and a job that isn't the collector.

**Production is the Owner's dispatch.** Required reviewers aren't offered for the operator's private repository on the organisation's GitHub plan, so its record declares the `no-reviewers` fallback ([plan 0010](plans/0010-deployment-lane.md) §13). A release of the operator's repository runs the gate, the trust probe and the build, then stops before production. The Owner, the Maintainer the record names, deploys it by dispatching the lane at that release's tag, in the operator's repository:

```sh
gh workflow run deploy.yml --ref <tag> -f release=<tag>
```

The production job refuses a dispatch from anyone else, and the operator's release-tag ruleset lets only the Releaser and the Maintainer create, move or delete a release tag. A failed deploy or smoke files `Deploy to production failed` there, and the next success closes it.

The first lane-driven deploy is plan 0008's token-path rollout ([plan 0010](plans/0010-deployment-lane.md) §15.1, D14), with `register.mjs import`, then `set --page-reader true` on Kanon's registration, right after it ([The register table](#the-register-table)). From then on, no deploy of the store is made by hand but break-glass. What stays the Owner's: the one-time bootstrap stack that holds the deploy role, the service role, the artifacts bucket and the permissions boundary, and any change to it; the `production` environment, its variables and `KANON_DEPLOY_SECRET`, kept in step with the register until J9, then deleted with the file; the dispatch of each production deploy; [Verify](#verify); and the data and account scripts (`register.mjs`, `erase.mjs`, `import.mjs`, `backfill.mjs`).

Before each of Kanon's releases, [`intake-first.mjs`](release.md#intake-first) says whether it needs this deploy first.

### By hand: break-glass, and Verify

Deploy by hand only when GitHub Actions is down, and for [Verify](#verify)'s two deploys, which need `EnableVerify` and your own principal. Run these from a Kanon checkout at the release tag being deployed, with your profile.

`$REG` is the register, and `$OUT` is a directory beside it. The rendered files, `template.json` and `parameters.json`, hold the register's contents, so they stay out of every repository where Kanon's lanes run too ([Where the register lives](#where-the-register-lives)).

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

**If the deploy that creates the register table fails** ([The register table](#the-register-table)), the stack rolls back, but `kanon-telemetry-register` stays, because it is retained and deletion-protected, and the next deploy fails because it already exists. While it is empty, turn off its deletion protection, delete it, and deploy again. Leave the stack alone: it is live, and only the register table needs to go.

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

**From vM, an adopter adds itself** ([plan 0008](plans/0008-self-service-registration.md) §8). `kanon init --telemetry`, or a yes to its consent question, writes the collector's caller ([Collect the rows](#collect-the-rows), [`docs/init.md`](init.md#telemetry), #428), and that is the whole registration: the caller's first run on the default branch, the first hourly schedule after the install's pull request merges or a dispatch, registers the repository, active at once, under the default quotas. Nothing names the repository in public, no variable is set, and you do nothing. Telemetry is off without that yes. `kanon doctor` reports `telemetry.not-run` until the caller has a finished run on the default branch, `telemetry.unpublished` when its last run skipped because its release doesn't publish the hosted store's URL, and `telemetry.refused` when its last run ended on the store's refusal, none of them blocking ([`docs/doctor.md`](doctor.md)). What stays yours is in [The register table](#the-register-table): suspending a key, the operator fields (`aggregate_invoker`, `publish_own_figures_as`, `page_reader`, a quota), and an erasure asked for another way.

### Publish the hosted URLs

The Owner's step, once, before the release that is vM is tagged ([plan 0008](plans/0008-self-service-registration.md) §9 step 3b, §12). [`scripts/lib/telemetry-token.mjs`](../scripts/lib/telemetry-token.mjs)'s `HOSTED_INGEST_URL` and `HOSTED_AGGREGATE_URL` are empty in the tree until then. A release with them empty sends nothing: its collector says in its summary that the hosted store's URL is not published, and stays green. Its job is named `Collect telemetry rows (hosted store unpublished)` then, so the watermark passes over those runs, and the first sweep at a release that publishes the URLs reaches back to the last sweep before them, up to 7 days; `kanon doctor` says `telemetry.unpublished`, and `kanon init` says the collector sends nothing yet ([#843](https://github.com/yedeya-labs/kanon/issues/843)).

1. **Reserved concurrency 2 on both functions first** (Owner decision 10 of 2026-10-12), from the template's `ReservedConcurrency` parameter in step 2's deploy. The token URLs are public (`AuthType: NONE`), and the reservation bounds what a flood of refused requests can cost. The account's concurrency quota must have been raised first ([Before the first deploy](#before-the-first-deploy), step 4).
2. **Deploy vM's template** with `MinTokenVersion` and a fresh `CursorKey`: `render.mjs --min-token-version <vM, as X.Y.Z>` writes the first, and every render writes a fresh second ([Before the deploy that admits tokens](#the-token-paths-endpoints-plan-0008-j3)). Then run `verify.mjs` ([Verify](#verify)). vM has no tag yet, so the template comes from a Kanon release before vM that carries J2 to J4, deployed through the operator's deployment lane ([plan 0010](plans/0010-deployment-lane.md) D13); a deploy by hand is break-glass only (plan 0010 §15.1). A later deploy, vM's own among them, keeps both URLs, since CloudFormation replaces a function URL only when its function or alias changes.
3. **Read the two outputs,** `IngestTokenUrl` and `AggregateTokenUrl`:

   ```sh
   aws cloudformation describe-stacks --stack-name kanon-telemetry --profile kanon --region eu-central-1 \
     --query "Stacks[0].Outputs[?OutputKey=='IngestTokenUrl' || OutputKey=='AggregateTokenUrl']"
   ```

4. **Set the two constants** to them in a Kanon pull request. The URLs are not credentials: the token is the gate. The same pull request removes the `hosted store unpublished` clause from the collect job's `name:` in [`telemetry-collect.yml`](../.github/workflows/telemetry-collect.yml): the job's name is evaluated before the script runs, so the workflow holds its own literal, and [`tests/unit/telemetry-collect-lane.test.ts`](../tests/unit/telemetry-collect-lane.test.ts) fails while the two disagree. The first release after that pull request, and after J5's second half, is the one adopters' pins move to.


### The SigV4 path's register entry (below vM; removed at J9)

A repository pinned below vM sends through its writer role, which the operator renders from the register file. These steps hold for it until J9 removes that path; no new adopter needs them.

1. Add an entry to the register, where [it lives](#where-the-register-lives):

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
3. Import the entry into the register table, `node infra/telemetry/register.mjs import --register "$REG"`, which leaves the entries already there as they are. Since plan 0008 J3 the function refuses a key the table doesn't hold as `active`.
4. In the repository, install the collector ([Collect the rows](#collect-the-rows)). It holds `id-token: write` in its collect job alone (`K-OBS-13`), and declares no environment, because an environment replaces the ref in the token's subject and the writer refuses it. Before the deploy, list the repository's default-branch jobs that already hold `id-token: write`, Kanon's QA-store jobs included. Each of them can assume the writer role (below).

**The time from install to first review** (plan 0003, group 9) goes in the entry once the Owner's aggregate script has computed it, as `"first_review": { "minutes": <n>, "review_recorded_at": "<the review row's recorded_at>" }`, copying `recorded_at` as the row holds it, milliseconds and all. It is kept for 13 months after `review_recorded_at`, then removed (plan 0002 decision 18). `render.mjs` refuses a register that still holds one past that date, naming only the entry's index.

A renamed repository fails closed: its `sub` stops matching, the collector turns red, and the register needs the new name. `render.mjs` refuses an entry whose `repository` differs from the name GitHub reports, a rename or a different case, so the next render says so before a deploy.

## Collect the rows

Plan 0002 S7. The lanes hold no store credentials. Each run uploads its row, run row version 2, 3 or 4 (the artifact family's version 2), as a `kanon-telemetry-<lane>-<run id>-<attempt>` artifact. One job sends the rows on: Kanon's reusable workflow [`telemetry-collect.yml`](../.github/workflows/telemetry-collect.yml), which runs [`scripts/telemetry-collect.mjs`](../scripts/telemetry-collect.mjs). Each run:

- **reaches back to the start of the last run whose collect job succeeded,** and overlaps by at least 90 minutes. However many scheduled runs GitHub drops, the next one covers them. A re-sent row overwrites itself, because the function builds its key from the row.
- **stops at 7 days, or at the repository's artifact retention when that is shorter** (S1a, [#212](https://github.com/yedeya-labs/kanon/issues/212)). The function refuses a row older than 8 days, and an expired artifact is gone. When the last successful run is older than that, the run warns that the rows before it are lost.
- **sends only this repository's own runs' rows.** A fork's run can upload any row under any name, so its artifacts are counted and ignored.
- **checks each row with `validate`, and against its artifact's lane, run and attempt,** then sends the rows 25 to a `POST`, each with a fresh GitHub OIDC token for the store's audience ([The caller](#collect-the-rows), plan 0008 §2.1).
- **sends upstream findings at the level your adoption record declares** ([plan 0006](plans/0006-upstream-findings.md) §3.1 and §5, step 3). The Overseer's and the telemetry Explorer's filing jobs upload them as `kanon-finding-<reporter>-<run id>-<attempt>`, holding `kanon-finding.json`, a list of at most 20 finding rows. Before it sends any, the run reads `docs/qa/adoption.md` from the default branch: `drafted` or `filed here` sends none, `sent` sends each row as codes only, without its evidence or suggested fix, and `sent with evidence` sends each row as the lane built it. So turning the level down stops the text at the next sweep, even for artifacts written before. A record it can't read, or a malformed one, sends no finding and turns the run red. Each row must name its artifact's reporter, run and attempt. A text the scrub still finds something in, with this repository's name as its context, is sent as codes only, with a warning naming the field and the rule.
- **sends the deploy lane's rows** ([plan 0010](plans/0010-deployment-lane.md) §8, §10, step D9). Each environment of a deploy run uploads one `deploy` row as `kanon-deploy-row-<run id>-<attempt>-<position>`, holding `kanon-deploy-row.json`, outside the `kanon-telemetry-` prefix that only a lane's run row carries. The sweep lists them with the run rows, from this repository's own runs only, checks that each row names its artifact's run, attempt and position and passes `validate`, and sends it to the `<key>#deploy` partition. A row that fails either check turns the run red, naming the artifact and the field, never a value.
- **sends each lane's notify rows** ([plan 0011](plans/0011-notifications.md) §11, step N5). A notifying lane's `notify` job uploads one `notify` row as `kanon-delivery-<lane>-<run id>-<attempt>`, the job's own run and attempt, holding `kanon-delivery.json`; the deploy lane's, which notifies once per environment in one run, adds the environment's position, `kanon-delivery-deploy-announce-<run id>-<attempt>-<position>` (step N9). These are also outside the `kanon-telemetry-` prefix. The sweep lists them with the run rows, from this repository's own runs only, checks that each row names its artifact's lane, run and attempt and passes `validate`, and sends it to the lane's partition. A row that fails either check turns the run red, naming the artifact and the field, never a value. A collector pinned at a release before N5 doesn't list the family, and its artifacts expire unsent; nothing turns red. **The deploy lane's notify rows are in a lane of their own, `deploy-announce`** (step N9; `deploy` is the deploy rows' partition), which widens the schema's lanes: deploy intake from the release that ships it before any repository's pin reaches it, as the [intake-first step](release.md#intake-first) names.
- **writes one work-item row per pull request closed in the span** ([plan 0003](plans/0003-metrics.md) §3, M4), merged or not, derived as `kanon metrics dry-run` derives it, and sends it with the run rows to the `<key>#work` partition, where the PR's number alone is its key. A PR closed, reopened and closed again is one item: its last derivation overwrites the first. It also writes again the row of an earlier item whose story the span changed: a PR merged in the span that reverts it or is a linked fix of it (§3.5), or a Reviewer follow-up of it that closed in the span, for any reason. Each such row is derived whole again, so it keeps the revert or fix an earlier sweep found. A PR still open gets no row; the one it gets when it closes reads its follow-ups' fates then. An item closed 13 months ago or more is not written again: its row has expired. The row holds counts, durations, times, enums and PR numbers only, no login, title, path or text, and `validate` refuses any other field (ADR 0007, `K-OBS-16`).
- **registers the repository on its first run** (plan 0008 §3.2): the store answers the rows of a repository it doesn't know 404 `not-registered`, and the run registers it once, with `POST /v1/registrations`, and sends the rows again; a run with no row to send reads `GET /v1/registrations/self` and registers on a 404, so a quiet repository registers too. Its summary says the registration's status.
- **stops on the store's refusal, and says it in the store's words,** under the annotation title `telemetry-refused`, which `kanon doctor` reads (`telemetry.refused`): 403 `suspended` (the operator suspended the key) and 429 `quota` (a limit, named, with when it resets; the next sweep after the reset sends the span again) turn the run red, as does any other 403, a check on the token; 410 `erased` keeps it green with a warning, since the adopter asked for it, and sends nothing.
- **turns red on anything it couldn't send:** an unreadable artifact, a row that fails the schema, a row the store rejects, or a listing that fails; and, in the work-item step, a GitHub read that fails (the declarations, the pull requests closed in the span, the reverts, fixes and follow-ups, an earlier item or its later pull requests), a pull request one of whose lists can't be read, a merged pull request missing a list the detectors read, or a work-item row that fails the schema. A number or commit that GitHub says doesn't exist, mentioned in a body or a comment, is no candidate and turns nothing red. The errors name the artifact and the field, never a value. That red run is the page (§9). The next run re-covers the same span, so nothing is lost by failing.

**Run row version 4** ([#173](https://github.com/yedeya-labs/kanon/issues/173), the Owner's decision of 2026-10-15) adds two counts to version 3's fields, each a whole number and absent when unknown, to measure again what predicts a run's turns:

- `review_open_items`, on a revise lane's run (`implement-revise`, `lead-revise`): the open items the Reviewer's latest changes-request declares in its `<!-- qa:open-items N -->` marker, the count the merge-reconcile gate reads. The review is the triggering event's, or else the pull request's latest changes-request. A review that doesn't open with the Reviewer's role marker, or whose marker is missing or garbled, records nothing.
- `issue_ac_count`, on a run that names its issue: the top-level bullets under each "Acceptance criteria" or "What must be true" line, plus each distinct `[ID-n]` spec clause the body cites outside them. A label with no bullets counts as one when it states one in prose, on its own line or in a paragraph under a heading, as a Reviewer follow-up is written; a sentence that introduces bullets under the label is not counted, only the bullets after it. Read from the same body as `issue_body_chars`.

Both are counts, which `K-OBS-16` allows; no text leaves. A row is written at the lowest version that holds its fields, so a row with neither count is still version 2 or 3. **Deploy intake from the release that ships version 4 before any repository's pin reaches it**, as the release procedure's [intake-first step](release.md#intake-first) names: an ingest function from an earlier release refuses `schema_version: 4` with a 422, and the collector turns red. The same release names the diagnose lane, `deploy-diagnose` ([#966](https://github.com/yedeya-labs/kanon/issues/966)), whose rows an earlier intake refuses as an unknown lane.

**Cadence and cost.** The caller schedules it hourly, at minute 40 (§1.2), so 24 runs a day. It touches no database, and nothing it calls scales to zero. On a public repository its Actions minutes are free. On a private one it is about a minute a run. Each run calls the function only when it has rows, once per 25 rows. For Kanon that is at most 720 calls a month, inside Lambda's free tier, plus 2 DynamoDB write units per row. That is inside §9's estimate of about $0.05 a month.

**The caller.** It grants `actions: read` for the runs and artifacts, `contents: read` for the adoption record's upstream-findings level (plan 0006 F4) and the declarations the work-item rows are derived with, `id-token: write` for the OIDC token each request carries, and `issues: read` and `pull-requests: read` for the pull requests and issues the work-item rows are derived from (plan 0003 M4). A caller written before F4 lacks `contents: read`, and one written before M4 lacks `issues: read` and `pull-requests: read`. GitHub refuses to start a called workflow that asks for more than its caller grants, so add them before moving the pin to a release with F4 or M4: `kanon doctor` reports each as `caller.grant-missing`. `kanon init --telemetry` writes it as `.github/workflows/telemetry.yml`, byte for byte as below; `tests/unit/kanon-init.test.ts` holds the two to each other. Written by hand, it is a trigger-only workflow. Pin it to the Kanon version every other Kanon reference uses. **It reads no variable and maps no secret** (plan 0008 §8): the hosted store's URL is the collector's own constant, and the token GitHub mints for the collect job, which the store checks claim by claim, is the only credential. Two dispatch inputs, both `no` by default, are the adopter's: `erase: yes` erases the repository's rows and registration and sends nothing, and `register: yes` comes back after an erasure, under a new key (§7, §3.3; [`docs/sharing.md`](sharing.md#stop-and-erase)). Name the caller as you like; the collector finds its own runs from `GITHUB_WORKFLOW_REF`.

<!-- x-release-please-start-version -->

```yaml
# Sends this repository's telemetry rows (agent-run, work-item, deploy and notify rows) to Kanon's hosted telemetry store (docs/telemetry.md).
# Its first run registers the repository. Delete this file to stop; dispatch it with erase: yes first to erase what was sent.
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
      erase:
        description: Erase this repository's rows and registration from the store, and send nothing.
        type: choice
        options: ["no", "yes"]
        default: "no"
      register:
        description: Register this repository again after an erasure.
        type: choice
        options: ["no", "yes"]
        default: "no"
permissions:
  actions: read
  contents: read
  id-token: write
  issues: read
  pull-requests: read
jobs:
  collect:
    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v0.40.0
    with:
      window_minutes: ${{ inputs.window_minutes }}
      erase: ${{ inputs.erase }}
      register: ${{ inputs.register }}
```

<!-- x-release-please-end -->

Give `window_minutes` no default. Empty means "no operator instruction", and a default would make every scheduled run an override and switch the watermark off. A run with an override never becomes the watermark either: its collect job is named `Collect telemetry rows (window override)`, and the next scheduled sweep still reaches back to the last full one, so a short override can't hide the rows before its span.

**A self-hosted store** (`K-OBS-18`), the same template in your own account with an `Audience` of its own, is named by two inputs together, `url:` (its `IngestTokenUrl` output) and `audience:`, never one without the other, and never with the hosted audience, `kanon-telemetry`: a token minted for Kanon's store is only ever sent to Kanon's store's URL (plan 0008 §2.1). The collect job's first step after Kanon's path checks them before any token is minted, and stops the run, red, naming the input, on either alone.

**Moving a caller from the SigV4 path** (plan 0008 §9 step 4): a caller written before vM passes `url: ${{ vars.KANON_TELEMETRY_URL }}` and `writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}`. **At vM both are refused** without `audience:` (Owner decision of 2026-10-14, [#842](https://github.com/yedeya-labs/kanon/issues/842)): the collect job's check step turns the run red before any token is minted, so it sends nothing and registers nothing, and the URL is never swapped for the hosted store's, since a caller that named a store of its own must not start sending to Kanon's. `kanon doctor` reports it as `telemetry.legacy-inputs`, blocking, and [`lane-check`](../actions/lane-check/README.md) fails the pull request that moves the pin while the caller still passes either without `audience:`, a Dependabot bump included, since the collector itself only refuses it after the merge ([#845](https://github.com/yedeya-labs/kanon/issues/845)). So **move the pin and the caller in one pull request**: run `kanon init --telemetry` again, which lists the caller as differing with the new caller's content, and write that in its place (both lines gone, the `erase` and `register` inputs added); once a week of runs is green, delete the two variables (§9 step 5). For a store of your own, add `audience:` beside `url:` and remove `writer-role:` instead; `writer-role:` beside both is ignored, with a warning.

**The check.** Dispatch the caller on the default branch. The run is green, and its summary says how many rows the store accepted and that the registration is `active`. The run rows are under `<key>#<lane>`, the work-item rows under `<key>#work`.

**Kanon's own caller** is [`telemetry.yml`](../.github/workflows/telemetry.yml). It is pinned like Kanon's other callers ([ADR 0011](decisions/0011-kanon-runs-its-own-lanes.md)). It runs hourly at minute 40, from the change after its pin reached v0.27.0, the first release that ships the collector it calls ([#304](https://github.com/yedeya-labs/kanon/issues/304)). Its pin is still below vM, so it still passes the two variables, `KANON_TELEMETRY_URL` and `KANON_TELEMETRY_WRITER_ROLE`, which the SigV4 path reads; it drops them when its pin moves to vM (J7).

## Who can write

**From vM, on the token path,** only Kanon's collector can write: the ingest function admits a row only with a GitHub OIDC token whose `job_workflow_ref` is `yedeya-labs/kanon/.github/workflows/telemetry-collect.yml` at a release tag at or above `MinTokenVersion`, from the caller's schedule or a dispatch of its default branch, with the store's audience (plan 0008 §2.2, `K-OBS-13`). Which job of that workflow may mint such a token is the id-token guard's: `collect` alone, in its exact shape (Kanon's path, the inputs' check and the one script). This is enforced by Kanon's code, not by IAM: the function is the gate ([The token verifier](#the-token-verifier-plan-0008-j1)). The rows the collector sends are still what the repository's own runs uploaded, so a repository can send rows of its own invention under its own key, and never under another's.

**Until J9, the SigV4 path stays beside it,** and on that path the writer trusts the default branch's ref. What a token's subject is decides whether it is admitted:

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
- **The Explorer's telemetry mode's `aggregate` job**, in a repository that runs that lane ([The Explorer's lane](#the-explorers-lane)). Below vM it holds the grant to assume the aggregate invoker role; from vM it mints a token for the aggregate function's token URL instead, and assumes no role. It runs on a schedule, so on the default branch.
- **The Overseer's `telemetry` job**, in a repository that sends telemetry, where a workflow on the default branch calls Kanon's collector ([The Overseer's cost view](#the-overseers-cost-view)). Below vM it held the grant to assume the reader role a caller mapped; from vM it mints a token for `GET /v1/rows/self` instead, and assumes no role. It runs on the weekly schedule or a dispatch, so on the default branch.
- **The metrics page's `aggregate` job**, in Kanon's own repository only ([The public metrics page](metrics.md#the-public-metrics-page)). It holds the grant to assume the aggregate invoker role, on the weekly schedule or a dispatch, so on the default branch.
- **The adopter's own jobs** that hold it for another cloud, such as a deploy on push to the default branch.

Each can write rows under its own adopter's key that pass the function's validation. None can read, name a partition, or reach another adopter's key. A job without `id-token: write` gets no token to ask with, so the set is exactly the jobs that hold it. What is guarded is that set's size in Kanon's own workflows, not that the collector is its only member: the id-token guard #291 added fails any Kanon job holding `id-token: write` that doesn't run the `qa-store` block or the AWS store's maintenance block alone, or isn't the collector's `collect` job, the telemetry Explorer's `aggregate` job, the Overseer's `telemetry` job or the metrics page's `aggregate` job in `metrics-page.yml` in its exact shape (for the collector, Kanon's path, the inputs' check and the one script; for the Explorer's `aggregate`, Kanon's path, the read and the upload; for the Overseer's `telemetry`, Kanon's path, the read, the upload and the report, these three with no credentials step since vM; for the metrics page's `aggregate`, until J7, Kanon's path, the masking step, the credentials, the one script and the upload; and nothing beside them). The adopter's own holders are the adopter's to check.

### The token verifier (plan 0008 J1)

[Plan 0008](plans/0008-self-service-registration.md) moves this gate from IAM into the function: it will check GitHub's OIDC token itself, so that only Kanon's collector at a Kanon release, on the repository's default branch, can write. Its first step is the verifier, [`function/oidc.mjs`](../infra/telemetry/function/oidc.mjs). `verifyToken` runs §2.2's nine checks in order (the algorithm, the signature against GitHub's keys, the issuer, the audience, the token's times with 60 seconds of skew and a 10-minute maximum age, the trigger, `job_workflow_ref` against the endpoint's own workflow at a release tag no older than `MIN_TOKEN_VERSION`, the repository and owner ids, and the default branch). It stops at the first failure and answers that check's status and code. A missing claim is a refusal. `keyCache` holds GitHub's JWKS for 15 minutes, fetches at most once a minute, and answers 503 `jwks-unavailable` rather than use a stale key. Neither logs a token, a key or a claim's value. The ingest function's five endpoints stand behind it (J3, [The token path's endpoints](#the-token-paths-endpoints-plan-0008-j3)); no lane calls them until J5, and the aggregate function's turn is J4. Its tests, [`telemetry-oidc.test.ts`](../tests/unit/telemetry-oidc.test.ts), sign their tokens with a key pair they generate, and each check has a test that a mutation of it turns red.

## The token path's endpoints (plan 0008 J3)

**Kanon's lanes call them from vM** (J5): the collector the rows, registration, the status read and erasure, and the Overseer's `telemetry` job the adopter's own rows, `GET /v1/rows/self` ([The Overseer's cost view](#the-overseers-cost-view)). The token path admits no token while `MinTokenVersion` is empty, its default. [Plan 0008](plans/0008-self-service-registration.md) §3 is the design; [`function/token.mjs`](../infra/telemetry/function/token.mjs) is the code.

The endpoints sit on the `live` alias's URL (the `IngestTokenUrl` output). The handler tells its three ways in apart by the alias Lambda says it was invoked through, never by the request: the unqualified function serves the SigV4 path above, `live` the token path, and `erase` the erasure walk. An IAM-signed request on the `live` URL, a bearer token on the IAM URL, and any other qualifier are refused, 403 `path`.

Each request carries `Authorization: Bearer <GitHub's OIDC token>`, which [`function/oidc.mjs`](../infra/telemetry/function/oidc.mjs) checks for the endpoint's own workflow ([The token verifier](#the-token-verifier-plan-0008-j1)). The token's `repository_id` finds the registration, and **the registration's key is the only key any endpoint uses**: no parameter, header or row names one. **No answer holds a key.**

| Endpoint | Admits | Answers |
|---|---|---|
| `POST /v1/registrations`, body `{}` or `{ "reregister": true }` | the collector | 201 `{ status: "active", registered_at }` for a new registration, active at once; 200 the same for an existing one; 409 `erased` for an erased repository without `reregister`, and 409 `erasing` while its rows are still being deleted; 403 `suspended`; 429 `registrations` |
| `GET /v1/registrations/self` | the collector, the Overseer, the Explorer | 200 `{ status, registered_at, suspended_at?, suspended_reason?, erased_at?, rows_erased, quota: { rows_per_day, rows_today }, aggregate_invoker, publish_own_figures_as? }`, for a suspended or erased registration too; 404 `not-registered` |
| `DELETE /v1/registrations/self` | the collector | 202 `{ status: "erased", erased_at, rows_erased: false }`, the walk started; 200 the same on a repeat, which starts the walk again, with `rows_erased` true once done; 403 `suspended`; 429 `erasures_per_day`; 502 `erase-start` |
| `POST /v1/rows`, up to 25 run, finding, work-item, deploy and notify rows, mixed | the collector | 200 per row, as the SigV4 path; 422 any row rejected; 502 a write failed; 403 `suspended`; 410 `erased`; 429 `quota` |
| `GET /v1/rows/self?lane=<lane or work>[&from=&to=&fields=&tag=&cursor=]` | the Overseer | 200 `{ rows, cursor? }`, at most 1,000 rows a page, never a row past its `expires_at`; with no `fields` every field the schema allows the row kind, with no window the last thirteen months, `tag=run` unless `smoke` or `test` is asked; 400 `lane`, `fields`, `window`, `tag` or `cursor` |

Shared by all: 401 for checks 1 to 5 with `WWW-Authenticate: Bearer error="invalid_token"`, 403 for checks 6 to 9, 404 `not-registered` or `route`, 405 `method`, 413 `body-size`, 400 `body-*`, 429 `requests_per_hour`, 503 `jwks-unavailable`, and 503 `config` when `Audience` or `MinTokenVersion` is unset (or `CursorKey`, for the own-rows read).

- **Registration** writes the registration and its key item in one transaction, each conditional on not existing, with the two registration counters, so two concurrent first runs make one registration and one key, and the other answers 200. The key is `k` and 16 hex characters the function mints. The name hashes are the token's: the SHA-256 of each word of its `repository` claim, computed per request, so a finding is checked against the sender's current name, and the registration's `name_hashes` and `repository` follow it, for the operator's private job. A `schedule` token on another branch moves `default_ref` (plan 0008 §2.3).
- **Quotas** (§6): per key, 120 requests an hour on every endpoint, 5,000 rows stored a UTC day and 5 erasures a day; per owner, 20 new registrations a day, and 100 store-wide. `quota_rows_per_day` and `quota_requests_per_hour`, which you set with `register.mjs set`, replace the defaults. Each is a counter (`count#…`) reserved by one conditional `ADD` of the whole amount before anything is written, so **a batch past the day's rows is refused whole**, 429 with `Retry-After` and `resets_at`, and its rows are added to `refused#<key>#<day>`, which your private job reports. The SigV4 path, the importer and the backfill role are not counted.
- **The adopter's own rows** are read under a session of `kanon-telemetry-self-read` whose session policy's `dynamodb:LeadingKeys` is the registration's key, so a query can't leave it. The `cursor` is DynamoDB's `LastEvaluatedKey` sealed with AES-GCM under `CursorKey`: it holds no key in clear, and is refused on any other partition. Pass a new `CursorKey` (`openssl rand -hex 32`) on each deploy, so a deploy ends every cursor.
- **Erasure** (§7): `DELETE` sets `status: erased` and `erased_at` at once, conditional on `active`, so every later write and read is refused (410), and starts the walk as an asynchronous invocation of the `erase` alias, naming the repository id, never the key. The walk deletes every partition of the key, each lane (its run rows and its notify rows), `work`, `finding` and `deploy`, with `BatchWriteItem` under a session held to that key, hands itself on when its time runs short, and then deletes the key item and writes the **tombstone**, the two ids, `status`, `erased_at` and `rows_erased_at`, as one transaction. A tombstone keeps no default branch, so the verifier holds a token's `ref` to a branch's form only there: all a tombstone answers is that it is erased. Re-registering takes `{ "reregister": true }` and gets a new key.
- **Suspension** is yours (`register.mjs suspend`). Every endpoint but the status read answers 403 `suspended`, and the SigV4 path does too. The function's writes never undo it: none sets `status` over `suspended`.

**Before the deploy that admits tokens** (plan 0008 §9 step 3a), render with `--min-token-version`, the release that ships the token path as `X.Y.Z` (no `v`, no suffix), which `render.mjs` writes into `parameters.json` as `MinTokenVersion`; without the flag it writes none, so a later deploy keeps the stack's value, and a stack that never had one keeps the token path closed. **Every render writes a fresh `CursorKey`,** 32 random bytes as hex, into `parameters.json` only, never printed, so every deploy from a render ends the cursors of the one before (J5):

```sh
node infra/telemetry/render.mjs --register "$REG" --out "$OUT" --min-token-version <X.Y.Z>
```

## Quotas

Each repository's registration has limits ([plan 0008](plans/0008-self-service-registration.md) §6, Owner decision 6 of 2026-10-12), counted per key on the token path:

| Limit | Default | What it means for an adopter |
|---|---|---|
| Rows stored per UTC day | 5,000 | about 100 times the busiest adopter's day; a 7-day recovery sweep is a few hundred rows |
| Requests per hour, every endpoint | 120 | an hourly collector makes 1 to 13 |
| Erasures per UTC day | 5 | an erasure is idempotent; more is a loop |
| Rows per `GET /v1/rows/self` page | 1,000 | the Overseer's reads take a few pages |
| New registrations per owner per UTC day | 20 | an organisation installing Kanon across its repositories in a day |
| New registrations, store-wide, per UTC day | 100 | bounds a mass registration |

**Past a limit,** the store answers 429 with `Retry-After` and `{ "error": "quota", "limit", "resets_at" }`, and **nothing from that request is stored**: a batch is admitted whole or not at all. The collector stops its sweep and turns red, naming the limit and when it resets, under the annotation title `telemetry-refused`, which `kanon doctor` reports as `telemetry.refused`. Its watermark doesn't move, so the next sweep after the reset sends the same span again, and nothing is lost while the artifacts live (the 7-day cap). The refused rows are counted (`refused#<key>#<day>`), so the operator sees a key that keeps hitting a limit. The operator can raise one repository's limits with `register.mjs set --rows-per-day` or `--requests-per-hour` ([The register table](#the-register-table)). The Owner's importer and backfill role are not counted.

## Erase an adopter

Plan 0002 §10. Deletion is immediate in the table, and complete in backups within 35 days, which is how long point-in-time recovery keeps them.

**From vM the adopter erases itself** (plan 0008 §7): a dispatch of its caller with `erase: yes` calls `DELETE /v1/registrations/self`, which refuses every later write and read for the key at once and walks its rows away within minutes; the run's summary says whether they are gone yet. `register: yes` comes back later, under a new key. **An erasure asked another way** (an issue, an email), or a key you remove, is `register.mjs erase --repository <owner/name> --apply` ([The register table](#the-register-table)), the same walk.

**On the SigV4 path** (a repository pinned below vM, until J9):

1. Remove the adopter's entry from the register, and in the same edit its time from install to first review, which sits beside the key (plan 0003). Record the date and the key there, not the repository. Then render, package and deploy. That deletes both roles, so its writes and reads stop at once.
2. Count the rows, then delete them. The script walks `<key>#<lane>` for every lane in the schema's enum, which holds the lane's notify rows too, `<key>#work`, `<key>#finding` and `<key>#deploy`, so it needs no scan. It runs as your role. The table lets only three principals delete: the function's role, yours, and the self-read role, which only the function assumes.

   ```sh
   node infra/telemetry/erase.mjs --key <key> --profile kanon
   node infra/telemetry/erase.mjs --key <key> --profile kanon --apply
   ```

## The register table

[Plan 0008](plans/0008-self-service-registration.md) §5 moves the register out of the private file and into a table, `kanon-telemetry-register`, for the token path that plan builds. **Since J3 the ingest function reads it on both of its paths:** a SigV4 writer's key, and the key the importer or the backfill role names, must have an `active` registration there (§9), and the token path registers, erases and counts quotas in it ([The token path's endpoints](#the-token-paths-endpoints-plan-0008-j3)). So **the table and J3's code arrive in one deploy, and the Owner imports the register right after production deploys** (`register.mjs import`, below): no Kanon release has J2 without J3. The deploy goes through the operator's deployment lane, as the Owner's dispatch under its `no-reviewers` fallback ([plan 0010](plans/0010-deployment-lane.md) §13), and from it until the import every SigV4 call is refused, 403 `caller`. The Owner then checks that `register.mjs list` shows each entry `active` (plan 0008 §9 steps 2, 3 and 3a; [plan 0010](plans/0010-deployment-lane.md) decision 17). Since J4 the aggregate function reads the table on both of its paths too, so until the import it answers no cells and its invoker roles get 404 `not-registered`. The writer, reader and invoker roles stay until J9.

**What the template creates for it**, beside the rows table and in the same stack:
- **The table:** on demand, keyed `pk` alone, TTL on `expires_at` (for the quota counters, plan 0008 §6), point-in-time recovery, deletion protection and `DeletionPolicy: Retain`, as the rows table has.
- **Encryption with KMS** under the AWS-managed key `aws/dynamodb` (Owner decision 4 of 2026-10-12). There is no key fee, and every use of the key is in CloudTrail. The key's policy can't be narrowed, so it is not an access control. The resource policy and the roles are.
- **Its resource policy** denies every DynamoDB action to every principal except four: the ingest function's role, the aggregate function's role, your role (`OwnerPrincipalArn`), and the operator's private jobs' roles. You name those with the `OperatorJobRoleArns` parameter, comma-separated, and it is empty by default. To set it, render with `--operator-job-roles <role ARN>,<role ARN>`, which writes it into `parameters.json`, and package and deploy as usual. Each ARN, like `owner_principal_arn`, names one role: the render refuses a `*` or `?` in it, which the policy would read as a wildcard, and a `,` in `owner_principal_arn`, which it would read as a second principal. The CLI reads `file://` only when it is the sole value of `--parameter-overrides`, so don't add the parameter beside the file. A later render without the option leaves it out of `parameters.json`, and the deploy keeps the stack's previous value (`aws cloudformation deploy` uses `UsePreviousValue` for a parameter it isn't given). The projection those jobs may read (plan 0008 §5.3) goes on their roles, in the operator's repository.
- **The ingest role's grants on it:** `GetItem` and `Query`; a `Scan` of `pk` alone, for the key check on findings; `PutItem` and `UpdateItem` naming only the fields the function writes (`function/register-fields.mjs`, `FUNCTION_FIELDS`); and `DeleteItem` on key items (`key#<key>`) alone, the one delete the function needs, on erasure. The operator's fields, `aggregate_invoker`, `publish_own_figures_as`, `page_reader`, `quota_rows_per_day`, `quota_requests_per_hour`, `suspended_at`, `suspended_reason` and `first_review`, aren't listed. So IAM refuses the function any write that **sets** one, whatever its code does. IAM doesn't keep them: a whole-item `PutItem` of the function's fields replaces an item and drops them without naming them. The function keeps them by how it writes ([`function/register-store.mjs`](../infra/telemetry/function/register-store.mjs)): a registration is created only where none is, or over a tombstone, which holds none; every other write to a registration is an `UpdateItem` that sets the function's own fields; and the one whole-item write over a registration is the tombstone, which drops them by design. The writes that change `status` are conditional on the status they replace, so a suspension you write mid-request stays.
- **The aggregate role's grants on it:** a `Scan` of exactly `pk`, `key`, `status` and `publish_own_figures_as`, with no name or owner id. Also a `GetItem` of exactly `pk`, `key`, `status`, `repository_owner_id`, `default_ref`, `aggregate_invoker` and `page_reader`.

`tests/unit/telemetry-store-template.test.ts` holds each of these, and fails if any operator field reaches the ingest role's list.

**What it holds** (plan 0008 §5.2). A registration is at `repo#<repository id>`: the ids, the repository's name (encrypted with the table, and readable only by the ingest role and yours), the key, `status`, `default_ref`, `name_hashes`, the dates, and your fields. A key item is at `key#<key>`, holding the repository id, so no two registrations share a key. An erased registration becomes a **tombstone**: the two ids, `status`, `erased_at` and `rows_erased_at`, kept with no expiry (Owner decision 5), so a deleted and restored caller is never registered again unasked.

### `register.mjs`

Your CLI for the table. Run it with your profile (`--profile`, default `kanon`). **It never prints a key.** Every line names a registration by its repository, an entry of a register file by its index, and a tombstone, which has no name, by its repository id. A failed `aws` call is reported by its operation and DynamoDB's error code, never by its own error text, which can quote the request. It exits non-zero on any refusal.

```sh
node infra/telemetry/register.mjs list
node infra/telemetry/register.mjs suspend --repository <owner/name> --reason abuse|quota|owner-changed|request|other
node infra/telemetry/register.mjs resume --repository <owner/name>
node infra/telemetry/register.mjs set --repository <owner/name> [--aggregate-invoker true|false] \
  [--publish-own-figures-as <label> | --no-publish-own-figures] [--page-reader true|false] \
  [--rows-per-day <n>] [--requests-per-hour <n>] [--first-review <minutes>@<recorded_at>]
node infra/telemetry/register.mjs erase --repository <owner/name> [--apply]
node infra/telemetry/register.mjs import --register "$REG"
```

- **`list`** prints the counts by status, then one line per registration: its status, the suspension's reason, and which operator fields are set. It never asks the table for the key.
- **`suspend` and `resume`** are one `UpdateItem` each, with no deploy. `resume` removes the suspension's date and reason. Once the token path is built, a suspended key is refused on every endpoint and left out of every aggregate (plan 0008 §3.6). Until then the suspension is recorded and nothing enforces it.
- **`set`** writes your fields in one `UpdateItem`, and refuses an erased registration. A label follows `render.mjs`'s rules: the key's pattern, never a key, and unique. A refusal never echoes the label, which could be a key. `--first-review` takes the review row's `recorded_at` as the row holds it, and is refused past its 13 months (plan 0002 decision 18). `--page-reader true` is for Kanon's own registration alone (plan 0008 §2.2).
- **`erase`** is plan 0008 §7's erasure, run by you. Without `--apply` it counts the rows by lane and writes nothing. With it, the registration's `status` becomes `erased` at once. Then `erase.mjs`'s walk deletes every partition of the key, and a second walk checks that nothing is left. Only then are the key item and the registration replaced by the tombstone. Run it again to finish an erasure that stopped. **Until the token path is built**, the writer role still writes through today's path, so remove the entry from the register file and deploy first, as [Erase an adopter](#erase-an-adopter) says.
- **`import`** is plan 0008 §9 step 3's one-time move from the register file. It checks the file as `render.mjs` does, then reads each repository's id, owner id and default branch from GitHub with `gh api repos/<owner>/<name>`. If an entry can't be resolved, or GitHub spells its name differently, the import stops before it writes anything. Each registration and its key item are written in one transaction, each conditional on not existing. **Every key is kept exactly**, and `aggregate_invoker`, `publish_own_figures_as` and `first_review` are carried across. A rerun leaves an imported registration as it is. A repository already registered under another key is refused, and so is a key already registered to another repository. After the import, set `--page-reader true` on Kanon's registration.

`tests/unit/telemetry-register.test.ts` runs every subcommand against a register full of keys. Each `aws` call answers with an error that quotes every key, and the test checks that no line on either stream holds one.

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
- **`own`:** for each adopter that declares a label, its registration's `publish_own_figures_as` in the register table ([The token URL](#the-token-url-plan-0008-j4)), the same cells from its rows alone, under its label. They are that adopter's figures, not cross-adopter ones.
- **`signals`:** the last 7 days' runs that did not end `ok`, by lane, reason, failed stage, Kanon error and Kanon version, with how many adopters each affected. No cost and no run count.

Nothing names an adopter or carries a key; the function refuses to answer output that holds one. It takes no input but the name of [the page view](#the-page-view), so a caller can't narrow a figure to one adopter, and it answers only a registered invoker role in this account (403 otherwise), or a token on [its token URL](#the-token-url-plan-0008-j4). A failed read answers 502 and logs only the operation and AWS's error code, such as `aggregate: failed (Query AccessDeniedException)`, for its `Query`, `Scan` or `GetItem`.

### The token URL (plan 0008 J4)

[Plan 0008](plans/0008-self-service-registration.md) §3.6 puts the aggregate function on GitHub's OIDC token, and on the register table instead of its environment. **The Explorer's lane reads it from vM** (J5, [The Explorer's lane](#the-explorers-lane)). Kanon's metrics page moves to it in J7, after the deploy, and reads through the IAM URL until then.

- **Two URLs during the overlap** (§9). The existing one, `AggregateUrl`, stays on the unqualified function with `AuthType: AWS_IAM`, for every caller still on a role. The new one, the `AggregateTokenUrl` output, is on an alias of its own, `live` (`$LATEST`), with `AuthType: NONE`. The function tells them apart by the alias in the ARN Lambda invoked, never by the request. It refuses a bearer token on the IAM URL, and on the token URL it refuses an IAM-shaped request and any request without a token (401 `token`). Any other alias answers 403.
- **Who the token URL admits.** `verifyToken` ([The token verifier](#the-token-verifier-plan-0008-j1)) checks the token for the `aggregate` endpoint: the Explorer's `agent-explore-telemetry.yml` at a release no older than `MinTokenVersion`, on its registration's default branch. Then the caller's registration, one `GetItem` projected to exactly the aggregate role's `GetItem` fields, must be `active` (403 `suspended`, 410 `erased`) and have `aggregate_invoker` set by `register.mjs set` (403 `invoker`). The flag is read from the table and never from the token. Such a caller may ask either view. A refusal answers its code alone, with `WWW-Authenticate: Bearer error="invalid_token"` on a 401.
- **Kanon's metrics page, for the page view only** (§2.2's exception, the Owner's decision 11 of 2026-10-12), behind an operator flag. A token that the verifier refuses at check 7 is admitted to `?view=page`, and to nothing else, only when all of these hold: its `workflow_ref` is exactly `yedeya-labs/kanon/.github/workflows/metrics-page.yml` at the registration's `default_ref`; its `job_workflow_ref` is absent or equal to that; checks 8 and 9 pass, with no allowance for a moved branch; the registration is active; and the registration has `page_reader` set by `register.mjs set --page-reader true`. Any other view answers 403 `workflow`. **Until you set `page_reader` on Kanon's registration, the exception admits no one.**
- **Whose rows are read, on both URLs.** The keys come from one `Scan` of the register table, projected to exactly `pk`, `key`, `status` and `publish_own_figures_as`. A container keeps the scan for 5 minutes. Every `active` registration is aggregated, and its `publish_own_figures_as` decides its `own` label and whose partitions the page view reads. **A suspended or erased key's partitions are never read,** so its rows are in no cell, no signal and no page view, within 5 minutes of `register.mjs suspend`. Adopters are counted by key, so three repositories of one owner make a cross-adopter cell (Owner decision 7 of 2026-10-12). A label that equals any key in the table, whatever that key's status, or that two registrations share, stops the answer with 502.
- **The IAM path changes too.** It still checks the invoker role against `INVOKER_KEYS` from the environment. Its keys and labels now come from the table, and the role's key must have an `active` registration (403 `suspended`, 404 `not-registered`). `AGGREGATE_KEYS` and `OWN_FIGURES` are still rendered, but the function no longer reads them. **So the ingest function's deploy order holds here too:** this code arrives in the same deploy as the table and J3 (plan 0008 §9 step 2), and until the Owner runs `register.mjs import` right after production deploys (§9 step 3) the aggregate answers no cells, and the invoker roles get 404. The import carries `aggregate_invoker` and `publish_own_figures_as` across.
- **Parameters.** The ingest function's token path's own `Audience` and `MinTokenVersion`, one definition each for both functions. `MinTokenVersion` is empty by default, and while it is, the token URL answers every token 503 `config`, as the ingest function's does. Set it to the release that ships the token path. Reserved concurrency (`ReservedConcurrency`, 2 by default) now applies to the aggregate function too, since its token URL is public (§12).
- **Tests.** [`telemetry-aggregate.test.ts`](../tests/unit/telemetry-aggregate.test.ts) and [`telemetry-aggregate-page.test.ts`](../tests/unit/telemetry-aggregate-page.test.ts) sign tokens with a key pair made in the test (`tests/unit/helpers/aggregate-register.ts`), and fake the register the way IAM holds it: a `Scan` or `GetItem` outside the role's projection answers 400.

**You can compute the same thing yourself,** with your role, plus the totals only you see (`notes`: the cells withheld under the threshold, and the runs left out for no model or no cost). The totals cover every adopter, so they never leave you:

```sh
node infra/telemetry/aggregate.mjs --register "$REG" --profile kanon
```

It walks `<key>#<lane>` for every key in the register and every lane in the enum, so it needs no scan. Plan 0003's indicators are in [the page view](#the-page-view), for declaring adopters only; the time from install to first review is not in it yet.

### The page view

Plan 0003 M7 ([#661](https://github.com/yedeya-labs/kanon/issues/661)): what the [public metrics page](metrics.md#the-public-metrics-page) shows, asked for by name with `GET ?view=page`. Without a query the function answers as above, so every pinned Explorer keeps reading the same answer; any other query answers 400.

For each adopter that declares a label, its registration's `publish_own_figures_as` in the register table ([The token URL](#the-token-url-plan-0008-j4)), and no other, it reads the adopter's lane partitions and its work-item partition, `<key>#work`, and computes plan 0003's report over them with the report's own code (`scripts/metrics/indicators.mjs`, linked into the function's package, as `schema.mjs` is): the headline over the last 28-day window, by band when the band validity check passes and pooled otherwise; the trend over six windows; and the Kanon-version view. Each entry is one adopter's figures under its label, `adopters: 1`; no work-item figure combines adopters, so an adopter that did not declare is in none of it, and the threshold of three and the subtraction guard hold as they do for `own`. Every estimate below its minimum sample answers `not-enough-data` with its count. The answer names the window, the band version, the cost basis, the minimum samples and the bootstrap's resamples and seed. Nothing in it is text: `scripts/aggregate-read.mjs page` refuses any key the view doesn't have and any string that isn't a status, a date or a version.

The role's projection holds the work-item fields the report reads (`pr_number`, `closed_at`, `fate`, `closing_issues`, the three size fields, `author_kind`, `revert_days`, `first_fix_days`, `first_verdict`, `human_commits`, `human_cr_after_approval`), and the run rows' `pr_number` and `issue_number` for the join. **A store deployed before this release has neither the page view nor this projection**, and the page's read refuses what it answers, so redeploy it, as in [Deploy the aggregate function](#deploy-the-aggregate-function), before the first page is generated.

### Deploy the aggregate function

The Owner's to run; agents run none. It costs about a cent a month (plan 0002 decision 10's terms, below).

1. **In the register,** on Kanon's entry, add `"publish_own_figures_as": "kanon"` and `"aggregate_invoker": true`. Any other adopter may ask for either, the same way. **Since plan 0008 J4, the function reads the label only from the registration** in the register table, which `register.mjs import` copies from this file once and `register.mjs set --publish-own-figures-as <label>` changes, so editing the file and rendering again no longer changes what is published ([The token URL](#the-token-url-plan-0008-j4)). `aggregate_invoker` in the file still matters during the overlap: it creates the invoker role and puts the key in `INVOKER_KEYS`, and the token URL reads the registration's own flag.
2. **Render, and read what it prints.** Besides each writer and reader, it prints `<owner>/<repo>: aggregate invoker trusts <subject>`, which must be the default-branch ref, like the writer's, and `<owner>/<repo>: own figures publishable as <label>` for each adopter the file declares; what is published follows the registrations instead (step 1). Check that only the adopters that asked are listed:

   ```sh
   node infra/telemetry/render.mjs --register "$REG" --out "$OUT"
   ```

3. **Package and deploy,** exactly as in [Deploy](#deploy). One package holds both functions.
4. **Read the outputs.** `AggregateUrl` is the function's URL, and `AggregateInvokerRole<id>` the invoker role's ARN, which an Explorer pinned below vM, and Kanon's metrics page until J7, take ([The Explorer's lane](#the-explorers-lane)); from vM the Explorer reads `AggregateTokenUrl` with GitHub's token instead:

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

   A 502 means the read failed: the function's log says `aggregate: failed (<Query|Scan|GetItem> <AWS error code>)`. `AccessDeniedException` there most likely means the role's projection condition refused the request, so compare `dynamodb:Attributes` in the template with `PROJECTION` in `function/aggregate.mjs` for a `Query`, or with `AGGREGATE_SCAN` and `AGGREGATE_GET` in `function/register-fields.mjs` for a `Scan` or a `GetItem`. `aggregate: failed (register)` means a registration it can't read, such as a label equal to a key.
6. **Check that no one else can call it.** An unsigned request to the URL gets 403 from Lambda:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' "<AggregateUrl>"
   ```

### The Overseer's cost view

The Overseer's weekly token trend and its prompt-cache facts are computed from a repository's own rows (plan 0002 §6; the Owner's decision on [#470](https://github.com/yedeya-labs/kanon/issues/470)). Its lane, `agent-overseer.yml`, has a `telemetry` job, the only one of the lane besides its QA store job that holds `id-token: write`. **From vM it reads through the store's `GET /v1/rows/self`** ([The token path's endpoints](#the-token-paths-endpoints-plan-0008-j3); plan 0008 §3.5, J5), with a fresh GitHub OIDC token for the store's audience on every request: no role, no secret, and no key, which the store never returns. It reads each of Kanon's lanes' rows for the last 14 days, projected to the fields the two reports use, and writes `token-trend.md` and `cache-ttl.md` (`scripts/overseer-telemetry.mjs`, with the reports in `scripts/lib/token-trend.mjs` and `scripts/lib/cache-ttl.mjs`, moved from the reference adopter's two readers of §1.4). Only the two files reach the agent, as an artifact kept one day; no row is printed or handed on. The job's last step reports plan 0003's headline indicators through the same endpoint ([#668](https://github.com/yedeya-labs/kanon/issues/668)): [`kanon metrics report`](metrics.md#kanon-metrics-report) over the repository's work items, whole, and each lane's rows over thirteen months, to the job's summary only. A partition the store refuses or fails to answer withholds the report, naming it. The store admits the token from `agent-overseer.yml` whichever of its jobs minted it (plan 0008 §2.2), so the id-token guard holds both jobs that can, `telemetry` and the QA store's `export`, to their exact steps (`tests/unit/helpers/store-jobs.ts`).

`cache-ttl.md` also says how each pinned lane's pin is doing, from the rows that record it ([#546](https://github.com/yedeya-labs/kanon/issues/546)). A run row records the TTL its run was pinned at, `prompt_cache_ttl`, from run row version 3. For each lane and pin, the file says how many of those rows still wrote cache at the other TTL, which means the pin didn't take effect. For a five-minute pin it also says how many idled over 300 seconds in total. Total idle is `duration_ms` less `duration_api_ms`, an upper bound on the longest gap. A row written before version 3 doesn't record its pin, so it is counted as it was before, by Kanon's lane definitions, and not checked.

**Deploy from the release that ships run row version 3, before any repository's pin reaches it.** Its lanes write `schema_version: 3` or later on every row that records its TTL (version 4 when the row also carries one of version 4's counts), and an ingest function deployed from an earlier release refuses that version: it answers 422 and the collector turns red. Render, package and deploy from that release's tag, as in [Deploy](#deploy). The function still accepts version 2, so a repository on an older release is unaffected. A row that records no TTL is still written at version 2, so the blocks smoke's row, which Kanon writes at the running commit on every pull request and push, doesn't fail a collector pinned at an older release.

**Only with consent.** The lane's gate job reads the default branch's workflows, and the `telemetry` job runs only when one of them calls Kanon's collector: the caller is the repository's consent (ADR 0007, plan 0008 §3.3), so a repository that didn't opt in never mints a token for the store. Without one the audit says the read is `not configured`, which it reports as such and never as a missing store; it says the same while the hosted store's URL is not published in the release the caller pins ([Publish the hosted URLs](#publish-the-hosted-urls)), and when the store answers 404 `not-registered`, before the collector's first run. Any other refusal (`suspended`, `erased`, a dispatch from another branch, 403 `ref`) is a `failed` read, said in the store's code, and green. On the runtime-version trigger, whose `pull_request_target` token the store refuses, the job doesn't try: the audit says the read was `not run on this trigger` (the Owner's decision on [#499](https://github.com/yedeya-labs/kanon/pull/499)).

**Nothing to set.** The lane still declares the old `KANON_TELEMETRY_READER_ROLE` secret, read by no job, so a caller that maps it keeps starting when its pin moves to vM; drop the line then (plan 0008 §9 step 4). The release after vM removes it. The `KANON_TELEMETRY_TABLE` and `KANON_TELEMETRY_REGION` variables ([#499](https://github.com/yedeya-labs/kanon/pull/499)) are read no more.

**A self-hosted telemetry store** is named by two repository variables together, never one without the other, as the collector's `url:` and `audience:` are ([Collect the rows](#collect-the-rows)). **A repository whose collector's caller names a store of its own** with `audience:` must set them: its caller is consent to its own store, not to Kanon's, so until both are set the gate reads `unknown`, the read is `failed`, and the warning names the two variables. **A caller still passing `url:` or `writer-role:` without `audience:`**, as every caller written before vM does, a hosted adopter's included, is refused the same way, since its store can't be told: the warning gives both ways out, as doctor's `telemetry.legacy-inputs` does: `kanon init --telemetry` writes the new caller for Kanon's hosted store, or `audience:` and the two variables name a store of your own ([Moving a caller from the SigV4 path](#collect-the-rows)). No token is ever minted for the hosted store on a caller's behalf until its caller sends there (`K-OBS-18`; [Owner decision 2026-10-14 (#842)](plans/0008-self-service-registration.md#owner-decision-2026-10-14-842)):

```sh
gh variable set KANON_TELEMETRY_TOKEN_URL -R <owner>/<repo> --body '<its IngestTokenUrl output>'
gh variable set KANON_TELEMETRY_AUDIENCE -R <owner>/<repo> --body '<its Audience parameter>'
```

The gate checks them before any token is minted: one without the other, a URL that isn't a function URL, or the hosted audience with another URL makes the read `failed`, naming the variable. The read masks a self-hosted URL before its first request.

### The Explorer's lane

The Explorer's telemetry mode, `agent-explore-telemetry.yml` (plan 0004 step 14, [docs/lanes.md](lanes.md#explore-the-telemetry)), reads the aggregate. Any repository whose registration sets `aggregate_invoker` can install it. **From vM its `aggregate` job, the only job of the lane that holds `id-token: write`, reads the function's token URL** ([The token URL](#the-token-url-plan-0008-j4); plan 0008 §3.6, J5): it mints a fresh GitHub OIDC token for the store's audience, sends it with a `GET` (`scripts/aggregate-read.mjs token`), and refuses an answer with any key the function never answers, or a threshold under three. It hands the checked answer to the agent's job, which holds no credentials, as an artifact kept one day. The function admits the token from this workflow file whichever of its jobs minted it, so Kanon's id-token guard holds that job to its exact steps, Kanon's path, the read and the upload (`tests/unit/helpers/store-jobs.ts`). A refusal is red, in the store's code: 403 `invoker` without `aggregate_invoker`, 404 `not-registered` before the collector's first run.

**Nothing to set** for the hosted store. No role, no secret and no variable. The gate (`scripts/explore-telemetry-check.mjs`) reads the default branch before any token is minted: without a workflow calling Kanon's collector it skips, green, a collector's caller that names a store of its own with `audience:` stops the gate, by name, until `KANON_AGGREGATE_TOKEN_URL` and `KANON_TELEMETRY_AUDIENCE` name that store, and one still passing `url:` or `writer-role:` without `audience:`, as callers before vM do, stops it with both ways out (`kanon init --telemetry` for the hosted store, or `audience:` and the two variables for your own). Neither is ever sent to the hosted store (`K-OBS-18`, #842). The lane still declares the old `KANON_AGGREGATE_ROLE` secret, read by no job, so a caller that maps it keeps starting when its pin moves to vM; drop the line then, with the `KANON_AGGREGATE_URL` variable (plan 0008 §9 steps 4 and 5). The release after vM removes it. While the hosted store's URL is not published in the release the caller pins, the lane's gate says so in a notice and stops, green. **A self-hosted store's aggregate** is named by two repository variables together, `KANON_AGGREGATE_TOKEN_URL` (its `AggregateTokenUrl` output) and `KANON_TELEMETRY_AUDIENCE` (its `Audience`); one without the other stops the gate, by name. The token is masked before anything prints; a self-hosted URL is masked by the read before its first request, so it prints once per run, in the read step's header ([#433](https://github.com/yedeya-labs/kanon/issues/433)).

**Kanon's metrics page still reads with SigV4 until J7** (plan 0008 §9 step 4a): its `aggregate` job assumes Kanon's invoker role, `KANON_AGGREGATE_ROLE`, and calls `KANON_AGGREGATE_URL`, the stack's `AggregateUrl`, with `scripts/aggregate-read.mjs page`, whose SigV4 way the release after vM removes. Its two settings stay in Kanon's repository until it moves.

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
  --trees <trees.json> --register <register.json> [--issues <open-issues.json>] --json
```

- **One issue per signature.** It runs `detect` over the run rows, unchanged, and groups the findings by the signals' own `signature()` (§2.4). A finding with a signal's signature goes on that signal's issue, below its counts, so the job updates the one issue and files no second. Every later finding with the signature is one more entry on it. A finding with no signal gets an issue of its own, with a title built from its codes. Each issue is labelled `kanon-bug` and `finding`, plus the signal's class label (`platform` or `adopter`) when it has one.
- **The gate.** Each finding is checked again at the release the job pins:
  - `validate`;
  - the scrub's `verify` on its text, with that key's name hashes (from the register, as `render.mjs` builds them for intake) and the release's tree;
  - an adopter key, as a field's value or as a word in it;
  - each `kanon_paths` entry against the file list of its `kanon_version`.

  A finding that fails is still filed privately, marked `gate: failed` with the field and rule, and labelled `gate-failed`. Its text, and any path outside the tree, are left out of the issue.
- **What the open issues already say** ([#611](https://github.com/yedeya-labs/kanon/issues/611)). `--issues` is the open issues, as `gh issue list --label kanon-bug --state open --limit 1000 --json title,body` prints them, each found by its `kanon:bug-signature` marker. `gh` returns 30 issues without `--limit`, and stops at the limit without saying so, so the job fails when it gets exactly 1000: an issue left out of `--issues` loses its earlier counts and its expired-findings note. The job replaces a body it updates, so a body is built to keep what this run's rows can't give again:
  - a finding whose signal isn't in this run's rows, because its run rows have expired or this run read none, keeps the counts its issue last had, under a line saying they are from an earlier run, and keeps the issue's title and class label;
  - an issue that held findings, none of which is in the store any more (expired after 13 months, 30 days at `test` or `smoke`, or erased), says so in place of the entries, on that run and every later one. Their evidence is no longer shown.

  Without `--issues`, a finding with no signal in the run rows gets a finding-only body, and an issue whose findings expired is left to the signal's own body.
- **Errors.** A refusal for a key prints `refused: the output would hold an adopter key, so nothing is printed`, exit 2. Any other error while planning prints `could not plan the issues (<its name>)`, exit 1: its name only, since its message could quote a row.
- **The tree.** `--trees` maps each release to its file list, as `git ls-tree -r --name-only v<version>` prints it from a Kanon clone. A release with no list, `dev` included, fails any finding of it that carries a path or a text.
- **What leaves.** Signals and rises come out exactly as `kanon-bugs.mjs` returns them, so a public issue never holds a finding. The evidence and suggested fix appear only in the private issue, and only for a finding that passed the gate. The whole output is checked for every key in the rows and the register, as a value and as a word, and refused whole if one appears. `tests/unit/kanon-findings.test.ts` proves each check.

## Kanon's health

[Plan 0003](plans/0003-metrics.md) M8: the group 9 measures Kanon computes itself (§4, "Group 9, field by field"). [`scripts/metrics/health.mjs`](../scripts/metrics/health.mjs) computes them and renders the health view. It is pure, like the rest of the metrics module. [`scripts/telemetry/kanon-health.mjs`](../scripts/telemetry/kanon-health.mjs) reads Kanon's repository through `gh`, read-only, and prints the view, or one `kanon-health/v1` JSON document with `--json`.

```sh
node scripts/telemetry/kanon-health.mjs [--rows <rows.json>] [--json]
```

- **Disputed rules** (decision 15). These are issues filed with the [Dispute a rule](../.github/ISSUE_TEMPLATE/rule-dispute.yml) form, counted open and closed per rule id. A dispute is recognised by the heading GitHub writes for the form's rule field, `### Disputed rule`, so it needs no label. A rule id is shown only when the rulebook has it (`RULE_IDS`). Anything else in the field is counted as unreadable and never printed.
- **Time to fix Kanon's own bugs.** These are the issues [#41's job](#kanons-own-bugs) files, recognised by its `kanon-bug` label and its `kanon:bug-signature` marker together. Two times are measured from filing:
  - to the close, for each issue closed as completed;
  - to the first release that contains the fix. That is the first release published at or after the fix merged, where the fix is the pull request or commit that closed the issue. Kanon releases from one branch, so a release cut after the merge holds the fix.

  An open issue, or one closed as not planned or as a duplicate, is counted and left out of both times. So is a fix that is in no release yet, and a close with no pull request or commit behind it. Each time is shown as a median and a 90th percentile, in days, with its count.
- **Upgrade lag.** This needs the run rows (`--rows`, the same input `kanon-bugs.mjs` reads). It compares each adopter's newest `kanon_version`, the highest release on its `tag: run` rows, with Kanon's releases published by then. It counts how many releases are newer, and how many days have passed since the first of them came out. Only adopters still running Kanon are measured: an adopter whose newest `tag: run` row was recorded more than the aggregate's window (`WINDOW_DAYS`, 28 days) before then is left out, and one recorded exactly at the window's edge is kept (the Owner's decision, 2026-10-12, #670). `dev` rows and rows without a version count toward that, but never toward the version. The figure combines adopters, so it is shown only as a distribution (median and 90th percentile), and only when at least `MIN_ADOPTERS` adopters contribute. That is the aggregate's three-adopter rule, imported, not restated. With fewer, it is withheld, and the view doesn't say how many adopters there are. The output holds numbers only, never a key.

The view is a section of the public page ([plan 0003](plans/0003-metrics.md) §6.1, M7). `tests/unit/kanon-health.test.ts` seeds a dispute and a #41 issue, and checks that each appears in it.

## The importer and the backfill role

These roles are created only for their step and deleted after it (§7). Add `--importer` (S5) or `--backfill` (S7a) to `render.mjs`, package and deploy, and the function accepts that role. Such a caller names the adopter's key as `?key=<key>` on the URL, and the key must have an `active` registration in the register table (a suspended one is refused, 403 `suspended`). Neither role's rows count against the key's quotas (plan 0008 §6):
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

The export holds the adopter's rows, so it stays beside the register, out of every repository where Kanon's lanes run ([Where the register lives](#where-the-register-lives)). The dry run prints counts, field names and enum values only, and exits non-zero while any row stops; plan 0002 §7 lists what stops a row.

**The work-item backfill (S7a, [plan 0003](plans/0003-metrics.md) M5)** derives a repository's work-item rows with the collector's own step, over one span from `--since` to now, read with the Owner's `gh` token. It sends them as the backfill role:

```sh
node infra/telemetry/backfill.mjs --repo <owner/name> --since 2026-09-04
node infra/telemetry/backfill.mjs --repo <owner/name> --since 2026-09-04 --key <key> --apply --profile kanon
```

`--caller` names the repository's collector caller under `.github/workflows` (default `telemetry.yml`), whose pin at each merge gives the row's `kanon_version`.

The dry run prints M5's check, counts only. For each month, it shows the pull requests closed, from GitHub's own listing with release PRs left out, beside the rows derived. Earlier items whose rows the span rewrites are counted apart. It exits non-zero when a month differs or the step failed, and `--apply` sends nothing when the step failed. A re-sent row overwrites itself, so a span that overlaps the collector's is harmless.

When `--apply` can't reach the store, either script prints one `send failed:` line to stdout and exits non-zero. The line names the `aws` call that failed and why: an expired or missing session, with its `aws sso login --profile <profile>`, or a stack or role that isn't deployed. It never names the key, the account id or a role's ARN.

## Cost and paging

Plan 0002 §9 estimates about $0.05 a month, under a $1 ceiling watched by the account's budget alert. The template creates nothing outside that estimate:
- on-demand DynamoDB, with the AWS-owned key for the rows table and the AWS-managed KMS key for the register table, which has no key fee and a few KMS requests a month at most (plan 0008 §12);
- two functions, ingest and aggregate, with no schedule, no VPC and no NAT;
- two log groups kept 30 days;
- IAM roles and the OIDC provider, which are free;
- the ingest function's two aliases and its public `live` URL (plan 0008 J3), which are free; a flood of refused requests is bounded by the reserved concurrency, which plan 0008 §12 makes a precondition of admitting tokens.

The aggregate function adds about a cent a month (§6.1): a weekly call reads every run row in full, because DynamoDB bills a projected query by the size of the items it reads, which at §9's 52,000 held rows is about 9,000 read units a call. Its compute stays inside the free tier.

The test that parses the template fails if any other resource type appears. The one addition is the artifacts bucket, a few kilobytes, which costs nothing measurable.

**No alarm** (`K-OBS-4`). A rejected or failed write turns the collector red, and that red run is the page. A collector that stops running is not paged, as the reference adopter decided.
