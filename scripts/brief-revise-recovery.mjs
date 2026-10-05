// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — re-delivery for a brief PR's unanswered changes-request (RA-1595).
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
// `agent-lead-revise.yml` subscribed to `pull_request_review: [submitted]` and
// `workflow_dispatch` and nothing else. `pull_request_review` fires ONCE; if the
// workflow does not run for it — a quota cap, an outage, a dropped queue — nothing
// re-delivers it and the brief PR parks on an unanswered changes-request, green and
// silent. That is the shape RA-1077 measured on PR RA-1057 (six hours, reported healthy),
// RA-1408 closed for the review lane and RA-1524/RA-1592 closed for the implementer.
//
// This lane was worse than the one RA-1592 fixed, on both axes:
//
//   · NO DETECTOR EITHER. `isReviewBlocked` is reached from `reviewRecovery` and
//     `reviseRecovery`, and both iterate `world.open` filtered to issues carrying
//     `agent:implement`. A brief PR is the Lead's OWN and is a linked PR of no such
//     issue, so the hourly tick that notices the implementer lane stalling cannot see
//     this one at all. The implementer stall was at least REPORTED for the ~11 months
//     between RA-1081 and RA-1524; this one was invisible.
//   · THE ARTIFACT IS THE DEVELOPER'S SINGLE GATE (docs/agentic-lead-engineer.md
//     §5.3). Everything downstream — which issues exist, what is built, what is
//     reviewed — follows from the brief, so a parked brief PR holds a whole project
//     rather than one issue.
//
// ── WHY THIS IS ITS OWN SCRIPT AND NOT A LANE IN lead-reconcile.mjs ─────────
// Not tidiness — the reconciler structurally cannot reach this subject. Its world is
// `readWorld(project)`, keyed off a NUMERIC TRACKING ISSUE whose brief is already on
// `main`, and `agent-lead-reconcile.yml`'s pre-filter enumerates projects by
// `ls docs/projects/*.md`. A brief PR is by definition a brief that has NOT merged, so
// its project is not in that list and `readWorld` would return `briefMerged: false`
// with nothing else derived. The subject here is "the Lead's own open PRs", which is a
// different world read, so it gets a different reader.
//
// ── THE BOUND IS EVIDENCE, NOT A COUNTER ────────────────────────────────────
// Churn only when NO `agent-lead-revise` run exists for that head SHA. After a churn a
// run exists, so a head cannot be churned twice; a run that FAILED is a run, so a cap
// or an outage is reported rather than repeated. Age-gated on the changes-request's
// own timestamp, and fails closed on an unreadable listing. ONE EXCEPTION (RA-2519): a
// head whose ONLY run died of its cause (the model unreachable, or its API failing
// mid-run) is re-churned once after `lane-retry.mjs`'s cool-down — during the outage
// it is still reported, and the retry is itself a run, so it stays bounded.
//
// ── AND IT CANNOT SPEND A REVISION ROUND ────────────────────────────────────
// RA-1595's first constraint, checked before this was written.
// `agent-lead-revise.yml`'s `ROUNDS=` computes `max(distinct patches faulted − 1,
// markers)` (RA-1841 — it counted changes-requests until then, which a content-free
// rebase could inflate) — derived from the world, not incremented per run. A
// re-delivered event adds neither a patch nor a marker, so it re-delivers the SAME
// round rather than spending another, and the cap is still honoured on the label path.
// (Named by symbol, not by line: the `:196` that used to be here was already stale.)
//
// Usage: node scripts/brief-revise-recovery.mjs [--apply]

import { execFileSync } from 'node:child_process';
import { AWAITING_REVIEW_HOURS } from './lead-reconcile.mjs';
import { churnBoundary, reviseDeliveries } from './revise-run-evidence.mjs';
import { NO_RETRY_EVIDENCE, RETRY_COOL_DOWN_HOURS, describeRetry, makeRetryEvidenceReader, retryDecision } from './lane-retry.mjs';
import { readTrailer } from './review-trailer.mjs';
import { CONFLICT_JSON, CONFLICT_WHY, blocksChurn, conflictState } from './conflict-state.mjs';
import { appLogin } from './app-register.mjs';
import { asRole } from './lib/role-marker.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { beforeApply } from './lib/labels.mjs';

const REPO = process.env.GITHUB_REPOSITORY;
const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';

/** The Lead's login, in the one spelling every endpoint is normalised TO.
 *
 *  One identity has three spellings across three endpoints — `app/example-lead`
 *  from `gh pr view --json author`, `example-lead` from an issue comment, and
 *  `example-lead[bot]` from the reviews API. `agent-lead-revise.yml` normalises
 *  rather than matching a list, having once matched two of the three and skipped every
 *  dispatch as a result; this does the same. */
export const LEAD_LOGIN = appLogin('Lead'); // the register's `Lead` row (RA-2701)
export const BRIEF_PATH = 'docs/projects/';
/** Its own marker, and the reason is the `skipped` conclusion rather than the side
 *  effects (RA-1659 review).
 *
 *  A DISTINCT NAME IS WHAT LETS THE JOB-LEVEL GATE DECLINE. `agent-lead-revise.yml`
 *  admits only this one, so every other label event on a brief PR concludes `skipped`
 *  and `briefReviseRunsFor` discards it. Churn `review:please` instead and the gate
 *  would have to admit the label the PR carries from open — which makes the churn's
 *  own run and the noise indistinguishable, and the only thing bounding this loop is
 *  telling those apart.
 *
 *  WHAT IT DOES NOT BUY, stated because the first version of this comment claimed it:
 *  a distinct label does NOT keep `agent-review.yml` out of it. That workflow's gate
 *  reads the PR's label SET rather than the label added, and a brief PR carries
 *  `review:please` from open — so ANY label event on one starts its `filter` job. The
 *  cost is a few seconds and no second review: RA-1351 keys a re-review on a HUMAN
 *  sender, and RA-1376's `github.actor` in the concurrency key puts a bot's churn in its
 *  own group, so it cannot cancel an in-flight review either. Measured on PR RA-1659.
 *
 *  Nor `agent:revise`, which is the implementer's and would start
 *  `agent-implement-revise.yml` on a brief PR it can only decline. */
export const REVISE_LABEL = 'agent:lead-revise';
export const WORKFLOW = 'agent-lead-revise.yml';

export const normaliseLogin = (login) =>
  String(login ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '');

function gh(args) {
  beforeApply(args, (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const ghJson = (args) => JSON.parse(gh(args));

/**
 * The open brief PRs the Lead authored — his own, touching `docs/projects/**`.
 *
 * BOTH CONDITIONS, because either alone is wrong: a human's PR editing a brief is not
 * his to revise, and one of his PRs that touches no brief is not a brief PR. These are
 * the same two conditions `agent-lead-revise.yml`'s filter applies before it acts, so
 * a churn cannot re-fire something the workflow would then decline.
 *
 * FILTERED CLIENT-SIDE rather than with `--author`, deliberately: an App's author
 * login is spelled three ways depending on the endpoint (see `LEAD_LOGIN`), and a
 * server-side filter written against the wrong one returns an empty list that is
 * indistinguishable from "nothing is parked".
 */
export function briefPrs(prs) {
  return (prs ?? []).filter((pr) =>
    pr.state === 'OPEN'
    // The Lead's login and, from L4, its role marker in the PR body (plan 0005 §3.3).
    && asRole('Lead', { login: normaliseLogin(pr.author?.login), expected: LEAD_LOGIN, body: pr.body })
    && (pr.files ?? []).some((f) => String(f.path ?? '').startsWith(BRIEF_PATH)));
}

/**
 * The changes-request standing on a PR's current head, or null.
 *
 * COMMENTED IS NOT A VERDICT — the RA-1081 rule, and it matters more here than on the
 * implementer lane: `docs/qa/reviewer-playbook.md` permitted the Reviewer to post `COMMENT`
 * with his findings on a red required check until RA-2299 removed it, those reviews
 * still stand on open PRs, a standalone inline comment still creates one, and a
 * brief PR is docs-only, so its checks are the ones most likely to be red for reasons
 * the brief did not cause.
 * Taking the last review regardless would read a trailing `COMMENTED` as an answer and
 * decide the brief is not parked.
 *
 * The same rule `isReviewBlocked` applies, over the review shape `gh pr view --json
 * reviews` actually returns — `commit.oid`, `body` and `submittedAt`, which that
 * function's projected world carries only in part and which the age gate here needs.
 *
 * ON THE HEAD IT READ, NOT THE HEAD GITHUB FILED IT UNDER (RA-1725, after RA-1680): the
 * reviewer job's `<!-- reviewed: sha=… -->` stamp wins, and `commit.oid` — the head at
 * SUBMISSION — is the fallback for a review that carries none. `gh pr list --json
 * reviews` already returns each body, so this costs no extra read. The same rule, from
 * the same parser, as `review-recovery.mjs`'s `verdictOnHead` and `lead-reconcile.mjs`'s
 * `standingChangesRequest`.
 */
export function standingChangesRequest(pr) {
  const onHead = (pr.reviews ?? []).filter((r) =>
    (readTrailer(r).reviewedSha ?? r.commit?.oid ?? r.sha) === pr.headRefOid);
  const deciding = onHead.filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED').at(-1);
  return deciding?.state === 'CHANGES_REQUESTED' ? deciding : null;
}

/**
 * The `agent-lead-revise` runs for a head SHA that represent a DELIVERY — or null if
 * the listing could not be read. Fail-closed, the same contract as `reviewRunsFor`.
 *
 * SKIPPED RUNS ARE NOT DELIVERIES. The workflow now subscribes to
 * `pull_request: [labeled]`, and a brief PR collects `review:please` at open and
 * `agent:reviewer` on its first review — both on the same head the first
 * changes-request lands on — while the Reviewer's `COMMENTED` reviews start it too. Its
 * job-level `if` makes all of those conclude `skipped`, and this drops them. Counting
 * them would suppress the churn on precisely the head this exists for.
 *
 * A run started by the CHURN passes that gate, so it still counts — which matters more
 * than it looks: "after a churn a run exists" is the ONLY thing bounding this loop.
 * Exclude the churn's own run and the same head is re-churned every hour forever.
 *
 * A null CONCLUSION is an unfinished run and is KEPT: that is the state the churn
 * itself creates on the very next tick.
 *
 * AND A RUN THAT PREDATES THE REVIEW IS NOT A DELIVERY EITHER (RA-1690). The `skipped`
 * filter above is the right diagnosis with too narrow a remedy, and the implementer
 * lane is where it was measured: the same burst of label events also produces runs the
 * workflow's `concurrency` group CANCELS, `cancelled` is not `skipped`, and PR RA-1660
 * parked for two days on one of them — a run that started ten minutes BEFORE the
 * review it was counted as having delivered. This lane has the identical exposure by
 * construction: `agent-lead-revise.yml` subscribes to `pull_request: [labeled]`, a
 * brief PR collects `review:please` at open, and it has a `concurrency` group too.
 * Fixed here in the same change rather than left as a known twin.
 *
 * The predicate was never `conclusion` — it is WHEN THE RUN STARTED. A delivery of a
 * changes-request cannot begin before the changes-request exists. The `skipped` filter
 * is kept: a non-marker label event AFTER the review starts a run too.
 *
 * AND A CANCELLED RUN A NEWER ONE SUPERSEDED IS NOT A DELIVERY (RA-1724) — the label
 * event the concurrency group displaced, which would have concluded `skipped`. The
 * three rules live in `revise-run-evidence.mjs`, shared with the implementer lane, and
 * `churnedAfter` is what keeps a churn's own run counted whatever it concluded. `event`
 * is read because only a LABEL-event run can be such a casualty (RA-2301): a cancelled
 * `pull_request_review` run was stopped mid-delivery, and still reads as broken.
 *
 * `--commit` is a server-side filter, and using it is what makes this correct rather
 * than usually-correct: `--limit N` is a time window in disguise, and a head whose
 * revise run failed before the window would list as zero runs and be churned.
 */
export function briefReviseRunsFor(sha, since, { json = ghJson, churnedAfter = /** @type {string|null} */ (null) } = {}) {
  try {
    const runs = json(['run', 'list', '--repo', REPO, '--workflow', WORKFLOW,
      '--commit', sha, '--limit', '100', '--json', 'headSha,event,status,conclusion,databaseId,createdAt']);
    return reviseDeliveries(runs, { sha, since, churnedAfter });
  } catch {
    return null;
  }
}

const BROKEN = ['failure', 'cancelled', 'timed_out', 'startup_failure'];

/**
 * What this tick should do about the brief PRs it can see.
 *
 * PURE, so the decision is testable without GitHub — the property that matters is
 * "acted when it should not have", and every input that decides it is an argument.
 *
 * @param {any[]} prs   open PRs, as `gh pr list --json
 *   number,author,state,files,headRefOid,reviews,mergeable,mergeStateStatus`
 * @param {{runsFor?: (sha: string, since?: string, opts?: {churnedAfter?: string|null}) => any[]|null, now?: number, hours?: number, evidenceOf?: (runId?: any) => ({classification: string, at: string|null}|null|undefined), retryHours?: number}} [opts]
 * @returns {{churn: {number: number, sha: string, retry?: {runId: any, classification: string, at: string|null}}[], noted: {number: number, sha: string, why: string}[]}}
 */
export function briefReviseRecovery(prs, { runsFor = briefReviseRunsFor, now = Date.now(), hours = AWAITING_REVIEW_HOURS, evidenceOf = NO_RETRY_EVIDENCE, retryHours = RETRY_COOL_DOWN_HOURS } = {}) {
  const churn = [];
  const noted = [];
  for (const pr of briefPrs(prs)) {
    const review = standingChangesRequest(pr);
    if (!review) continue;
    // AGE-GATED ON THE REVIEW, not on the push — and that is the right clock for this
    // lane rather than a copy of the implementer's. What is being timed is "how long
    // has this changes-request gone unanswered", and the head predates the review by
    // definition. An unknown timestamp is not a stall: a missing `submittedAt` must
    // not manufacture one.
    if (!review.submittedAt) continue;
    if (now - new Date(review.submittedAt).getTime() < hours * 3600_000) continue;
    // BEFORE THE RUN EVIDENCE (RA-1722). A conflicting PR dispatches no `pull_request`
    // event, so `agent-lead-revise.yml`'s `labeled` trigger — the whole of this lane's
    // remedy — raises an event nothing receives. The run listing would then be empty
    // forever, which is precisely the condition that licenses a churn, so this lane
    // churns hourly and reports success at doing nothing. Asked first, because the
    // answer changes the remedy rather than merely the wording.
    if (blocksChurn(conflictState(pr))) {
      noted.push({ number: pr.number, sha: pr.headRefOid, why: CONFLICT_WHY });
      continue;
    }
    const runs = runsFor(pr.headRefOid, review.submittedAt, { churnedAfter: churnBoundary(review.submittedAt, hours) });
    if (!Array.isArray(runs)) {
      noted.push({ number: pr.number, sha: pr.headRefOid, why: 'could not read this workflow\'s runs, so nothing was churned' });
      continue;
    }
    if (runs.length === 0) {
      churn.push({ number: pr.number, sha: pr.headRefOid });
      continue;
    }
    // Its only delivery died of its cause and the cool-down has passed (RA-2519) — the
    // one exception to "a failed run is a run", bounded because the retry is a run too.
    const retry = retryDecision(runs, { evidenceOf, now, hours: retryHours });
    if (retry?.retry) {
      churn.push({ number: pr.number, sha: pr.headRefOid, retry: retry.retry });
      continue;
    }
    if (retry?.why) {
      noted.push({ number: pr.number, sha: pr.headRefOid, why: retry.why });
      continue;
    }
    const broken = runs.find((r) => BROKEN.includes(r.conclusion));
    const unfinished = runs.find((r) => !r.conclusion);
    const latest = broken ?? unfinished ?? runs[0];
    noted.push({
      number: pr.number,
      sha: pr.headRefOid,
      why: `${runs.length} revise run(s) exist for this head and the request is still unanswered `
        + `(latest: ${latest?.status ?? '?'}/${latest?.conclusion ?? '-'}, run ${latest?.databaseId ?? '?'}). `
        + (unfinished && !broken
          ? 'It has NOT finished — nothing needs doing yet'
          : broken
            ? 'Re-firing repeats it — read that run\'s classify annotation (RA-1503)'
            : 'The run did not fail — read its `filter` step for which arm declined it. '
              + 'The round cap is the usual reason, and it has no annotation'),
    });
  }
  return { churn, noted };
}

/** What a human reads. Two lanes of nothing is still a finding, so it says so. */
export function report({ churn, noted }, { apply = APPLY } = {}) {
  const lines = ['## The Lead — brief-PR revise recovery\n'];
  if (!churn.length && !noted.length) {
    lines.push('**No brief PR is parked on an unanswered changes-request.** That is a finding, not an absence — every open PR the Lead authored under `docs/projects/**` was examined.\n');
    return lines.join('\n');
  }
  if (churn.length) {
    lines.push(`**${churn.length} brief PR(s)${apply ? '' : ' that would be'} re-labelled \`${REVISE_LABEL}\`:**\n`);
    for (const c of churn) lines.push(`- PR #${c.number} \`${String(c.sha).slice(0, 7)}\` — ${c.retry ? describeRetry(c.retry) : 'no revise run exists for this head (RA-1595)'}`);
    lines.push('');
  }
  if (noted.length) {
    // NAMED, NOT COUNTED. "detected 3, churned 1" reads as two silently dropped; the
    // reasons want different responses and two of them want none.
    lines.push('**Parked heads that were NOT re-labelled.** Each line says why:\n');
    for (const n of noted) lines.push(`- PR #${n.number} \`${String(n.sha).slice(0, 7)}\`: ${n.why}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Remove-then-add, because adding a label a PR already carries raises NO event — and
 *  the event is the entire point. The remove may legitimately fail (the PR was never
 *  labelled), and that is not an error: the add below is the event either way. */
function churnLabel(number) {
  try {
    gh(['pr', 'edit', String(number), '--repo', REPO, '--remove-label', REVISE_LABEL]);
  } catch {
    // not labelled yet
  }
  gh(['pr', 'edit', String(number), '--repo', REPO, '--add-label', REVISE_LABEL]);
}

function main() {
  if (!REPO) {
    console.error('brief-revise-recovery: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100',
    '--json', `number,author,body,state,files,headRefOid,reviews,${CONFLICT_JSON}`]);
  const decision = briefReviseRecovery(prs, { evidenceOf: makeRetryEvidenceReader({ json: ghJson }) });
  const text = report(decision);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    execFileSync('bash', ['-c', 'cat >> "$GITHUB_STEP_SUMMARY"'], { input: text });
  }
  if (!APPLY) return;
  for (const c of decision.churn) {
    churnLabel(c.number);
    console.log(`re-labelled PR #${c.number} for revision — ${c.retry ? describeRetry(c.retry) : 'no revise run exists'} for ${String(c.sha).slice(0, 7)} (RA-1595)`);
  }
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) main();
