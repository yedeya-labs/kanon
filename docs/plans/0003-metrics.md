# Plan 0003: metrics: cost, efficiency, accuracy, and the work-item row

- **Status:** accepted, 2026-10-02. The Owner's six decisions are recorded as decided (§0), and the Owner accepted decisions 7 to 20 the same day, including the cost in §8.
- **Tracks:** #32 and #41. **Governed by:** [ADR 0007](../decisions/0007-data-boundary.md) (the data boundary), `K-OBS-14` (claims are measured, size-controlled, with intervals), `K-OBS-16` to `K-OBS-18`, `K-PRIN-14`, and [plan 0002](0002-hosted-telemetry-store.md), whose store this plan extends.
- **Measured on** the reference adopter's main branch and Kanon's, on 2026-10-02. The commands are in [Measurements](#measurements). The reference adopter's repository is private, and the token this plan ran with can't read its pull requests or reviews. Every number that needs them is marked **not run**, with the command the Owner runs.
- **Amended** 2026-10-07 (#91), before M4 and M6 are built: the follow-up-close trigger re-derives only PRs that are closed and inside the 13-month window (§3.1), and an issue-only run joins at most one item, the first to close after it (§3.4). Both make the text say what the accepted ambiguity note and the store's window already require. M4's and M6's checks gain one case each (§7).
- **Amended** 2026-10-07 (#516, #518), as M2's metrics module is built: how an actor is classified once one App plays several roles (§3.2); the `origin` of each author class (§3.3); the stage partition's details and the scope of human corrections (§3.3); where `bandOf` and `areaOf` live (§3.6, §5.2); and the `config` area and Kanon's file lists (§3.7). The Owner accepted the origin mapping the same day.
- **Amended** 2026-10-07 (#520): the stacks whose manifests and lockfiles the `deps` area and the size exclusions name, and the one lockfile list both read (§3.7).

## The plan in one paragraph

**Today.** Plan 0002 stores one row per agent run: what it cost, how long it took, how it ended. That says what Kanon spends. It can't say what the spend bought, because a run doesn't know whether its work merged, how big the work was, or whether it broke something a month later.

**Where it ends.**
- **A second row kind, the work-item row.** One per pull request, written when the PR closes and updated when a later revert, linked fix or follow-up changes its story. Every field is a count, a duration, an enum or a number pattern, derived from GitHub events, never from what an agent says about itself.
- **Three headline indicators, always shown together, by complexity band:** cost per merged work item, the share of spend that ends in merged work, and the escaped-defect rate. Each has a formula, a minimum sample and an interval.
- **A complexity band (S, M, L, XL),** computed by one versioned function from stored counts, so the same work gets the same band everywhere, and a new version recomputes history.
- **A per-adopter report and a public page,** both free to host. The public page says **"measured on Kanon's own projects"** until three adopters contribute.

**How it gets there.** The new run fields join plan 0002's version 2 before its step S1 ships. The work-item collector is a step in the collector plan 0002 moves into Kanon, so it adds no schedule. A dry run on the reference adopter's history calibrates the band and measures the defect detector's precision before any row is written.

## 0. The Owner's decisions (2026-10-02)

Decided, and not reopened here:

1. **Cost is stated at API list price only,** and labelled as such. There is no translation to subscription usage: usage-capacity events and model-specific promotions would skew any translation.
2. **Capture as many fields as possible,** so later analysis can find correlations. All within ADR 0007: a fixed schema, enums and counts, no content.
3. **A complexity band and an amount of work on every work item,** so cost, efficiency and accuracy are compared like for like.
4. **Publish honestly.** A cross-adopter figure needs at least three adopters (plan 0002, decision 7). Until then the wording is "measured on Kanon's own projects".
5. **Against gaming,** the three headline indicators are always shown together, banded by complexity.
6. **All nine metric groups are captured from the start,** including human wait time (§3.3).

## 1. What exists, and what the history says

### 1.1 What is already measured

- **The run row** (plan 0002 §2.1): cost, tokens, turns, durations, configuration, outcome, reason code, and the attribution fields. Its `pr_number` and `issue_number` are the only link to the work.
- **Quality columns** (`scripts/agent-quality-columns.mjs`): a Reviewer run's verdict and an Explorer run's filed issues and severities, read from review events and labels. Absent means unknown, never zero.
- **The size-controlled cost trend** (the reference adopter's weekly report): a log-linear fit of cost on diff size, with a 95% interval, because a raw median once showed a 6% saving that was really smaller work. An issue-side size is admitted as a control only after it passes an adoption test: its slope's interval must be entirely above zero.

**What none of these can say:** whether a run's work merged, how long the whole item took, whether a human had to step in, and whether the merged change was later reverted or fixed.

### 1.2 The reference adopter's history, since 2026-09-04

`RA` is the reference adopter. 2026-09-04 is when its cost rows start (plan 0002 §1.3). The window is commits on main committed from 2026-09-04 00:00 UTC up to 2026-10-02 00:00 UTC, 28 days, with release commits excluded. One script measures every row ([Measurements](#measurements)).

| Fact | Value | What follows |
|---|---|---|
| Squash-merged PRs on main | **336** | **12 a day**, so about 360 work-item rows a month |
| Authored by the Implementer's App | **127** | |
| Authored by a human account | **206** | Most are the Owner's interactive agent sessions. They have no run rows, so no cost. They are a comparison cohort for accuracy only (decision 13). |
| Authored by the dependency bot | **3** | |
| Changed lines per PR (lockfiles, snapshots and changelog excluded) | p25 **227**, p50 **449**, p75 **810**, p90 **1,381** | the band thresholds in §3.6 |
| Band v1 (§3.6) | S **74**, M **97**, L **90**, XL **75** | Four usable bands, none starved. |
| PRs touching an escalation path | **240** of 336 | Risk is common here, so it can't be a band bump (§3.6). |
| Revert commits on main | **0** in the window, **1** ever | Reverts alone would report zero escapes. |
| `fix` commits | **163** | |
| … sharing a file with any commit in the 30 days before | **162** | File overlap alone links almost every fix to something: useless as a detector. |
| … whose changed code lines were last touched by a commit at most 30 days older (blame on the parent) | **132** | The SZZ method (§3.5): 81% hits in a young, fast-moving repository. Too noisy for a headline. |

**Not run** (needs the reference adopter's pull requests): first-review approval rate, review rounds, closed-unmerged PRs, `needs:human` wait times, and the share merged by the Merger against a human. The commands are in [Measurements](#measurements).

## 2. The three headline indicators

### 2.1 Rules that apply to all three

- **Shown together, always.** No view, report or page shows one headline indicator without the other two, for the same cells. A cheaper cell that escapes more defects then looks like what it is.
- **By band.** Each indicator is shown per complexity band (§3.6), and pooled only with the band mix printed beside it.
- **Merged work only counts as delivered.** A work item is a pull request (§3.1). Its fate is `merged` or `closed_unmerged`.
- **Windows are by close date,** 28 days by default, so a window is four whole weeks.
- **A cell below its minimum sample shows "not enough data" and its count,** never a number. The minimum is per indicator (below).
- **Every interval is 95%,** printed beside the point estimate. Two cells are called different only when an interval for their difference excludes zero (`K-OBS-14`).
- **Only `tag = run` rows count** (plan 0002 §2.4).
- **Cost is the API list price** (§0, decision 1). It is the `total_cost_usd` the agent CLI reports for each run, which it computes at list price whatever the adopter's billing. Every page labels it "API list price".

### 2.2 Cost: list-price cost per merged work item

| | |
|---|---|
| **Formula** | For each merged work item *i*: cost*ᵢ* = Σ `total_cost_usd` over every run row joined to *i* (§3.4). That is every role and lane: implement, triage, implement-revise, review, verify-acs, rebase, merge-reconcile, and the Lead's lead, lead-revise and lead-split runs that name the item. It includes failed, exhausted and retried runs, and every revise round. Shown as the **median** and the **90th percentile** of cost*ᵢ*, per band and window. |
| **Unit** | US dollars at API list price, two decimals. |
| **Source** | run rows (plan 0002 schema), joined to work-item rows. |
| **What it represents** | What delivering one merged PR of a given size cost in model usage, priced at list, including the attempts it took. |
| **What it does not claim** | What the adopter paid: on a subscription that is a different number, and decision 1 forbids translating. Nor the spend on work that never merged (that is efficiency, §2.3), the Explorer's, Overseer's and digests' spend (shown as **overhead**, beside, never inside), or the cost of human time. Items with no run row at all (human-authored, §1.2) have no cost and are excluded, never counted as zero. |
| **Minimum sample** | median: **10** merged items with at least one run row in the cell; p90: **30**. |
| **Interval** | Distribution-free, from order statistics: the binomial interval on the ranks around the median or p90. It needs no assumption about the shape of cost, which is skewed. It exists at 95% for a median from n = 6 and for a p90 from n = 29, so the minimums sit above both. At p90's minimum of 30, the interval's upper end is the sample maximum, so the page shows it as wide as it is. |

**Secondary, beside it:** cost per acceptance criterion (cost*ᵢ* / `ac_count`, for items with criteria), and cache savings (§4, group 8).

### 2.3 Efficiency: the share of spend that ends in merged work

| | |
|---|---|
| **Formula** | **Yield** = Σ cost of delivery-lane runs joined to a merged item / Σ cost of all delivery-lane runs. Delivery lanes are every lane except explore, code-audit, overseer and the digests. A run that joins to no work item, or to one closed unmerged, counts in the denominator only. A run counts once its item is settled: its PR closed; or, for a run with no PR, its issue closed or 30 days passed with no event on it. An item idle for 30 days counts as not merged until it closes. |
| **Unit** | percent. |
| **Source** | run rows and work-item rows. |
| **What it represents** | How much of the delivery spend bought something that shipped. Failed runs, abandoned PRs and work that bailed before opening a PR all lower it. |
| **What it does not claim** | That unmerged spend was worthless: a bail that led to a split, or a PR closed because the plan changed, is still counted as not merged. Nor that the merged work was right (accuracy, §2.4). |
| **By band** | Where the item has a PR. Runs that never reached a PR form a **"no PR"** column, shown beside the bands, because they have no diff to band. |
| **Minimum sample** | **20** settled items in the cell. |
| **Interval** | A ratio of sums, so a **bootstrap over work items**: each item's runs are resampled together, 2,000 resamples, a fixed seed so the page is reproducible. Across adopters (§6) the resampling unit is the adopter. |

**Secondary, beside it, by band:** review rounds to approval (median), lead time from dispatch to merge (median and p90, split by stage, §3.3), and human wait time (median).

**Why yield, and not the proposed rounds and lead time, as the indicator.** Rounds and lead time describe how the work went, but neither says what the spend bought, and lead time is mostly waiting on people. Yield is one number that falls when spend is wasted, which is what "efficiency" has to mean next to a cost. The other two stay, as its breakdown.

### 2.4 Accuracy: escaped defects, with first-review approval and human corrections

| | |
|---|---|
| **Formula** | **Escaped-defect rate at 30 days** = merged items with an *explicit* revert or linked fix (§3.5) merged within 30 days of the item's merge / merged items merged at least 30 days ago. **At 90 days** the same with 90. Beside it: **first-review approval** = merged items whose first Reviewer verdict was `approved` / merged items with a Reviewer verdict; and **human-correction rate** = items with any human correction (§3.3, group 3) / items authored by an agent. |
| **Unit** | percent. |
| **Source** | work-item rows. |
| **What it represents** | How often merged agent work was found wrong, by a revert or a linked fix, within one and three months; and how often a human had to correct it before merge. |
| **What it does not claim** | That an item with no link had no defect. Detection needs a link someone made (§3.5), so the rate is a **lower bound**. Nor does approval measure correctness: a lenient reviewer raises it. That is why approval is never shown without the escape rate and the human-correction rate. |
| **Maturity** | An item counts only once its whole window has passed. A 90-day rate therefore lags by 90 days, and a page says which merge dates it covers. |
| **Minimum sample** | **50** matured items in the cell for an escape rate, **20** for approval and correction rates. Below 50, the escape rate is shown pooled across bands, with the band mix. |
| **Interval** | **Wilson score interval** for each proportion. It behaves at zero: 0 escapes of 50 gives 0% to 7.1%, where the plain normal interval would claim 0% to 0%. |

**Why these refinements.**
- **Explicit links only, for the headline.** The reference adopter's history shows the alternatives fail (§1.2): reverts alone find nothing, file overlap links 162 of 163 fixes, and blame links 132. A headline that moves with noise invites false conclusions; a lower bound that moves only with evidence doesn't.
- **First-review approval needs a counterweight** that the Reviewer can't produce: human corrections are actions by a person, after the agents were done.
- **Human-authored items are a comparison cohort, not a baseline.** Their escape rate is shown beside the agents' where both cells meet the minimum. Their authors differ in more ways than being human, so the comparison is descriptive and the page says so.

## 3. The work-item row

### 3.1 What it is, when it is written

- **One row per pull request,** in the same table as the run rows, under the partition `<key>#work` (§5).
- **Written** by the collector's work-item step (§4) on its first sweep after the PR closes, merged or not.
- **Rewritten** when something later changes the item's story. Two events trigger it:
  - **a PR merges** that reverts or fixes the item (§3.5);
  - **an issue closes,** for any reason, that is labelled `follow-up` and `agent:reviewer`: the step re-derives each PR the issue cross-references that is **closed** and whose `closed_at` is inside the 13-month window, the same bound as the merge trigger (§3.5), so `followups_completed`, `followups_not_planned` and `followups_open` follow the follow-ups' fates. A follow-up closed by hand or as not planned merges no PR, so the merge trigger alone would leave these fields frozen at their first value. **Amended 2026-10-07 (#91):** the bound keeps the step from sending a row the store rejects (§5.2's `closed_at` window), which would turn the collector red for nothing. A PR still open has no row yet, or, if it was closed and reopened, a row that is re-derived whole when it closes again. Either way the row it carries after that close is derived then, with the follow-up's fate already current. A PR closed more than 13 months ago has no row left to rewrite: it expired 13 months after `closed_at`.

  The step re-derives the **whole** row from GitHub and sends it again. The key is the same, so the store overwrites it. Nothing is patched field by field, so a row is always one consistent derivation.
- **A PR is one item, however often it is closed and reopened.** The key is the PR number alone (§5.2), so a PR closed unmerged, reopened and merged has one row, the latest derivation. Keying on `closed_at` would leave the first close's row behind; deleting it on reopen would need a delete path that the ingest function, a write-only `PutItem` path by design (plan 0002 §4), doesn't have; and a reader rule "keep the newest row per PR" would have to be repeated in every reader. A key that can't hold two rows is the only one of the three that is right by construction.
- **A dispatched issue that never got a PR** has no work-item row. Its runs still count, in efficiency's "no PR" column (§2.3).
- **Every field is optional unless marked required, and absent means unknown, never zero** (the same discipline as `agent-quality-columns.mjs`). A GitHub read that fails leaves its fields absent.

### 3.2 How the collector tells people from agents

Several fields count what a **human** did. The collector classifies each GitHub actor **adopter-side**, then discards the login:
- a login in the App register (`K-LAYOUT-6`) is that **role**;
- any other `[bot]` account is `other_bot`;
- everything else is `human`.

The row stores the class, or a count per class. **No login, name or account id ever leaves the adopter.**

**Amended 2026-10-07 (#516, #518): one App, several roles.** Since plan 0005's L4, one App plays several roles: the Author App plays the Implementer, the Lead, the Explorer and the Overseer, and the Judge App plays the Reviewer and the Merger. A login then names the App, not the role. The collector reads the role the way Kanon's own checks do (`scripts/lib/role-marker.mjs`):
1. the role marker on what the account wrote, when it names a role the App plays;
2. otherwise, the role the action implies, when the App plays it: a merge is the Merger's, a review the Reviewer's, a pull request the Implementer's;
3. otherwise the class is **unknown**, and the field is left out rather than guessed.

A register row whose role the row can't carry (the Releaser, Intake) is `other_bot`.

**Amended 2026-10-07 (#521): `human` is a person.** GitHub's own committer, `web-flow`, is `other_bot`, not `human`, though it is a `User`-type account with no `[bot]` suffix: GitHub records it as the committer of every commit it creates through the API or the web UI, so read as `human` it would make an App's API commit, or Dependabot's, a human commit. A person's web-UI commit still counts, by its author.

### 3.3 The fields

**Eighty-four fields, flat.** Types: **count** (non-negative integer below 2³¹), **duration** (whole seconds), **time** (ISO-8601 UTC), **bool**, **enum** (a closed list), **pattern** (a strict regular expression). Every field was checked against ADR 0007 rule 1: none holds code, prompts, issue or PR text, file paths, error messages, free text or a username. The ones rule 1 doesn't already list are added by the `K-OBS-16` amendment (§5).

**Row and join**

| Field | Type | Derived from |
|---|---|---|
| `schema_version` (required) | `1` | the collector |
| `row_kind` (required) | enum `work_item` | the collector |
| `tag` (required) | enum `run`, `smoke`, `test` | as plan 0002 §2.4 |
| `recorded_at` (required) | time | when this derivation ran |
| `pr_number` (required) | count | the PR |
| `closing_issues` | pattern `^\d{1,9}(,\d{1,9}){0,19}$` | the PR's closing-issue references |
| `opened_at`, `closed_at` (required), `dispatched_at` | time | PR events; the dispatch label's `labeled` event on the first closing issue |
| `fate` (required) | enum `merged`, `closed_unmerged` | the PR's state |
| `kanon_version` | `^\d+\.\d+\.\d+$` or `dev` | the Kanon tag pinned by the adopter's lane callers at the merge commit; for a `closed_unmerged` item, at the base branch's head at `closed_at` |

**Group 1. Amount and complexity of work**

| Field | Type | Derived from |
|---|---|---|
| `changed_lines`, `changed_files`, `changed_dirs` | count | the PR's file list, excluding lockfiles, snapshots and the changelog (§3.6) |
| `excluded_lines` | count | the lines those exclusions removed, so nothing is hidden |
| `files_code`, `files_tests`, `files_workflows`, `files_migrations`, `files_docs`, `files_specs`, `files_config`, `files_deps` | count | each changed file's **area** (§3.7) |
| `esc_pipeline`, `esc_playbooks`, `esc_infra`, `esc_migrations`, `esc_schema`, `esc_payments`, `esc_auth`, `esc_other` | bool | the escalation category each changed path falls under (§3.7) |
| `tests_added`, `tests_changed` | count | test-area files with status `added`, and `modified` or `renamed` |
| `ac_count` | count | checklist items in the first closing issue's acceptance-criteria section |
| `spec_clauses_cited` | count | distinct `[AREA-N]` spec ids in that issue (chapter 02) |
| `issue_body_chars`, `issue_paths_named` | count | as the run row has them (plan 0002), for the first closing issue |
| `blocked_by_count` | count | the issue's GitHub `blocked-by` relationships |
| `origin` | enum `brief`, `explorer`, `reviewer_followup`, `overseer`, `human`, `dependency_bot`, `other_bot` | the first closing issue's labels, checked in this order, first match wins: `follow-up` with `agent:reviewer` is `reviewer_followup`; `agent:explorer`; `agent:overseer`; then `project:<n>` is `brief`; else the issue author's class. A PR with no issue takes the PR author's class. The specific origins come first because the Lead's reconciler also puts `project:<n>` on follow-ups and Explorer issues inside a project, so `project:<n>` alone doesn't mean a brief filed the item. |
| `author_kind` | enum: a role, `human`, `other_bot` | the PR author's class (§3.2) |
| `commits`, `force_pushes` | count | the PR's commits and `head_ref_force_pushed` events |
| `band` | enum `S`, `M`, `L`, `XL` | §3.6 |
| `band_version` | count | §3.6 |

The collector reads the acceptance criteria, the spec ids and the body from the issue, but stores **only the counts**.

**Amended 2026-10-07 (#516, #518): the `origin` of an author class.** `origin`'s list isn't the class list (§3.2), so when the rule falls through to an author's class, the class maps to an origin as below. The Owner accepted this mapping on 2026-10-07.

| Author's class | `origin` |
|---|---|
| `explorer` | `explorer` |
| `overseer` | `overseer` |
| `lead` | `brief` |
| `reviewer` | `reviewer_followup` |
| `human` | `human` |
| `other_bot` that is a dependency-update App (Kanon's list: `dependabot`, `renovate`) | `dependency_bot` |
| any other `other_bot` | `other_bot` |
| `implementer`, `merger`, or an App of several roles with no role marker | absent: no origin Kanon can name |

The Implementer and the Merger file no issue and open no PR of their own, so an item they appear to originate has no origin. A PR whose closing issues weren't read has an unknown origin, never the PR author's.

**Group 2. Flow and time**

| Field | Type | Derived from |
|---|---|---|
| `lead_time_s` | duration | `dispatched_at` (or `opened_at` when not dispatched) to `closed_at` |
| `t_queue_s`, `t_agent_s`, `t_review_s`, `t_ci_s`, `t_rework_s`, `t_human_s`, `t_merge_queue_s`, `t_other_s` | duration | the stage partition below |
| `human_waits` | count | separate intervals in the `human` stage |
| `wip_at_dispatch` | count | the adopter's work items dispatched and not yet closed at `dispatched_at` |

**The stage partition.** Every second of the lead time goes to exactly one stage, so the stages sum to `lead_time_s`. Where intervals overlap, the first stage in this order wins:

| Order | Stage | An interval is open from … to … |
|---|---|---|
| 1 | `human` (human wait) | `needs:human` labelled → unlabelled, closed or merged; or, for an item the Merger may not merge (escalated, or outside the green zone), approved with green checks → merged by a human, a human review, or a human commit |
| 2 | `merge_queue` | `added_to_merge_queue` → merged or `removed_from_merge_queue` |
| 3 | `agent` | a non-Reviewer lane run joined to the item: the workflow run's start → end, from the Actions API |
| 4 | `review` | `review:please` labelled, or a Reviewer run's start → the Reviewer's verdict |
| 5 | `ci` | the first check run's start on a head commit → its last required check's completion |
| 6 | `rework` | a `changes_requested` verdict → the next push |
| 7 | `queue` | `dispatched_at` → the first lane run's start |
| 8 | `other` | everything left |

**Human wait time** is `t_human_s`. Its definition is the one place a policy is encoded in a measure: "waiting for a human" means a human is the only party who can move the item. The order puts it first so that a human wait overlapping, say, a CI run is still counted as human wait.

**Amended 2026-10-07 (#516, #518): the partition's details.**
- **The next push** (`rework`) is the next commit's committer date or a `head_ref_force_pushed` event, whichever comes first. GitHub records no time for an ordinary push.
- **`rework` opens only on the Reviewer's** `changes_requested` verdict, not on a human's.
- **A Reviewer run with no verdict inside it** ends its `review` interval at the run's end.
- **The Merger may not merge** (the second half of stage 1) is an input the collector sets from the Merger's escalation, `merger_blocked`. The interval opens at the later of the standing Reviewer approval and the last required check's completion on the approved head, when those checks are green.
- **`dispatched_at` ignores a dispatch label applied after `closed_at`.**
- **When the first closing issue's timeline wasn't read,** `dispatched_at` is unknown, so the lead time and every stage field are left out, never measured from `opened_at`.
- Every time is floored to its second before anything is subtracted, so the stages sum to `lead_time_s` exactly. The module checks that sum on every row it builds.

**Group 3. Accuracy**

| Field | Type | Derived from |
|---|---|---|
| `first_verdict` | enum `approved`, `changes_requested`, `none` | the first review by the Reviewer's App |
| `review_rounds` | count | Reviewer reviews with a verdict |
| `ci_failures_before_review` | count | failed required check runs on head commits before the first Reviewer verdict |
| `red_first` | enum `pass`, `fail`, `absent` | the conclusion of the red-first check (`K-MERGE-13`) on the final head; `absent` on a human-authored PR, which the rule exempts |
| `verify_acs` | enum `pass`, `fail`, `absent` | the verify-acs lane's check conclusion on the final head |
| `human_commits` | count | PR commits whose author or committer is `human`, on an agent-authored PR; **absent** on a human-authored PR, where they are the author's own (amended 2026-10-07, #516, #518) |
| `human_cr_after_approval` | count | `changes_requested` reviews by a `human` after the Reviewer approved |
| `human_reviews` | count | reviews by a `human` |
| `revert_pr` | count (a PR number) | §3.5 |
| `revert_days` | count | days from this item's merge to the revert's merge |
| `fix_prs` | pattern `^\d{1,9}(,\d{1,9}){0,19}$` | §3.5 |
| `first_fix_days` | count | days from this item's merge to the first linked fix's merge |

Escaped at 30 days means `revert_days` or `first_fix_days` is at most 30, computed at read time from the stored days. Closed-unmerged is `fate`, and needs no field.

**Group 4. Reviewer quality**

| Field | Type | Derived from |
|---|---|---|
| `review_comments` | count | inline comments by the Reviewer's App |
| `followups_filed` | count | issues labelled `follow-up` and `agent:reviewer` that cross-reference this PR |
| `followups_sev_critical`, `…_high`, `…_medium`, `…_low` | count | their `sev:*` labels |
| `followups_completed`, `followups_not_planned`, `followups_open` | count | their state and state reason, at `recorded_at` |
| `cr_acted` | count | `changes_requested` verdicts followed by a new head commit before the next Reviewer verdict |
| `cr_withdrawn` | count | `changes_requested` verdicts followed by an approval **at the same head**: the Implementer pushed back and the Reviewer accepted it |

**Reviewer precision** is `cr_acted / (cr_acted + cr_withdrawn)`. A commit after a change request may answer something else, so `cr_acted` over-counts a little, and the page says so. Findings by severity are measured on what was **filed**, with labels a human can audit. The count a review body claims is the Reviewer's own report, and `K-OBS-14` keeps it out.

**Group 5. Autonomy**

| Field | Type | Derived from |
|---|---|---|
| `escalations` | count | `needs:human` labelled events |
| `escalation_reasons` | pattern: codes from the Merger's closed list, comma-separated, each validated | the per-rule marker in the Merger's escalation comment (`K-MERGE-10`); it is Kanon's code, not the adopter's text |
| `human_interventions` | count | `human_commits` + `human_reviews` + labels applied or removed by a `human` from the `agent:`, `review:`, `needs:` and `qa:` families |
| `merged_by` | enum: a role, `human`, `other_bot` | the merge actor's class |

**Group 6. Reliability.** Mostly from the joined run rows: outcome distribution, `failed_stage`, `kanon_error`, `api_error_status`, retries (`run_attempt` > 1) and timeouts (§5's new run fields). The item adds one field:

| Field | Type | Derived from |
|---|---|---|
| `recoveries` | count | recovery labels applied (`agent:revise`, `agent:lead-revise`) and lane re-dispatches by Kanon's retry script |

**Group 7. Model behaviour,** and **group 8. Cost composition:** from the joined run rows only (§4). The item carries no copy of a run's numbers, so there is one source for each.

**Group 9. Kanon's own health**

| Field | Type | Derived from |
|---|---|---|
| `guard_failures` | pattern: `<guard>:<count>` pairs, comma-separated, each guard from Kanon's closed guard list | failed conclusions of Kanon's guard checks on the PR's head commits, by check name |

The rest of group 9 is computed in the store or in Kanon (§4).

### 3.4 Joining runs to work items

Joins happen in the reader, never in a row, and always **within one adopter key**. A run row joins to work item *i* when:
1. its `pr_number` is *i*'s `pr_number`; or
2. it has no `pr_number`, its `issue_number` is in *i*'s `closing_issues`, it was recorded before *i*'s `closed_at`, and *i* is the **first** such item to close after it: of the items whose `closing_issues` holds its `issue_number` and whose `closed_at` is after it, the one with the earliest `closed_at`, and on a tie the lowest `pr_number`.

So a run joins **at most one** item, and is counted once in cost*ᵢ* (§2.2), once in each of yield's sums (§2.3), once in waste (§4, group 8) and once in the bootstrap's resampling. Every reader of a run's item goes through this join, so none applies rule 2 on its own. **Amended 2026-10-07 (#91):** without the last condition, an issue whose first PR closed unmerged and whose second merged sent a run recorded before the first close to both.

**Ambiguity, stated.**
- An issue closed by two PRs in turn (the first closed unmerged, the second merged) sends its issue-only runs to the PR that was the next to close when they ran: a run recorded before the first PR closed goes to the first, and one recorded after it to the **later** PR. Rule 2's last condition is this note, stated as the rule.
- A run on an issue that later got no PR joins nothing, and counts in efficiency's "no PR" column.
- A Lead run that names a tracking issue, not the item's issue, joins nothing. Lead planning cost is overhead, like the Explorer's.
- A PR that closes more than 20 issues stores the first 20 and joins only those. The pattern bounds it. Whether any PR in the reference adopter's history comes near is **not run**; the command is in [Measurements](#measurements).

### 3.5 Detecting reverts and linked fixes

**A revert of item *i*** is a later merged PR *r* where either:
- *r*'s head commits include a commit whose message ends with GitHub's or git's generated `This reverts commit <sha>.`, and `<sha>` is *i*'s merge commit; or
- *r* was created with GitHub's **Revert** button, whose generated body is `Reverts <owner>/<repo>#<i>`.

Both are text generated by tools, matched by an anchored pattern. The collector reads them and stores only *r*'s number and the days.

**A linked fix of item *i*** is a later merged PR *f* where all three hold:
1. *f* closes an issue labelled `bug`;
2. that issue, or *f*, **cross-references** *i*: GitHub's own `cross-referenced` timeline event on *i*, whose source is the issue or *f*;
3. *f* changes at least one file in the **code** area (§3.7) that *i* also changed.

**How the collector finds them.** When a PR merges, the work-item step checks it once against both definitions. (The other rewrite trigger, a follow-up closing, is in §3.1.) If it reverts or fixes an earlier item still inside the 13-month window, the step re-derives **that earlier item's** row (§3.1). Nothing re-scans old items on a timer: both triggers are events the sweep already reads.

**Making the links exist.** Condition 2 needs someone to name the PR that introduced the bug. Today nothing asks for it, so the rate would be a lower bound with a large gap. Decision 9 adds an optional **"Introduced by"** field in the bug issue form, holding a PR number, and a line in the triage playbook: when the Implementer finds the cause, it names the PR. A number in a form field becomes a cross-reference GitHub records, which is the fact the collector reads.

**False positives, honestly.**
- A bug issue may mention a PR that didn't cause it ("similar to #i"). Condition 3 cuts some of these; M2's hand check measures how many are left. Those left are counted as escapes.
- *f*'s shared code file may be a coincidence, in a hot file. Condition 2 is what carries the evidence, so this matters only when both hold by chance.
- A revert that is later re-applied unchanged (a revert of a revert) still counts as an escape for *i*. It was reverted.

**False negatives, honestly.** These are the larger risk, and they make the rate a lower bound:
- A fix with no bug issue, or whose issue names no PR. The Implementer's triage naming the cause is an agent's statement about earlier work, so under-reporting is the risk, not inflation: it would have no reason to blame its own role's work falsely.
- A defect found and fixed inside a later feature PR.
- **A defect outside the `code` area.** Condition 3 needs a shared file in the code area (§3.7), so a defect in a workflow, a migration, configuration or dependencies, fixed by a PR that touches only that area, is never counted as an escape, whatever its bug issue cross-references. These are the escalation-path areas, so the gap sits where work is riskiest. It is kept because decision 8 accepted "a shared code file"; widening condition 3 to every area but `docs` is a later decision for the Owner, made on M2's numbers.
- A defect never found within 90 days.
- A fix after the 13-month retention, which can't be counted at all.

**What isn't used, and why.** The reference adopter's history (§1.2):
- **File overlap alone** linked 162 of 163 fix commits to an earlier commit.
- **SZZ** (blame the lines a fix changed, and call their last author the cause) linked 132 of 163. In a repository whose code is a few months old, almost every line was last touched within 30 days, so blame finds a recent commit whether or not it caused anything.

SZZ stays possible later as a **diagnostic,** never a headline: the dry run (§7, M2) prints its count beside the explicit-link count, so the gap between them is visible.

### 3.6 The complexity band

**Band version 1.** One function, `bandOf(row, version)`, in the metrics module (`scripts/metrics/band.mjs`), used by the collector, the store's aggregates and every report. **Amended 2026-10-07 (#516, #518):** it was to live in the schema module, but the schema imports nothing so that it can run in the ingest function, and `areaOf` needs the code-areas and escalation readers. `band.mjs` imports nothing, so the ingest side may copy it, as the schema copies `ESCALATION_CATEGORIES`. Its inputs are stored counts, so a new version recomputes every stored row without collecting anything again.

1. **Lines** are `changed_lines`: additions plus deletions, excluding lockfiles, snapshot files and the changelog. Those are generated. Counting them would put a dependency bump in XL.
2. **Base band from lines:** S up to 200; M up to 500; L up to 1,200; XL above.
3. **Spread bump:** one band up when `changed_files` is 20 or more, or `changed_dirs` is 8 or more. Work spread across a codebase is harder than the same lines in one place.
4. **Capped at XL.**
5. **Risk is not a bump.** It is a separate split: any `esc_*` field true. In the reference adopter 240 of 336 PRs touch an escalation path, because pipeline work is most of its work. With a risk bump, XL holds 146 of the 336 PRs (43%) and S only 24, which leaves the band useless.

**Calibration.** The first two thresholds sit near the reference adopter's lower quartile and median of changed lines (227 and 449; §1.2). The third, 1,200, sits between its upper quartile (810) and p90 (1,381); with the spread bump, the four bands still come out even. On its 336 PRs, version 1 gives S **74**, M **97**, L **90**, XL **75**.

**Why the merged diff, and not the issue.** The band must exist for every item, and the issue-side measures (`ac_count`, `issue_body_chars`) are absent for ad hoc PRs. The diff is also what the size-controlled trend already keys on. Its weakness is that the agent produces it, so a thrashing agent writes a bigger diff and lands in a bigger band. Three things limit that:
- the band uses the **net** merged diff, not the churn, so rework doesn't inflate it;
- the headline indicators are shown together (§0, decision 5), so a padded diff that raises the band also shows in yield and review rounds;
- the **validity check** below.

**The validity check, every window.** A band is only a control if cost actually rises with it, the same test the reference adopter applies before adopting a size regressor. The report computes the median cost per band and Kendall's τ between band and cost, with its interval. When the interval doesn't sit entirely above zero, the banded view is replaced by the pooled view and a warning, never shown as if it meant something. The issue-side band (`ac_count` and `issue_body_chars`, the same scheme) is printed beside it as a cross-check, once enough brief-driven items have criteria.

**Versioning.** `band_version` is stored on each row as written. A new version is a Kanon release with its own thresholds and a changelog entry. Reports always recompute with **one** version, the newest, and say which. A version is never mixed within a view.

### 3.7 Area and escalation categories

**Area,** one per changed file, first match wins. The patterns are Kanon's, fixed, and versioned with the band:

| Area | Matches |
|---|---|
| `deps` | lockfiles and dependency manifests (`package.json`, `requirements*.txt`, `go.mod`, `Cargo.toml`, …) |
| `workflows` | `.github/workflows/**`, `.github/actions/**` |
| `migrations` | the paths the adopter's escalation list puts in the `migrations` category, plus `**/migrations/**` |
| `specs` | the spec corpus (`docs/qa/specs/**`, `K-LAYOUT-2`) |
| `tests` | the adopter's tests: the `tests` trees its stack document declares under `## Code areas` (`K-LAYOUT-17`), else each file its language's convention calls a test (ADR 0012), `*.test.*` and `*.spec.*` in JavaScript and TypeScript (`isTestPath`, `scripts/lib/code-areas.mjs`) |
| `docs` | `*.md`, `docs/**` |
| `config` | dotfiles and root-level configuration files |
| `code` | everything else |

**Amended 2026-10-07 (#516, #518): the `config` area and Kanon's lists.**
- **`config`** is a path with any segment starting with `.` (so `.github/CODEOWNERS`, `.claude/` and `.husky/` are config), or a root-level file named `*.config.*` or with a `json`, `yaml`, `toml`, `ini`, `cfg` or `conf` extension.
- **A declared `code` tree beats `config`:** a dot-directory the adopter declares as code under `## Code areas` is `code`, as Kanon's own `.github/scripts/` is. Outside a declared code tree, everything else is still `code`.
- **The `deps` file names and the size exclusions (§3.6) are Kanon's lists,** covering the common stacks' manifests and lockfiles, not one stack's. On a JavaScript repository the exclusions are the files [Measurements](#measurements)' script excludes.
- **Amended 2026-10-07 (#520): the stacks the lists name.** JavaScript, Python, Go, Rust, Ruby, PHP, the JVM (Maven, Gradle, sbt), .NET (NuGet, Paket), Elixir and Erlang, Swift (SwiftPM, CocoaPods, Carthage) and Dart. The size exclusions' lockfiles are the `deps` area's, one list (`LOCKFILES`, `scripts/metrics/band.mjs`, which still imports nothing: `areas.mjs` imports it from there), so a file is never a lockfile to one and code to the other.

**Escalation categories.** Each entry in the adopter's `docs/qa/escalation-paths.md` (`K-MERGE-4`, `K-LAYOUT-8`) gains a **category** from Kanon's closed list: `pipeline`, `playbooks`, `infra`, `migrations`, `schema`, `payments`, `auth`, `other`. The framework's own entries (workflows, the pipeline's scripts, the playbooks) carry `pipeline` or `playbooks`. The collector sets `esc_<category>` to true when any changed path matches an entry of that category. The adopter's patterns and paths never leave; only the eight booleans do.

## 4. Where each metric is computed

Three places, and nothing crosses the adopter boundary except validated rows:
- **The lane** writes the run row, adopter-side (plan 0002).
- **The work-item step** of the collector derives the work-item row, adopter-side, with the adopter's own token. It is the only code that reads issue bodies, logins and paths, and it emits only the row.
- **The store's readers** join and aggregate: the adopter's report with its reader role, and the Owner's aggregate script across adopters. **Kanon** computes the part of group 9 that is about Kanon itself, from Kanon's own repository.

| Group | Run row (plan 0002) | Work-item row | Computed in the reader |
|---|---|---|---|
| 1. Amount and complexity | `changed_lines`, `changed_files` (the PR at run time) | all of §3.3 group 1, and the band | the band under the newest version |
| 2. Flow and time | `duration_ms` | lead time, the stage partition, WIP, human waits | medians and p90 by band |
| 3. Accuracy | the Reviewer's `verdict` | first verdict, rounds, CI failures, red-first, verify-acs, human corrections, reverts and fixes | escape rates at 30 and 90 days, approval, correction rate |
| 4. Reviewer quality | `severities_*` of the review run | follow-ups and their fates, `cr_acted`, `cr_withdrawn` | precision, follow-up completion rate |
| 5. Autonomy | | escalations and their reason codes, interventions, `merged_by` | interventions per merged PR; the Merger's share |
| 6. Reliability | `outcome`, `reason`, `failed_stage`, `kanon_error`, `api_error_status`, `run_attempt`; new `job_status`, `timed_out` (§5) | `recoveries` | outcome distribution per lane, retry and timeout rates |
| 7. Model behaviour | turns, tokens, thinking, subagents, permission denials, model, effort, `max_turns`, `config_fingerprint`; new `tool_calls`, `tool_errors`, `compactions` (§5) | | cache hit ratio = cache reads / (input + cache reads + cache writes); thinking share = thinking / output tokens; A/B by fingerprint |
| 8. Cost composition | `total_cost_usd`, `role`, `lane` | | cost by role and lane; waste = cost of runs not joined to a merged item; cost per AC; cache savings = cache-read tokens × (input price − cache-read price), from Kanon's dated list-price table |
| 9. Kanon's own health | `kanon_version` | `guard_failures` | see below |

**Group 9, field by field.**

| Measure | Where | How |
|---|---|---|
| Guard firing counts | the store | `guard_failures`, summed per guard |
| Rule firing counts | the store | the same, through Kanon's map from each guard to the rule it enforces |
| Disputed rules | Kanon's repository | a "Dispute a rule" issue form with a rule-id field; the count of open and closed disputes per rule id (decision 15) |
| Upgrade lag | the store | each adopter's newest `kanon_version` against Kanon's release list on that date: releases behind and days behind |
| Time from install to first review | the store, and the Owner's private register | computed **once**, by the Owner's aggregate script, on the first run after an adopter key's first `tag: run` review row with a verdict arrives: from that key's first `tag: run` row of any lane to that review row. The first lane run comes after installation started, so this is a lower bound on setup time. It doesn't start from the installer's smoke row: smoke rows expire after 30 days and are excluded from every read (plan 0002 §2.4). **The per-key value is kept in the Owner's private register, beside the key** (plan 0002 §5), never in Kanon's public tree, for **13 months after that review row** and no longer (plan 0002 decision 18, 2026-10-06), and erasing the key removes it with the key's rows (plan 0002 §10). Past its bound the key drops out of the published distribution. The public committed output holds only the **distribution across adopters**, under the three-adopter rule (§6.2), which ADR 0007 rule 5 requires of anything shared. |
| Time to fix #41's bugs | Kanon's repository | issues filed by #41's job: created to closed, and to the first release that contains the fix |

**Why the work item is its own row, and not more run fields.** A run row is written when a run ends, but most of a work item's facts don't exist yet: the merge, the human wait, and above all the revert three months later. A run row is also one of many per item, so an item field on it would be repeated, and could disagree. One row per item, rewritten when its story changes, keeps each fact in one place.

## 5. Changes to plan 0002

**When:** in a **follow-up PR, after the Owner accepts this plan.** Plan 0002 is accepted and approved as it stands; it is amended in its own PR, so that each plan's change is reviewed on its own (decision 17). The follow-up has to land **before S1 is built**, because §5.1 adds to version 2, which S1 ships. If S1 ships first, §5.1 becomes version 3 instead, with the same fields.

### 5.1 New run-row fields, added to version 2

S1 hasn't shipped, so no version 2 row exists yet, and these join version 2 itself. **Fifty-three fields become fifty-nine.**

| Field | Type | Derived from |
|---|---|---|
| `row_kind` (required) | enum `run` | the normaliser |
| `tool_calls` | count | `tool_use` blocks in the execution file |
| `tool_errors` | count | `tool_result` blocks with `is_error: true` |
| `compactions` | count | the CLI's compaction-boundary system events |
| `job_status` | enum `success`, `failure`, `cancelled` | `job.status`, which the lane passes to `agent-finish` |
| `timed_out` | bool | `job_status` is `cancelled` and the job ran at least its own `timeout-minutes` less a 3-minute margin, from a start stamp that is the job's first step; the lane passes both. The margin covers the setup before that first step, which GitHub's timeout counts and the stamp doesn't (plan 0002 §2.1) |

Whether the execution file carries every tool and compaction event is checked in S1 against a real run. If it doesn't, those fields stay absent, never zero.

### 5.2 Every change, by section

| Plan 0002 section | Change |
|---|---|
| §2.1 | Add §5.1's six fields. Add the work-item row as a second field list (this plan §3.3). |
| §2.2 | The store keeps a field list per **(`row_kind`, `schema_version`)**. Work-item rows start at version 1. |
| §2.5 | `validate(row)` reads `row_kind` first and checks the row against that kind's list. The pattern fields (`closing_issues`, `fix_prs`, `escalation_reasons`, `guard_failures`) are validated element by element against their number pattern or Kanon's code list. `bandOf` and `areaOf` live in the metrics module, `scripts/metrics/`, not in the import-free schema (amended 2026-10-07, #516, #518; §3.6). |
| §4 | Work-item key: `pk = <key>#work`, `sk = pr-<n>`, with the PR number zero-padded to ten digits so the keys sort numerically. The key holds no date, so a closed, reopened and re-closed PR overwrites its one row (§3.1). The `recorded_at` window check is unchanged. `closed_at` must be in the past and at most 13 months old. A rewrite has the same key and overwrites. |
| §5 | The private register also holds, per key, its time from install to first review (§4, group 9). It never enters the public tree. |
| §6 | The read helper gains `query('work', from, to)`, which reads the adopter's `<key>#work` partition and filters on `closed_at`. The partition is small (about 11 MB at 13 months, §8), so reading it whole is cheap. The first cross-adopter aggregate adds the three indicators per band, under the same three-adopter rule. |
| §8 | S1 gains §5.1's fields and the extended `K-OBS-16` amendment. A new row after S7 points to this plan's steps M4 to M7 (§7). |
| §9 | One cost line for work-item rows (this plan §8). |
| §10 | A work-item row expires at `closed_at` plus 13 months, never `recorded_at` plus 13, so a rewrite can't extend retention. The erase script deletes every lane partition **and** `<key>#work`, and removes the key's time to first review from the private register. |
| Decision 2 | The `K-OBS-16` amendment also adds this plan's groups (§5.3). One amendment, in S1. |

### 5.3 The `K-OBS-16` amendment, extended

Plan 0002's decision 2 adds five groups to the rule's allowed list. This plan adds six more, each metadata:
1. **Work amounts:** counts of lines, files, directories, files per area, tests, acceptance criteria, cited spec ids, blocking issues, commits; and booleans per escalation category from Kanon's closed list.
2. **Times of platform events,** and durations between them.
3. **Actor classes:** a role, `human` or `other_bot`. Never a login, name or account id.
4. **Label-derived enums and counts:** the item's origin, follow-up severities and fates, check conclusions.
5. **Kanon's own codes:** the Merger's escalation reasons, guard ids.
6. **Linked numbers:** closing issues, and the PRs that revert or fix an item.

The rule's "never" list is unchanged, and ADR 0007 gets a note pointing to the amendment, as in plan 0002.

## 6. The dashboard

### 6.1 The views

| View | Shows | Cells |
|---|---|---|
| **Headline** | cost, yield and escape rate side by side, with first-review approval and human-correction rate beneath | per band, plus pooled with the band mix; the latest 28-day window |
| **Trend** | the same, over time | 28-day windows, each with its interval |
| **By Kanon version** | the same, per `kanon_version` | only versions with enough items; a version boundary is marked on the trend |
| **Configuration A/B** | cost, yield and escape rate per `config_fingerprint` (model, effort, turn cap), per lane | two fingerprints, same lane, overlapping windows |
| **Breakdowns** | lead time by stage; cost by role and lane; overhead; waste; reliability per lane; reviewer precision; autonomy | per band where it has one |
| **Kanon's health** | group 9 | public: distributions only |

**How the A/B view decides.** A configuration change is called a win only if:
- its cost difference, **size-controlled** with the band and the reference adopter's log-linear fit, has an interval entirely below zero (`K-OBS-14`); and
- its quality holds within a margin, with differences taken as new minus old: **yield's lower bound is above −5 percentage points**, and **the 30-day escape rate's upper bound is below +2 percentage points** (decision 11).

A cheaper configuration that might be worse is shown as **"cheaper, quality not shown to hold"**, never as a win.

### 6.2 Public and per-adopter

| | Who sees it | Contents |
|---|---|---|
| **Per-adopter report** | the adopter only | every view, on its own rows, with its reader role (plan 0002 §6) |
| **Public page** | everyone | the headline, trend and Kanon-version views; Kanon's health as distributions. No adopter is named, and no cell with fewer than three adopters is shown as cross-adopter. |
| **Owner** | the Owner, as operator | every row (plan 0002 §6) |

### 6.3 The transparency page

A section of the public page, always present:
- **Where the numbers come from.** Until a cell has three adopters, its heading reads **"Measured on Kanon's own projects"**, and the page says how many projects that is and that the Owner runs all of them. The heading is generated, not written, and a generator test fails when a cell with fewer than three adopters is published without it.
- **What "cost" means.** API list price, as the CLI computes it; not what anyone paid; no subscription translation (§0, decision 1).
- **What each indicator doesn't claim,** from §2's tables, word for word.
- **The detection gap.** Escape rates are lower bounds (§3.5).
- **The band version, the window, the sample sizes and the intervals,** for every number.
- **How to reproduce it.** The aggregate script's command and the release it ran at (`K-PRIN-14`).

### 6.4 Where it is hosted

The Owner decided this as a cost item (decision 18).

| Option | Public page | Per-adopter view | Month |
|---|---|---|---|
| **A. Static page, plus a report in the adopter's own CI** | GitHub Pages from Kanon's repository, generated by the Owner's aggregate script, committed in a PR | a Kanon command, `kanon metrics report`, run in the adopter's weekly Overseer job: Markdown to the job summary, with the reader role | **$0** |
| B. Static page in the Kanon account | S3 and CloudFront | the same CLI report | about $0.10 to $0.50 |
| C. A hosted dashboard | a BI service on the store | sign-in per adopter | from about $24 per author seat, plus per-reader charges |

**Chosen: A** (decision 18). It costs nothing, needs no sign-in system, and keeps per-adopter data on the adopter's side of the reader role. A public page that updates by PR also gives each published number a reviewed commit. B adds a cost and nothing a reader would notice. C adds an identity system for per-adopter views that Kanon doesn't otherwise need. The C price is quoted from memory, **not run** against the vendor's price list.

## 7. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **M1** | Kanon vN, **with plan 0002's S1** | §5.1's run fields; the extended `K-OBS-16` amendment (§5.3). | Every fixture's row validates. A cancelled job records `job_status: cancelled`, and an execution file with no tool events leaves `tool_errors` absent, not 0. **Mutation:** a row with `row_kind: work_item` and a run field fails. |
| **M2** | Kanon | The metrics module: `bandOf`, `areaOf`, the actor classifier, the stage partition, the revert and linked-fix detectors, and the work-item schema, with unit tests. A **dry run**, `kanon metrics dry-run --since <date>`, derives work-item rows from GitHub with a read-only token and prints only counts. | On the reference adopter since 2026-09-04, the dry run's band counts match §1.2's (S 74, M 97, L 90, XL 75) within the PRs the API and the script see differently, each explained. It prints the explicit-link and SZZ counts side by side. The Owner hand-checks a random 30 detected linked fixes and 30 undetected `fix` PRs; the precision and recall go into the PR, with how many of the undetected ones touch no code-area file (§3.5's non-code gap). **Mutations:** a PR sharing only a doc file with the earlier item is not a linked fix; a revert commit naming another SHA is not a revert; a Reviewer follow-up that also carries `project:<n>` has `origin: reviewer_followup`, not `brief`; a stage partition whose stages don't sum to the lead time fails. |
| **M3** | Kanon vN+k | The "Introduced by" field in the bug issue form and the triage playbook's line (decision 9). The escalation-paths format gains its category column (§3.7). *Category column: done in kanon#54's PR, with `escalationCategories` and the schema's `esc_*` fields held to the escalation module's list.* | A new bug filed with the field creates the `cross-referenced` event on the named PR, which the dry run then finds. |
| **M4** | Kanon, **after plan 0002's S7** | The work-item step in the collector workflow. | A PR merged in Kanon has its row in the store within one sweep. A revert of it rewrites that row with `revert_pr` set. A follow-up closed as not planned rewrites its source PR's row with `followups_not_planned` raised. A follow-up closed while its PR is still open sends no row, and the PR's row, when it closes, counts that follow-up's fate. A PR closed unmerged, reopened and merged leaves one row in the `#work` partition, with `fate: merged`. **Mutations:** a row carrying any login fails `validate`, because no field accepts one; a key built from `closed_at` turns the reopened PR into two items, and the test fails. |
| **M5** | Owner, with the backfill role (plan 0002 §7, S7a) | Backfill the reference adopter's and Kanon's work items from 2026-09-04, derived from GitHub by the same step. | Rows per month = PRs closed per month, by the command in [Measurements](#measurements). |
| **M6** | Kanon | The report module: the indicators, minimum samples, intervals and the band validity check. `kanon metrics report` for adopters; the Overseer's weekly job runs it. | A band with 9 items prints "not enough data (9)". A fixture where cost falls with the band replaces the banded view with the pooled one and a warning. Two PRs on the same issue, the first closed unmerged and the second merged, and two issue-only runs: one recorded before the first PR closed joins only the first, and one recorded between the two closes joins only the second. **Mutations:** removing the minimum-sample check fails a test; dropping rule 2's earliest-`closed_at` condition (§3.4) joins the first run to both PRs, and a test fails; choosing the earliest `closed_at` among all of the issue's PRs, ignoring "recorded before", leaves the second run unjoined, and a test fails. |
| **M7** | Owner, then Kanon | The aggregate script and the public page on GitHub Pages (§6, option A). | The generator test of §6.3. The first published numbers carry their command. |
| **M8** | Kanon, with plan 0002's S10 | Group 9's Kanon-side measures: the dispute form, #41's time to fix, upgrade lag. | A seeded dispute and a seeded #41 issue each appear in the health view. |

**Why this order.**
- **M1 rides on S1,** so no run row is ever written without the new fields, and no version 3 is needed.
- **The detector is measured before it is trusted.** M2's hand check gives the escape rate a known precision and recall before any rate is shown.
- **M4 waits for S7,** because the collector it extends moves into Kanon there. Building it into the adopter's collector first would be a second live copy (ADR 0009).
- **Nothing is published before M6's checks exist,** so the first page can't show a number below its minimum.

## 8. Monthly cost

**Estimate: about $0.03 a month more on the hosted store, so under $0.10 with plan 0002's, still under its $1 ceiling. On the reference adopter's GitHub bill, between $0 and about $6 a month more, at worst.** No AWS schedule is added, and nothing touches a resource that scales to zero, so `K-OBS-10`'s wake pricing doesn't apply.

**Volume.**
- The reference adopter merged **12 PRs a day** (§1.2), so about **360 merged items a month.**
- Closed-unmerged PRs are **not run** (no access to its pull requests). This estimate allows 20% more.
- Rewrites (reverts, linked fixes, follow-up fates) are rare: zero reverts in the window. This estimate allows another 20%.
- So about **520 work-item writes a month** for the reference adopter. Kanon and Kolophon are assumed to write no more each: at most **1,600 a month** in all, and about **17,000 rows held** at 13 months.
- A work-item row is **84 fields** at most (§3.3), about **2 KB** with DynamoDB's attribute names, so 2 write units. The six new run fields add about 0.15 KB to each run row.

| Item | Driver | Month |
|---|---|---|
| DynamoDB writes | 1,600 rows × 2 write units, plus the larger run rows | < $0.01 |
| DynamoDB storage | about 34 MB of work-item rows at steady state | about $0.01 |
| Point-in-time recovery | the same 34 MB | < $0.01 |
| DynamoDB reads | each adopter's weekly report reads its 13 months of work rows (about 11 MB), eventually consistent: about 20,000 read units a month for three adopters | < $0.01 |
| Lambda | work-item rows ride on the collector's existing hourly `POST`s | < $0.01 |
| The Owner's aggregate script | run by hand, a few full reads | < $0.01 |
| Public page (option A) | GitHub Pages | $0 |
| Per-adopter report | a step in the existing weekly Overseer job | $0 on AWS; seconds of Actions time |

**At a hundred times the volume:** about $4 a month, almost all storage and reads.

**GitHub Actions.**
- **Kanon is public**, so its collector, and the work-item step inside it, are free.
- **The reference adopter is private.** The work-item step runs inside the existing hourly collector job and does work only when a PR or a Reviewer follow-up closed since the last sweep: about one sweep in two, a few dozen API calls. The follow-up trigger adds sweeps with work, not jobs, so the worst case below is unchanged: it already assumes every hourly run crosses a minute. GitHub bills each job in whole minutes. If the step pushes the job over a minute boundary on every run, that is **720 minutes a month at most**. At the per-minute rate implied by the adopter's own figure for its collector (about $6 a month), that is **about $6 more, at worst**, and nothing if the job stays inside its minute. M4 measures it: the job's billed minutes for a week before and after. The per-minute price is **not run** against GitHub's price list.
- **The backfill (M5)** is a one-off: a few thousand API calls and about 400 writes. Cents.

**The prices are Frankfurt list prices as I know them, not run against the price list,** as in plan 0002. The conclusion is not sensitive to them.

**Observability.** No alarm, by `K-OBS-4`. A rejected work-item row turns the collector red, which is already the page. The metrics themselves page nothing: they are read weekly, and a bad week is a finding for the Overseer, not an incident.

## Measurements

`RA` is the reference adopter's checkout, read at `origin/main` on 2026-10-02. `RA_REPO` is its `owner/name`.

**Every number in §1.2, and the band counts in §3.6,** from one script, saved as `measure.py` and run as `python3 measure.py $RA`. The window is fixed by commit time, not by `git log --since`, which stops walking at the first older commit and so drops commits with out-of-order dates. The `RISK` pattern approximates the reference adopter's escalation list.

```python
# Plan 0003's measurements on an adopter checkout. Usage: python3 measure.py <repo>
# Commits on origin/main committed in [2026-09-04, 2026-10-02) UTC, release commits excluded.
import subprocess,re,sys,os,collections,datetime
R=sys.argv[1]; U=datetime.timezone.utc; START=datetime.datetime(2026,9,4,tzinfo=U).timestamp(); END=datetime.datetime(2026,10,2,tzinfo=U).timestamp()
def g(*a): return subprocess.run(['git','-C',R,*a],capture_output=True,text=True).stdout
EXCL=re.compile(r'(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG\.md)$|\.snap$')
RISK=re.compile(r'^(\.github/|scripts/qa/|docs/qa/[^/]+\.md$|sst\.config\.ts$|infra/|drizzle/|src/db/)|^(src|drizzle)/.*(payments?|auth|session)',re.I)
ALL=[]; cur=None
for l in g('log','origin/main','--no-merges','--format=@%H|%ct|%an|%s','--numstat').splitlines():
    if l.startswith('@'):
        h,t,a,s=l[1:].split('|',3); cur=dict(h=h,t=int(t),a=a,s=s,L=0,F=set(),risk=False); ALL.append(cur)
    elif l.strip() and cur:
        ad,de,p=l.split('\t',2); cur['F'].add(p)
        if RISK.search(p): cur['risk']=True
        if not EXCL.search(p): cur['L']+=(int(ad) if ad!='-' else 0)+(int(de) if de!='-' else 0)
work=[c for c in ALL if not c['s'].startswith('chore(main): release')]
items=[c for c in work if START<=c['t']<END]
print('merged PRs',len(items),'authors',dict(collections.Counter(c['a'] for c in items)))
Ls=sorted(c['L'] for c in items); n=len(Ls)
print('lines p25',Ls[n//4],'p50',Ls[n//2],'p75',Ls[3*n//4],'p90',Ls[9*n//10])
def band(c,risk=False):
    L=c['L']; b=0 if L<=200 else 1 if L<=500 else 2 if L<=1200 else 3
    files={p for p in c['F'] if not EXCL.search(p)}
    if len(files)>=20 or len({os.path.dirname(p) for p in files})>=8: b+=1
    if risk and c['risk']: b+=1
    return ['S','M','L','XL'][min(b,3)]
print('bands v1',dict(collections.Counter(band(c) for c in items)),'with a risk bump',dict(collections.Counter(band(c,True) for c in items)),'touching an escalation path',sum(c['risk'] for c in items))
print('reverts since start',sum(1 for c in items if c['s'].lower().startswith('revert')),'ever',sum(1 for c in work if c['s'].lower().startswith('revert')))
skip={'CHANGELOG.md','package.json','package-lock.json','.release-please-manifest.json'}
fixes=[c for c in items if re.match(r'fix(\(|:|!)',c['s'])]
ov=sum(1 for c in fixes if any(c['t']-30*86400<=p['t']<c['t'] and (c['F']-skip)&(p['F']-skip) for p in work))
code=re.compile(r'\.(ts|tsx|mjs|js|sql)$'); szz=0
for c in fixes:
    f=None; hit=False
    for line in g('diff','-U0',c['h']+'^',c['h']).splitlines():
        if line.startswith('--- '): f=line[6:] if line.startswith('--- a/') else None
        m=re.match(r'@@ -(\d+)(?:,(\d+))? ',line)
        if m and f and code.search(f) and not f.startswith('tests/') and '/test' not in f:
            a=int(m.group(1)); k=int(m.group(2) or 1)
            if k==0: continue
            for ct in re.findall(r'^committer-time (\d+)',g('blame','--porcelain','-L',f'{a},+{k}',c['h']+'^','--',f),re.M):
                if 0<c['t']-int(ct)<=30*86400: hit=True
    szz+=hit
print('fix commits',len(fixes),'sharing a file with an earlier commit within 30d',ov,'with a changed code line last touched <=30d before (SZZ)',szz)
```

Its output on 2026-10-02:

```
merged PRs 336 authors {<human account>: 206, <Implementer App>: 127, <dependency bot>: 3}
lines p25 227 p50 449 p75 810 p90 1381
bands v1 {'L': 90, 'M': 97, 'S': 74, 'XL': 75} with a risk bump {'XL': 146, 'L': 76, 'M': 90, 'S': 24} touching an escalation path 240
reverts since start 0 ever 1
fix commits 163 sharing a file with an earlier commit within 30d 162 with a changed code line last touched <=30d before (SZZ) 132
```

The author names are replaced here by their class (§3.2).

**The interval facts in §2:**

```
python3 -c 'z=1.96;n=50;print(z*z/(n+z*z))'                    # Wilson upper bound for 0 of 50: 0.071
python3 -c 'print(1-2*0.5**5, 1-2*0.5**6)'                     # median order-statistic interval: 0.94 at n=5, 0.97 at n=6
python3 -c 'print(1-0.9**28, 1-0.9**29)'                       # p90 order-statistic interval: 0.948 at n=28, 0.953 at n=29
```

**Not run: the reference adopter's pull-request facts.** The token this plan ran with returns no pull requests for the private repository. The Owner, with read access:

```
# closed unmerged in the window (§8's 20% allowance)
gh pr list -R $RA_REPO --state closed --limit 1000 --search 'is:unmerged closed:2026-09-04..2026-10-01' --json number --jq length
# first-review approval and review rounds, per merged PR (the Reviewer's App login from the App register)
gh pr list -R $RA_REPO --state merged --limit 1000 --search 'merged:2026-09-04..2026-10-01' --json number,reviews \
  --jq '.[] | [.number, ([.reviews[] | select(.author.login == "<reviewer-app>[bot]") | .state] | (first // "none"), length)] | @tsv'
# who merged
gh pr list -R $RA_REPO --state merged --limit 1000 --search 'merged:2026-09-04..2026-10-01' --json mergedBy --jq '[.[].mergedBy.login] | group_by(.) | map({(.[0]): length}) | add'
# the most closing issues on one PR (§3.4's bound of 20)
gh pr list -R $RA_REPO --state merged --limit 1000 --search 'merged:2026-09-04..2026-10-01' --json closingIssuesReferences --jq '[.[].closingIssuesReferences | length] | max'
# needs:human intervals on one item
gh api repos/$RA_REPO/issues/<n>/timeline --paginate --jq '.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == "needs:human") | [.event, .created_at] | @tsv'
```

**M5's check, rows per month:**

```
gh pr list -R $RA_REPO --state closed --limit 1000 --search 'closed:2026-09-01..2026-09-30' --json number --jq length
```

**Not run: the prices.** DynamoDB and Lambda as in plan 0002's [Measurements](0002-hosted-telemetry-store.md#measurements); GitHub's per-minute Actions price on its pricing page; the BI service's seat price on its vendor's page.

## Decisions for the Owner

1. **Decided by the Owner, 2026-10-02:** cost at API list price only, labelled, with no subscription translation (§0).
2. **Decided by the Owner, 2026-10-02:** capture as many fields as ADR 0007 allows (§0, §3.3).
3. **Decided by the Owner, 2026-10-02:** a complexity band and an amount of work on every item (§0, §3.6).
4. **Decided by the Owner, 2026-10-02:** three adopters before a cross-adopter figure; "measured on Kanon's own projects" until then (§0, §6.3).
5. **Decided by the Owner, 2026-10-02:** the three headline indicators always shown together, by band (§0, §2.1).
6. **Decided by the Owner, 2026-10-02:** all nine groups captured from the start, with human wait time (§0, §3.3).
7. **Accepted by the Owner, 2026-10-02.** **The indicator definitions** (§2). Two refine the Owner's proposal: efficiency's headline is **yield**, with rounds and lead time as its breakdown, because only yield says what the spend bought; and accuracy adds the **human-correction rate** beside first-review approval, because approval alone rewards a lenient Reviewer.
8. **Accepted by the Owner, 2026-10-02.** **Escaped defects from explicit links only** (§3.5): reverts by their generated text, and linked fixes by a bug issue's cross-reference plus a shared code file. SZZ is a dry-run diagnostic, never stored or published. The reference adopter's history shows both alternatives near 100% noise.
9. **Accepted by the Owner, 2026-10-02.** **Ask for the link:** an optional "Introduced by" PR-number field in the bug issue form, and a line in the triage playbook asking the Implementer to name the cause when it finds it (§3.5, M3). Without it, escape rates stay a lower bound with a large gap. It is a rulebook change to the bug intake, in its own PR.
10. **Accepted by the Owner, 2026-10-02.** **Band version 1** (§3.6): the net merged diff, thresholds at 200, 500 and 1,200 lines, a spread bump, risk as a separate split, a validity check every window, and reports always on the newest version.
11. **Accepted by the Owner, 2026-10-02.** **Minimum samples, intervals and the A/B margins** (§2, §6.1): medians from 10 items, p90 from 30, proportions from 20, escape rates by band from 50; order-statistic, bootstrap and Wilson intervals; a configuration is a win only if yield falls by less than 5 points and the 30-day escape rate rises by less than 2. These are starting values, revisited after three months of data.
12. **Accepted by the Owner, 2026-10-02.** **The work-item row** (§3, §5): a second row kind in the same table and schema module, at `<key>#work`, rewritten whole when its story changes, expiring 13 months after `closed_at`.
13. **Accepted by the Owner, 2026-10-02.** **Human-authored PRs are collected too,** with no cost, as a comparison cohort for accuracy (§1.2, §2.4). In the reference adopter they are 206 of 336 PRs. They cost nothing extra to collect, and without them the agents' escape rate has nothing beside it.
14. **Accepted by the Owner, 2026-10-02.** **Escalation categories:** each entry in `docs/qa/escalation-paths.md` gains a category from Kanon's closed list (§3.7). A change to `K-MERGE-4` and `K-LAYOUT-8`'s format, made in M3.
15. **Accepted by the Owner, 2026-10-02.** **Disputed rules** are recorded through a "Dispute a rule" issue form in Kanon's repository, with a rule-id field (§4). It is the one group 9 measure with no existing source.
16. **Accepted by the Owner, 2026-10-02.** **`guard_failures` as a validated list of `<guard>:<count>` pairs,** not a field per guard (§3.3). Kanon's guard list grows with its releases, and a field per guard would need a new schema version for each new guard. Every name is still checked against Kanon's list, so the list can't carry text.
17. **Accepted by the Owner, 2026-10-02.** **Plan 0002 is amended in a follow-up PR after this plan is accepted, and before S1 is built** (§5). The run fields join version 2.
18. **Accepted by the Owner, 2026-10-02.** **Dashboard hosting:** option A, a static public page on GitHub Pages and a per-adopter report in the adopter's own CI, at $0 (§6.4).
19. **Accepted by the Owner, 2026-10-02.** **Cross-adopter figures,** once a cell has three adopters: items pooled, intervals by a bootstrap over adopters, and the largest adopter's share of the cell printed beside it. With three adopters of very different sizes, an equal-weight mean of adopters would let the smallest swing the figure.
20. **Accepted by the Owner, 2026-10-02.** **Cost** (§8): about $0.03 a month more on the store, inside plan 0002's $1 ceiling, which stays; at worst about $6 a month more on the reference adopter's Actions bill, measured in M4. This was the gate for M4 and M5, and it is met.
