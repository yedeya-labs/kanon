// The flow of a work item: its lead time, split into stages (plan 0003 §3.3, group 2).
//
// EVERY SECOND OF THE LEAD TIME GOES TO EXACTLY ONE STAGE, so the stages sum to `lead_time_s`.
// Where the stages' intervals overlap, the first in this order wins:
//
//   1 human        `needs:human` labelled → unlabelled, closed or merged; or, for an item the
//                  Merger may not merge, approved with green checks → a human review, a human
//                  commit, or the close (which, for such an item, a human made)
//   2 merge_queue  `added_to_merge_queue` → `removed_from_merge_queue`, or the close
//   3 agent        a non-Reviewer lane run: the workflow run's start → end
//   4 review       `review:please` labelled, or a Reviewer run's start → the Reviewer's verdict
//   5 ci           the first check run's start on a head commit → its last required check's end
//   6 rework       a `changes_requested` verdict → the next push
//   7 queue        `dispatched_at` → the first lane run's start
//   8 other        everything left
//
// Human wait comes first so that a human wait overlapping, say, a CI run is still human wait:
// "waiting for a human" means a human is the only party who can move the item.
//
// TWO STEPS, SO THE RULE IS TESTABLE ON ITS OWN. `stageIntervals` reads the item's events into
// intervals, one stage each; `partitionStages` turns any intervals into the row's durations.
// Durations are whole seconds: every time is floored to its second before anything is
// subtracted, so the parts and the whole are computed from the same integers and sum exactly.
// `partitionProblem` is the invariant, which `workItemRow` checks on every row it builds. An
// error names what is wrong, never the value, as the schema's rejections do.

import { LANE_ROLES } from '../../actions/agent-telemetry/schema.mjs';
import { classifyActor } from './actors.mjs';

/** The stages, in the order that wins an overlap. */
export const STAGE_ORDER = /** @type {const} */ (['human', 'merge_queue', 'agent', 'review', 'ci', 'rework', 'queue', 'other']);

/** @typedef {typeof STAGE_ORDER[number]} Stage */

/** Each stage's row field. @type {Readonly<Record<Stage, string>>} */
export const STAGE_FIELDS = Object.freeze({
  human: 't_human_s',
  merge_queue: 't_merge_queue_s',
  agent: 't_agent_s',
  review: 't_review_s',
  ci: 't_ci_s',
  rework: 't_rework_s',
  queue: 't_queue_s',
  other: 't_other_s',
});

/** The labels that dispatch an issue to the Implementer (`rulebook/labels.json`). */
export const DISPATCH_LABELS = Object.freeze(['agent:implement', 'agent:triage']);

/**
 * A time as whole seconds since the epoch, floored. Throws on a string that isn't a time,
 * because a stage computed from one would be silently wrong.
 * @param {string} iso
 */
export function seconds(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError('a stage time is not a time');
  return Math.floor(ms / 1000);
}

/**
 * @typedef {{ stage: Exclude<Stage, 'other'>, start: string, end: string }} StageInterval
 * @typedef {{ start: string, end: string }} Window
 */

/**
 * The lead time split into stages (§3.3). Each interval is clipped to the window; where
 * intervals overlap, the stage earliest in `STAGE_ORDER` takes the second; a second no
 * interval covers is `other`. `human_waits` is the number of separate stretches the `human`
 * stage holds, after overlapping and touching `human` intervals are joined.
 * @param {Window} window `start` is `dispatched_at`, or `opened_at` when not dispatched; `end`
 *   is `closed_at`
 * @param {readonly StageInterval[]} intervals
 * @returns {Record<string, number>} `lead_time_s`, each `t_<stage>_s`, and `human_waits`
 */
export function partitionStages(window, intervals) {
  const s = seconds(window.start);
  const e = seconds(window.end);
  if (e < s) throw new RangeError('the lead time ends before it starts');
  const clipped = intervals.map((i) => {
    if (!STAGE_ORDER.includes(i.stage) || i.stage === /** @type {string} */ ('other')) {
      throw new RangeError('an interval names no stage it can open');
    }
    return { rank: STAGE_ORDER.indexOf(i.stage), a: Math.max(seconds(i.start), s), b: Math.min(seconds(i.end), e) };
  }).filter((i) => i.a < i.b);
  const points = [...new Set([s, e, ...clipped.flatMap((i) => [i.a, i.b])])].sort((x, y) => x - y);
  /** @type {Record<string, number>} */
  const totals = Object.fromEntries(STAGE_ORDER.map((st) => [st, 0]));
  let waits = 0;
  let inHuman = false;
  for (let k = 0; k + 1 < points.length; k += 1) {
    const p = /** @type {number} */ (points[k]);
    const q = /** @type {number} */ (points[k + 1]);
    // Every interval's ends are among the points, so one either covers [p, q) whole or not at all.
    const rank = clipped.reduce((best, i) => (i.a <= p && q <= i.b && i.rank < best ? i.rank : best), STAGE_ORDER.length - 1);
    const stage = /** @type {Stage} */ (STAGE_ORDER[rank]);
    totals[stage] = /** @type {number} */ (totals[stage]) + (q - p);
    if (stage === 'human' && !inHuman) waits += 1;
    inHuman = stage === 'human';
  }
  return { lead_time_s: e - s, ...Object.fromEntries(STAGE_ORDER.map((st) => [STAGE_FIELDS[st], totals[st]])), human_waits: waits };
}

/**
 * Why a row's stages don't partition its lead time, or null when they do: every stage field
 * present with the lead time, and summing to it exactly. A row with none of them is fine
 * (group 2 unknown).
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
export function partitionProblem(row) {
  const fields = Object.values(STAGE_FIELDS);
  const present = fields.filter((f) => Object.hasOwn(row, f));
  const hasLead = Object.hasOwn(row, 'lead_time_s');
  if (!hasLead && present.length === 0) return null;
  if (!hasLead) return 'stage durations without a lead time';
  if (present.length !== fields.length) return `the lead time without ${fields.filter((f) => !present.includes(f)).join(', ')}`;
  const sum = fields.reduce((acc, f) => acc + Number(row[f]), 0);
  return sum === row.lead_time_s ? null : `the stages sum to ${sum} seconds, not the lead time's ${row.lead_time_s}`;
}

/**
 * When the first closing issue was dispatched: the first `labeled` event of a dispatch label
 * on its timeline, at or before the close. `null` when the PR closes no issue, or the issue
 * was never dispatched; undefined when its timeline wasn't read.
 * @param {import('./types.mjs').PullRequest} pr
 * @returns {string | null | undefined}
 */
export function dispatchedAt(pr) {
  if (!pr.closing_issues) return undefined;
  const issue = pr.closing_issues[0];
  if (!issue) return null;
  if (!issue.timeline) return undefined;
  const end = pr.closed_at ? seconds(pr.closed_at) : Infinity;
  const hit = issue.timeline
    .filter((ev) => ev.event === 'labeled' && DISPATCH_LABELS.includes(ev.label ?? '') && seconds(ev.created_at) <= end)
    .sort((x, y) => seconds(x.created_at) - seconds(y.created_at))[0];
  return hit ? hit.created_at : null;
}

/** The verdict states a review can carry. */
const VERDICT_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED']);

/**
 * The Reviewer's verdicts, oldest first: reviews by the Reviewer's App (its marker, or, when
 * the Judge App's review has none, the action's role) with an approval or a change request.
 * @param {readonly import('./types.mjs').Review[]} reviews
 * @param {Map<string, string>} register
 */
export function reviewerVerdicts(reviews, register) {
  return reviews
    .filter((r) => VERDICT_STATES.has(r.state) && classifyActor(r.author, register, { body: r.body, expect: 'reviewer' }) === 'reviewer')
    .sort((x, y) => seconds(x.submitted_at) - seconds(y.submitted_at));
}

/**
 * The item's stage intervals, read from its events (§3.3). Each source is used only when the
 * reader fetched it: no `runs`, no `agent` or `queue` intervals; no `check_runs`, no `ci`.
 * @param {import('./types.mjs').WorkItemInput} input
 * @returns {StageInterval[]}
 */
export function stageIntervals(input) {
  const { pr, runs, check_runs: checks, merger_blocked: blocked, declarations: { register } } = input;
  const closed = /** @type {string} */ (pr.closed_at);
  const timeline = [...(pr.timeline ?? [])].sort((x, y) => seconds(x.created_at) - seconds(y.created_at));
  const reviews = pr.reviews ?? [];
  const verdicts = reviewerVerdicts(reviews, register);
  const at = (/** @type {string} */ t) => seconds(t);
  /** The first event of `name` strictly after `t`, or the close. */
  const nextOr = (/** @type {(ev: import('./types.mjs').TimelineEvent) => boolean} */ match, /** @type {string} */ t) =>
    timeline.find((ev) => match(ev) && at(ev.created_at) > at(t))?.created_at ?? closed;
  /** @type {StageInterval[]} */
  const out = [];

  // 1. human: `needs:human` on the PR.
  for (const ev of timeline) {
    if (ev.event !== 'labeled' || ev.label !== 'needs:human') continue;
    out.push({ stage: 'human', start: ev.created_at, end: nextOr((x) => x.event === 'unlabeled' && x.label === 'needs:human', ev.created_at) });
  }
  // 1. human: an item the Merger may not merge, approved with green checks.
  const standing = verdicts.at(-1);
  if (blocked && standing?.state === 'APPROVED' && checks) {
    const required = checks.filter((c) => c.head_sha === standing.commit_id && c.required);
    const green = required.every((c) => c.completed_at && ['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''));
    if (green) {
      const ends = required.map((c) => at(/** @type {string} */ (c.completed_at)));
      const start = Math.max(at(standing.submitted_at), ...ends);
      const human = (/** @type {import('./types.mjs').Actor | null} */ a) => classifyActor(a, register) === 'human';
      const after = [
        ...reviews.filter((r) => human(r.author) && at(r.submitted_at) > start).map((r) => at(r.submitted_at)),
        ...(pr.commits ?? []).filter((c) => (human(c.author) || human(c.committer)) && at(c.committed_at) > start).map((c) => at(c.committed_at)),
      ];
      const end = Math.min(at(closed), ...after);
      out.push({ stage: 'human', start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() });
    }
  }
  // 2. merge_queue.
  for (const ev of timeline) {
    if (ev.event !== 'added_to_merge_queue') continue;
    out.push({ stage: 'merge_queue', start: ev.created_at, end: nextOr((x) => x.event === 'removed_from_merge_queue', ev.created_at) });
  }
  // 3. agent, and 4. review from the Reviewer's runs.
  for (const run of runs ?? []) {
    if (!Object.hasOwn(LANE_ROLES, run.lane)) throw new RangeError("a lane run names no lane of Kanon's");
    if (LANE_ROLES[run.lane] !== 'reviewer') { out.push({ stage: 'agent', start: run.started_at, end: run.completed_at }); continue; }
    const verdict = verdicts.find((v) => at(v.submitted_at) >= at(run.started_at) && at(v.submitted_at) <= at(run.completed_at));
    out.push({ stage: 'review', start: run.started_at, end: verdict?.submitted_at ?? run.completed_at });
  }
  // 4. review: `review:please` → the next verdict.
  for (const ev of timeline) {
    if (ev.event !== 'labeled' || ev.label !== 'review:please') continue;
    const verdict = verdicts.find((v) => at(v.submitted_at) > at(ev.created_at));
    out.push({ stage: 'review', start: ev.created_at, end: verdict?.submitted_at ?? closed });
  }
  // 5. ci: per head commit, the first check's start → the last required check's end.
  /** @type {Map<string, import('./types.mjs').CheckRun[]>} */
  const byHead = new Map();
  for (const c of checks ?? []) byHead.set(c.head_sha, [...(byHead.get(c.head_sha) ?? []), c]);
  for (const runsOnHead of byHead.values()) {
    const ends = runsOnHead.filter((c) => c.required && c.completed_at).map((c) => at(/** @type {string} */ (c.completed_at)));
    if (ends.length === 0) continue;
    const start = Math.min(...runsOnHead.map((c) => at(c.started_at)));
    out.push({ stage: 'ci', start: new Date(start * 1000).toISOString(), end: new Date(Math.max(...ends) * 1000).toISOString() });
  }
  // 6. rework: a change request → the next push (a commit's committer date, or a force-push).
  for (const v of verdicts) {
    if (v.state !== 'CHANGES_REQUESTED') continue;
    const pushes = [
      ...(pr.commits ?? []).map((c) => at(c.committed_at)),
      ...timeline.filter((ev) => ev.event === 'head_ref_force_pushed').map((ev) => at(ev.created_at)),
    ].filter((t) => t > at(v.submitted_at));
    const end = pushes.length ? new Date(Math.min(...pushes) * 1000).toISOString() : closed;
    out.push({ stage: 'rework', start: v.submitted_at, end });
  }
  // 7. queue: dispatch → the first lane run's start.
  const dispatched = dispatchedAt(pr);
  if (dispatched && runs) {
    const first = runs.map((r) => at(r.started_at)).filter((t) => t >= at(dispatched)).sort((x, y) => x - y)[0];
    if (first !== undefined) out.push({ stage: 'queue', start: dispatched, end: new Date(first * 1000).toISOString() });
  }
  return out;
}
