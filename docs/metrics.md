# `kanon metrics dry-run`

`kanon metrics dry-run` derives the work-item row of every pull request closed in a window, from GitHub, and prints counts only ([plan 0003](plans/0003-metrics.md) §7, step M2, [#516](https://github.com/yedeya-labs/kanon/issues/516)). It is how the metrics module is tried on a real history before the collector writes a single work-item row (M4). **It writes nothing to GitHub and sends nothing to the telemetry store.**

```sh
kanon metrics dry-run --since 2026-09-04 --dir .                       # from the repository's checkout
kanon metrics dry-run --since 2026-09-04 --until 2026-10-02 --repo <owner>/<repo> --json
kanon metrics dry-run --since 2026-09-04 --dir . --details ../ops/metrics-details.json
```

## What it reads

- **The pull requests closed in the window**, `--since` (00:00 UTC) up to `--until` (00:00 UTC, not included; default now), each with its files, commits, reviews, timeline and closing issues, and each closing issue's labels and label events. It reads them through GitHub's GraphQL API, a page of pull requests at a time with every list nested, and pages a nested list past its first page for that pull request alone. GraphQL gives no renamed file's old path, so a pull request with a rename has its files read once more from REST. Open pull requests are counted and left out: they have no row yet (§3.1). An open pull request is counted when it was opened in the window; one opened before `--since` is in neither count.
- **Release pull requests are left out** of every count, and of the detectors' items, since a release is never a fix's cause; their number is reported as left out, `release` (§1.2 leaves release commits out; the Owner, on [#538](https://github.com/yedeya-labs/kanon/pull/538)). A release PR is recognised by what the release workflow produces, never by a repository's name: release-please's label `autorelease: pending` or `autorelease: tagged`; an author that is the App register's Releaser App; or, for history from before the Releaser App, `github-actions[bot]` with a conventional release title, `chore(<branch>): release <version>`. The title alone never makes a person's pull request a release.
- **The declarations**: the App register (`docs/qa/agent-identities.md`), the code areas in `docs/qa/stack.md` and the escalation file (`docs/qa/escalation-paths.md`). With `--dir`, from that checkout; without it, from the default branch on GitHub. A missing one takes Kanon's default, and the output says which were read.
- **`git blame`, for SZZ**, in the checkout `--dir` names: each fix's old-side lines, from `git diff -U0` between its merge commit and that commit's parent, blamed at the parent (`git blame --porcelain -L`). Without `--dir`, or when the checkout lacks a fix's merge commit or its parent, SZZ is reported as **not run**, with the reason, and its counts are `null`, never 0. Fetch the default branch first.

It needs `gh` and a token that can read the repository's pull requests and issues; nothing more. It says on standard error which token `gh` used and whose it is, as the other commands do.

**Respecting GitHub's limits.** A call refused by a secondary rate limit or a gateway error is tried again, after 30, 60 and 90 seconds. The run stops, as an error, when the token has fewer than 100 GraphQL points left, and says when they reset.

**Nothing is dropped silently.** GitHub caps a pull request's commits at 250 and its files at 3,000. A list GitHub stops short of its total is **truncated**, and that pull request is left out under that reason, as is one whose nested page couldn't be read (**unreadable**). Either makes the exit code 4.

## What it prints

Counts, the window, the repository you named and field names. **No title, login or path** reaches standard output, in prose or in JSON: the output of a dry run is the kind of text pasted into an issue ([ADR 0007](decisions/0007-data-boundary.md), `K-OBS-16`).

- **Pull requests:** read, merged, closed unmerged, and left out: still open, release, truncated, unreadable.
- **Rows:** how many validate against the telemetry schema's work-item list and the stage partition, and, for each one that doesn't, only the fields that failed.
- **Bands** (§3.6), for the merged and the closed unmerged apart; **files by area** (§3.7); merged rows touching an escalation path, when the escalation file is declared.
- **Origins** and **actor classes**: the author's class and who merged, each with `unknown` (§3.2, §3.3).
- **Linked fixes**, over the merged fix pull requests (a conventional `fix` title, or a closing issue labelled `bug`), the explicit links and SZZ side by side (§3.5, decision 8): `explicit`, `szz`, `both`, `explicitOnly`, `szzOnly`, `neither`; `undetected`, the fixes the explicit detector links to nothing; and `nonCodeGap`, the fixes that change no code-area file, which condition 3 can never detect.
- **Reverts:** the pull requests that revert an earlier one, and the items reverted.

Both detectors look only inside the window: a fix whose cause merged before `--since` links to nothing. Start the window earlier than the fixes you want judged.

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
| `escalation` | object or null | `mergedTouching`; null without an escalation file. |
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
