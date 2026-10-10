// Joining run rows to work items (plan 0003 §3.4, amended by #91). Every reader of a run's item
// goes through `joinRuns`, so no reader applies rule 2 on its own.
//
// A run row joins work item i when:
//   1. its `pr_number` is i's `pr_number`; or
//   2. it has no `pr_number`, its `issue_number` is in i's `closing_issues`, it was recorded
//      before i's `closed_at`, and i is the FIRST such item to close after it: of the items whose
//      `closing_issues` holds its issue and whose `closed_at` is after it, the one with the
//      earliest `closed_at`, and on a tie the lowest `pr_number`.
//
// So a run joins AT MOST ONE item. An issue closed by two PRs in turn sends a run recorded before
// the first close to the first, and one recorded between the closes to the second.
//
// The rows are one adopter's: the join never crosses an adopter key. Pure; imports nothing.

/**
 * @typedef {{ pr_number?: number, issue_number?: number, recorded_at: string }} JoinRun
 * @typedef {{ pr_number: number, closing_issues?: string, closed_at: string }} JoinItem
 */

/**
 * A work item's closing issues, from the stored comma-separated list.
 * @param {string | undefined} list
 * @returns {number[]}
 */
export function closingIssues(list) {
  if (typeof list !== 'string' || list === '') return [];
  return list.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The item each run joins, by the run's index: the item's `pr_number`, or null when it joins none.
 * @param {readonly JoinRun[]} runs @param {readonly JoinItem[]} items
 * @returns {(number | null)[]}
 */
export function joinRuns(runs, items) {
  /** @type {Map<number, JoinItem>} */
  const byPr = new Map(items.map((i) => [i.pr_number, i]));
  /** @type {Map<number, JoinItem[]>} */
  const byIssue = new Map();
  for (const item of items) {
    for (const issue of closingIssues(item.closing_issues)) {
      const list = byIssue.get(issue);
      if (list) list.push(item);
      else byIssue.set(issue, [item]);
    }
  }
  return runs.map((run) => {
    // Rule 1: the run names a PR. One with no row yet (still open) joins nothing.
    if (Number.isInteger(run.pr_number)) return byPr.has(/** @type {number} */ (run.pr_number)) ? /** @type {number} */ (run.pr_number) : null;
    // Rule 2: an issue-only run joins the first item on its issue to close after it.
    if (!Number.isInteger(run.issue_number)) return null;
    const at = Date.parse(run.recorded_at);
    /** @type {JoinItem | null} */
    let first = null;
    for (const item of byIssue.get(/** @type {number} */ (run.issue_number)) ?? []) {
      const closed = Date.parse(item.closed_at);
      if (!(at < closed)) continue;
      const best = first ? Date.parse(first.closed_at) : Infinity;
      if (closed < best || (closed === best && first && item.pr_number < first.pr_number)) first = item;
    }
    return first ? first.pr_number : null;
  });
}
