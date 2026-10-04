import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `closing-refs` reads from GitHub, asserted on the request itself.
 *
 * A field a `gh … --json` list does not request comes back `undefined`, not as an error,
 * so a dropped field fails silently in whichever direction its reader defaults to. Its own
 * file because `vi.mock` replaces `node:child_process` for the whole file.
 */
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const { execFileSync } = await import('node:child_process');
const { baseRetargeted, readPr } = await import('../../scripts/closing-refs.mjs');
const gh = vi.mocked(execFileSync);

const PR = {
  title: 't',
  body: 'Closes #1207',
  closingIssuesReferences: [{ number: 1207 }],
  commits: [{ messageHeadline: 'fix: x', messageBody: '' }],
  baseRefName: 'fix/1636-x',
};

beforeEach(() => {
  gh.mockReset();
});

describe('readPr (kanon#165)', () => {
  it('requests baseRefName, which decides whether a stacked PR is deferred', () => {
    // `linksArePopulated` treats a missing base as "populated", so losing the field would
    // not silence the check — it would make the deferral never apply, and every stacked
    // PR would be red again for links GitHub never fills on a non-default base.
    gh.mockReturnValueOnce(JSON.stringify(PR) as never).mockReturnValueOnce('[]' as never);
    const meta = readPr(42, 'o/r');
    const args = gh.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 4)).toEqual(['pr', 'view', '42', '--repo']);
    const fields = args[args.indexOf('--json') + 1]?.split(',');
    expect(fields).toContain('baseRefName');
    expect(meta.baseRefName, 'and hands it on').toBe('fix/1636-x');
  });
});

describe('readPr carries the retarget evidence (kanon#182)', () => {
  it('reads the timeline for the same PR and hands the answer on', () => {
    gh.mockReturnValueOnce(JSON.stringify(PR) as never).mockReturnValueOnce('[{"__typename":"BaseRefChangedEvent"}]' as never);
    expect(readPr(42, 'o/r').retargeted).toBe(true);
    expect(gh.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['graphql', 'number=42']));
  });

  it('hands on null, not false, when the timeline cannot be read', () => {
    gh.mockReturnValueOnce(JSON.stringify(PR) as never).mockImplementationOnce(() => {
      throw new Error('HTTP 502');
    });
    expect(readPr(42, 'o/r').retargeted).toBeNull();
  });
});

describe('baseRetargeted (kanon#182)', () => {
  it('reads the base changes on the PR timeline, for this PR in this repository', () => {
    gh.mockReturnValue('[]\n' as never);
    expect(baseRetargeted(2654, 'o/r')).toBe(false);
    const args = gh.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args.join(' ')).toContain('itemTypes:[BASE_REF_CHANGED_EVENT]');
    expect(args).toEqual(expect.arrayContaining(['owner=o', 'name=r', 'number=2654']));
  });

  it('is true only when the timeline has a base change on it', () => {
    gh.mockReturnValue('[{"__typename":"BaseRefChangedEvent"}]' as never);
    expect(baseRetargeted(1109, 'o/r')).toBe(true);
  });

  it('counts the nodes, not totalCount, which counts the whole unfiltered timeline', () => {
    // Measured on kanon#240: `totalCount` 5 with `itemTypes: [BASE_REF_CHANGED_EVENT]` and
    // no base change at all. Asking for it would read every PR as retargeted.
    gh.mockReturnValue('[]' as never);
    baseRetargeted(1, 'o/r');
    const args = (gh.mock.calls[0]?.[1] as string[]).join(' ');
    expect(args).toContain('--jq .data.repository.pullRequest.timelineItems.nodes');
    expect(args).not.toContain('totalCount');
  });

  it('is null, not false, when the timeline cannot be read', () => {
    // `false` is evidence that no retarget happened; an unread timeline is no evidence at all.
    gh.mockImplementation(() => {
      throw new Error('HTTP 502');
    });
    expect(baseRetargeted(1, 'o/r')).toBeNull();
    gh.mockReturnValue('null' as never);
    expect(baseRetargeted(1, 'o/r')).toBeNull();
  });
});
