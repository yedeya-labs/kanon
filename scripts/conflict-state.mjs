// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — is this PR conflicting, and did the caller actually ask? (RA-1722)
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
// GitHub cannot build `refs/pull/<n>/merge` for a conflicting PR, and every
// `pull_request`-triggered workflow is dispatched against that ref. So a conflicting
// PR runs no `pull_request` workflow: not `ci.yml`, not `red-test.yml`, not
// `label-guard.yml`, and not the `pull_request: [labeled]` re-delivery paths of the
// revise lanes (`agent-implement-revise.yml` RA-1524, `agent-lead-revise.yml` RA-1595).
//
// REVIEW IS THE EXCEPTION SINCE RA-2299, AND IT DOES NOT CHANGE THE ANSWER (RA-2302).
// `agent-review.yml`'s label trigger (RA-1408/RA-1689) is now `pull_request_target`, which
// GitHub documents as firing on a conflicting PR — so a `review:please` churn there
// DOES start a run. It still cannot move the PR: with no CI on the head `filter`
// defers to a CI completion that never comes, and a verdict on a head whose CI did
// finish before the conflict is one the conflict resolution's push dismisses
// (`dismiss_stale_reviews_on_push`). The CI-driven review (`workflow_run` after CI)
// stays unreachable. So the lanes still refuse the churn; only the reason changed.
//
// The remedy and the failure mode are therefore the same mechanism. Measured on PR
// RA-1708: the reconciler applied the documented remedy — a label churn — 25 times over
// 36 hours and not one of them produced a workflow run. `main` had taken a commit
// touching the same file three hours after the PR's last run, and nothing in the
// pipeline reads mergeability, so every lane went on describing a hard-stopped PR as
// one whose review was merely late.
//
// ── WHAT THIS MODULE IS FOR ─────────────────────────────────────────────────
// One definition of "conflicting", shared by every reader of that fact so that none of
// them can disagree about it. NOT A COUNT: this said "the three churn lanes and the
// digest ... the four of them" and was wrong twice within a fortnight — RA-2154 added
// `merge-gate.mjs` and RA-2150 added `rebase-lane.mjs`. `grep -rln "conflict-state.mjs'"`
// is the enumeration; a number here rots the moment a reader is added (RA-2184).
//
// It decides nothing about resolving a conflict — `agent-rebase.yml` does that (RA-2150),
// and this module only says which PRs are in that state. This is the
// detector: refuse the churn that cannot work, and say so in the words that send a
// reader to the right remedy.
//
// ── FOUR STATES, NOT A BOOLEAN, AND `unread` IS THE POINT ───────────────────
// A boolean makes "GitHub has not computed it yet" and "this caller never asked"
// indistinguishable from "clear", and both would silently disable the detector on
// every PR. That is the `silent-absence` class (RA-946) applied to the guard itself, and
// this repo has produced it often enough to pay for a discriminated answer:
//
//   · `conflicting` — a churn cannot reach this PR. Refuse it and report the rebase.
//   · `clear`       — proceed; the lane's own rules decide.
//   · `computing`   — GitHub is still working it out. PROCEED, exactly as before this
//                     module existed: a churn against a PR that turns out to be clean
//                     is the ordinary path, and one against a conflicting PR costs a
//                     no-op event. Refusing here would park a healthy PR on a value
//                     that resolves seconds later, which is the direction
//                     `merge-gate.mjs` already rejected for `UNKNOWN` (it waits rather
//                     than escalating).
//   · `unread`      — neither field is present, so the CALLER's read did not request
//                     them. This is a code defect, not a fact about the PR, and it
//                     affects every PR in the lane equally — so it THROWS. A detector
//                     that quietly answers "clear" because someone trimmed a `--json`
//                     list is worse than no detector, and the fixtures that would have
//                     to declare mergeability are the same fixtures `merge-gate.mjs`'s
//                     header warns about defaulting into a state the scenario cannot
//                     produce.
//
// ── TWO SPELLINGS, BECAUSE TWO APIS ─────────────────────────────────────────
// `gh pr view --json` is GraphQL: `mergeable: CONFLICTING|MERGEABLE|UNKNOWN` and
// `mergeStateStatus: DIRTY|CLEAN|BLOCKED|BEHIND|UNSTABLE|DRAFT|HAS_HOOKS|UNKNOWN`.
// The REST pull object — which is what `scripts/project-digest.mjs` can reach
// without GraphQL — is `mergeable: true|false|null` and `mergeable_state: "dirty"`,
// lowercased. Normalising in one place is the whole reason the digest can share this.

/**
 * The failure of a CALLER, not of GitHub — thrown when a PR object carries no
 * mergeability at all.
 *
 * ITS OWN CLASS SO THE CATCHES CANNOT EAT IT. Every lane that reads a PR wraps the
 * read in a `try` that degrades to "could not read this PR" — the right behaviour for
 * a 502 or a deleted branch, and exactly the wrong one here: a trimmed `--json` list
 * would be reported hourly as a transient read failure, on a warning line that already
 * exists for another reason, while the conflict detector silently answered "clear" for
 * every PR. So each of those catches re-throws this one, and only this one. A code
 * defect reds the tick; a bad day degrades.
 */
export class ConflictFieldsUnread extends Error {}

/** The `gh pr view --json` fields every lane that asks this question must request. */
export const CONFLICT_FIELDS = ['mergeable', 'mergeStateStatus'];

/** Ready to interpolate into a `--json` argument. */
export const CONFLICT_JSON = CONFLICT_FIELDS.join(',');

/** The merge-state value that means "git could not merge this". Both APIs agree on
 *  the word; only the case differs. */
const DIRTY = 'DIRTY';

/** One field's opinion: `yes` (conflicting), `no`, or `unknown`. */
function opinionOfState(raw) {
  if (raw == null) return null;
  const s = String(raw).toUpperCase();
  if (s === DIRTY) return 'yes';
  if (s === 'UNKNOWN' || s === '') return 'unknown';
  return 'no';
}

function opinionOfMergeable(raw) {
  if (raw == null) return null;
  if (raw === true) return 'no';
  if (raw === false) return 'yes';
  const s = String(raw).toUpperCase();
  if (s === 'CONFLICTING') return 'yes';
  if (s === 'MERGEABLE') return 'no';
  if (s === 'UNKNOWN' || s === '') return 'unknown';
  return 'unknown';
}

/**
 * What a PR object says about whether a `pull_request` event can reach it.
 *
 * ANY POSITIVE "CONFLICTING" WINS. The two fields come from one computation, so a
 * disagreement means one of them is stale rather than that the truth is in between —
 * and of the two directions, believing the conflict costs a suppressed churn that the
 * next hourly tick retries, while disbelieving it costs the 25 no-op churns this
 * module exists to stop.
 *
 * @param {Record<string, unknown>} pr a PR as `gh pr view --json mergeable,mergeStateStatus`
 *   returns it, or as the REST pull object spells it (`mergeable_state`)
 * @returns {'conflicting'|'clear'|'computing'|'unread'}
 */
export function conflictState(pr) {
  const o = pr ?? {};
  const hasState = 'mergeStateStatus' in o || 'mergeable_state' in o;
  const hasMergeable = 'mergeable' in o;
  if (!hasState && !hasMergeable) {
    throw new ConflictFieldsUnread(
      'conflictState: this PR object carries neither `mergeStateStatus`/`mergeable_state` nor '
      + '`mergeable`, so the read that produced it did not ask whether the PR conflicts. '
      + 'Add `conflict-state.mjs`\'s CONFLICT_JSON to that read — answering "clear" here would '
      + 'silently disable every conflict check in the pipeline (RA-1722).');
  }
  const opinions = [
    opinionOfState(hasState ? (o.mergeStateStatus ?? o.mergeable_state) : null),
    opinionOfMergeable(hasMergeable ? o.mergeable : null),
  ].filter((x) => x !== null);
  if (opinions.includes('yes')) return 'conflicting';
  if (opinions.includes('no')) return 'clear';
  return 'computing';
}

/** Does this state stop a label churn from reaching the PR? */
export const blocksChurn = (state) => state === 'conflicting';

/**
 * The one sentence every lane prints about a conflicting PR.
 *
 * SAME WORDS EVERYWHERE, deliberately. A reader who has seen it once on the tick
 * summary should recognise it on the digest and in the standalone lane's report, and
 * the thing it has to get across is not "conflict" — GitHub's own UI says that — but
 * that NO pipeline lane can act, which is the part that is invisible.
 *
 * IT NAMES THE REMEDY AND NOT THE ACTOR, deliberately (RA-2150). An earlier draft of this
 * named the lane that would perform the update, and had to be reverted when that lane
 * turned out not to work — a sentence promising an actor is false twice over while the
 * actor is in flight, and it is on five surfaces. "Needs its base merged in" is true
 * whoever does it, so the lane that eventually does can land without editing this.
 *
 * `merge-gate.mjs` interpolates it verbatim rather than restating it (RA-2154).
 */
export const CONFLICT_WHY =
  'this PR CONFLICTS with its base, so GitHub builds no merge ref and dispatches no '
  + '`pull_request` events — CI and revise are `pull_request`-triggered and cannot start, '
  + 'and a review a label churn can still start would judge a head the conflict fix must '
  + 'replace. Nothing was churned: it needs its base merged in before any lane can move '
  + 'it (RA-1722)';

/** The same fact in a few words, for a surface that cannot carry the sentence — the
 *  Slack digest's one-line member row. Shared rather than re-worded there, which is
 *  RA-2154's invariant applied to the RENDERING as well as to the predicate. */
export const CONFLICT_SHORT = 'needs its base merged in';
