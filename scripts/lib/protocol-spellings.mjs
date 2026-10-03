// The strings another program reads by their exact text, in one place (#53).
//
// Each protocol below has ONE current spelling, which every writer uses, and the
// spellings it had before, which readers still accept. The old spellings came from the
// reference adopter: its agents' persona names, its caller workflows' names and its issue
// numbers. A reader that dropped them while a live pull request, branch, issue or run
// still carried one would misread that artifact (a Merger that waits on itself, a second
// escalation comment, a second split of one issue, a capped run read as a real failure),
// so they are dropped by a measurement, not a date:
//
//   `node "$KANON/scripts/protocol-census.mjs"`, run in the adopter's repository, lists
//   every live artifact that still carries an old spelling. When it lists none, a Kanon
//   release deletes every `LEGACY_*` entry below and `protocol-spellings.test.ts` tightens
//   to "no persona name anywhere in the library".
//
// Until then this file is the only place in Kanon's library allowed to hold a persona
// name or an adopter's workflow name; the library test holds every other file to that.

/** The comment the Merger leaves once per (rule, head), and reads back to stay quiet. */
export const MERGER_MARKER = 'merger';
const LEGACY_MERGER_MARKERS = ['joshua'];
export const MERGER_MARKERS = Object.freeze([MERGER_MARKER, ...LEGACY_MERGER_MARKERS]);

/** The marker a writer leaves: always the current spelling. */
export const mergerMarker = (/** @type {string} */ rule, /** @type {string} */ sha) => `<!-- ${MERGER_MARKER}:${rule}:${String(sha).slice(0, 12)} -->`;

/** Every spelling of one (rule, head) marker, for a reader asking "was this said?". */
export const mergerMarkerSpellings = (/** @type {string} */ rule, /** @type {string} */ sha) =>
  MERGER_MARKERS.map((m) => `<!-- ${m}:${rule}:${String(sha).slice(0, 12)} -->`);

/** Every marker in a comment body, in any spelling, as `{rule, sha}`. */
export const mergerMarkersIn = (/** @type {unknown} */ body) =>
  [...String(body ?? '').matchAll(new RegExp(`<!-- (?:${MERGER_MARKERS.join('|')}):([a-z-]+):([0-9a-f]{7,40}) -->`, 'g'))]
    .map((m) => ({ rule: m[1], sha: m[2] }));

/** The first line of the Merger's escalation comment. */
export const ESCALATION_HEADER = '🚦 **Merger — not merging.**';
const LEGACY_ESCALATION_HEADERS = ['🚦 **Joshua — not merging.**'];
export const ESCALATION_HEADERS = Object.freeze([ESCALATION_HEADER, ...LEGACY_ESCALATION_HEADERS]);
export const isEscalation = (/** @type {unknown} */ body) => ESCALATION_HEADERS.some((h) => String(body ?? '').includes(h));

/** The branch the split lane opens its pull request from, per issue. */
export const splitBranch = (/** @type {number|string} */ issue) => `lead/split-${issue}`;
const LEGACY_SPLIT_PREFIXES = ['bezalel/split-'];
/** Every branch a split of this issue may be on: the current one first. */
export const splitBranches = (/** @type {number|string} */ issue) => [splitBranch(issue), ...LEGACY_SPLIT_PREFIXES.map((p) => `${p}${issue}`)];

/** The sentence the Lead writes into an issue it adopts into a project, and looks for so it
 *  writes it once. */
export const adoptedNote = (/** @type {number|string} */ project) => `Adopted into project #${project} by the Lead`;
const LEGACY_ADOPTED_BY = ['Bezalel'];
export const adoptedNotes = (/** @type {number|string} */ project) => [adoptedNote(project), ...LEGACY_ADOPTED_BY.map((by) => `Adopted into project #${project} by ${by}`)];

/**
 * The adopter's CALLER workflow names the merge gate recognises. GitHub reports a called
 * lane's check runs under the caller's `name:`, so Kanon cannot name them; `docs/lanes.md`
 * asks the adopter for these role names, the names of Kanon's own lane workflows.
 *
 * `SELF_CHECKS`: the review that wakes the Merger and the Merger itself, never waited on.
 * `REVIEW_EVENT_CHECKS`: the jobs that race the Merger on the same review event
 * (`merge-gate.mjs` says why each one is excluded).
 */
export const REVIEW_CALLER = 'Review (Reviewer)';
export const MERGE_CALLER = 'Merge (Merger)';
export const IMPLEMENT_REVISE_CALLER = 'Implement (Implementer) — revise';
export const MERGE_RECONCILE_CALLER = 'Merge Reconcile (Reviewer)';
const LEGACY_SELF_CHECKS = ['Review (Thomas)', 'Merge (Joshua)'];
const LEGACY_REVIEW_EVENT_CHECKS = [
  { workflow: 'Implement (Oholiab) — revise', job: 'revise / filter' },
  { workflow: 'Merge Reconcile (Thomas)', job: 'reconcile / filter' },
];
export const SELF_CHECKS = Object.freeze([REVIEW_CALLER, MERGE_CALLER, ...LEGACY_SELF_CHECKS]);
export const REVIEW_EVENT_CHECKS = Object.freeze([
  { workflow: IMPLEMENT_REVISE_CALLER, job: 'revise / filter' },
  { workflow: MERGE_RECONCILE_CALLER, job: 'reconcile / filter' },
  ...LEGACY_REVIEW_EVENT_CHECKS,
]);

/**
 * The no-op steps a lane runs when its classify step reported a retryable failure, per
 * classification. The names ARE the protocol: the recoveries read a failed run's jobs by
 * step name. Kanon's lanes write the current spelling; a run from before it carries one
 * of the old ones, which named the reference adopter's issue.
 */
export const RETRY_STEPS = Object.freeze({
  unreachable: 'Retryable once the cause clears: the model was unreachable',
  api_error: 'Retryable once the cause clears: the model API failed mid-run',
});
const LEGACY_RETRY_SUFFIXES = [' (RA-2519)', ' (#2519)'];
export const RETRY_STEP_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(RETRY_STEPS).map(([k, v]) => [k, Object.freeze([v, ...LEGACY_RETRY_SUFFIXES.map((s) => `${v}${s}`)])]),
));

/** Every old spelling, by protocol, for the census. */
export const LEGACY = Object.freeze({
  mergerMarkers: LEGACY_MERGER_MARKERS,
  escalationHeaders: LEGACY_ESCALATION_HEADERS,
  splitPrefixes: LEGACY_SPLIT_PREFIXES,
  adoptedBy: LEGACY_ADOPTED_BY,
  selfChecks: LEGACY_SELF_CHECKS,
  reviewEventChecks: LEGACY_REVIEW_EVENT_CHECKS,
  retrySteps: Object.values(RETRY_STEP_NAMES).flatMap((names) => names.slice(1)),
});
