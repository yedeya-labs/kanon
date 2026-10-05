import { describe, expect, it } from 'vitest';
import {
  countInterlock,
  interlockCount,
  linkedFromGraphql,
  linkedQuery,
  renderInterlock,
  unlinkedFromSearch,
  unlinkedQuery,
} from '../../scripts/capability-interlock.mjs';

/**
 * RA-866, `K-SELF-17`: the interlock count must not fall when a capability issue's only linked
 * PR is closed unmerged. Moved from the reference adopter with the Overseer's lane (plan 0004
 * step 13); it now counts on the repository the lane runs in.
 *
 * `-linked:pr` is state-blind: a dead PR links an issue forever. So the `-linked:pr` total alone
 * deflates toward `<= 6`, which UNLOCKS the Overseer's capability generator, the one direction
 * the interlock exists to make impossible. The script adds back every open `capability` issue
 * whose linked PRs were all closed unmerged.
 */

const pr = (number: number, state: 'OPEN' | 'MERGED' | 'CLOSED') => ({ number, state });

describe('an abandoned PR does not deflate the interlock (RA-866)', () => {
  it('adds back an open issue whose ONLY linked PR was closed unmerged', () => {
    const r = interlockCount({ unlinked: 6, linked: [{ number: 619, prs: [pr(623, 'CLOSED')] }] });
    expect(r.count, '6 + the abandoned one = 7, which keeps the interlock CLOSED').toBe(7);
    expect(r.abandoned).toEqual([619]);
  });

  it('does not add back an issue an open or merged PR still absorbs', () => {
    const r = interlockCount({
      unlinked: 6,
      linked: [
        { number: 1, prs: [pr(10, 'OPEN')] },
        { number: 2, prs: [pr(20, 'MERGED')] },
        { number: 3, prs: [pr(30, 'CLOSED'), pr(31, 'OPEN')] },
        { number: 4, prs: [pr(40, 'CLOSED'), pr(41, 'MERGED')] },
      ],
    });
    expect(r).toMatchObject({ count: 6, abandoned: [], unverifiable: [] });
  });

  it('counts IN a linked issue whose PRs this token cannot see, the fail-closed direction', () => {
    const r = interlockCount({ unlinked: 2, linked: [{ number: 5, prs: [] }] });
    expect(r).toMatchObject({ count: 3, unverifiable: [5] });
  });

  it('puts the bare count on line 1, and says which issues were added back', () => {
    const text = renderInterlock(interlockCount({ unlinked: 6, linked: [{ number: 619, prs: [pr(623, 'CLOSED')] }] }));
    const [first, ...rest] = text.split('\n');
    expect(first).toBe('7');
    expect(rest.join('\n')).toMatch(/closed unmerged, added back \(RA-866\): #619/);
    expect(rest.join('\n')).toMatch(/CLOSED, so file nothing/);
  });

  it('refuses to under-count when the GraphQL read was truncated', () => {
    expect(() => linkedFromGraphql({ data: { search: { issueCount: 2, nodes: [{ number: 1 }] } } }))
      .toThrow(/refusing to under-count/);
    expect(() => linkedFromGraphql({ data: { search: { issueCount: 1, nodes: [
      { number: 1, closedByPullRequestsReferences: { pageInfo: { hasNextPage: true }, nodes: [] } },
    ] } } })).toThrow(/refusing to guess/);
    expect(() => linkedFromGraphql({})).toThrow(/no search\.nodes/);
  });

  it('refuses a partial REST search rather than reading its low total as the count', () => {
    expect(unlinkedFromSearch({ total_count: 6, incomplete_results: false })).toBe(6);
    expect(() => unlinkedFromSearch({ total_count: 4, incomplete_results: true })).toThrow(/incomplete_results/);
    expect(() => unlinkedFromSearch({})).toThrow(/no integer total_count/);
  });
});

describe('the count, on the repository the lane runs in', () => {
  it('queries that repository\'s cohort, and adds back what the second read finds', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args[1] === '-X') return JSON.stringify({ total_count: 5, incomplete_results: false });
      return JSON.stringify({ data: { search: { issueCount: 1, nodes: [
        { number: 9, closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [{ number: 10, state: 'CLOSED' }] } },
      ] } } });
    };
    expect(countInterlock('acme/widgets', gh)).toMatchObject({ count: 6, abandoned: [9] });
    expect(calls[0]).toContain(`q=${unlinkedQuery('acme/widgets')}`);
    expect(calls[1]).toContain(`q=${linkedQuery('acme/widgets')}`);
    expect(unlinkedQuery('acme/widgets')).toBe('repo:acme/widgets is:issue is:open label:capability -linked:pr');
  });

  it('refuses a repository that is not owner/name, rather than counting somebody else\'s', () => {
    expect(() => countInterlock('', () => '{}')).toThrow(/not an owner\/name repository/);
    expect(() => countInterlock('acme', () => '{}')).toThrow(/not an owner\/name repository/);
  });
});
