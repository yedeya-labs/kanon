import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fakeReads, FakeHttpError, type FakePr } from './helpers/fake-reader.js';

/**
 * kanon#161: `readDeploy` decided containment by ancestry, so a release cut after a revert
 * of a closing merge still "contained every merge", and if its deploy job succeeded the
 * project read `deployed` for code no longer in the tree. Presence is now read from the
 * reverts in the range from each closing merge to the release that would be credited.
 */
const REPO = 'example-org/example-repo';
process.env.GITHUB_REPOSITORY = REPO;
const { readDeploy, revertTargets, revertedMerges, relandedReverts, namesReverted, closingMergeShas, closingMergesByIssue, REVERT_PREFILTER } = await import('../../scripts/lead-reconcile.mjs');

/** The production prefilter, evaluated with the one flag the reconciler compiles it with. */
const prefilter = new RegExp(REVERT_PREFILTER, 'i');
/** The reconciler's source, for what a read no longer carries (the prefilter's flags). */
const SOURCE = readFileSync(new URL('../../scripts/lead-reconcile.mjs', import.meta.url), 'utf8');

const DECLARED = { environment: 'staging', workflow: 'deploy-staging.yml', job: 'deploy' };
const SHA1 = 'a1'.repeat(20);
const SHA2 = 'b2'.repeat(20);
const REV1 = 'c3'.repeat(20);
const REV2 = 'd4'.repeat(20);
const RELAND = 'e5'.repeat(20);

type Release = { tag: string; deploy: 'success' | 'skipped'; after?: Array<{ sha: string; message: string }> };

/**
 * The `io` seam for releases given OLDEST FIRST. Every release contains every closing merge
 * (ancestry is not what is under test). `after` is the commits a release adds; the range
 * from a merge to a tag is every earlier release's `after` plus its own, EVERY commit of it,
 * as the compare API returns them: the reconciler filters them by the prefilter itself.
 * `raw` is a compare answer given verbatim, as its pages; `calls` is every read the reader saw.
 */
const world = (releases: Release[], { closing = [[9, SHA1]] as Array<[number, string]>, issues = undefined as Record<number, Array<[number, string]>> | undefined, prs = {} as Record<number, string>, bodies = {} as Record<number, string>, unreadable = false, raw = undefined as unknown[] | undefined, repo: as = REPO } = {}) => {
  const ids = new Map(releases.map((r, i) => [r.tag, i + 1]));
  // Which pull requests close which issue: `closing` is issue 1's, unless `issues` says.
  const byIssue = issues ?? { 1: closing };
  const allClosing = Object.values(byIssue).flat();
  const fakePrs: Record<number, FakePr> = {};
  // A pull request a revert names, by its merge commit alone.
  for (const [n, sha] of Object.entries(prs)) fakePrs[Number(n)] = { mergeCommit: { oid: sha } };
  // A closing pull request, merged, with its title and body.
  for (const [n, sha] of allClosing) fakePrs[n] = { state: 'MERGED', mergeCommit: { oid: sha }, title: `PR ${n}`, body: bodies[n] ?? '' };
  const { reader, repo, seen } = fakeReads({
    closedBy: Object.fromEntries(Object.entries(byIssue).map(([i, c]) => [i, c.map(([n]) => n)])),
    prs: fakePrs,
    releases: [...releases].reverse().map((r) => r.tag),
    runs: releases.map((r) => ({ displayTitle: r.tag, status: 'completed', conclusion: 'success', databaseId: ids.get(r.tag)!, url: `u-${r.tag}` })),
    jobs: Object.fromEntries(releases.map((r) => [ids.get(r.tag)!, [{ name: 'deploy', conclusion: r.deploy }]])),
    compare: () => 'behind',
    pages: (path) => {
      if (!/\/compare\//.test(path)) return undefined;
      if (unreadable) throw new FakeHttpError(`PAGES ${path}`, 502);
      return raw;
    },
    compareCommits: (base, tag) => {
      const upTo = releases.slice(0, releases.findIndex((r) => r.tag === tag) + 1).flatMap((r) => r.after ?? []);
      // The range from a merge is what lands AFTER it; a merge not listed in `after` is
      // older than every release here.
      return upTo.slice(upTo.findIndex((c) => c.sha === base) + 1)
        .map((c) => ({ sha: c.sha, commit: { message: c.message } }));
    },
  }, { repo: as });
  const io = { declared: () => DECLARED, reader, repo };
  return { io, calls: seen };
};
const CLOSED = [{ number: 1, state: 'CLOSED' }];
const merge = (sha: string) => ({ sha, message: 'feat: the work, again' });
const revertOf = (sha: string, by: string) => ({ sha: by, message: `Revert "feat: the work"\n\nThis reverts commit ${sha}.` });

describe('readDeploy does not credit a release whose tree no longer holds the work (kanon#161)', () => {
  it('a closing merge reverted between two releases is not deployed', async () => {
    // v1.0.0's gate declined, the merge was reverted, and v1.0.1 deployed: ancestry says
    // v1.0.1 contains the merge, and it does not.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success', after: [revertOf(SHA1, REV1)] },
    ]);
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.tag).toBe('v1.0.1');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a partial revert resolves to `reverted`, naming only the reverted merge', async () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success', after: [revertOf(SHA2.slice(0, 12), REV2)] },
    ], { closing: [[9, SHA1], [10, SHA2]] });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA2, by: REV2 }]);
  });

  it('a later release that re-lands the work by reverting the revert is credited — it ends positive', async () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [revertOf(REV1, RELAND)] },
    ]);
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('deployed');
    expect(d.tag).toBe('v1.0.1');
  });

  it('reads a revert that names the pull request rather than the commit', async () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [{ sha: REV1, message: `Revert "feat: the work" (#12)\n\nReverts ${REPO}#9` }] },
    ], { prs: { 9: SHA1 } });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a revert of something else leaves the deploy credited', async () => {
    const { io } = world([{ tag: 'v1.0.0', deploy: 'success', after: [revertOf('f6'.repeat(20), REV1)] }]);
    expect((await readDeploy(CLOSED, io)).state).toBe('deployed');
  });

  it('an unreadable history is not "no reverts": the project waits, the next tick re-reads', async () => {
    const { io } = world([{ tag: 'v1.0.0', deploy: 'success' }], { unreadable: true });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('history-unreadable');
    expect(d.tag).toBe('v1.0.0');
  });

  it('an answer that is not a list of commits is unreadable too, never an empty history', async () => {
    // The compare's pages, verbatim. These were `gh --jq` text lines once, so each shape the
    // text could take is here as the API answer that would carry it: a page that is no
    // comparison, a commit without a message, a bare string, a revert message with no commit.
    const answers: unknown[][] = [
      ['behind'],
      [{ sha: 'x' }],
      [{ commits: [{ sha: 'x' }] }],
      [{ commits: ['a string'] }],
      [{ commits: [{ commit: { message: `This reverts commit ${SHA1}.` } }] }],
      [{ commits: [{ message: `This reverts commit ${SHA1}.` }] }],
    ];
    for (const raw of answers) {
      const { io } = world([{ tag: 'v1.0.0', deploy: 'success' }], { raw });
      expect((await readDeploy(CLOSED, io)).state, JSON.stringify(raw)).toBe('history-unreadable');
    }
  });

  it('names the NEWEST release that deployed without the work', async () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success' },
    ]);
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.tag).toBe('v1.0.1');
  });

  it('reads history only for a release it would credit: one paginated compare per closing merge', async () => {
    const { io, calls } = world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success' },
    ], { closing: [[9, SHA1], [10, SHA2]] });
    expect((await readDeploy(CLOSED, io)).state).toBe('deployed');
    const paged = calls.filter((c) => c.startsWith('PAGES ') && c.includes('/compare/'));
    // The prefilter no longer travels with the read (it was a `gh --jq` filter); the reconciler
    // applies it to the pages itself, so the stub answers every commit and what is guarded is
    // that the production pattern is compiled with `i` alone, as it was passed to gojq.
    expect(SOURCE).toContain("new RegExp(REVERT_PREFILTER, 'i')");
    const reads = paged.map((c) => c.slice('PAGES '.length));
    expect(reads).toEqual([
      `repos/${REPO}/compare/${SHA1}...v1.0.1?per_page=100`,
      `repos/${REPO}/compare/${SHA2}...v1.0.1?per_page=100`,
    ]);
  });
});

describe('work re-landed through a NEW pull request that closes the same issue (kanon#264)', () => {
  it('is credited once a release holding the re-land deploys', async () => {
    // #9 merged, was reverted and shipped reverted in v1.0.0; #11 closed the same issue
    // again and shipped in v1.0.1.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: 'Re-lands #9, which was reverted.' } });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('deployed');
    expect(d.tag).toBe('v1.0.1');
  });

  it('reads the re-land against the repository the read was given, not GITHUB_REPOSITORY (project #1327)', async () => {
    // The status view reads another project's repository from the CLI or the hosted
    // server, where `GITHUB_REPOSITORY` is unset or names a different one. A re-land that
    // names the reverted pull request by its full reference must still be credited, or the
    // view holds at `reverted` while the tick inside that repository moves on.
    const OTHER = 'acme/shop';
    expect(process.env.GITHUB_REPOSITORY).not.toBe(OTHER);
    for (const body of [`Re-lands ${OTHER}#9.`, `Restores https://github.com/${OTHER}/pull/9`]) {
      const { io } = world([
        { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
        { tag: 'v1.0.1', deploy: 'success', after: [merge(RELAND)] },
      ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: body }, repo: OTHER });
      expect((await readDeploy(CLOSED, io)).state, body).toBe('deployed');
    }
    // And the module's own repository names nothing in another's.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: `Re-lands ${REPO}#9.` }, repo: OTHER });
    expect((await readDeploy(CLOSED, io)).state).toBe('reverted');
  });

  it('a later merge of the same issue that does not name the reverted work is a different part, and the revert holds (kanon#280)', async () => {
    // #9 and #11 each delivered part of issue 1; #11 was in flight when #9 was reverted,
    // and merged after the revert. History alone reads it exactly like a re-land.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: 'The other half of the issue. Unrelated to #90.' } });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a later merge that only cites the reverted pull request is a sibling too, and the revert holds (kanon#357)', async () => {
    // #11 delivered the other part of issue 1 and merged after #9's revert. It mentions #9
    // for context, which is no re-land: the release still lacks #9's work.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: 'Part 2 of the issue, follows #9.' } });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a second merge that landed BEFORE the revert re-lands nothing: a partial revert still holds', async () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [merge(SHA2), revertOf(SHA1, REV1)] },
    ], { closing: [[9, SHA1], [10, SHA2]] });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a later merge closing a DIFFERENT issue re-lands nothing', async () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1), merge(RELAND)] },
    ], { issues: { 1: [[9, SHA1]], 2: [[11, RELAND]] } });
    const d = await readDeploy([{ number: 1, state: 'CLOSED' }, { number: 2, state: 'CLOSED' }], io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a re-land that was itself reverted re-lands nothing, and both are named', async () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1), merge(RELAND), revertOf(RELAND, REV2)] },
    ], { closing: [[9, SHA1], [11, RELAND]] });
    const d = await readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }, { sha: RELAND, by: REV2 }]);
  });

  it('the re-land costs no extra call: one paginated compare per closing merge, as before', async () => {
    const { io, calls } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1), merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: `Re-lands ${SHA1.slice(0, 7)}.` } });
    expect((await readDeploy(CLOSED, io)).state).toBe('deployed');
    expect(calls.filter((c) => c.startsWith('PAGES ') && c.includes('/compare/')).map((c) => c.slice('PAGES '.length))).toEqual([
      `repos/${REPO}/compare/${SHA1}...v1.0.0?per_page=100`,
      `repos/${REPO}/compare/${RELAND}...v1.0.0?per_page=100`,
    ]);
  });

  it('keeps the merges per issue, and the flat list is their concatenation', async () => {
    const { io } = world([], { issues: { 1: [[9, SHA1], [11, RELAND]], 2: [[10, SHA2]], 3: [] } });
    const issues = [{ number: 1, state: 'CLOSED' }, { number: 2, state: 'CLOSED' }, { number: 3, state: 'CLOSED' }, { number: 4, state: 'OPEN' }];
    expect((await closingMergesByIssue(issues, io)).map(({ issue, shas }: { issue: number; shas: string[] }) => ({ issue, shas }))).toEqual([{ issue: 1, shas: [SHA1, RELAND] }, { issue: 2, shas: [SHA2] }]);
    expect((await closingMergesByIssue(issues, io))[0].prs).toEqual([
      { number: 9, sha: SHA1, text: 'PR 9\n' }, { number: 11, sha: RELAND, text: 'PR 11\n' },
    ]);
    expect(await closingMergeShas(issues, io)).toEqual([SHA1, RELAND, SHA2]);
  });
});

describe('which reverts a re-land answers', () => {
  const r1 = { sha: SHA1, by: REV1 };
  const ranges = (entries: Array<[string, string[]]>) => new Map(entries.map(([k, v]) => [k, new Set(v)]));
  const prs = (relandText: string) => [{ number: 9, sha: SHA1, text: '' }, { number: 11, sha: RELAND, text: relandText }];
  it('a later, unreverted merge of the same issue that names the reverted work answers the revert', () => {
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1, RELAND], prs: prs('re-land #9') }], ranges([[SHA1, [REV1]], [RELAND, []]]))).toEqual([]);
  });
  it('the same merge citing the reverted pull request without re-landing it answers nothing (kanon#357)', () => {
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1, RELAND], prs: prs('Part 2 of the issue, follows #9') }], ranges([[SHA1, [REV1]], [RELAND, []]]))).toEqual([r1]);
  });
  it('the same merge naming nothing answers nothing: it may be a different part of the issue (kanon#280)', () => {
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1, RELAND], prs: prs('the other part') }], ranges([[SHA1, [REV1]], [RELAND, []]]))).toEqual([r1]);
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1, RELAND] }], ranges([[SHA1, [REV1]], [RELAND, []]]))).toEqual([r1]);
  });
  it('an earlier merge (the revert is in its range) answers nothing', () => {
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1, SHA2] }], ranges([[SHA1, [REV1]], [SHA2, [REV1]]]))).toEqual([r1]);
  });
  it('a reverted merge answers nothing, even when it is later', () => {
    const r2 = { sha: RELAND, by: REV2 };
    expect(relandedReverts([r1, r2], [{ issue: 1, shas: [SHA1, RELAND] }], ranges([[SHA1, [REV1, REV2]], [RELAND, [REV2]]]))).toEqual([r1, r2]);
  });
  it('a merge of another issue answers nothing', () => {
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1] }, { issue: 2, shas: [RELAND] }], ranges([[SHA1, [REV1]], [RELAND, []]]))).toEqual([r1]);
  });
  it('a merge with no range read answers nothing', () => {
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1, RELAND] }], ranges([[SHA1, [REV1]]]))).toEqual([r1]);
  });
});

describe('what a re-land must name (kanon#280, kanon#357)', () => {
  const target = { pr: 9, sha: SHA1, by: REV1 };
  it('says it re-lands the reverted pull request or its merge, or names the revert', () => {
    for (const t of ['Re-lands #9', `Re-lands ${REPO}#9`, `restores https://github.com/${REPO}/pull/9`,
      `re-land of ${SHA1.slice(0, 7)}`, 'Reland #9, which was reverted.', 'feat: the work, re-applied from #9',
      'Brings back #9', `Revert "Revert "feat: the work (#9)""`, 'This is the revert of the revert of #9',
      'Part 2.\nAlso re-lands #9', `after ${REV1.slice(0, 12).toUpperCase()}`, `Follows the revert ${REV1.slice(0, 7)}.`]) {
      expect(namesReverted(t, target, REPO), t).toBe(true);
    }
  });
  it('a mention of the reverted pull request or its merge with no re-land word is not a re-land (kanon#357)', () => {
    // A sibling that delivers another part of the issue commonly cites the first.
    for (const t of ['#9', 'Part 2 of the issue, follows #9', 'builds on #9', `see https://github.com/${REPO}/pull/9`,
      `Follows ${SHA1.slice(0, 7)}`, '#9 will be re-landed later', 'Re-land is tracked elsewhere. Follows #9',
      'Restore the cache; part 2 of #9', 'Re-lands nothing\nbuilds on #9']) {
      expect(namesReverted(t, target, REPO), t).toBe(false);
    }
  });
  it('a different number, another repository\'s #9, a short or foreign hash names nothing', () => {
    for (const t of ['', 'Re-lands #90', 'Re-lands #19', 'Re-lands other-org/other-repo#9', 'Re-lands https://github.com/other/repo/pull/9',
      `Re-lands ${SHA1.slice(0, 6)}`, `Re-lands ${'f6'.repeat(4)}`, 'Re-lands issue9', REV1.slice(0, 6)]) {
      expect(namesReverted(t, target, REPO), t).toBe(false);
    }
    expect(namesReverted('Re-lands #9', { ...target, pr: null }, REPO)).toBe(false);
  });
});

describe('what a commit message says it reverts', () => {
  it('names commits as git and GitHub write them, and only this repository\'s pull requests', () => {
    expect(revertTargets(`Revert "x"\n\nThis reverts commit ${SHA1}.`, REPO)).toEqual({ shas: [SHA1], prs: [] });
    expect(revertTargets('This reverts commit ABCDEF1.\nThis reverts commit 1234567890.', REPO)).toEqual({ shas: ['abcdef1', '1234567890'], prs: [] });
    expect(revertTargets(`Reverts ${REPO}#9`, REPO)).toEqual({ shas: [], prs: [9] });
    expect(revertTargets('Reverts EXAMPLE-ORG/Example-Repo#9', REPO).prs).toEqual([9]);
    expect(revertTargets('Reverts someone-else/fork#9', REPO).prs).toEqual([]);
    // Not a revert: too short to be a commit, or a PR number mentioned mid-line.
    expect(revertTargets('This reverts commit abc12.\nIt Reverts example-org/example-repo#9', REPO)).toEqual({ shas: [], prs: [] });
  });
});

describe('the --jq prefilter keeps every revert the parser reads (kanon#262 review)', () => {
  // `gh --jq` is gojq, whose `m` flag is `(?s)`, not `(?m)`. A pattern with no anchor and
  // no flag but `i` reads the same in gojq and in JavaScript, which is what let the stub
  // above evaluate the production pattern rather than a copy of it; the reconciler now runs
  // it in JavaScript itself (project #1327), and it still holds to that shape.
  it('is flag-independent: no anchor, so gojq and JavaScript agree on it', () => {
    // `^` only as a class negation (`[^ ]`); never `$` or an inline flag group.
    expect(REVERT_PREFILTER).not.toMatch(/(^|[^[])\^|\$|\(\?/);
  });
  it.each([
    [`Revert "x"\n\nThis reverts commit ${SHA1}.`],
    [`Revert "feat: the work" (#12)\n\nReverts ${REPO}#9`],
    [`Revert "feat: the work" (#12) (#13)\n\n* Reverts ${REPO}#9\nReverts ${REPO}#10`],
    ['this REVERTS COMMIT ABCDEF1'],
  ])('keeps %j', (message) => {
    const t = revertTargets(message, REPO);
    expect(t.shas.length + t.prs.length, 'the parser reads a revert here').toBeGreaterThan(0);
    expect(prefilter.test(message)).toBe(true);
  });
});

describe('which merges a revert undoes', () => {
  it('a revert undoes the merge it names, by full SHA or prefix', () => {
    expect(revertedMerges([SHA1], [{ sha: REV1, targets: [SHA1.slice(0, 7)] }])).toEqual([{ sha: SHA1, by: REV1 }]);
  });
  it('a reverted revert undoes nothing, and a third revert undoes it again', () => {
    const rev = { sha: REV1, targets: [SHA1] };
    const reland = { sha: RELAND, targets: [REV1] };
    expect(revertedMerges([SHA1], [rev, reland])).toEqual([]);
    expect(revertedMerges([SHA1], [rev, reland, { sha: REV2, targets: [RELAND] }])).toEqual([{ sha: SHA1, by: REV1 }]);
  });
  it('a second, independent revert of the same merge still undoes it after the first is re-landed', () => {
    const commits = [{ sha: REV1, targets: [SHA1] }, { sha: RELAND, targets: [REV1] }, { sha: REV2, targets: [SHA1] }];
    expect(revertedMerges([SHA1], commits)).toEqual([{ sha: SHA1, by: REV2 }]);
  });
  it('nothing reverted, nothing named', () => {
    expect(revertedMerges([SHA1, SHA2], [])).toEqual([]);
  });
});
