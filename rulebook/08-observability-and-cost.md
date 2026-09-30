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

**Enforced by.** A unit test that fails when any agent step's ceiling disagrees with its turn cap and the per-turn rate.

**Class.** framework. Kanon ships the per-turn rate as part of its standard lane table, so every adopter's ceilings are derived the same way ([ADR 0005](../docs/decisions/0005-roles-and-standard-lane-settings.md) §3).

### `K-OBS-13` Telemetry is written by one credentialed collector

**Rule.** Record a cost row for every agent run through a single collector job that holds the store's credentials. Agent jobs upload their reports as artifacts and hold no store credentials.

**Why.** Granting cloud credentials to a job that executes PR code grants them to the PR's code.

**Enforced by.** The telemetry collector is the only workflow granted the store's role.

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
- the repository, and the issue or PR number;
- the agent **role**, never a GitHub username or account;
- the lane, model, token counts, cost and duration;
- the outcome, and a bail or failure reason chosen from a fixed list of codes.

It never contains code, prompts, issue or PR text, file paths, error messages or any other free text.

**Why.** Telemetry is the one thing that may leave an adopter's project, so it must be safe to leave by construction, not by review. Free text is how content leaks: a bail reason or an error message can quote code, and a file path reveals a project's structure. Without usernames, the rows hold no personal data, which keeps hosted telemetry almost entirely outside data-protection law.

**Enforced by.** Prose only; a guard is planned. The collector will validate each row against the fixed schema and refuse any field outside it, or any reason that isn't a known code.

**Class.** framework

### `K-OBS-17` Project QA data stays in the adopter's own account

**Rule.** Everything that describes the adopter's application stays in the adopter's own cloud account: run reports and findings, route coverage, signal precision, the code-reading ledger and the embeddings used to deduplicate findings. It is created there by infrastructure code Kanon ships, and its lifecycle is independent of any application stage, so tearing down an environment can never delete it. When the adopter has several cloud accounts, the QA store, and a self-hosted telemetry store, live in the **reference environment's account** (`K-PROJ-11`).

**Why.** That data is the adopter's content, not Kanon's. Keeping it in the adopter's account is the cleanest boundary there is, and it means Kanon never holds another team's code findings. The lifecycle clause exists because the reference adopter kept its store inside a staging stage, and a teardown of that stage once emptied the run reports.

**Enforced by.** Prose only; a guard is planned.

**Class.** framework

### `K-OBS-18` Hosted telemetry is opt-in, EU-hosted, and kept for thirteen months

**Rule.**
- **Opt-in.** Telemetry is written to the adopter's own store by default, by the same collector. Sending it to the Kanon-hosted service is an explicit opt-in.
- **Where and how long.** Hosted telemetry is kept in the EU (Frankfurt) for thirteen months, and an adopter's data is deleted on request.
- **Who sees what.** An adopter sees only their own data. Anything shared across adopters, including published cost figures, is aggregated and anonymised.

**Why.** An open-source tool that sends data home by default loses the trust it depends on. Thirteen months allows year-on-year comparisons, and no more. Opting in is also what feeds the cross-adopter improvement work, so the value of opting in has to be visible to the adopter, not assumed.

**Enforced by.** Prose only; the opt-in will be a step in the installer.

**Class.** framework

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
