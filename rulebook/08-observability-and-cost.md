# 08 Observability and cost

This chapter governs two kinds of decision that are easy to skip because skipping them looks free: whether a new operational signal should wake a human, and whether a change should be allowed to raise spend. Kanon's answer to both is the same. The decision is made explicitly, in the change that creates the need for it, and it is recorded, so a deliberate "no" can always be told apart from a signal or a cost nobody thought about. The mechanisms are framework. The adopter's alerting stack, its signal names and its prices are project content.

## Signals

### `K-OBS-1` Every feature decides its observability

**Rule.** When a feature adds a failure mode or an operational surface (a job, a webhook, an external integration, an asynchronous path), decide explicitly whether to extend observability, and surface that decision for discussion with its reason, whether the answer is to add or to skip.

**Why.** A skipped decision is indistinguishable from a forgotten one. Surfacing it the same way a cost change is surfaced means the "no" is on record too.

**Enforced by.** The brief guard fails a brief whose observability section has no add-or-skip decision (`K-PROJ-6`). Outside briefs, prose only.

**Class.** split. The decision rule is framework. **The project supplies:** its alerting and query stack, and what counts as an operational surface in it.

### `K-OBS-2` What pages is code; what it means is one document

**Rule.** Define everything that pages in infrastructure code. Keep what each signal means in one observability document, `docs/observability.md`, laid out as `K-LAYOUT-5` fixes, and update that document in the same change that adds or alters a signal. Where the document restates the paged list, keep the two in agreement.

**Why.** The two sources have distinct jobs: the code decides what pages, the document explains what it means. The restated list in the reference adopter drifted from the configuration four times in four PRs, and twice the drift reached production as a signal that paged nowhere.

**Enforced by.** A parity test that fails when the document's paged list, its per-signal table and the infrastructure code's paged list disagree.

**Class.** split. The two homes, the document's path and anchors (`K-LAYOUT-5`), and the parity check are framework. **The project supplies:** the alerting mechanism, any stack-specific sections of the document, and the signal vocabulary.

### `K-OBS-3` Every signal has exactly one recorded decision

**Rule.** Every signal the code emits is either on the paged list or in the not-paged table, and never both. A not-paged entry carries the reason and the trigger that would change the answer. "Not decided" is not a state a signal may be in. Write signal names as literals the guard can read, or annotate the emit site with the names it emits, and keep names on the naming convention.

**Why.** A signal that was born and forgotten is otherwise indistinguishable, on every surface, from one somebody deliberately declined. Deciding "no" stays cheap and one line long; not deciding stops being possible.

**Enforced by.** A test-time guard that scans every emit site in the source, fails when a signal name is in neither or both of the paged list and the not-paged table, and fails hard on an emit site whose name it cannot resolve and which carries no annotation.

**Class.** framework

### `K-OBS-4` A signal earns a page only by passing the admission rule

**Rule.** A signal pages only when all five hold:

1. there is a specific human action, and it cannot wait for someone to go and look;
2. nothing retries its way out;
3. the healthy value is exactly zero, or a threshold is defensible from measured data;
4. nothing else already sees it;
5. the cost of the alarm is stated in the change.

A signal that fails any test is recorded as not-paged (`K-OBS-3`).

**Why.** The rule was extracted from about twenty earlier paging decisions, so the next signal is a check against a rule rather than a fresh argument. Before it existed, half a dozen signals stalled for months on the same unanswered question.

**Enforced by.** Prose only, applied in review.

**Class.** framework

### `K-OBS-5` Split a signal until one half reads a true zero

**Rule.** When a signal is blocked on test 3 because nobody can defend a threshold, split it until one half has a healthy value of exactly zero, and page on that half. Don't guess a rate.

**Why.** A true zero is the cheapest possible page: it needs no baseline and cannot false-fire.

**Enforced by.** Prose only.

**Class.** framework

### `K-OBS-6` Pipeline surfaces fail the job, and a job that is always red escalates

**Rule.** For surfaces hosted in CI (the pipeline's own jobs and writers), prefer failing the job plus the Overseer's liveness read to a new cloud alarm, and record that no-alarm decision. Escalate an agent workflow that is red on every run to a human.

**Why.** CI jobs are not cloud compute, so cloud alarms don't apply to them. But a failed scheduled run notifies nobody: a reconciler in the reference adopter failed on every run for weeks unnoticed.

**Enforced by.** A workflow-health check that finds workflows red on every recent run and escalates them.

**Class.** split. The preference and the escalation are framework. **The project supplies:** its cloud alarm mechanism.

### `K-OBS-7` Production is observed through alarms, never agent sweeps

**Rule.** Agents that explore or sweep the application never target production. Production is observed through its alarms.

**Why.** It is a deliberate boundary, and it should not depend on an environment variable happening to point somewhere safe.

**Enforced by.** The sweep workflows target a non-production environment by construction.

**Class.** split. The boundary is framework. **The project supplies:** its production alarms.

### `K-OBS-8` A hand-created resource is dated, and configured is not delivered

**Rule.** For a resource created by hand outside infrastructure code (a budget, a notification channel), record in the observability document's hand-created-resource table (`K-LAYOUT-5`) either "not yet created", with the tracking issue, or "created" with a date. Keep a check that the configuration is right distinct from a proof that it delivers.

**Why.** An undated "created" is indistinguishable from never created. A notification path can be configured correctly and still deliver nothing.

**Enforced by.** Documentation checks that fail when such a resource's entry has neither state, a "created" state with no date, or a "verified" claim that doesn't say whether it is a configuration check or a delivery proof. Whether the claim is true is outside what a checkout can see.

**Class.** split. The recording rule is framework. **The project supplies:** its hand-created resources.

## Cost

### `K-OBS-9` Spend is discussed before it is incurred

**Rule.** Any change that raises cloud spend (new resources, added capacity, new paid service usage, a new alarm or custom metric) needs the Owner's agreement first. Estimate the monthly delta, say what drives it, and get a yes before implementing. State the delta per environment, multiplied by the number of environments the change is deployed to.

**Why.** Costs that are each reasonable multiply. In the reference adopter a job and the budget alerts were each correct on their own, and nobody had multiplied them together until both budget alerts fired in the first week of the month. The number of environments is the multiplier most easily left out, because each environment's figure looks small on its own.

**Enforced by.** The brief guard requires a priced cost section in every brief (`K-PROJ-6`). Outside briefs, prose only.

**Class.** split. The rule is framework. **The project supplies:** its cloud provider's prices and what counts as a resource.

### `K-OBS-10` A recurring schedule is priced by what it wakes

**Rule.** Before adding a recurring schedule that touches a scale-to-zero resource, or shortening an existing one's interval, state the tick frequency, how many extra wakes per day it adds beyond the existing tick, whether it touches the resource at all, and a rough monthly delta per environment, multiplied by the number of environments it runs in, and get agreement on that number. This covers every kind of schedule wherever it is defined: scheduled jobs, event rules, timed consumers, warmers, external uptime probes, scheduled CI jobs that reach the application. Align a new job to the top of the hour (minute 0) wherever the work tolerates it, so that every hourly job shares one wake; on a project that has no hourly job yet, the first one sets that tick at minute 0. Treat any sub-hourly cadence as a cost decision needing justification. Split a frequent probe: check liveness often against something that touches nothing, and reachability rarely.

**Why.** The meter is the resource that wakes up, not the thing that calls it. An external uptime probe defined in a vendor's configuration, not in the infrastructure code, kept a scale-to-zero database awake permanently and defeated scale-to-zero on a whole stage. A reminder job on a fifteen-minute tick did the same and cost several hundred dollars a month for a job whose real requirement was "within an hour". An aligned job costs almost nothing extra.

**Enforced by.** Prose only.

**Class.** split. Pricing a schedule by what it wakes, alignment and probe-splitting are framework. **The project supplies:** its scale-to-zero resources, their idle timeout, their unit price and how many instances bill (see the example below).

### `K-OBS-11` Agent spend is budgeted like cloud spend

**Rule.** Agree an agent workload's budget and cadence up front, and log anything skipped for budget. Reach for the standing levers first: pick the model tier by task, downsample screenshots, keep cadences disciplined, cache stable prompt prefixes, and pre-filter with a shell step so a no-op tick never starts a model. Moving an agent to a more expensive model needs agreement under `K-OBS-9`.

**Why.** Agent runs draw on a shared rate-limit pool that competes with hands-on work. Moving one audit agent to a pricier model would have doubled its rate.

**Enforced by.** Prose only.

**Class.** framework

### `K-OBS-12` Every agent run has a dollar ceiling no normal run reaches

**Rule.** Give every agent run a dollar ceiling derived from its turn cap at a fixed per-turn rate, rounded up, so that it catches runaway fan-out and nothing else. Change the derivation and every workflow together; to move the ceiling, raise the per-turn rate, not one run's figure.

**Why.** A capped run loses its artifact, so a ceiling a normal run can hit destroys work. A ceiling well above normal only stops the runaway case.

**Enforced by.** A unit test that fails when any agent step's ceiling disagrees with its turn cap and the per-turn rate. For a run whose turn cap a person raised for that one dispatch, `agent-run`'s turn-limit step derives the ceiling from the raised cap at the same rate, held by [`tests/unit/agent-run-turn-budget.test.ts`](../tests/unit/agent-run-turn-budget.test.ts) ([the lanes' "The turn budget"](../docs/lanes.md#the-turn-budget)).

**Class.** framework. Kanon ships the per-turn rate as part of its standard lane table, so every adopter's ceilings are derived the same way ([ADR 0005](../docs/decisions/0005-roles-and-standard-lane-settings.md) §3).

### `K-OBS-13` Telemetry is written by one credentialed collector

**Rule.** Record a cost row for every agent run through a single collector job that holds the store's credentials. Agent jobs upload their reports as artifacts and hold no store credentials.

**Why.** Granting cloud credentials to a job that executes PR code grants them to the PR's code.

**Enforced by.** From vM, the release that ships [plan 0008](../docs/plans/0008-self-service-registration.md)'s token path: the hosted store's ingest function accepts a row only with a GitHub OIDC token whose `job_workflow_ref` is Kanon's `telemetry-collect.yml` at a release tag, issued for the repository's default branch, with the store's audience (`infra/telemetry/function/oidc.mjs`, one mutation-checked test per claim in `tests/unit/telemetry-oidc.test.ts`). This is enforced by Kanon's code, not by IAM: the function is the gate. Which job of that workflow may mint such a token is held by the id-token guard (`tests/unit/helpers/store-jobs.ts`, `isCollectorJob`), and that job's `if:` keeps a dispatch to the default branch (`tests/unit/telemetry-collect-lane.test.ts`). Agent jobs hold no `id-token: write` (the store-coupled lanes' tests). **Not enforced:** that the rows the collector sends are true; a repository can upload any artifact from its own workflows, and send it under its own key. **From vM+1** (plan 0008 J9) the SigV4 path and its writer roles are gone, so no role in the store trusts GitHub's OIDC provider, which `tests/unit/telemetry-store-template.test.ts` fails on, and no job's token writes unless it is the collector's: not even another default-branch job holding `id-token: write`, such as Kanon's QA-store jobs, which declare no environment, or the adopter's own jobs that hold it for another cloud ([`docs/telemetry.md`](../docs/telemetry.md#who-can-write)). The Owner's importer and backfill roles write only through their own aliases, as the Owner.

**Class.** framework. Where the collector writes is set by `K-OBS-17` and `K-OBS-18`.

### `K-OBS-14` Cost and quality claims are measured, not self-reported

**Rule.** Derive an agent's quality measures from platform facts (review events, issue labels and severities), never from the agent's own report. Claim a cost effect only from a comparison controlled for work size, with a confidence interval, and distrust a report that finds a win every week.

**Why.** A saving that comes with a recall regression looks like a win in every cost column. A reported six per cent saving in the reference adopter turned out to be an artifact of smaller work that week.

**Enforced by.** The quality-column derivation reads only platform data, and the cost-trend report computes size-controlled comparisons with intervals.

**Class.** framework

### `K-OBS-15` Standard cache and fallback settings, guarded against drift

**Rule.** Every agent run uses Kanon's standard prompt-cache TTL and fallback-model policy for its kind. Runs that produce a verdict (review, audit, oversight) have no fallback model. Runs whose output something else checks (implementation, fixes) may fall back to a model of the same tier or cheaper. The cache TTL follows how long each kind of run sits idle: a run that never idles past five minutes uses the five-minute TTL.

**Why.** A missing verdict is loud; a verdict from a different model than intended is silent. The one-hour cache costs twice as much to write, so it is waste on a run that never idles that long. Letting each project set these would reopen the configuration question (`K-PRIN-1`), and silent drift in them has already cost the reference adopter money. See [ADR 0004 §6](../docs/decisions/0004-disputed-rules.md).

**Enforced by.** A unit test that fails when a verdict-producing step declares a fallback model or a checked-output step's fallback is missing or of a higher tier, and a cache-TTL detector over the run telemetry that reports any run whose cache writes departed from its standard TTL, and says how many runs it examined.

**Class.** framework

## Data boundary

These rules decide what leaves an adopter's project, where it is kept, and who may see it ([ADR 0007](../docs/decisions/0007-data-boundary.md)).

### `K-OBS-16` Telemetry is metadata, never content

**Rule.** A telemetry row may contain only:
- the opaque key the store files it under, and the issue or PR number;
- the agent **role**, never a GitHub username or account;
- the lane, model, token counts, cost and duration;
- the outcome, and a bail or failure reason chosen from a fixed list of codes;
- the run's identity: its run id and attempt, its trigger, and when it was recorded;
- its configuration: effort, turn cap, compaction window, the prompt-cache TTL it was pinned at, and configuration fingerprint;
- work-size and output counts;
- the verdict, and diagnostic codes: terminal reason, API status, error flag and execution-file form;
- attribution codes: the Kanon version, the failed stage, and a Kanon error code from Kanon's own list.

A work-item row, which describes one pull request, may also contain:
- **work amounts:** counts of lines, files, directories, files per area, tests, acceptance criteria, cited spec ids, blocking issues and commits, and a boolean per escalation category from Kanon's closed list;
- **times of platform events,** and the durations between them;
- **actor classes:** a role, `human` or `other_bot`, never a login, name or account id;
- **label-derived enums and counts:** the item's origin, follow-up severities and fates, and check conclusions;
- **Kanon's own codes:** the Merger's escalation reasons and guard ids;
- **linked numbers:** the issues it closes, and the PRs that revert or fix it.

An upstream-finding row, which carries one finding only Kanon can act on and is sent only when the adoption record opts in (`K-LAYOUT-10`), may also contain:
- **its run:** the run id and attempt of the lane that found it, and the finding's position in that run's report;
- **Kanon's own codes:** the reporting lane, the subject, the evidence level and the scrub version;
- **the signature's codes:** the lane, stage, Kanon error, reason and Kanon version, from the run row's lists;
- **Kanon's vocabulary:** rulebook ids, the paths of files Kanon ships, and a suggested-fix category from Kanon's closed list.

A deploy row, which describes one release's deploy to one environment of the chain the adoption record declares (`K-SHIP-12`), may also contain:
- **the environment's place, never its name:** its **role**, `production` for the last environment of the chain and `pre-production` for every other, and its **position** in the chain, counted from 1;
- **its run's kind:** the trigger, and whether the release is a pre-release, the deploy a redeploy of a commit this environment already has, or a rollback to an older one;
- **Kanon's own codes:** the outcome, the stage that failed and the refusal, from Kanon's closed lists;
- **durations:** the wait before the environment's job, the build, the deploy and smoke hooks, the environment's job, and the time from the release's publication to the deploy's end.

A deploy row never holds the release's commit or tag, the adopter's version, an environment's name, a URL, the reviewer, or any name from the cloud. Deploy rows are stored, and never published across adopters ([plan 0010](../docs/plans/0010-deployment-lane.md) §10).

A notify row, which describes one `notify` job's delivery of one lane's message through the adopter's hook (`K-OBS-19`), may also contain:
- **the message and the hook:** the message's kind and its contract version, from Kanon's closed lists, and the hook's kind, `slack`, `webhook` or `custom`;
- **its run:** the producer's attempt, beside the `notify` job's own run id and attempt;
- **Kanon's own codes:** the outcome, `posted`, `failed` or `skipped`, a skip reason only with `skipped`, and a failure only with `failed`, from Kanon's closed lists;
- **a duration:** from the message's download to the hook's end.

A notify row never holds a URL, a channel, a host, the message's text, the hook's status body or a secret. Notify rows are stored, and not published: nothing reads them until the follow-up reader that [plan 0011](../docs/plans/0011-notifications.md)'s decision 19 names (§11).

No row contains code, prompts, issue or PR text, file paths outside Kanon's own tree, error messages or any other free text, with one exception: an upstream-finding row sent with evidence carries the finding's evidence and suggested fix as text, bounded in length. The lane writes that text for Kanon's maintainer to Kanon's template, in roles rather than names and without quoting the adopter, and then a deterministic scrub removes every URL, email address, credential shape and path outside Kanon's tree, the repository's own name, and the logins and names the lane can see. It may rarely still contain personal data, which the opt-in says. That text is read by Kanon's maintainer and by one third-party decision provider, never published ([ADR 0007](../docs/decisions/0007-data-boundary.md)).

**Why.** Telemetry is the one thing that may leave an adopter's project, so it must be safe to leave by construction, not by review. Free text is how content leaks: a bail reason or an error message can quote code, and a file path reveals a project's structure. Without usernames, the rows hold no personal data, which keeps hosted telemetry almost entirely outside data-protection law; an upstream finding sent with evidence is the one row that may rarely hold some, and is opted into knowing it. The longer allowed list holds only metadata: numbers, times, and values from closed lists that Kanon defines. Cost work needs it to compare like with like, and to check a prompt-cache pin on the runs that ran under it, because a pin that silently fails to apply looks like ordinary spend. The work-item row needs it to say what the spend bought ([plan 0002](../docs/plans/0002-hosted-telemetry-store.md), decision 2; [plan 0003](../docs/plans/0003-metrics.md) §5.3). A deploy row records an environment's role and position rather than its name, and no release tag or commit, because any of those would let whoever can read the adopter's public repository say whose row it is, which the opaque key exists to prevent; the role is all the metrics need, since they are measured on production ([plan 0010](../docs/plans/0010-deployment-lane.md) §10, §11). A notify row records whether a message was delivered and through which kind of hook, never where it went or what it said, because a webhook URL is a credential, and a channel, a host or the text would say whose row it is, or quote the project it describes ([plan 0011](../docs/plans/0011-notifications.md) §11, decision 14). The one exception, an upstream finding's evidence, exists because a finding without its evidence often can't be acted on; it is opted into on its own, written to Kanon's template rather than quoted, scrubbed by fixed rules rather than by review, and never published ([plan 0006](../docs/plans/0006-upstream-findings.md)).

**Enforced by.** The schema module, `actions/agent-telemetry/schema.mjs`. It lists every field each row kind may carry, with its type, enum or pattern, and its `validate` rejects a whole row with any field outside the list, any value outside its enum or pattern, or a reason code that doesn't match the outcome, naming fields and never values. The lane writes its row only when it validates, and the unit tests fail when a fixture's row doesn't, or when a field, a sentence or a code outside the list gets through. The hosted store's ingest function runs the same check (`infra/telemetry/function/index.mjs`). The deploy row is held the same way, its role from a closed list, its position an integer from 1, and no field for an environment's name, a release or a commit ([plan 0010](../docs/plans/0010-deployment-lane.md), step D3). The notify row is held the same way, its hook's kind, message kind, outcome, skip reason and failure from closed lists, a skip reason only with `skipped` and a failure only with `failed`, and no field for a URL, a channel, a host, text, a status body or a secret ([plan 0011](../docs/plans/0011-notifications.md), step N5; `tests/unit/telemetry-schema.test.ts`). The upstream-finding row is held the same way, and its two text fields are bounded in length, refused with a control character or an HTML comment, and checked by the scrub, [`actions/agent-telemetry/scrub.mjs`](../actions/agent-telemetry/scrub.mjs), whose `verify` the schema's `validate` runs, so a text that still holds a URL, an email address, a login, a key's or a credential's shape, a path outside Kanon's tree or a forbidden word is refused, by the rule's name ([plan 0006](../docs/plans/0006-upstream-findings.md), step F1; `tests/unit/telemetry-finding.test.ts` and `tests/unit/telemetry-scrub.test.ts`). At intake, the ingest function stores a finding row from a writer only, and only once its text also passes `verify` with the sender's own name hashes, which, from vM, the function computes from the token's `repository` claim (on the SigV4 path until vM+1, it reads them from the sender's registration), and no field holds a registered key (`assertNoKey`); the collector sends finding rows only at the level the adoption record on the default branch declares, stripping the text for `sent` (plan 0006, step F4; `tests/unit/telemetry-ingest.test.ts`, `tests/library/telemetry-collect.test.ts`, and `infra/telemetry/verify.mjs` against the deployed store).

**Class.** framework

### `K-OBS-17` Project QA data stays in the adopter's own account

**Rule.** Everything that describes the adopter's application stays in the adopter's own cloud account: run reports and findings, route coverage, signal precision, the code-reading ledger and the embeddings used to deduplicate findings. Its lifecycle is independent of any application stage, so tearing down an environment can never delete it. When the adopter has several cloud accounts, the QA store, and a self-hosted telemetry store, live in the **reference environment's account** (`K-PROJ-11`).

The lanes reach the QA store only through Kanon's **store contract**: a hook the adopter writes at `.github/actions/qa-store/action.yml`, with five operations (`last-green`, `record-skip`, `put`, `export` and `cost-rows`) and the files each reads or writes ([`docs/qa-store.md`](../docs/qa-store.md)). Kanon's **AWS implementation** is the first behind it: infrastructure code that creates the store in the adopter's account, and an action the hook calls. Any other store implements the same five operations. Every store operation runs in a job of its own, which, besides the Overseer's telemetry read job held to its exact shape, is the only kind of job in the store-coupled lanes that holds `id-token: write`; the store's role trusts the default branch's ref, never an environment, and an agent job holds no store credentials, as `K-OBS-13` has it for telemetry. An adopter with no hook needs no cloud account for this: every lane runs, without memory, and says the store is absent.

**Why.** That data is the adopter's content, not Kanon's. Keeping it in the adopter's account is the cleanest boundary there is, and it means Kanon never holds another team's code findings. The lifecycle clause exists because the reference adopter kept its store inside a staging stage, and a teardown of that stage once emptied the run reports. The contract keeps the lanes cloud-neutral: they see five operations, never a cloud, and an adopter that brings another store changes only its hook. Separate store jobs keep the store's credentials away from the agent, which needs to read the store, not to hold the key to it.

**Enforced by.** `tests/unit/qa-store-aws.test.ts`, which fails Kanon's AWS template when the table lacks deletion protection, when the table or the bucket isn't retained, when a stage names, conditions or parameterises either, and when its role trusts anything but exactly its `Subjects`; `provision.mjs`, which refuses to deploy such a template, and refuses a subject that is not the repository's default-branch ref (an environment, a pull request, a tag, another branch, a pattern, another repository), reading the default branch from GitHub's API even when the subjects are given; `tests/unit/helpers/store-jobs.ts`, which each store-coupled lane's test applies, and which fails an agent job that holds `id-token` and any job of a store-coupled lane that declares an environment; and `tests/unit/id-token-guard.test.ts`, which fails any job of any Kanon workflow that holds `id-token: write`, by its own grant, the workflow's or its caller's, unless it runs the `qa-store` block or the AWS store's maintenance block alone, is the telemetry collector's `collect` job, the telemetry Explorer's `aggregate` job, the Overseer's `telemetry` job or the metrics page's `aggregate` job in `metrics-page.yml` in its exact shape, or calls a lane that has such a job. Which of the adopter's own default-branch jobs hold `id-token: write` is the adopter's to check: each of them can assume the store's role ([`docs/qa-store.md`](../docs/qa-store.md#who-can-reach-the-store)). That the adopter's own store follows the lifecycle clause is prose only.

**Class.** framework

### `K-OBS-18` Hosted telemetry is opt-in, EU-hosted, and kept for thirteen months

**Rule.**
- **Opt-in.** By default telemetry stays in the adopter's own repository: each lane run keeps its row as one of the run's artifacts, and no collector sends it anywhere, which is what the answer **No** gives. Sending it to the Kanon-hosted service is an explicit opt-in.
- **Upstream findings are a second opt-in.** Sending upstream findings to the Kanon-hosted service, with or without their evidence text, is declared on its own in the adoption record, and needs the first.
- **Where and how long.** Hosted telemetry is kept in the EU (Frankfurt) for thirteen months, and an adopter's data is deleted on request: from vM, by the adopter, with one dispatch of its caller, or by the operator.
- **Who sees what.** An adopter sees only their own data. Anything shared across adopters, including published cost figures, is aggregated and anonymised.

**Why.** An open-source tool that sends data home by default loses the trust it depends on. Thirteen months allows year-on-year comparisons, and no more. Opting in is also what feeds the cross-adopter improvement work, so the value of opting in has to be visible to the adopter, not assumed.

**Enforced by.** The installer's opt-in is one consent question that sets both opt-ins, *Yes*, *Codes only* or *No*, sends nothing without an explicit answer, and links [`docs/sharing.md`](../docs/sharing.md) for what is sent, where it is kept and for how long, who reads it, and how to stop and erase it ([plan 0007](../docs/plans/0007-guided-install.md) §3, Q4). `kanon init` asks it, as `CONSENT_QUESTION` in `cli/init.mjs`, and the `/kanon:adopt` skill asks it word for word ([`docs/init.md`](../docs/init.md#sharing)). [`tests/unit/kanon-init.test.ts`](../tests/unit/kanon-init.test.ts) fails when `init` writes the collector's caller without an explicit yes (by default, under `--yes`, `--json` or a dry run, or on an answer it doesn't recognise), when `--yes` alone records upstream findings as anything but `drafted`, and when the skill's question differs from `init`'s. From vM, each adopter reads only its own rows through the function, which finds the key from the token's `repository_id` and reads under a session policy scoped to that key; which key is chosen is code-enforced ([plan 0008](../docs/plans/0008-self-service-registration.md) §3.5, §11).

**Class.** framework

## Notifications

What the lanes tell people in chat, and where the code that posts it may run ([plan 0011](../docs/plans/0011-notifications.md)).

### `K-OBS-19` A lane notifies only through Kanon's notification contract, and a hook runs only in a `notify` job

**Rule.**
- **One contract.** Everything a lane sends to people in chat (the daily project digest, the weekly digest and a deploy's announcement) is one message in Kanon's notification contract, `kanon-notify`: a kind, a severity, a title, a summary, sections and links, in plain text and Kanon text, within fixed limits. One library builds and checks it, [`scripts/lib/notify-contract.mjs`](../scripts/lib/notify-contract.mjs), and [`docs/notifications.md`](../docs/notifications.md) describes it with its published JSON Schema. A lane never formats for a chat system. Its one producing job builds the message with the library's `fit` and uploads it as an artifact; it never reads a chat secret and makes no request to anything but GitHub.
- **One place a hook runs.** Only the adopter's hook posts: the composite action at `.github/actions/notify/action.yml` (`K-LAYOUT-1`), which is Kanon's Slack hook, Kanon's generic JSON webhook hook or the adopter's own. The hook runs only in the lane's `notify` job. That job validates the message before any hook runs; it holds its kind's chat secret and no other (`KANON_CHAT_PROJECT_DIGEST`, `KANON_CHAT_WEEKLY_DIGEST` or `KANON_CHAT_DEPLOY`), a token that reads contents and nothing more, and no App key, Claude credential or OIDC grant; and it is in no workflow a pull request can start. A kind's secret appears nowhere else, except as one presence check in its lane's gate.
- **No hook, nothing posts.** There is no built-in fallback. Without a hook, or without the kind's secret, the kind is not posted, and no model runs to write it.
- **The run's own hook.** The `notify` job runs the hook at the run's commit, whatever branch it is on. Anyone who can push a branch and dispatch a notifying lane can therefore read that lane's chat secret. That exposure is accepted, and it is the chat secrets alone: the `notify` job never holds anything else.

**Why.** Where a message goes is now the adopter's choice, so the code that posts it is the adopter's code, and adopter code must never run in a job that holds an App key or a Claude credential (`K-AGENT-49`, `K-AGENT-50`). Posting from the job that runs the model was harmless only while the poster was Kanon's own script; a job of its own, holding one chat secret, is what lets any hook run. One contract lets a hook work with every lane and every release: the limits are checked once, text nobody controls (an issue title, a model's narrative) is made safe in one tested place rather than in each lane, and a message that breaks the contract fails before anything posts. Keeping the post in a job of its own also keeps a failed post apart from the work it reports on (`K-SHIP-10`). Running the run's own hook, not the default branch's, was the Owner's choice with the risk stated: a leaked chat secret lets its holder post to one channel, and nothing more ([plan 0011](../docs/plans/0011-notifications.md) §5.3).

**Enforced by.** The contract itself: `scripts/lib/notify-contract.mjs`'s `validate` and `fit`, held by `tests/library/notify-contract.test.ts`, which also holds the published schema equal to the library. The jobs, by [plan 0011](../docs/plans/0011-notifications.md)'s step N6: `tests/unit/helpers/notify-jobs.ts` and `tests/unit/notify-guard.test.ts`, which fail a `notify` job that holds more than its shape allows, a `KANON_CHAT_*` secret anywhere but its own lane's `notify` job and that lane's gate, a `notify` job in a workflow with a `pull_request` or `pull_request_target` trigger, a script under `scripts/` that calls `fetch` on a host other than GitHub's or reads a chat secret, and a producer that writes Slack's syntax; `tests/library/notify-block.test.ts`, which runs Kanon's block, `actions/notify`, against a fixture hook and fails a hook called before the message validates or with nothing to post; `K-AGENT-50`'s guard, `tests/unit/pr-code-token-isolation.test.ts`, which counts the block as running the adopter's code and admits the `notify` job only in that exact shape; `K-AGENT-49`'s guard, `tests/unit/app-key-isolation.test.ts`, which counts the block as running the adopter's code too, and so fails a `notify` job that holds an App's private key; `tests/unit/digest-lanes.test.ts` (steps N7 and N8), which fails a digest job that maps a chat secret or decides whether the digest will post, and a digest that runs its model when no hook or no secret would post it; and `kanon doctor`'s `notify.hook-*` findings (step N10), which check an adopter's hook. Both digests post through their `notify` jobs, the daily project digest since step N7 and the weekly digest since step N8, and the deploy lane announces each environment's deploy through its own since step N9, held by `tests/unit/deploy-lane.test.ts` too; no lane posts through `DIGEST_WEBHOOK`, and `notify-guard.test.ts` fails a job that acts on a `notify` job's result rather than its `outcome`.

**Class.** split. The contract, the `notify` job and its guards are framework. **The project supplies:** its hook, and each kind's secret.

## Billing

How an adopter pays for its agents is not a Kanon rule ([ADR 0004 §5](../docs/decisions/0004-disputed-rules.md)). Kanon works on a Claude subscription and on API billing. The trade-off, for documentation only:

- **Subscription.** For most Claude Code users the binding constraint is rate-limit quota, not money. Pipeline runs share the quota with hands-on work, so heavy agent activity can throttle the developer. Some Claude Code features (routines, for example) require a subscription.
- **API billing.** Spend is per token and unbounded by quota, so `K-OBS-11` and `K-OBS-12` carry more weight. Contention with hands-on work disappears.

The reference adopter started on the subscription and planned to move to API billing only if contention throttled hands-on work. That is one team's commercial choice.

## Examples from the reference adopter

- **Paging stack** (`K-OBS-2`, `K-OBS-3`). The reference adopter pages only through cloud alarms defined in its infrastructure code: native metric alarms, plus metric-filter patterns over structured log lines that carry a named business event. Its log-query service is a dashboard and query surface and pages nothing. Each business-event name must be dot-separated lowercase, because an alarm id is derived from it.
- **Alarm cost** (`K-OBS-4` test 5). About $0.10 per alarm per month per stage, and up to about $0.30 per month per stage for each custom-metric dimension value that actually emits, times two stages.
- **Schedule pricing** (`K-OBS-10`). Its database cluster scales to zero and pauses only after 300 seconds with no connection, so each database-touching tick costs roughly the run time plus five minutes of awake cluster, and a sub-hourly cadence keeps it awake permanently. It prices that at about $0.12 per capacity-unit hour, and remembers that production bills two instances because its disaster-recovery reader also bills. Its uptime probe hits a liveness endpoint that touches no database.
- **Per-run ceiling** (`K-OBS-12`). The ceiling is the turn cap times $0.40, rounded up to the next $5.
