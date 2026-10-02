# Plan 0002: the hosted telemetry store

- **Status:** proposed, 2026-10-02. Nothing in it is built until the Owner approves the cost (§9).
- **Tracks:** #32. **Governed by:** [ADR 0007](../decisions/0007-data-boundary.md) (the data boundary), `K-OBS-13`, `K-OBS-16` to `K-OBS-18`, [ADR 0009](../decisions/0009-move-dont-rewrite.md) (move, don't rewrite), and #19 (the cloud-neutral store interface).
- **Measured on** the reference adopter's main branch, and Kanon's, on 2026-10-02. The commands are in [Measurements](#measurements). Two numbers need AWS or GitHub access this plan did not have; they are marked **not run**, with the command the Owner runs.

## The plan in one paragraph

**Today.** Every agent run writes a 52-field telemetry row and uploads it as an artifact. In the reference adopter, one hourly collector job pushes each row into a DynamoDB table in that project's staging account, under `COST#<agent>` partitions. Two of the stored fields are free text that `K-OBS-16` forbids, seven more are unvalidated strings, and nothing checks the row on the way in.

**Where it ends.**
- **One store in a new Kanon AWS account, in Frankfurt.** A DynamoDB table, written only by a small validating function.
- **One fixed schema, version 2.** Fifty fields, every string an enum or a strict pattern, and a reason code instead of a sentence. The function rejects any row with a field outside the list.
- **Per-repository roles through GitHub OIDC.** No stored secrets. A writer role can only call the function, and the function takes the partition from the role, never from the row. A reader role can only query its own partitions.
- **The reference adopter's history moves in once,** cleaned, through the same function.

**How it gets there.** Kanon changes the row first. The store is built and tested with Kanon as its first adopter. The reference adopter's collector writes to both stores for a week, its history is imported, its readers switch, and only then does the collector move into Kanon. The store is live before step 6 of [plan 0001](0001-move-the-agent-lanes.md), so Kolophon's first lane run writes there and nowhere else.

## 1. What exists today

### 1.1 The row

`actions/agent-telemetry` (Kanon v0.5.0, moved unchanged from the reference adopter) writes one JSON row per run: **52 leaf fields**, one of which (`models`) is an array of seven-field objects. The collector stores **45 of them** as DynamoDB attributes, plus the key. The raw row also goes to S3 whole.

**No field holds a GitHub username.** The normaliser reads no actor or login. The `agent` value is a lane name the workflow passes in, and in the reference adopter all 15 values are lane names. **No field holds a file path:** `issue_paths_named` is a count.

**What breaks ADR 0007 rule 1:**

| Field | Stored? | Problem |
|---|---|---|
| `reason` | yes | **Free text.** A sentence from the classifier with the model id and numbers in it, for example `` `claude-opus-…` never ran (modelUsage: …, num_turns 1, …) ``. |
| `workflow` | yes | **Free text.** The adopter's own workflow name. |
| `job` | S3 only | **Free text.** The adopter's own job id. |
| `agent` | yes (and in the key) | Unvalidated string. Safe today because the reference adopter passes lane names. Kanon's smoke workflow passes `smoke`. |
| `outcome_label` | yes | Unvalidated string. Today it is only the Reviewer's `APPROVED` or `CHANGES_REQUESTED`. |
| `severities` | yes | Unvalidated packed string, `critical:0,high:1,…`. |
| `model`, `configured_model`, `model_arg` | first two | Unvalidated strings. Model ids in practice. |
| `terminal_reason`, `autocompact` | yes | Unvalidated strings from the CLI and the flags. |
| `commit` | yes | Not content, but not on rule 1's list, and no reader uses it. |

Everything else is a number, a boolean, or a value from a closed list (`outcome`, `execution_file_form`, `effort`, `trigger`). Many of those are still **not on rule 1's list** (run id, sizes, configuration). Decision 2 deals with that.

### 1.2 How rows reach the store

- **Each lane uploads** an artifact named `agent-telemetry-<agent>-<run id>-<attempt>`, kept 7 days. The lane holds no store credentials (`K-OBS-13`).
- **The collector** (`agent-telemetry-collect.yml`, 294 lines of script) runs **hourly at minute 40**, and on demand. It lists the repository's artifacts in one paginated call, takes every `agent-telemetry-*` one since the start of the last successful sweep (floored at 90 minutes, capped at 7 days), downloads each **by id**, and runs `push-run.sh telemetry` on each row.
- **`push-run.sh`** writes the raw row to S3 at `telemetry/<agent>/<ts>.json`, and one DynamoDB item at `COST#<agent>` / `<ts>`. The key comes from the row's `recorded_at`, so a re-sweep overwrites identically.
- **Any failed push turns the collector red.** That red run is the page. A collector that stops running is not paged, and the reference adopter records that as a decision.
- **Credentials:** `id-token: write` and `environment: qa`, assuming the reference adopter's QA role. That role is trusted for `repo:<owner>/<repo>:environment:qa` and can also write the QA data, delete one QA partition, and call Bedrock. **The collector holds far more than telemetry needs.**

### 1.3 The store

- **Where:** the reference adopter's infrastructure code, **only on its staging stage**, in `us-east-2`, in the staging AWS account. `retainOnDelete` on the table and bucket. One staging teardown already emptied the bucket once.
- **The table:** single-table design, `pk` and `sk` strings, on-demand billing. Telemetry is the `COST#<agent>` partitions; the same table holds QA data (`RUN#`, `COVERAGE`, `PRECISION`, `AREAS`).
- **How far back:** the first `COST#` rows were written on **2026-09-04**, when telemetry shipped. Attributes added later are absent, not zero, on earlier rows: `duration_api_ms` from 2026-09-17, `cache_write_5m_tokens` and `subagents_completed` later, the issue-size fields from RA-2137.
- **Row count: not run.** No AWS credentials were available. The reference adopter's own documentation reports **249 rows over 6 days** (2026-09-18 to 2026-09-23), about **42 a day**, which puts the store at roughly **1,200 rows** today. That is quoted, not re-measured. The Owner's commands are in [Measurements](#measurements).

### 1.4 Every reader

| Reader | When | What it reads |
|---|---|---|
| `token-trend.mjs` (the weekly cost report) | Overseer job, Mondays 07:00 | every `COST#<agent>` partition in full: outcome, model, effort, fingerprint, cost, tokens, durations, and the size fields |
| `cache-ttl-check.mjs` | Overseer job, weekly | every partition: `sk`, `outcome` and the three cache-write fields |
| `dispatch-sweep.mjs` | daily, 04:40 | the lanes' partitions since a cutoff, projected to `sk`, `issue_number`, `outcome`, `run_id` |
| The Overseer agent | weekly | any partition, ad hoc, through `aws dynamodb query` in its prompt |
| The weekly and project digests | — | **nothing.** They mention cost rows in comments only. |

The partition list comes from `qa-store.mjs`, which scans the workflows for `agent:` names. One reader may already read nothing: the dispatch sweep assumes the QA role without declaring `environment: qa`, which the role's trust requires. Its read is non-fatal by design. **Not run:** its "Configure AWS credentials" step log would settle it. Either way, the new reader trust must name that job's subject (§6).

## 2. The schema (decision 1)

### 2.1 The fixed field list

**Version 2. Fifty fields. Each is optional unless marked required. No nesting.** Field names are the reference adopter's stored attribute names wherever one exists, so its readers keep their column names.

| Group | Fields | Type |
|---|---|---|
| **Row** | `schema_version` (required, `2`); `tag` (required, §2.4); `recorded_at` (required) | integer; enum; ISO-8601 UTC |
| **Run** | `run_id`, `run_attempt` (both required); `trigger`; `pr_number`, `issue_number` | integers; GitHub event name from GitHub's documented list |
| **Who** | `role` (required): `explorer`, `implementer`, `reviewer`, `merger`, `lead`, `overseer`; `lane` (required): Kanon's lane names | enums |
| **Outcome** | `outcome` (required): `ok`, `unavailable`, `exhausted`, `failed`, `not-reached`; `reason` (required, §2.3); `execution_file_form`: `ok`, `no-path`, `absent`, `unparseable`, `no-result-event`; `terminal_reason`; `is_error`; `api_error_status`; `verdict`: `approved`, `changes_requested` | enums; boolean; integer 100 to 599 |
| **Configuration** | `model`, `configured_model`; `effort`: `low`, `medium`, `high`, `xhigh`, `max`; `max_turns`; `autocompact`; `config_fingerprint` | model id pattern `^[a-z0-9][a-z0-9.-]{0,63}(\[1m\])?$`; enum; integer; `auto` or `^\d+[km]?$`; `^[0-9a-f]{12}$` |
| **Cost** | `total_cost_usd`; `num_turns`, `duration_ms`, `duration_api_ms` | number 0 to 1,000; integers |
| **Tokens** | `input_tokens`, `output_tokens`, `total_input_tokens`, `thinking_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_write_1h_tokens`, `cache_write_5m_tokens` | integers |
| **Behaviour** | `permission_denials`, `subagents_spawned`, `subagents_completed`, `subagents_failed`, `subagents_max_depth` | integers |
| **Work size** | `changed_lines`, `changed_files`, `issue_body_chars`, `issue_paths_named`, `produced_lines`, `artifacts_filed`, `severities_critical`, `severities_high`, `severities_medium`, `severities_low` | integers |

Every integer is non-negative and bounded below 2³¹. `terminal_reason` is an enum that starts from the values found in the reference adopter's history (§7 lists them in its dry run), plus `other`. The normaliser maps any new CLI value to `other`, so a CLI release can't make rows fail.

**What version 1 had that version 2 drops:** `reason` as a sentence, `workflow`, `job`, `commit`, `agent`, `outcome_label`, `severities` as a string, `model_arg`, `additions` and `deletions` (their sum, `changed_lines`, stays), and the per-model `models` array. None of them has a reader in the store. The sentence stays where it is useful: in the run's step summary, which never leaves the adopter.

**Set by the store, never by the row:** the adopter's key, `source` (`collector` or `import`), `received_at`, and `expires_at`. A row that sends any of them is rejected.

### 2.2 The version field

`schema_version` is required. The store accepts each version it lists, each with its own field list. A new version is a Kanon release that adds a list; the old one stays accepted until no supported Kanon release writes it. Readers see the version on every row.

### 2.3 Reason codes

The classifier in `actions/agent-classify` already returns one of five kinds and a sentence. Its six branches build seven sentence templates (the `unavailable` branch has two). Each template becomes a code, returned beside the sentence:

| Outcome | Code | Branch today |
|---|---|---|
| `ok` | `none` | finished on the configured model |
| `unavailable` | `model_never_ran` | errored, and the configured model is absent from `modelUsage` |
| `unavailable` | `no_model_ran` | errored, with no configured model to look for |
| `exhausted` | `turn_cap` | `terminal_reason: max_turns` |
| `exhausted` | `budget_cap` | `terminal_reason: budget_exhausted` |
| `failed` | `did_not_finish` | errored, the configured model ran |
| `not-reached` | `no_result_file` | no result in the execution file; `execution_file_form` says which absence |

The store also checks the pair: a code is valid only with its outcome. Bail reasons (the Implementer's bail list) are not in the row today. When they are, they join this list in a new schema version.

### 2.4 Smoke and test rows

`tag` is required: `run`, `smoke` or `test`.
- `agent-telemetry` gains a `tag` input, default `run`.
- Kanon's smoke workflow passes `smoke`. Today it marks its row only by passing `agent: smoke`, which version 2 has no field for.
- `test` is for checks run against the store itself (§8, S3).

Smoke and test rows are stored, which proves the path end to end, but they expire after **30 days**. **Every read filters on `tag = run` by default, and every aggregate excludes the other tags, with no option.**

### 2.5 How the store rejects a field outside the list

**One schema module,** `actions/agent-telemetry/schema.mjs` (`node:` built-ins only), exports the field lists and a `validate(row)` function. The same file at the same tag is used three times:
1. **By the normaliser's tests:** every fixture's row must validate.
2. **By the collector,** before it sends a row, so a bad row fails the collector with the field's name.
3. **By the ingest function** (§4), which is the enforcement. A row with any field not in its version's list, a value of the wrong type, a string outside its enum or pattern, or a reason that doesn't match its outcome, is **rejected whole**, with HTTP 422 and the offending field **names**. The function never echoes values, so a bad row can't leak into a log.

Nothing strips unknown fields quietly. A row is stored as validated, or not at all.

## 3. Write authentication (decision 3)

**GitHub OIDC to an AWS role per opted-in repository. No stored secrets.**

**Each opted-in repository gets two roles:**

| Role | Trust policy conditions | May do |
|---|---|---|
| `kanon-telemetry-<key>-writer` | `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com`, and `token.actions.githubusercontent.com:sub` **StringEquals** `repo:<owner>/<repo>:environment:kanon-telemetry` | invoke the ingest function's URL. Nothing else. |
| `kanon-telemetry-<key>-reader` | the same `aud`, and `sub` StringEquals one of a listed set: `repo:<owner>/<repo>:ref:refs/heads/<default branch>`, plus `repo:<owner>/<repo>:environment:<name>` for each environment the adopter's readers run in | `dynamodb:Query` and `GetItem` on the table, where `dynamodb:LeadingKeys` matches `<key>#*` |

**Where the `sub` and repository conditions sit:** in each role's **trust policy**, generated by Kanon's infrastructure code from the register (§5). The repository appears only there. No wildcard ever covers the repository part.

**Why an environment for the writer.** `K-OBS-13` says only the collector holds the store's credentials. The `kanon-telemetry` environment, restricted to the default branch, is how that becomes true: only the collector job declares it. Without it, every job on the default branch could assume the writer role. This is the reference adopter's existing pattern, narrowed to one job.

**A renamed repository fails closed.** The `sub` no longer matches, the collector turns red, and the register is updated.

## 4. Shape: the ingest path (decision 4)

**Options considered:**

| Option | Schema enforced by | Verdict |
|---|---|---|
| **A.** The collector writes DynamoDB directly with its role | IAM's `dynamodb:Attributes` condition can limit *which attribute names* are written, but nothing in IAM can check a value. A sentence in `reason` would pass. | **Rejected.** Enforces the names by construction, the values only by review. |
| **B.** A small ingest function behind a function URL with IAM auth | the schema module, in the only code that can write | **Chosen.** |
| **C.** API Gateway with a JWT authorizer on the GitHub OIDC token, no AWS roles | the same function | Rejected for now. It works, but it moves "who may write" from IAM trust policies into Kanon's own code, and #32 decided roles. |

**Option B, concretely:**
- **One Lambda function** (Node 24, `node:` built-ins and the schema module) with a **function URL, auth type `AWS_IAM`**. Its resource policy allows only the writer roles.
- **The collector sends** up to 25 rows per `POST`, signed with SigV4 by the runner's `curl --aws-sigv4`. No SDK, no new dependency.
- **The function reads the caller's role** from the request context (`requestContext.authorizer.iam.userArn`), maps it to the adopter's key, and builds the key itself: `pk = <key>#<lane>`, `sk = <recorded_at as YYYYMMDDTHHMMSSZ>#<run id>-<attempt>-<pr or issue number, or 0>`. **The row can't name a partition**, so a writer can only ever write its own.
- **It checks** `recorded_at` is between 8 days ago and 10 minutes ahead, which is artifact retention plus slack, so a collector can't backdate rows.
- **It writes with `PutItem`.** A re-sent row has the same key and overwrites identically, as today.
- **It answers per row,** and the collector turns red on any rejection, which keeps today's paging contract.
- **Hard limits:** reserved concurrency of 2, and a body of at most 256 KB. An adopter writing garbage can fill only its own partition, slowly.
- **The table's resource policy denies `PutItem`, `UpdateItem`, `DeleteItem` and `BatchWriteItem` to every principal except the function's role and the Owner's erase procedure (§10).** So the function is the only writer by construction, not by convention.

## 5. Account, IaC and the interface (decision 5)

**The account.** A new member account, `kanon`, created by the Owner in the Owner's existing AWS organisation, from its management account. The Owner runs every AWS write in this plan; agents run none.
- A service control policy on the account **denies every region except `eu-central-1`**, for the services that are regional. That makes "kept in Frankfurt" a property of the account, not of a template. It costs nothing.
- One AWS Budgets alert at **$1 a month**, free (§9).
- The Owner reaches it through the organisation's existing single sign-on.

**The IaC: CloudFormation,** one template, deployed by the Owner with `aws cloudformation deploy`.

| Option | Why not |
|---|---|
| The reference adopter's own stack tool | It ties resources to an app and a stage, which is exactly the lifecycle that emptied the reference adopter's bucket. It would also make every adopter's QA store (`K-OBS-17`) depend on that tool and its version. |
| CDK | Needs a bootstrap stack in every account, and a CDK version Kanon would pin for every adopter. |
| Terraform or OpenTofu | Needs a state backend, which an adopter would have to create before Kanon's first stack: a second bootstrap. |

CloudFormation needs only the AWS CLI. AWS keeps the state. `DeletionPolicy: Retain` and deletion protection on the table make its lifecycle independent of the stack, which `K-OBS-17` requires. The Lambda code is packaged with `aws cloudformation package` from a Kanon release tag. The template lives at `infra/telemetry/` and is parsed by a unit test, like the actions.

**The register is not public.** The list of opted-in repositories, their keys, and their reader environments is a parameter file the Owner keeps outside the public tree. Publishing it would tell everyone who opted in. Kanon's public tree holds the template and an example register naming only Kanon. **Rows carry the opaque key, never the repository name,** so the table alone doesn't say whose rows it holds.

**Behind #19's interface.** The store is defined by four operations, and the AWS stack is their first implementation:

| Operation | Who | AWS implementation |
|---|---|---|
| `put(rows)` | the collector | `POST` to the ingest function |
| `query(lane, from, to)` | the adopter's own readers | a Kanon read helper over `aws dynamodb query` with the reader role |
| `erase(adopter)` | the Owner | §10 |
| `aggregate()` | the Owner | §6 |

The collector and the readers call the operations, never DynamoDB by name. The same template deployed in an adopter's own account is the **default, self-hosted** telemetry store that `K-OBS-18` requires: hosted telemetry is the same stack with more than one adopter in its register. The no-cloud implementation is #19's work.

## 6. Reads (decision 6)

**Each adopter reads only its own rows,** by construction: the reader role's `LeadingKeys` condition is the adopter's key. A query on another key is denied by IAM, not filtered by code.

**Reads at the start:** exactly the four in §1.4, through the read helper. Their changes are small:
- the partition is `<key>#<lane>` instead of `COST#<agent>`;
- the sort key's first 16 characters are today's whole sort key;
- the lane list comes from Kanon's lane enum, not from scanning workflows for `agent:`.

The dispatch sweep keeps its three-field projection.

**Cross-adopter aggregates: none published at the start.**
- The first one, when there is something to publish, is per lane and model: run count, and median and 90th-percentile cost per run, on `tag = run` rows only.
- A cell is published only when **at least three distinct adopters** contribute to it. Nothing names an adopter.
- It is computed by an Owner-run script, not on a schedule. The three first adopters are all the Owner's, so the Owner decides when aggregates mean anything (decision 7).

**The Owner, as operator, can read every row.** That is how the cross-adopter improvement work reads them. It is stated here so that rule 5 of ADR 0007 is read as being about adopters, which is what it says.

## 7. Migrating the reference adopter's history (decision 8)

**Once, cleaned, and through the same function,** so history passes the same validation as new rows.

1. **Export (Owner, read-only):** every item whose `pk` begins `COST#`, from the reference adopter's table in `us-east-2`. The S3 copies are not used. They carry the fields version 2 drops.
2. **Transform** (a Kanon script, `infra/telemetry/import.mjs`, with unit tests):
   - **`agent` → `role` and `lane`,** by the table below. An `agent` not in the table stops the import. Nothing is guessed.
   - **`reason` → code,** by matching the classifier's seven fixed sentence templates. A reason that matches none is **dropped** (the field, not the row) and counted, as the roadmap says.
   - **`outcome_label` → `verdict`, and `severities` → the four counts.**
   - **Dropped:** `workflow`, `commit`. Kept as they are: every other stored field, and **absent stays absent**.
   - **Added:** `schema_version: 2`, `tag: run`, and `recorded_at` from the old sort key.
3. **Dry run.** The script prints, per lane, the rows exported, the rows to import, the reasons dropped, and every distinct `terminal_reason`. These are counts and enum values only. They seed the `terminal_reason` enum and go into the import PR.
4. **Import** through the function, with an **importer role** only the Owner can assume. It may name the adopter key, and it accepts `recorded_at` up to 13 months back. It is deleted afterwards.

| Old `agent` | `lane` | `role` |
|---|---|---|
| `reviewer` | `review` | reviewer |
| `merge-reconcile` | `merge-reconcile` | reviewer (the reference adopter runs it as the Reviewer's App) |
| `implementer`, `implementer-revise` | `implement`, `implement-revise` | implementer |
| `triage-fix` | `triage` | implementer |
| `rebase-lane` | `rebase` | implementer |
| `lead`, `lead-revise`, `lead-split` | the same names | lead |
| `explorer`, `auditor`, `verify-acs` | `explore`, `code-audit`, `verify-acs` | explorer |
| `overseer` | `overseer` | overseer |
| `weekly-digest`, `project-digest` | the same names | overseer (they use no App; decision 9) |

**Readers switch** after the import and a week of dual writes (§8, S6): one change in the read helper, one in the dispatch sweep's `readCostRows`, and the Overseer's prompt. The old `COST#` rows stay read-only in the reference adopter's table until its QA data leaves the staging stage. They are not carried over a second time.

## 8. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **S1** | Kanon vN | The schema module (§2.5). `agent-classify` returns a code beside its sentence. `agent-telemetry` gains `tag` and `lane` inputs and uploads a **second** artifact, `kanon-telemetry-<lane>-<run id>-<attempt>`, holding the version-2 row. `K-OBS-16` is amended (decision 2). | Every fixture's version-2 row validates. **Mutations:** a row with one extra field, a `reason` sentence, or `reason: turn_cap` with `outcome: ok` each fails `validate`. The reference adopter's collector still matches only `agent-telemetry-*`, so after its Dependabot bump its next sweep pushes the same number of rows as the one before. |
| **S2** | Owner | Create the `kanon` account, the region SCP and the $1 budget. | `aws organizations list-accounts` lists it; a `describe` call in `us-east-1` from inside it is denied by the SCP; the budget exists. |
| **S3** | Kanon PR; Owner deploys | The template (§4, §5): table, function, URL, OIDC provider, table resource policy, and roles for Kanon, the reference adopter and the importer. A verify script ships with it. | The Owner runs the verify script, which sends `tag: test` rows: a valid row gets 200; a row with an extra field gets 422 naming that field; a row naming a partition gets 422; the reader role querying another adopter's key gets `AccessDeniedException`; a direct `PutItem` with the writer role is denied; the stored row's `expires_at` is 30 days out. |
| **S4** | adopter | **Prepare in the adopter** (ADR 0009 §4). Its collector also sends each `kanon-telemetry-*` row to the function, after its existing push. Its job gets the `kanon-telemetry` environment and the writer role, and keeps the QA role for the old push. | For one week, the hosted store's `tag = run` rows per lane equal the adopter's new `COST#` rows per agent over the same window, and the collector logged no rejections. |
| **S5** | Owner, with the Kanon script | Import the history (§7), from 2026-09-04 to the start of S4. | Per lane: exported = imported + stopped, and stopped = 0. The dry-run counts are in the import PR. The hosted store's oldest `tag = run` row is from 2026-09-04. |
| **S6** | adopter | Switch the four readers to the read helper and the reader role. | `token-trend.mjs` with a fixed `--now` prints the same report from both stores; `cache-ttl-check.mjs` reports the same row count. Any difference is explained before S7. |
| **S7** | Kanon vN+k, adopter | Move the collector into Kanon as the reusable workflow `telemetry-collect.yml`, sending only version 2 (ADR 0009 §2: one step, no second live copy). The adopter's caller keeps the schedule. Its QA role and the `COST#` push go. Kanon installs its own caller. The next release stops uploading the version-1 artifact. | The adopter's table gets no `COST#` row dated after the switch. Kanon's collector is green, and Kanon's smoke rows appear with `tag: smoke` and nothing else. |
| **S8** | gate | **The store is live before step 6 of plan 0001.** At step 6, Kolophon's register entry, roles and collector caller go in with its other callers. | Kolophon's first review run's row is in the hosted store with `tag: run`, and in no other store. |
| **S9** | Kanon | **Kanon writes `run` rows from #22,** when the Reviewer runs on Kanon's PRs. Nothing new is needed; S7 installed the collector. | The first review of a Kanon PR has its row in the hosted store. |

**Why this order.**
- **The row changes first, in Kanon, and is invisible to the adopter.** A second artifact under a new prefix can't disturb a collector that matches the old one.
- **The store is proven with test rows before any real row reaches it.**
- **The adopter writes both ways before anything is switched off,** so the import and the readers are checked against the store they replace.
- **The collector moves last,** when it no longer writes the old store. Moving it earlier would mean moving the QA role's credentials into Kanon's workflow.

## 9. Monthly cost (decision 10)

**Estimate: about $0.05 a month, under $0.10, and under $5 at a hundred times the volume.** Approval is asked for a **$1 ceiling**, watched by a free budget alert.

**Volume.** The reference adopter writes about 42 rows a day (quoted, §1.3). Kanon and Kolophon are assumed to write no more each. That is at most **4,000 rows a month**, and about **52,000 held** at 13 months. A version-2 row is about 1.2 KB, or 2 write units.

| Item | Driver | Month |
|---|---|---|
| DynamoDB writes, on demand | 8,000 write units | < $0.01 |
| DynamoDB reads | weekly full reads of each lane plus the daily sweep: about 25,000 read units | < $0.01 |
| DynamoDB storage | about 62 MB at steady state | about $0.02 |
| Point-in-time recovery | the same 62 MB | about $0.015 |
| Lambda requests and compute | about 2,200 calls (hourly collectors, three adopters), 128 MB, under a second each | < $0.01; inside the free tier |
| CloudWatch Logs | keys and field names only, 30-day retention | < $0.01 |
| Account, IAM roles, OIDC provider, SCP, function URL, TTL deletes | | $0 |
| CloudWatch alarms | none (below) | $0 |
| Encryption | the AWS-owned key, not a customer-managed key ($1 a month each) | $0 |
| AWS Budgets | one alert; the first two are free | $0 |

**The prices are Frankfurt list prices as I know them, not run against the price list.** The Owner re-checks them with the command in [Measurements](#measurements) before approving. The conclusion is not sensitive to them: storage is the largest item, and it is cents.

**What it does not cost:**
- **No new schedule in AWS.** The collector's hourly schedule already exists in the reference adopter, and runs on GitHub. Nothing touches a scale-to-zero resource, so `K-OBS-10`'s wake pricing doesn't apply. DynamoDB on demand has no idle floor.
- **Actions minutes:** Kanon is public, so its collector is free. The reference adopter's collector costs what it costs today (the adopter's own figure: about $6 a month). The dual-write week adds a call to the same job, not a job. Kolophon's collector is free if Kolophon is public. If it is private, an hourly one-minute collector is about 720 minutes a month against its plan's allowance.

**Observability.** No alarm, by `K-OBS-4`. A rejected or failed write turns the collector red, and that red run is already the page (test 4). A collector that stops running remains unpaged, as the reference adopter decided, until cost data gates something. This decision is recorded in the template's README.

## 10. Retention and deletion (decision 11)

- **Thirteen months.** The function sets `expires_at` to `recorded_at` plus 13 calendar months (30 days for `smoke` and `test`). DynamoDB's TTL deletes expired items at no cost, usually within a few days. **The read helper filters `expires_at > now`,** so a row past its date is never read even before it is deleted.
- **Deletion on request,** done by the Owner with an erase script:
  1. remove the adopter from the register and redeploy, which deletes both its roles, so writes and reads stop at once;
  2. delete every partition `<key>#<lane>`, one per lane in the enum. The lane list is closed, so this is complete without a scan;
  3. record the date and the key, not the repository, in the private register.
- **Backups.** Point-in-time recovery keeps 35 days. So the promise is: **deleted from the table at once, and from backups within 35 days.** The alternative, no point-in-time recovery, would make an operator mistake unrecoverable for every adopter's history. The ingest logs hold keys and field names only, and expire in 30 days.

## Measurements

`RA` is the reference adopter's checkout, read at `origin/main`. `K` is Kanon's.

**The row's 52 leaf fields**, from Kanon's normaliser on its own fixture:

```
node -e 'import("./actions/agent-telemetry/agent-telemetry.mjs").then(m=>{const r=m.run({agent:"reviewer",execution_file:"tests/fixtures/agent-blocks/finished.json"},{});const f=(o,p="")=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"&&!Array.isArray(v)?f(v,p+k+"."):[p+k]);console.log(f(r).length)})'
```

**The 45 stored attributes** (26 numbers, 14 strings, 1 boolean, plus `agent`, `outcome`, `commit`, `trigger`):

```
awk '/^  telemetry\)/,/^    ;;/' $RA/scripts/qa/push-run.sh | grep -cE -- '--argjson [a-z]+ "\$\(n '   # 26; s: 14; b: 1
```

**No username source:**

```
grep -v '^\s*//' $K/actions/agent-telemetry/agent-telemetry.mjs | grep -nE 'ACTOR|actor|login|user\b'   # nothing
```

**The 15 agent names:**

```
git -C $RA grep -h -E '^[[:space:]]+agent:[[:space:]]' origin/main -- .github/workflows .github/actions | sort | uniq -c
```

**Which App each lane uses** (for the role column of §7):

```
grep -oE 'secrets\.[A-Z_]+_APP_ID|github\.token' $RA/.github/workflows/<lane>.yml | sort -u
```

**The classifier's six branches** (seven templates, because the `unavailable` branch has two):

```
sed -n '/^export function classifyResult/,/^}/p' $K/actions/agent-classify/classify-agent-result.mjs | grep -c "kind: '"
```

**The collector's schedule, permissions and role:**

```
grep -nE 'cron:|id-token|environment:|role-to-assume' $RA/.github/workflows/agent-telemetry-collect.yml
```

**The store's definition** (stage gate, region, keys, trust subject, policy): the `QaIndex`, `QaRuns` and `QaCiRole` block of `$RA/sst.config.ts`, and §6 of `$RA/docs/agentic-qa-pipeline.md`.

**The start of cost rows (2026-09-04):**

```
git -C $RA log origin/main --reverse --format='%cs %s' -S'COST#' -- scripts/qa/push-run.sh | head -1
```

**Every reader:**

```
git -C $RA grep -n -E 'COST#|queryPartition|QA_DYNAMO_TABLE' origin/main -- . ':!*.test.ts' ':!CHANGELOG.md'
```

**Not run: the row count and the oldest row.** The Owner, with read-only credentials on the staging account (`<table>` is the `QaIndex` output):

```
aws dynamodb scan --table-name <table> --region us-east-2 --select COUNT \
  --filter-expression 'begins_with(pk, :c)' --expression-attribute-values '{":c":{"S":"COST#"}}'
aws dynamodb query --table-name <table> --region us-east-2 --max-items 1 \
  --key-condition-expression 'pk = :p' --expression-attribute-values '{":p":{"S":"COST#reviewer"}}'
aws s3 ls s3://<bucket>/telemetry/ --recursive --summarize | tail -2
```

The figure used instead, 249 rows over 2026-09-18 to 2026-09-23, is quoted from the "Window" paragraph of `$RA/docs/agentic-qa-pipeline.md`.

**Not run: whether the dispatch sweep's store read works.** The "Configure AWS credentials (qa OIDC)" step of its latest scheduled run, in the adopter's Actions log.

**Not run: the Frankfurt prices.**

```
aws pricing get-products --region us-east-1 --service-code AmazonDynamoDB \
  --filters Type=TERM_MATCH,Field=location,Value='EU (Frankfurt)' --max-items 50
```

Repeat with `AWSLambda` and `AmazonCloudWatch`.

## Decisions for the Owner

1. **The schema** (§2): version 2, fifty flat fields, every string an enum or a strict pattern, `tag` required, rows rejected whole. *Recommend:* yes.
2. **Amend `K-OBS-16`'s allowed list.** It is a closed list, and it doesn't name fields the cost work needs and that hold no content: the run id and attempt, the trigger, the time, the configuration (effort, turn cap, compaction, fingerprint), work-size and output counts, the verdict, and the diagnostic codes (terminal reason, API status, error flag, execution-file form). *Recommend:* add these four groups to the rule, with ADR 0007 noted, in S1. Without it, version 2 breaks the rule it exists to enforce.
3. **Write auth** (§3): a writer and a reader role per repository; the writer trusted only for the `kanon-telemetry` environment. *Recommend:* yes.
4. **Ingest** (§4): a validating function behind an IAM-authenticated URL, with the table's resource policy making it the only writer. *Recommend:* option B.
5. **Decided by the Owner, 2026-10-02:** a new `kanon` member account, a region SCP, CloudFormation, and a private register (§5). CloudFormation was chosen over the reference adopter's stack tool because the same template is what every adopter deploys for its own stores (`K-OBS-17`, `K-OBS-18`), so it must need nothing beyond the AWS CLI.
6. **Reads** (§6): direct queries, limited by `LeadingKeys`, through a Kanon read helper. *Recommend:* yes.
7. **Aggregates** (§6): nothing published until a cell has three distinct adopters, and computed by hand. *Recommend:* yes. All three first adopters are the Owner's, so the first published figure is a separate decision.
8. **Migration** (§7): from the DynamoDB rows, not S3; through the function; an unmapped lane stops it, an unmapped reason drops only the reason. *Recommend:* yes.
9. **Decided by the Owner, 2026-10-02:** the digest lanes, which run a model but use no App, record their rows as role `overseer`, whose remit they are (§7).
10. **Approved by the Owner, 2026-10-02:** about $0.05 a month, under a $1 monthly ceiling with a free budget alert, and no alarm (§9). This was the gate for S2, and it is met.
11. **Retention** (§10): 13 months by TTL, 30 days for smoke and test rows; point-in-time recovery on, so deletion completes within 35 days. *Recommend:* yes, and say "within 35 days" wherever deletion on request is promised.
12. **Decided by the Owner, 2026-10-02:** deploys of the hosted store stay manual at the start. The Owner runs `aws cloudformation deploy`, and no deploy role exists until the stack changes often enough to need one. **This applies to Kanon's own operation only.** For an adopter's own stores, Kanon prescribes *what* is deployed (the template, and `K-OBS-17`'s lifecycle rule), never *how*: the adopter's deployment pipeline is part of its stack.
