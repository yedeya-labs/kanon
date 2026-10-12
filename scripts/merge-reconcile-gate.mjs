// The merge-reconcile lane's open-items gate (kanon#177): whether a merged pull request's
// reviews prove there is nothing to reconcile, so the lane can skip its model run.
//
// WHY. About 4 in 5 runs of the merge-reconcile lane filed nothing (the reference adopter, 242
// runs over three weeks, about $0.49 each): a full model pass re-reading the reviews to conclude
// what the Reviewer already knew when it posted them. The review prompt
// (`review-agent-job.yml`) has the Reviewer end every verdict with `<!-- qa:open-items N -->`,
// N being the actionable items it raised, this round or carried over, that are neither applied
// in the head nor filed as an issue. When every review on the pull request is a Reviewer
// verdict, and the latest of them was read on the merged head and declares 0, the lane runs no
// model.
//
// IT SKIPS ONLY ON A PROVEN ZERO. Anything else runs the model as before, with the reason:
//   - a review that is not the Reviewer's: a person's, another App's, or one by the Judge App
//     without the Reviewer's role marker (`asRole`, the way every reader tells the Reviewer's
//     verdicts from the Merger's on the shared login). Its marker, if any, is never read: only
//     the Reviewer's count is a claim the lane trusts, and the other review's items are the
//     model's to reconcile;
//   - no Reviewer verdict at all;
//   - a latest Reviewer verdict whose last `qa:open-items` marker is missing (a verdict from
//     before the marker existed) or garbled, or declares a count above 0. THE LATEST decides,
//     by submission time: its count includes the items carried over from earlier rounds that
//     are still neither applied nor filed, by the prompt's definition, so an earlier round's
//     count is superseded rather than re-read. A pull request whose first round requested
//     changes and whose approval declares 0 is exactly the run #177 removes;
//   - a latest verdict read on an earlier commit than the merged head (a commit landed after
//     it). The commit a verdict read is its `reviewed: sha=` stamp where present, its commit
//     otherwise, the selection the review lane uses (RA-1680);
//   - an unknown merged head, an unknown Reviewer login (the App register could not be read
//     or names no Reviewer), or an answer of a shape this does not expect.
//
// THE LAST MARKER COUNTS, so a verdict quoting the format before declaring its own count is read
// by its own. A review that lands after the merge re-runs the lane's filter on its own event, so
// it is read by the same rule.
//
// Run as a CLI by the lane's `filter` job: the `gh pr view --json mergedAt,reviews,headRefOid`
// answer on standard input, the App register's text (read from the default branch) in
// `REGISTER`. It prints one line of JSON, `{ skip, why, summary }` (the summary only on a skip),
// and never fails: an error prints `{ skip: false, … }`, so the model runs.

import { readFileSync } from 'node:fs';

import { parseAppRegister } from './app-register.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { asRole, slugOf } from './lib/role-marker.mjs';

/** The last `<!-- qa:open-items … -->` comment in a body, its inside captured. */
const MARKER_RE = /<!--\s*qa:open-items\b([^>]*?)-->/g;
/** A marker's inside, well formed: a space, then the count. */
const COUNT_RE = /^\s+(\d+)\s*$/;
/** The review lane's stamp of the commit a verdict read (`scripts/review-trailer.mjs`). */
const STAMP_RE = /<!--\s*reviewed:\s*sha=([0-9a-fA-F]{7,40})/g;

/**
 * The count a body's last open-items marker declares: a number, or `missing` / `garbled`.
 * @param {string} body
 * @returns {number | 'missing' | 'garbled'}
 */
export function openItems(body) {
  const last = [...body.matchAll(MARKER_RE)].at(-1);
  if (!last) return 'missing';
  const m = COUNT_RE.exec(last[1] ?? '');
  return m ? Number(m[1]) : 'garbled';
}

/**
 * The commit a review read: its last stamp, else its commit. Lower case; '' when it names none.
 * @param {{ body: string, commit?: { oid?: unknown } | null }} review
 */
function readAt(review) {
  const stamp = [...review.body.matchAll(STAMP_RE)].at(-1)?.[1];
  const oid = stamp ?? (typeof review.commit?.oid === 'string' ? review.commit.oid : '');
  return oid.toLowerCase();
}

/**
 * @typedef {{ id: string, state: string, at: string, sha: string }} Verdict
 * @typedef {{ skip: true, why: string, latest: Verdict, earlier: number } | { skip: false, why: string }} Decision
 */

/**
 * Whether the lane may skip its model run on a merged pull request. Pure.
 *
 * @param {{ reviews: unknown, head: unknown, reviewer: unknown }} input `reviews` as
 *   `gh pr view --json reviews` gives them, `head` the merged head's SHA, `reviewer` the
 *   Reviewer's App slug from the App register
 * @returns {Decision}
 */
export function openItemsGate({ reviews, head, reviewer }) {
  if (typeof head !== 'string' || !/^[0-9a-fA-F]{40}$/.test(head)) return { skip: false, why: 'the merged head is unknown' };
  if (typeof reviewer !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugOf(reviewer))) {
    return { skip: false, why: "the Reviewer's login is unknown" };
  }
  if (!Array.isArray(reviews)) return { skip: false, why: 'the reviews could not be read' };

  /** @type {Array<{ id: string, state: string, at: string, sha: string, open: number | 'missing' | 'garbled' }>} */
  const verdicts = [];
  for (const r of reviews) {
    if (!r || typeof r !== 'object' || typeof r.body !== 'string' || typeof r.submittedAt !== 'string') {
      return { skip: false, why: 'a review could not be read' };
    }
    const login = r.author?.login;
    if (!asRole('Reviewer', { login, expected: reviewer, body: r.body })) {
      return { skip: false, why: `a review by \`${slugOf(login) || 'unknown'}\` is not the Reviewer's verdict` };
    }
    verdicts.push({
      id: String(r.id ?? '?'), state: String(r.state ?? '?'), at: r.submittedAt, sha: readAt(r), open: openItems(r.body),
    });
  }
  if (verdicts.length === 0) return { skip: false, why: 'the Reviewer posted no verdict' };

  const latest = verdicts.reduce((a, b) => (b.at > a.at ? b : a));
  if (latest.open === 'missing') return { skip: false, why: "the Reviewer's latest verdict carries no open-items marker" };
  if (latest.open === 'garbled') return { skip: false, why: "the Reviewer's latest verdict's open-items marker is garbled" };
  if (latest.open !== 0) return { skip: false, why: "the Reviewer's latest verdict declares open items" };
  if (latest.sha.length < 7 || !head.toLowerCase().startsWith(latest.sha)) {
    return { skip: false, why: "the Reviewer's latest verdict was read before the merged head" };
  }
  const { id, state, at, sha } = latest;
  return {
    skip: true,
    why: `the Reviewer's latest verdict, on ${head.slice(0, 7)}, declares zero open items (kanon#177)`,
    latest: { id, state, at, sha },
    earlier: verdicts.length - 1,
  };
}

/**
 * The step-summary text for a skip: why, and the verdict that decided it, `open-items 0`.
 * @param {{ latest: Verdict, earlier: number }} d a skipping decision
 * @param {string} reviewer
 */
export function skipSummary(d, reviewer) {
  return [
    `**Skipped:** the latest verdict the Reviewer (\`${slugOf(reviewer)}\`) posted on this pull request was read on the merged head and declares zero open items, so no model ran (kanon#177).`,
    '',
    `- review \`${d.latest.id}\`, ${d.latest.state} at ${d.latest.at} on \`${d.latest.sha.slice(0, 7)}\`: \`open-items 0\``,
    `- its count covers the items carried over from the Reviewer's ${d.earlier} earlier verdict${d.earlier === 1 ? '' : 's'}, and every review on the pull request is the Reviewer's`,
  ].join('\n');
}

if (isCliEntry(import.meta.url)) {
  /** @type {Decision} */
  let d;
  let reviewer = '';
  try {
    const state = JSON.parse(readFileSync(0, 'utf8'));
    try {
      reviewer = parseAppRegister(process.env.REGISTER ?? '').get('Reviewer') ?? '';
    } catch {
      reviewer = '';
    }
    d = openItemsGate({ reviews: state?.reviews, head: state?.headRefOid, reviewer });
  } catch {
    d = { skip: false, why: 'the pull request could not be read' };
  }
  process.stdout.write(`${JSON.stringify({ skip: d.skip, why: d.why, summary: d.skip ? skipSummary(d, reviewer) : '' })}\n`);
}
