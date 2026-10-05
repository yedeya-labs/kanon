#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — a detector for a PR that is RED and has NO REVIEW VERDICT (RA-1723).
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
// PR RA-1719 sat red and unreviewed for a day. `agent-review.yml`'s job died on the same
// `db:init` step CI did, so no verdict was posted; with no changes-request nothing could
// re-invoke the implementer; and nothing else read check state at all. "Red CI, no review
// verdict" was an unowned state — invisible to every detector.
//
// Part 1 of RA-1723 (RA-2299) makes the reviewer survive a PR that cannot migrate, so the
// commonest cause now produces a verdict. What remains red-and-unreviewed is a head whose
// REVIEW RUN broke — a cap, an outage, a crash — and that already has a recovery with a
// bound: the `review:please` churn in `review-recovery.mjs`. So this does not act.
//
// ── REPORT ONLY, BY THE DEVELOPER'S DECISION (2026-09-24, on RA-1723) ──────────
// No dispatch, no label, and no `agent:fix-ci` entry point: "a red PR the reviewer
// couldn't read is fixed by fixing the review, not by sending the implementer in without
// findings". It prints a `::warning` per PR and a step-summary section, and exits 0 —
// a tick that goes red because a PR is red would be a second alarm for one fact.
//
// ── NOTHING HERE READS THE ROLLUP ITSELF ─────────────────────────────────────
// Three modules already answer the three questions, and a fourth reader is how they
// drift (RA-1723's own inventory found two readers and asked for no third):
//   • which PRs, and do they have a verdict on the head  → `review-recovery.mjs`
//     (`reviewPrs`, `hydrate`, `verdictOnHead` — COMMENTED is not a verdict)
//   • is the head red                                     → `merge-gate.mjs`
//     (`readPr` projects the rollup; `checkPartition` supersedes and partitions it)
//   • was a review of this head attempted                 → `review-run-evidence.mjs`
//
// GitHub API only — no Aurora, no AWS — so the schedule-cost rule in AGENTS.md does not
// apply, and it rides the existing hourly `agent-lead-reconcile.yml` tick.
//
// Usage: node scripts/red-unreviewed.mjs

import { execFileSync } from 'node:child_process';
import { CONFLICT_WHY, conflictState } from './conflict-state.mjs';
import { AWAITING_REVIEW_HOURS } from './lead-reconcile.mjs';
import { checkPartition, readPr } from './merge-gate.mjs';
import { hydrate, reviewPrs, verdictOnHead } from './review-recovery.mjs';
import { reviewAttempts, reviewRunsFor, whyNoChurn } from './review-run-evidence.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

const REPO = process.env.GITHUB_REPOSITORY;

/**
 * Which open pipeline PRs are red, old enough to be stalled, and unreviewed on the head.
 *
 * PURE over its injected reads, so every arm is testable without GitHub.
 *
 * The ORDER is the cost bound: the cheap, already-hydrated facts (label set, verdict on
 * head, age) go first, and the two expensive reads — `readChecks` is a whole `readPr`,
 * `runsFor` a paginated Actions listing — run only for a PR that survives them.
 *
 * @param {any[]} prs  hydrated PRs, as `review-recovery.mjs`'s `hydrate` returns them
 * @param {object} [io]
 * @param {(n: number) => any[]} [io.readChecks]  the rollup as `readPr` projects it; throws when unreadable
 * @param {(sha: string, since: string) => any[] | null} [io.runsFor]  `reviewRunsFor`
 * @param {number} [io.now]
 * @param {number} [io.hours]  the stall window, `AWAITING_REVIEW_HOURS`
 * @returns {{flagged: {number: number, sha: string, failed: string[], review: string}[], unreadable: number[], conflicting: number[]}}
 */
export function redUnreviewed(prs, {
  readChecks = (n) => readPr(n, REPO).checks,
  runsFor = (sha, since) => reviewRunsFor(sha, { repo: REPO, json: ghJson, since }),
  now = Date.now(),
  hours = AWAITING_REVIEW_HOURS,
} = {}) {
  const flagged = [];
  const unreadable = [];
  const conflicting = [];
  for (const pr of reviewPrs(prs)) {
    // A verdict on this head — APPROVED or CHANGES_REQUESTED, by what it READ — means
    // the state is owned: the revise lane or the Merger has it.
    if (verdictOnHead(pr)) continue;
    // AGE, NOT MERE ABSENCE. A head pushed minutes ago is red-and-unreviewed while CI and
    // then the Reviewer run; that is the pipeline working. Undated is not stalled.
    const pushedAt = pr.commits?.at(-1)?.committedDate ?? null;
    if (!pushedAt || now - Date.parse(pushedAt) < hours * 3600_000) continue;
    let parts;
    try {
      parts = checkPartition(readChecks(pr.number));
    } catch {
      // Reported, never dropped: an unreadable PR is not a green one. (`readPr` reads
      // more than the rollup, so this also catches its other reads failing — the line
      // says "could not read the PR", not "the checks".)
      unreadable.push(pr.number);
      continue;
    }
    // AN EMPTY ROLLUP IS NOT A GREEN ONE. A rollup read with a token lacking `Checks:
    // Read` / `Commit statuses: Read` comes back SHORT, not as an error — which would
    // make this detector silently green forever. A head past the stall window with no
    // check at all is either that or a conflicting PR (no merge ref, no CI), and neither
    // is evidence of green. The CONFLICTING half is told apart, because it has a
    // different remedy — a rebase, not a review — and "unreadable" sends a reader to the
    // token. `hydrate` asks for the conflict fields, so `conflictState` throwing
    // `ConflictFieldsUnread` here is a code defect and is left to surface as one.
    if (!parts.relevant.length) {
      (conflictState(pr) === 'conflicting' ? conflicting : unreadable).push(pr.number);
      continue;
    }
    // RED IS FAILED OR CANCELLED-AND-NOT-SUPERSEDED — both block the ruleset, and a
    // cancelled CI job is exactly the state in which the Reviewer is never fired. Pending is
    // not red: CI still running is the pipeline working.
    const red = [...parts.failed, ...parts.cancelled];
    if (!red.length) continue;
    const runs = runsFor(pr.headRefOid, pushedAt);
    let review;
    if (!Array.isArray(runs)) {
      review = 'whether a review of this head was attempted is UNKNOWN — the Actions listing could not be read';
    } else {
      // `churnedAfter`, as `reviewRecovery` passes it (RA-1714): the Lead labelling his
      // own brief PR at creation is not a recovery attempt.
      const attempts = reviewAttempts(runs, { churnedAfter: Date.parse(pushedAt) + hours * 3600_000 });
      // A REVIEW RUNNING NOW IS NOT A STALL — often the re-delivery the step before
      // this one just fired. Flagging it would warn that "nothing is wrong yet".
      if (attempts.some((r) => !r.conclusion)) continue;
      review = attempts.length
        ? `a review WAS attempted and posted no verdict: ${whyNoChurn(attempts)}`
        : 'no review run has attempted this head';
    }
    flagged.push({ number: pr.number, sha: pr.headRefOid, failed: red.map((c) => `${c.name} (${c.conclusion})`), review });
  }
  return { flagged, unreadable, conflicting };
}

/**
 * What a human reads. "Nothing found" is a finding too, and says what was examined.
 * @param {{flagged: any[], unreadable: number[], conflicting?: number[]}} found
 * @param {{hours?: number}} [opts]
 */
export function report({ flagged, unreadable, conflicting = [] }, { hours = AWAITING_REVIEW_HOURS } = {}) {
  const lines = ['## Red and unreviewed — PRs nobody is looking at (RA-1723)\n'];
  if (!flagged.length && !unreadable.length && !conflicting.length) {
    lines.push(`**No open pipeline PR is red and unreviewed past ${hours}h.** Every open \`review:please\` / \`agent:implement\` / \`agent:triage\` PR was examined.\n`);
    return lines.join('\n');
  }
  if (flagged.length) {
    lines.push(`**${flagged.length} PR(s) red with no verdict on the head for over ${hours}h.** Report only — nothing is dispatched (RA-1723's decision). The remedy is usually the REVIEW: once it posts a changes-request, the revise lane takes the red check with it.\n`);
    for (const f of flagged) lines.push(`- PR #${f.number} \`${String(f.sha).slice(0, 7)}\` — failing: ${f.failed.join(', ')}. ${f.review}.`);
    lines.push('');
  }
  if (conflicting.length) {
    lines.push(`**No checks, because conflicting:** ${conflicting.map((n) => `#${n}`).join(', ')} — ${CONFLICT_WHY}.\n`);
  }
  if (unreadable.length) {
    lines.push(`**Could not read, or saw no checks on:** ${unreadable.map((n) => `#${n}`).join(', ')} — NOT reported as green.\n`);
  }
  return lines.join('\n');
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}

function main() {
  if (!REPO) {
    console.error('red-unreviewed: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const candidates = reviewPrs(ghJson(['pr', 'list', '--repo', REPO, '--state', 'open',
    '--limit', '100', '--json', 'number,state,isDraft,labels']));
  const unreadable = [];
  const prs = hydrate(candidates, { json: ghJson, onError: (n) => unreadable.push(n) });
  const found = redUnreviewed(prs);
  found.unreadable.push(...unreadable);
  const text = report(found);
  console.log(text);
  for (const f of found.flagged) {
    console.log(`::warning title=red and unreviewed::PR #${f.number} has been red (${f.failed.join(', ')}) with no review verdict on ${String(f.sha).slice(0, 7)} for over ${AWAITING_REVIEW_HOURS}h — ${f.review} (RA-1723)`);
  }
  // Annotated as well as summarised, like `review-recovery.mjs`: the guarantee that an
  // unreadable PR is not green must live where a reader of a green tick looks.
  for (const n of found.conflicting) {
    console.log(`::warning title=red and unreviewed::PR #${n} shows no checks past the stall window because it conflicts with its base — ${CONFLICT_WHY}`);
  }
  for (const n of found.unreadable) {
    console.log(`::warning title=red and unreviewed::could not read PR #${n}, or it shows no checks at all past the stall window, so whether it is red is UNKNOWN (RA-1723)`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    execFileSync('bash', ['-c', 'cat >> "$GITHUB_STEP_SUMMARY"'], { input: text });
  }
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) main();
