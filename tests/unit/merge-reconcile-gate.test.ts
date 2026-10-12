import { describe, expect, it } from 'vitest';

const { openItems, openItemsGate, skipSummary } = await import('../../scripts/merge-reconcile-gate.mjs');

/**
 * kanon#177 — the decision the merge-reconcile lane's `filter` makes about skipping its model
 * run, as a pure function. The step that calls it is executed in `merge-reconcile-filter.test.ts`.
 *
 * It skips only on a proven zero: every review on the PR a Reviewer verdict (the Reviewer's
 * login AND role marker), and the latest of them, by submission time, read on the merged head
 * with a last `qa:open-items` marker of 0. The latest's count includes what earlier rounds left
 * open, by the prompt's definition, so earlier counts are superseded. Every other answer runs
 * the model.
 */

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const REVIEWER = 'example-reviewer';
const SIGNED = '**Reviewer** <!-- kanon:role=reviewer -->\n\n';

type Review = { id?: string; author?: { login?: string } | null; state?: string; submittedAt?: unknown; body?: unknown; commit?: { oid?: string } | null };
const rv = (over: Partial<Review> & { open?: number | null } = {}): Review => {
  const { open = 0, ...rest } = over;
  return {
    id: 'PRR_1', author: { login: REVIEWER }, state: 'APPROVED', submittedAt: '2026-10-04T12:00:00Z',
    commit: { oid: HEAD },
    body: open === null ? `${SIGNED}Approve.` : `${SIGNED}Approve.\n\n<!-- qa:open-items ${open} -->`,
    ...rest,
  };
};
// `in`, not a default: a case passing `head: undefined` means it.
const gate = (reviews: unknown, opts: { head?: unknown; reviewer?: unknown } = {}) =>
  openItemsGate({ reviews, head: 'head' in opts ? opts.head : HEAD, reviewer: 'reviewer' in opts ? opts.reviewer : REVIEWER });
const runs = (reviews: unknown, why: RegExp, opts?: { head?: unknown; reviewer?: unknown }) => {
  const d = gate(reviews, opts);
  expect(d.skip).toBe(false);
  expect(d.why).toMatch(why);
};

describe('reading the marker', () => {
  it('reads the last marker of a body, a count, or says it is missing or garbled', () => {
    expect(openItems('x <!-- qa:open-items 0 -->')).toBe(0);
    expect(openItems('x <!--qa:open-items   12  -->')).toBe(12);
    expect(openItems('no marker')).toBe('missing');
    expect(openItems('<!-- qa:open-items two -->')).toBe('garbled');
    expect(openItems('<!-- qa:open-items -->')).toBe('garbled');
    expect(openItems('<!-- qa:open-items -1 -->')).toBe('garbled');
    expect(openItems('<!-- qa:open-items 0 --> then <!-- qa:open-items 3 -->')).toBe(3);
    expect(openItems('<!-- qa:open-items 0 --> then <!-- qa:open-items ? -->')).toBe('garbled');
    expect(openItems('<!-- qa:open-itemsX 0 -->')).toBe('missing');
  });
});

describe('the gate skips only on a proven zero (kanon#177)', () => {
  it("skips when the Reviewer's latest verdict was read on the merged head and declares zero", () => {
    const earlier = rv({ id: 'PRR_0', state: 'COMMENTED', submittedAt: '2026-10-04T10:00:00Z', commit: { oid: OLD } });
    const d = gate([earlier, rv()]);
    expect(d).toEqual({
      skip: true,
      why: "the Reviewer's latest verdict, on aaaaaaa, declares zero open items (kanon#177)",
      latest: { id: 'PRR_1', state: 'APPROVED', at: '2026-10-04T12:00:00Z', sha: HEAD },
      earlier: 1,
    });
  });

  it('skips a pull request whose first round requested changes and whose approval declares zero', () => {
    // The latest count includes what the earlier round left open, by the prompt's definition.
    const earlier = rv({ id: 'PRR_0', open: 3, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-04T10:00:00Z', commit: { oid: OLD } });
    expect(gate([earlier, rv()]).skip).toBe(true);
    // An earlier verdict from before the marker existed is superseded the same way.
    expect(gate([rv({ open: null, submittedAt: '2026-10-04T10:00:00Z', commit: { oid: OLD } }), rv()]).skip).toBe(true);
  });

  it('runs when the latest verdict declares open items, whatever an earlier one said', () => {
    runs([rv({ open: 2 })], /latest verdict declares open items/);
    runs([rv(), rv({ open: 1, submittedAt: '2026-10-04T12:10:00Z' })], /latest verdict declares open items/);
  });

  it('runs when the latest verdict carries no marker — a verdict from before the marker existed', () => {
    runs([rv({ open: null })], /latest verdict carries no open-items marker/);
    runs([rv({ submittedAt: '2026-10-04T10:00:00Z' }), rv({ open: null, submittedAt: '2026-10-04T12:10:00Z' })], /carries no open-items marker/);
  });

  it('runs when a marker is garbled', () => {
    runs([rv({ body: `${SIGNED}<!-- qa:open-items none -->` })], /garbled/);
    runs([rv({ body: `${SIGNED}<!-- qa:open-items 0 -->\n<!-- qa:open-items 0x -->` })], /garbled/);
  });

  it('takes the LAST marker, so a quoted format does not decide the count', () => {
    runs([rv({ body: `${SIGNED}Discussing \`<!-- qa:open-items 0 -->\`.\n\n<!-- qa:open-items 1 -->` })], /declares open items/);
    expect(gate([rv({ body: `${SIGNED}An old run said <!-- qa:open-items 4 --> here.\n\n<!-- qa:open-items 0 -->` })]).skip).toBe(true);
  });

  it('runs when there is no Reviewer verdict', () => {
    runs([], /posted no verdict/);
  });

  it("never trusts another author's count: a person's review with a zero marker runs", () => {
    const person = rv({ author: { login: 'a-person' }, state: 'COMMENTED' });
    runs([person], /`a-person` is not the Reviewer's verdict/);
    runs([rv(), person], /`a-person` is not the Reviewer's verdict/);
  });

  it("runs on another App's review, even one carrying the Reviewer's marker", () => {
    runs([rv({ author: { login: 'other-app[bot]' } })], /`other-app` is not the Reviewer's verdict/);
  });

  it("runs on a review by the Reviewer's App without the Reviewer's role marker: the Merger's, or a thread reply", () => {
    runs([rv({ body: '<!-- qa:open-items 0 -->' })], /not the Reviewer's verdict/);
    runs([rv({ body: '**Merger** <!-- kanon:role=merger -->\n\n<!-- qa:open-items 0 -->' })], /not the Reviewer's verdict/);
    runs([rv(), rv({ body: '', state: 'COMMENTED', submittedAt: '2026-10-04T12:05:00Z' })], /not the Reviewer's verdict/);
  });

  it('reads the login however the APIs spell an App', () => {
    for (const login of [REVIEWER, `${REVIEWER}[bot]`, `app/${REVIEWER}`]) {
      expect(gate([rv({ author: { login } })]).skip, login).toBe(true);
    }
  });

  it('runs when a commit landed after the latest verdict', () => {
    runs([rv({ commit: { oid: OLD } })], /read before the merged head/);
    runs([rv({ commit: null })], /read before the merged head/);
  });

  it('reads the commit from the stamp before `commit`, as the review lane does (RA-1680)', () => {
    const misfiled = rv({ body: `${SIGNED}<!-- qa:open-items 0 -->\n\n<!-- reviewed: sha=${OLD} run=1 -->` });
    runs([misfiled], /read before the merged head/);
    const short = rv({ commit: { oid: OLD }, body: `${SIGNED}<!-- qa:open-items 0 -->\n\n<!-- reviewed: sha=${HEAD.slice(0, 7).toUpperCase()} run=1 -->` });
    expect(gate([short]).skip).toBe(true);
  });

  it('judges by the LATEST verdict, by submission time, not by order in the list', () => {
    const later = rv({ id: 'PRR_2', submittedAt: '2026-10-04T13:00:00Z', commit: { oid: OLD } });
    runs([later, rv()], /read before the merged head/);
    const laterOpen = rv({ id: 'PRR_2', open: 2, submittedAt: '2026-10-04T13:00:00Z' });
    runs([laterOpen, rv()], /latest verdict declares open items/);
    const earlierOpen = rv({ id: 'PRR_0', open: 2, submittedAt: '2026-10-04T10:00:00Z' });
    expect(gate([rv(), earlierOpen]).skip).toBe(true);
  });

  it('runs when the merged head is unknown', () => {
    for (const head of [null, undefined, '', 'not-a-sha', HEAD.slice(0, 7)]) runs([rv()], /merged head is unknown/, { head });
  });

  it("runs when the Reviewer's login is unknown", () => {
    for (const reviewer of [null, undefined, '', 'Not A Slug']) runs([rv()], /Reviewer's login is unknown/, { reviewer });
  });

  it('runs on an answer of an unexpected shape', () => {
    for (const reviews of [null, undefined, 'x', {}]) runs(reviews, /reviews could not be read/);
    runs([null], /a review could not be read/);
    runs([rv({ body: 7 })], /a review could not be read/);
    runs([rv({ submittedAt: undefined })], /a review could not be read/);
    runs([rv({ author: null })], /`unknown` is not the Reviewer's verdict/);
  });
});

describe('the skip is visible', () => {
  it('names the Reviewer and the verdict that decided, with its zero', () => {
    const d = gate([rv({ id: 'PRR_0', open: 2, submittedAt: '2026-10-04T10:00:00Z' }), rv()]);
    if (!d.skip) throw new Error('expected a skip');
    const text = skipSummary(d, `${REVIEWER}[bot]`);
    expect(text).toMatch(/^\*\*Skipped:\*\* the latest verdict the Reviewer \(`example-reviewer`\) posted on this pull request was read on the merged head and declares zero open items/);
    expect(text).toContain('- review `PRR_1`, APPROVED at 2026-10-04T12:00:00Z on `aaaaaaa`: `open-items 0`');
    expect(text).toContain("carried over from the Reviewer's 1 earlier verdict,");
  });
});
