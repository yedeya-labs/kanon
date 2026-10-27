import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { UNREACHABLE_TITLE as DOCTOR_UNREACHABLE_TITLE } from '../../cli/doctor.mjs';
import {
  ApiError, apply, check, E2E_CHECK, EXPLAIN_MARKER, GATES, gate, gateSummary, HARNESS, HARNESS_WORKFLOW, HELD_LABEL, HELD_MILESTONE, heldTitle,
  laneCallers, notify, pinTitle, redIssueTitle, Refusal, REPORTER_APP_ID, RUN_LISTING_CAP, SOAK_MS, SPACING_MS, startJobName, summary,
  HELD_AUTHOR, UNREACHABLE_TITLE, VERDICT_JOB, VERDICT_TITLES,
} from '../../scripts/promote.mjs';
import { VERDICT_TITLE as RED_TEST_VERDICT_TITLE, verdictCommand } from '../../scripts/red-test.mjs';

/**
 * Plan 0009 §2, §3 and §7, step S5: the promotion, on fixtures of GitHub's answers. A candidate is
 * held by each of the four gates in turn, promoted when all five pass (its tag on the candidate's
 * commit, its Release latest, `v0` moved), held by the six-day spacing unless `urgent`, and
 * refused when `urgent` has no reason or the commit's package.json names another version. Plan
 * 0012 §8, step E11: the fifth gate, end to end, on fixtures of the Reporter's check runs and the
 * harness's runs.
 */

const REPO = 'yedeya-labs/kanon';
const SHA = 'c'.repeat(40);
const PREV = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const ITEM_101 = '1'.repeat(40);
const ITEM_102 = '2'.repeat(40);
const LATER = 'd'.repeat(40);
const HELD = '4'.repeat(40);
const ITEM_95 = '5'.repeat(40);
const REVIEWED = '6'.repeat(40);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CUT = '2026-10-19T09:00:00Z';
const PIN = '2026-10-19T12:00:00Z';
const at = (ms: number) => Date.parse(PIN) + ms;
const iso = (ms: number) => new Date(ms).toISOString();

const VERSION = '0.41.0';
const CANDIDATE = `candidate-v${VERSION}`;
const STABLE = `v${VERSION}`;
const CUT_NOTES = '## [0.41.0](https://github.com/yedeya-labs/kanon/compare/candidate-v0.40.0...candidate-v0.41.0) (2026-10-19)\n\n### Features\n\n* a ([#101](https://github.com/yedeya-labs/kanon/issues/101))\n';

/** A candidate cut, held and never promoted: release-please wrote its changelog from the previous candidate tag. */
const HELD_NOTES = '## [0.40.1](https://github.com/yedeya-labs/kanon/compare/candidate-v0.40.0...candidate-v0.40.1) (2026-10-12)\n\n### ⚠ BREAKING CHANGES\n\n* e: callers pass `x` ([#95](https://github.com/yedeya-labs/kanon/issues/95))\n';
/** The candidate promoted as v0.40.0, whose changes v0.40.0's Release carries already. */
const PROMOTED_NOTES = '## [0.40.0](https://github.com/yedeya-labs/kanon/compare/candidate-v0.39.0...candidate-v0.40.0) (2026-10-05)\n\n### Features\n\n* z ([#80](https://github.com/yedeya-labs/kanon/issues/80))\n';

const ref = (name: string, sha: string) => ({ ref: `refs/tags/${name}`, object: { sha, type: 'commit' } });
const commit = (sha: string, message: string, date: string) => ({ sha, commit: { message, committer: { date } } });
const page = (path: string, n = 1) => `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${n}`;
const runsBase = (file: string, since = PIN) => `repos/${REPO}/actions/workflows/${file}/runs?created=${encodeURIComponent(`>=${since}`)}`;
/** One page of a caller's runs whose latest attempt has `status`. */
const runsPath = (file: string, status: string, since = PIN, n = 1) => `${runsBase(file, since)}&status=${status}&per_page=100&page=${n}`;
/** The count of a caller's completed runs. */
const countPath = (file: string, since = PIN) => `${runsBase(file, since)}&status=completed&per_page=1`;
const RED_STATUSES = ['failure', 'timed_out', 'startup_failure'];
/** Every listing the gates read, for the two callers, empty of red runs. */
const listings = (since = PIN) => Object.fromEntries(['review.yml', 'merge.yml'].flatMap((file) => [
  [countPath(file, since), { total_count: 2, workflow_runs: [] }],
  ...RED_STATUSES.map((s) => [runsPath(file, s, since), { total_count: 0, workflow_runs: [] }]),
]));
/** A review run as GitHub lists it: the lane it called, by `referenced_workflows`. */
const reviewRun = (laneRef: string) => ({
  id: 1, status: 'completed', conclusion: 'success', event: 'pull_request_target', head_sha: REVIEWED,
  referenced_workflows: [{ path: `${REPO}/.github/workflows/agent-review.yml@${laneRef}`, sha: SHA, ref: `refs/tags/${laneRef}` }],
});
const pinSearch = `search/issues?q=${encodeURIComponent(`repo:${REPO} is:pr is:merged in:title "${pinTitle(VERSION)}"`)}&per_page=100`;

/** The end-to-end gate's reads (plan 0012 §8.2): the Reporter's check runs, and the harness run one links. */
const HARNESS_RUN = 900;
const checkRunsPath = (sha = SHA) => page(`repos/${REPO}/commits/${sha}/check-runs?check_name=${E2E_CHECK}&app_id=${REPORTER_APP_ID}&filter=all`);
const checkRun = (over: Record<string, unknown> = {}) => ({
  id: 7001, name: E2E_CHECK, head_sha: SHA, status: 'completed', conclusion: 'success', external_id: `${HARNESS_RUN}-1`,
  app: { id: REPORTER_APP_ID, slug: 'kanon-e2e-reporter' }, html_url: `https://github.com/${REPO}/runs/7001`, ...over,
});
const harnessRun = (over: Record<string, unknown> = {}) => ({
  id: HARNESS_RUN, path: HARNESS_WORKFLOW, head_branch: 'main', head_repository: { full_name: HARNESS }, conclusion: 'success', run_attempt: 1,
  html_url: `https://github.com/${HARNESS}/actions/runs/${HARNESS_RUN}`, ...over,
});
/** The harness run's jobs at one attempt: its `start` job's name records the candidate's tag and commit. */
const harnessJobs = (verdict: string, others = 'success', start = startJobName(CANDIDATE, SHA)) => ({ jobs: [
  { name: 'plan', conclusion: 'success' }, { name: start, conclusion: 'success' }, { name: 'provision (deploy-rehearsal)', conclusion: others }, { name: VERDICT_JOB, conclusion: verdict }, { name: "report (the check run's conclusion)", conclusion: 'success' },
] });
const redSearch = (tag = CANDIDATE) => `search/issues?q=${encodeURIComponent(`repo:${HARNESS} is:issue in:title "${redIssueTitle(tag)}"`)}&per_page=100`;
/** A harness that ran `e2e.yml` on its main for the candidate, and whose verdict job succeeded. */
const e2eGreen = (): Record<string, unknown> => ({
  [checkRunsPath()]: { total_count: 1, check_runs: [checkRun()] },
  [`repos/${HARNESS}`]: { full_name: HARNESS, default_branch: 'main' },
  [`repos/${HARNESS}/actions/runs/${HARNESS_RUN}`]: harnessRun(),
  [page(`repos/${HARNESS}/actions/runs/${HARNESS_RUN}/attempts/1/jobs`)]: harnessJobs('success'),
  [redSearch()]: { items: [] },
});

const WORKFLOWS = [
  { file: 'review.yml', text: `jobs:\n  review:\n    uses: ${REPO}/.github/workflows/agent-review.yml@${CANDIDATE}\n` },
  { file: 'merge.yml', text: `jobs:\n  merge:\n    # uses: ${REPO}/.github/workflows/agent-merge.yml@v0.39.0\n    uses: ${REPO}/.github/workflows/agent-merge.yml@${CANDIDATE}\n` },
  { file: 'ci.yml', text: 'jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7\n' },
];

type Route = unknown;
type Write = { method: string; path: string; body: unknown };
/** GitHub's API as the fixtures answer it, at time `now`; any other read is a 404. Writes are recorded. */
const github = (now: number, over: Record<string, Route> = {}) => {
  const routes: Record<string, Route> = {
    [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [ref('candidate-v0.40.0', PREV), ref(CANDIDATE, SHA)],
    [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0', PREV), ref('v0.39.0', OLD), ref('v0.40.0', PREV)],
    [`repos/${REPO}/contents/package.json?ref=${SHA}`]: JSON.stringify({ name: 'kanon', version: VERSION }),
    // The candidate's commit carries the end-to-end gate: it was cut after E11.
    [`repos/${REPO}/contents/scripts/promote.mjs?ref=${SHA}`]: readFileSync(new URL('../../scripts/promote.mjs', import.meta.url), 'utf8'),
    [`repos/${REPO}/releases/tags/${CANDIDATE}`]: { tag_name: CANDIDATE, prerelease: true, body: CUT_NOTES, created_at: CUT },
    [page(`repos/${REPO}/compare/v0.40.0...${SHA}`)]: {
      commits: [
        commit(ITEM_101, 'feat: a (#101)\n\nBody.', '2026-10-14T10:00:00Z'),
        commit(ITEM_102, 'fix: b (#102)', '2026-10-15T10:00:00Z'),
        commit(SHA, 'chore(main): release candidate 0.41.0 (#103)', CUT),
      ],
    },
    [pinSearch]: { items: [{ number: 110, title: pinTitle(VERSION), pull_request: { merged_at: PIN } }] },
    // Where an admin explains red runs (#1441): the pin pull request, and a held issue when one is open.
    [page(`repos/${REPO}/issues/110/comments`)]: [],
    [page(`repos/${REPO}/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}`)]: [],
    [page(`repos/${REPO}/compare/${SHA}...main`)]: { commits: [commit(LATER, 'docs: c (#111)', '2026-10-20T10:00:00Z')] },
    [page(`repos/${REPO}/pulls/111/commits`)]: [commit('e'.repeat(40), 'docs: c', '2026-10-20T09:00:00Z')],
    [page(`repos/${REPO}/issues?state=open&labels=bug`)]: [
      { number: 130, labels: [{ name: 'bug' }, { name: 'sev:medium' }], body: '### Introduced by\n\n#101\n' },
    ],
    ...listings(),
    [runsPath('review.yml', 'success')]: { total_count: 1, workflow_runs: [reviewRun(CANDIDATE)] },
    [`repos/${REPO}/actions/runs/1/jobs?per_page=100`]: { jobs: [{ id: 11, name: 'review / filter', conclusion: 'success' }, { id: 12, name: 'review / review / review / review', conclusion: 'success' }] },
    [`repos/${REPO}/releases/latest`]: { tag_name: 'v0.40.0', published_at: iso(now - 8 * DAY) },
    [`repos/${REPO}/git/ref/tags/v0`]: { ref: 'refs/tags/v0', object: { sha: PREV } },
    ...e2eGreen(),
    ...over,
  };
  const writes: Write[] = [];
  const reads: string[] = [];
  const api = (path: string, { method = 'GET', body }: { method?: string; body?: unknown; raw?: boolean } = {}) => {
    if (method === 'GET') reads.push(path);
    if (method !== 'GET') {
      writes.push({ method, path, body });
      return {};
    }
    if (!(path in routes) || routes[path] === undefined) throw new ApiError(`${path}: HTTP 404`, 404);
    return routes[path];
  };
  return { api, writes, reads };
};

const ENV = { GITHUB_REPOSITORY: REPO, DEFAULT_BRANCH: 'main' };
const run = (soak: number, { env = {}, over = {}, workflows = WORKFLOWS }: { env?: Record<string, string>; over?: Record<string, Route>; workflows?: typeof WORKFLOWS } = {}) => {
  const now = at(soak);
  const gh = github(now, over);
  const outcome = check({ ...ENV, ...env }, { api: gh.api, now, workflows });
  return { outcome, gh, now };
};
const verdicts = (o: ReturnType<typeof check>) => Object.fromEntries(o.gates.map((g) => [g.id, g.skipped ? 'skipped' : g.pass ? 'pass' : 'hold']));
const ALL_PASS = { soak: 'pass', revert: 'pass', bug: 'pass', red: 'pass', e2e: 'pass' };

describe('the gates (plan 0009 §2)', () => {
  it('a candidate passing all five is promoted: its tag on the candidate\'s commit, its Release latest, v0 moved', () => {
    const { outcome, gh } = run(4 * DAY);
    expect(verdicts(outcome)).toEqual(ALL_PASS);
    expect(outcome.decision).toBe('promote');
    expect(outcome.plan).toMatchObject({ tag: STABLE, candidate: CANDIDATE, sha: SHA, major: 'v0', resume: false });
    expect(gh.writes).toEqual([]);
    const done = apply(outcome.plan!, { api: gh.api, repo: REPO });
    expect(gh.writes).toEqual([
      { method: 'POST', path: `repos/${REPO}/git/refs`, body: { ref: `refs/tags/${STABLE}`, sha: SHA } },
      { method: 'POST', path: `repos/${REPO}/releases`, body: { tag_name: STABLE, name: STABLE, body: outcome.plan!.notes, draft: false, prerelease: false, make_latest: 'true' } },
      { method: 'PATCH', path: `repos/${REPO}/git/refs/tags/v0`, body: { sha: SHA, force: true } },
    ]);
    expect(done).toHaveLength(3);
    // The Release carries the candidate's notes, and a line saying when and on what evidence.
    expect(outcome.plan!.notes.startsWith(CUT_NOTES.trimEnd())).toBe(true);
    expect(outcome.plan!.notes).toContain(`Promoted from \`${CANDIDATE}\` on 2026-10-23`);
    for (const g of outcome.gates) expect(outcome.plan!.notes).toContain(`**${g.title}:** ${g.evidence}`);
  });

  it('creates the major tag when none exists yet', () => {
    const { outcome } = run(4 * DAY);
    const gh = github(at(4 * DAY), { [`repos/${REPO}/git/ref/tags/v0`]: undefined });
    apply(outcome.plan!, { api: gh.api, repo: REPO });
    expect(gh.writes[2]).toEqual({ method: 'POST', path: `repos/${REPO}/git/refs`, body: { ref: 'refs/tags/v0', sha: SHA } });
  });

  it('a candidate pinned 71 hours is held by the soak (MUTATION: the soak gate removed turns this red)', () => {
    const { outcome, gh } = run(71 * HOUR);
    expect(verdicts(outcome)).toEqual({ ...ALL_PASS, soak: 'hold' });
    expect(outcome.decision).toBe('hold');
    expect(outcome.gates.find((g) => g.id === 'soak')!.evidence).toBe(`pinned 71h of 72, since #110 merged at ${PIN}`);
    expect(outcome.plan).toBeUndefined();
    expect(gh.writes).toEqual([]);
  });

  it('a candidate pinned exactly 72 hours passes the soak (MUTATION: `<` for `<=` in the soak turns this red)', () => {
    const { outcome } = run(SOAK_MS);
    expect(verdicts(outcome).soak).toBe('pass');
    expect(outcome.decision).toBe('promote');
    expect(verdicts(run(SOAK_MS - 1).outcome).soak).toBe('hold');
  });

  it('the soak holds a candidate with no merged pin pull request, or whose callers pin another release', () => {
    // With no pin, the runs are read from the cut.
    const unpinned = {
      [pinSearch]: { items: [{ number: 110, title: pinTitle(VERSION), pull_request: { merged_at: null } }] },
      ...listings(CUT),
    };
    expect(run(4 * DAY, { over: unpinned }).outcome.gates[0]!.evidence)
      .toMatch(/^no merged pull request titled `ci\(deps\): run Kanon on candidate v0\.41\.0`/);
    const now = at(4 * DAY);
    const moved = check(ENV, { api: github(now).api, now, workflows: [{ file: 'review.yml', text: `    uses: ${REPO}/.github/workflows/agent-review.yml@v0.40.0\n` }] });
    expect(verdicts(moved).soak).toBe('hold');
    expect(moved.gates[0]!.evidence).toBe(`review.yml pins v0.40.0, not ${CANDIDATE}`);
  });

  it('reads an empty pin search again before the soak holds for no pin (kanon#1322)', () => {
    const now = at(4 * DAY);
    const gh = github(now);
    let pinReads = 0;
    const api: typeof gh.api = (path, opts) => {
      if (path === pinSearch && pinReads++ === 0) return { total_count: 0, incomplete_results: false, items: [] };
      return gh.api(path, opts);
    };
    const outcome = check(ENV, { api, now, workflows: WORKFLOWS });
    expect(verdicts(outcome).soak).toBe('pass');
    expect(pinReads).toBe(3);
  });

  it('a candidate with a merged revert of its pull request is held (MUTATION: the revert gate removed turns this red)', () => {
    const revert = { [page(`repos/${REPO}/compare/${SHA}...main`)]: { commits: [commit(LATER, `Revert "feat: a (#101)" (#112)\n\nReverts ${REPO}#101`, '2026-10-20T10:00:00Z')] }, [page(`repos/${REPO}/pulls/112/commits`)]: [] };
    const { outcome } = run(4 * DAY, { over: revert });
    expect(verdicts(outcome)).toEqual({ ...ALL_PASS, revert: 'hold' });
    expect(outcome.decision).toBe('hold');
    expect(outcome.gates.find((g) => g.id === 'revert')!.evidence).toBe('#112 reverts #101');
  });

  it("the revert gate reads the reverting pull request's own commits too: `This reverts commit <sha>.`", () => {
    const revert = {
      [page(`repos/${REPO}/compare/${SHA}...main`)]: { commits: [commit(LATER, 'fix: undo b (#113)', '2026-10-20T10:00:00Z')] },
      [page(`repos/${REPO}/pulls/113/commits`)]: [commit('f'.repeat(40), `Revert "fix: b"\n\nThis reverts commit ${ITEM_102}.`, '2026-10-20T09:00:00Z')],
    };
    expect(run(4 * DAY, { over: revert }).outcome.gates.find((g) => g.id === 'revert')!.evidence).toBe('#113 reverts #102');
  });

  it("a candidate with an open sev:high bug naming its pull request in `Introduced by` is held (MUTATION: the bug gate removed turns this red)", () => {
    const bug = { [page(`repos/${REPO}/issues?state=open&labels=bug`)]: [
      { number: 130, labels: [{ name: 'bug' }, { name: 'sev:medium' }], body: '### Introduced by\n\n#101\n' },
      { number: 131, labels: [{ name: 'bug' }, { name: 'sev:high' }], body: '### What happened\n\nIt broke.\n\n### Introduced by\n\n#102\n\n### Severity\n\nhigh\n' },
    ] };
    const { outcome } = run(4 * DAY, { over: bug });
    expect(verdicts(outcome)).toEqual({ ...ALL_PASS, bug: 'hold' });
    expect(outcome.gates.find((g) => g.id === 'bug')!.evidence).toContain('#131 names #102');
  });

  it("a held candidate's pull requests are the next one's: an open sev:high bug naming one holds it (MUTATION: reading from the previous candidate instead of the newest stable tag turns this red)", () => {
    const over = {
      [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [ref('candidate-v0.40.0', PREV), ref('candidate-v0.40.1', HELD), ref(CANDIDATE, SHA)],
      // candidate-v0.40.1 was cut, held, and never promoted: v0.40.0 is still the newest stable tag.
      [page(`repos/${REPO}/compare/v0.40.0...${SHA}`)]: { commits: [commit(ITEM_95, 'fix: e (#95)', '2026-10-08T10:00:00Z'), commit(HELD, 'chore(main): release candidate 0.40.1 (#96)', '2026-10-12T09:00:00Z'), commit(ITEM_101, 'feat: a (#101)', '2026-10-14T10:00:00Z')] },
      [page(`repos/${REPO}/compare/candidate-v0.40.1...${SHA}`)]: { commits: [commit(ITEM_101, 'feat: a (#101)', '2026-10-14T10:00:00Z')] },
      [`repos/${REPO}/releases/tags/candidate-v0.40.1`]: { tag_name: 'candidate-v0.40.1', prerelease: true, body: HELD_NOTES },
      [page(`repos/${REPO}/issues?state=open&labels=bug`)]: [{ number: 132, labels: [{ name: 'bug' }, { name: 'sev:high' }], body: '### Introduced by\n\n#95\n' }],
    };
    const { outcome } = run(4 * DAY, { over });
    expect(verdicts(outcome)).toEqual({ ...ALL_PASS, bug: 'hold' });
    expect(outcome.gates.find((g) => g.id === 'bug')!.evidence).toContain('#132 names #95');
  });

  it('a serious bug naming a pull request the candidate does not contain holds nothing', () => {
    const bug = { [page(`repos/${REPO}/issues?state=open&labels=bug`)]: [{ number: 131, labels: [{ name: 'bug' }, { name: 'sev:critical' }], body: '### Introduced by\n\n#90\n' }] };
    expect(verdicts(run(4 * DAY, { over: bug }).outcome).bug).toBe('pass');
  });

  it('a candidate with an unexplained red run is held (MUTATION: the red gate removed turns this red)', () => {
    const red = {
      [runsPath('merge.yml', 'failure')]: { total_count: 1, workflow_runs: [{ id: 2, status: 'completed', conclusion: 'failure' }] },
      [`repos/${REPO}/actions/runs/2/jobs?per_page=100`]: { jobs: [{ id: 21, conclusion: 'failure' }] },
      [`repos/${REPO}/check-runs/21/annotations?per_page=100`]: [{ title: 'Process completed with exit code 1' }],
    };
    const { outcome } = run(4 * DAY, { over: red });
    expect(verdicts(outcome)).toEqual({ ...ALL_PASS, red: 'hold' });
    expect(outcome.gates.find((g) => g.id === 'red')!.evidence).toContain('merge.yml run 2 (failure)');
  });

  it("a red run whose failed job carries agent-classify's `unavailable` notice is explained: the model was never reached", () => {
    expect(UNREACHABLE_TITLE).toBe(DOCTOR_UNREACHABLE_TITLE);
    const red = {
      [runsPath('merge.yml', 'failure')]: { total_count: 1, workflow_runs: [{ id: 2, status: 'completed', conclusion: 'failure' }] },
      [`repos/${REPO}/actions/runs/2/jobs?per_page=100`]: { jobs: [{ id: 20, conclusion: 'success' }, { id: 21, conclusion: 'failure' }] },
      [`repos/${REPO}/check-runs/21/annotations?per_page=100`]: [{ title: UNREACHABLE_TITLE }],
    };
    const { outcome } = run(4 * DAY, { over: red });
    expect(verdicts(outcome).red).toBe('pass');
    expect(outcome.decision).toBe('promote');
  });

  it('reads only the red listings, and counts the completed runs: an all-green caller far over the listing cap passes', () => {
    const busy = { [countPath('review.yml')]: { total_count: 4 * RUN_LISTING_CAP, workflow_runs: [] } };
    const { outcome, gh } = run(4 * DAY, { over: busy });
    expect(verdicts(outcome).red).toBe('pass');
    expect(outcome.gates.find((g) => g.id === 'red')!.evidence).toBe(`${4 * RUN_LISTING_CAP + 2} completed runs of 2 callers since ${PIN}, 0 red with the model unreachable, 0 red as a verdict on a pull request`);
    // A run re-run green is not in a red listing (GitHub's filter matches the latest attempt), and
    // no green listing is read.
    expect(gh.reads.filter((r) => r.includes('/actions/workflows/') && !r.includes('status=completed') && !RED_STATUSES.some((st) => r.includes(`status=${st}&`)))).toEqual([]);
  });

  it('a truncated red listing holds the candidate and says so: more runs than were read, or the listing\'s cap (MUTATION: ignoring truncation turns this red)', () => {
    const explained = (id: number) => ({
      [`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`]: { jobs: [{ id: id * 10, conclusion: 'failure' }] },
      [`repos/${REPO}/check-runs/${id * 10}/annotations?per_page=100`]: [{ title: UNREACHABLE_TITLE }],
    });
    const more = { [runsPath('merge.yml', 'failure')]: { total_count: 3, workflow_runs: [{ id: 2, status: 'completed', conclusion: 'failure' }] }, ...explained(2) };
    const short = run(4 * DAY, { over: more }).outcome;
    expect(verdicts(short).red).toBe('hold');
    expect(short.gates.find((g) => g.id === 'red')!.evidence).toBe('a red run listing is truncated, so a red run may be unread: merge.yml failure (read 1 of 3)');
    const capped: Record<string, unknown> = {};
    for (let n = 1; n * 100 <= RUN_LISTING_CAP; n += 1) {
      const ids = Array.from({ length: 100 }, (_, i) => n * 1000 + i);
      capped[runsPath('merge.yml', 'timed_out', PIN, n)] = { total_count: RUN_LISTING_CAP, workflow_runs: ids.map((id) => ({ id, status: 'completed', conclusion: 'timed_out' })) };
      for (const id of ids) Object.assign(capped, explained(id));
    }
    const atCap = run(4 * DAY, { over: capped }).outcome;
    expect(verdicts(atCap).red).toBe('hold');
    expect(atCap.gates.find((g) => g.id === 'red')!.evidence).toBe(`a red run listing is truncated, so a red run may be unread: merge.yml timed_out (read ${RUN_LISTING_CAP} of ${RUN_LISTING_CAP})`);
  });
});

// #1441: a red the candidate didn't cause no longer holds it forever. A verdict on a pull request
// isn't a lane dying, and a repository admin can explain the rest, on the record.
describe('what explains a red run (#1441)', () => {
  const VERDICT = VERDICT_TITLES['red-test.yml']!;
  const RED_TEST_WORKFLOWS = [...WORKFLOWS, { file: 'red-test-check.yml', text: `jobs:\n  red-test:\n    uses: ${REPO}/.github/workflows/red-test.yml@${CANDIDATE}\n` }];
  const redTestListings = {
    [countPath('red-test-check.yml')]: { total_count: 1, workflow_runs: [] },
    ...Object.fromEntries(RED_STATUSES.map((s) => [runsPath('red-test-check.yml', s), { total_count: 0, workflow_runs: [] }])),
  };
  /** A caller's red run whose one failed job carries `titles` among its annotations, beside the exit code's. */
  const failedRun = (file: string, id: number, titles: string[] = []) => ({
    [runsPath(file, 'failure')]: { total_count: 1, workflow_runs: [{ id, status: 'completed', conclusion: 'failure' }] },
    [`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`]: { jobs: [{ id: id * 10, conclusion: 'failure' }] },
    [`repos/${REPO}/check-runs/${id * 10}/annotations?per_page=100`]: [{ title: 'Process completed with exit code 1' }, ...titles.map((title) => ({ title }))],
  });
  const STAMP = '2026-10-21T08:00:00Z';
  const comment = (login: string, body: string, edited = false) => ({ user: { login, type: 'User' }, created_at: STAMP, updated_at: edited ? '2026-10-21T09:00:00Z' : STAMP, body });
  const roles = { [`repos/${REPO}/collaborators/owner/permission`]: { permission: 'admin' }, [`repos/${REPO}/collaborators/helper/permission`]: { permission: 'write' } };
  const redGate = (o: ReturnType<typeof check>) => o.gates.find((g) => g.id === 'red')!;

  it('reads the red-test check\'s own verdict title, which it prints only on a verdict, and with no comma for the runner to split', () => {
    expect(VERDICT).toBe(RED_TEST_VERDICT_TITLE);
    expect(VERDICT).not.toContain(',');
    expect(verdictCommand({ blocked: true })).toMatch(new RegExp(`^::error title=${VERDICT}::`));
    expect(verdictCommand({})).toBe('');
  });

  // B3 on #1471: a candidate that breaks how red-test runs or reads its runner makes every PR
  // `inconclusive`, so only results the PR's diff decides may carry the annotation.
  it("prints the annotation only for a failure the pull request's diff decided, never for the lane's own (MUTATION: annotating on every exit 1 turns this red)", () => {
    for (const r of [{ blocked: true }, { unverifiable: true }, { weakOnUnrevertedHarness: true }]) expect(verdictCommand(r), JSON.stringify(r)).not.toBe('');
    for (const r of [{ inconclusive: true }, { refused: true }, { areasChanged: true }, { blocked: true, inconclusive: true }, { blocked: true, refused: true }]) expect(verdictCommand(r), JSON.stringify(r)).toBe('');
  });

  it('a red-test run carrying its verdict annotation is a verdict on a pull request, not a lane dying (MUTATION: counting verdicts as red turns this red)', () => {
    const { outcome } = run(4 * DAY, { workflows: RED_TEST_WORKFLOWS, over: { ...redTestListings, ...failedRun('red-test-check.yml', 3, [VERDICT]) } });
    expect(verdicts(outcome).red).toBe('pass');
    expect(redGate(outcome).evidence).toContain('1 red as a verdict on a pull request');
  });

  it('a red-test run that failed without its verdict annotation holds: a script that throws fails the same step (#1441\'s first criterion; MUTATION: reading the step instead of the annotation turns this red)', () => {
    const { outcome } = run(4 * DAY, { workflows: RED_TEST_WORKFLOWS, over: { ...redTestListings, ...failedRun('red-test-check.yml', 3) } });
    expect(verdicts(outcome).red).toBe('hold');
    expect(redGate(outcome).evidence).toContain('red-test-check.yml run 3 (failure)');
  });

  it('the verdict title on a run of a caller of another lane is no verdict (MUTATION: matching the title without its lane turns this red)', () => {
    expect(verdicts(run(4 * DAY, { over: failedRun('merge.yml', 3, [VERDICT]) }).outcome).red).toBe('hold');
  });

  it('an admin\'s explanation on the pin pull request explains the run, and the evidence quotes it (MUTATION: ignoring explanations turns this red)', () => {
    const over = { ...failedRun('merge.yml', 2), ...roles, [page(`repos/${REPO}/issues/110/comments`)]: [comment('owner', `${EXPLAIN_MARKER}\n- 2: GitHub answered 502 to one read; the next tick was green`)] };
    const { outcome } = run(4 * DAY, { over });
    expect(verdicts(outcome)).toEqual(ALL_PASS);
    expect(redGate(outcome).evidence).toContain('merge.yml run 2, explained by @owner on #110: GitHub answered 502 to one read; the next tick was green');
  });

  it('the first line may be typed in any case, as on a phone', () => {
    const over = { ...failedRun('merge.yml', 2), ...roles, [page(`repos/${REPO}/issues/110/comments`)]: [comment('owner', 'explain red:\n- 2: transient')] };
    expect(verdicts(run(4 * DAY, { over }).outcome).red).toBe('pass');
  });

  it("an explanation by someone who isn't an admin, or edited after it was posted, counts for nothing, and the evidence says why (MUTATION: dropping either check turns this red)", () => {
    for (const [c, why] of [[comment('helper', `${EXPLAIN_MARKER}\n- 2: fine`), '@helper is not a repository admin'], [comment('owner', `${EXPLAIN_MARKER}\n- 2: fine`, true), "@owner's explanation was edited after it was posted"]] as const) {
      const over = { ...failedRun('merge.yml', 2), ...roles, [page(`repos/${REPO}/issues/110/comments`)]: [c] };
      const { outcome } = run(4 * DAY, { over });
      expect(verdicts(outcome).red).toBe('hold');
      expect(redGate(outcome).evidence).toContain(why);
    }
  });

  it("an explanation whose author's permission can't be read holds, and says the read failed, not that they aren't an admin", () => {
    const over = { ...failedRun('merge.yml', 2), [page(`repos/${REPO}/issues/110/comments`)]: [comment('owner', `${EXPLAIN_MARKER}\n- 2: fine`)] };
    const { outcome } = run(4 * DAY, { over });
    expect(verdicts(outcome).red).toBe('hold');
    expect(redGate(outcome).evidence).toContain("@owner's permission could not be read");
    expect(redGate(outcome).evidence).not.toContain('is not a repository admin');
  });

  it('an explanation on the open held issue counts, as on the pin pull request', () => {
    const over = {
      ...failedRun('merge.yml', 2), ...roles,
      [page(`repos/${REPO}/issues?state=open&creator=${encodeURIComponent(HELD_AUTHOR)}`)]: [{ number: 140, title: heldTitle(CANDIDATE), body: '', user: { login: HELD_AUTHOR } }],
      [page(`repos/${REPO}/issues/140/comments`)]: [comment('owner', `${EXPLAIN_MARKER}\n- 2: GitHub 502`)],
    };
    const { outcome } = run(4 * DAY, { over });
    expect(verdicts(outcome).red).toBe('pass');
    expect(redGate(outcome).evidence).toContain('explained by @owner on #140: GitHub 502');
  });
});

describe('a held promotion reaches the Owner (#1441)', () => {
  const red = {
    [runsPath('merge.yml', 'failure')]: { total_count: 1, workflow_runs: [{ id: 2, status: 'completed', conclusion: 'failure' }] },
    [`repos/${REPO}/actions/runs/2/jobs?per_page=100`]: { jobs: [{ id: 21, conclusion: 'failure', steps: [{ name: 'Consider the PR(s)', conclusion: 'failure' }] }] },
    [`repos/${REPO}/check-runs/21/annotations?per_page=100`]: [{ title: 'Process completed with exit code 1' }],
  };
  const owner = {
    [`repos/${REPO}/pulls/110`]: { number: 110, merged_by: { login: 'owner' } },
    [page(`repos/${REPO}/milestones?state=open`)]: [{ number: 3, title: HELD_MILESTONE }, { number: 4, title: 'Product Backlog' }],
  };
  const notified = (soak: number, { over = {}, env = {}, applied = '', open }: { over?: Record<string, Route>; env?: Record<string, string>; applied?: string; open?: { number: number; body: string; title?: string; author?: string } } = {}) => {
    const issues = open ? {
      [page(`repos/${REPO}/issues?state=open&creator=${encodeURIComponent(HELD_AUTHOR)}`)]: [{ number: open.number, title: open.title ?? heldTitle(CANDIDATE), body: open.body, user: { login: open.author ?? HELD_AUTHOR } }],
      [page(`repos/${REPO}/issues/${open.number}/comments`)]: [],
    } : {};
    const { outcome, now } = run(soak, { over: { ...over, ...issues }, env });
    const gh = github(now, { ...over, ...owner, ...issues });
    const done = notify(outcome, { api: gh.api, repo: REPO, applied, runUrl: 'https://github.com/yedeya-labs/kanon/actions/runs/9' });
    return { outcome, writes: gh.writes, done };
  };

  it('opens one issue past the soak, assigned to whoever merged the pin pull request, on the pipeline bucket, with each gate and how to explain a red (MUTATION: no assignee turns this red)', () => {
    const { writes } = notified(4 * DAY, { over: red });
    expect(writes).toHaveLength(1);
    const [w] = writes;
    expect(w!.method).toBe('POST');
    expect(w!.path).toBe(`repos/${REPO}/issues`);
    const body = w!.body as { title: string; body: string; labels: string[]; assignees: string[]; milestone: number };
    expect(body.title).toBe(heldTitle(CANDIDATE));
    expect(body.assignees).toEqual(['owner']);
    expect(body.labels).toEqual([HELD_LABEL]);
    expect(body.milestone).toBe(3);
    expect(body.body).toContain('| No unexplained red | **hold** |');
    expect(body.body).toContain(`${EXPLAIN_MARKER}\n- <run id>: <cause>`);
  });

  it('a later run rewrites the body and comments only when the gates holding it change (MUTATION: commenting every run turns this red)', () => {
    const same = notified(4 * DAY, { over: red, open: { number: 140, body: '<!-- kanon:promotion-held red -->\nold' } }).writes;
    expect(same.map((w) => `${w.method} ${w.path}`)).toEqual([`PATCH repos/${REPO}/issues/140`]);
    const changed = notified(4 * DAY, { over: red, open: { number: 140, body: '<!-- kanon:promotion-held e2e -->\nold' } }).writes;
    expect(changed.map((w) => `${w.method} ${w.path}`)).toEqual([`PATCH repos/${REPO}/issues/140`, `POST repos/${REPO}/issues/140/comments`]);
  });

  it('opens nothing for an expected hold: before the soak ends, or by a dispatch\'s `hold` (MUTATION: notifying every hold turns this red)', () => {
    expect(notified(71 * HOUR, { over: red }).writes).toEqual([]);
    expect(notified(4 * DAY, { env: { HOLD: 'true' } }).writes).toEqual([]);
  });

  it("never reads a same-titled issue someone else opened: it opens the workflow's own (MUTATION: dropping the author check turns this red)", () => {
    const { writes } = notified(4 * DAY, { over: red, open: { number: 141, body: 'mine now', author: 'stranger' } });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST repos/${REPO}/issues`]);
  });

  it("closes an older candidate's held issue once a newer candidate is the newest (MUTATION: reading only this candidate's issue turns this red)", () => {
    const { writes } = notified(4 * DAY, { over: red, open: { number: 139, body: '<!-- kanon:promotion-held red -->', title: heldTitle('candidate-v0.40.1') } });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST repos/${REPO}/issues/139/comments`, `PATCH repos/${REPO}/issues/139`, `POST repos/${REPO}/issues`]);
    expect(writes[1]!.body).toEqual({ state: 'closed', state_reason: 'not_planned' });
  });

  it('closes the issue once the candidate is promoted, and not while the apply step failed', () => {
    const open = { number: 140, body: '<!-- kanon:promotion-held red -->\nold' };
    const promoted = notified(4 * DAY, { applied: 'success', open });
    expect(promoted.outcome.decision).toBe('promote');
    expect(promoted.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST repos/${REPO}/issues/140/comments`, `PATCH repos/${REPO}/issues/140`]);
    expect(promoted.writes[1]!.body).toEqual({ state: 'closed', state_reason: 'completed' });
    expect(notified(4 * DAY, { applied: 'failure', open }).writes).toEqual([]);
  });
});

describe("the stable Release's notes cover every change since the last stable release (#992)", () => {
  /** The notes above the promotion's evidence line. */
  const changes = (notes: string) => notes.split('\n\n---\n\n')[0];
  const promotedRelease = { [`repos/${REPO}/releases/tags/candidate-v0.40.0`]: { tag_name: 'candidate-v0.40.0', prerelease: true, body: PROMOTED_NOTES } };
  const held = {
    ...promotedRelease,
    [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [ref('candidate-v0.40.0', PREV), ref('candidate-v0.40.1', HELD), ref(CANDIDATE, SHA)],
    [`repos/${REPO}/releases/tags/candidate-v0.40.1`]: { tag_name: 'candidate-v0.40.1', prerelease: true, body: HELD_NOTES },
  };

  it("a candidate held and superseded: the promoted one's notes, then the held one's, newest first (MUTATION: the candidate's own body alone turns this red)", () => {
    const { outcome } = run(4 * DAY, { over: held });
    expect(outcome.decision).toBe('promote');
    expect(changes(outcome.plan!.notes)).toBe(`${CUT_NOTES.trimEnd()}\n\n${HELD_NOTES.trimEnd()}`);
    expect(outcome.plan!.notes).toContain('### ⚠ BREAKING CHANGES');
    // candidate-v0.40.0 was promoted as v0.40.0: its changes are that Release's, not this one's.
    expect(outcome.plan!.notes).not.toContain(PROMOTED_NOTES.trimEnd());
  });

  it("a single candidate's notes are its own body, as before, not a candidate already promoted (MUTATION: dropping the newest stable tag as the lower bound turns this red)", () => {
    const { outcome } = run(4 * DAY, { over: promotedRelease });
    expect(changes(outcome.plan!.notes)).toBe(CUT_NOTES.trimEnd());
    expect(outcome.plan!.notes.startsWith(`${CUT_NOTES.trimEnd()}\n\n---\n\nPromoted from \`${CANDIDATE}\` on 2026-10-23.`)).toBe(true);
  });

  it('a promotion finished after an interruption carries the same notes', () => {
    const resumed = [ref('v0.40.0', PREV), ref(STABLE, SHA)];
    const { outcome } = run(4 * DAY, { over: { ...held, [`repos/${REPO}/git/matching-refs/tags/v`]: resumed } });
    expect(outcome.plan).toMatchObject({ resume: true, notes: `${CUT_NOTES.trimEnd()}\n\n${HELD_NOTES}` });
    expect(run(4 * DAY, { over: { [`repos/${REPO}/git/matching-refs/tags/v`]: resumed } }).outcome.plan!.notes).toBe(CUT_NOTES);
  });

  it("refuses when a superseded candidate has no Release, since the notes can't cover its changes", () => {
    const over = { ...held, [`repos/${REPO}/releases/tags/candidate-v0.40.1`]: undefined };
    expect(() => run(4 * DAY, { over })).toThrow(Refusal);
    expect(() => run(4 * DAY, { over })).toThrow("candidate-v0.40.1, a candidate since v0.40.0 that was never promoted, has no Release, so v0.41.0's notes can't cover its changes");
  });
});

describe('the spacing, hold and urgent (plan 0009 §3, §7)', () => {
  const recent = (now: number) => ({ [`repos/${REPO}/releases/latest`]: { tag_name: 'v0.40.0', published_at: iso(now - 5 * DAY) } });

  it('a second promotion within six days is held', () => {
    const now = at(4 * DAY);
    const { outcome, gh } = run(4 * DAY, { over: recent(now) });
    expect(verdicts(outcome)).toEqual(ALL_PASS);
    expect(outcome.decision).toBe('hold');
    expect(outcome.why).toMatch(/^the last stable release, v0\.40\.0, was published 120h ago, under 6 days/);
    expect(gh.writes).toEqual([]);
    const later = at(4 * DAY);
    expect(run(4 * DAY, { over: { [`repos/${REPO}/releases/latest`]: { tag_name: 'v0.40.0', published_at: iso(later - SPACING_MS) } } }).outcome.decision).toBe('promote');
  });

  it('urgent, with a reason, promotes within six days and before the soak ends, and the reason goes into the notes', () => {
    const now = at(10 * HOUR);
    const { outcome } = run(10 * HOUR, { env: { URGENT: 'true', REASON: 'security fix for #140' }, over: recent(now) });
    expect(verdicts(outcome)).toEqual({ revert: 'pass', bug: 'pass', red: 'pass', e2e: 'pass', review: 'pass', soak: 'skipped' });
    expect(outcome.decision).toBe('promote');
    expect(outcome.plan!.notes).toContain('out of band (urgent): security fix for #140');
  });

  it('urgent still applies the other four gates, and needs a review run that succeeded at the candidate', () => {
    const urgent = { URGENT: 'true', REASON: 'fix' };
    const bug = { [page(`repos/${REPO}/issues?state=open&labels=bug`)]: [{ number: 131, labels: [{ name: 'bug' }, { name: 'sev:high' }], body: '### Introduced by\n\n#101\n' }] };
    expect(run(10 * HOUR, { env: urgent, over: bug }).outcome.decision).toBe('hold');
    const noReview = run(10 * HOUR, { env: urgent, over: { [runsPath('review.yml', 'success')]: { total_count: 0, workflow_runs: [] } } }).outcome;
    expect(verdicts(noReview).review).toBe('hold');
    expect(noReview.decision).toBe('hold');
  });

  it("urgent's review gate needs the review job itself to have succeeded: a run the filter declined reviewed nothing", () => {
    const urgent = { URGENT: 'true', REASON: 'fix' };
    const ok = run(10 * HOUR, { env: urgent }).outcome;
    expect(ok.gates.find((g) => g.id === 'review')!.evidence).toBe(`review.yml run 1 called agent-review.yml@${CANDIDATE}, and its \`review\` job succeeded`);
    const filtered = { [`repos/${REPO}/actions/runs/1/jobs?per_page=100`]: { jobs: [{ id: 11, name: 'review / filter', conclusion: 'success' }, { id: 12, name: 'review / review', conclusion: 'skipped' }] } };
    const out = run(10 * HOUR, { env: urgent, over: filtered }).outcome;
    expect(verdicts(out).review).toBe('hold');
    expect(out.decision).toBe('hold');
  });

  it("urgent's review gate reads the lane the run called, not the caller's head copy: a pull_request_target run whose head pins the candidate but which ran the previous release holds (MUTATION: reading the head copy turns this red)", () => {
    const old = {
      [runsPath('review.yml', 'success')]: { total_count: 1, workflow_runs: [reviewRun('v0.40.0')] },
      // The pull request's own copy of the caller, at the run's head, pins the candidate.
      [`repos/${REPO}/contents/.github/workflows/review.yml?ref=${REVIEWED}`]: WORKFLOWS[0]!.text,
    };
    const out = run(10 * HOUR, { env: { URGENT: 'true', REASON: 'fix' }, over: old }).outcome;
    expect(verdicts(out).review).toBe('hold');
    expect(out.gates.find((g) => g.id === 'review')!.evidence).toBe(`no run of the review lane's caller since ${PIN} called agent-review.yml@${CANDIDATE} and had its \`review\` job succeed`);
  });

  it('urgent without a reason is refused', () => {
    for (const REASON of ['', '   ']) {
      expect(() => run(4 * DAY, { env: { URGENT: 'true', REASON } })).toThrow(Refusal);
    }
    expect(() => run(4 * DAY, { env: { URGENT: 'true' } })).toThrow(/`urgent` needs a reason/);
  });

  it('`hold` reports the gates and promotes nothing', () => {
    const { outcome } = run(4 * DAY, { env: { HOLD: 'true' } });
    expect(verdicts(outcome)).toEqual(ALL_PASS);
    expect(outcome.decision).toBe('hold');
    expect(outcome.why).toBe("held by the dispatch's `hold`");
    expect(outcome.plan).toBeUndefined();
  });

  it('`hold` finishes no interrupted promotion either: no Release, no latest, no major tag moved (#1054; MUTATION: the resume branch ignoring `hold` turns this red)', () => {
    const tagged = [ref('v0.40.0', PREV), ref(STABLE, SHA)];
    const cases: Record<string, Route>[] = [
      { [`repos/${REPO}/git/matching-refs/tags/v`]: tagged },
      { [`repos/${REPO}/git/matching-refs/tags/v`]: tagged, [`repos/${REPO}/releases/tags/${STABLE}`]: { tag_name: STABLE } },
    ];
    for (const over of cases) {
      const { outcome } = run(4 * DAY, { env: { HOLD: 'true' }, over });
      expect(outcome).toMatchObject({ decision: 'hold', candidate: CANDIDATE, gates: [] });
      expect(outcome.why).toMatch(/^held by the dispatch's `hold`: v0\.41\.0 (is|and its Release are) on candidate-v0\.41\.0's commit[^;]*; the next run without `hold` finishes it$/);
      expect(outcome.plan).toBeUndefined();
      expect(summary(outcome)).toContain("**Held:** held by the dispatch's `hold`");
    }
    // A promotion with nothing left to finish is still `none`, held or not.
    const done = { [`repos/${REPO}/git/matching-refs/tags/v`]: tagged, [`repos/${REPO}/releases/tags/${STABLE}`]: { tag_name: STABLE }, [`repos/${REPO}/git/ref/tags/v0`]: { ref: 'refs/tags/v0', object: { sha: SHA } } };
    expect(run(4 * DAY, { env: { HOLD: 'true' }, over: done }).outcome.decision).toBe('none');
  });
});

describe('what the promotion refuses or skips', () => {
  it("refuses a commit whose package.json version differs from the tag's (MUTATION: the version check removed turns this red)", () => {
    const over = { [`repos/${REPO}/contents/package.json?ref=${SHA}`]: JSON.stringify({ version: '0.40.1' }) };
    expect(() => run(4 * DAY, { over })).toThrow(Refusal);
    expect(() => run(4 * DAY, { over })).toThrow(`${CANDIDATE}'s commit ${SHA} says it is version 0.40.1 in package.json, not 0.41.0`);
  });

  it('refuses a stable tag of the same version on another commit', () => {
    const over = { [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0.40.0', PREV), ref(STABLE, LATER)] };
    expect(() => run(4 * DAY, { over })).toThrow(/^v0\.41\.0 names d+, not candidate-v0\.41\.0's commit/);
  });

  it('refuses a candidate with no Release, whose notes the stable one takes', () => {
    expect(() => run(4 * DAY, { over: { [`repos/${REPO}/releases/tags/${CANDIDATE}`]: undefined } })).toThrow(/has no Release/);
  });

  it('does nothing with no candidate, or when the newest is promoted already', () => {
    expect(run(4 * DAY, { over: { [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [] } }).outcome.decision).toBe('none');
    const done = run(4 * DAY, { over: {
      [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0.40.0', PREV), ref(STABLE, SHA)],
      [`repos/${REPO}/releases/tags/${STABLE}`]: { tag_name: STABLE },
      [`repos/${REPO}/git/ref/tags/v0`]: { ref: 'refs/tags/v0', object: { sha: SHA } },
    } });
    expect(done.outcome).toMatchObject({ decision: 'none', why: `${CANDIDATE} is promoted already, as ${STABLE}` });
  });

  it('finishes a promotion interrupted after its tag: the Release and the major tag, not the tag again', () => {
    const { outcome, gh } = run(4 * DAY, { over: { [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0.40.0', PREV), ref(STABLE, SHA)] } });
    expect(outcome).toMatchObject({ decision: 'promote', plan: { tag: STABLE, sha: SHA, resume: true, publish: true } });
    apply(outcome.plan!, { api: gh.api, repo: REPO });
    expect(gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST repos/${REPO}/releases`, `PATCH repos/${REPO}/git/refs/tags/v0`]);
  });

  it('finishes a promotion interrupted after its Release: the major tag alone, when it is not on the candidate\'s commit', () => {
    const over = {
      [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0.40.0', PREV), ref(STABLE, SHA)],
      [`repos/${REPO}/releases/tags/${STABLE}`]: { tag_name: STABLE },
    };
    const { outcome, gh } = run(4 * DAY, { over });
    expect(outcome).toMatchObject({ decision: 'promote', why: `${STABLE} and its Release are on ${CANDIDATE}'s commit, but v0 is not: finishing that promotion`, plan: { resume: true, publish: false } });
    apply(outcome.plan!, { api: gh.api, repo: REPO });
    expect(gh.writes).toEqual([{ method: 'PATCH', path: `repos/${REPO}/git/refs/tags/v0`, body: { sha: SHA, force: true } }]);
    // Never back: with a newer stable release, the major tag stays on it.
    const newer = run(4 * DAY, { over: { ...over, [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0.40.0', PREV), ref(STABLE, SHA), ref('v0.42.0', LATER)] } });
    expect(newer.outcome.decision).toBe('none');
  });

  it('never moves v0 or latest back: a candidate below a newer stable release is superseded, urgent or not (#1002; MUTATION: dropping the newer-stable check turns this red)', () => {
    const over = { [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0', LATER), ref('v0.40.0', PREV), ref('v0.42.0', LATER)] };
    for (const env of [{}, { URGENT: 'true', REASON: 'a security fix' }] as Record<string, string>[]) {
      const { outcome, gh } = run(4 * DAY, { env, over });
      expect(outcome).toMatchObject({ decision: 'none', why: `v0.42.0 is a newer stable release, so ${CANDIDATE} is superseded: promoting it would move v0 and the latest Release back`, candidate: CANDIDATE });
      expect(outcome.plan).toBeUndefined();
      expect(gh.writes).toEqual([]);
    }
  });

  it('finishes a promotion interrupted after its tag below a newer stable release: its Release, not latest, and v0 left where it is (#1002; MUTATION: apply ignoring the plan\'s `latest` or `moveMajor` turns this red)', () => {
    const over = { [`repos/${REPO}/git/matching-refs/tags/v`]: [ref('v0', LATER), ref('v0.40.0', PREV), ref(STABLE, SHA), ref('v0.42.0', LATER)] };
    const { outcome, gh } = run(4 * DAY, { over: { ...over, [`repos/${REPO}/git/ref/tags/v0`]: { ref: 'refs/tags/v0', object: { sha: LATER } } } });
    expect(outcome).toMatchObject({ decision: 'promote', plan: { resume: true, publish: true, latest: false, moveMajor: false } });
    const done = apply(outcome.plan!, { api: gh.api, repo: REPO });
    expect(gh.writes).toEqual([
      { method: 'POST', path: `repos/${REPO}/releases`, body: { tag_name: STABLE, name: STABLE, body: outcome.plan!.notes, draft: false, prerelease: false, make_latest: 'false' } },
    ]);
    expect(done).toEqual([`Published the Release ${STABLE}, not latest: a newer stable release is`]);
  });

  it('reads the newest candidate by version, not by listing order, and an annotated tag by the commit it names', () => {
    const over = {
      [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [{ ref: `refs/tags/${CANDIDATE}`, object: { sha: '9'.repeat(40), type: 'tag' } }, ref('candidate-v0.9.0', OLD), ref('candidate-v0.40.0', PREV)],
      [`repos/${REPO}/git/tags/${'9'.repeat(40)}`]: { object: { sha: SHA, type: 'commit' } },
    };
    expect(run(4 * DAY, { over }).outcome).toMatchObject({ decision: 'promote', plan: { sha: SHA, tag: STABLE } });
  });
});

describe('one table of gates, so a gate is one more entry', () => {
  afterEach(() => {
    while (GATES.length > 6) GATES.pop();
  });

  it('holds the four gates of plan 0009 §2, plan 0012\'s end-to-end gate and the urgent path\'s review, in order', () => {
    expect(GATES.map((g) => [g.id, g.when])).toEqual([['soak', 'normal'], ['revert', 'always'], ['bug', 'always'], ['red', 'always'], ['e2e', 'always'], ['review', 'urgent']]);
  });

  it('a gate added to the table is read, shown, and holds the candidate, urgent or not', () => {
    GATES.push({ id: 'fifth', title: 'Fifth', when: 'always', check: () => ({ pass: false, evidence: 'red on the candidate' }) });
    for (const env of [{}, { URGENT: 'true', REASON: 'fix' }] as Array<Record<string, string>>) {
      const { outcome } = run(4 * DAY, { env });
      expect(outcome.decision).toBe('hold');
      expect(outcome.why).toContain('fifth');
      expect(summary(outcome)).toContain('| Fifth | **hold** | red on the candidate |');
    }
  });

  it('the summary names every gate with its verdict and evidence, and the outcome', () => {
    const text = summary(run(71 * HOUR).outcome);
    expect(text).toContain(`## Promotion: \`${CANDIDATE}\``);
    for (const title of ['Soak', 'No revert', 'No serious bug', 'No unexplained red', 'End to end']) expect(text).toMatch(new RegExp(`^\\| ${title} \\| `, 'm'));
    expect(text).toContain('**Held:** held by soak.');
  });
});

// Plan 0012 §8.2 and §8.3, step E11 (`[ETE-31]` to `[ETE-34]`, `[ETE-36]`). Each condition of the
// gate holds a candidate otherwise promoted, so each `hold` here is that condition's alone.
describe('the end-to-end gate (plan 0012 §8.2, E11)', () => {
  const e2e = (o: ReturnType<typeof check>) => o.gates.find((g) => g.id === 'e2e')!;
  const held = (over: Record<string, Route>, env: Record<string, string> = {}) => {
    const { outcome, gh } = run(4 * DAY, { over, env });
    expect(verdicts(outcome).e2e).toBe('hold');
    expect(outcome.decision).toBe('hold');
    expect(outcome.why).toContain('end to end');
    expect(outcome.plan).toBeUndefined();
    expect(gh.writes).toEqual([]);
    return e2e(outcome).evidence;
  };
  const runs = (...list: unknown[]) => ({ [checkRunsPath()]: { total_count: list.length, check_runs: list } });

  it('[ETE-31] holds a candidate with no `kanon-e2e` check run (MUTATION: condition 1 removed turns this red)', () => {
    expect(held(runs())).toBe(`no \`kanon-e2e\` check run by the Reporter (App id ${REPORTER_APP_ID}) on ${CANDIDATE}'s commit ${SHA}; no red issue \`e2e: ${CANDIDATE} is red\` in ${HARNESS}`);
  });

  it('[ETE-31] holds a candidate whose only green `kanon-e2e` check run is another App\'s, by its App id, though it links a green harness run (MUTATION: the App id check removed turns this red)', () => {
    // GitHub Actions' own App, as a workflow token's check run would carry; and one on another commit.
    const evidence = held(runs(checkRun({ id: 7002, app: { id: 15368, slug: 'github-actions' } }), checkRun({ id: 7003, head_sha: LATER })));
    expect(evidence).toMatch(/^no `kanon-e2e` check run by the Reporter .*; 2 more by another App or on another commit, ignored;/);
  });

  it('[ETE-36] holds a candidate whose Reporter check run links a run on another branch of the harness (MUTATION: the branch check removed turns this red)', () => {
    expect(held({ [`repos/${HARNESS}/actions/runs/${HARNESS_RUN}`]: harnessRun({ head_branch: 'forged' }) })).toContain(`on ${HARNESS}'s forged, not ${HARNESS}'s default branch main`);
  });

  it('[ETE-36] holds a candidate whose Reporter check run links a run of another workflow (MUTATION: the workflow check removed turns this red)', () => {
    expect(held({ [`repos/${HARNESS}/actions/runs/${HARNESS_RUN}`]: harnessRun({ path: '.github/workflows/probe-13-reporter-check-run.yml' }) }))
      .toContain(`a run of .github/workflows/probe-13-reporter-check-run.yml, not ${HARNESS_WORKFLOW}`);
  });

  it('[ETE-36] holds a candidate whose Reporter check run links a run recorded for another candidate (MUTATION: the candidate check removed turns this red)', () => {
    const jobs = (start: string) => ({ [page(`repos/${HARNESS}/actions/runs/${HARNESS_RUN}/attempts/1/jobs`)]: harnessJobs('success', 'success', start) });
    const want = JSON.stringify(startJobName(CANDIDATE, SHA));
    expect(held(jobs(startJobName('candidate-v0.40.0', PREV)))).toContain(`whose \`start\` job records ${JSON.stringify(startJobName('candidate-v0.40.0', PREV))}, not ${want}`);
    // The candidate's tag at another commit is another candidate too.
    expect(held(jobs(startJobName(CANDIDATE, LATER)))).toContain(`not ${want}`);
    // A run whose `start` job records no candidate (the harness's name today, before E8).
    expect(held(jobs("start (the Reporter's check run)"))).toContain(`whose \`start\` job records "start (the Reporter's check run)", not ${want}`);
  });

  it('[ETE-36] holds a candidate whose Reporter check run links no run, or a run the harness doesn\'t have', () => {
    expect(held(runs(checkRun({ external_id: 'https://example.com/forged' })))).toContain('links no harness run');
    expect(held({ [`repos/${HARNESS}/actions/runs/${HARNESS_RUN}`]: undefined })).toContain(`links the harness run ${HARNESS_RUN}, which ${HARNESS} doesn't have`);
  });

  it('[ETE-36] holds a candidate whose green check run links a harness run whose `verdict` job failed (MUTATION: condition 4 removed turns this red)', () => {
    const red = { [page(`repos/${HARNESS}/actions/runs/${HARNESS_RUN}/attempts/1/jobs`)]: harnessJobs('failure') };
    expect(held(red)).toContain(`attempt 1, whose \`verdict\` job concluded failure`);
    const none = { [page(`repos/${HARNESS}/actions/runs/${HARNESS_RUN}/attempts/1/jobs`)]: { jobs: [{ name: 'plan', conclusion: 'success' }, { name: startJobName(CANDIDATE, SHA), conclusion: 'success' }] } };
    expect(held(none)).toContain('whose `verdict` job is missing');
  });

  it('[ETE-36] reads the `verdict` job at the attempt the check run names', () => {
    const second = {
      ...runs(checkRun({ external_id: `${HARNESS_RUN}-2` })),
      [page(`repos/${HARNESS}/actions/runs/${HARNESS_RUN}/attempts/2/jobs`)]: harnessJobs('failure'),
    };
    expect(held(second)).toContain('attempt 2, whose `verdict` job concluded failure');
  });

  it('[ETE-31] holds a candidate whose latest Reporter check run is red, though an earlier one is green, or is still running (MUTATION: condition 5 removed turns this red)', () => {
    const red = runs(checkRun(), checkRun({ id: 7010, conclusion: 'failure', html_url: `https://github.com/${REPO}/runs/7010` }));
    expect(held(red)).toBe(`the Reporter's latest \`kanon-e2e\` check run, 7010, concluded failure; the check run: https://github.com/${REPO}/runs/7010; no red issue \`e2e: ${CANDIDATE} is red\` in ${HARNESS}`);
    expect(held(runs(checkRun(), checkRun({ id: 7011, status: 'in_progress', conclusion: null })))).toMatch(/check run, 7011, is in_progress, not completed/);
    expect(held(runs(checkRun({ conclusion: 'neutral' })))).toMatch(/check run, 7001, concluded neutral/);
  });

  it('[ETE-36] passes a green check run whose run concluded `failure` only because a non-gating job failed, while its `verdict` job succeeded (MUTATION: reading the run\'s conclusion instead of the `verdict` job\'s turns this red)', () => {
    const over = {
      [`repos/${HARNESS}/actions/runs/${HARNESS_RUN}`]: harnessRun({ conclusion: 'failure' }),
      [page(`repos/${HARNESS}/actions/runs/${HARNESS_RUN}/attempts/1/jobs`)]: harnessJobs('success', 'failure'),
    };
    const { outcome } = run(4 * DAY, { over });
    expect(verdicts(outcome)).toEqual(ALL_PASS);
    expect(outcome.decision).toBe('promote');
    expect(e2e(outcome).evidence).toBe(`the Reporter's latest \`kanon-e2e\` check run, https://github.com/${REPO}/runs/7001, concluded success, linking the harness run https://github.com/${HARNESS}/actions/runs/${HARNESS_RUN}, attempt 1, of ${HARNESS_WORKFLOW} on main for ${CANDIDATE}, whose \`verdict\` job succeeded`);
    expect(outcome.plan!.notes).toContain(`**End to end:** ${e2e(outcome).evidence}`);
  });

  it('[ETE-31] the latest Reporter check run decides: a green one after an earlier red one passes', () => {
    const { outcome } = run(4 * DAY, { over: runs(checkRun({ id: 6990, conclusion: 'failure' }), checkRun()) });
    expect(verdicts(outcome)).toEqual(ALL_PASS);
    expect(outcome.decision).toBe('promote');
  });

  it('a candidate cut before the gate was built, whose own commit carries no end-to-end gate, is not gated by it (plan 0012 decision 3)', () => {
    const before = { [`repos/${REPO}/contents/scripts/promote.mjs?ref=${SHA}`]: '// the promotion, with four gates\nexport const SOAK_MS = 1;\n', ...runs(checkRun({ conclusion: 'failure' })) };
    const { outcome } = run(4 * DAY, { over: before });
    expect(verdicts(outcome)).toEqual(ALL_PASS);
    expect(e2e(outcome).evidence).toBe(`not gated: ${CANDIDATE}'s commit ${SHA} predates the end-to-end gate, since its scripts/promote.mjs names no \`kanon-e2e\` check (plan 0012 decision 3)`);
    // A commit with no scripts/promote.mjs carries none either; a failed read is no answer.
    expect(verdicts(run(4 * DAY, { over: { ...before, [`repos/${REPO}/contents/scripts/promote.mjs?ref=${SHA}`]: undefined } }).outcome).e2e).toBe('pass');
  });

  it('[ETE-32] `urgent` doesn\'t skip it: an urgent candidate with no check run is held, the gate read and not skipped (MUTATION: `urgent` skipping the gate turns this red)', () => {
    const { outcome } = run(10 * HOUR, { env: { URGENT: 'true', REASON: 'security fix for #140' }, over: runs() });
    expect(verdicts(outcome)).toEqual({ revert: 'pass', bug: 'pass', red: 'pass', e2e: 'hold', review: 'pass', soak: 'skipped' });
    expect(outcome.decision).toBe('hold');
    expect(outcome.plan).toBeUndefined();
  });

  it('[ETE-32] no input overrides it: the dispatch has `hold`, `urgent` and `reason` only, and no other variable passes a red gate', () => {
    const wf = parse(readFileSync(new URL('../../.github/workflows/promote.yml', import.meta.url), 'utf8')) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } };
    expect(Object.keys(wf.on.workflow_dispatch.inputs)).toEqual(['hold', 'urgent', 'reason']);
    for (const env of [{ HOLD: 'false' }, { OVERRIDE: 'true', SKIP_E2E: 'true', E2E: 'pass', FORCE: 'true' }, { URGENT: 'true', REASON: 'override the end-to-end gate' }] as Record<string, string>[]) {
      held(runs(checkRun({ conclusion: 'failure' })), env);
    }
  });

  it('[ETE-34] the summary names the gate, the check run and its red issue when it holds a candidate', () => {
    const issue = `https://github.com/${HARNESS}/issues/41`;
    const over = {
      ...runs(checkRun({ conclusion: 'failure' })),
      [redSearch()]: { items: [
        { title: `${redIssueTitle(CANDIDATE)} again`, html_url: `https://github.com/${HARNESS}/issues/40`, state: 'open' },
        { title: redIssueTitle(CANDIDATE), html_url: issue, state: 'open' },
      ] },
    };
    const text = summary(run(4 * DAY, { over }).outcome);
    expect(text).toContain(`| End to end | **hold** | the Reporter's latest \`kanon-e2e\` check run, 7001, concluded failure; the check run: https://github.com/${REPO}/runs/7001; the red issue: ${issue} (open) |`);
    expect(text).toContain('**Held:** held by end to end.');
    // A search that fails still holds, and says so.
    const failed = summary(run(4 * DAY, { over: { ...runs(), [redSearch()]: undefined } }).outcome);
    expect(failed).toMatch(/\| End to end \| \*\*hold\*\* \| no `kanon-e2e` check run .*; the red issue `e2e: candidate-v0\.41\.0 is red` in kanon-e2e\/harness couldn't be searched: /);
  });

  it('[ETE-31] the Reporter\'s App id is the one the App register records', () => {
    const register = readFileSync(new URL('../../docs/qa/agent-identities.md', import.meta.url), 'utf8');
    expect(register).toMatch(/^\| Other App \| `kanon-e2e-reporter` \|/m);
    expect(/`kanon-e2e-reporter`, created by the Owner \(App id (\d+)\)/.exec(register)?.[1]).toBe(String(REPORTER_APP_ID));
  });

  describe("the pin job's reading, `promote.mjs gate` ([ETE-33])", () => {
    const read = (over: Record<string, Route> = {}) => gate({ GITHUB_REPOSITORY: REPO, TAG: CANDIDATE }, { api: github(at(0), over).api });

    it('passes on a green check run with a matching harness run, and holds on each red one, with the gate\'s evidence', () => {
      const green = read();
      expect(green).toMatchObject({ candidate: CANDIDATE, pass: true });
      expect(gateSummary(green)).toContain('| End to end | pass |');
      expect(gateSummary(green)).toContain(`**Pass:** the pin job moves Kanon's pins to \`${CANDIDATE}\`.`);
      for (const over of [runs(), runs(checkRun({ conclusion: 'failure' })), { [page(`repos/${HARNESS}/actions/runs/${HARNESS_RUN}/attempts/1/jobs`)]: harnessJobs('failure') }]) {
        const red = read(over);
        expect(red.pass).toBe(false);
        expect(gateSummary(red)).toContain('| End to end | **hold** |');
        expect(gateSummary(red)).toContain("**Held:** Kanon's pins stay where they are.");
      }
    });

    it('refuses a TAG that is not a candidate, or a candidate with no tag', () => {
      for (const TAG of ['', 'v0.41.0', 'candidate-v0.41']) expect(() => gate({ GITHUB_REPOSITORY: REPO, TAG }, { api: github(at(0)).api })).toThrow(Refusal);
      expect(() => gate({ GITHUB_REPOSITORY: REPO, TAG: CANDIDATE }, { api: github(at(0), { [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [ref('candidate-v0.40.0', PREV)] }).api })).toThrow(`no tag ${CANDIDATE}`);
    });

    it('opens nothing for a candidate a newer one superseded, though its gate is green: a re-run\'s check run never moves the pins back', () => {
      const newer = { [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [ref('candidate-v0.40.0', PREV), ref(CANDIDATE, SHA), ref('candidate-v0.42.0', LATER)] };
      expect(read(newer)).toEqual({ candidate: CANDIDATE, pass: false, evidence: `candidate-v0.42.0 is a newer candidate, so ${CANDIDATE} is superseded: Kanon's pins never move back to it` });
    });
  });
});

describe('Kanon\'s lane callers', () => {
  it('are the workflows calling one of its reusable workflows at a ref; a commented-out line calls nothing', () => {
    expect(laneCallers(WORKFLOWS, REPO)).toEqual([
      { file: 'review.yml', lane: 'agent-review.yml', ref: CANDIDATE },
      { file: 'merge.yml', lane: 'agent-merge.yml', ref: CANDIDATE },
    ]);
  });
});

describe('promote.yml', () => {
  type Step = { id?: string; name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
  const wf = parse(readFileSync(new URL('../../.github/workflows/promote.yml', import.meta.url), 'utf8')) as {
    on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs: Record<string, { type: string }> } };
    permissions: Record<string, string>;
    jobs: Record<string, { permissions: Record<string, string>; steps: Step[] }>;
  };
  const job = wf.jobs.promote!;
  const step = (id: string) => job.steps.find((s) => s.id === id || s.name === id)!;

  it('runs daily and on dispatch, with `hold`, `urgent` and its reason, and no override ([ETE-32])', () => {
    expect(wf.on.schedule).toEqual([{ cron: '0 6 * * *' }]);
    expect(Object.fromEntries(Object.entries(wf.on.workflow_dispatch.inputs).map(([k, v]) => [k, v.type]))).toEqual({ hold: 'boolean', urgent: 'boolean', reason: 'string' });
  });

  it('reads with a read-only token but for the held issue, and mints the Releaser\'s, Contents and Pull requests write, only to promote', () => {
    expect(wf.permissions).toEqual({});
    expect(Object.entries(job.permissions).filter(([, p]) => p !== 'read')).toEqual([['issues', 'write']]);
    expect(step('gates').run).toBe('node scripts/promote.mjs check');
    expect(step('gates').env!.GH_TOKEN).toBe('${{ github.token }}');
    const mint = step('releaser');
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(mint.if).toBe("steps.gates.outputs.decision == 'promote'");
    expect(mint.with).toEqual({ 'client-id': '${{ secrets.RELEASER_APP_ID }}', 'private-key': '${{ secrets.RELEASER_APP_PRIVATE_KEY }}', 'permission-contents': 'write', 'permission-pull-requests': 'write' });
    const write = step('Tag, publish and move the major tag');
    expect(write.if).toBe("steps.gates.outputs.decision == 'promote'");
    expect(write.run).toBe('node scripts/promote.mjs apply');
    expect(write.env!.GH_TOKEN).toBe('${{ steps.releaser.outputs.token }}');
  });

  // The docs follow the stable channel (scripts/doc-pins.mjs): only a promotion moves them, after
  // its tag exists, and only to a release that is the latest.
  it('after promoting, opens the pull request that points the docs at the release, when it is the latest', () => {
    const docs = step('Open the pull request that points the docs at the new release');
    expect(docs.if).toBe("steps.gates.outputs.decision == 'promote'");
    expect(job.steps.indexOf(docs)).toBeGreaterThan(job.steps.indexOf(step('Tag, publish and move the major tag')));
    expect(docs.env!.GH_TOKEN).toBe('${{ steps.releaser.outputs.token }}');
    expect(docs.run).toContain('jq -r .latest "$PLAN"');
    expect(docs.run).toContain('node scripts/doc-pins.mjs move "$tag"');
    expect(docs.run).toContain('title="docs: point the docs at $tag"');
  });

  // #1441: a hold reports as a green run, so the held issue is how the Owner hears of it.
  it('tells the Owner last, with the workflow token, after any promotion, unless the check refused', () => {
    const tell = step('Tell the Owner of a held promotion');
    expect(job.steps.indexOf(tell)).toBe(job.steps.length - 1);
    expect(tell.if).toBe("${{ !cancelled() && steps.gates.outcome == 'success' }}");
    expect(tell.run).toBe('node scripts/promote.mjs notify');
    expect(tell.env).toEqual({ GH_TOKEN: '${{ github.token }}', OUTCOME: '${{ runner.temp }}/outcome.json', APPLIED: '${{ steps.apply.outcome }}' });
    expect(step('gates').env!.OUTCOME).toBe('${{ runner.temp }}/outcome.json');
    expect(step('Tag, publish and move the major tag').id).toBe('apply');
  });
});
