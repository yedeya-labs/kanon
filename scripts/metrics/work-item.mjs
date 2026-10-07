// One pull request's work-item row (plan 0003 §3.3): derived from the plain input
// (`types.mjs`), validated against the telemetry schema, and returned whole or not at all.
//
// THE ROW IS ONE DERIVATION. The work-item step rewrites a row by deriving it again from
// GitHub, never by patching a field (§3.1), so this is the only place a row is assembled, and
// it re-derives every field each time.
//
// ABSENT MEANS UNKNOWN, NEVER ZERO (§3.1). A field whose source the reader didn't fetch is
// left out: no `files`, no group-1 counts or band; no `reviews`, no review fields; no `runs`,
// no `agent` or `queue` stage. A field that needs a source no reader has yet (`ac_count` and
// `spec_clauses_cited` need the adopter's criteria format and spec prefixes, `escalation_reasons`
// the Merger's comments, `review_comments` the inline comments, `recoveries` the retry
// script's dispatches, `guard_failures` the guards' check names) is left for the step that
// reads it.
//
// THE ROW CARRIES NO LOGIN, PATH OR TEXT. Every value below is a count, a time, an enum, a
// class or a number. `validate` is the enforcement: it rejects any field outside the schema's
// list, so a slip here fails the row rather than sending content. And `checkWorkItemRow` adds
// the one invariant the schema can't state field by field: the stages sum to the lead time.

import { describeErrors, validate } from '../../actions/agent-telemetry/schema.mjs';
import { issueSize } from '../../actions/agent-telemetry/agent-telemetry.mjs';
import { classifyActor, isAgentClass } from './actors.mjs';
import { areaCounts, escalationFlags } from './areas.mjs';
import { BAND_VERSION, bandOf, diffSize } from './band.mjs';
import { originOf } from './origin.mjs';
import { dispatchedAt, partitionProblem, partitionStages, reviewerVerdicts, seconds, stageIntervals } from './stages.mjs';

/** The closing issues and linked PRs a row lists at most (the schema's pattern, §3.4). */
const MAX_NUMBERS = 20;

/** The label families whose changes by a person count as interventions (§3.3, group 5). */
const INTERVENTION_LABELS = /^(?:agent|review|needs|qa):/;

/** A failed check conclusion. */
const FAILED = new Set(['failure', 'timed_out']);

/** The `sev:*` labels a follow-up is counted under. */
const SEVERITIES = /** @type {const} */ (['critical', 'high', 'medium', 'low']);

/** A time as the row stores it: ISO-8601 UTC, to the second. @param {string} t */
const utc = (t) => new Date(seconds(t) * 1000).toISOString().replace(/\.000Z$/, 'Z');

/** A row field set only when its value is known. @param {Record<string, unknown>} row @param {Record<string, unknown>} fields */
const put = (row, fields) => {
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) row[k] = v;
};

/** Thrown when the input can't make a valid row; the message names fields, never values. */
export class WorkItemError extends Error {}

/**
 * Validates a work-item row against the schema, and checks that its stages partition its lead
 * time (§3.3, group 2). The answer names fields only.
 * @param {Record<string, unknown>} row
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function checkWorkItemRow(row) {
  const v = validate(row);
  if (!v.ok) return { ok: false, why: describeErrors(v.errors) };
  const p = partitionProblem(row);
  return p ? { ok: false, why: `stage partition: ${p}` } : { ok: true };
}

/**
 * The reviews, commits and labels a human contributed, on what the reader fetched.
 * @param {import('./types.mjs').WorkItemInput} input
 * @param {string | undefined} authorKind
 */
function accuracyFields(input, authorKind) {
  const { pr, declarations: { register } } = input;
  /** @type {Record<string, unknown>} */
  const out = {};
  const human = (/** @type {import('./types.mjs').Actor | null | undefined} */ a) => classifyActor(a, register) === 'human';
  if (pr.reviews) {
    const verdicts = reviewerVerdicts(pr.reviews, register);
    const first = verdicts[0];
    out.first_verdict = first ? (first.state === 'APPROVED' ? 'approved' : 'changes_requested') : 'none';
    out.review_rounds = verdicts.length;
    out.human_reviews = pr.reviews.filter((r) => human(r.author)).length;
    const approved = verdicts.find((v) => v.state === 'APPROVED');
    out.human_cr_after_approval = approved
      ? pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED' && human(r.author) && seconds(r.submitted_at) > seconds(approved.submitted_at)).length
      : 0;
    if (pr.commits && pr.timeline) {
      const pushes = [
        ...pr.commits.map((c) => seconds(c.committed_at)),
        ...pr.timeline.filter((ev) => ev.event === 'head_ref_force_pushed').map((ev) => seconds(ev.created_at)),
      ];
      let acted = 0;
      let withdrawn = 0;
      verdicts.forEach((v, k) => {
        if (v.state !== 'CHANGES_REQUESTED') return;
        const next = verdicts[k + 1];
        const until = next ? seconds(next.submitted_at) : Infinity;
        if (pushes.some((t) => t > seconds(v.submitted_at) && t < until)) acted += 1;
        else if (next?.state === 'APPROVED' && next.commit_id === v.commit_id) withdrawn += 1;
      });
      out.cr_acted = acted;
      out.cr_withdrawn = withdrawn;
    }
    if (input.check_runs) {
      const before = first ? seconds(first.submitted_at) : Infinity;
      out.ci_failures_before_review = input.check_runs.filter((c) =>
        c.required && FAILED.has(c.conclusion ?? '') && c.completed_at && seconds(c.completed_at) < before).length;
    }
  }
  if (pr.commits && isAgentClass(authorKind)) {
    out.human_commits = pr.commits.filter((c) => human(c.author) || human(c.committer)).length;
  }
  if (pr.timeline) {
    out.escalations = pr.timeline.filter((ev) => ev.event === 'labeled' && ev.label === 'needs:human').length;
    out.force_pushes = pr.timeline.filter((ev) => ev.event === 'head_ref_force_pushed').length;
    if (out.human_reviews !== undefined && (pr.commits || !isAgentClass(authorKind))) {
      const labels = pr.timeline.filter((ev) =>
        (ev.event === 'labeled' || ev.event === 'unlabeled') && INTERVENTION_LABELS.test(ev.label ?? '') && human(ev.actor)).length;
      out.human_interventions = /** @type {number} */ (out.human_commits ?? 0) + /** @type {number} */ (out.human_reviews) + labels;
    }
  }
  return out;
}

/**
 * The row's Reviewer follow-up counts (§3.3, group 4), from the follow-ups the reader found.
 * @param {readonly import('./types.mjs').FollowUp[]} followups
 */
function followupFields(followups) {
  /** @type {Record<string, number>} */
  const out = { followups_filed: followups.length };
  for (const s of SEVERITIES) out[`followups_sev_${s}`] = followups.filter((f) => f.labels.includes(`sev:${s}`)).length;
  out.followups_completed = followups.filter((f) => f.state === 'closed' && f.state_reason === 'completed').length;
  out.followups_not_planned = followups.filter((f) => f.state === 'closed' && f.state_reason === 'not_planned').length;
  out.followups_open = followups.filter((f) => f.state === 'open').length;
  return out;
}

/**
 * The work-item row of one closed pull request (§3.3), validated. Throws `WorkItemError` for
 * a PR still open (it has no row yet, §3.1) or a row the schema or the stage invariant rejects.
 * @param {import('./types.mjs').WorkItemInput} input
 * @returns {Record<string, unknown>}
 */
export function workItemRow(input) {
  const { pr, declarations } = input;
  const { register, codeAreas, escalationFile } = declarations;
  if (pr.state !== 'closed' || !pr.closed_at) throw new WorkItemError(`PR #${pr.number} is not closed, so it has no work-item row yet`);

  /** @type {Record<string, unknown>} */
  const row = {
    schema_version: 1,
    row_kind: 'work_item',
    tag: input.tag,
    recorded_at: utc(input.recorded_at),
    pr_number: pr.number,
    opened_at: utc(pr.created_at),
    closed_at: utc(pr.closed_at),
    fate: pr.merged_at ? 'merged' : 'closed_unmerged',
  };
  const dispatched = dispatchedAt(pr);
  put(row, {
    closing_issues: pr.closing_issues?.length ? pr.closing_issues.slice(0, MAX_NUMBERS).map((i) => i.number).join(',') : undefined,
    dispatched_at: dispatched ? utc(dispatched) : undefined,
    kanon_version: input.kanon_version,
  });

  // Group 1.
  if (pr.files) {
    const size = diffSize(pr.files);
    put(row, size);
    put(row, areaCounts(pr.files, { codeAreas, escalationFile }));
    if (escalationFile) put(row, escalationFlags(escalationFile, pr.files));
    put(row, { band: bandOf(size, BAND_VERSION), band_version: BAND_VERSION });
  }
  const issue = pr.closing_issues?.[0];
  if (issue) {
    // GitHub sends an empty body as null, which is 0 characters; an unread one is undefined.
    const { issue_body_chars: chars, issue_paths_named: named } = issueSize(issue.body === undefined ? undefined : issue.body ?? '');
    put(row, { issue_body_chars: chars, issue_paths_named: named, blocked_by_count: issue.blocked_by });
  }
  const authorKind = classifyActor(pr.author, register, { body: pr.body, expect: 'implementer' });
  put(row, {
    origin: originOf(pr, register),
    author_kind: authorKind,
    commits: pr.commits?.length,
  });

  // Group 2: known only when the window's start is (`dispatched_at`, or `opened_at` when not
  // dispatched) and the item didn't close before it.
  if (dispatched !== undefined) {
    const start = dispatched ?? pr.created_at;
    if (seconds(start) <= seconds(pr.closed_at)) {
      put(row, partitionStages({ start, end: pr.closed_at }, stageIntervals(input)));
    }
  }
  put(row, { wip_at_dispatch: input.wip_at_dispatch });

  // Groups 3 to 5.
  put(row, accuracyFields(input, authorKind));
  const links = input.links ?? {};
  put(row, {
    revert_pr: links.revert_pr,
    revert_days: links.revert_days,
    fix_prs: links.fix_prs?.length ? links.fix_prs.slice(0, MAX_NUMBERS).join(',') : undefined,
    first_fix_days: links.first_fix_days,
  });
  if (input.followups) put(row, followupFields(input.followups));
  if (pr.merged_at) {
    const merger = pr.merged_by ?? pr.timeline?.find((ev) => ev.event === 'merged')?.actor;
    put(row, { merged_by: classifyActor(merger, register, { expect: 'merger' }) });
  }

  const check = checkWorkItemRow(row);
  if (!check.ok) throw new WorkItemError(`PR #${pr.number}'s work-item row is invalid: ${check.why}`);
  return row;
}
