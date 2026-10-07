import { describe, expect, it } from 'vitest';
import { AdapterError, toDetectorPr } from '../../scripts/metrics/adapter.mjs';
import { codeAreaTest, explicitLink, reverts, szzLinks } from '../../scripts/metrics/detectors.mjs';
import { ORIGINS } from '../../scripts/metrics/origin.mjs';
import { workItemRow } from '../../scripts/metrics/work-item.mjs';
import { validate } from '../../actions/agent-telemetry/schema.mjs';

/**
 * Plan 0003 M2 (kanon#516, kanon#527): one reader fills `types.mjs`'s `PullRequest`, and
 * `toDetectorPr` gives the detectors their `DetectorPr` from it, so the same object feeds the
 * work-item row and the detectors, and a cross-reference's repository is carried through.
 */

const REPO = 'acme/widgets';
const HUMAN = { login: 'octocat', type: 'User' };
const isCode = codeAreaTest();

const PR = (number: number, o: Record<string, unknown> = {}) => ({
  number,
  state: 'closed' as const,
  title: `feat: ${number}`,
  created_at: '2026-09-01T00:00:00Z',
  closed_at: '2026-09-02T00:00:00Z',
  merged_at: '2026-09-02T00:00:00Z',
  merge_commit_sha: `${number}`.padEnd(40, 'a'),
  parent_sha: 'p'.repeat(40),
  author: HUMAN,
  body: null,
  labels: [],
  files: [{ path: 'src/calc.js', status: 'modified' as const, additions: 2, deletions: 1 }],
  commits: [{ sha: `h${number}`.padEnd(40, '0'), message: 'work', committed_at: '2026-09-01T01:00:00Z', author: HUMAN, committer: HUMAN }],
  closing_issues: [],
  timeline: [],
  reviews: [],
  ...o,
});

describe('toDetectorPr', () => {
  it('maps every field the detectors read, by name', () => {
    const pr = PR(7, {
      title: 'fix: it',
      body: 'Reverts acme/widgets#3',
      files: [{ path: 'src/new.js', previous_path: 'src/old.js', status: 'renamed', additions: 1, deletions: 1, old_ranges: [{ start: 2, count: 1 }], patch: '@@ -2 +2 @@' }],
      closing_issues: [{ number: 9, labels: ['bug'], body: '### Introduced by\n\n#3' }],
      timeline: [
        { event: 'cross-referenced', created_at: '2026-09-01T00:00:00Z', source: { type: 'issue', number: 9, repository: 'other/place' } },
        { event: 'labeled', created_at: '2026-09-01T00:00:00Z', label: 'bug' },
      ],
    });
    expect(toDetectorPr(pr)).toEqual({
      number: 7,
      title: 'fix: it',
      body: 'Reverts acme/widgets#3',
      mergedAt: '2026-09-02T00:00:00Z',
      mergeCommitSha: pr.merge_commit_sha,
      parentSha: 'p'.repeat(40),
      commits: [{ sha: pr.commits[0]!.sha, message: 'work' }],
      files: [{ path: 'src/new.js', previousPath: 'src/old.js', status: 'renamed', patch: '@@ -2 +2 @@', ranges: [{ start: 2, count: 1 }] }],
      closingIssues: [{ number: 9, labels: ['bug'], body: '### Introduced by\n\n#3' }],
      timeline: [{ type: 'cross-referenced', source: { number: 9, repository: 'other/place' } }, { type: 'labeled' }],
    });
  });

  it("carries a cross-reference's repository, so another repository's issue of the same number links nothing (kanon#527)", () => {
    const fix = toDetectorPr(PR(5, { merged_at: '2026-09-05T00:00:00Z', closing_issues: [{ number: 9, labels: ['bug'] }] }));
    const event = (repository?: string) => ({ event: 'cross-referenced', created_at: '2026-09-03T00:00:00Z', source: { type: 'issue', number: 9, ...(repository ? { repository } : {}) } });
    const item = (repository?: string) => toDetectorPr(PR(3, { timeline: [event(repository)] }));
    expect(explicitLink(fix, item(REPO), { repo: REPO, isCode })).toMatchObject({ pr: 3, via: ['cross-reference'] });
    expect(explicitLink(fix, item('other/place'), { repo: REPO, isCode })).toBeNull();
  });

  it('feeds the revert detector the merge commit, and SZZ the parent and the old-side ranges', async () => {
    const item = toDetectorPr(PR(3));
    const revert = toDetectorPr(PR(4, { merged_at: '2026-09-04T00:00:00Z', commits: [{ sha: 'r'.repeat(40), message: `This reverts commit ${item.mergeCommitSha}.`, committed_at: '2026-09-03T00:00:00Z', author: HUMAN, committer: HUMAN }] }));
    expect(reverts(revert, item, REPO)).toBe(true);
    const fix = toDetectorPr(PR(5, { merged_at: '2026-09-05T00:00:00Z', files: [{ path: 'src/calc.js', status: 'modified', additions: 1, deletions: 1, old_ranges: [{ start: 4, count: 1 }] }] }));
    const asked: unknown[] = [];
    const links = await szzLinks(fix, [item, fix], { isCode, blame: (path, ranges, at) => { asked.push([path, ranges, at]); return [item.mergeCommitSha as string]; } });
    expect(asked).toEqual([['src/calc.js', [{ start: 4, count: 1 }], 'p'.repeat(40)]]);
    expect(links).toEqual([{ pr: 3, days: 3 }]);
  });

  it('refuses a merged PR missing a list the detectors read, naming it, rather than read it as empty', () => {
    for (const field of ['files', 'commits', 'closing_issues', 'timeline']) {
      expect(() => toDetectorPr(PR(3, { [field]: undefined })), field).toThrow(AdapterError);
      expect(() => toDetectorPr(PR(3, { [field]: undefined })), field).toThrow(field);
    }
    expect(() => toDetectorPr(PR(3, { merged_at: null, files: undefined }))).not.toThrow();
  });

  it('takes the same object workItemRow takes, and the row it builds is valid', () => {
    const pr = PR(3, { timeline: [{ event: 'cross-referenced', created_at: '2026-09-01T12:00:00Z', source: { type: 'issue', number: 9, repository: REPO } }] });
    toDetectorPr(pr);
    const row = workItemRow({ pr, declarations: { register: new Map() }, tag: 'test', recorded_at: '2026-10-07T00:00:00Z' });
    expect(validate(row).ok).toBe(true);
  });
});

describe('ORIGINS', () => {
  it("is exactly the telemetry schema's origin list", () => {
    const row = workItemRow({ pr: PR(3), declarations: { register: new Map() }, tag: 'test', recorded_at: '2026-10-07T00:00:00Z' });
    for (const origin of ORIGINS) expect(validate({ ...row, origin }).ok, origin).toBe(true);
    expect(validate({ ...row, origin: 'implementer' }).ok).toBe(false);
  });
});
