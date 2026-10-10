// The work-item rows of a set of pull requests (plan 0003 §3.3, §3.5), derived one way for every
// reader: the dry run (`kanon metrics dry-run`, M2) and the collector's work-item step (M4,
// kanon#658) both call this, so a row the collector sends is the row the dry run counted.
//
// WHAT IT DOES, IN ORDER.
//   1. Leaves out release PRs (§1.2, kanon#538) and any merged PR the detectors can't judge
//      (`toDetectorPr`): a merged PR without its files, commits, closing issues or timeline.
//   2. Runs the revert and linked-fix detectors over every PR it was given, the items and the
//      `context` together, so an item's later revert or fix is found when it is among them.
//   3. Builds each item's row with `workItemRow`, its links and its Reviewer follow-ups
//      (`followupsOf`) beside it. A row the schema or the stage invariant rejects is reported
//      by its fields, never sent.
//
// `context` holds PRs read only for the detectors: the collector passes the later PRs that may
// revert or fix an item it derives again (§3.5), and no row is built for them.
//
// PURE: no network, no file.

import { toDetectorPr } from './adapter.mjs';
import { accuracyFields, codeAreaTest } from './detectors.mjs';
import { followupsOf } from './followups.mjs';
import { isReleasePr } from './release.mjs';
import { WorkItemError, workItemRow } from './work-item.mjs';

/**
 * @typedef {{ pr: number, reason: 'release' | 'unreadable' }} LeftOut
 * @typedef {{
 *   rows: Record<string, unknown>[],
 *   invalid: { pr: number, fields: string[] }[],
 *   leftOut: LeftOut[],
 *   prs: import('./types.mjs').PullRequest[],
 *   dprs: import('./detectors.mjs').DetectorPr[],
 *   isCode: (path: string) => boolean,
 * }} Derived
 */

/**
 * The work-item rows of `prs`.
 * @param {import('./types.mjs').PullRequest[]} prs the items, each closed
 * @param {{
 *   declarations: import('./types.mjs').Declarations,
 *   repo: string,
 *   tag?: 'run' | 'smoke' | 'test',
 *   recordedAt: string,
 *   kanonVersion?: string | ((pr: import('./types.mjs').PullRequest) => string | undefined),
 *   context?: import('./types.mjs').PullRequest[],
 * }} opts
 * @returns {Derived}
 */
export function deriveRows(prs, { declarations, repo, tag = 'run', recordedAt, kanonVersion, context = [] }) {
  /** @type {LeftOut[]} */
  const leftOut = [];
  /** @type {import('./types.mjs').PullRequest[]} */
  const kept = [];
  /** @type {import('./detectors.mjs').DetectorPr[]} */
  const dprs = [];
  for (const pr of prs) {
    if (isReleasePr(pr, declarations.register)) {
      leftOut.push({ pr: pr.number, reason: 'release' });
      continue;
    }
    try {
      dprs.push(toDetectorPr(pr));
      kept.push(pr);
    } catch {
      leftOut.push({ pr: pr.number, reason: 'unreadable' });
    }
  }
  const items = new Set(kept.map((p) => p.number));
  /** @type {import('./detectors.mjs').DetectorPr[]} */
  const more = [];
  for (const pr of context) {
    if (items.has(pr.number) || isReleasePr(pr, declarations.register)) continue;
    try {
      more.push(toDetectorPr(pr));
    } catch {
      // A context PR the detectors can't judge links nothing; the item it might link is still derived.
    }
  }
  const all = [...dprs, ...more];
  const isCode = codeAreaTest({ codeAreas: declarations.codeAreas, escalationFile: declarations.escalationFile });

  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {{ pr: number, fields: string[] }[]} */
  const invalid = [];
  kept.forEach((pr, k) => {
    const links = pr.merged_at ? accuracyFields(/** @type {import('./detectors.mjs').DetectorPr} */ (dprs[k]), all, { repo, isCode }) : {};
    const version = typeof kanonVersion === 'function' ? kanonVersion(pr) : kanonVersion;
    const followups = followupsOf(pr, repo);
    try {
      rows.push(workItemRow({
        pr, declarations, tag, recorded_at: recordedAt, links,
        ...(version === undefined ? {} : { kanon_version: version }),
        ...(followups === undefined ? {} : { followups }),
      }));
    } catch (e) {
      if (!(e instanceof WorkItemError)) throw e;
      invalid.push({ pr: pr.number, fields: e.fields.length ? e.fields : ['(row)'] });
    }
  });
  return { rows, invalid, leftOut, prs: kept, dprs, isCode };
}
