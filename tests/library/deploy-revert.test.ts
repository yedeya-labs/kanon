import { describe, expect, it } from 'vitest';

/**
 * kanon#161: `readDeploy` decided containment by ancestry, so a release cut after a revert
 * of a closing merge still "contained every merge", and if its deploy job succeeded the
 * project read `deployed` for code no longer in the tree. Presence is now read from the
 * reverts in the range from each closing merge to the release that would be credited.
 */
const REPO = 'example-org/example-repo';
process.env.GITHUB_REPOSITORY = REPO;
const { readDeploy, revertTargets, revertedMerges } = await import('../../scripts/lead-reconcile.mjs');

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
const world = (releases: Release[], { closing = [[9, SHA1]] as Array<[number, string]>, prs = {} as Record<number, string>, unreadable = false, raw = undefined as string | undefined } = {}) => {
  const calls: string[][] = [];
  const ids = new Map(releases.map((r, i) => [r.tag, i + 1]));
  const io = {
    declared: () => DECLARED,
    json: (args: string[]) => {
      calls.push(args);
      if (args[0] === 'issue') return { closedByPullRequestsReferences: closing.map(([n]) => ({ number: n })) };
      if (args[0] === 'pr' && args.includes('state,mergeCommit')) {
        return { state: 'MERGED', mergeCommit: { oid: closing.find(([n]) => String(n) === args[2])![1] } };
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
      const tag = /compare\/[0-9a-f]+\.\.\.([^?]+)\?/.exec(args[2]!)![1];
      const upTo = releases.slice(0, releases.findIndex((r) => r.tag === tag) + 1);
      return upTo.flatMap((r) => r.after ?? [])
        .filter((c) => /reverts commit [0-9a-f]{7}|^Reverts [^ ]+#[0-9]/im.test(c.message))
        .map((c) => JSON.stringify(c)).join('\n');
    },
  };
  return { io, calls };
};
const CLOSED = [{ number: 1, state: 'CLOSED' }];
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

  it('reads history only for a release it would credit: one paginated compare per closing merge', () => {
    const { io, calls } = world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success' },
    ], { closing: [[9, SHA1], [10, SHA2]] });
    expect(readDeploy(CLOSED, io).state).toBe('deployed');
    const reads = calls.filter((a) => a.includes('--paginate')).map((a) => a[2]);
    expect(reads).toEqual([
      `repos/${REPO}/compare/${SHA1}...v1.0.1?per_page=100`,
      `repos/${REPO}/compare/${SHA2}...v1.0.1?per_page=100`,
    ]);
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
