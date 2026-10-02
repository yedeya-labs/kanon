// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — which revise runs for a head SHA DELIVERED its changes-request (RA-1724).
//
// Both revise recoveries — `reviseRecovery` in `lead-reconcile.mjs` (the implementer,
// `agent-implement-revise.yml`) and `brief-revise-recovery.mjs` (the Lead's briefs,
// `agent-lead-revise.yml`) — rest on one bound: churn the marker label only when NO run
// of that workflow delivered the changes-request standing on the head. After a churn a
// run exists, so a head cannot be churned twice; a run that broke IS a run, so a cap or
// an outage is reported rather than repeated. This module is the one definition of
// "delivered", so the two lanes cannot drift apart on it.
//
// It is the revise lanes' own, deliberately NOT `review-run-evidence.mjs`: that module's
// `reviewAttempts` answers a different question over a different workflow ("was a
// REVIEW attempted"), and its rules differ from these for reasons its header gives.
// `startedAfter` is the one primitive both genuinely share, and it is imported.
//
// ── WHAT IS NOT A DELIVERY ──────────────────────────────────────────────────
//
//   · a SKIPPED run (RA-1592). Both workflows subscribe to `pull_request: [labeled]` and
//     gate every label but their own marker at the JOB level, which concludes `skipped`.
//   · a run that STARTED BEFORE the review (RA-1690). A delivery of a changes-request
//     cannot begin before it exists — PR RA-1660 parked two days on one that did.
//   · a CANCELLED LABEL-EVENT run a NEWER run on the same head superseded (RA-1724,
//     narrowed to label events by RA-2301).
//
// ── WHY THE THIRD RULE, MEASURED ────────────────────────────────────────────
// RA-1690 kept every `cancelled` run that started after the review, on the grounds that
// "a cap or an outage IS a delivery attempt". True of a cap; not of a run the workflow's
// OWN `concurrency` group displaced. `cancel-in-progress: false` never kills a RUNNING
// run, but a group holds one PENDING run, and a third event displaces it.
//
// That is the ordinary shape of every first review, not an edge. Measured 2026-09-24
// over every `cancelled` run the Actions API still lists: 15 of 52 for
// `agent-implement-revise.yml` and 1 of 35 for `agent-lead-revise.yml` started AFTER a
// changes-request on their head. Every one follows the same three events, seconds apart
// — PR RA-2267 head `6b48ca6`: the Reviewer's review (run 35848261456, `success`) → his
// `agent:reviewer` label (run 35848263198, pending behind it) → the Merger's `needs:human`
// label 20 s later (run 35848293949, `skipped`), which displaced the pending one to
// `cancelled`. The cancelled run is a label event the job gate would have SKIPPED. It
// delivered nothing, could never have, and — because `cancelled` sorts first in both
// lanes' `broken` pick — it was the run a parked head's note named, with "Re-firing
// repeats it — read that run's classify annotation": RA-1690's inverted advice, with the
// clock now on the right side of the review.
//
// SUPERSEDED MEANS A NEWER RUN OF ANY CONCLUSION, skipped included — which is why this
// reads the RAW listing rather than one already filtered to non-skipped. In every
// measured case the displacing run is a `skipped` label event; filter skips out first
// and the casualty looks like the newest run, i.e. like a genuine cancellation.
// `reviewAttempts` makes the identical call for the review lane.
//
// ── ONLY A LABEL EVENT CAN BE A DISPLACED CASUALTY (RA-2301) ──────────────────
// "Superseded" was first written as "a strictly newer run exists on the head", and
// newness is not displacement. The run that genuinely DELIVERS a changes-request is the
// `pull_request_review` run, created seconds after the review — and it is ALWAYS
// followed within seconds by label-event runs on the same head (the RA-2267 burst above:
// review run at T+3 s, `agent:reviewer` at T+4 s, `needs:human` at T+24 s). So if THAT
// run was cancelled mid-work — by a person, or by a job ceiling reported as
// `cancelled` — "anything newer" dropped it as superseded, and after the stall window
// both lanes churned the marker and re-fired an Opus run the operator had stopped.
//
// The run's `event` separates the two. Measured 2026-09-24 over every `cancelled` run
// the Actions API still lists: all 45 of `agent-implement-revise.yml`'s and all 32 of
// `agent-lead-revise.yml`'s are `pull_request` (label) events — the displacement burst,
// and nothing else. So only a cancelled `pull_request` run is ever read as superseded;
// a cancelled `pull_request_review` or `workflow_dispatch` run is a delivery that was
// stopped, and reads as broken ("re-firing repeats it").
//
// A listing WITHOUT `event` keeps the pre-RA-2301 rule, "anything newer": a caller that
// has not asked for the field must not lose RA-1724's fix by omission. So RA-2301 applies
// to a lane only once its reader names `event` in its `--json` list; one that forgets
// fails the way it used to rather than a new way.
//
// What this still reads as displaced: a `pull_request` run a person cancelled mid-work
// on a head with newer label events. That is the MARKER's own run, and the marker is
// what a churn re-applies — so the worst case is the one extra re-fire RA-1724 already
// bounds, never a loop, because the churn's run counts whatever it concludes. The
// residue on the other side: a `pull_request_review` run displaced while still PENDING
// (only possible if another run already holds the PR's group) now counts as a delivery,
// which suppresses a churn rather than causing one.
//
// A cancelled run that is the NEWEST on its head still counts whatever its event:
// nothing displaced it, so somebody or something stopped it, and that is what
// "re-firing repeats it" is for.
//
// ── THE BOUND DOES NOT MOVE ─────────────────────────────────────────────────
// The one property RA-1524, RA-1592 and RA-1690 all protect, and the reason RA-1724 names the
// naive version of this fix ("cancelled runs do not count") as wrong: after a churn a
// run must exist, or the same head is re-churned every hour forever. So a run the
// CHURN started counts whatever it concluded, superseded or not.
//
// Which runs the churn started is readable without an actor (`gh run list --json` has
// none) and without state, by the rule `reviewAttempts` adopted in RA-1714: WHEN. Both
// recoveries churn only once the changes-request is older than the stall window, so a
// churn's run is created at least that long after the review, while the displacement
// burst above lands within seconds of it. The caller passes that boundary as
// `churnedAfter`; a cancelled run at or after it always counts.
//
// FAILS CLOSED. An unknown `churnedAfter` treats every post-review run as possibly the
// churn's own — the pre-RA-1724 behaviour, which suppresses a churn rather than causing
// one. So does a cancelled run whose own clock is unreadable: supersession has to be
// PROVEN by a strictly newer run, never inferred from missing data.

import { startedAfter } from './review-run-evidence.mjs';

export { startedAfter };

/**
 * Ordered newest-last by (createdAt, databaseId). The id breaks a tie inside one
 * second, which the displacement burst produces (PR RA-2007: a `pull_request_review` run
 * and the label run it outlived share `18:25:38`); ids are allocated in order.
 *
 * @returns {number} >0 when `a` is newer than `b`, NaN when either clock is unreadable.
 */
function newerThan(a, b) {
  const ta = Date.parse(a?.createdAt ?? '');
  const tb = Date.parse(b?.createdAt ?? '');
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.NaN;
  if (ta !== tb) return ta - tb;
  return Number(a?.databaseId ?? 0) - Number(b?.databaseId ?? 0);
}

/**
 * The runs of a revise workflow for `sha` that DELIVERED the changes-request submitted
 * at `since`. An empty result is what licenses a churn.
 *
 * @param {{headSha?: string, event?: string, conclusion?: string|null, createdAt?: string, databaseId?: number}[]} runs
 *   the RAW `gh run list --json headSha,event,status,conclusion,databaseId,createdAt`
 *   listing — skipped runs included, because a skipped run is what supersedes a
 *   displaced one. `event` is what limits supersession to label events (RA-2301); a
 *   listing without it falls back to the pre-RA-2301 rule.
 * @param {{sha: string, since?: string|null, churnedAfter?: string|null}} opts
 */
export function reviseDeliveries(runs, { sha, since, churnedAfter = null } = /** @type {any} */ ({})) {
  const onHead = (runs ?? []).filter((r) => r?.headSha === sha);
  const churnFloor = Date.parse(churnedAfter ?? '');
  const startedByChurn = (r) => {
    // Unknown boundary: every run might be the churn's, so every run is kept.
    if (Number.isNaN(churnFloor)) return true;
    const t = Date.parse(r?.createdAt ?? '');
    return Number.isNaN(t) || t >= churnFloor;
  };
  // Only a LABEL event is ever displaced by the burst (RA-2301). Unknown event: the
  // pre-RA-2301 rule, so a listing that omits the field loses nothing it had.
  const displaceable = (r) => r.event == null || r.event === 'pull_request';
  const superseded = (r) => displaceable(r) && onHead.some((o) => o !== r && newerThan(o, r) > 0);
  return onHead.filter((r) => {
    if (r.conclusion === 'skipped') return false;
    if (!startedAfter(r, since)) return false;
    if (r.conclusion === 'cancelled' && superseded(r) && !startedByChurn(r)) return false;
    return true;
  });
}

/**
 * The boundary a churn's own run is created after: the changes-request's timestamp plus
 * the stall window both recoveries gate on. `null` when the review is undated, which
 * `reviseDeliveries` reads as "unknown" and fails closed on.
 *
 * @param {string|null|undefined} submittedAt
 * @param {number} hours
 */
export function churnBoundary(submittedAt, hours) {
  const t = Date.parse(submittedAt ?? '');
  if (Number.isNaN(t) || !Number.isFinite(hours)) return null;
  return new Date(t + hours * 3600_000).toISOString();
}
