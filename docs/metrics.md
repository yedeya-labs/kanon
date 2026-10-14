# `kanon metrics`

Two subcommands: `kanon metrics dry-run` derives work-item rows from GitHub and prints counts (below), and [`kanon metrics report`](#kanon-metrics-report) reports the three headline indicators from stored rows.

`kanon metrics dry-run` derives the work-item row of every pull request closed in a window, from GitHub, and prints counts only ([plan 0003](plans/0003-metrics.md) §7, step M2, [#516](https://github.com/yedeya-labs/kanon/issues/516)). It is how the metrics module is tried on a real history before the collector writes a single work-item row (M4). **It writes nothing to GitHub and sends nothing to the telemetry store.**

```sh
kanon metrics dry-run --since 2026-09-04 --dir .                       # from the repository's checkout
kanon metrics dry-run --since 2026-09-04 --until 2026-10-02 --repo <owner>/<repo> --json
kanon metrics dry-run --since 2026-09-04 --dir . --details ../ops/metrics-details.json
```

## What it reads

- **The pull requests closed in the window**, `--since` (00:00 UTC) up to `--until` (00:00 UTC, not included; default now), each with its files, commits, reviews, timeline and closing issues, and each closing issue's labels and label events. It reads them through GitHub's GraphQL API, a page of pull requests at a time with every list nested, and pages a nested list past its first page for that pull request alone. GraphQL gives no renamed file's old path, so a pull request with a rename has its files read once more from REST. Open pull requests are counted and left out: they have no row yet (§3.1). An open pull request is counted when it was opened in the window; one opened before `--since` is in neither count.
- **Release pull requests are left out** of every count, and of the detectors' items, since a release is never a fix's cause; their number is reported as left out, `release` (§1.2 leaves release commits out; the Owner, on [#538](https://github.com/yedeya-labs/kanon/pull/538)). A release PR is recognised by what the release workflow produces, never by a repository's name: release-please's label `autorelease: pending` or `autorelease: tagged`; an author that is the App register's Releaser App; or, for history from before the Releaser App, `github-actions[bot]` with a conventional release title, `chore(<branch>): release <version>`. The title alone never makes a person's pull request a release.
- **The declarations**: the App register (`docs/qa/agent-identities.md`), the code areas in `docs/qa/stack.md` and the escalation file (`docs/qa/escalation-paths.md`). With `--dir`, from that checkout; without it, from the default branch on GitHub. A missing one takes Kanon's default, and the output says which were read: no code areas declared, the escalation file's default (the pipeline's own paths), and, for a missing register, no App registered, so every bot is `other_bot`. A file that is there but can't be read or parsed stops the run (exit 3), so no row is derived from a guess.
- **`git blame`, for SZZ**, in the checkout `--dir` names: each fix's old-side lines, from `git diff -U0` between its merge commit and that commit's parent, blamed at the parent (`git blame --porcelain -L`). Without `--dir`, or when the checkout lacks a fix's merge commit or its parent, SZZ is reported as **not run**, with the reason, and its counts are `null`, never 0. Fetch the default branch first.

It needs `gh` and a token that can read the repository's pull requests and issues; nothing more. It says on standard error which token `gh` used and whose it is, as the other commands do.

**Respecting GitHub's limits.** A call refused by a secondary rate limit or a gateway error is tried again, after 30, 60 and 90 seconds. The run stops, as an error, when the token has fewer than 100 GraphQL points left, and says when they reset.

**Nothing is dropped silently.** GitHub caps a pull request's commits at 250 and its files at 3,000. A list GitHub stops short of its total is **truncated**, and that pull request is left out under that reason, as is one whose nested page couldn't be read (**unreadable**). Either makes the exit code 4.

## What it prints

Counts, the window, the repository you named and field names. **No title, login or path** reaches standard output, in prose or in JSON: the output of a dry run is the kind of text pasted into an issue ([ADR 0007](decisions/0007-data-boundary.md), `K-OBS-16`).

- **Pull requests:** read, merged, closed unmerged, and left out: still open, release, truncated, unreadable.
- **Rows:** how many validate against the telemetry schema's work-item list and the stage partition, and, for each one that doesn't, only the fields that failed.
- **Bands** (§3.6), for the merged and the closed unmerged apart; **files by area** (§3.7); merged rows touching an escalation path, by the escalation file, or by Kanon's default (the pipeline's own paths) without one.
- **Origins** and **actor classes**: the author's class and who merged, each with `unknown` (§3.2, §3.3). `human` is a person: a bot, and GitHub's own committer `web-flow` (the committer of every commit GitHub creates through the API or the web UI), are `other_bot`.
- **Linked fixes**, over the merged fix pull requests (a conventional `fix` title, or a closing issue labelled `bug`), the explicit links and SZZ side by side (§3.5, decision 8): `explicit`, `szz`, `both`, `explicitOnly`, `szzOnly`, `neither`; `undetected`, the fixes the explicit detector links to nothing; and `nonCodeGap`, the fixes that change no code-area file, which condition 3 can never detect.
- **Reverts:** the pull requests that revert an earlier one, and the items reverted.

Both detectors look only inside the window: a fix whose cause merged before `--since` links to nothing. Start the window earlier than the fixes you want judged.

Both detectors also take as a fix's cause only an item that merged before the fix was opened (kanon#563). The dates of the issues the fix closes play no part (kanon#571): a batch fix closes old issues beside the new one, and a Reviewer's follow-up is filed while its cause is still under review, so either would drop a correct link.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every pull request in the window was read, and its row is valid. |
| 1 | At least one row failed validation. |
| 2 | A usage error. |
| 3 | It could not run: no repository, a checkout of another repository, a declaration that can't be parsed, a GitHub error, a rate limit nearly spent. |
| 4 | Incomplete: every row read is valid, but a pull request was left out as truncated or unreadable, or a blame failed. |

## The JSON output

`--json` prints one document, following [the convention every `kanon` command's JSON shares](cli-json.md), versioned by its `schema` field, `kanon-metrics-dry-run/v1`:

| Field | Type | Meaning |
|---|---|---|
| `schema`, `kanon`, `status`, `exitCode` | | As in [`docs/cli-json.md`](cli-json.md). `status` is `ok`, `invalid-rows`, `incomplete` or `error`. |
| `repo` | string | `owner/name`. |
| `window` | object | `since` and `until` (`YYYY-MM-DD`; `until` null for now). |
| `declarations` | object | `source` (`checkout` or `github`), `register` (`read` or `absent`), `codeAreas` (`declared` or `default`), `escalationFile` (`read` or `default`). |
| `prs` | object | `read`, `merged`, `closedUnmerged`. |
| `leftOut` | object | `open`, `release`, `truncated`, `unreadable`. |
| `rows` | object | `valid`, `invalid`, and `invalidFields`, each failing field's name with how many rows it failed. |
| `bands` | object | `merged` and `closedUnmerged`, each `S`, `M`, `L`, `XL` and `none`. |
| `areas` | object | Files per area, over every row. |
| `escalation` | object | `mergedTouching`, by the escalation file or, without one, Kanon's default. |
| `origins`, `authors`, `mergedBy` | object | A count per origin or actor class, and `unknown`. |
| `linkedFixes` | object | `fixes`, `explicit`, `szz`, `both`, `explicitOnly`, `szzOnly`, `neither`, `undetected`, `nonCodeGap`. The SZZ counts are null when SZZ didn't run. |
| `reverts` | object | `reverting`, `revertedItems`. |
| `szz` | object | `status` (`ran` or `not-run`), `reason` (null when it ran), `blameFailures`. |
| `githubCalls` | number | The calls the reading took. |

On a usage error or when it can't run, the document is the error document, `{ "schema", "kanon", "status": "error", "exitCode", "error" }`.

## The details file is private

`--details <file>` also writes a local JSON file, `kanon-metrics-details/v1`, for the Owner's hand check: every row (the same fields the telemetry store would take: counts, times, classes, numbers), the rows that failed with their field names, the pull requests left out and why, and, for every merged fix, its explicit links (the item's number, how it was found, `cross-reference` or `introduced-by`, and the days) and its SZZ links (number and days), and whether it touches a code-area file.

**It names pull requests, so it stays private.** It goes to the private ops repository, never into a public issue or pull request. It is never written unless asked for, and never inside the checkout `--dir` names, where a commit would publish it; it is written readable by its owner only.

## How M2's acceptance uses it

Plan 0003 §7 accepts M2 on the reference adopter, with the Owner:

1. Run `kanon metrics dry-run --since 2026-09-04 --until 2026-10-02 --dir <checkout>` and compare the merged bands with §1.2's (S 74, M 97, L 90, XL 75). [Measurements](plans/0003-metrics.md#measurements)' script counts commits on main by commit time and leaves out release commits; the dry run counts pull requests by `closed_at`, and leaves release pull requests out as the script leaves release commits out. Each pull request the two see differently is explained.
2. Run it again with `--details` into the private ops repository. From its `fixes`, the Owner hand-checks a random 30 with an explicit link and 30 `fix` pull requests without one, and puts the precision and recall in the pull request that closes M2, with how many of the undetected touch no code-area file.
3. The explicit and SZZ counts go into that pull request side by side, as printed.

## `kanon metrics report`

`kanon metrics report` reports [plan 0003](plans/0003-metrics.md)'s three headline indicators by complexity band (§2, step M6, [#659](https://github.com/yedeya-labs/kanon/issues/659)), their secondary measures, and the trend, by-version and configuration A/B views (§6.1, [#669](https://github.com/yedeya-labs/kanon/issues/669)), from one adopter's stored rows. It reads only the files it's given, and calls nothing.

```sh
kanon metrics report --rows runs-and-items.json                       # Markdown, the last 28 days
kanon metrics report --rows runs.jsonl --rows work.jsonl --until 2026-10-01 --json
kanon metrics report --rows runs-and-items.json --windows 12           # a trend over 12 windows
```

**The Overseer runs it every week** ([#668](https://github.com/yedeya-labs/kanon/issues/668), §6.4), for a repository that maps a telemetry reader role to that lane ([The Overseer's cost view](telemetry.md#the-overseers-cost-view)). The last step of the lane's `telemetry` job reads the repository's work-item partition and each lane's partition, over the store's thirteen months, and writes this Markdown, for the default 28 days to the run's time, to the job's summary. The rows stay in that step: no file, log line or artifact holds one. A partition it can't read withholds the whole report and says which, since a report missing a lane's cost or the work items would be wrong. The report never fails the job.

**Its input** is the adopter's run rows and work-item rows, exported from the telemetry store with its reader role ([plan 0002](plans/0002-hosted-telemetry-store.md) §6), as a JSON array, JSON Lines, or a JSON object with a `rows` array. Give `--rows` once per file. Only `tag: run` rows count (§2.1). A row of another kind, or one missing what the report needs to place it (a time, a lane, a PR number, a fate), is counted as left out, never guessed at. The window ends at `--until` (00:00 UTC, not included; default now) and reaches back `--days` (default 28), by close date.

**What it prints**, always together, per band (S, M, L, XL) and pooled, with the pooled cells' band mix:

| Indicator | What it is | Minimum | Interval |
|---|---|---|---|
| Cost per merged item | The median and p90, over merged items closed in the window, of the summed `total_cost_usd` of every delivery-lane run joined to the item. **API list price**, not what anyone paid. Items with no run row are left out, not counted as zero. | median 10, p90 30 | order statistics |
| Yield | The cost of delivery runs joined to a merged item over the cost of all delivery runs, over the items settled in the window. Runs that never reached a PR are a **No PR** column. | 20 | bootstrap, 2,000 resamples, fixed seed |
| Escaped defects, 30 and 90 days | Agent-authored merged items with an explicit revert or linked fix within the horizon, over those merged in the window that far back, so each has had its whole horizon. A **lower bound** (§3.5). Human-authored items are printed beside, pooled, as a comparison cohort. | 50 | Wilson |
| First-review approval | Merged items whose first Reviewer verdict was `approved`, over those with a verdict. | 20 | Wilson |
| Human-correction rate | Agent-authored merged items with a human commit or a human's change request after the Reviewer approved, over those where that is known. | 20 | Wilson |

- **A cell below its minimum shows `not enough data (N)`**, with its count, never a number (§2.1, decision 11).
- **The band validity check (§3.6).** The report computes Kendall's τ-b between band and cost per merged item, with a bootstrap interval. Unless the interval sits entirely above zero, or when there are fewer than 10 such items in two bands, **the pooled view replaces the banded one, with a warning**, for every indicator. The median cost per band is printed with the check.
- **The band is recomputed** from each row's stored counts with the newest band version, never read from the row, so one report never mixes versions.
- **Overhead,** the Explorer's, the code audit's, the telemetry Explorer's, the Overseer's and the digests' spend, and the Lead's runs that join no item (a brief run, or a split of a tracking issue no PR closes: planning, §3.4), is printed beside cost, never inside it, and is left out of yield's numerator and denominator alike. A Lead run that joins an item is in that item's cost and yield (§2.2).
- **A missing cost is unknown, never $0.** A merged item none of whose delivery runs reports `total_cost_usd` is left out of cost and yield, and counted; so are the runs without a cost inside the items that are costed. A settled item of either fate, or a settled group of delivery runs that join no item, whose runs report no cost is left out of yield, so it never counts toward a cell's minimum, and is counted: the merged items in `cost.mergedWithoutCost`, the closed-unmerged items in `yield.closedWithoutCost`, the groups in `yield.unjoinedWithoutCost`. The report's sentence "Left out of yield" names all three. A closed-unmerged item with no delivery run carries no delivery spend, so leaving it out changes no yield, and it is not counted.

**Beside the indicators**, in the same cells and the same view, banded or pooled (§2.2, §2.3):

| Measure | What it is | Minimum |
|---|---|---|
| Cost per acceptance criterion | The median, over costed merged items whose first closing issue has criteria (`ac_count` above 0), of the item's cost over its `ac_count`. | 10 |
| Review rounds to approval | The median `review_rounds` over merged items the Reviewer reviewed at least once. | 10 |
| Lead time to merge, and each stage | The median and p90 of `lead_time_s` over merged items, and of each stage's `t_<stage>_s` (§3.3's partition: `human`, `merge_queue`, `agent`, `review`, `ci`, `rework`, `queue`, `other`). | median 10, p90 30 |
| Human wait | The median `t_human_s` over merged items. | 10 |
| Cache savings | Over every run recorded in the window: `cache_read_tokens` × (input price − cache-read price), at **API list price**, from the dated price table (`scripts/metrics/prices.mjs`), with the share of what the priced runs would have cost uncached. A run is priced at its `model` by the table entry in force when it ran. A run the table can't price (a model it doesn't hold, a long-context `[1m]` model, no cache count) is counted, and its model named: unknown, never $0. The table holds every model Kanon's lanes run on, as `--model` or `--fallback-model` (a test reads them from the workflows), at Anthropic's list prices, each read from [its pricing page](https://platform.claude.com/docs/en/about-claude/pricing) with the date read beside the table. It leaves out Claude Haiku 5.5, whose price depends on the prompt's length, which the run row doesn't carry, so its runs are unpriced. | |

**The issue-side cross-check (§3.6)** is printed beside the band validity check: Kendall's τ-b between cost and each issue-side size, `ac_count` and `issue_body_chars`, with a bootstrap interval, over brief-driven merged items (`origin: brief`) with criteria. The measures are used raw: there is no issue-side band (the Owner's decision of 2026-10-14, [#685](https://github.com/yedeya-labs/kanon/issues/685)). It *rises* when the interval sits entirely above zero, and needs 10 such items. When every cost is tied, τ is not computed, and the line says so. It is a cross-check only, and never changes the view.

**The views (§6.1)** read the span of `--windows` windows (default 6) of `--days` each, ending at `--until`. Their cells are the headline's, pooled across bands with the band mix beside them; the banded cells are the headline's, for the latest window.
- **Trend:** the headline for each window, oldest first, each with its interval. A Kanon version starts in the window its first item closed in, and the trend marks it there when a versioned item closed before that first item, in an earlier window or the same one. The version of the earliest versioned item is never marked, since nothing came before it.
- **By Kanon version:** the headline per item `kanon_version`, for each version with at least 10 merged items in the span; the others are listed with their counts.
- **Configuration A/B:** per delivery lane that ran on two or more `config_fingerprint`s in the span, its newest fingerprint (by first run) against the one before it, over the whole span. The arms need not have run at the same time: each arm's first and last run is printed, so a reader can see how far they overlap, and a trend that isn't diff size (a Kanon release, a change in the work mix) can still be read as the configuration's. An item is in an arm when every run of the lane joined to it ran on that fingerprint; an item on both is left out and counted. A change is a **win** only if its cost at equal size has an interval entirely below zero, from the reference adopter's log-linear fit (log cost on log(1 + `changed_lines`) and the configuration, with no band term, over merged items of the two arms, 10 per arm at least), **and** its quality holds within decision 11's margins, new minus old: yield's lower bound above −5 points (a two-sample seeded bootstrap, 20 settled items per arm), and the 30-day escape rate's upper bound below +2 points (Newcombe's interval, 50 matured agent-authored items per arm). A cheaper change whose quality isn't shown to hold is **cheaper, quality not shown to hold**, never a win. An arm's cost is its items' whole delivery cost, as the headline's, so a change that is cheaper in its lane and dearer downstream is not called cheaper. These readings of §6.1 are the Owner's decision of 2026-10-14 ([#685](https://github.com/yedeya-labs/kanon/issues/685)).

**How runs join items** is §3.4's rule, in `scripts/metrics/join.mjs`, which every reader uses: a run joins the item whose PR it names; a run naming only an issue joins the first item closing that issue to close after the run (on a tie, the lowest PR number). So a run joins at most one item. A delivery run that joins nothing, other than a Lead's (overhead, above), settles, not merged, 30 days after the last run on its PR or issue; the report reads no issue's state, so an issue closed without a PR settles the same way.

**Exit codes:** 0 the report was made (a cell with too little data or a pooled view is not a failure); 2 a usage error; 3 a rows file that can't be read or isn't JSON rows. The message names the file, never its content.

### Its JSON output

`--json` prints one document, `kanon-metrics-report/v1`, following [the convention](cli-json.md):

| Field | Type | Meaning |
|---|---|---|
| `schema`, `kanon`, `status`, `exitCode` | | As in [`docs/cli-json.md`](cli-json.md). `status` is `ok` (the banded view), `pooled` (the validity check replaced it) or `error`. |
| `window` | object | `from`, `until` (`YYYY-MM-DD`) and `days`. |
| `bandVersion`, `costBasis` | number, string | The band version every item was banded with; `API list price`. |
| `view`, `warnings` | string, array | `banded` or `pooled`, and why, as sentences. |
| `rows` | object | `runs`, `workItems`, `runsJoined`, `runsUnjoined`, and `ignored`: `notRun`, `otherKind`, `unreadable`. |
| `validity` | object | `status` (`valid`, `invalid`, `not-enough-data`), `n`, `tau`, `low`, `high`, and `medianCost` per band. |
| `cost` | object | `cells` (each with `median` and `p90`), `mergedWithoutRuns`, `mergedWithoutCost` (merged items whose runs report no cost), `runsWithoutCost` (runs without a cost inside the costed items), `overhead` (`runs`, `usd`). |
| `yield` | object | `cells`, each with `yield`; `closedWithoutCost` (closed-unmerged items in the window with delivery runs, none of which reports a cost, left out of yield); and `unjoinedWithoutCost` (settled groups of delivery runs that join no item and report no cost, left out of yield). The merged items left out of yield for the same reason are `cost.mergedWithoutCost`. |
| `escape` | object | `d30` and `d90`, each with `mergedFrom`, `mergedUntil`, and `agent` and `human` cells, each with `rate`. |
| `approval`, `correction` | object | `cells`, each with `rate`. |
| `secondary` | object | `costPerAc`, `reviewRounds` and `humanWait`, each with `cells` holding `median`; `leadTime`, whose `cells` hold `median`, `p90` and `stages` (each stage's `median` and `p90`); and `cacheSavings`: `usd`, `runs` (priced), `share` (or null), `unpriced` and `unpricedModels`. |
| `validity.issueSide` | object | `n` (brief-driven costed items with criteria), and `acCount` and `bodyChars`, each `{ "status": "rises" \| "not-shown", "n", "tau", "low", "high" }` or `not-enough-data`. |
| `span` | object | The views' span: `from`, `until`, `windows`, `days`. |
| `trend` | array | One entry per window, oldest first: `window`, `cost` (`median`, `p90`), `yield`, `escape` (`d30`, `d90`), `approval`, `correction` (each an estimate), `bandMix` and `versionsIntroduced`. |
| `byVersion` | object | `minimum`, `versions` (each `version`, `items` and the trend's cells), `fewer` (`version`, `items`) and `unversioned`. |
| `ab` | object | `margins` (`yield`, `escape30`) and `lanes`: each `lane`, `old` and `new` (`fingerprint`, `firstRun`, `lastRun`, `items`, `cost`, `yield`, `escape.rate`), `mixed`, `costAtEqualSize` (`{ "ok": true, "n", "pct", "loPct", "hiPct" }` or `{ "ok": false, "reason" }`), `yieldDifference` (`{ "status": "ok", "value", "low", "high" }`, `not-enough-data`, or `{ "status": "no-spend", "n" }` when an arm's delivery runs cost nothing, so yield has no value) and `escapeDifference` (`{ "status": "ok", "value", "low", "high" }` or `not-enough-data`), and `verdict`: `win`, `cheaper-quality-not-shown`, `not-shown-cheaper` or `not-enough-data`. |
| `bootstrap` | object | `resamples` and `seed`. |

`cells` holds `S`, `M`, `L`, `XL` in the banded view only, `pooled` always with its `bandMix`, and, for yield, `noPr`. Each estimate is `{ "status": "ok", "n", "value", "low", "high" }`, `{ "status": "not-enough-data", "n", "minimum" }` or, for a yield with no spend, `{ "status": "no-spend", "n" }`. Dollars and shares are rounded to four decimals.

## The public metrics page

Plan 0003 M7 ([#661](https://github.com/yedeya-labs/kanon/issues/661)), §6 option A as the Owner amended it on 2026-10-11: a static page on GitHub Pages, served from Kanon's own repository at `docs/metrics/index.html`. It shows the headline, trend and Kanon-version views of each project that declared its figures publishable, Kanon's health as counts and distributions, and how each number is made (§6.3).

**Measured on Kanon's own projects.** Until three adopters declare their figures, every project on the page is one the Owner runs: Kanon and the operator's second repository, which is published under a neutral label and never named or linked. The page's section of figures says so under the generated heading "Measured on Kanon's own projects", with how many projects that is. Each project is shown alone; no figure combines projects. Until then, set `publish_own_figures_as` only on the Owner's own projects' register entries, each with a label that names no repository, organisation or person ([The aggregate function](telemetry.md#the-aggregate-function)).

**When a bail counts against yield.** The page says, beside the method, that a run which stopped before opening a pull request counts against yield only once its issue has been idle for `IDLE_DAYS` (30, `scripts/metrics/indicators.mjs`), while a merged item counts when it closes. So a project's first month, and the month after any burst of such runs, reads yield high until they settle ([#703](https://github.com/yedeya-labs/kanon/issues/703)).

**How it is refreshed.** `.github/workflows/metrics-page.yml`, weekly on Monday at 07:15 UTC or by dispatch, on the default branch:

1. its `aggregate` job assumes the aggregate-invoker role and reads the function's [page view](telemetry.md#the-page-view) with `scripts/aggregate-read.mjs page`, which refuses anything but the view's keys, codes, dates, versions and numbers;
2. its `page` job reads Kanon's health with `scripts/telemetry/kanon-health.mjs --json` and renders the page with `.github/scripts/metrics-page.mjs`;
3. when the page changed, it commits it as the Author App, with the delegate's sign-off, to the branch `kanon/metrics-page` and opens a pull request (or updates the open one). The Owner reads the figures and merges it; nothing is published before the merge.

**What the generator refuses.** It writes no page:
- whose section of figures from fewer than three adopters lacks the generated heading, or doesn't say how many projects it is and that Kanon's Owner runs all of them (§6.3's generator test, in `tests/unit/metrics-page.test.ts`), or that has a table of figures outside such a section;
- with an estimate from fewer items than its minimum (§2.1), or from an answer computed with other minimums than the release's;
- that holds an `@`, a bot login, a GitHub URL, a function URL, an ARN or a twelve-digit account id;
- from a health document of another schema, or naming a rule the rulebook doesn't have.

**Turning Pages on, once.** In the repository's settings, under **Pages**, set **Source** to **Deploy from a branch**, the branch to `main` and the folder to `/docs`. The page is then at `/metrics/` under the Pages address. `docs/.nojekyll` makes Pages serve the folder as it is, without Jekyll, which would otherwise read the `${{ }}` in the docs as Liquid.

**Reproduce a page.** The page names the release and commit it was generated at, and points here for the commands: only the store's operator can run them, so they stay off the public page (Owner, 2026-10-12). With the invoker role's credentials:

```sh
OUT=. KANON_AGGREGATE_URL=<the function URL> node "$KANON/scripts/aggregate-read.mjs" page
node scripts/telemetry/kanon-health.mjs --json > health.json
node .github/scripts/metrics-page.mjs --page page.json --health health.json --release <x.y.z> --commit <sha> --out docs/metrics/index.html
```
