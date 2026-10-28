import { describe, expect, it } from 'vitest';
import { fakeReads } from './helpers/fake-reader.js';

/**
 * kanon#1412: the Lead's phase-4 deploy read takes each closed issue's closing pull requests
 * from `closedByPullRequestsReferences`, which can list a pull request from ANOTHER
 * repository (`Fixes owner/A#N` in a body in repository B). The read asked only for the
 * number and read `pullRequest(number:)` in the project's own repository: a number that
 * doesn't exist here failed the project on every tick, and one that does read an unrelated
 * pull request's merge into the release walk.
 */
const REPO = 'example-org/example-repo';
const OTHER = 'someone-else/other-repo';
process.env.GITHUB_REPOSITORY = REPO;
const { readDeploy, closingMergesByIssue, linkedPrsRead } = await import('../../scripts/lead-reconcile.mjs');

const CLOSED = [{ number: 1, state: 'CLOSED' }];
const DECLARED = { environment: 'staging', workflow: 'deploy-staging.yml', job: 'deploy' };
const SHA_HERE = 'a1'.repeat(20);
const SHA_UNRELATED = 'f0'.repeat(20);
/** The reads of pull request #n's merge in this repository the fake saw. */
const mergeReadsOf = (seen: string[], n: number) => seen.filter((s) => s.startsWith('GraphQL PullRequestMerge') && s.includes(`"number":${n}`));
/** A release that contains, and deployed, every merge it is asked about. */
const deployedWorld = {
  releases: ['v1.0.0'],
  runs: [{ displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u1' }],
  jobs: { 1: [{ name: 'deploy', conclusion: 'success' }] },
  compare: () => 'behind',
  compareCommits: () => [],
};

describe('a closing pull request from another repository (kanon#1412)', () => {
  it('is never read by its number in this repository', async () => {
    // #9 exists here too, and is an unrelated merge: the defect credited its commit.
    const io = fakeReads({
      closedBy: { 1: [{ number: 9, repo: OTHER, state: 'MERGED' }] },
      prs: { 9: { state: 'MERGED', mergeCommit: { oid: SHA_UNRELATED } } },
    }, { repo: REPO });
    const byIssue = await closingMergesByIssue(CLOSED, io);
    expect(mergeReadsOf(io.seen, 9)).toEqual([]);
    expect(byIssue.flatMap((i: { shas: string[] }) => i.shas)).not.toContain(SHA_UNRELATED);
    expect(byIssue).toEqual([{ issue: 1, shas: [], prs: [], elsewhere: [{ number: 9, repo: OTHER }] }]);
  });

  it('holds the deploy read by name instead of failing the project every tick', async () => {
    // No #9 here at all: before, the read threw on every tick and the project never closed.
    const io = fakeReads({ closedBy: { 1: [{ number: 9, repo: OTHER, state: 'MERGED' }] }, prs: {} }, { repo: REPO });
    const d = await readDeploy(CLOSED, { ...io, declared: () => DECLARED });
    // Nothing here closed the issue, so nothing here is owed a deploy (kanon#1435).
    expect(d).toEqual({ state: 'merged-elsewhere', here: 'nothing-to-deploy', merges: [{ issue: 1, number: 9, repo: OTHER }] });
  });

  it('holds even when this repository\'s own merges deployed: the release cannot hold the other repository\'s work', async () => {
    const io = fakeReads({
      ...deployedWorld,
      closedBy: { 1: [7, { number: 9, repo: OTHER, state: 'MERGED' }] },
      prs: { 7: { state: 'MERGED', mergeCommit: { oid: SHA_HERE } } },
    }, { repo: REPO });
    const d = await readDeploy(CLOSED, { ...io, declared: () => DECLARED });
    expect(d.state).toBe('merged-elsewhere');
    // kanon#1435: the hold carries this repository's own verdict, so its message can name it.
    expect(d).toMatchObject({ here: 'deployed', tag: 'v1.0.0', url: 'u1', environment: 'staging' });
    expect(mergeReadsOf(io.seen, 9)).toEqual([]);
    // The control: without the other repository's merge, the same world deploys.
    const own = fakeReads({ ...deployedWorld, closedBy: { 1: [7] }, prs: { 7: { state: 'MERGED', mergeCommit: { oid: SHA_HERE } } } }, { repo: REPO });
    expect((await readDeploy(CLOSED, { ...own, declared: () => DECLARED })).state).toBe('deployed');
  });

  // kanon#1435: the hold used to return before this repository's own merges were walked, so
  // a project whose own work never shipped was handed to a human to close on the other
  // repository's deploy alone.
  it.each([
    ['no release contains them', { releases: [] }, 'awaiting-release'],
    ['their release failed to deploy', { jobs: { 1: [{ name: 'deploy', conclusion: 'failure' }] } }, 'failed'],
    ['their release\'s deploy was skipped', { jobs: { 1: [{ name: 'deploy', conclusion: 'skipped' }] } }, 'gate-declined'],
  ])('reports this repository\'s own state, not the hold, when %s', async (_w, world, state) => {
    const io = fakeReads({
      ...deployedWorld,
      ...world,
      closedBy: { 1: [7, { number: 9, repo: OTHER, state: 'MERGED' }] },
      prs: { 7: { state: 'MERGED', mergeCommit: { oid: SHA_HERE } } },
    }, { repo: REPO });
    const d = await readDeploy(CLOSED, { ...io, declared: () => DECLARED });
    expect(d.state).toBe(state);
    expect(d).not.toHaveProperty('merges');
  });

  it('ignores one that hasn\'t merged, as an unmerged pull request here is ignored', async () => {
    const io = fakeReads({ closedBy: { 1: [{ number: 9, repo: OTHER, state: 'OPEN' }] }, prs: {} }, { repo: REPO });
    expect((await readDeploy(CLOSED, { ...io, declared: () => DECLARED })).state).toBe('nothing-to-deploy');
  });

  it('matches this repository whatever the case of its name', async () => {
    const io = fakeReads({
      ...deployedWorld,
      closedBy: { 1: [{ number: 7, repo: REPO.toUpperCase(), state: 'MERGED' }] },
      prs: { 7: { state: 'MERGED', mergeCommit: { oid: SHA_HERE } } },
    }, { repo: REPO });
    expect((await readDeploy(CLOSED, { ...io, declared: () => DECLARED })).state).toBe('deployed');
  });

  it('fails the read when a closing pull request\'s repository is missing, rather than guessing it is this one', async () => {
    const io = fakeReads({
      graphql: { ClosedBy: () => ({ repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } } } }) },
      prs: { 9: { state: 'MERGED', mergeCommit: { oid: SHA_UNRELATED } } },
    }, { repo: REPO });
    await expect(closingMergesByIssue(CLOSED, io)).rejects.toThrow(/#9's repository/);
  });

  it('asks GitHub for each closing pull request\'s repository and state', async () => {
    // GraphQL returns only the fields a query names, so a fake that answers every field
    // can't see the query lose one. This one answers what the query asks for, as GitHub does.
    const reader = {
      graphql: (query: string) => {
        const node = query.match(/closedByPullRequestsReferences\([^)]*\)\s*\{\s*nodes\s*\{([^}]*\{[^}]*\}[^}]*|[^}]*)\}/)?.[1] ?? '';
        return { repository: { issue: { closedByPullRequestsReferences: {
          nodes: [{
            number: 9,
            ...(/\bstate\b/.test(node) ? { state: 'MERGED' } : {}),
            ...(/repository\s*\{\s*nameWithOwner\s*\}/.test(node) ? { repository: { nameWithOwner: OTHER } } : {}),
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } };
      },
      get: () => { throw new Error('no REST read expected'); },
      pages: () => { throw new Error('no REST read expected'); },
    };
    expect(await closingMergesByIssue(CLOSED, { reader, repo: REPO })).toEqual([{ issue: 1, shas: [], prs: [], elsewhere: [{ number: 9, repo: OTHER }] }]);
  });

  it('is left out of an issue\'s linked pull requests, by name, and never read here', async () => {
    const warned: string[] = [];
    const io = fakeReads({
      closedBy: { 1: [7, { number: 9, repo: OTHER, state: 'OPEN' }] },
      prs: {
        7: { number: 7, state: 'OPEN', headRefOid: 'abc', commits: [], reviews: [], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' },
        9: { number: 9, state: 'OPEN', headRefOid: 'unrelated', commits: [], reviews: [], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' },
      },
    }, { repo: REPO, warn: (m) => warned.push(m) });
    const read = await linkedPrsRead(1, io);
    expect(read.ok).toBe(true);
    expect(read.prs.map((p: { number: number }) => p.number)).toEqual([7]);
    expect(io.seen.filter((s) => s.startsWith('GraphQL PullRequest ') && s.includes('"number":9'))).toEqual([]);
    expect(warned.join('\n')).toContain(`${OTHER}#9`);
  });
});
