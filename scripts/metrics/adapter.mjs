// The one place the metrics module's two spellings of a pull request meet (plan 0003 M2,
// kanon#516, kanon#527).
//
// A READER FILLS ONE SHAPE. Whoever reads GitHub (the dry run, later the collector's work-item
// step) builds `types.mjs`'s `PullRequest`, in the REST API's spelling, which `workItemRow` and
// the actor, origin and stage functions read. The revert and linked-fix detectors
// (`detectors.mjs`) read their own `DetectorPr`, in camelCase, with only the fields they need.
// `toDetectorPr` maps the first to the second, field by field, so no reader builds both and
// neither module's names leak into the other.
//
// ABSENT IS NOT EMPTY. `types.mjs` leaves a list out when the reader couldn't fetch it, and the
// detectors read a missing list as an empty one: an unread file list would make a fix share no
// code file, and an unread timeline would make an item cross-referenced by nothing. So a merged
// pull request without its files, commits, closing issues or timeline is refused, by name,
// rather than counted as linking nothing.
//
// THE CROSS-REFERENCE'S REPOSITORY IS CARRIED THROUGH. The detector reads a source with no
// repository as this repository, so a reader always fills it (`TimelineEvent.source.repository`),
// and this adapter passes it on unchanged (kanon#527).

/** The lists the detectors read, each required on a merged pull request. */
const REQUIRED = /** @type {const} */ (['files', 'commits', 'closing_issues', 'timeline']);

/** Thrown when a pull request lacks a list the detectors read; the message names the field. */
export class AdapterError extends Error {}

/**
 * The detectors' view of one pull request (`detectors.mjs`'s `DetectorPr`).
 * @param {import('./types.mjs').PullRequest} pr
 * @returns {import('./detectors.mjs').DetectorPr}
 */
export function toDetectorPr(pr) {
  if (pr.merged_at) {
    const missing = REQUIRED.filter((f) => pr[f] === undefined);
    if (missing.length) throw new AdapterError(`PR #${pr.number} is merged but its ${missing.join(', ')} weren't read, so the detectors can't judge it`);
  }
  return {
    number: pr.number,
    ...(pr.title === undefined ? {} : { title: pr.title }),
    body: pr.body ?? null,
    mergedAt: pr.merged_at ?? null,
    createdAt: pr.created_at ?? null,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    ...(pr.parent_sha ? { parentSha: pr.parent_sha } : {}),
    commits: (pr.commits ?? []).map((c) => ({ sha: c.sha, message: c.message })),
    files: (pr.files ?? []).map((f) => ({
      path: f.path,
      ...(f.previous_path ? { previousPath: f.previous_path } : {}),
      status: f.status,
      ...(f.patch === undefined ? {} : { patch: f.patch }),
      ...(f.old_ranges === undefined ? {} : { ranges: f.old_ranges }),
    })),
    closingIssues: (pr.closing_issues ?? []).map((i) => ({ number: i.number, labels: i.labels, body: i.body ?? null })),
    timeline: (pr.timeline ?? []).map((ev) => ({
      type: ev.event,
      ...(ev.source ? { source: { number: ev.source.number, repository: ev.source.repository ?? null } } : {}),
    })),
  };
}
