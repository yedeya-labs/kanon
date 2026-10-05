// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — re-delivery for a review that never landed on an implement/review PR
// (RA-1689).
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
// `agent-review.yml` fires on `workflow_run` (CI completion). That event fires ONCE;
// when it does not deliver — a dropped queue, a cap, an outage — nothing re-fires it
// and the PR parks: green, labelled, with no review event and no signal that one is
// missing.
//
// PR RA-1659 parked on BOTH of its heads. CI completed on `bb8232b` and on `5cd7880`,
// no `agent-review.yml` run followed either, and both were recovered by hand with a
// `review:please` churn. The first cost roughly a day of stall. The irony is exact:
// the PR that automated this recovery for the BRIEF lane (RA-1595) sat parked in this
// one, waiting for a human to notice.
//
// ── WHY THE EXISTING RECOVERY DOES NOT REACH IT ─────────────────────────────
// `reviewRecovery` in `lead-reconcile.mjs` covers this lane and cannot see most of
// it. Its world is `readWorld(project)` — issues carrying `qa:project <n>` in their
// body, for a project whose brief has MERGED — and it iterates only those carrying
// `agent:implement`. A `review:please` PR from a human, an `agent:triage` bug-fix, an
// implement PR filed outside a project brief, and the Lead's own PRs are in no such
// world. `agent-lead-reconcile.yml` does not even mint a token unless
// `ls docs/projects/*.md` finds an open project, so on a repo with none the whole
// lane is inert.
//
// This is the same shape RA-1595 answered for the brief lane, with the same reader
// pattern: a different world gets a different read, driven from the same hourly tick.
//
// ── AND IT IS NOT A DUPLICATE OF RA-1594 ──────────────────────────────────────
// RA-1594 is a BOUND defect in the recovery that exists; this is the WORLD it cannot
// see. They share one half — `review-run-evidence.mjs`, which both import — and
// neither subsumes the other: fixing the bound leaves every non-project PR
// uncovered, and adding this lane over the old bound would inherit the defect.
//
// The two lanes CAN both fire on one PR in the same tick, and the cost of that is
// nil rather than merely acceptable: both churn `review:please` as the same App, so
// both `labeled` events land in `agent-review.yml`'s
// `qa-review-<pr>-pull_request_target-open-<actor>` concurrency group with
// `cancel-in-progress`, and the second supersedes the first. One review either way.
//
// ── THE BOUND IS EVIDENCE, NOT A COUNTER ────────────────────────────────────
// Churn only when no `agent-review.yml` run for that head is evidence a review was
// attempted. After a churn one is — a run this recovery started counts whatever it
// concluded — so a head cannot be churned twice, and a run that FAILED is a run, so
// a cap or an outage is reported rather than repeated. See `review-run-evidence.mjs`.
// ONE EXCEPTION (RA-2519): a head whose ONLY attempt died of its cause is re-churned once,
// after `lane-retry.mjs`'s cool-down — see that module for the rule and its bound.
//
// ── IT DOES NOT PRE-EMPT THE CI-PENDING DEFER ───────────────────────────────
// RA-378's whole point: the Reviewer is invoked after CI settles, because firing on the push
// raced CI and forced a `COMMENTED` verdict carrying an approve in its prose that
// nothing re-fired. So this refuses to churn a head whose CI has not finished. That
// is not merely politeness — a churn fired into running CI produces a run that DEFERS,
// and because that run counts as a recovery attempt the bound is then spent on a head
// that was never reviewed. The age gate makes this rare and the check makes it
// impossible.
//
// ── NO `actions: write` ─────────────────────────────────────────────────────
// Recovery is a label churn (`docs/qa/agent-identities.md` footnote 2), which is what
// RA-1281 cost when phase 5 reached for `gh workflow run` instead. `agent-review.yml`
// subscribes to `pull_request_target: [labeled]` for exactly this case (it was
// `pull_request` until RA-2299).
//
// Usage: node scripts/review-recovery.mjs [--apply]

import { execFileSync } from 'node:child_process';
import { AWAITING_REVIEW_HOURS } from './lead-reconcile.mjs';
import { CONFLICT_JSON, CONFLICT_WHY, blocksChurn, conflictState } from './conflict-state.mjs';
import { readTrailer } from './review-trailer.mjs';
import { normaliseLogin, reviewAttempts, reviewRunsFor, whyNoChurn } from './review-run-evidence.mjs';
import { NO_RETRY_EVIDENCE, RETRY_COOL_DOWN_HOURS, describeRetry, makeRetryEvidenceReader, retryDecision } from './lane-retry.mjs';
import { appLogin } from './app-register.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

const REPO = process.env.GITHUB_REPOSITORY;
const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';

/** The reviewer's login, normalised — one identity, three spellings. Read from the
 *  register's `Reviewer` row (RA-2701). */
export const REVIEWER_LOGIN = appLogin('Reviewer');

/** The labels that make a PR the Reviewer's, and the one that is churned to re-deliver.
 *
 *  `review:please` is churned rather than a fresh label of this lane's own, unlike
 *  RA-1595's `agent:lead-revise`. There the distinct name was load-bearing: it let the
 *  workflow's job-level `if` decline every OTHER label event, which is what separated
 *  the churn's own run from the noise. Here the gate reads the label SET rather than
 *  the label added, so a new name would change nothing about which runs start — and
 *  the separation comes from the run's ACTOR instead (`review-run-evidence.mjs`).
 *  Churning a label the PR already carries also keeps the label set unchanged, so
 *  nothing downstream that reads labels sees a state this recovery invented. */
export const REVIEW_LABELS = ['review:please', 'agent:implement', 'agent:triage'];
export const CHURN_LABEL = 'review:please';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const ghJson = (args) => JSON.parse(gh(args));

/**
 * Whether CI has finished for a head SHA — `null` when the listing could not be read.
 *
 * Keyed on the workflow FILE and the SHA, for the reason `agent-review.yml`'s filter
 * now is (RA-1413): the PR-level rollup answered about the head as GraphQL saw it and
 * returned NO CI entries at all just after a push, so absence read as completion.
 * Here the direction of the failure is inverted — an unreadable or empty answer must
 * NOT license a churn — so `null` and `no runs yet` both mean "do not act".
 */
export function ciSettledFor(sha, { json = ghJson } = {}) {
  try {
    const runs = json(['run', 'list', '--repo', REPO, '--workflow', 'ci.yml',
      '--commit', sha, '--limit', '50', '--json', 'headSha,status,conclusion,databaseId']);
    const mine = (runs ?? []).filter((r) => r.headSha === sha);
    if (mine.length === 0) return false;
    return mine.every((r) => r.status === 'completed');
  } catch {
    return null;
  }
}

/**
 * The verdict standing on a PR's current head, or null.
 *
 * ASKS WHAT THE REVIEW READ, NOT WHAT GITHUB FILED IT UNDER (RA-1680). `commit.oid` is
 * the head at submission time, so a verdict formed against an earlier commit reads as
 * one about this one — which is the whole of RA-1680, and it would make this recovery
 * decide a parked head had been reviewed. The reviewer job stamps the SHA it checked
 * out into the body; that stamp wins, and `commit.oid` remains the fallback for every
 * review predating it.
 *
 * COMMENTED IS NOT A VERDICT — the RA-1081 rule, and the same one `merge-gate.mjs` and
 * the workflow's own reconcile step apply. A `COMMENT` is invisible to everything
 * downstream (RA-378), so a head carrying only one is a head with no review.
 */
export function verdictOnHead(pr) {
  return (pr.reviews ?? []).find((r) =>
    normaliseLogin(r.author?.login) === REVIEWER_LOGIN
    && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
    && (readTrailer(r).reviewedSha ?? r.commit?.oid) === pr.headRefOid) ?? null;
}

/** The open PRs this lane owns: the Reviewer's to review, not a draft, and not merged. */
export function reviewPrs(prs) {
  return (prs ?? []).filter((pr) =>
    pr.state === 'OPEN'
    && !pr.isDraft
    && (pr.labels ?? []).some((l) => REVIEW_LABELS.includes(l.name ?? l)));
}

/**
 * What this tick should do about the PRs it can see.
 *
 * PURE, so the decision is testable without GitHub — the property that matters is
 * "acted when it should not have", and every input that decides it is an argument.
 *
 * @param {any[]} prs open PRs, as `gh pr list --json number,state,isDraft,labels,headRefOid,reviews,commits`
 */
export function reviewRecovery(prs, {
  // `since` floors RA-1717's title read at the head's push time — the stall clock this
  // function already holds, so the read needs no commit lookup of its own.
  runsFor = (sha, since) => reviewRunsFor(sha, { repo: REPO, json: ghJson, since }),
  ciSettled = ciSettledFor,
  now = Date.now(),
  hours = AWAITING_REVIEW_HOURS,
  // The RA-2519 retry's jobs read. The default reads nothing as retryable, so the unit
  // tier never shells out; `main()` passes the real reader.
  evidenceOf = NO_RETRY_EVIDENCE,
  retryHours = RETRY_COOL_DOWN_HOURS,
} = {}) {
  const churn = [];
  const noted = [];
  for (const pr of reviewPrs(prs)) {
    if (verdictOnHead(pr)) continue;
    // AGE, NOT MERE ABSENCE. A PR pushed a minute ago has no review either, and
    // calling that a stall would fire on every healthy PR in the window CI takes.
    // An unknown timestamp is not a stall: a missing date must not manufacture one.
    const pushedAt = pr.commits?.at(-1)?.committedDate ?? null;
    if (!pushedAt) continue;
    if (now - new Date(pushedAt).getTime() < hours * 3600_000) continue;
    // BEFORE THE CI QUESTION, AND THE ORDER IS THE FIX (RA-1722). A conflicting PR has
    // no merge ref, so `ci.yml` was never dispatched for this head — which reaches the
    // branch below and reports "CI has not finished on this head ... Nothing to
    // recover yet". That sentence is true of a PR whose CI is merely slow and false of
    // this one, where CI will never start and no churn can change it. Same detector,
    // opposite remedy, so the conflicting case has to be asked first. (The churn's own
    // `pull_request_target` run DOES start on a conflicting PR since RA-2299, RA-2302 — and
    // defers, or reviews a head the conflict fix will replace. Still refused.)
    if (blocksChurn(conflictState(pr))) {
      noted.push({ number: pr.number, sha: pr.headRefOid, why: CONFLICT_WHY });
      continue;
    }
    const settled = ciSettled(pr.headRefOid);
    if (settled !== true) {
      noted.push({
        number: pr.number,
        sha: pr.headRefOid,
        why: settled === null
          ? 'could not read CI\'s runs for this head, so whether CI has settled is unknown — not churning, because a churn fired into running CI produces a run that merely defers and spends the bound (RA-378)'
          : 'CI has not finished on this head — the Reviewer is invoked after CI settles by design (RA-378), and CI\'s own completion is what fires him. Nothing to recover yet',
      });
      continue;
    }
    const runs = runsFor(pr.headRefOid, pushedAt);
    if (!Array.isArray(runs)) {
      noted.push({ number: pr.number, sha: pr.headRefOid, why: 'could not read this workflow\'s runs, so nothing was churned' });
      continue;
    }
    // `churnedAfter` — the moment this head first became churnable — is what separates
    // a run THIS recovery started from one an App merely actored by labelling the PR
    // (RA-1714). The Lead applies `review:please` to its own brief PR at creation, so
    // without it a brief PR's initial head reads as permanently "already attempted" and
    // this lane could never churn the very PRs RA-1689 was filed over.
    const attempts = reviewAttempts(runs, {
      churnedAfter: new Date(pushedAt).getTime() + hours * 3600_000,
    });
    if (attempts.length === 0) {
      churn.push({ number: pr.number, sha: pr.headRefOid });
      continue;
    }
    // Its only attempt died of its cause and the cool-down has passed (RA-2519).
    const retry = retryDecision(attempts, { evidenceOf, now, hours: retryHours });
    if (retry?.retry) {
      churn.push({ number: pr.number, sha: pr.headRefOid, retry: retry.retry });
      continue;
    }
    noted.push({ number: pr.number, sha: pr.headRefOid, why: retry?.why ?? whyNoChurn(attempts) });
  }
  return { churn, noted };
}

/** What a human reads. Two lanes of nothing is still a finding, so it says so. */
export function report({ churn, noted }, { apply = APPLY } = {}) {
  const lines = ['## Review recovery — PRs parked with no review\n'];
  if (!churn.length && !noted.length) {
    lines.push(`**No PR is parked without a review.** That is a finding, not an absence — every open PR carrying \`${REVIEW_LABELS.join('` / `')}\` was examined.\n`);
    return lines.join('\n');
  }
  if (churn.length) {
    lines.push(`**${churn.length} PR(s)${apply ? '' : ' that would be'} re-labelled \`${CHURN_LABEL}\`:**\n`);
    for (const c of churn) lines.push(`- PR #${c.number} \`${String(c.sha).slice(0, 7)}\` — CI is done, no verdict, and ${c.retry ? describeRetry(c.retry) : 'no review run has attempted this head (RA-1689)'}`);
    lines.push('');
  }
  if (noted.length) {
    // NAMED, NOT COUNTED. "detected 3, churned 1" reads as two silently dropped; the
    // reasons want different responses and most of them want none.
    lines.push('**Parked heads that were NOT re-labelled.** Each line says why:\n');
    for (const n of noted) lines.push(`- PR #${n.number} \`${String(n.sha).slice(0, 7)}\`: ${n.why}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Remove-then-add, because adding a label a PR already carries raises NO event — and
 *  the event is the entire point. The remove may legitimately fail (a PR labelled
 *  `agent:implement` alone), and that is not an error: the add below is the event. */
function churnLabel(number) {
  try {
    gh(['pr', 'edit', String(number), '--repo', REPO, '--remove-label', CHURN_LABEL]);
  } catch {
    // not carrying that label yet
  }
  gh(['pr', 'edit', String(number), '--repo', REPO, '--add-label', CHURN_LABEL]);
}

/**
 * The candidate PRs, hydrated with the two CONNECTIONS the decision needs.
 *
 * TWO READS, AND THAT IS NOT AN OPTIMISATION — the one-read form does not work. Asking
 * `gh pr list` for `reviews` and `commits` across 100 PRs multiplies two connections by
 * the page size, and GitHub rejects the query outright:
 *
 *   GraphQL: By the time this query traverses to the authors connection, it is
 *   requesting up to 1,000,000 possible nodes which exceeds the maximum limit of
 *   500,000.
 *
 * Measured against this repo before this lane ever ran on a tick — the failure is total
 * (no result, non-zero exit), not a truncation, so the whole recovery would have died
 * on its first heartbeat with a green unit suite behind it. That is RA-1032's shape
 * exactly, which is why the script is run against the real repo and not only stubbed.
 *
 * So the cheap pass asks only for SCALARS, `reviewPrs` narrows to the PRs this lane
 * owns, and the connections are fetched per PR — the same shape `lead-reconcile.mjs`'s
 * `linkedPrs` uses, and bounded by the workflow's own pre-filter (3 such PRs today).
 *
 * A PR whose detail read fails is REPORTED, not dropped: an unreadable PR must not be
 * silently treated as "nothing parked here", which is the swallow this pipeline keeps
 * producing.
 *
 * @param {{number: number}[]} candidates
 * @param {{json?: (args: string[]) => any, onError?: (number: number) => void}} [io]
 */
export function hydrate(candidates, { json = ghJson, onError = (_number) => {} } = {}) {
  const out = [];
  for (const pr of candidates) {
    try {
      out.push(json(['pr', 'view', String(pr.number), '--repo', REPO, '--json',
        `number,state,isDraft,labels,headRefOid,reviews,commits,${CONFLICT_JSON}`]));
    } catch {
      // NO `ConflictFieldsUnread` RE-THROW HERE, deliberately (RA-2158). `lead-reconcile.mjs`
      // and `project-digest.mjs` both carry one because they call `conflictState` INSIDE
      // their try; this block only calls `gh pr view`, so the branch could never fire. A
      // guard that cannot fire reads as protection and provides none — the same argument
      // `project-digest.mjs` makes about its deleted double-bail filter. The field list is
      // still enforced: `reviewRecovery` calls `conflictState` on what this returns.
      onError(pr.number);
    }
  }
  return out;
}

function main() {
  if (!REPO) {
    console.error('review-recovery: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const candidates = reviewPrs(ghJson(['pr', 'list', '--repo', REPO, '--state', 'open',
    '--limit', '100', '--json', 'number,state,isDraft,labels']));
  const unreadable = [];
  const prs = hydrate(candidates, { onError: (n) => unreadable.push(n) });
  for (const n of unreadable) {
    console.log(`::warning title=review recovery::could not read PR #${n}, so whether it is parked without a review is unknown. Not churning it (RA-1689).`);
  }
  const decision = reviewRecovery(prs, { evidenceOf: makeRetryEvidenceReader({ json: ghJson }) });
  const text = report(decision);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    execFileSync('bash', ['-c', 'cat >> "$GITHUB_STEP_SUMMARY"'], { input: text });
  }
  if (!APPLY) return;
  for (const c of decision.churn) {
    churnLabel(c.number);
    console.log(`re-labelled PR #${c.number} for review — ${c.retry ? describeRetry(c.retry) : 'no review run has attempted'} ${String(c.sha).slice(0, 7)} (RA-1689)`);
  }
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) main();
