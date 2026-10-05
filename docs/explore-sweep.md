# The Explorer's sweep

The explore lane (`agent-explore.yml`) has the Explorer triage a sweep of your running product and file what it finds ([docs/lanes.md](lanes.md#the-explorers-sweep)). What it sweeps, with which tool and in which tiers, is your product, so the sweep is yours: a hook at a fixed path. What the sweep hands the lane is Kanon's: one summary, in the format below ([plan 0004 §4](plans/0004-move-the-remaining-lanes.md#4-what-stays-in-the-adopter-permanently), decision 5).

## The hook

`.github/actions/explore-sweep/action.yml` is a composite action you write. The lane reads it from its checkout of your default branch, after the project-setup hook has run with `lane: explorer`, `install: 'true'`, `browsers: 'true'` and the database your test-database declaration gives (`K-LAYOUT-16`). So your app's dependencies, its database and a browser are ready, and the hook installs and starts nothing of its own.

It takes one input, a string:

| Input | What |
|---|---|
| `tier` | The tier to sweep, as your sweep names its tiers, from the caller's dispatch. Empty sweeps every tier. Refuse a value that isn't one of your tier names, so it can't add arguments of its own. |

It runs the sweep and writes the summary to `qa-explore-summary.json`, at the root of the checkout. It may also keep a raw report and upload it as an artifact of its own: the lane reads neither. **Findings are not failures.** A route with a signal is a finding in the summary, so the hook succeeds when the sweep ran, whatever it found, and fails only when the sweep could not run.

`lane-check` fails an explore caller in a repository without the hook.

## The summary

One JSON object, with exactly these keys and no others, at any level:

| Key | Type | What |
|---|---|---|
| `timestamp` | string | When the summary was written, in ISO 8601 as `Date#toISOString` writes it: `2026-10-04T06:17:00.000Z` |
| `trigger` | string | The event that ran the sweep: `schedule` or `workflow_dispatch` |
| `commit` | string | The commit swept, a full SHA: the run's `github.sha` |
| `tier` | string | The tier swept; `all` when the run asked for none |
| `routes_swept` | integer | How many entries `routes` holds |
| `passed` | integer | How many of them passed |
| `failed` | integer | How many of them failed |
| `routes` | array | One `{route, status, signal}` per route swept. `route` is a non-empty string; `status` is `passed` or `failed`; `signal`, a non-empty string, is present only on a failed route that reported one, and is the first objective signal the sweep recorded there |
| `cost_proxy` | object | `{duration_ms_total, screenshots}`: the sweep's total duration in milliseconds, a non-negative number, and how many screenshots it took, a count |

`passed + failed == routes_swept`. [`scripts/explore-summary.mjs`](../scripts/explore-summary.mjs) is the format's executable definition, and its `checkSummary` names the key in every problem it finds. The format is the one the reference adopter's sweep hook already writes, and its QA store and change gate already read (RA-2746).

A worked summary of a two-route sweep with one finding:

```json
{
  "timestamp": "2026-10-04T06:21:42.512Z",
  "trigger": "schedule",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "tier": "all",
  "routes_swept": 2,
  "passed": 1,
  "failed": 1,
  "routes": [
    { "route": "/", "status": "passed" },
    { "route": "/admin/courses", "status": "failed", "signal": "objective signals on /admin/courses: [pageerror] Minified React error #418" }
  ],
  "cost_proxy": { "duration_ms_total": 48210, "screenshots": 2 }
}
```

### No summary is no sweep, never green

A sweep that wrote no report writes no summary. The lane reads each of these as **no sweep**: the job fails, naming every problem, the agent doesn't run, and nothing is recorded in the store, so the change gate never takes it for a green baseline:

- no `qa-explore-summary.json`;
- one that isn't JSON, or breaks the format above;
- one for another commit than the run's, or another tier than the run asked for;
- one that swept no route. A store that recorded it would hold a green full sweep of nothing, and the next scheduled run on that commit would be skipped.

### No version key

The summary has no version key, and that is deliberate. The store keeps each run's summary as its raw report, so a key added now would change every stored report from here on, for a reader that has nothing to tell apart: there is one format. A summary in any other shape fails by name, so a hook and a lane that disagree fail loudly, not silently. If a second format ever ships, it adds a `format` key and a summary without one is this format, so the stored reports still read.

### What the lane does with it

- **The Explorer reads it,** and only it: each failed route's `signal` is what it files from. It never reads your raw report, whose format is your tool's.
- **The `put` store job records it** through your QA store hook ([The QA store](qa-store.md)), as the run's raw report, with a row for the run and one per route. Kanon's AWS implementation reads `commit`, `trigger`, `tier`, `routes_swept`, `passed`, `failed` and `routes` from it.
- **The change gate reads the store's answer, not the file:** the newest recorded sweep with `tier` `all` and `failed` 0 is the green baseline a scheduled run compares its commit with.
