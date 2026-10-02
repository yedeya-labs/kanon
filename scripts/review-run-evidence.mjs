// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — what the Actions listing for a head SHA says about whether a review
// of THAT head was ever attempted (RA-1594, RA-1689).
//
// ── THE BOUND EVERY REVIEW RECOVERY RESTS ON ────────────────────────────────
// RA-1408 gave the review lane a recovery whose bound is EVIDENCE, not a counter:
// churn `review:please` only when NO review run exists for that head SHA. After a
// churn a run exists, so the same head can never be churned twice — no attempt
// counter, no marker comment, no state to keep or reset — and a run that FAILED is a
// run, so a live cap or an outage is reported rather than re-fired into.
//
// ── WHY "A RUN EXISTS" WAS THE WRONG QUESTION (RA-1594) ───────────────────────
// `agent-review.yml` subscribes to `pull_request_target: [labeled]` (`pull_request`
// until RA-2299; `head_sha` is the PR's head on both), and its job-level `if`
// admits any label event on a PR that CARRIES a review label. So on an
// `agent:implement` PR every label event manufactures a run for the head — the
// `agent:implement` and `review:please` adds at open, `needs:human` from the Merger,
// `agent:reviewer` from the Reviewer — and each concludes `skipped` or `success` having
// reviewed nothing.
//
// Measured on PR RA-1591, an implement PR with `"reviews": []`, head `b972df20`: FIVE
// `agent-review.yml` runs, zero reviews. Actors: the Implementer x3 (the open and its two
// labels), the Merger x1, the Reviewer x1. `runs.length === 5` meant the recovery took the note
// branch instead of the churn branch — and because a superseded `cancelled` run was
// among them it printed "Re-firing repeats it — read that run's classify annotation"
// about a head nothing had ever tried to review. The recovery RA-1408 shipped was inert
// on exactly the head the incidents it was built for sat on (PR RA-1503, PR RA-1057).
//
// Dropping `skipped` — the shape RA-1592 used for the revise lane — is NOT enough here,
// and that is the difference between the two lanes. There the workflow's `if` admits
// one label and every other event concludes `skipped`; here the `if` reads the label
// SET, so a `needs:human` add on an implement PR runs the filter, concludes `success`
// and looks identical to a real review that posted nothing.
//
// ── WHAT COUNTS AS AN ATTEMPT, AND WHY EACH RULE IS SAFE ────────────────────
// The classification below is entirely readable from the Actions listing, which is
// the only surface the Lead's `Actions: Read` grant reaches (agent-identities.md ⁷):
//
//   · a run the RECOVERY ITSELF started counts, whatever it concluded. This is the
//     only thing bounding the loop, and it must not depend on what the churn's run
//     went on to decide: a head whose push was docs-only, or whose commit carries
//     `[skip-review]`, gets a churn run that legitimately declines — and if a decline
//     did not count, that head would be churned every hour forever.
//
//     "STARTED BY THE RECOVERY" IS NOT "ACTORED BY THE LEAD" (RA-1714). The actor is the
//     App that applied a label, and the Lead applies `review:please` to its OWN brief
//     PR at creation (`agent-lead.yml`; `agent-identities.md` records it as the only
//     label that workflow applies). Keying on the actor alone therefore marked a brief
//     PR's initial head permanently "already attempted" — so the lane could never
//     churn it, which is the RA-1594 inertness shape narrowed to one actor class, and it
//     falsified this module's own claim to cover the Lead's PRs. PR RA-1659, the
//     motivating incident for RA-1689, is exactly such a PR.
//
//     WHAT SEPARATES THEM IS WHEN, and it is readable rather than a counter: the
//     recovery only churns once a head is older than the stall window, so the run it
//     starts is created at least that long after the head was pushed, while a label
//     applied at PR creation fires within seconds of it. `churnedAfter` is that
//     boundary. It is derived from the same two facts the caller already used to decide
//     the head was stalled, so it introduces no new state.
//   · an UNFINISHED run counts. That is the state a churn creates on the very next
//     hourly tick, and re-firing on top of a live run is the one thing RA-1408 forbids.
//   · a BROKEN run counts — `failure`, `timed_out`, `startup_failure`. A capped or
//     crashed run IS a run: its head is reported so a human reads the classify
//     annotation (RA-1503), never re-fired into the same cap.
//   · a CANCELLED run counts only if nothing newer OF THE SAME EVENT exists for the
//     head. Concurrency supersession is the ordinary way a label event dies here
//     (`cancel-in-progress` on `qa-review-<pr>-…`), and reporting a superseded casualty
//     as a crash sends a reader to an annotation that was never written — RA-1594's
//     constraint 2. The WORKFLOW-level group key includes the event, so a run of
//     another event cannot have displaced it there (RA-1717). The job-level
//     `qa-review-head-<pr>-<sha>` group is shared across events and can displace a
//     PENDING review job — which then reads as a real cancellation, i.e. over-counts.
//     That is the safe direction: the head is reported, not churned.
//   · a SKIPPED run counts for nothing: the job-level `if` declined the event.
//   · a SUCCESSFUL run BY ANYONE ELSE counts for nothing. It reached a decision and
//     posted no verdict — otherwise the caller would not be asking, since every
//     caller has already established the head carries no verdict — so the filter
//     declined this head. A decline is not an attempt to review it.
//
// ── THE `workflow_run` PATH, AND HOW IT BECAME VISIBLE (RA-1717) ──────────────
// A SHA-keyed listing cannot find a `workflow_run`-triggered review run, and that is
// the PRIMARY review path. Measured on PR RA-1712's own head `a4f4084` while it was
// under review: the run reviewing it carried `head_sha` = MAIN's SHA (`f4e4fca`),
// `head_branch: main`, an empty `pull_requests`, and `display_title: "Review
// (Reviewer)"`. Nothing on the run object tied it to the commit it reviewed — the PR is
// resolved inside the `filter` job, from the payload, after the run exists. So a head
// whose `workflow_run` review CRASHED read as "no attempt" and was churned once: the
// re-fire-into-a-cap RA-1408 exists to avoid. (12 `workflow_run` runs of this workflow
// concluded `failure` in the retained listing on 2026-09-24 — every one invisible.)
//
// THE RUN NOW RECORDS WHAT TRIGGERED IT, AT CREATION. `agent-review.yml`'s `run-name`
// stamps the triggering head SHA into the run's title — `workflow_run.head_sha` is the
// CI run's head, i.e. the PR head — and `run-name` is evaluated when the run is
// CREATED, before any job starts. So the title exists on a run that was capped, hit an
// outage or crashed in its first step, which is the only kind this bound was ever
// wrong about: a signal written late would be no signal at all. Verified on real
// `workflow_run` runs before relying on it (apache/kafka's `ci-complete.yml` sets
// `run-name` from `github.event.workflow_run.*`, and its runs' `display_title` carry
// the rendered value).
//
// `reviewRunsFor` therefore makes a SECOND read: this workflow's `workflow_run` runs
// created since the head was pushed, paginated, kept only when the title NAMES the
// SHA. Against RA-1717's three constraints —
//   1. NOT WIDENED TO EVERY RUN. The title match is exact, per SHA — evidence, not a
//      time correlation. The `created` floor only bounds the cost of the read; an
//      early floor costs a page, never a false match.
//   2. THE LOOP BOUND IS UNTOUCHED. The churn's own run is a `pull_request_target:
//      labeled` event, still recorded against the PR head, still found by the first
//      read. And a `workflow_run` run is never counted as the recovery's own, whoever
//      pushed the commit behind it (`reviewAttempts`).
//   3. `Actions: Read` ONLY. It is a list read; nothing is written anywhere.
//
// Do NOT "fix" a miss here by dropping the title match: every `workflow_run` run of
// this workflow sits on the default branch's SHA, so a head would inherit every other
// PR's review runs and the recovery would go permanently inert — RA-1594 again, worse.
//
// Exported as a pure function over the listing so the classification is testable
// without Actions; `runsFor` is the only part that needs a token.

import { appLogin } from './app-register.mjs';

/** One identity, three spellings across three endpoints. Normalise, never match a list. */
export const normaliseLogin = (login) =>
  String(login ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '');

/** The workflow whose runs are the evidence, keyed by FILE rather than by display
 *  name: a workflow can be renamed, and `name:` is not what identifies it. It is also
 *  what the REST endpoint below addresses, so there is nothing to keep in step. */
export const REVIEW_WORKFLOW_FILE = 'agent-review.yml';

/** The App whose label churn IS the recovery, so that its runs are the loop bound —
 *  the register's `Lead` (RA-2701). */
export const RECOVERY_LOGIN = appLogin('Lead');

/** Conclusions that mean the run tried and broke — re-firing repeats it. */
export const BROKEN = ['failure', 'timed_out', 'startup_failure'];

/**
 * Did this run start at or after `since`? (RA-1690)
 *
 * THE PRIMITIVE BOTH LANES NEED, WITH DIFFERENT FLOORS. `reviewAttempts` already
 * applies a floor to the recovery actor via `churnedAfter`; the revise lanes apply one
 * to every run, because their trigger is the REVIEW and a run that began before the
 * review existed cannot have delivered it. Same question, different clock — so the
 * comparison lives here once rather than being written a third time.
 *
 * This module's header argues the two lanes differ, and they do: dropping `skipped` is
 * not enough for EITHER, but for different reasons. There the workflow's `if` reads the
 * label SET, so foreign label events conclude `success`. In the revise lanes the `if`
 * admits one marker and everything else concludes `skipped` — except the runs the
 * workflow's own `concurrency` group CANCELS, which is what parked PR RA-1660 for two
 * days on a run that started ten minutes before the review it was counted as
 * delivering.
 *
 * UNKNOWN ON EITHER SIDE COUNTS THE RUN, so an unreadable clock suppresses a churn
 * rather than causing one — the same fail-closed direction as an unreadable listing,
 * and the same direction `reviewAttempts` takes for an unparseable `churnedAfter`.
 */
export function startedAfter(run, since) {
  const floor = Date.parse(since ?? '');
  const started = Date.parse(run?.createdAt ?? '');
  if (Number.isNaN(floor) || Number.isNaN(started)) return true;
  return started >= floor;
}

/** One run from the REST listing, in the shape every consumer reads. */
const normaliseRun = (r) => ({
  id: r.id,
  actor: normaliseLogin(r.actor?.login ?? r.triggering_actor?.login),
  event: r.event,
  status: r.status,
  conclusion: r.conclusion,
  createdAt: r.created_at,
});

/**
 * Does this run's title name `sha` as the head it was created for? (RA-1717)
 *
 * The LAST whitespace-separated token of `display_title`, compared EXACTLY against the
 * full SHA — `agent-review.yml`'s `run-name` puts it there. Exact rather than a prefix
 * or a substring so a short SHA, a PR number (the `workflow_dispatch` spelling) or a
 * title that merely mentions a commit can never match.
 */
export function titleNamesSha(title, sha) {
  if (!sha) return false;
  const last = String(title ?? '').trim().split(/\s+/).at(-1);
  return last === sha;
}

/** How far before the head's commit time the title read starts (RA-1717). A commit's
 *  date comes from the pusher's clock, and a floor that is LATE drops exactly the run
 *  being looked for, while one that is early costs part of a page (~50 `workflow_run`
 *  runs a day, measured 2026-09-24). So the margin is generous and one-sided. */
export const TITLE_FLOOR_MARGIN_MS = 24 * 3600_000;

/** The ceiling GitHub puts on a FILTERED run listing (`created`, `event`, …): 1,000
 *  results, i.e. ten pages of 100. Reading past it returns nothing, so a window with
 *  more runs than this cannot be read completely — which `titledRunsFor` reports as
 *  unreadable rather than as complete. */
export const TITLE_READ_MAX_PAGES = 10;

/**
 * Where the title read starts: `since` (the head's push time, when the caller has it)
 * or the commit's own committer date, minus the margin above. Throws when neither is
 * readable — the caller turns that into `null`, i.e. unreadable, never "none".
 */
function titleFloor(sha, { repo, json, since }) {
  let t = Date.parse(since ?? '');
  if (Number.isNaN(t)) {
    const commit = json(['api', `repos/${repo}/commits/${sha}`]);
    t = Date.parse(commit?.commit?.committer?.date ?? '');
  }
  if (Number.isNaN(t)) throw new Error(`no readable push time for ${sha}`);
  return new Date(t - TITLE_FLOOR_MARGIN_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The `workflow_run`-triggered runs of this workflow whose title names `sha` (RA-1717).
 * Throws when the window cannot be read completely.
 */
function titledRunsFor(sha, { repo, json, since }) {
  const floor = titleFloor(sha, { repo, json, since });
  const found = [];
  for (let page = 1; ; page++) {
    const res = json(['api',
      `repos/${repo}/actions/workflows/${REVIEW_WORKFLOW_FILE}/runs?event=workflow_run`
      + `&created=${encodeURIComponent(`>=${floor}`)}&per_page=100&page=${page}`]);
    const runs = res?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error('unreadable workflow_run listing');
    found.push(...runs.filter((r) => titleNamesSha(r.display_title, sha)));
    const total = Number(res?.total_count);
    if (runs.length < 100 || (Number.isFinite(total) && page * 100 >= total)) break;
    // INCOMPLETE IS UNREADABLE, not "none past this point". The runs past the ceiling
    // are the OLDEST in the window, and a head parked that long is exactly the one
    // whose crashed review would be missed.
    if (page >= TITLE_READ_MAX_PAGES) throw new Error(`more than ${TITLE_READ_MAX_PAGES * 100} runs since ${floor}`);
  }
  return found;
}

/**
 * Every `agent-review.yml` run for a head SHA, normalised — or `null` if the listing
 * could not be read.
 *
 * `null` means UNREADABLE, which is not the same as none, and the difference decides
 * whether anything is churned. Failing to read Actions must never manufacture a "no
 * run ever fired" and re-fire a review on top of one that is already running.
 *
 * TWO READS, MERGED BY RUN ID (RA-1717). The SHA-keyed read finds every run recorded
 * against the PR head — `pull_request_target` label events, the churn's own run among
 * them, which is the loop bound. The title read finds the `workflow_run` runs, which
 * are recorded against the default branch and are visible only because `run-name`
 * stamps the head into their title; the header above has the argument. EITHER read
 * failing makes the whole answer `null`: a listing missing the `workflow_run` half is
 * the under-count RA-1717 exists to remove, and an under-count means a churn.
 *
 * `since` is optional and backward-compatible: the head's push time, when the caller
 * already holds it (both recoveries do — it is their stall clock). Absent, the floor
 * is read from the commit itself, one extra call.
 *
 * THE REST ENDPOINT, NOT `gh run list`, and the reason is one field: `gh run list
 * --json` has no `actor`, and the actor is what separates a run this recovery started
 * from the label noise every implement PR manufactures.
 *
 * BOTH SERVER-SIDE FILTERS, not just the SHA. The repo-wide `actions/runs?head_sha=`
 * form makes this workflow's runs compete for 100 unpaginated slots with every other
 * workflow on that head (26 on the busiest head measured), and the direction of that
 * loss is the forbidden one: under-counted attempts mean a churn into a live or broken
 * run. The per-workflow path filters server-side AND still returns `actor`.
 *
 * `?head_sha=` matters for the same reason `--commit` did: `--limit N` is a time window
 * in disguise — the 80 most recent runs of this workflow covered 6.1 hours, against a
 * 4-hour stall gate with no upper bound on how long a PR stays unreviewed — so a
 * windowed read would list a long-parked head as zero runs and churn it. The title
 * read is windowed too, but by the head's OWN push time, so it covers the head's whole
 * life however long it has been parked, and says so when it cannot.
 *
 * @param {string} sha
 * @param {{repo: string, json: (args: string[]) => any, since?: string|null}} io
 * @returns {any[] | null} — `any`, as before RA-1717: callers and their fixtures inject
 *   partial runs, and the classification tolerates every missing field.
 */
export function reviewRunsFor(sha, { repo, json, since = null }) {
  try {
    const res = json(['api',
      `repos/${repo}/actions/workflows/${REVIEW_WORKFLOW_FILE}/runs?head_sha=${sha}&per_page=100`]);
    const bySha = (res?.workflow_runs ?? []).filter((r) => r.head_sha === sha);
    const byTitle = titledRunsFor(sha, { repo, json, since });
    const seen = new Set();
    return [...bySha, ...byTitle]
      .filter((r) => !seen.has(r.id) && seen.add(r.id))
      .map(normaliseRun);
  } catch {
    return null;
  }
}

/**
 * The subset of those runs that is evidence a review of this head was attempted or is
 * under way. An empty result is what licenses a churn.
 *
 * @param {{id: number, actor: string, event?: string, status: string, conclusion: string|null, createdAt: string}[] | null | undefined} runs
 * @param {{recovery?: string, churnedAfter?: number|string|null}} [opts]
 */
export function reviewAttempts(runs, { recovery = RECOVERY_LOGIN, churnedAfter = null } = {}) {
  const list = runs ?? [];
  const floor = churnedAfter == null ? null : new Date(churnedAfter).getTime();
  // A run by the recovery identity is only THIS recovery's when it was started after
  // the head could first have been churned. An unusable `churnedAfter` (absent, or an
  // unparseable date) falls back to trusting the actor — the pre-RA-1714 behaviour, which
  // over-counts and therefore never churns twice.
  //
  // AND NEVER A `workflow_run` RUN (RA-1717). The recovery churns a LABEL; a run fired by
  // CI's completion carries the actor who pushed the commit, which is the Lead on his
  // own brief PRs — so a late CI re-run there would otherwise pass as the churn's own
  // run and count whatever it concluded, a decline included.
  const startedByRecovery = (r) =>
    r.event !== 'workflow_run'
    && normaliseLogin(r.actor) === recovery
    && (floor == null || Number.isNaN(floor) || new Date(r.createdAt ?? 0).getTime() >= floor);
  // Newest first — the order `whyNoChurn` reads. `created_at` is the only ordering
  // the listing gives.
  const byAge = [...list].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  // SUPERSEDED WITHIN ITS OWN EVENT (RA-1717). The workflow-level concurrency group is
  // keyed on the event, so there a label event cannot cancel a `workflow_run` review.
  // (The job-level group can still displace a PENDING job across events — see the
  // header — which over-counts, suppressing a churn rather than causing one.) Before
  // the title read made `workflow_run` runs visible the question never arose, because
  // every run in the list was a label event. Now it does: a `workflow_run` review cancelled mid-work is always followed by some label
  // run on its head, and "anything newer" would read that as supersession and hide a
  // real cancellation. An unknown event on either side falls back to "anything newer".
  const newerSameEvent = (r) => byAge.some((o) => o !== r
    && (o.event == null || r.event == null || o.event === r.event)
    && (String(o.createdAt ?? '').localeCompare(String(r.createdAt ?? '')) > 0
      || (o.createdAt === r.createdAt && Number(o.id) > Number(r.id))));
  return byAge.filter((r) => {
    if (startedByRecovery(r)) return true;
    if (r.conclusion === 'skipped') return false;
    if (!r.conclusion) return true;
    if (BROKEN.includes(r.conclusion)) return true;
    // Superseded by a later event on the same head — the ordinary death of a label
    // event here, and not a crash to send anyone reading annotations for.
    if (r.conclusion === 'cancelled') return !newerSameEvent(r);
    return false;
  });
}

/**
 * What a human should read instead of a churn, given the attempts that blocked it.
 *
 * NAMED, NOT COUNTED: the reasons want different responses and two of them want none.
 *
 * @param {ReturnType<typeof reviewAttempts>} attempts
 */
export function whyNoChurn(attempts) {
  // BROKEN FIRST (RA-1523 review round 3). A re-run leaves a failure AND an unfinished
  // run on one head; the failure is the actionable one and must be the one named.
  // A `cancelled` run that reached `attempts` at all is the NEWEST of its event for its
  // head, so it was not superseded — it really was cancelled, and that is a break.
  const broken = attempts.find((r) => BROKEN.includes(r.conclusion) || r.conclusion === 'cancelled');
  const unfinished = attempts.find((r) => !r.conclusion);
  // THE ONLY REMAINING WAY TO BE HERE, and saying so is what keeps the arm from
  // reading as a catch-all. A finished, unbroken run is an attempt ONLY when this
  // recovery started it — every other actor's finished-and-unbroken run is a filter
  // decline, which `reviewAttempts` drops. So there is no fourth outcome to write.
  const latest = broken ?? unfinished ?? attempts[0];
  const outcome = broken ? 'broken' : unfinished ? 'pending' : 'churned';
  return `${attempts.length} review run(s) already stand for this head and none posted a verdict `
    + `(latest: ${latest?.status ?? '?'}/${latest?.conclusion ?? '-'}, run ${latest?.id ?? '?'}, started by ${latest?.actor || '?'}). `
    + {
      pending:
        'It has NOT finished — nothing is wrong yet and nothing needs doing. This head will '
        + 'be reported again next tick if the run ends without posting a verdict',
      broken:
        'Re-firing repeats it — read that run\'s classify annotation for cap vs outage vs crash (RA-1503)',
      churned:
        'This head has ALREADY been recovered once and the re-fire finished without posting a verdict. '
        + 'That is the bound working, not a second failure to fix. The run did not fail, so it carries no '
        + 'classify annotation — read its `filter` job\'s evidence lines (`CI_STATE`, `FILES`, '
        + '`GUARDED_DOCS`, `NONDOCS`, `LAST_REVIEWED`) for which arm declined this head, rather than '
        + 'churning again (RA-1408)',
    }[outcome];
}
