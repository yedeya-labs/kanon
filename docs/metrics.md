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

`kanon metrics report` reports [plan 0003](plans/0003-metrics.md)'s three headline indicators by complexity band (§2, step M6, [#659](https://github.com/yedeya-labs/kanon/issues/659)), from one adopter's stored rows. It reads only the files it's given, and calls nothing.

```sh
kanon metrics report --rows runs-and-items.json                       # Markdown, the last 28 days
kanon metrics report --rows runs.jsonl --rows work.jsonl --until 2026-10-01 --json
```

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
- **Overhead,** the Explorer's, the code audit's, the telemetry Explorer's, the Overseer's and the digests' spend, is printed beside cost, never inside it, and is left out of yield.

**How runs join items** is §3.4's rule, in `scripts/metrics/join.mjs`, which every reader uses: a run joins the item whose PR it names; a run naming only an issue joins the first item closing that issue to close after the run (on a tie, the lowest PR number). So a run joins at most one item. A run that joins nothing settles, not merged, 30 days after the last run on its PR or issue; the report reads no issue's state, so an issue closed without a PR settles the same way.

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
| `cost` | object | `cells` (each with `median` and `p90`), `mergedWithoutRuns`, `runsWithoutCost`, `overhead` (`runs`, `usd`). |
| `yield` | object | `cells`, each with `yield`. |
| `escape` | object | `d30` and `d90`, each with `mergedFrom`, `mergedUntil`, and `agent` and `human` cells, each with `rate`. |
| `approval`, `correction` | object | `cells`, each with `rate`. |
| `bootstrap` | object | `resamples` and `seed`. |

`cells` holds `S`, `M`, `L`, `XL` in the banded view only, `pooled` always with its `bandMix`, and, for yield, `noPr`. Each estimate is `{ "status": "ok", "n", "value", "low", "high" }`, `{ "status": "not-enough-data", "n", "minimum" }` or, for a yield with no spend, `{ "status": "no-spend", "n" }`. Dollars and shares are rounded to four decimals.
