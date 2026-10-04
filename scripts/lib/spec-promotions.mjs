// K-SPEC-9's guard: a pull request that promotes an invariant to `[confirmed]` goes to a human.
//
// Specs are deliberately not an escalation path (`merge-gate.mjs` says why), so without this a
// diff that rewrote a clause's tag from `[seed]` to `[confirmed]` sat in the green zone and the
// Merger could merge it with no human ever seeing the promotion. Only a human confirms an
// invariant (`K-SPEC-9`), so the promotion itself is what escalates, not the spec edit.
//
// READ FROM THE DIFF, by clause id, across every spec file the pull request touches:
//
//   - an added `[confirmed]` declaration whose id the diff removes under any other tag is a
//     promotion, in place or moved between spec files;
//   - an added `[confirmed]` declaration whose id the diff doesn't remove at all is a new
//     clause written as `[confirmed]`, which is the same act;
//   - an added `[confirmed]` declaration whose id the diff also removes as `[confirmed]` is an
//     edit or a move that keeps the tag, and is not a promotion.
//
// A declaration with no id is not read: `spec-guard` fails CI on an invariant without one, so
// it can't merge. A fenced example in a spec can't be told from a declaration in a diff hunk,
// so one written as `[confirmed]` escalates; that errs toward a human, never toward a merge.

import { DECL, SPEC_DIR } from '../spec-lib.mjs';

/**
 * Is this changed file a spec the guard reads?
 * @param {string} file
 */
export const isSpecFile = (file) => file.startsWith(`${SPEC_DIR}/`) && file.endsWith('.md');

/**
 * The promotions in a pull request's spec diffs.
 *
 * @param {{file: string, patch: string|null, changes: number}[]} diffs  one entry per changed
 *   spec file; `patch` is `null` when GitHub returned none (a diff too large to show)
 * @returns {{promotions: {id: string, file: string, from: string|null}[], unreadable: string[]}}
 *   `from` is the tag the diff removed for that id, or `null` for a new clause; `unreadable`
 *   names each file with changes and no patch, which the caller must not read as "no promotion"
 */
export function specPromotions(diffs) {
  /** @type {Map<string, Set<string>>} */
  const removed = new Map();
  /** @type {{id: string, file: string}[]} */
  const confirmedAdds = [];
  const unreadable = [];
  for (const { file, patch, changes } of diffs) {
    if (typeof patch !== 'string') {
      if (changes > 0) unreadable.push(file);
      continue;
    }
    for (const line of patch.split('\n')) {
      const sign = line[0];
      if ((sign !== '+' && sign !== '-') || line.startsWith('+++') || line.startsWith('---')) continue;
      const m = DECL.exec(line.slice(1));
      if (!m?.[3]) continue;
      const [id, status] = [m[3], m[4] ?? ''];
      if (sign === '-') {
        const tags = removed.get(id) ?? new Set();
        removed.set(id, tags.add(status));
      } else if (status === 'confirmed') {
        confirmedAdds.push({ id, file });
      }
    }
  }
  const promotions = confirmedAdds
    .filter(({ id }) => !removed.get(id)?.has('confirmed'))
    .map(({ id, file }) => {
      const tags = removed.get(id);
      return { id, file, from: tags ? [...tags].join('/') : null };
    });
  return { promotions, unreadable };
}
