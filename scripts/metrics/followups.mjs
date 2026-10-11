// A pull request's Reviewer follow-ups (plan 0003 §3.3, group 4; M4, kanon#658): the issues
// labelled `follow-up` and `agent:reviewer` that cross-reference it, read from the PR's own
// timeline, each with its state now.
//
// FROM THE PR'S SIDE, ALWAYS. GitHub records a mention of the PR in an issue as a
// `cross-referenced` event on the PR, whose source is the issue. So the PR's timeline is the one
// list of every issue that names it, whichever of the issue's body or comments did, and a row
// derived again later reads every follow-up's fate as it is then. That is what makes a rewrite
// one consistent derivation (§3.1): nothing is carried over from the row before.
//
// ABSENT MEANS UNKNOWN (§3.1). An unread timeline, or an issue source of this repository whose
// labels or state the reader didn't read, leaves every follow-up field out: one unread source
// could be a follow-up, so no count can be trusted. Another repository's issue is never one.
//
// PURE: no network, no file.

/** The two labels a Reviewer follow-up carries (`K-WORK-17`, the Reviewer's playbook). */
export const FOLLOWUP_LABELS = Object.freeze(['follow-up', 'agent:reviewer']);

/** Whether an issue's labels make it a Reviewer follow-up. @param {readonly string[]} labels */
export const isReviewerFollowup = (labels) => FOLLOWUP_LABELS.every((l) => labels.includes(l));

/**
 * The PR's Reviewer follow-ups, in `types.mjs`'s `FollowUp` shape, one per issue, or undefined
 * when they can't be known.
 * @param {import('./types.mjs').PullRequest} pr
 * @param {string} repo `owner/name`
 * @returns {import('./types.mjs').FollowUp[] | undefined}
 */
export function followupsOf(pr, repo) {
  if (!pr.timeline) return undefined;
  /** @type {Map<number, import('./types.mjs').TimelineSource>} */
  const sources = new Map();
  for (const ev of pr.timeline) {
    const s = ev.source;
    if (ev.event !== 'cross-referenced' || !s || s.type !== 'issue') continue;
    if (!s.repository || s.repository.toLowerCase() !== repo.toLowerCase()) continue;
    sources.set(s.number, s);
  }
  /** @type {import('./types.mjs').FollowUp[]} */
  const out = [];
  for (const s of sources.values()) {
    if (!s.labels || !s.state) return undefined;
    if (!isReviewerFollowup(s.labels)) continue;
    out.push({ labels: s.labels, state: s.state, state_reason: s.state_reason ?? null });
  }
  return out;
}
