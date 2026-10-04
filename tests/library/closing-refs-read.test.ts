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
const { readPr } = await import('../../scripts/closing-refs.mjs');
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
    gh.mockReturnValue(JSON.stringify(PR) as never);
    const meta = readPr(42, 'o/r');
    const args = gh.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 4)).toEqual(['pr', 'view', '42', '--repo']);
    const fields = args[args.indexOf('--json') + 1]?.split(',');
    expect(fields).toContain('baseRefName');
    expect(meta.baseRefName, 'and hands it on').toBe('fix/1636-x');
  });
});
