// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — what a review event says about the commit it actually read (RA-1680).
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// GitHub sets a review's `commit_id` to whatever the PR head was AT SUBMISSION TIME,
// and `gh pr review` cannot pin it. A reviewer run reads a diff at the start and
// posts minutes later, so a push landing inside that window silently re-attributes
// the verdict to a commit the run never saw. Measured on PR RA-1672: an `APPROVED`
// whose `commit_id` is `add9508` opens with "First review on this PR (single commit
// `effc0c9`)", reports a check as failing that is green on `add9508`, and asserts a
// CI set that had not finished there.
//
// AND ON THE PR THAT FIXES IT, which is the cleanest instance recorded. PR RA-1712 review
// `5133992359`, `2026-09-07T16:30:04Z`, `commit_id = 75b2bba`. Its body opens "Re-review
// of head `0fd8ed49`" and enumerates THAT commit's diff —
// `75b2bba` was pushed at 16:27:48, two minutes into the run. Its "all required checks
// green" line is stale on the same axis: CI for `75b2bba` was created at 16:27:55 and was
// still `in_progress` when the approval posted. So a merge gate reading `commit_id` alone
// had, at that moment, an APPROVED sitting on a commit no reviewer had opened and no CI
// had finished. With the stamp, that review reads `sha=0fd8ed4` and `merge-gate` answers
// `review-misattributed` instead of merging.
//
// Two mechanisms read `commit_id` as "this review is evidence about THIS commit", and
// a mis-attributed verdict satisfies both: `merge-gate.mjs`'s `r.sha === pr.headSha`
// filter — which ends in an unattended MERGE — and `agent-review.yml`'s RA-1351
// reconcile step, whose whole job is to prove the head commit was reviewed. That is
// RA-964's shape (merged on an approval belonging to an earlier commit) reached by a
// different route.
//
// ── THE FIX IS EVIDENCE THE RUN WRITES ABOUT ITSELF ─────────────────────────
// The reviewer job knows exactly which SHA it checked out — `actions/checkout` was
// given `needs.filter.outputs.head_sha` — so after the agent posts, the WORKFLOW
// stamps that SHA into the review body. Consumers then read the stamp in preference
// to `commit_id`, and a verdict formed against an earlier commit stops looking like
// evidence about the head.
//
// STAMPED BY THE WORKFLOW, NOT BY THE AGENT, deliberately. The Reviewer already names the
// SHA in his prose (that is how RA-1680 was found), but prose is a claim and its format
// is his to change; the checked-out ref is a fact the job holds. It also keeps the
// reviewer prompt — and therefore the `config_fingerprint` every cost comparison keys
// on (RA-1485) — untouched.
//
// ── AND WHAT IT SUPERSEDES ──────────────────────────────────────────────────
// The same trailer carries the review ids this verdict deliberately replaces (RA-1334).
// Two the Reviewer verdicts can legitimately sit on ONE SHA: RA-1351's human-relabel arm
// re-reviews an unchanged commit when the remedy was a PR-BODY edit, and there
// `request-changes` -> `approve` is the pipeline working. They can also sit there
// ILLEGITIMATELY — two concurrent runs that never saw each other, which is what
// PR RA-1324 collected three of on one SHA, each with different findings, the verdict
// decided by submission ordering.
//
// TWO MECHANISMS PRODUCE THE ILLEGITIMATE KIND, and the trailer answers both with a
// different field, which is why it carries both:
//
//   · TWO RUNS. Measured on PR RA-1708 head `76a6a18`: six `agent-review` runs
//     dispatched within four seconds, two surviving the concurrency group because they
//     had different ACTORS (the Implementer's labels at creation, then the Merger's `needs:human`),
//     and between them three review events. `supersedes` is what a deliberate
//     re-review can claim and a blind sibling cannot.
//   · ONE RUN CORRECTING ITSELF, which he does explicitly — "Correcting myself first.
//     I approved this at 14:57 on what I believed was the head" (PR RA-1652). No
//     concurrency key can reach that, and it is not a contradiction at all: `run`
//     records who posted, so a consumer can see one author changing its mind.
//
// An out-of-band session — a reviewer driven by hand rather than by this workflow —
// posts no trailer at all, so a contradicting verdict from one stays unexplained,
// which is the correct outcome: nothing here can prove it read anything.
//
// The parser lives apart from both consumers so the format has ONE definition.

/**
 * The trailer format, written out.
 *
 * One HTML comment rather than three: it is invisible in the rendered review, it is
 * appended once, and a single regex reads it back.
 *
 * THE WORKFLOW DOES NOT CALL THIS — it builds the same string in bash, because the
 * stamping step runs before any Node is on the path in that job. Stated plainly so the
 * next reader does not go looking for a caller that is not there: this is the
 * emitter `review-trailer.test.ts` round-trips `readTrailer` against, which is what
 * keeps the parser honest about the shape the workflow actually writes. That round trip
 * was named here before it existed (RA-1718) — every parser test fed a HAND-WRITTEN
 * literal, so writer and reader were pinned to two independent copies of the format
 * rather than to each other, and a format change made in bash and in `trailerFor`
 * together left every test green while the workflow stamped something `readTrailer`
 * cannot match. `agent-review-verdict.test.ts` is the other half of the link: it asserts
 * the bash step emits exactly `trailerFor`'s string.
 *
 * @param {{sha: string, runId: string|number, supersedes?: (string|number)[]}} input
 * @returns {string}
 */
export const trailerFor = ({ sha, runId, supersedes = [] }) =>
  `<!-- reviewed: sha=${sha} run=${runId}${supersedes.length ? ` supersedes=${supersedes.join(',')}` : ''} -->`;

/**
 * Matches a trailer anywhere in a body, tolerating extra whitespace.
 *
 * GLOBAL, AND THE LAST MATCH WINS (RA-1713). The first version took the FIRST match,
 * and the stamp is APPENDED — so a review body that merely *quotes* this format won
 * over the genuine stamp beneath it. That is not a contrived input: a review
 * discussing RA-1680 quotes the trailer, and this file's own header does. The guard was
 * breakable by describing it, in a change whose subject is guards that cannot fail.
 */
const TRAILER = /<!--[ \t]*reviewed:[ \t]*sha=([0-9a-f]{7,40})(?:[ \t]+run=([0-9]+))?(?:[ \t]+supersedes=([0-9,]+))?[ \t]*-->/gi;

/**
 * What one review event is evidence about.
 *
 * `reviewedSha` is `null` when the body carries no trailer — which is NOT the same as
 * "it reviewed the head". Every review posted before this shipped is in that state, as
 * is one from a manual session, so a consumer must fall back to `commit_id` rather
 * than treat an absent stamp as a mismatch. That fallback is the pre-RA-1680 behaviour,
 * so nothing regresses; what it cannot do is PROVE the head was read, and the callers
 * say which of the two they got.
 *
 * @param {{body?: string|null}} review
 * @returns {{reviewedSha: string|null, runId: string|null, supersedes: string[]}}
 */
export function readTrailer(review) {
  // `matchAll` rather than `exec`, because a `g` regex carries `lastIndex` between
  // calls and would return a different answer on every second invocation.
  const all = [...String(review?.body ?? '').matchAll(TRAILER)];
  const m = all.at(-1);
  if (!m) return { reviewedSha: null, runId: null, supersedes: [] };
  return {
    reviewedSha: m[1].toLowerCase(),
    runId: m[2] ?? null,
    supersedes: (m[3] ?? '').split(',').filter(Boolean),
  };
}

/**
 * The commit a review is evidence about: the stamp when there is one, `commit_id`
 * otherwise.
 *
 * @param {{sha?: string, commit_id?: string, body?: string|null, reviewedSha?: string|null}} review
 */
export function evidenceSha(review) {
  const stamped = review?.reviewedSha ?? readTrailer(review).reviewedSha;
  return stamped ?? review?.sha ?? review?.commit_id ?? '';
}
