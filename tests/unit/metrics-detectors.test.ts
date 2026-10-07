import { describe, expect, it, vi } from 'vitest';
import { parseCodeAreas } from '../../scripts/lib/code-areas.mjs';
import {
  MAX_FIX_PRS, accuracyFields, codeAreaTest, detectorCounts, explicitLink, explicitLinks, fixesOf, introducedBy,
  isFixPr, oldRanges, revertedBy, reverts, revertsOf, sharedCodeFiles, szzLinks,
} from '../../scripts/metrics/detectors.mjs';

/**
 * Plan 0003 §3.5, M2 part B (kanon#516): the revert and linked-fix detectors. Pure functions over
 * plain PR objects, so the dry run (part C) feeds them GitHub data and SZZ's blame. §7's two
 * detector mutations are pinned here: a PR sharing only a doc file with the earlier item is not a
 * linked fix, and a revert commit naming another SHA is not a revert.
 */

const REPO = 'example-org/example-repo';
const isCode = codeAreaTest();
const opts = { repo: REPO, isCode };

type File = { path: string; previousPath?: string | null; status?: string; patch?: string | null; ranges?: { start: number; count: number }[] };
type Pr = {
  number: number; title?: string; body?: string | null; mergeCommitSha: string | null; parentSha?: string | null; mergedAt: string | null;
  commits: { sha: string; message: string }[]; files: File[];
  closingIssues: { number: number; labels: (string | { name: string })[]; body?: string | null }[];
  timeline: { type: string; source?: { number: number; repository?: string | null } | null }[];
};

const sha = (n: number) => n.toString(16).padStart(8, '0').repeat(5);
const day = (d: number) => new Date(Date.UTC(2026, 8, 1, 12) + d * 86_400_000).toISOString();

/** A merged PR on day `d`, its merge commit `sha(n)`, changing `src/app.ts`. */
function pr(n: number, d: number, over: Partial<Pr> = {}): Pr {
  return {
    number: n, title: `feat: item ${n}`, body: '', mergeCommitSha: sha(n), mergedAt: day(d),
    commits: [{ sha: sha(n + 1000), message: `feat: item ${n}` }],
    files: [{ path: 'src/app.ts', status: 'modified', patch: '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d' }],
    closingIssues: [], timeline: [], ...over,
  };
}

const bug = (n: number, body = '') => ({ number: n, labels: [{ name: 'bug' }], body });
const xref = (n: number, repository: string | null = REPO) => ({ type: 'cross-referenced', source: { number: n, repository } });

describe('the revert detector', () => {
  const item = pr(10, 0);

  it('reads `This reverts commit <sha>.` naming the item\'s merge commit, full or abbreviated', () => {
    const full = pr(20, 3, { commits: [{ sha: sha(1020), message: `Revert "feat: item 10"\n\nThis reverts commit ${sha(10)}.` }] });
    const short = pr(21, 5, { commits: [{ sha: sha(1021), message: `Revert\n\nThis reverts commit ${sha(10).slice(0, 7)}.` }] });
    expect(reverts(full, item, REPO)).toBe(true);
    expect(reverts(short, item, REPO)).toBe(true);
    expect(revertsOf(item, [item, full, short], opts)).toEqual([{ pr: 20, days: 3 }, { pr: 21, days: 5 }]);
    expect(revertedBy(full, [item, full, short], opts)).toEqual([{ pr: 10, days: 3 }]);
  });

  it('reads the Revert button\'s body, `Reverts <repo>#<item>`, of this repository only', () => {
    expect(reverts(pr(20, 1, { body: `Reverts ${REPO}#10` }), item, REPO)).toBe(true);
    expect(reverts(pr(20, 1, { body: 'Reverts other-org/other-repo#10' }), item, REPO)).toBe(false);
    expect(reverts(pr(20, 1, { body: `Reverts ${REPO}#11` }), item, REPO)).toBe(false);
  });

  it('§7 mutation: a revert commit naming ANOTHER sha is not a revert of this item', () => {
    const other = pr(20, 1, { commits: [{ sha: sha(1020), message: `Revert\n\nThis reverts commit ${sha(11)}.` }] });
    expect(reverts(other, item, REPO)).toBe(false);
    expect(revertsOf(item, [item, other], opts)).toEqual([]);
  });

  it('a revert naming one of the item\'s head commits, not its merge commit, is not one (§3.5 names the merge commit)', () => {
    const head = pr(20, 1, { commits: [{ sha: sha(1020), message: `This reverts commit ${sha(1010)}.` }] });
    expect(reverts(head, item, REPO)).toBe(false);
  });

  it('counts only PRs merged after the item, and never an unmerged one', () => {
    const msg = `This reverts commit ${sha(10)}.`;
    const earlier = pr(20, -1, { commits: [{ sha: sha(1020), message: msg }] });
    const open = { ...pr(21, 2, { commits: [{ sha: sha(1021), message: msg }] }), mergedAt: null };
    expect(revertsOf(item, [earlier, open, item], opts)).toEqual([]);
    expect(revertsOf({ ...item, mergedAt: null }, [pr(22, 2, { commits: [{ sha: sha(1022), message: msg }] })], opts)).toEqual([]);
  });

  it('an item with no merge commit is reverted only by the body form', () => {
    const noSha = { ...item, mergeCommitSha: null };
    expect(reverts(pr(20, 1, { commits: [{ sha: sha(1020), message: `This reverts commit ${sha(10)}.` }] }), noSha, REPO)).toBe(false);
    expect(reverts(pr(20, 1, { body: `Reverts ${REPO}#10` }), noSha, REPO)).toBe(true);
  });

  it('counts whole days from merge to merge', () => {
    const r = { ...pr(20, 0, { body: `Reverts ${REPO}#10` }), mergedAt: new Date(Date.parse(day(2)) - 1000).toISOString() };
    expect(revertsOf(item, [r], opts)).toEqual([{ pr: 20, days: 1 }]);
  });
});

describe('the code-area test (§3.7)', () => {
  it('undeclared: code is everything but tests and §3.7\'s other areas', () => {
    for (const p of ['src/app.ts', 'lib/x.py', 'scripts/build.mjs', 'app/main.go']) expect(isCode(p), p).toBe(true);
    for (const p of [
      'README.md', 'docs/guide.txt', 'src/notes.md', // docs
      'package.json', 'package-lock.json', 'web/yarn.lock', 'go.sum', 'requirements-dev.txt', // deps
      '.github/workflows/ci.yml', '.github/actions/x/action.yml', // workflows
      'db/migrations/0001.sql', // migrations
      'docs/qa/specs/01-auth.md', // specs
      '.eslintrc', 'src/.env.example', 'tsconfig.json', 'vitest.config.ts', // config
      'src/app.test.ts', 'src/app.spec.ts', // tests, by convention
    ]) expect(isCode(p), p).toBe(false);
  });

  it('declared: only inside the code trees, and never inside a tests tree', () => {
    const areas = parseCodeAreas('# Stack\n\n## Code areas\n\n- `src/` — code: the app\n- `src/fixtures/` — tests: fixtures\n');
    const test = codeAreaTest(areas);
    expect(test('src/app.ts')).toBe(true);
    expect(test('tools/x.ts')).toBe(false);
    expect(test('src/fixtures/a.ts')).toBe(false);
    expect(test('src/README.md')).toBe(false);
  });
});

describe('introducedBy reads the bug form\'s field (decision 9)', () => {
  const form = (value: string) => `### Kanon version\n\nv1.0.0\n\n### Introduced by\n\n${value}\n\n### What happened\n\nIt broke, see #99.`;

  it('reads `#N`, `N`, `<repo>#N` and the PR\'s URL, one or several', () => {
    expect(introducedBy(form('#10'), REPO)).toEqual([10]);
    expect(introducedBy(form('10'), REPO)).toEqual([10]);
    expect(introducedBy(form(`${REPO}#10, https://github.com/${REPO}/pull/12`), REPO)).toEqual([10, 12]);
    expect(introducedBy(form('#10').replace(/\n/g, '\r\n'), REPO)).toEqual([10]);
  });

  it('reads nothing from prose, another repository, an empty field or a body without it', () => {
    expect(introducedBy(form('similar to #10'), REPO)).toEqual([]);
    expect(introducedBy(form('other-org/other-repo#10'), REPO)).toEqual([]);
    expect(introducedBy(form('https://github.com/other-org/other-repo/pull/10'), REPO)).toEqual([]);
    expect(introducedBy(form('_No response_'), REPO)).toEqual([]);
    expect(introducedBy(form(''), REPO)).toEqual([]);
    expect(introducedBy('It broke in #10.', REPO)).toEqual([]);
    expect(introducedBy(null, REPO)).toEqual([]);
  });

  it('reads only the field\'s own heading', () => {
    expect(introducedBy('### Introduced by mistake\n\n#10', REPO)).toEqual([]);
    expect(introducedBy('Introduced by\n\n#10', REPO)).toEqual([]);
  });

  it('stops at the next heading, so a later field\'s numbers are not read', () => {
    expect(introducedBy('### Introduced by\n\n### What happened\n\n#10', REPO)).toEqual([]);
  });
});

describe('the explicit linked-fix detector (§3.5)', () => {
  const item = pr(10, 0, { timeline: [xref(30)] });
  const fix = pr(20, 4, { title: 'fix: the crash', closingIssues: [bug(30)] });

  it('links a fix that closes a bug issue cross-referencing the item, through a shared code file', () => {
    expect(explicitLink(fix, item, opts)).toEqual({ pr: 10, days: 4, via: ['cross-reference'], files: ['src/app.ts'] });
    expect(explicitLinks(fix, [item, fix], opts)).toHaveLength(1);
    expect(fixesOf(item, [item, fix], opts)).toEqual([{ pr: 20, days: 4 }]);
  });

  it('links when the cross-reference comes from the fix itself', () => {
    expect(explicitLink(fix, { ...item, timeline: [xref(20)] }, opts)?.via).toEqual(['cross-reference']);
  });

  it('links through the "Introduced by" field, alone or beside the event', () => {
    const named = { ...fix, closingIssues: [bug(30, '### Introduced by\n\n#10\n')] };
    expect(explicitLink(named, { ...item, timeline: [] }, opts)?.via).toEqual(['introduced-by']);
    expect(explicitLink(named, item, opts)?.via).toEqual(['cross-reference', 'introduced-by']);
    // A field naming another PR links nothing to this one.
    expect(explicitLink({ ...fix, closingIssues: [bug(30, '### Introduced by\n\n#11\n')] }, { ...item, timeline: [] }, opts)).toBeNull();
  });

  it('condition 1: the closing issue must be labelled `bug`', () => {
    expect(explicitLink({ ...fix, closingIssues: [{ number: 30, labels: ['enhancement'] }] }, item, opts)).toBeNull();
    expect(explicitLink({ ...fix, closingIssues: [{ number: 30, labels: ['bug'] }] }, item, opts)).not.toBeNull();
    expect(explicitLink({ ...fix, closingIssues: [] }, { ...item, timeline: [xref(20)] }, opts)).toBeNull();
  });

  it('condition 2: the cross-reference must come from that bug issue or the fix, in this repository, as `cross-referenced`', () => {
    expect(explicitLink(fix, { ...item, timeline: [xref(31)] }, opts)).toBeNull();
    expect(explicitLink(fix, { ...item, timeline: [xref(30, 'other-org/other-repo')] }, opts)).toBeNull();
    expect(explicitLink(fix, { ...item, timeline: [xref(30, null)] }, opts)).not.toBeNull();
    expect(explicitLink(fix, { ...item, timeline: [{ type: 'referenced', source: { number: 30 } }] }, opts)).toBeNull();
    expect(explicitLink(fix, { ...item, timeline: [{ type: 'cross-referenced', source: null }] }, opts)).toBeNull();
    // A cross-reference from another issue the fix closes, not labelled `bug`, is not "that issue".
    const two = { ...fix, closingIssues: [bug(30), { number: 31, labels: [] }] };
    expect(explicitLink(two, { ...item, timeline: [xref(31)] }, opts)).toBeNull();
  });

  it('§7 mutation, condition 3: a PR sharing only a doc file with the earlier item is not a linked fix', () => {
    const docs = [{ path: 'docs/guide.md', status: 'modified' }, { path: 'src/app.ts', status: 'modified' }];
    const docOnly = { ...fix, files: [{ path: 'docs/guide.md', status: 'modified' }, { path: 'src/other.ts', status: 'modified' }] };
    expect(explicitLink(docOnly, { ...item, files: docs }, opts)).toBeNull();
    expect(sharedCodeFiles(docOnly, { ...item, files: docs }, isCode)).toEqual([]);
    // The same pair sharing a code file is one.
    expect(explicitLink({ ...docOnly, files: [...docOnly.files, { path: 'src/app.ts', status: 'modified' }] }, { ...item, files: docs }, opts)?.files).toEqual(['src/app.ts']);
  });

  it('condition 3 counts a rename under either path', () => {
    const renamed = { ...fix, files: [{ path: 'src/main.ts', previousPath: 'src/app.ts', status: 'renamed' }] };
    expect(explicitLink(renamed, item, opts)?.files).toEqual(['src/app.ts']);
  });

  it('only a fix merged after the item links to it', () => {
    expect(explicitLink({ ...fix, mergedAt: day(-1) }, item, opts)).toBeNull();
    expect(explicitLink({ ...fix, mergedAt: null }, item, opts)).toBeNull();
    expect(fixesOf(item, [{ ...fix, mergedAt: day(-1) }], opts)).toEqual([]);
  });
});

describe('accuracyFields fills group 3 from the explicit detector and the first revert', () => {
  const item = pr(10, 0, { timeline: [xref(30), xref(31)] });

  it('sets the revert and the fixes, oldest first, and leaves absent what it can\'t say', () => {
    const r = pr(40, 9, { body: `Reverts ${REPO}#10` });
    const f1 = pr(20, 2, { closingIssues: [bug(30)] });
    const f2 = pr(21, 6, { closingIssues: [bug(31)] });
    expect(accuracyFields(item, [r, f2, item, f1], opts)).toEqual({ revert_pr: 40, revert_days: 9, fix_prs: '20,21', first_fix_days: 2 });
    expect(accuracyFields(item, [item], opts)).toEqual({});
  });

  it('stores at most 20 fixes, the pattern\'s bound', () => {
    const many = Array.from({ length: MAX_FIX_PRS + 1 }, (_, k) => pr(100 + k, 1 + k, { closingIssues: [bug(30)] }));
    const fields = accuracyFields(item, many, opts);
    expect(fields.fix_prs?.split(',')).toHaveLength(MAX_FIX_PRS);
    expect(fields.fix_prs).toMatch(/^\d{1,9}(,\d{1,9}){0,19}$/);
  });
});

describe('the SZZ detector (diagnostic only)', () => {
  it('reads old-side ranges from the patch, or from `ranges`, skipping pure additions', () => {
    expect(oldRanges({ path: 'a', patch: '@@ -3,2 +3,4 @@ fn\n-x\n@@ -0,0 +1,2 @@\n+y\n@@ -9 +11 @@\n-z\n+z' })).toEqual([{ start: 3, count: 2 }, { start: 9, count: 1 }]);
    expect(oldRanges({ path: 'a', ranges: [{ start: 1, count: 0 }, { start: 5, count: 3 }] })).toEqual([{ start: 5, count: 3 }]);
    expect(oldRanges({ path: 'a', patch: null })).toEqual([]);
  });

  it('links a fix whose changed code lines blame back to the item, at the fix\'s parent', async () => {
    const item = pr(10, 0);
    const fix = pr(20, 3, { title: 'fix: x' });
    const blame = vi.fn(() => [sha(10)]);
    expect(await szzLinks(fix, [item, fix], { isCode, blame })).toEqual([{ pr: 10, days: 3 }]);
    expect(blame).toHaveBeenCalledWith('src/app.ts', [{ start: 1, count: 2 }], `${sha(20)}^`);
    // A head commit of an item merged without squashing counts too, and `parentSha` wins.
    const atParent = vi.fn(() => [sha(1010)]);
    expect(await szzLinks({ ...fix, parentSha: 'p'.repeat(40) }, [item], { isCode, blame: atParent })).toEqual([{ pr: 10, days: 3 }]);
    expect(atParent).toHaveBeenCalledWith('src/app.ts', [{ start: 1, count: 2 }], 'p'.repeat(40));
  });

  it('blames a renamed file under its old path', async () => {
    const blame = vi.fn(() => [sha(10)]);
    const fix = pr(20, 3, { files: [{ path: 'src/b.ts', previousPath: 'src/a.ts', status: 'renamed', patch: '@@ -4 +4 @@' }] });
    await szzLinks(fix, [pr(10, 0)], { isCode, blame });
    expect(blame).toHaveBeenCalledWith('src/a.ts', [{ start: 4, count: 1 }], `${sha(20)}^`);
  });

  it('never blames outside the code area: lines in a shared doc file link nothing', async () => {
    const item = pr(10, 0, { files: [{ path: 'docs/guide.md', status: 'modified' }] });
    const fix = pr(20, 3, { files: [{ path: 'docs/guide.md', status: 'modified', patch: '@@ -1,2 +1,2 @@' }] });
    const blame = vi.fn(() => [sha(10)]);
    expect(await szzLinks(fix, [item], { isCode, blame })).toEqual([]);
    expect(blame).not.toHaveBeenCalled();
  });

  it('links nothing when the lines blame to another commit, to a later item, or the fix has no merge commit', async () => {
    const item = pr(10, 0);
    const fix = pr(20, 3);
    expect(await szzLinks(fix, [item], { isCode, blame: () => [sha(11)] })).toEqual([]);
    expect(await szzLinks(fix, [pr(10, 5)], { isCode, blame: () => [sha(10)] })).toEqual([]);
    const blame = vi.fn(() => [sha(10)]);
    expect(await szzLinks({ ...fix, mergeCommitSha: null }, [item], { isCode, blame })).toEqual([]);
    expect(blame).not.toHaveBeenCalled();
  });

  it('blames no file whose diff has no old lines to blame', async () => {
    const blame = vi.fn(() => [sha(10)]);
    const fix = pr(20, 3, { files: [{ path: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1,3 @@' }, { path: 'src/big.ts', status: 'modified', patch: null }] });
    expect(await szzLinks(fix, [pr(10, 0)], { isCode, blame })).toEqual([]);
    expect(blame).not.toHaveBeenCalled();
  });

  it('does not match a SHA shorter than 7 characters', async () => {
    expect(await szzLinks(pr(20, 3), [pr(10, 0)], { isCode, blame: () => [sha(10).slice(0, 6)] })).toEqual([]);
  });
});

describe('isFixPr: the population the detectors are counted over', () => {
  it('a conventional `fix` title, or a closed `bug` issue', () => {
    expect(isFixPr(pr(1, 0, { title: 'fix: x' }))).toBe(true);
    expect(isFixPr(pr(1, 0, { title: 'fix(lanes)!: x' }))).toBe(true);
    expect(isFixPr(pr(1, 0, { title: 'feat: x', closingIssues: [bug(5)] }))).toBe(true);
    expect(isFixPr(pr(1, 0, { title: 'fixture: x' }))).toBe(false);
    expect(isFixPr(pr(1, 0, { title: 'feat: fix: x' }))).toBe(false);
    expect(isFixPr(pr(1, 0, { title: undefined }))).toBe(false);
  });
});

describe('detectorCounts: explicit and SZZ side by side, and the non-code gap', () => {
  // Items 10 and 11, then four fixes:
  //   20 explicit and SZZ           (bug issue 30 cross-references 10, its lines blame to 10)
  //   21 explicit only              (bug issue 31 cross-references 11, blame finds nothing)
  //   22 SZZ only, touches code     (no bug issue; blames to 10)
  //   23 neither, touches no code   (only a workflow file: the non-code gap)
  //   24 neither, touches code      (blame finds nothing)
  // and 40, a revert of 11; 41, an unmerged revert of 10, and 26, an unmerged fix, which count for nothing.
  const prs = [
    pr(10, 0, { timeline: [xref(30)] }),
    pr(11, 1, { timeline: [xref(31)] }),
    pr(20, 3, { title: 'fix: a', closingIssues: [bug(30)] }),
    pr(21, 4, { title: 'fix: b', closingIssues: [bug(31)], files: [{ path: 'src/app.ts', patch: '@@ -50 +50 @@' }] }),
    pr(22, 5, { title: 'fix: c' }),
    pr(23, 6, { title: 'fix(ci): d', files: [{ path: '.github/workflows/ci.yml', patch: '@@ -1 +1 @@' }] }),
    pr(24, 7, { title: 'fix: e', files: [{ path: 'src/app.ts', patch: '@@ -50 +50 @@' }] }),
    pr(40, 8, { title: 'revert: b', commits: [{ sha: sha(1040), message: `This reverts commit ${sha(11)}.` }] }),
    { ...pr(41, 9, { body: `Reverts ${REPO}#10` }), mergedAt: null },
    { ...pr(26, 9, { title: 'fix: unmerged', closingIssues: [bug(30)] }), mergedAt: null },
  ];
  const blame = (_path: string, ranges: { start: number }[]) => (ranges[0]?.start === 1 ? [sha(10)] : [sha(99)]);

  it('counts each detector, their overlap, the undetected fixes and the non-code gap', async () => {
    const { counts, fixes } = await detectorCounts(prs, { ...opts, blame });
    expect(counts).toEqual({
      fixes: 5, explicit: 2, szz: 2, both: 1, explicitOnly: 1, szzOnly: 1, neither: 2,
      undetected: 3, nonCodeGap: 1, revertedItems: 1, reverts: 1,
    });
    expect(fixes.map((f) => [f.pr, f.explicit.map((l) => l.pr), f.szz.map((l) => l.pr), f.touchesCode])).toEqual([
      [20, [10], [10], true], [21, [11], [], true], [22, [], [10], true], [23, [], [], false], [24, [], [], true],
    ]);
  });

  it('a detected fix is never in the non-code gap, and a rename out of the code area still touches code', async () => {
    const renamed = pr(25, 10, { title: 'fix: f', files: [{ path: 'docs/app.md', previousPath: 'src/app.ts', status: 'renamed' }] });
    const { counts } = await detectorCounts([...prs, renamed], { ...opts, blame });
    expect(counts.undetected).toBe(4);
    expect(counts.nonCodeGap).toBe(1);
  });
});
