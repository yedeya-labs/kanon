/**
 * The release view's worlds (`scripts/status/release.mjs`): a Kanon deploy chain with its releases,
 * runs and jobs, and a repository running Kanon's promotion workflow, with the reads its check
 * makes. Shared by the view's tests and the `kanon status` command's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './adopter.js';
import { CHAIN_DEPLOY, adopterFiles, adoptionWith, releaseWorld } from './status-world.js';

const { pinTitle } = await import('../../../scripts/promote.mjs');

export const run = (id: number) => `https://github.com/acme/shop/actions/runs/${id}`;
export const RC_SHA = 'f'.repeat(40);
export const RELEASES = [
  { tag_name: 'v2.2.0-rc.1', name: 'v2.2.0-rc.1', prerelease: true, draft: false, published_at: '2026-10-22T09:30:00Z', html_url: 'https://github.com/acme/shop/releases/tag/v2.2.0-rc.1' },
  { tag_name: 'v2.1.0', name: 'v2.1.0', prerelease: false, draft: false, published_at: '2026-10-20T00:00:00Z', html_url: 'https://github.com/acme/shop/releases/tag/v2.1.0' },
  { tag_name: 'v2.0.0', name: 'v2.0.0', prerelease: false, draft: false, published_at: '2026-10-10T00:00:00Z', html_url: 'https://github.com/acme/shop/releases/tag/v2.0.0' },
];
export const PULLS = [
  { number: 40, title: 'chore(main): release 2.2.0', labels: [{ name: 'autorelease: pending' }], user: { login: 'example-releaser[bot]', type: 'Bot' }, html_url: 'https://github.com/acme/shop/pull/40', created_at: '2026-10-23T08:00:00Z' },
  { number: 41, title: 'chore(main): release 9.9.9', labels: [], user: { login: 'someone', type: 'User' }, html_url: 'https://github.com/acme/shop/pull/41', created_at: '2026-10-23T09:00:00Z' },
];
export const job = (name: string, conclusion: string | null, status = 'completed') => ({ name, status, conclusion });
/** The deploy lane's runs, newest first: the pre-release's titled by its commit, as a `workflow_run` start titles it. */
export const RUNS = [
  { databaseId: 503, displayTitle: RC_SHA, status: 'completed', conclusion: 'success', url: run(503) },
  { databaseId: 502, displayTitle: 'v2.1.0', status: 'completed', conclusion: 'failure', url: run(502) },
  { databaseId: 501, displayTitle: 'v2.0.0', status: 'completed', conclusion: 'success', url: run(501) },
];
export const JOBS = {
  // Production held: its job skipped, so it didn't deploy this release.
  503: [job('release / gate', 'success'), job('staging / deploy', 'success'), job('production / deploy', 'skipped')],
  502: [job('release / gate', 'success'), job('staging / deploy', 'success'), job('production / deploy', 'failure')],
  501: [job('release / gate', 'success'), job('staging / deploy', 'success'), job('production / deploy', 'success')],
};
export const chain = (over: Partial<Parameters<typeof releaseWorld>[0]> = {}) => releaseWorld({
  files: adopterFiles(undefined, { 'docs/qa/adoption.md': adoptionWith(CHAIN_DEPLOY) }),
  pulls: PULLS, releases: RELEASES, latest: RELEASES[1], runs: RUNS, jobs: JOBS, tagShas: { 'v2.2.0-rc.1': RC_SHA },
  ...over,
});

// The promotion's reads, for a candidate soaking ten hours of seventy-two: held by the soak alone.
export const SHA = 'c'.repeat(40);
const PREV = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
export const CANDIDATE = 'candidate-v0.41.0';
const CUT = '2026-10-19T09:00:00Z';
export const PIN = '2026-10-19T12:00:00Z';
export const PROMOTION_NOW = new Date(Date.parse(PIN) + 10 * 3_600_000);
const ref = (name: string, sha: string) => ({ ref: `refs/tags/${name}`, object: { sha, type: 'commit' } });
export const page = (path: string) => `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=1`;
export const file = (text: string) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), sha: 'blob' });
const runsOf = (status: string) => `repos/acme/shop/actions/workflows/review.yml/runs?created=${encodeURIComponent(`>=${PIN}`)}&status=${status}&per_page=${status === 'completed' ? 1 : '100&page=1'}`;
export const PROMOTION_ROUTES = {
  'repos/acme/shop/git/matching-refs/tags/candidate-v': [ref('candidate-v0.40.0', PREV), ref(CANDIDATE, SHA)],
  'repos/acme/shop/git/matching-refs/tags/v': [ref('v0', PREV), ref('v0.39.0', OLD), ref('v0.40.0', PREV)],
  [`repos/acme/shop/contents/package.json?ref=${SHA}`]: file(JSON.stringify({ name: 'shop', version: '0.41.0' })),
  [`repos/acme/shop/releases/tags/${CANDIDATE}`]: { tag_name: CANDIDATE, prerelease: true, body: 'notes', created_at: CUT },
  [page(`repos/acme/shop/compare/v0.40.0...${SHA}`)]: { commits: [{ sha: '1'.repeat(40), commit: { message: 'feat: a (#101)', committer: { date: '2026-10-14T10:00:00Z' } } }] },
  [`search/issues?q=${encodeURIComponent(`repo:acme/shop is:pr is:merged in:title "${pinTitle('0.41.0')}"`)}&per_page=100`]: { items: [{ number: 110, title: pinTitle('0.41.0'), pull_request: { merged_at: PIN } }] },
  [page(`repos/acme/shop/compare/${SHA}...main`)]: { commits: [] },
  [page('repos/acme/shop/issues?state=open&labels=bug')]: [],
  // Where an admin explains a red run (#1441): the open held issues, none, and the pin pull request's comments.
  [page(`repos/acme/shop/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}`)]: [],
  [page('repos/acme/shop/issues/110/comments')]: [],
  [runsOf('completed')]: { total_count: 2, workflow_runs: [] },
  ...Object.fromEntries(['failure', 'timed_out', 'startup_failure'].map((s) => [runsOf(s), { total_count: 0, workflow_runs: [] }])),
};
const PROMOTE_YML = readFileSync(join(ROOT, '.github/workflows/promote.yml'), 'utf8');
export const WORKFLOWS = {
  'promote.yml': PROMOTE_YML,
  'review.yml': `jobs:\n  review:\n    uses: acme/shop/.github/workflows/agent-review.yml@${CANDIDATE}\n`,
};
export const promoting = (over: Partial<Parameters<typeof releaseWorld>[0]> = {}) => releaseWorld({ workflows: WORKFLOWS, routes: PROMOTION_ROUTES, ...over });
