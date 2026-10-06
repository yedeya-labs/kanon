import { describe, expect, it } from 'vitest';

/**
 * kanon#161: `readDeploy` decided containment by ancestry, so a release cut after a revert
 * of a closing merge still "contained every merge", and if its deploy job succeeded the
 * project read `deployed` for code no longer in the tree. Presence is now read from the
 * reverts in the range from each closing merge to the release that would be credited.
 */
const REPO = 'example-org/example-repo';
process.env.GITHUB_REPOSITORY = REPO;
const { readDeploy, revertTargets, revertedMerges, relandedReverts, namesReverted, closingMergeShas, closingMergesByIssue, REVERT_PREFILTER } = await import('../../scripts/lead-reconcile.mjs');

/** The production prefilter, evaluated with the one flag it is passed to gojq with. */
const prefilter = new RegExp(REVERT_PREFILTER, 'i');

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
 * from a merge to a tag is every earlier release's `after` plus its own, filtered as the
 * `--jq` filter would.
 */
const world = (releases: Release[], { closing = [[9, SHA1]] as Array<[number, string]>, issues = undefined as Record<number, Array<[number, string]>> | undefined, prs = {} as Record<number, string>, bodies = {} as Record<number, string>, unreadable = false, raw = undefined as string | undefined } = {}) => {
  const calls: string[][] = [];
  const ids = new Map(releases.map((r, i) => [r.tag, i + 1]));
  // Which pull requests close which issue: `closing` is issue 1's, unless `issues` says.
  const byIssue = issues ?? { 1: closing };
  const allClosing = Object.values(byIssue).flat();
  const io = {
    declared: () => DECLARED,
    json: (args: string[]) => {
      calls.push(args);
      if (args[0] === 'issue') return { closedByPullRequestsReferences: (byIssue[Number(args[2])] ?? []).map(([n]) => ({ number: n })) };
      if (args[0] === 'pr' && args.includes('state,mergeCommit,title,body')) {
        return { state: 'MERGED', mergeCommit: { oid: allClosing.find(([n]) => String(n) === args[2])![1] }, title: `PR ${args[2]}`, body: bodies[Number(args[2])] ?? '' };
      }
      if (args[0] === 'pr') return { mergeCommit: { oid: prs[Number(args[2])] ?? null } };
      if (args[0] === 'api') return [...releases].reverse().map((r) => ({ tag: r.tag }));
      if (args[0] === 'run' && args[1] === 'list') {
        return releases.map((r) => ({ displayTitle: r.tag, status: 'completed', conclusion: 'success', databaseId: ids.get(r.tag), url: `u-${r.tag}` }));
      }
      if (args[0] === 'run' && args[1] === 'view') {
        const r = releases.find((x) => String(ids.get(x.tag)) === args[2])!;
        return { jobs: [{ name: 'deploy', conclusion: r.deploy }] };
      }
      throw new Error(`unrouted: ${args.join(' ')}`);
    },
    text: (args: string[]) => {
      calls.push(args);
      if (!args.includes('--paginate')) return 'behind';
      if (unreadable) throw new Error('gh: 502');
      if (raw !== undefined) return raw;
      const [, base, tag] = /compare\/([0-9a-f]+)\.\.\.([^?]+)\?/.exec(args[2]!)!;
      const upTo = releases.slice(0, releases.findIndex((r) => r.tag === tag) + 1).flatMap((r) => r.after ?? []);
      // The range from a merge is what lands AFTER it; a merge not listed in `after` is
      // older than every release here.
      return upTo.slice(upTo.findIndex((c) => c.sha === base) + 1)
        .filter((c) => prefilter.test(c.message))
        .map((c) => JSON.stringify(c)).join('\n');
    },
  };
  return { io, calls };
};
const CLOSED = [{ number: 1, state: 'CLOSED' }];
const merge = (sha: string) => ({ sha, message: 'feat: the work, again' });
const revertOf = (sha: string, by: string) => ({ sha: by, message: `Revert "feat: the work"\n\nThis reverts commit ${sha}.` });

describe('readDeploy does not credit a release whose tree no longer holds the work (kanon#161)', () => {
  it('a closing merge reverted between two releases is not deployed', () => {
    // v1.0.0's gate declined, the merge was reverted, and v1.0.1 deployed: ancestry says
    // v1.0.1 contains the merge, and it does not.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success', after: [revertOf(SHA1, REV1)] },
    ]);
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.tag).toBe('v1.0.1');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a partial revert resolves to `reverted`, naming only the reverted merge', () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success', after: [revertOf(SHA2.slice(0, 12), REV2)] },
    ], { closing: [[9, SHA1], [10, SHA2]] });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA2, by: REV2 }]);
  });

  it('a later release that re-lands the work by reverting the revert is credited — it ends positive', () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [revertOf(REV1, RELAND)] },
    ]);
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('deployed');
    expect(d.tag).toBe('v1.0.1');
  });

  it('reads a revert that names the pull request rather than the commit', () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [{ sha: REV1, message: `Revert "feat: the work" (#12)\n\nReverts ${REPO}#9` }] },
    ], { prs: { 9: SHA1 } });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a revert of something else leaves the deploy credited', () => {
    const { io } = world([{ tag: 'v1.0.0', deploy: 'success', after: [revertOf('f6'.repeat(20), REV1)] }]);
    expect(readDeploy(CLOSED, io).state).toBe('deployed');
  });

  it('an unreadable history is not "no reverts": the project waits, the next tick re-reads', () => {
    const { io } = world([{ tag: 'v1.0.0', deploy: 'success' }], { unreadable: true });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('history-unreadable');
    expect(d.tag).toBe('v1.0.0');
  });

  it('an answer that is not a list of commits is unreadable too, never an empty history', () => {
    for (const raw of ['behind', '{"sha":"x"}', '"a string"', `{"message":"This reverts commit ${SHA1}."}`]) {
      const { io } = world([{ tag: 'v1.0.0', deploy: 'success' }], { raw });
      expect(readDeploy(CLOSED, io).state, raw).toBe('history-unreadable');
    }
  });

  it('names the NEWEST release that deployed without the work', () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success' },
    ]);
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.tag).toBe('v1.0.1');
  });

  it('reads history only for a release it would credit: one paginated compare per closing merge', () => {
    const { io, calls } = world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success' },
    ], { closing: [[9, SHA1], [10, SHA2]] });
    expect(readDeploy(CLOSED, io).state).toBe('deployed');
    const paged = calls.filter((a) => a.includes('--paginate'));
    // The pattern the stub evaluates, passed with `i` alone — gojq's `m` is not `(?m)`.
    for (const a of paged) expect(a[a.indexOf('--jq') + 1]).toContain(`test("${REVERT_PREFILTER}"; "i")`);
    const reads = paged.map((a) => a[2]);
    expect(reads).toEqual([
      `repos/${REPO}/compare/${SHA1}...v1.0.1?per_page=100`,
      `repos/${REPO}/compare/${SHA2}...v1.0.1?per_page=100`,
    ]);
  });
});

describe('work re-landed through a NEW pull request that closes the same issue (kanon#264)', () => {
  it('is credited once a release holding the re-land deploys', () => {
    // #9 merged, was reverted and shipped reverted in v1.0.0; #11 closed the same issue
    // again and shipped in v1.0.1.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: 'Re-lands #9, which was reverted.' } });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('deployed');
    expect(d.tag).toBe('v1.0.1');
  });

  it('a later merge of the same issue that does not name the reverted work is a different part, and the revert holds (kanon#280)', () => {
    // #9 and #11 each delivered part of issue 1; #11 was in flight when #9 was reverted,
    // and merged after the revert. History alone reads it exactly like a re-land.
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1)] },
      { tag: 'v1.0.1', deploy: 'success', after: [merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: 'The other half of the issue. Unrelated to #90.' } });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a second merge that landed BEFORE the revert re-lands nothing: a partial revert still holds', () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [merge(SHA2), revertOf(SHA1, REV1)] },
    ], { closing: [[9, SHA1], [10, SHA2]] });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a later merge closing a DIFFERENT issue re-lands nothing', () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1), merge(RELAND)] },
    ], { issues: { 1: [[9, SHA1]], 2: [[11, RELAND]] } });
    const d = readDeploy([{ number: 1, state: 'CLOSED' }, { number: 2, state: 'CLOSED' }], io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }]);
  });

  it('a re-land that was itself reverted re-lands nothing, and both are named', () => {
    const { io } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1), merge(RELAND), revertOf(RELAND, REV2)] },
    ], { closing: [[9, SHA1], [11, RELAND]] });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('reverted');
    expect(d.reverted).toEqual([{ sha: SHA1, by: REV1 }, { sha: RELAND, by: REV2 }]);
  });

  it('the re-land costs no extra call: one paginated compare per closing merge, as before', () => {
    const { io, calls } = world([
      { tag: 'v1.0.0', deploy: 'success', after: [revertOf(SHA1, REV1), merge(RELAND)] },
    ], { closing: [[9, SHA1], [11, RELAND]], bodies: { 11: `Re-lands ${SHA1.slice(0, 7)}.` } });
    expect(readDeploy(CLOSED, io).state).toBe('deployed');
    expect(calls.filter((a) => a.includes('--paginate')).map((a) => a[2])).toEqual([
      `repos/${REPO}/compare/${SHA1}...v1.0.0?per_page=100`,
      `repos/${REPO}/compare/${RELAND}...v1.0.0?per_page=100`,
    ]);
  });

  it('keeps the merges per issue, and the flat list is their concatenation', () => {
    const { io } = world([], { issues: { 1: [[9, SHA1], [11, RELAND]], 2: [[10, SHA2]], 3: [] } });
    const issues = [{ number: 1, state: 'CLOSED' }, { number: 2, state: 'CLOSED' }, { number: 3, state: 'CLOSED' }, { number: 4, state: 'OPEN' }];
    expect(closingMergesByIssue(issues, io).map(({ issue, shas }: { issue: number; shas: string[] }) => ({ issue, shas }))).toEqual([{ issue: 1, shas: [SHA1, RELAND] }, { issue: 2, shas: [SHA2] }]);
    expect(closingMergesByIssue(issues, io)[0].prs).toEqual([
      { number: 9, sha: SHA1, text: 'PR 9\n' }, { number: 11, sha: RELAND, text: 'PR 11\n' },
    ]);
    expect(closingMergeShas(issues, io)).toEqual([SHA1, RELAND, SHA2]);
  });
});

describe('which reverts a re-land answers', () => {
  const r1 = { sha: SHA1, by: REV1 };
  const ranges = (entries: Array<[string, string[]]>) => new Map(entries.map(([k, v]) => [k, new Set(v)]));
  const prs = (relandText: string) => [{ number: 9, sha: SHA1, text: '' }, { number: 11, sha: RELAND, text: relandText }];
  it('a later, unreverted merge of the same issue that names the reverted work answers the revert', () => {
    expect(relandedReverts([r1], [{ issue: 1, shas: [SHA1, RELAND], prs: prs('re-land #9') }], ranges([[SHA1, [REV1]], [RELAND, []]]))).toEqual([]);
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

describe('what a re-land must name (kanon#280)', () => {
  const target = { pr: 9, sha: SHA1, by: REV1 };
  it('names the reverted pull request, its merge or the revert', () => {
    for (const t of ['Re-lands #9', '#9', `Re-lands ${REPO}#9`, `see https://github.com/${REPO}/pull/9`,
      `re-land of ${SHA1.slice(0, 7)}`, `after ${REV1.slice(0, 12).toUpperCase()}`]) {
      expect(namesReverted(t, target, REPO), t).toBe(true);
    }
  });
  it('a different number, another repository\'s #9, a short or foreign hash names nothing', () => {
    for (const t of ['', '#90', '#19', 'other-org/other-repo#9', `https://github.com/other/repo/pull/9`,
      SHA1.slice(0, 6), 'f6'.repeat(4), 'issue9']) {
      expect(namesReverted(t, target, REPO), t).toBe(false);
    }
    expect(namesReverted('#9', { ...target, pr: null }, REPO)).toBe(false);
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
  // no flag but `i` reads the same in gojq and in JavaScript, which is what lets the stub
  // above evaluate the production pattern rather than a copy of it.
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
