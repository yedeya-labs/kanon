# Plan 0004: move the remaining lanes into Kanon

- **Status:** accepted, 2026-10-03. The Owner decided all thirteen decisions that day. Decisions 2, 8, 9 and 10 differ from what the plan first recommended, and the plan below follows the Owner's version. Step P5 and P6's library side are done; steps 7 and 8 move in the release after v0.20.0 (kanon#202, kanon#203).
- **Why now:** the Owner decided on 2026-10-03 to **pause step 6 of [plan 0001](0001-move-the-agent-lanes.md)** (Kolophon) and to plan the lanes still in the reference adopter. Plan 0001 listed them as "later", each with its own plan. This is that plan, for all of them.
- **Governed by:** [ADR 0009](../decisions/0009-move-dont-rewrite.md) (move, don't rewrite), [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), [ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), `K-OBS-13`, `K-OBS-17`, #15 (stack-neutral) and #19 (the cloud-neutral store interface).
- **Measured on** the reference adopter's main branch on 2026-10-03, pinned to Kanon v0.17.0, and on Kanon's main branch after v0.18.0. The commands are in [Measurements](#measurements).

## The plan in one paragraph

**Today.** Ten workflows in the reference adopter still hold agent-pipeline logic: three lanes with no model (the Merger, the Lead's reconciler and the dispatch sweep), five with one (the Explorer, the code audit, the Overseer and the two digests), the telemetry collector and a store-maintenance workflow. Together they are 3,113 lines. Their scripts are mostly Kanon's already: the library moved at plan 0001's step 3, so the three non-model lanes run nothing of the adopter's own. The model lanes still run 16 adopter scripts (4,608 lines), and six of the ten workflows reach the adopter's QA store in its cloud account.

**Where it ends.**
- **Kanon ships** eight more lane workflows: the Merger, the reconciler, the dispatch sweep, both digests, the code audit, the Explorer and the Overseer.
- **The adopter keeps,** per lane, a trigger-only caller as in plan 0001, and its **deploys** and its **Explorer sweep** (what it explores is its product).
- **The QA store sits behind a contract.** Kanon defines a store hook at a fixed path, with four operations and their formats. Every store operation runs in a job of its own, so no agent job ever holds store credentials. An adopter can bring any store by writing the hook, and one with no hook gets lanes that run without memory.
- **Kanon ships the first implementation: AWS.** A provisioning script creates the store in the adopter's own account (`K-OBS-17`'s "infrastructure code Kanon ships", now behind #19's interface), an action implements the four operations on it, and the store-maintenance workflow moves into Kanon with it. No lane names a cloud.
- **Not moved by this plan:** the telemetry collector, which [plan 0002](0002-hosted-telemetry-store.md) moves at its step S7.

**How it gets there.** As in plan 0001: every non-mechanical change is made first where it already runs (ADR 0009 §4), and each Kanon step is a move. The lanes that touch no store go first. The dispatch sweep follows once it reads its cost rows from run artifacts instead of the store. The three store-coupled model lanes go last, after the store contract and its AWS implementation exist and the reference adopter's lanes use them.

## 1. Order of moves

The numbering continues plan 0001's, so a step number means one thing across both plans. The release labels don't continue: `vN` here is the first release after this plan is accepted, not plan 0001's `vN`.

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **P5** | adopter | **Read the two non-model lanes' logins from the App register** (`K-LAYOUT-6`, decision 8), instead of literals. A workflow `if:` can't read a file, so the Merger gains a small first job, `logins`, that reads the register from the default branch through the API, as the revise lanes' `read_login` does, and outputs the Merger's and the Implementer's logins. The Merger job's `if:` keeps all its clauses, and compares against `needs.logins.outputs` instead of literals. The `logins` job carries the role-neutral clauses itself (the event, a cancelled CI run, the PR's state, draft flag and agent label), so a review that fails them still starts no runner. The reconciler reads the Lead's login the same way, inside its existing job. | `grep -nE '\[bot\]\|-the-' .github/workflows/agent-merge.yml .github/workflows/agent-lead-reconcile.yml` prints only comments. The adopter's job-`if:` test is rewritten to assert both jobs' conditions. **Mutation:** in a fixture register, renaming the Implementer's App slug skips the Merger job for a review of that App's PR, and deleting the register's Merger row fails the `logins` job by name. |
| **P6** | Kanon library, then adopter | **Declare the reference environment's deploy** (§5). The adoption record (`docs/qa/adoption.md`, `K-LAYOUT-10`), where `K-PROJ-11` already has the project name its reference environment, gains the workflow that deploys there and the job whose success is the deploy. `lead-reconcile.mjs`'s `readDeploy` and the reconciler's Actions probe read it, instead of the literal `deploy-staging.yml` and `deploy`. The reference adopter adds its declaration in the same upgrade. | `grep -rn "'deploy-staging.yml'" scripts/` in Kanon prints nothing. Today it prints `lead-reconcile.mjs:1378`, the `--workflow` argument, so the check fails before P6 and passes only after it. The comments and messages that name the workflow in prose (ten more lines in `lead-reconcile.mjs`) are reworded in the same PR, but the check is scoped to the code. **Mutation:** restoring the literal at that argument turns the check red. A unit test fails by name on an adoption record without them, or with a malformed one. **Live:** the adopter's next project tick reaches the same deploy phase as its last tick before the upgrade. |
| **7** | Kanon vN | **Move the Merger** (`agent-merge.yml`) as it is today, #158 aside (§7). The adopter's caller, named `Merge (Merger)` as `docs/lanes.md` requires, keeps its four triggers: the review event, CI completing on the default branch, the hourly floor at minute 7, and a dispatch with `pr_number` and `apply`. | `lane-check` is green on the adopter, and the caller is under 40 lines. **Live:** a dispatch with `apply` off over every open PR prints the same verdict per PR as the adopter's own lane on the same heads; then the Merger merges one Implementer PR through the moved lane. **Mutation:** `lane-check` fails a Merger caller under any other name, a rule step 7 adds, because `lane-check` checks no caller's name today. |
| **8** | Kanon vN+1 | **Move the reconciler** (`agent-lead-reconcile.yml`): the project tick, the parked-brief and unreviewed-PR re-deliveries, and the red-unreviewed report, all of which run library scripts. Its tick budget of 6 becomes a constant in Kanon's lane file. | `lane-check` is green, and the caller is under 40 lines. **Live:** a dispatch with `apply` off on each open project prints the same planned actions as the adopter's last tick, and the next scheduled tick files or dispatches as before. |
| **P7** | Kanon library, then adopter | **The dispatch sweep reads its cost rows from run artifacts** (§3.3). The two lanes it watches are Kanon lanes, which upload a version-2 telemetry row, kept 90 days, on every run (plan 0002, S1 and S1a). The sweep's 14-day window fits inside that. For one week the adopter's sweep runs both reads and prints both counts. | For seven scheduled runs, the artifact read and the store read return the same rows per lane, or each difference is a run the store never received. Then the store read, the AWS step and the job's environment go. **Mutation:** an artifact whose row fails `validate` is skipped and counted, never read as "no run". |
| **9** | Kanon vN+2 | **Move the dispatch sweep** (`agent-dispatch-sweep.yml`). It keeps its daily schedule at 04:40 and its soft skip when the Lead's App isn't set up. | `lane-check` is green, and `grep -nE 'aws\|environment:\|id-token'` on the caller prints nothing. **Live:** a scheduled run's summary says "Cost rows read" with a count for both lanes. |
| **P8** | adopter | **Put both digests on Kanon's blocks** (`agent-setup`, `agent-run`, `agent-finish`), as plan 0001's P1 did for the other lanes. Today they call `claude-code-action` directly at a floating `@v1`, so Kanon's exact pin (plan 0001, decision 14) and its lane tests don't yet describe them. | Each digest's effective step list is identical before and after apart from the block boundary, by the comparison plan 0001's P1 used. A dry-run dispatch of each prints the same message as before the change, narrative aside. |
| **10** | Kanon vN+3 | **Move both digests** (`project-digest.yml`, `weekly-digest.yml`), and the project digest's health check, `workflow-health.mjs` (720 lines), into the library with its test. The webhook reaches Kanon under a fixed secret name (decision 7). | `lane-check` is green. **Live:** each digest posts once from the moved lane, and the health job reports the same red workflows as the day before. |
| **P9** | Kanon, then adopter | **The store contract and its AWS implementation** (§3, decisions 2, 9 and 10). Kanon defines the hook's operations and the files each one reads or writes, and runs every store operation in a job of its own, in the `kanon-qa-store` environment, before or after the agent job. Kanon also ships the AWS implementation: a provisioning script, an action implementing the four operations, and the store-maintenance workflow, moved from the reference adopter with `push-run.sh`'s logic. The same Kanon PR amends `K-OBS-17` and the assumptions table in chapter 00 to say the store is reached through the contract, with Kanon's AWS implementation as the first, and updates #19's body to match. The reference adopter's hook calls Kanon's AWS action on its existing table and bucket, and it moves its code audit, Explorer and Overseer onto the hook and onto Kanon's blocks ([RA-2610](#9-issues)). | In each of the three lanes, the job that runs the agent declares an explicit `permissions:` block without `id-token`, and no `environment:`; a Kanon test reads that block, and also requires every read the blocks' telemetry step uses, because narrowing that grant once cost the telemetry step a read (RA-2592). Without one, the job would inherit the caller's `id-token: write`, as every job of `agent-lane.yml` inherits its caller's grant today. **Mutation:** removing that block, or adding `id-token: write` to it, turns the test red. The audit's and the Explorer's next store rows equal the previous run's in shape, row for row. **Live:** the Explorer's change gate still skips an unchanged commit and records the skip. **Mutation:** with the hook file removed, each lane runs to completion, the gate runs the sweep, and the summary says the store is absent. The provisioning script is parsed by a unit test, like the actions, and a stack it creates in a sandbox account answers `last-green`, `record-skip`, `put` and `export` through Kanon's action. **Mutation:** a template without deletion protection on the table, or with a stage name in a resource's lifecycle, fails the test (`K-OBS-17`'s lifecycle clause). The store jobs' environment is `kanon-qa-store`, and a Kanon test fails on any other name. |
| **P10** | adopter | **The Explorer's sweep becomes the adopter's sweep hook** (§4): the Playwright run, its summary and its report upload, at a fixed path. The lane's database comes from the test-database declaration (`K-LAYOUT-16`) and the project-setup hook, not from the lane's own service block. | `grep -nE 'services:\|POSTGRES_\|playwright' .github/workflows/agent-explore.yml` prints nothing. A sweep finds the same failing routes as the run before the change on the same commit. |
| **11** | Kanon vN+4 | **Move the code audit** (`agent-code-audit.yml`). Its code areas come from a declaration (§5). | `lane-check` is green. **Live:** an audit run files or dedupes, writes its row through the hook, and posts its cost row. |
| **11a** | Kanon | **Kanon audits its own code** (decision 13). Kanon installs a caller for the code-audit lane, pinned to the previous release (ADR 0011's bootstrap), with an Explorer App created and registered with `kanon apps`. Its code areas are Kanon's rules, docs, guards and scripts, declared in Kanon's own stack document. It has no store hook, so it runs without memory (§3.2). It looks for objective contradictions between them, and files on Kanon. | `lane-check` is green on Kanon, and the caller pins the release before the one that moved the lane. **Live:** a scheduled audit on Kanon files or dedupes at least one finding, or says it found none, and posts its cost row. **Mutation:** a caller that reaches the lane through `$/` fails the self-pinning test. |
| **12** | Kanon vN+5 | **Move the Explorer** (`agent-explore.yml`): the change gate, the agent and its quality columns. | **Live:** a scheduled run on an unchanged commit skips; a dispatch with a tier runs the adopter's sweep hook and files from its report. |
| **13** | Kanon vN+6 | **Move the Overseer** (`agent-overseer.yml`), with `cc-sweep.mjs` and `capability-interlock.mjs` into the library. Its playbook joins `K-LAYOUT-17`'s list. It reads the store as files the hook exports (§3.2). It becomes **adopter-scoped and optional** (decision 12): it files adopter-actionable findings as today, and writes Kanon-actionable ones only as drafts in an "Upstream" section of its rolling audit issue. The adoption record says whether it is installed. | **Live:** an Overseer run files its audit issue, with the cache-TTL lines and the token trend present. Every pipeline issue it opened in that run is adopter-actionable, and its audit issue carries an "Upstream" section, empty or not. **Mutation:** a fixture finding classed as Kanon-actionable (a guard's behaviour) ends up in the "Upstream" section and in no new issue; `lane-check` fails an adoption record that doesn't say whether the Overseer is installed, a rule step 13 adds. The adopter holds no agent-lane logic outside its hooks and the two workflows §4 lists. |
| **14** | Kanon, **after plan 0002's store is live, and after the Owner's decision on the first published figure** (plan 0002, decision 7) | **The Explorer reads the hosted telemetry's aggregates** (decision 13). A scheduled Explorer run on Kanon reads only what plan 0002's `aggregate()` returns, looks for anomalies that #41's fixed rules miss, and files on Kanon. It never reads a row, an adopter key or any content. **Plan 0002 doesn't allow this yet,** and this plan doesn't amend it: plan 0002 gives `aggregate()` to the Owner alone (§5), runs it from an Owner script and not on a schedule (§6), and makes the first published figure a separate decision (decision 7). An issue on public Kanon that holds aggregated figures is a publication. So step 14 waits for that decision, and the PR that makes it amends plan 0002's `aggregate()` caller and schedule, if the Owner allows a scheduled agent caller. | **Live:** a run on seeded aggregates with one planted anomaly that #41's rules don't match files exactly one issue, and that issue holds only aggregated figures. **Mutation:** a cell below three distinct adopters is withheld from the run's input, and a finding that names an adopter key fails the filing step's check. |

**Why this order.**
- **The lanes that touch no store go first** (7, 8 and 10). They run only Kanon's scripts already, so their moves are the most mechanical, and they need no answer to the store question.
- **The Merger is first among them,** because it is the smallest and the most valuable to an adopter that runs agents unattended. The reconciler follows, because it is the other half of the unattended loop.
- **The dispatch sweep waits for P7,** because its only store use is a read that the run artifacts can already answer, and that removes the store from it instead of moving the store's credentials into Kanon.
- **The digests wait for P8,** because they don't run on the blocks yet.
- **The three store-coupled lanes go last,** in the order of how much of the store they use: the audit reads one partition, the Explorer adds its sweep, and the Overseer reads everything.
- **Kanon doesn't run these lanes on itself yet.** No agent merges on Kanon (ADR 0011). The reconciler and the sweep act for the Lead and the Implementer, and Kanon has installed neither: its only lane caller is the Reviewer's, `review.yml` (plan 0001's step 4b). The next stage of ADR 0011's rollout, now that #23 and #24 are closed, is a decision of its own, not part of this plan. Kanon also has no product for the Explorer to sweep. So each step's live check runs on the reference adopter, apart from the two Explorer modes Kanon runs on itself (steps 11a and 14, decision 13), and Kanon's smoke workflow covers what it can without a model call.

## 2. What each lane holds

Sizes include comments. "Library" means Kanon's pipeline library, already in Kanon since plan 0001's step 3. Every lane below but the Overseer already reaches the library through `kanon-path` at v0.17.0.

### 2.1 The Merger, `agent-merge.yml` (210 lines)

- **Triggers:** `pull_request_review: [submitted]`; `workflow_run` of `CI`, completed, on the default branch; `schedule` at `7 * * * *`; `workflow_dispatch` with `pr_number` and `apply`.
- **Permissions and secrets:** `contents: read`; the Merger App's ID and key. No environment.
- **Code:** `merge-gate.mjs` (library, 1,540 lines). Nothing of the adopter's.
- **Store:** none.
- **The adopter's own:** the Merger's and the Implementer's App logins, written into the job `if:` (RA-2596's filter, which saves a one-minute job per review event that was never the Merger's); a persona name in `name:`; its own document anchors in comments.
- **Blocks a pure move:** the literal logins (P5). Kanon can't write them, and a job `if:` can't read the register.

### 2.2 The reconciler, `agent-lead-reconcile.yml` (453 lines)

- **Triggers:** `workflow_dispatch` with `project` and `apply`; `pull_request: [closed]`; `issues: [closed]`; `schedule` at `25 * * * *`.
- **Permissions and secrets:** `contents`, `issues`, `pull-requests`, `checks`, `statuses` and `actions`, all read; the Lead App's ID and key. No environment.
- **Code:** `lead-reconcile.mjs`, `brief-revise-recovery.mjs`, `review-recovery.mjs` and `red-unreviewed.mjs`, all library.
- **Store:** none.
- **The adopter's own:** the Lead's login as a literal; the tick budget, 6; the reference environment's deploy workflow, `deploy-staging.yml`, in the Actions probe, and in the library's `readDeploy`; a persona name.
- **Blocks a pure move:** the login (P5) and the deploy workflow's name (P6). The library literal is also an adopter fact that #54's list misses.

### 2.3 The dispatch sweep, `agent-dispatch-sweep.yml` (221 lines)

- **Triggers:** `schedule` at `40 4 * * *`; `workflow_dispatch` with `apply`.
- **Permissions and secrets:** `contents: read`, `id-token: write`; the Lead App's ID and key; the `qa` environment and its role, region and table variables.
- **Code:** `dispatch-sweep.mjs`, library.
- **Store:** reads the **telemetry** partitions (`COST#implementer`, `COST#triage-fix`) for 14 days, to see which dispatches never reached a run. A failed read fails closed: it charges every dispatch, and since RA-2706 the summary says so.
- **The adopter's own:** the environment and variable names; the cloud credentials step; a persona name.
- **Blocks a pure move:** the cloud credentials step, which Kanon can't hold (#15). P7 removes the need for it.

### 2.4 The project digest, `project-digest.yml` (263 lines), and the weekly digest, `weekly-digest.yml` (174 lines)

- **Triggers:** `schedule` daily at 07:35, and weekly on Monday at 08:00; `workflow_dispatch` with `dry_run`, and the weekly one with `week_end`.
- **Permissions and secrets:** `contents`, `issues` and `pull-requests` read; the project digest's health job adds `actions: read` and `issues: write`. The subscription token, the workflow token and a chat webhook. No environment.
- **Code:** `project-digest.mjs` and `weekly-digest.mjs`, library; the health job runs the adopter's `workflow-health.mjs`.
- **Store: none.** Plan 0001 grouped the digests with the store-coupled lanes. They read only GitHub and write only the webhook, and their telemetry goes through `agent-telemetry` as an artifact, like every lane's.
- **The adopter's own:** the webhook's secret name; the health check's knowledge of the Overseer's cadence and its audit issue's title.
- **Blocks a pure move:** they call `claude-code-action@v1` directly instead of `agent-run` (P8).

### 2.5 The code audit, `agent-code-audit.yml` (427 lines)

- **Triggers:** `schedule` at `30 7 */3 * *`; `workflow_dispatch`.
- **Permissions and secrets:** `issues`, `actions` and `contents` read, `id-token: write`; the Explorer App and the subscription token; the `qa` environment.
- **Code:** `agent-quality-columns.mjs` (library); the adopter's `push-run.sh` (287 lines), which writes the store.
- **Store:** the agent itself queries the `AREAS` ledger with the cloud CLI, from its prompt; after the agent, `push-run.sh` writes the raw report to object storage and the `RUN#audit` and `AREAS` rows to the table. The agent's step runs with the store's credentials in its environment.
- **The adopter's own:** the code areas it audits (three source directories, named in the prompt); the bucket milestone's name; the example paths in its report format; a persona name.
- **Blocks a pure move:** the credentialed steps around the agent and inside its prompt; the direct `claude-code-action` call; the code areas.

### 2.6 The Explorer, `agent-explore.yml` (494 lines)

- **Triggers:** `schedule` at `17 6 * * *`; `workflow_dispatch` with `tier`, whose description lists the adopter's six user tiers.
- **Permissions and secrets:** as the code audit; two jobs (`gate`, `explore`), both in the `qa` environment.
- **Code:** `agent-quality-columns.mjs` (library); the adopter's `push-run.sh` and `install-playwright-chromium.sh`; an inline summary script; the adopter's Playwright sweep config.
- **Store:** the `gate` job queries `RUN#explorer` for the newest green full sweep, and skips an unchanged commit, recording the skip as a row. After the sweep, `push-run.sh` writes the raw report, the `RUN#explorer` row and one `COVERAGE` row per route.
- **The adopter's own:** the database service, with the adopter's credentials and port, inline rather than through the hook; `npm ci`, `db:init` and the browser install; the sweep itself and its tiers; the milestone names; a persona name.
- **Blocks a pure move:** the sweep is the adopter's product (§4); the database and install bypass the hook; the store steps; the direct `claude-code-action` call.

### 2.7 The Overseer, `agent-overseer.yml` (680 lines)

- **Triggers:** `schedule` weekly on Monday at 07:00; `workflow_dispatch`.
- **Permissions and secrets:** `contents` and `actions` read, `id-token: write`; the Overseer App and the subscription token; the `qa` environment, and eight variables.
- **Code:** eleven adopter scripts (3,185 lines): the semantic-recall pair (`embed-sync.mjs`, `cluster.mjs`, with `vector-lib.mjs`), the telemetry readers (`token-trend.mjs`, `cache-ttl-check.mjs`, with `qa-store.mjs`, `cutovers.mjs` and `agent-lanes.mjs`), `cc-sweep.mjs`, `capability-interlock.mjs`, and `kanon-checkout.mjs`.
- **Store:** the most of any lane. Before the agent, embeddings are synced to object storage through the cloud's model service, and the token trend reads the telemetry partitions. The agent then queries `RUN#explorer`, `RUN#audit`, `COVERAGE`, `AREAS` and `COST#<agent>` itself, reads raw reports from object storage by key, and runs `cache-ttl-check.mjs`, which reads the telemetry partitions again.
- **The adopter's own:** the route map's source glob; its observability and agent-instruction documents by section; the recall thresholds; a persona name.
- **Blocks a pure move:** the credentialed agent; the telemetry readers, which are plan 0002's (`K-OBS-13`); the recall pair, which is a cloud model service; the direct `claude-code-action` call.

### 2.8 The collector and store maintenance

- **The telemetry collector, not moved by this plan:** `agent-telemetry-collect.yml` (114 lines, hourly at minute 40, `collect-agent-telemetry.mjs`, 294 lines). It writes the telemetry partitions, so it moves at plan 0002's S7 (plan 0002 §8), which the Owner has deferred until after the extraction.
- **Store maintenance,** `agent-maintenance.yml` (77 lines, dispatch only), which deletes stale `COVERAGE` rows with `purge-legacy-coverage.sh`. It is upkeep of the AWS store, so it **moves into Kanon at P9 as part of the AWS implementation** (decision 10), and ships beside the provisioning script. An adopter with a store of its own writes its own upkeep.

## 3. The store question

### 3.1 What the lanes actually do with the store

Two different stores share one table in the reference adopter:
- **the QA store** (`K-OBS-17`): the run reports, `RUN#explorer`, `RUN#audit`, `COVERAGE` and `AREAS`, and the raw reports and embeddings in object storage;
- **the telemetry store** (plan 0002): the `COST#<agent>` partitions.

| Lane | QA store | Telemetry store |
|---|---|---|
| Dispatch sweep | none | reads 14 days of two partitions |
| Code audit | the agent reads `AREAS`; writes a run | none |
| Explorer | reads the last green run; writes a skip, or a run with coverage | none |
| Overseer | the agent reads every QA partition and raw reports; the recall pair writes embeddings | reads every partition, twice |
| Collector | none | writes (plan 0002) |
| Maintenance | deletes stale `COVERAGE` rows | none |

### 3.2 The decision: a contract with hooks, and AWS as the first implementation

**Decided by the Owner, 2026-10-03 (decision 2): "a contract with hooks" so an adopter can bring any store, and "Kanon ships a script that provisions the store on AWS" as the first reference implementation behind it.** The store-coupled lanes move behind the contract, and the lanes that need no store move first. That takes both options the brief offered, in sequence, and rejects only a split of one lane between two repositories.

**This keeps a direction Kanon has written down, behind an interface.** `K-OBS-17` says the QA store is "created there by infrastructure code Kanon ships", chapter 00's assumptions table says "Kanon's infrastructure code creates both" stores, and #19's direction is an interface with "AWS … the *first* implementation". All three hold: the lanes see only the contract, and Kanon's AWS implementation is the first thing behind it. P9's Kanon PR amends `K-OBS-17` and the assumptions-table row only to say so, and to say that the cloud account is needed only by an adopter that runs a store (#19's "done when"). The telemetry store is not affected: plan 0002's stack stays Kanon's (`K-OBS-18`).

**The hook.** `.github/actions/qa-store/action.yml`, a composite action at a fixed path, like the project-setup hook. Kanon defines its operations and the files each one reads or writes; the content is the adopter's. For an AWS store it is one `uses:` line, calling Kanon's AWS action with the table, bucket, region and role it should reach. The operations are the ones §3.1 measured:

| Operation | Called by | Reads or writes |
|---|---|---|
| `last-green` | the Explorer's gate | writes the commit of the newest green full sweep to an output, or nothing |
| `record-skip` | the Explorer's gate | records that a commit was skipped |
| `put` | the audit and the Explorer, after the agent | takes the report file the lane wrote, in a format Kanon fixes |
| `export` | the code audit and the Overseer, before the agent | writes the store's contents that the agent may read into a directory, as files in formats Kanon fixes |

**Jobs of their own.** Every operation runs in a job that holds the store's credentials and does nothing else. The agent's job holds no cloud credentials: it declares its own `permissions:` without `id-token` (P9's check), and gets the export as an artifact. This is `K-OBS-13`'s rule for telemetry ("agent jobs hold no store credentials") applied to the QA store. Today all three agents run in a job that has already assumed the store's role, and the audit's and the Overseer's prompts tell them to run the cloud CLI, so the change also takes away a privilege no agent needs.

**The environment.** The credentialed jobs declare an environment with a fixed name, `kanon-qa-store` (decision 9). The caller grants `id-token: write`; Kanon's lane uses it only in those jobs. OIDC is GitHub's, not a cloud's, so this assumes nothing about the store's implementation. The reference adopter's role trusts the `qa` environment today, so at P9 its trust policy's OIDC subject changes to `kanon-qa-store` (§6).

**The export artifact.** It holds what `K-OBS-17` keeps in the adopter's account: findings, coverage and raw reports. Anyone who can read the repository can download a run's artifacts while they exist, so the export is uploaded with a retention of one day, and a job of its own deletes it, with `actions: write` granted to that job alone. That job needs the export's upload job and runs with `if: always()`, so it runs when the agent job fails or is skipped, and P9's test fails if its condition is anything else. The window is then the run's length. It stays up to a day in the cases no job condition covers: a run cancelled before the delete job starts, or a delete that fails, which turns the run red. That holds the same on a private repository and a public one (`K-PRIN-20`). What the agent files from it is public on a public repository anyway, through the issues it writes.

**Without a hook.** Each operation is a no-op that says so: `last-green` returns nothing, so the Explorer always sweeps; `put` is skipped with a notice; `export` writes an empty directory, and the prompt says the store is absent. So an adopter with no cloud account gets every lane, without memory (#19's "done when").

**The AWS implementation** (`infra/qa-store/aws/`). It follows plan 0002's choices for the telemetry store (its decision 5), so an adopter needs nothing beyond the AWS CLI:
- **a provisioning script** that deploys a CloudFormation template into the adopter's own account: the table and the bucket the reference adopter's store uses today, with deletion protection and `DeletionPolicy: Retain`, so no application stage can delete them (`K-OBS-17`), and the OIDC role trusted for `environment:kanon-qa-store`;
- **an action** that implements the four operations on that table and bucket. It is `push-run.sh` and the Explorer gate's queries, moved from the reference adopter (ADR 0009), not rewritten;
- **the maintenance workflow,** moved from the reference adopter with its task list (§2.8).

The reference adopter keeps its existing table and bucket: its hook passes their names to the action. Moving its data into a stack the script provisions is its own choice, later, and not part of this plan. Kanon prescribes what is deployed, never how an adopter deploys it (plan 0002, decision 12).

**The Overseer's telemetry inputs.** The token trend and the cache-TTL facts are reads of the telemetry store, which plan 0002 owns. Until its step S7, the reference adopter's `export` writes them as two more files, with its existing scripts; after S7 the Overseer's lane reads them through plan 0002's `query`. The recall clusters are the same: `qa-clusters.md`, if the export holds it. Kanon's lane never calls a model service of the adopter's.

**Why not the alternatives:**
- **The lanes call the cloud directly,** with no contract between them. That makes every lane assume a cloud (#15), and it would move the adopter's credentials into Kanon's agent jobs, which plan 0002 already refused for the collector (its §8).
- **The contract with no implementation in Kanon,** which this plan first recommended. The Owner chose to ship AWS too, so that an adopter gets a working store without writing one, and `K-OBS-17` keeps its meaning.
- **Move only the stateless part of each model lane now.** The Explorer's gate, sweep and push surround its agent within one run. Splitting them would leave each run in two repositories, joined by a contract that exists only for the transition. Moving whole lanes after P9 costs the same contract once, and it is permanent.
- **Wait for #19 to finish first.** The hook needs only the interface, which this plan measures, and a no-cloud implementation can follow without changing the lanes.

### 3.3 The dispatch sweep needs no store

The two lanes it watches, implement and triage, are Kanon lanes since plan 0001's steps 3 and 2, and every run uploads a version-2 telemetry row as an artifact, kept 90 days. The row holds every field the sweep reads: `recorded_at`, `run_id`, `issue_number`, `outcome` and `lane`. So P7 gives `dispatch-sweep.mjs` an artifact reader, the shape plan 0002 calls `query(lane, from, to)`, and the sweep stops needing the store at all. When plan 0002's store exists, the reader can switch to it without moving anything.

## 4. What stays in the adopter permanently

- **Its deploys:** the staging and production deploy workflows, and anything that announces them. Kanon only reads the reference environment's deploy, through the P6 declaration.
- **Its Explorer sweep,** at `.github/actions/explore-sweep/action.yml` (decision 5). What the Explorer sweeps, with which tool, and in which tiers, is the adopter's product. Kanon's lane calls the hook, reads a summary in a format Kanon fixes, and gives the agent that summary.
- **Its store hook,** a `uses:` line naming its own table and bucket, and **its semantic-recall pair**, which uses a cloud model service and writes `qa-clusters.md` into the export. `push-run.sh` and the maintenance workflow move into Kanon's AWS implementation at P9.
- **The telemetry collector,** until plan 0002's S7.
- **Its own CI and release workflows,** which aren't lanes.

## 5. Adopter facts that become declarations

Each follows #54's pattern: a file the adopter owns, at a fixed `K-LAYOUT` path, read from the default branch where it affects judging, and failing by name when missing or malformed.

| Fact | Where it is today | Becomes | Step |
|---|---|---|---|
| The Merger's and the Implementer's logins | the Merger's job `if:` | kept in the Merger job's `if:`, read from the register by the `logins` job (decision 8) | P5 |
| The Lead's login | the reconciler's step env | the register | P5 |
| The reference environment's deploy workflow and job | the reconciler's probe; `lead-reconcile.mjs` | the adoption record, beside the reference environment's name (decision 4); also added to #54's list | P6 |
| The tick budget, 6 | the reconciler's step env | a constant in Kanon's lane file: a standard, not a declaration (ADR 0002) | 8 |
| The webhook's secret name | both digests | a fixed name the caller maps (decision 7) | 10 |
| The code areas the audit reads | the audit's prompt | a new section of the stack document, `## Code areas` (`K-LAYOUT-17`; decision 6) | 11 |
| The Explorer's tiers, test-database service and sweep | the Explorer lane | the sweep hook and the test-database declaration | P10 |
| The route map's source glob | the Overseer's prompt | the Explorer's summary, which lists the routes swept | 13 |
| The Overseer's playbook | the Overseer's prompt | a fixed path, added to `K-LAYOUT-17` | 13 |
| Milestone names | the audit's and the Explorer's prompts | "a bucket milestone", as Kanon's other prompts say it; #54 covers deriving them | 11, 12 |
| Persona names, the adopter's document anchors, `#N` references | every lane | substitutions at each move, and `RA-N` | each |

## 6. Each step's follow-up

**In the reference adopter**, every Kanon step is one PR there too, in the same release:
- **Steps 7 to 13:** the caller replaces the lane file; secrets map to their fixed names; the caller takes its fixed name where `docs/lanes.md` gives one; the lane's tests leave its tree (§9); and its scanners stop listing the lane, as plan 0001 §6 describes.
- **Step 9** also deletes the environment and the AWS step from the sweep's caller.
- **P9** replaces `push-run.sh` and the maintenance workflow with Kanon's AWS action and a maintenance caller, and creates the `kanon-qa-store` environment with the store's variables. **An Owner AWS write:** the store role's trust policy changes its OIDC subject from `environment:qa` to `environment:kanon-qa-store`. Until it does, every store job fails red, so the change goes in before the adopter's P9 PR merges. After plan 0002's S7, nothing uses `qa`.
- **Step 10** deletes its `workflow-health.mjs` and test, which now live in Kanon.
- **Step 13** deletes `kanon-checkout.mjs` if nothing else calls it: Kanon's lane reaches its own scripts through `kanon-path`.

**For Kolophon, when step 6 resumes,** each moved lane is one more caller and nothing else Kanon-side:
- **The Merger** needs a Merger App, created with `kanon apps`, and a choice to run it.
- **The reconciler** needs the Lead App and its reference-environment declaration (P6).
- **The dispatch sweep** needs only the Lead App.
- **The digests** need a webhook, or post nothing.
- **The audit, the Explorer and the Overseer** work without a store hook, or with a store Kanon's script provisions, and the Overseer is optional (decision 12). The Explorer needs Kolophon's own sweep hook, because what it sweeps is Kolophon's product.

## 7. The Merger's green zone

**The Merger moves as it is in Kanon v0.17.0,** whose `merge-gate.mjs` escalates every escalation path (`K-MERGE-4`). The reference adopter's own decision, RA-936, let its Merger merge escalation paths, because its production promotion has a required reviewer. Pinning v0.17.0 (RA-2738) already reversed that in practice, so step 7 changes nothing the adopter runs today.

**#158 stays open and independent of this plan.** If the Owner accepts it, the change lands in `merge-gate.mjs` and the rulebook, and reaches the moved lane with the next release. If the Owner declines it, RA-936 is closed as superseded. Either way, the move neither waits for #158 nor decides it.

## 8. Cost

**No schedule or cadence changes.** Each caller keeps its lane's cron exactly:

| Lane | Schedule | Touches the adopter's database cluster? |
|---|---|---|
| Merger | hourly at minute 7, and on each CI completion on the default branch | no |
| Reconciler | hourly at minute 25 | no |
| Dispatch sweep | daily at 04:40 | no |
| Explorer | daily at 06:17 | no: its database is a service container on the runner |
| Overseer | Monday at 07:00 | no |
| Code audit | every third day at 07:30 | no |
| Project digest | daily at 07:35 | no |
| Weekly digest | Monday at 08:00 | no |

So `K-OBS-10`'s wake pricing, which the reference adopter applies to its scale-to-zero database cluster, is not engaged: no step adds a wake. A change to any of these cadences, in any step, is a separate cost decision.

**Actions minutes, not run against the price page.** P9 adds the store jobs: about two per code-audit run, one to the Explorer, which already has its gate job, and two per Overseer run. From the schedules, that is about 10 + 30 + 4 runs a month, so roughly 60 more billed minutes a month on a private repository, under about $0.50 at GitHub's Linux rate. P7's artifact read adds seconds to an existing daily job. P5's `logins` job runs for a few seconds on every Merger trigger that passes the role-neutral clauses, and bills as a minute each on a private repository; the increase is one short job per Merger run, plus one per review the literal login clauses used to skip without a runner: a review on an agent-labelled PR by someone other than the expected reviewer, or of a PR its Implementer didn't author. Those are rare, but not zero. At step 7 the Owner narrowed it to reviews (decision 8), which takes back the sweep's share: about 1,200 to 1,800 billed minutes a month on the reference adopter, whose default-branch CI completes 12 to 37 times a day beside the hourly schedule.

**AWS: none until an adopter runs the provisioning script.** The reference adopter keeps its existing table and bucket, and its store reads and writes are the same calls, made from different jobs, so its spend doesn't change; P7 removes the sweep's reads. An adopter that provisions a store pays for its own on-demand table and bucket. The provisioning step's PR estimates that, under the reference adopter's cost rule, before anything is deployed. No alarm is added.

**No new alarm.** Each lane keeps its paging contract: a red run is the page, as today. The store jobs fail red on a failed write, as `push-run.sh` does now.

## 9. Issues

As in plan 0001 §9: none move ahead of time. When a lane moves, its open issues are re-filed on Kanon, written neutrally, and closed at the source with a link. The candidates today, by title:

| Step | The reference adopter's open issues |
|---|---|
| 8 | RA-2339 (a red-unreviewed test title) |
| 10 | RA-2428 (project-digest's member selection) |
| P9, 11 | RA-2610 (how the credentialed lanes join the blocks: this plan answers it, so it closes at P9); RA-2632 (re-fire an audit after a usage cap); RA-1512 (a fan-out spike for the audit) |
| P10, 12 | RA-2400 (label-guard and `gate-candidate` on Explorer issues); RA-2360 and RA-2357 (`push-run.sh` row drift; move to Kanon at P9, with `push-run.sh`); RA-501 (an idea for a fourth Explorer modality) |
| 13 | RA-2624 (the Overseer's rolling audit issue: stays, it is the adopter's audit); RA-886 (the Overseer sees outcomes, not effort) |

Each step's PR also reads the issues that mention the lane only in their bodies, because a title match misses them: 67 more open issues do today, many of them in passing.

## Measurements

All commands ran on a `git archive` of the reference adopter's `origin/main` (`RA`), and on Kanon's `origin/main` (`K`). GitHub calls used the read-only token.

**Lane sizes** (3,113 lines in ten files):

```
wc -l $RA/.github/workflows/{agent-merge,agent-lead-reconcile,agent-dispatch-sweep,agent-explore,agent-overseer,agent-code-audit,project-digest,weekly-digest,agent-telemetry-collect,agent-maintenance}.yml
```

**Triggers, schedules, permissions, secrets, variables, environments, `uses:`, scripts and models:** a Python pass over each file with comment lines removed, matching `permissions:` blocks, `secrets.X`, `vars.X`, `environment:`, `uses:`, script paths under `$KANON/scripts/`, `scripts/` and `.github/scripts/`, and `--model`. The schedules:

```
grep -nE "cron:" $RA/.github/workflows/<lane>.yml
```

**The adopter's own scripts these lanes run** (16 files, 4,608 lines; only `node:` imports): the same pass's script paths, closed over relative imports in both quote styles, per lane. The library scripts' sizes:

```
wc -l $K/scripts/{merge-gate,lead-reconcile,dispatch-sweep,project-digest,weekly-digest,red-unreviewed,review-recovery,brief-revise-recovery}.mjs
```

**Store access:**

```
grep -nE "aws |dynamodb|s3 |environment:|id-token" $RA/.github/workflows/<lane>.yml
grep -nE "QA_DYNAMO_TABLE|COST#|dynamodb" $K/scripts/dispatch-sweep.mjs
grep -nE "aws |s3://|dynamodb" $RA/scripts/qa/push-run.sh
```

**The library's deploy literal:**

```
grep -n "deploy-staging" $K/scripts/*.mjs
```

**No `lane:` input on the model lanes' telemetry step** (so they write no version-2 row yet), and the version-2 row's fields:

```
grep -A8 "agent-telemetry@" $RA/.github/workflows/{agent-explore,agent-overseer,agent-code-audit,project-digest,weekly-digest}.yml | grep -E "lane:"
grep -nE "^\s+(issue_number|outcome|run_id|recorded_at|lane)\s*:" $K/actions/agent-telemetry/schema.mjs
```

**The database cluster:** none of the ten files names the adopter's database endpoint.

```
grep -niE "aurora|DATABASE_URL" $RA/.github/workflows/<lane>.yml
```

Every hit for the cluster is a comment saying the lane touches none. The only `DATABASE_URL` is the Explorer's, which points at its service container on `localhost`.

**The adopter's tests for these lanes** (27 files, 16,211 lines):

```
ls $RA/tests/unit | grep -E '^(merge-gate|lead-reconcile|dispatch-sweep|review-recovery|red-unreviewed|brief-revise-recovery|filter-job-if|project-digest|workflow-health|explorer-|code-audit|overseer-|capability-interlock|cc-sweep|token-trend|cache-ttl-check|qa-cluster|collect-agent-telemetry)'
```

Thirteen of them import the library from the adopter's `.kanon/` checkout (`grep -c '\.kanon/'`). They move to Kanon with their lane, except `collect-agent-telemetry`, which waits for the collector. One, `dispatch-sweep-cost-read`, already has a ported copy in Kanon's `tests/library/`, so the adopter's copy goes at step 9. The rest test the adopter's own scripts, and move with the script or stay with the store hook.

**Open issues** (240 open in the reference adopter): a Python match of each open issue's title, and separately its body, against each lane's workflow name, script names and role name:

```
gh issue list --state open --limit 500 --json number,title,body
```

## Decisions for the Owner

1. **Decided by the Owner, 2026-10-03: accepted.** **The order** (§1): the non-model lanes and the digests first, then the dispatch sweep after P7, then the store-coupled lanes behind the store contract.
2. **Decided by the Owner, 2026-10-03: changed.** **The store question** (§3.2). The plan recommended a store hook the adopter writes, with every implementation the adopter's. The Owner decided: provide "a contract with hooks" so an adopter can bring any store (the hook at `.github/actions/qa-store`, its four operations and formats, store jobs separate from agent jobs, a no-op without a hook), and "Kanon ships a script that provisions the store on AWS", as the first reference implementation behind the contract. That **keeps** `K-OBS-17`'s "infrastructure code Kanon ships", now behind #19's interface, instead of reversing it.
3. **Decided by the Owner, 2026-10-03: accepted.** **The dispatch sweep reads run artifacts** (§3.3, P7), not the store.
4. **Decided by the Owner, 2026-10-03: accepted.** **The reference environment's deploy goes in the adoption record** (P6), beside the reference environment's name, and joins #54's list.
5. **Decided by the Owner, 2026-10-03: accepted.** **The Explorer's sweep stays the adopter's,** as a hook at `.github/actions/explore-sweep/action.yml` that writes a summary in Kanon's format (§4).
6. **Decided by the Owner, 2026-10-03: accepted.** **The audit's code areas** go in a new stack-document section, `## Code areas`.
7. **Decided by the Owner, 2026-10-03: accepted.** **The digests' webhook** reaches Kanon's lane under the fixed secret name `DIGEST_WEBHOOK`, and the message stays the `{"text": …}` body.
8. **Decided by the Owner, 2026-10-03: changed.** **The Merger's logins** (P5). The plan recommended dropping the login clauses from the Merger job's `if:`. The Owner decided: "keep the Merger's login clauses, but read the logins from the App register, not literals". A small first job reads the register and outputs the logins, and the Merger job's `if:` uses `needs.<job>.outputs`. The cost is that job, a few seconds on every trigger it admits (§8). **Amended by the Owner, 2026-10-04, for step 7:** the logins job starts only on a review, the one trigger whose `if:` needs a login. CI's completion, the schedule and a dispatch start the Merger's job alone, which holds the membership gate itself, so the sweep bills one runner, not two. A review still needs the logins job to have succeeded, and is compared against its outputs.
9. **Decided by the Owner, 2026-10-03: changed.** **The store jobs' environment is `kanon-qa-store`,** not `qa` as recommended. The reference adopter updates its AWS trust policy's OIDC subject to match, an Owner AWS write at P9 (§6).
10. **Decided by the Owner, 2026-10-03: changed.** The collector doesn't move in this plan; it moves with plan 0002's S7. "The maintenance workflow moves into Kanon as part of the AWS store implementation" (P9, §2.8): the upkeep ships with the provisioning script, and an adopter with its own store writes its own. The plan had recommended keeping it in the adopter.
11. **Decided by the Owner, 2026-10-03: accepted.** **The Merger moves as it is,** and #158 stays open (§7).
12. **Decided by the Owner, 2026-10-03: the Overseer becomes adopter-scoped and optional** (step 13).
    - **Findings go by who can act.** Adopter-actionable findings go to the adopter's repository, as today: declarations, playbooks, Apps and permissions, cost and schedules, labels and milestones, test and spec coverage. Kanon-actionable findings (lane behaviour, guards, rules) are **never filed in the adopter's repository**. They go into an **"Upstream" section** of the rolling audit issue, as a neutral, ready-to-file draft that the adopter may file on Kanon by hand.
    - **Never filed directly on Kanon.** Kanon is public, so a direct filing would cross ADR 0007's data boundary, and it would need trust across organisations.
    - **Kanon's automatic learning channel stays #41,** the content-free telemetry job.
    - **The Overseer is an optional lane.** Whether it is installed or not, the adoption record says so.
    - **Out of scope:** automatic upstream filing for the Owner's own projects. It is a possible later decision.
13. **Decided by the Owner, 2026-10-03: the Explorer runs on Kanon itself,** extending ADR 0011's staged rollout.
    - **Code-audit mode on Kanon's own codebase** (step 11a): objective contradictions between rules, docs, guards and code. Once the code-audit lane has moved (step 11), Kanon installs a caller pinned to the previous release (ADR 0011's bootstrap), with an Explorer App created with `kanon apps`. Its findings are filed on Kanon, because they are about Kanon.
    - **Explore mode on the hosted telemetry** (step 14): the Explorer reads the store's **aggregates only**, and looks for anomalies that #41's fixed rules miss.
      - **Gated on the telemetry store being live,** which is deferred (plan 0002, decision 16).
      - **Privacy:** anything filed on public Kanon follows plan 0002's decision 7 and ADR 0007's rule 5: aggregated, anonymised, at least three distinct adopters per cell, and never an adopter key or any content.
      - **Relation to #41:** #41 stays the deterministic channel, and the Explorer adds a judgement layer on top.
