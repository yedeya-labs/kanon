# Plan 0002: the hosted telemetry store

- **Status:** proposed, 2026-10-02. Nothing in it is built until the Owner approves the cost (§9).
- **Amended** 2026-10-02 by [plan 0003](0003-metrics.md) (its decision 17): six run-row fields, a second row kind (the work-item row), its key and retention, and a wider `K-OBS-16` amendment. Each amended place says so.
- **Amended** 2026-10-05, after the Owner dropped GitHub Environments (decision 3, as changed): the writer trusts the default branch's ref, in the subject form the repository issues, and no role trusts an environment (§3, S4, S7; #213). The same day, the 90-day artifact retention is restated as a request the adopter's repository setting caps (S1a, §7, decision 16; #212).
- **S7 built** 2026-10-05 (#303): the collector is Kanon's `telemetry-collect.yml`, and Kanon's caller is `telemetry.yml`, scheduled hourly from the change after its pin reached v0.27.0, the first release that ships the collector (#304). Two parts of S7 wait for the reference adopter's switch, which waits for plan 0005: the adopter's own caller, and the release that stops uploading the version-1 artifact, because that adopter's current collector still reads it. The sweep cap is 7 days, or the repository's retention when shorter, measured from the artifacts. A watermark older than the cap warns that rows were lost.
- **Amended** 2026-10-07 by the Owner (#443): the Explorer's lane on Kanon reaches the aggregates through an aggregate-only function, and an adopter may declare its own figures publishable; the three-adopter rule is unchanged ([§6.1](#61-decided-by-the-owner-2026-10-07-the-aggregate-function-and-an-adopters-own-figures)). Built the same day: `infra/telemetry/aggregate.mjs`, the function and its roles. The Owner deploys them.
- **Tracks:** #32. **Governed by:** [ADR 0007](../decisions/0007-data-boundary.md) (the data boundary), `K-OBS-13`, `K-OBS-16` to `K-OBS-18`, [ADR 0009](../decisions/0009-move-dont-rewrite.md) (move, don't rewrite), and #19 (the cloud-neutral store interface).
- **Measured on** the reference adopter's main branch, and Kanon's, on 2026-10-02. The commands are in [Measurements](#measurements). Two numbers need AWS or GitHub access this plan did not have; they are marked **not run**, with the command the Owner runs.

## The plan in one paragraph

**Today.** Every agent run writes a 52-field telemetry row and uploads it as an artifact. In the reference adopter, one hourly collector job pushes each row into a DynamoDB table in that project's staging account, under `COST#<agent>` partitions. Two of the stored fields are free text that `K-OBS-16` forbids, seven more are unvalidated strings, and nothing checks the row on the way in.

**Where it ends.**
- **One store in a new Kanon AWS account, in Frankfurt.** A DynamoDB table, written only by a small validating function.
- **One fixed schema, version 2.** Fifty-nine fields for a run row, plus a second row kind, the work-item row (plan 0003), every string an enum or a strict pattern, and a reason code instead of a sentence. The function rejects any row with a field outside the list.
- **Per-repository roles through GitHub OIDC.** No stored secrets. A writer role can only call the function, and the function takes the partition from the role, never from the row. A reader role can only query its own partitions.
- **The reference adopter's history moves in once,** cleaned, through the same function.

**How it gets there.** Kanon changes the row first. The store is built and tested with Kanon as its first adopter. The reference adopter's collector writes to both stores for a week, its history is imported, its readers switch, and only then does the collector move into Kanon. Step 6 of [plan 0001](0001-move-the-agent-lanes.md) no longer waits for the store (decision 16): Kolophon's rows wait in its own run artifacts, kept 90 days from S1a, and are imported after S7, in S8.

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

The partition list comes from `qa-store.mjs`, which scans the workflows for `agent:` names. One reader read nothing: the dispatch sweep's store read did not run, because its job assumed the QA role without declaring `environment: qa`, which the role's trust requires (RA-2706). The read is non-fatal by design, so nothing failed. RA-2714 added the declaration, and Kanon [#60](https://github.com/yedeya-labs/kanon/pull/60) ported its reporting of a skipped read. The new reader trust must name that job's subject (§6).

## 2. The schema (decision 1)

### 2.1 The fixed field list

**Version 2. Fifty-nine fields. Each is optional unless marked required. No nesting.** (Fifty-three as accepted; plan 0003 §5.1 added `row_kind` and the five fields marked below, before S1 shipped.) Field names are the reference adopter's stored attribute names wherever one exists, so its readers keep their column names.

| Group | Fields | Type |
|---|---|---|
| **Row** | `schema_version` (required, `2`); `row_kind` (required, `run`; plan 0003); `tag` (required, §2.4); `recorded_at` (required) | integer; enum; enum; ISO-8601 UTC |
| **Run** | `run_id`, `run_attempt` (both required); `trigger`; `pr_number`, `issue_number` | integers; GitHub event name from GitHub's documented list |
| **Who** | `role` (required): `explorer`, `implementer`, `reviewer`, `merger`, `lead`, `overseer`; `lane` (required): Kanon's lane names | enums |
| **Outcome** | `outcome` (required): `ok`, `unavailable`, `exhausted`, `failed`, `not-reached`; `reason` (required, §2.3); `execution_file_form`: `ok`, `no-path`, `absent`, `unparseable`, `no-result-event`; `terminal_reason`; `is_error`; `api_error_status`; `verdict`: `approved`, `changes_requested` | enums; boolean; integer 100 to 599 |
| **Attribution** (§2.6) | `kanon_version` (required, except on an imported row, decision 17): the Kanon release the lane ran at; `failed_stage`: `checkout`, `token`, `hook`, `setup`, `agent`, `finish`; `kanon_error`: a code from Kanon's own list | `^\d+\.\d+\.\d+$` or `dev`; enum; enum |
| **Configuration** | `model`, `configured_model`; `effort`: `low`, `medium`, `high`, `xhigh`, `max`; `max_turns`; `autocompact`; `config_fingerprint` | model id pattern `^[a-z0-9][a-z0-9.-]{0,63}(\[1m\])?$`; enum; integer; `auto` or `^\d+[km]?$`; `^[0-9a-f]{12}$` |
| **Cost** | `total_cost_usd`; `num_turns`, `duration_ms`, `duration_api_ms` | number 0 to 1,000; integers |
| **Tokens** | `input_tokens`, `output_tokens`, `total_input_tokens`, `thinking_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_write_1h_tokens`, `cache_write_5m_tokens` | integers |
| **Behaviour** | `permission_denials`, `subagents_spawned`, `subagents_completed`, `subagents_failed`, `subagents_max_depth`; `tool_calls`, `tool_errors`, `compactions` (plan 0003) | integers |
| **Job** (plan 0003) | `job_status`: `success`, `failure`, `cancelled`; `timed_out` | enum; boolean |
| **Work size** | `changed_lines`, `changed_files`, `issue_body_chars`, `issue_paths_named`, `produced_lines`, `artifacts_filed`, `severities_critical`, `severities_high`, `severities_medium`, `severities_low` | integers |

**How the plan 0003 fields are derived.** `tool_calls` counts `tool_use` blocks in the execution file, and `tool_errors` the `tool_result` blocks with `is_error: true`. `compactions` counts the CLI's compaction-boundary system events. `job_status` is `job.status`, which the lane passes to `agent-finish`. `timed_out` is true when `job_status` is `cancelled` and the job ran at least its `timeout-minutes` less a 3-minute margin, measured from a start stamp the lane writes as its job's first step and passed with the job's own `timeout-minutes`. The margin exists because the stamp is the first step, not the job's start: GitHub counts the timeout from the start, and "Set up job" and the service containers come first (16 s on a measured review run, longer with an image pull). A cancel clearly before the limit is `false`. S1 checks against a real run that the execution file carries every tool and compaction event; where it doesn't, those fields stay absent, never zero. **Checked 2026-10-06 (#97)** at `claude-code-action@v1.0.239`: the action writes every message the Agent SDK emits to the file, unfiltered, and the SDK's message union includes the `compact_boundary` event. Across 207 real Reviewer execution files (every one Kanon's 14-day retention still kept), each `tool_use` had its `tool_result`, and 98 files held failed calls with `is_error: true`. None of those runs compacted, so a real `compact_boundary` is still unobserved, and #97 stays open for one. Each count is therefore kept only on its own evidence: `tool_errors` is absent when tool calls have no results at all, and `compactions` is absent when the file holds no `system` event. By the SDK's own documentation, a subagent's tool calls arrive with `parent_tool_use_id` set, and they are counted, as the definition reads; none of the 207 runs used one. A stripped copy of one real file is a test fixture.

**The second row kind.** A work-item row (`row_kind: work_item`, its own version 1) describes one pull request: its size, band, flow, accuracy, reviewer, autonomy and Kanon-health fields. Its field list is [plan 0003 §3.3](0003-metrics.md#33-the-fields). It lives in the same table and the same schema module, and passes through the same function.

Every integer is non-negative and bounded below 2³¹. `terminal_reason` is an enum that starts from the values found in the reference adopter's history (§7 lists them in its dry run), plus `other`. The normaliser maps any new CLI value to `other`, so a CLI release can't make rows fail.

**What version 1 had that version 2 drops:** `reason` as a sentence, `workflow`, `job`, `commit`, `agent`, `outcome_label`, `severities` as a string, `model_arg`, `additions` and `deletions` (their sum, `changed_lines`, stays), and the per-model `models` array. None of them has a reader in the store. The sentence stays where it is useful: in the run's step summary, which never leaves the adopter.

**Set by the store, never by the row:** the adopter's key, `source` (`collector` or `import`), `received_at`, and `expires_at`. A row that sends any of them is rejected.

### 2.2 The version field

`schema_version` and `row_kind` are required. The store keeps one field list per **(`row_kind`, `schema_version`)** pair, and accepts each pair it lists. Run rows start at version 2, work-item rows at version 1. A new version is a Kanon release that adds a list; the old one stays accepted until no supported Kanon release writes it. Readers see the version on every row.

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

**One schema module,** `actions/agent-telemetry/schema.mjs` (`node:` built-ins only), exports the field lists and a `validate(row)` function. `validate` reads `row_kind` first and checks the row against that kind's list. The work-item row's list fields (`closing_issues`, `fix_prs`, `escalation_reasons`, `guard_failures`) are checked element by element, against their number pattern or Kanon's code list. Plan 0003's `bandOf` and `areaOf` live in the same module. The same file at the same tag is used three times:
1. **By the normaliser's tests:** every fixture's row must validate.
2. **By the collector,** before it sends a row, so a bad row fails the collector with the field's name.
3. **By the ingest function** (§4), which is the enforcement. A row with any field not in its version's list, a value of the wrong type, a string outside its enum or pattern, or a reason that doesn't match its outcome, is **rejected whole**, with HTTP 422 and the offending field **names**. The function never echoes values, so a bad row can't leak into a log.

Nothing strips unknown fields quietly. A row is stored as validated, or not at all.

### 2.6 Fault attribution

**Why these three fields exist.** The Owner wants to find Kanon's own bugs in adopters' runs and fix them before an adopter has to report one (#41). To do that, a failed row has to say *where* it failed and *whose code* failed, without carrying anything the adopter wrote.

- **`kanon_version`** is the release the caller pinned, read from `github.action_ref`, or, for a lane's `$/` call, whose `action_ref` is the commit it resolved to, from the release tag in `job.workflow_ref` when `job.workflow_sha` is that commit ([#454](https://github.com/yedeya-labs/kanon/issues/454)). A run at an untagged ref, which only happens in Kanon's own CI, records `dev`. Failures that start at one version, at several adopters, point to a Kanon regression. **An imported row has none** (decision 17): the reference adopter's history ran before Kanon existed, so no release or `dev` describes it, and the function refuses one that claims either. Every reader that groups by `kanon_version`, this table's patterns and S10's #41 job included, reads only rows that carry one, so an imported row is never counted as a release or as `dev`; the stored `source: import` marks the same rows.
- **`failed_stage`** is the first lane stage that ended the run: `checkout`, `token` (minting the App token), `hook` (the adopter's project-setup hook), `setup` (the push and scope probes), `agent` (the model run) or `finish`. Every lane, the spine and the lanes that call the blocks directly, passes each stage's step **conclusion** to `agent-finish`, which runs `always()`, **in the order that lane runs its stages** (the review lane mints its token last, for example). Conclusions, not outcomes: a step the lane runs on past with `continue-on-error` concludes `success`, so a stage the lane tolerated is never blamed. The first stage that failed or was cancelled wins; failing that, the first stage before `finish` that was skipped (the lane never reached it); failing that, `agent`. It is **required when `outcome` is `not-reached` or `failed`, and absent otherwise**; the store checks the pairing, like the reason codes. **An imported `not-reached` row is the one exception** (decision 19): the history doesn't record where it stopped, so it carries none, and readers of `failed_stage` count it as unknown, never as a stage. **A hook failure is recorded only as `hook`**, never by the adopter's own step names, which are their content.
- **`kanon_error`** is a code from a closed list that Kanon defines, written by Kanon's own scripts when they fail, for example `register_row_missing` or `scope_probe_denied`. It is absent when nothing of Kanon's failed. `unhandled` is the catch-all for an exception in Kanon's own code. The codes are Kanon's, so they say nothing about the adopter. A unit test fails when a script emits a code that isn't in the list, or when the list holds a code no script emits.

**How the three combine with the platform codes:**

| Pattern | Most likely cause |
|---|---|
| The same `failed_stage` and `kanon_error` at several adopters, on one `kanon_version`, often starting at a release | A Kanon bug |
| A failure at one adopter only, typically at `failed_stage: hook` | The adopter's setup |
| `api_error_status` 429 or 5xx, or `reason: model_never_ran` | The platform, so neither Kanon nor the adopter |

The table is guidance for reading the data, not a field. The store records facts and never stores a verdict about fault. Turning these patterns into Kanon issues is a later step with its own cost (#41).

## 3. Write authentication (decision 3)

**GitHub OIDC to an AWS role per opted-in repository. No stored secrets.**

**Each opted-in repository gets two roles:**

| Role | Trust policy conditions | May do |
|---|---|---|
| `kanon-telemetry-<key>-writer` | `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com`, and `token.actions.githubusercontent.com:sub` **StringEquals** `<prefix>:ref:refs/heads/<default branch>` | invoke the ingest function's URL. Nothing else. |
| `kanon-telemetry-<key>-reader` | the same `aud`, and `sub` StringEquals one of a listed set of branch refs, `<prefix>:ref:refs/heads/<branch>`, usually just the default branch. Never an environment. | `dynamodb:Query` and `GetItem` on the table, where `dynamodb:LeadingKeys` matches `<key>#*` |

**`<prefix>` is what the repository's tokens carry,** read from GitHub's API when the template is rendered, never written by hand: `repo:<owner>/<repo>` for a repository created before 2026-07-15, and the immutable `repo:<owner>@<owner id>/<repo>@<repo id>` for one created after it, which a role naming `repo:<owner>/<repo>` refuses (measured on a sandbox, 2026-10-05; Kanon's own repository issues the immutable form). The default branch comes from the same API. A repository with a custom subject template is refused unless its register entry names the exact subjects, which pass the same checks.

**Where the `sub` and repository conditions sit:** in each role's **trust policy**, generated by Kanon's infrastructure code from the register (§5). The repository appears only there. No wildcard ever covers the repository part.

**Why the default branch's ref, and no environment (decision 3, as the Owner changed it on 2026-10-05).** `K-OBS-13` says only the collector holds the store's credentials. This plan first made that true with a `kanon-telemetry` environment, restricted to the default branch, that only the collector job declared. On 2026-10-05 the Owner decided to drop GitHub Environments: for the QA store in #291 (plan 0004's decision 9, once that lands), and here by the same reasoning (#213). An environment's branch restriction needs a paid plan in a private repository, and a job that declares one carries `environment:<name>` in its subject in place of the ref, so one job can't satisfy two roles that name different environments. So the writer trusts the default branch's ref. **What this gives up:** the environment named the collector; the ref names a branch. Every default-branch job that holds `id-token: write` can assume the writer: Kanon's own QA-store jobs (explore, the code audit, the Overseer, the dispatch sweep and the AWS maintenance job, several on a schedule) once they declare no environment, and any adopter job that holds it for another cloud, such as a deploy. Each can write rows under its own adopter's key that pass validation, and can't read, name a partition, or reach another adopter's key. Nothing narrows that set to the collector. What is guarded is the set in Kanon's own workflows: #291's id-token guard fails any Kanon job holding `id-token: write` that doesn't run a store block alone, and the collector joins its allow-list at S7. The adopter's own holders are the adopter's to check. A pull request (`pull_request_target` included), another branch, a tag, a job that declares an environment and a fork are all refused. [`docs/telemetry.md`](../telemetry.md#who-can-write) has the table.

**Note, 2026-10-05: the QA store dropped its environment, and the same approach applies here** (plan 0004, decision 9 as the Owner changed it). The QA store's role now trusts the default branch's ref subject, in the repository's own form (`repo:<owner>/<repo>`, or the immutable `repo:<owner>@<id>/<repo>@<id>` GitHub gives a repository created after 2026-07-15, which a template naming `repo:<owner>/<repo>` refuses), and "only this job reaches the store" is held by a guard on which jobs hold `id-token: write`, not by an environment, whose branch restriction needs a paid plan in a private repository. The writer's `kanon-telemetry` environment, S4's and #213's, would take the same shape: the collector job alone holds `id-token: write`, and the writer trusts the default branch's ref. That change is #213's, not made here; the reader's subject list above also needs the immutable form for a newer repository.

**A renamed repository fails closed.** The `sub` no longer matches, the collector turns red, and the register is updated.

## 4. Shape: the ingest path (decision 4)

**Options considered:**

| Option | Schema enforced by | Verdict |
|---|---|---|
| **A.** The collector writes DynamoDB directly with its role | IAM's `dynamodb:Attributes` condition can limit *which attribute names* are written, but nothing in IAM can check a value. A sentence in `reason` would pass. | **Rejected.** Enforces the names by construction, the values only by review. |
| **B.** A small ingest function behind a function URL with IAM auth | the schema module, in the only code that can write | **Chosen.** |
| **C.** API Gateway with a JWT authorizer on the GitHub OIDC token, no AWS roles | the same function | Rejected for now. It works, but it moves "who may write" from IAM trust policies into Kanon's own code, and #32 decided roles. |

**Option B, concretely:**
- **One Lambda function** (Node 24, `node:` built-ins and the schema module) with a **function URL, auth type `AWS_IAM`**. Every role that calls it is named here: the writer roles, and, while each exists, the importer, the backfill role and the Kolophon import role (§7). The function URL's resource policy grants each writer role, which the OIDC trust lets an adopter's job assume. The other three are roles in the store's own account, assumable only by the Owner, so their own policies grant the call, and the resource policy doesn't need to name them. Each role's own policy allows only a call through the URL: `lambda:InvokeFunctionUrl`, and `lambda:InvokeFunction` held to URL calls. Which rows a role may send is decided by the function from the role's name, never by its policy.
- **The collector sends** up to 25 rows per `POST`, signed with SigV4 by the runner's `curl --aws-sigv4`. No SDK, no new dependency.
- **The function reads the caller's role** from the request context (`requestContext.authorizer.iam.userArn`), maps it to the adopter's key, and builds the key itself: `pk = <key>#<lane>`, `sk = <recorded_at as YYYYMMDDTHHMMSSZ>#<run id>-<attempt>-<pr or issue number, or 0>`. **The row can't name a partition**, so a writer can only ever write its own.
- **A work-item row** (plan 0003) gets `pk = <key>#work`. **`work` is reserved:** no lane may be named `work`, and the schema module's test fails if the lane enum ever contains it. Its sort key is `sk = pr-<pr number, zero-padded to ten digits>`. The key holds no date, so a PR closed, reopened and closed again overwrites its one row instead of leaving a second (plan 0003 §3.1). Its `closed_at` must be in the past and at most 13 months old. A work item is rewritten whole when a later revert, linked fix or follow-up close changes it, and the rewrite has the same key, so it overwrites.
- **It checks** `recorded_at` is between 8 days ago and 10 minutes ahead, which is the collector's 7-day sweep cap (§1.2) plus slack, so a collector can't backdate rows. The version-2 artifact's retention (S1a: up to 90 days) doesn't widen it: they serve only S8's import, through its own role (§7). This applies to both row kinds: a work-item row's `recorded_at` is when it was derived, not when its PR closed.
- **It writes with `PutItem`.** A re-sent row has the same key and overwrites identically, as today.
- **It answers per row,** and the collector turns red on any rejection, which keeps today's paging contract.
- **Hard limits:** reserved concurrency of 2, and a body of at most 256 KB. An adopter writing garbage can fill only its own partition, slowly.
  - **Until the account's Lambda concurrency quota is raised** (decision 15), the function deploys with **no** reservation: the account's quota of 10 cannot spare one, and the quota itself still caps the function. Once the Owner's free quota increase is granted, the register's `reserved_concurrency` goes back to 2.
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

**The register is not public.** The list of opted-in repositories, their keys, and their reader branches is a parameter file the Owner keeps outside the public tree. Publishing it would tell everyone who opted in. Kanon's public tree holds the template and an example register naming only Kanon. **Rows carry the opaque key, never the repository name,** so the table alone doesn't say whose rows it holds. **It also holds, per key, the adopter's time from install to first review** (plan 0003 §4, group 9), as `first_review: { minutes, review_recorded_at }`, which describes one adopter and so never enters the public tree. It is kept for **13 months after the review row it was computed from** (decision 18, §10), like the row itself; only its distribution across adopters is published, under the three-adopter rule (§6).

**Behind #19's interface.** The store is defined by four operations, and the AWS stack is their first implementation:

| Operation | Who | AWS implementation |
|---|---|---|
| `put(rows)` | the collector | `POST` to the ingest function |
| `query(lane, from, to)` | the adopter's own readers | a Kanon read helper over `aws dynamodb query` with the reader role |
| `query('work', from, to)` (plan 0003) | the adopter's own readers, and its metrics report | the same helper, reading the `<key>#work` partition and filtering on `closed_at`; the partition is small (plan 0003 §8) |
| `erase(adopter)` | the Owner | §10 |
| `aggregate()` | the Owner; and, since 2026-10-07, the aggregate-only function, for the Explorer's lane (§6.1) | §6, §6.1 |

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
- Plan 0003 adds its three headline indicators per complexity band (cost per merged work item, yield, escaped-defect rate), under the same three-adopter rule, with intervals by a bootstrap over adopters.
- A cell is published only when **at least three distinct adopters** contribute to it. Nothing names an adopter.
- It is computed by an Owner-run script, not on a schedule. The three first adopters are all the Owner's, so the Owner decides when aggregates mean anything (decision 7).

**Built 2026-10-07 (#443):** [`infra/telemetry/aggregate.mjs`](../../infra/telemetry/aggregate.mjs) computes the lane-and-model cells, enforces the three-adopter rule in code, and refuses output that holds an adopter key. A run with no model or no cost is in no cell; the median is the middle value or the mean of the two middles, and the 90th percentile is the nearest rank. Its runbook is [The aggregate function](../telemetry.md#the-aggregate-function). Plan 0003's band indicators are not in it yet. **Amended the same day by the Owner** (§6.1): an aggregate-only function serves the same figures to the Explorer's lane, so the aggregate is no longer only Owner-run, and an adopter that declares so has its own figures published.

**The Owner, as operator, can read every row.** That is how the cross-adopter improvement work reads them. It is stated here so that rule 5 of ADR 0007 is read as being about adopters, which is what it says. Since 2026-10-07 one machine reader sits beside the Owner: the aggregate function's role reads every key's run rows, held by IAM to the aggregate's projection (§6.1).

### 6.1 Decided by the Owner, 2026-10-07: the aggregate function, and an adopter's own figures

**Decided by the Owner on 2026-10-07 (#443).** It amends §5's `aggregate()` caller and decision 7's "not on a schedule"; decision 7's three-adopter rule is unchanged. Built the same day: the function and its roles are in the template, and the Owner deploys them ([Deploy the aggregate function](../telemetry.md#deploy-the-aggregate-function)). Nothing calls it on a schedule yet: the Explorer's lane on Kanon (plan 0004, step 14) follows once the Owner has deployed it.

**Why.** Plan 0004 step 14 has a scheduled Explorer on Kanon read only aggregates, look for anomalies that #41's fixed rules miss, and file them. §5 gave `aggregate()` to the Owner alone, and decision 7 had it computed by hand, so a scheduled reader needed this decision. Three options were weighed: an aggregate-only function (A), a precomputed aggregates object the Owner writes (B), and keeping it Owner-run only (C). **The Owner chose A.**

**What may be published** (the Owner's items 1 to 3):
1. **The three-adopter rule stays.** A figure that combines several adopters' rows is published only when at least three distinct adopters contribute to it (decision 7, unchanged; ADR 0007 rule 5). **A cross-adopter cell counts and combines only adopters that did not declare their own figures** (item 2). A declaring adopter's rows are published in its own figures only, so the two never overlap: were they in both, subtracting its own figures from a cell would recover a figure of fewer than three adopters (found in #449's review; within this item, so no new decision).
2. **An adopter's own figures may be published only if that adopter declares so:** `publish_own_figures_as` in its register entry, off by default, open to any adopter, under a label it chooses that is never a key. Kanon declares it, because its runs are public anyway. This is how the work runs fully on Kanon's telemetry first. Those figures are labelled as that adopter's own, never as cross-adopter ones.
3. **The Explorer files what's wrong, not other adopters' numbers.** A signal names the lane, the reason, the failed stage, the Kanon error and the Kanon version, and how many adopters were affected, with no cost and no run count. It quotes figures only from item 1's cells or item 2's own figures.

**The function** (`infra/telemetry/function/aggregate.mjs`, the same module as the Owner's `aggregate.mjs`):
- **Answers** `cross_adopter` (lane-and-model cells from non-declaring adopters' rows, at three such adopters or more), `own` (each declaring adopter's cells, under its label) and `signals` (the last 7 days' runs that did not end `ok`). The figures are the run count, and the median and nearest-rank 90th-percentile cost per run, on `tag = run` rows only. The totals over every adopter, such as how many cells were withheld, stay in the Owner's script.
- **Refuses** to answer output that holds an adopter key, takes no input, so a caller can't narrow a figure to one adopter, and answers only a registered invoker role. A failed read logs DynamoDB's status and nothing else.
- **Its own role** may `Query` the table and nothing else, and only with exactly the aggregate's projection: IAM's `dynamodb:Attributes` lists those attributes, and `dynamodb:Select` must be `SPECIFIC_ATTRIBUTES`, so even a fault in its code can't fetch another field of a row. It learns the keys and the declared labels from its environment, which `render.mjs` writes from the register.
- **Its URL** is IAM-authenticated, and only an invoker role may call it: `kanon-telemetry-<key>-aggregates`, created for an entry that sets `aggregate_invoker`, trusted for that repository's default-branch ref like its writer (§3), and allowed to call that URL and nothing else.

**Cost:** about a cent a month, in decision 10's terms. A weekly call reads every run row in full, because DynamoDB bills a projected query by the size of the items it reads: about 9,000 read units at §9's 52,000 held rows. Lambda stays inside the free tier. The store stays well under the $1 ceiling.

**IAM blast radius.** The invoker role reaches only what items 1 to 3 allow: cross-adopter cells from at least three non-declaring adopters, which never include a declaring adopter's rows, declared own figures, and signals. Like the writer, it can be assumed by any default-branch job of its repository that holds `id-token: write`, so Kanon's id-token guard will list the lane's one reading job when the lane is added; that job hands the agent the answer as a file, as `K-OBS-13` and `K-OBS-17` have it for the stores. The function's role reads the projected fields of every adopter's run rows: it is the second principal, after the Owner, that reads across keys, and its code is the control between rows and a public lane. That code is unit-tested, and its guards are mutation-tested.

**Decided by the Owner, 2026-10-07 (on #449):**
- **No dominance rule.** Three distinct adopters are enough for a cross-adopter cell, even when one of them sends most of its runs.
- **The signals are accepted as built:** the reason code is included beside the lane, stage, Kanon error and version, and the window is 7 days.

**In ADR 0007's terms.** Rule 5 is unchanged: anything shared across adopters is aggregated and anonymised, and a cell that combines adopters needs three of them. An adopter's own figures are its own data, published because it declared so (ADR 0007's note of 2026-10-07). §6's "only the Owner, as operator, can read every row" now has one machine reader beside the Owner, the aggregate function, held by IAM to the projection.

## 7. Migrating the reference adopter's history (decision 8)

**Once, cleaned, and through the same function,** so history passes the same validation as new rows.

1. **Export (Owner, read-only):** every item whose `pk` begins `COST#`, from the reference adopter's table in `us-east-2`. The S3 copies are not used. They carry the fields version 2 drops.
2. **Transform** (a Kanon script, `infra/telemetry/import.mjs`, with unit tests):
   - **`agent` → `role` and `lane`,** by the table below. An `agent` not in the table stops the import. Nothing is guessed.
   - **`reason` → code,** by matching the classifier's seven fixed sentence templates, when the template's code agrees with the row's `outcome`. **Otherwise the code is derived where the row decides it** (decision 17, amending decision 8): from `outcome` alone for `ok` (`none`), `failed` (`did_not_finish`) and `not-reached` (`no_result_file`), and from `terminal_reason` for `exhausted` (`max_turns` gives `turn_cap`, `budget_exhausted` gives `budget_cap`). `unavailable` has two codes and nothing else that tells them apart, so such a row **stops**, and so does an `exhausted` row with neither cap. The dry run counts the reasons derived.
   - **`outcome_label` → `verdict`, and `severities` → the four counts.**
   - **Dropped:** `workflow`, `commit`. Kept as they are: every other stored field, and **absent stays absent**, except that a `terminal_reason` outside the enum becomes `other`, as the normaliser maps it; the dry run lists the raw values.
   - **Converted:** `run_id`, `run_attempt` and `api_error_status` from strings to integers. Version 1 stores them as DynamoDB strings (`S`), and version 2 types them as integers.
   - **Added:** `schema_version: 2`, `row_kind: run`, `tag: run`, and `recorded_at` from the old sort key.
   - **Absent: `kanon_version`** (decision 17). No release or `dev` describes a run from before Kanon existed. `validate` takes the row as `imported`, which the function sets for the importer role only: the field is then not required, and refused if present.
   - **`failed_stage`** (decision 19), which version 2 requires when `outcome` is `failed` or `not-reached` and no version-1 row stores: **`agent` on a `failed` row**, because a `failed` run reached the model, so the agent stage is where it failed; **absent on a `not-reached` row**, because the history doesn't say which stage it stopped at. `validate` allows that absence on an imported row only.
3. **Dry run.** The script prints, per lane, the rows exported, the rows to import, the rows stopped by cause, the reasons derived, and every distinct `terminal_reason`. It also runs `validate` on every transformed row and prints, per lane, how many fail and on which field names, so a row S5 would send to a 422 is counted here first. These are counts, field names and enum values only. They seed the `terminal_reason` enum and go into the import PR.
4. **Import** through the function, with an **importer role** only the Owner can assume. It may name the adopter key, and it accepts `recorded_at` up to 13 months back. It is deleted afterwards. The script's `--apply` sends the rows, 25 to a `POST`, and prints the rows stored and refused by field name; it exits non-zero when any row stopped or was refused.

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

**The backfill role (plan 0003, step S7a)** is a separate, narrower role, not the importer kept alive. The importer is the most powerful writer the store ever has: it names any adopter's partition **and** backdates. Keeping it from S5 to S7a would leave that power standing for weeks, for a job that needs only half of it. A work-item row's `recorded_at` is when it was derived, so the backfill needs no backdating. So the backfill role:
- may be assumed only by the Owner, like the importer;
- may name the adopter key;
- is accepted for `row_kind: work_item` rows only;
- gets the normal `recorded_at` window (§4), not the importer's 13 months;
- is added to the template for S7a and removed from it when the backfill is done, so between S5 and S7a no role can name an adopter's key.

**The Kolophon import role (S8, decision 16)** is the other half: it backdates, but names no partition. Kolophon's rows from step 6 of plan 0001 until S8 are older than the normal window allows, so they need the importer's 13 months; they belong to one adopter, so they don't need its power to name a key. The importer itself is not brought back. So the Kolophon import role:
- may be assumed only by the Owner, like the importer;
- **maps to Kolophon's key,** the way Kolophon's writer role does, so the function builds the partition from the role and a row naming one gets 422, as for any writer;
- is accepted for `row_kind: run` rows only;
- gets the importer's `recorded_at` window, up to 13 months back;
- is added to the template for S8 and removed from it when the import is done.

**What it imports** is Kolophon's version-2 `kanon-telemetry-*` artifacts, which its lanes upload from step 6 on and keep for as long as its repository's retention setting allows, up to the 90 days Kanon asks for (S1a; Kolophon's setting measured 90 on 2026-10-05). Each holds a row that already passed `validate` when the lane wrote it, so nothing is transformed: none of the import script's mapping above applies. The Owner's import lists Kolophon's artifacts through the Actions artifacts API (`GET /repos/<owner>/<repo>/actions/artifacts`, paginated), keeps every unexpired one whose name begins `kanon-telemetry-` (the last 90 days at most, or the repository's retention if that is shorter), downloads each **by id**, and sends the rows through the function with the Kolophon import role, 25 to a `POST` like the collector. **A row sent twice is harmless:** the function builds the same key from the same row, so `PutItem` overwrites it identically, whether the import is re-run or the collector, once S8 installs it, sends a row the import already sent.

## 8. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **S1** | Kanon vN | The schema module (§2.5). `agent-classify` returns a code beside its sentence. `agent-telemetry` gains `tag` and `lane` inputs, every lane passes each stage's conclusion, in its own order, for `failed_stage` (§2.6), and Kanon's scripts write their `kanon_error` codes; `agent-telemetry` uploads a **second** artifact, `kanon-telemetry-<lane>-<run id>-<attempt>`, holding the version-2 row. The row carries `row_kind: run` and plan 0003's five run fields (§2.1); the schema module holds the work-item field list too. `K-OBS-16` is amended (decision 2, extended by plan 0003). | Every fixture's version-2 row validates. A cancelled job records `job_status: cancelled`, and an execution file with no tool events leaves `tool_errors` absent, not 0. **Mutations:** a run row with `row_kind: work_item`, or a work-item row carrying a run field, fails; a row with one extra field, a `reason` sentence, or `reason: turn_cap` with `outcome: ok`, a `not-reached` row without `failed_stage`, or a `kanon_error` outside the list each fails `validate`. Adding `work` to the lane enum fails the schema module's test (§4's reserved partition). A lane whose hook fails records `failed_stage: hook` and nothing else from the hook. The reference adopter's collector still matches only `agent-telemetry-*`, so after its Dependabot bump its next sweep pushes the same number of rows as the one before. |
| **S1a** | Kanon, before plan 0001's step 6 | **Keep the version-2 row for 90 days** (#123, decision 16; plan 0001's step 5a). `agent-telemetry` uploads the `kanon-telemetry-*` artifact with a fixed `retention-days` of 90, not its `retention_days` input, which keeps setting the version-1 artifact's 7. Nothing in Kanon is configurable ([ADR 0002](../decisions/0002-standardise-dont-parameterise.md)): a row is a few KB, so 90 days cost nothing measurable. 90 is also GitHub's ceiling for a public repository. The collector's 7-day sweep cap and the function's 8-day window don't change. **Premise, corrected 2026-10-05 (#212): 90 days is what Kanon asks for, not what an adopter keeps.** The repository's artifact-and-log retention setting caps every artifact's `retention-days`, so the version-2 row is kept for the shorter of the two. Measured with `gh api repos/<owner>/<repo>/actions/permissions/artifact-and-log-retention`: Kanon and Kolophon 90 (2026-10-05), the reference adopter 5, with an organisation maximum of 7 (2026-10-04; plan 0004 §3.3). **Where the setting is shorter:** S8's import, which reads only artifacts, finds the last *retention* days of rows, not 90, so S8 must run within the setting's window of step 6, or the adopter raises its setting before step 6, or the rows before that window are lost (the import counts what it found); S7's collector loses the rows of any outage longer than the retention, because its 7-day sweep cap can't reach an artifact already expired; S4's dual-write comparison is unaffected, since both stores get the rows of the same sweep; and S5 doesn't rely on artifacts at all, because it imports the reference adopter's table (§7). | A unit test fails when the version-2 upload's `retention-days` is anything but 90. **Mutation:** a lane that passes `retention_days: 3` still gets a 90-day version-2 artifact. **Live:** a Kanon lane run's `kanon-telemetry-*` artifact expires 90 days after it was created, and its `agent-telemetry-*` artifact 7; at step 6, Kolophon's first one expires 90 days out too, which shows its repository's retention setting doesn't cap it. Before step 6, Kolophon's setting is re-measured with the command above; if it has dropped below 90, S8's deadline is that many days, and this row says so. |
| **S2** | Owner | Create the `kanon` account, the region SCP and the $1 budget. | `aws organizations list-accounts` lists it; a `describe` call in `us-east-1` from inside it is denied by the SCP; the budget exists. |
| **S3** | Kanon PR; Owner deploys | The template (§4, §5): table, function, URL, OIDC provider, table resource policy, and roles for Kanon, the reference adopter and the importer. A verify script ships with it. | The Owner runs the verify script, which sends `tag: test` rows: a valid row gets 200; a row with an extra field gets 422 naming that field; a row naming a partition gets 422; the reader role querying another adopter's key gets `AccessDeniedException`; a direct `PutItem` with the writer role is denied; the stored row's `expires_at` is 30 days out; a probe role whose own policy allows the four writes is denied each one by the table's resource policy (added by #101: the writer's denial alone doesn't show the deny). |
| **S4** | adopter | **Prepare in the adopter** (ADR 0009 §4). Its collector also sends each `kanon-telemetry-*` row to the function, after its existing push. Its job gets the writer role and keeps the QA role for the old push, **and drops `environment: qa`, declaring no environment** (#213): one job's token carries one subject, and the writer trusts only the default branch's ref. **Precondition, an Owner AWS write before S4: the QA role trusts that ref too**, beside `environment:qa`, as `<prefix>:ref:refs/heads/<default branch>`. This is the write #291 adds to plan 0004's P9 for the QA store; if S4 comes first, it is S4's own. Without it, the old push fails from S4 until S7. The collector job is the only one in the adopter that gains `id-token: write`. | Before merging, the QA role's trust lists the default branch's ref subject. For one week, the hosted store's `tag = run` rows per lane equal the adopter's new `COST#` rows per agent over the same window, and the collector logged no rejections; its first run's two pushes are both green, which shows both roles accept the job's one subject. |
| **S5** | Owner, with the Kanon script | Import the history (§7), from 2026-09-04 to the start of S4. | Per lane: exported = imported + stopped, and stopped = 0. The dry-run counts are in the import PR. The hosted store's oldest `tag = run` row is from 2026-09-04. |
| **S6** | adopter | Switch the four readers to the read helper and the reader role. | `token-trend.mjs` with a fixed `--now` prints the same report from both stores; `cache-ttl-check.mjs` reports the same row count. Any difference is explained before S7. |
| **S7** | Kanon vN+k, adopter | Move the collector into Kanon as the reusable workflow `telemetry-collect.yml`, sending only version 2 (ADR 0009 §2: one step, no second live copy). The adopter's caller keeps the schedule and grants `id-token: write` to that call alone. Its QA role and the `COST#` push go. Kanon installs its own caller. The collector's job is the only one in that workflow that holds `id-token: write`, and it joins the allow-list of #291's id-token guard, and declares no environment. The next release stops uploading the version-1 artifact. **The collector's 7-day sweep cap is the adopter's artifact retention when that is shorter** (S1a): a collector stopped for longer than the retention loses the rows whose artifacts expired, and none of them reaches the store. | The adopter's table gets no `COST#` row dated after the switch. Kanon's collector is green, and Kanon's smoke rows appear with `tag: smoke` and nothing else. **Mutation:** `id-token: write` on any other job of `telemetry-collect.yml` turns the guard red. |
| **S7a** | Kanon, after S7 | **The work-item row starts:** [plan 0003](0003-metrics.md)'s steps M4 to M7. The work-item step joins the collector Kanon now owns, the reference adopter's and Kanon's work items are backfilled from 2026-09-04 through the **backfill role** (§7), and the metrics report and public page follow. The backfill role is created for this step and deleted when the backfill is done. | Plan 0003 §7's checks for M4 to M7. The backfill role's own checks: a `run` row sent with it gets 422; a work-item row whose `recorded_at` is older than 8 days gets 422; after the backfill, the role no longer exists. |
| **S8** | Kanon PR, Owner deploys; Kolophon | **Kolophon joins the store** (no longer a gate on plan 0001's step 6, decision 16). Its register entry, writer and reader roles and collector caller go in. The template gains the **Kolophon import role** (§7) for this step, and the Owner imports Kolophon's version-2 `kanon-telemetry-*` artifacts since step 6 through it, unchanged (§7): listed and downloaded through the Actions artifacts API, then sent through the function. The role is removed when the import is done. | The import prints the artifacts it listed and the rows the function accepted, and they are equal, with no rejections; those counts go into the S8 PR. Kolophon's hosted `tag = run` rows dated before the import number the same. Re-running the import leaves that count unchanged. With the role, a row naming a partition gets 422, and a `work_item` row gets 422. After the import, the role no longer exists. Kolophon's next review run's row arrives through the collector. |
| **S9** | Kanon | **Kanon writes `run` rows from #22,** when the Reviewer runs on Kanon's PRs. Nothing new is needed; S7 installed the collector. | The first review of a Kanon PR has its row in the hosted store. |
| **S10** | Kanon account, later | **Kanon files its own bugs (#41).** A scheduled job reads the aggregates and files a Kanon issue for a new combination of `failed_stage`, `kanon_error` and `kanon_version`, or a rise in failures after a release. The issue holds counts and codes only. It needs a few weeks of data first, and the Owner approves its thresholds, cadence and cost separately (the cost-discussion rule). | A seeded `test` combination files exactly one Kanon issue, and a second run updates that issue instead of filing another. |

**Why this order.**
- **The row changes first, in Kanon, and is invisible to the adopter.** A second artifact under a new prefix can't disturb a collector that matches the old one.
- **The store is proven with test rows before any real row reaches it.**
- **The adopter writes both ways before anything is switched off,** so the import and the readers are checked against the store they replace.
- **The collector moves last,** when it no longer writes the old store. Moving it earlier would mean moving the QA role's credentials into Kanon's workflow.

## 9. Monthly cost (decision 10)

**Estimate: about $0.05 a month, under $0.10, and under $5 at a hundred times the volume.** Approval is asked for a **$1 ceiling**, watched by a free budget alert.

**Plan 0003's work-item rows add about $0.03 a month** (its §8, approved by the Owner, 2026-10-02), so the store stays under $0.10, and under $9 at a hundred times the volume. The $1 ceiling is unchanged. The work-item step runs inside the existing collector job, so it adds no schedule; on a private adopter it can add up to one billed minute per hourly run, which plan 0003 measures in its step M4.

**Volume.** The reference adopter writes about 42 rows a day (quoted, §1.3). Kanon and Kolophon are assumed to write no more each. That is at most **4,000 rows a month**, and about **52,000 held** at 13 months. A version-2 run row is about 1.35 KB (1.2 KB as accepted, plus about 0.15 KB for plan 0003's six fields), or 2 write units.

| Item | Driver | Month |
|---|---|---|
| DynamoDB writes, on demand | 8,000 write units | < $0.01 |
| DynamoDB reads | weekly full reads of each lane plus the daily sweep: about 25,000 read units | < $0.01 |
| DynamoDB storage | about 70 MB at steady state (62 MB before plan 0003's run fields) | about $0.02 |
| Work-item rows (plan 0003 §8) | at most 1,600 writes a month, about 34 MB held, weekly report reads | about $0.03 in all |
| Point-in-time recovery | the same 70 MB | about $0.02 |
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

- **Thirteen months.** The function sets `expires_at` to `recorded_at` plus 13 calendar months (30 days for `smoke` and `test`). **A work-item row expires at `closed_at` plus 13 months** (plan 0003), never `recorded_at` plus 13, so a rewrite can't extend its retention. DynamoDB's TTL deletes expired items at no cost, usually within a few days. **The read helper filters `expires_at > now`,** so a row past its date is never read even before it is deleted.
- **Deletion on request,** done by the Owner with an erase script:
  1. remove the adopter from the register, **and in the same edit the key's time from install to first review** (plan 0003), which sits beside the key; record the date and the key, not the repository, in it; then redeploy, which deletes both its roles, so writes and reads stop at once. Both go in one edit because the value is part of the entry: a separate later step would look for an entry step 1 already removed;
  2. delete every partition `<key>#<lane>`, one per lane in the enum, **and `<key>#work`** (plan 0003). The lane list is closed, so this is complete without a scan.
- **The register's time to first review** (§5) is kept 13 months after the review row it was computed from, its `review_recorded_at`, and then removed from the register (decision 18). That also takes the key out of the published distribution. `render.mjs` refuses a register holding one past its bound, so no deploy goes out while one is kept.
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

**Artifact retention** (2026-10-05, #212): the repository's setting, which caps every artifact's `retention-days` (S1a). Kanon's and Kolophon's are `{"days":90,"maximum_allowed_days":90}`:

```
gh api repos/<owner>/<repo>/actions/permissions/artifact-and-log-retention
```

**A repository's OIDC subject prefix and default branch** (2026-10-05, §3), which `render.mjs` reads for each register entry. Kanon's is immutable, `{"use_default":true,"use_immutable_subject":true,"sub_claim_prefix":"repo:yedeya-labs@<id>/kanon@<id>"}`, on `main`:

```
gh api repos/<owner>/<repo>/actions/oidc/customization/sub
gh api repos/<owner>/<repo> --jq .default_branch
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

1. **Accepted by the Owner, 2026-10-02.** **The schema** (§2): version 2, fifty-three flat fields (the three attribution fields added by the Owner the same day, §2.6), every string an enum or a strict pattern, `tag` required, rows rejected whole. **Amended 2026-10-02** by plan 0003's decisions 12 and 17: fifty-nine run fields with `row_kind` required, and the work-item row as a second kind.
2. **Accepted by the Owner, 2026-10-02.** **Amend `K-OBS-16`'s allowed list.** It is a closed list, and it doesn't name fields the cost work needs and that hold no content: the run id and attempt, the trigger, the time, the configuration (effort, turn cap, compaction, fingerprint), work-size and output counts, the verdict, and the diagnostic codes (terminal reason, API status, error flag, execution-file form), plus the attribution codes (Kanon version, failed stage, Kanon error code, §2.6). The amendment adds these five groups to the rule, with ADR 0007 noted, in S1. Without it, version 2 breaks the rule it exists to enforce. **Extended 2026-10-02** by plan 0003 (§5.3, decision 17): the same amendment also adds six groups for the work-item row, each metadata: work amounts (counts of lines, files, directories, files per area, tests, acceptance criteria, cited spec ids, blocking issues and commits, and booleans per escalation category from Kanon's closed list); times of platform events and the durations between them; actor classes (a role, `human` or `other_bot`, never a login, name or account id); label-derived enums and counts (origin, follow-up severities and fates, check conclusions); Kanon's own codes (the Merger's escalation reasons, guard ids); and linked numbers (closing issues, and the PRs that revert or fix an item). **Plan 0003's five new run-row fields** need no new group: `tool_calls`, `tool_errors` and `compactions` are counts of the run's own behaviour, covered by the work-size and output counts above like the accepted Behaviour fields, and `job_status` and `timed_out` are diagnostic codes, covered with the terminal reason and error flag. The rule's "never" list is unchanged. One amendment, in S1.
3. **Accepted by the Owner, 2026-10-02; changed by the Owner, 2026-10-05.** **Write auth** (§3): a writer and a reader role per repository; the writer trusted only for the `kanon-telemetry` environment. **Changed:** the Owner dropped GitHub Environments (for the QA store in #291, which amends plan 0004's decision 9, and the same approach here, #213). The writer trusts the default branch's ref, and the readers their listed branch refs, each in the subject form the repository issues, read from GitHub's API at render time; only the collector job holds `id-token: write`.
4. **Accepted by the Owner, 2026-10-02.** **Ingest** (§4): a validating function behind an IAM-authenticated URL, with the table's resource policy making it the only writer. Option B.
5. **Decided by the Owner, 2026-10-02:** a new `kanon` member account, a region SCP, CloudFormation, and a private register (§5). CloudFormation was chosen over the reference adopter's stack tool because the same template is what every adopter deploys for its own stores (`K-OBS-17`, `K-OBS-18`), so it must need nothing beyond the AWS CLI.
6. **Accepted by the Owner, 2026-10-02.** **Reads** (§6): direct queries, limited by `LeadingKeys`, through a Kanon read helper.
7. **Accepted by the Owner, 2026-10-02.** **Aggregates** (§6): nothing published until a cell has three distinct adopters, and computed by hand. All three first adopters are the Owner's, so the first published figure is a separate decision. **Amended by the Owner, 2026-10-07 (#443):** the three-adopter rule stays. An adopter's own figures may be published when it declares so in the register, and a scheduled Explorer lane reads the aggregates through an aggregate-only function, not by hand ([§6.1](#61-decided-by-the-owner-2026-10-07-the-aggregate-function-and-an-adopters-own-figures)).
8. **Accepted by the Owner, 2026-10-02.** **Migration** (§7): from the DynamoDB rows, not S3; through the function; an unmapped lane stops it, an unmapped reason drops only the reason. **Amended by the Owner, 2026-10-06** (decision 17): `reason` is required, so an unmapped reason is derived where the row decides it, and the row stops where it doesn't.
9. **Decided by the Owner, 2026-10-02:** the digest lanes, which run a model but use no App, record their rows as role `overseer`, whose remit they are (§7).
10. **Approved by the Owner, 2026-10-02:** about $0.05 a month, under a $1 monthly ceiling with a free budget alert, and no alarm (§9). This was the gate for S2, and it is met. **2026-10-07 (#443):** the aggregate function adds about a cent a month, agreed by the Owner with option A (§6.1); the ceiling is unchanged.
11. **Accepted by the Owner, 2026-10-02.** **Retention** (§10): 13 months by TTL, 30 days for smoke and test rows; point-in-time recovery on, so deletion completes within 35 days. Also: say "within 35 days" wherever deletion on request is promised.
12. **Decided by the Owner, 2026-10-02:** deploys of the hosted store stay manual at the start. The Owner runs `aws cloudformation deploy`, and no deploy role exists until the stack changes often enough to need one. **This applies to Kanon's own operation only.** For an adopter's own stores, Kanon prescribes *what* is deployed (the template, and `K-OBS-17`'s lifecycle rule), never *how*: the adopter's deployment pipeline is part of its stack.
13. **Accepted by the Owner, 2026-10-03:** the **backfill role** (§7, S7a). It ships behind `EnableBackfill`, off by default; it may name any registered adopter's key, accepts `row_kind: work_item` rows only within the normal `recorded_at` window, is assumable only by the Owner, and is removed when the backfill is done.
14. **Accepted by the Owner, 2026-10-03:** **`EnableVerify`**. While on, the Owner's role may assume every writer and reader role so `verify.mjs` can run S3's checks as them. Off by default; the runbook redeploys without it right after `verify`.
15. **Decided by the Owner, 2026-10-03:** the first deploy runs **without reserved concurrency** (§4), because the account's quota of 10 cannot spare one. The Owner requests the free quota increase (`L-B99A9384`) and sets the reservation to 2 when it is granted.
16. **Decided by the Owner, 2026-10-03:** telemetry capture is deferred until after the agent-lane extraction, so **step 6 of plan 0001 (Kolophon) no longer waits for the store** (S8). Kolophon's lanes upload their rows as artifacts from step 6 on, and S8 imports them after S7, through the **Kolophon import role** (§7): scoped to Kolophon's key, with the importer's 13-month window, added for S8 and removed afterwards. The importer itself is not brought back. **The rows are kept 90 days** because S1a, a Kanon step before step 6 (#123), gives the version-2 artifact a fixed 90-day retention: the default `retention_days` is 7, and no lane can raise it. So S8 must run within 90 days of step 6, or the rows from before that window are lost; the import counts what it found. **Premise corrected 2026-10-05 (#212):** the 90 days are a request, which the repository's retention setting caps (S1a). Kolophon's is 90, measured on 2026-10-05, so this decision holds for Kolophon as written. For an adopter whose setting is shorter, S8's deadline is that setting, not 90 days.
17. **Decided by the Owner, 2026-10-06 (#89):** the two required fields a version-1 row can't supply (§7, step 2).
    - **`kanon_version`: absent on an imported row** (option b). It stays required from every writer; the importer's rows carry none, and the function refuses one that does. The stored `source: import` already marks those rows. S10's #41 job and §2.6's attribution patterns read only rows that carry a version, so an imported row is never read as a release or as `dev`.
    - **`reason`: derived where the row decides it** (option b): from `outcome` for `ok`, `failed` and `not-reached`, and from `terminal_reason` for `exhausted`. An `unavailable` row with no matching sentence still stops. Decision 8 is amended to match.
18. **Decided by the Owner, 2026-10-06 (#93):** the register's **time from install to first review** is kept **13 months after the review row it was computed from**, then removed (option a, §10). That also removes the key from the published distribution. `render.mjs` refuses a register that still holds one past its bound.
19. **Decided by the Owner, 2026-10-06 (#89):** **`failed_stage` on an imported row** (§7, step 2), which version 2 requires for `failed` and `not-reached` and no version-1 row stores. A `failed` row derives **`agent`**: it reached the model, so the agent stage is where it failed. A `not-reached` row leaves it **absent**, on imported rows only: the history doesn't record which stage it stopped at. `validate` allows that absence for the importer's rows alone, and §2.6's readers count it as unknown.
