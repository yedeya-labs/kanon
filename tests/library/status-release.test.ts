/**
 * The status core's release view (project #1327, Issue E): the open release pull request, the
 * latest release and pre-release, each declared environment's last deploy as the reconciler's
 * deploy read finds it, and, where the default branch runs Kanon's promotion workflow, each gate's
 * verdict and evidence from the promotion's own read-only check.
 */
import { describe, expect, it } from 'vitest';
import { FakeHttpError } from './helpers/fake-reader.js';
import { JOBS, PIN, PROMOTION_NOW, PROMOTION_ROUTES, PULLS, RELEASES, RUNS, SHA, WORKFLOWS, chain, file, job, page, promoting, run } from './helpers/release-world.js';
import { CHAIN_DEPLOY, RELEASE_NOW, adopterFiles, adoptionWith, releaseWorld } from './helpers/status-world.js';

const { releaseView } = await import('../../scripts/status/release.mjs');
const { IncompleteRead } = await import('../../scripts/status/project.mjs');
const { ReadError } = await import('../../scripts/status/reader.mjs');
const { ApiError, check } = await import('../../scripts/promote.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('the release view', () => {
  it('[STAT-9] gives the open release pull request, the latest release, the latest pre-release with its age, and each declared environment\'s last deploy', async () => {
    const w = chain();
    const view: Any = await releaseView({ reader: w.reader, repo: w.repo, now: new Date(RELEASE_NOW) });
    expect(view.branch).toBe('main');
    // The release pull request as the metrics' detector knows one: the Releaser's, with
    // release-please's label. A person's pull request with a release's title is not one.
    expect(view.releasePrs).toEqual([{ number: 40, title: 'chore(main): release 2.2.0', url: 'https://github.com/acme/shop/pull/40', createdAt: '2026-10-23T08:00:00Z' }]);
    expect(view.latest).toEqual({ tag: 'v2.1.0', name: 'v2.1.0', url: RELEASES[1]!.html_url, publishedAt: '2026-10-20T00:00:00Z' });
    expect(view.preRelease).toEqual({ tag: 'v2.2.0-rc.1', name: 'v2.2.0-rc.1', url: RELEASES[0]!.html_url, publishedAt: '2026-10-22T09:30:00Z', ageHours: 48 });

    // Each environment of the chain, its job named as the deploy caller names it, and its last
    // deploy: the run found for a release by its tag or its commit, and the job's own outcome.
    // Production's job was skipped on the pre-release, so its last deploy is the release before.
    expect(view.deploys).toEqual([
      { environment: 'staging', workflow: 'deploy.yml', job: 'staging / deploy', last: { tag: 'v2.2.0-rc.1', outcome: 'deployed', url: run(503) } },
      { environment: 'production', workflow: 'deploy.yml', job: 'production / deploy', last: { tag: 'v2.1.0', outcome: 'failed', url: run(502) } },
    ]);
    expect(w.seen, 'the run titled by its commit was found by the tag\'s commit').toContain('GET repos/acme/shop/commits/v2.2.0-rc.1');
    // A deploy waiting on its approval is deploying.
    const waiting = chain({
      runs: [{ ...RUNS[0]!, status: 'in_progress', conclusion: null }, ...RUNS.slice(1)],
      jobs: { ...JOBS, 503: [job('staging / deploy', 'success'), job('production / deploy', null, 'waiting')] },
    });
    const wv: Any = await releaseView({ reader: waiting.reader, repo: waiting.repo, now: new Date(RELEASE_NOW) });
    expect(wv.deploys[1].last).toEqual({ tag: 'v2.2.0-rc.1', outcome: 'deploying', url: run(503) });

    // A record that declares only the reference deploy declares its one environment. One whose
    // reference job isn't named as the deploy caller names it names no job for the others.
    const read = (x: ReturnType<typeof releaseWorld>): Promise<Any> => releaseView({ reader: x.reader, repo: x.repo, now: new Date(RELEASE_NOW) });
    const reference = await read(releaseWorld({
      releases: RELEASES, latest: RELEASES[1], runs: [{ databaseId: 9, displayTitle: 'v2.1.0', status: 'completed', conclusion: 'success', url: run(9) }], jobs: { 9: [job('ship', 'success')] },
    }));
    expect(reference.deploys).toEqual([{ environment: 'preview', workflow: 'deploy-preview.yml', job: 'ship', last: { tag: 'v2.1.0', outcome: 'deployed', url: run(9) } }]);
    const custom = await read(chain({
      files: adopterFiles(undefined, { 'docs/qa/adoption.md': adoptionWith(CHAIN_DEPLOY.replace('`staging / deploy`', '`ship`')) }),
    }));
    expect(custom.deploys.map((d: Any) => [d.environment, d.job, d.last?.tag ?? null])).toEqual([['staging', 'ship', null], ['production', null, null]]);

    // Nothing to report is reported as nothing: no release pull request, release or environment.
    const bare = await read(releaseWorld({ files: adopterFiles(undefined, { 'docs/qa/adoption.md': adoptionWith('## Deploy\n\nNone.\n') }) }));
    expect([bare.releasePrs, bare.latest, bare.preRelease, bare.deploys, bare.promotion]).toEqual([[], null, null, [], null]);
  });

  it('[STAT-9] gives each promotion gate\'s verdict and evidence from the promotion\'s own check, only where the default branch runs its workflow', async () => {
    const w = promoting();
    const view: Any = await releaseView({ reader: w.reader, repo: w.repo, now: PROMOTION_NOW });

    // The promotion's own check, given the same reads, answers the same.
    const api = (path: string, { raw = false }: { raw?: boolean } = {}) => {
      let body: Any;
      try {
        body = promoting().reader.get(path);
      } catch (e) {
        throw new ApiError(`${path}: HTTP ${(e as FakeHttpError).status}`, (e as FakeHttpError).status ?? null);
      }
      return raw ? Buffer.from(body.content, 'base64').toString('utf8') : body;
    };
    const workflows = Object.entries(WORKFLOWS).map(([f, text]) => ({ file: f, text }));
    const direct = check({ GITHUB_REPOSITORY: 'acme/shop', DEFAULT_BRANCH: 'main' }, { api, now: PROMOTION_NOW.getTime(), workflows });
    expect(view.promotion).toEqual({ workflow: 'promote.yml', decision: direct.decision, why: direct.why, candidate: direct.candidate, gates: direct.gates });
    expect(view.promotion.decision).toBe('hold');
    expect(view.promotion.gates.map((g: Any) => [g.id, g.pass])).toEqual([['soak', false], ['revert', true], ['bug', true], ['red', true], ['e2e', true]]);
    expect(view.promotion.gates[0].evidence).toBe(`pinned 10h of 72, since #110 merged at ${PIN}`);

    // A refusal is the check's answer too, which a person reads.
    const refused = promoting({ routes: { ...PROMOTION_ROUTES, [`repos/acme/shop/contents/package.json?ref=${SHA}`]: file('{"version":"0.40.9"}') } });
    const rv: Any = await releaseView({ reader: refused.reader, repo: refused.repo, now: PROMOTION_NOW });
    expect(rv.promotion).toMatchObject({ workflow: 'promote.yml', decision: 'refused', candidate: null, gates: [] });
    expect(rv.promotion.why).toMatch(/says it is version 0\.40\.9 in package\.json, not 0\.41\.0/);

    // Where no workflow runs the check, there is no promotion, whatever the repository is called:
    // Kanon's name runs nothing, and a fixture adopter's repository running it runs the check.
    const named = releaseWorld({ repo: 'yedeya-labs/kanon' });
    expect(((await releaseView({ reader: named.reader, repo: named.repo, now: PROMOTION_NOW })) as Any).promotion).toBeNull();
    const commented = releaseWorld({ workflows: { 'promote.yml': '# run: node scripts/promote.mjs check\njobs: {}\n' } });
    expect(((await releaseView({ reader: commented.reader, repo: commented.repo, now: PROMOTION_NOW })) as Any).promotion).toBeNull();
  });

  it('[STAT-1] the release view asks only REST GETs and GraphQL queries, the promotion\'s check\'s reads among them', async () => {
    const w = promoting({ releases: RELEASES, latest: RELEASES[1], pulls: PULLS });
    const view: Any = await releaseView({ reader: w.reader, repo: w.repo, now: PROMOTION_NOW });
    expect(view.promotion.gates).toHaveLength(5);
    expect(w.seen).toContain('GET repos/acme/shop/git/matching-refs/tags/candidate-v');
    for (const s of w.seen) expect(s, s).toMatch(/^(GET|PAGES|GraphQL) /);
  });

  it('[STAT-3] a read the release view or the promotion\'s check can\'t complete is an error naming it, never a partial answer', async () => {
    const pulls = chain();
    pulls.reader.pages = () => { throw new ReadError('GET repos/acme/shop/pulls?state=open&per_page=100', 'API rate limit exceeded', { status: 403, resetAt: '2026-10-24T10:00:00.000Z' }); };
    const err: Any = await releaseView({ reader: pulls.reader, repo: pulls.repo, now: new Date(RELEASE_NOW) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteRead);
    expect(err.message).toMatch(/^the release view couldn't be read whole, so there is no answer: GET repos\/acme\/shop\/pulls\?state=open&per_page=100 failed: API rate limit exceeded \(the rate limit resets at 2026-10-24T10:00:00.000Z\)$/);

    // A deploy run whose jobs came back without a job list is no answer for its environments.
    const jobs = chain({ jobs: { ...JOBS, 503: undefined } });
    await expect(releaseView({ reader: jobs.reader, repo: jobs.repo, now: new Date(RELEASE_NOW) })).rejects.toThrow(/actions\/runs\/503\/jobs\?per_page=100 failed: the answer has no job list/);

    // A read inside the promotion's check, by name.
    const bugs = promoting();
    const get = bugs.reader.get;
    bugs.reader.get = (p: string) => {
      if (p === page('repos/acme/shop/issues?state=open&labels=bug')) throw new ReadError(`GET ${p}`, 'Server Error', { status: 502 });
      return get(p);
    };
    await expect(releaseView({ reader: bugs.reader, repo: bugs.repo, now: PROMOTION_NOW })).rejects.toThrow(/GET repos\/acme\/shop\/issues\?state=open&labels=bug&per_page=100&page=1 failed: Server Error/);
  });
});
