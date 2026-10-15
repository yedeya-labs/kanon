import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { UNREACHABLE_TITLE as DOCTOR_UNREACHABLE_TITLE } from '../../cli/doctor.mjs';
import { ApiError, apply, check, GATES, laneCallers, pinTitle, Refusal, RUN_LISTING_CAP, SOAK_MS, SPACING_MS, summary, UNREACHABLE_TITLE } from '../../scripts/promote.mjs';

/**
 * Plan 0009 §2, §3 and §7, step S5: the promotion, on fixtures of GitHub's answers. A candidate is
 * held by each of the four gates in turn, promoted when all four pass (its tag on the candidate's
 * commit, its Release latest, `v0` moved), held by the six-day spacing unless `urgent`, and
 * refused when `urgent` has no reason or the commit's package.json names another version.
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

const ref = (name: string, sha: string) => ({ ref: `refs/tags/${name}`, object: { sha, type: 'commit' } });
const commit = (sha: string, message: string, date: string) => ({ sha, commit: { message, committer: { date } } });
const page = (path: string, n = 1) => `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${n}`;
const runsPath = (file: string, since = PIN) => page(`repos/${REPO}/actions/workflows/${file}/runs?created=${encodeURIComponent(`>=${since}`)}`);
const pinSearch = `search/issues?q=${encodeURIComponent(`repo:${REPO} is:pr is:merged in:title "${pinTitle(VERSION)}"`)}&per_page=100`;

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
    [`repos/${REPO}/releases/tags/${CANDIDATE}`]: { tag_name: CANDIDATE, prerelease: true, body: CUT_NOTES, created_at: CUT },
    [page(`repos/${REPO}/compare/v0.40.0...${SHA}`)]: {
      commits: [
        commit(ITEM_101, 'feat: a (#101)\n\nBody.', '2026-10-14T10:00:00Z'),
        commit(ITEM_102, 'fix: b (#102)', '2026-10-15T10:00:00Z'),
        commit(SHA, 'chore(main): release candidate 0.41.0 (#103)', CUT),
      ],
    },
    [pinSearch]: { items: [{ number: 110, title: pinTitle(VERSION), pull_request: { merged_at: PIN } }] },
    [page(`repos/${REPO}/compare/${SHA}...main`)]: { commits: [commit(LATER, 'docs: c (#111)', '2026-10-20T10:00:00Z')] },
    [page(`repos/${REPO}/pulls/111/commits`)]: [commit('e'.repeat(40), 'docs: c', '2026-10-20T09:00:00Z')],
    [page(`repos/${REPO}/issues?state=open&labels=bug`)]: [
      { number: 130, labels: [{ name: 'bug' }, { name: 'sev:medium' }], body: '### Introduced by\n\n#101\n' },
    ],
    [runsPath('review.yml')]: { total_count: 1, workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', head_sha: REVIEWED }] },
    [`repos/${REPO}/actions/runs/1/jobs?per_page=100`]: { jobs: [{ id: 11, name: 'review / filter', conclusion: 'success' }, { id: 12, name: 'review / review / review / review', conclusion: 'success' }] },
    [`repos/${REPO}/contents/.github/workflows/review.yml?ref=${REVIEWED}`]: WORKFLOWS[0]!.text,
    [runsPath('merge.yml')]: { total_count: 2, workflow_runs: [{ id: 2, status: 'completed', conclusion: 'success' }, { id: 3, status: 'completed', conclusion: 'cancelled' }] },
    [`repos/${REPO}/releases/latest`]: { tag_name: 'v0.40.0', published_at: iso(now - 8 * DAY) },
    [`repos/${REPO}/git/ref/tags/v0`]: { ref: 'refs/tags/v0', object: { sha: PREV } },
    ...over,
  };
  const writes: Write[] = [];
  const api = (path: string, { method = 'GET', body }: { method?: string; body?: unknown; raw?: boolean } = {}) => {
    if (method !== 'GET') {
      writes.push({ method, path, body });
      return {};
    }
    if (!(path in routes) || routes[path] === undefined) throw new ApiError(`${path}: HTTP 404`, 404);
    return routes[path];
  };
  return { api, writes };
};

const ENV = { GITHUB_REPOSITORY: REPO, DEFAULT_BRANCH: 'main' };
const run = (soak: number, { env = {}, over = {} }: { env?: Record<string, string>; over?: Record<string, Route> } = {}) => {
  const now = at(soak);
  const gh = github(now, over);
  const outcome = check({ ...ENV, ...env }, { api: gh.api, now, workflows: WORKFLOWS });
  return { outcome, gh, now };
};
const verdicts = (o: ReturnType<typeof check>) => Object.fromEntries(o.gates.map((g) => [g.id, g.skipped ? 'skipped' : g.pass ? 'pass' : 'hold']));
const ALL_PASS = { soak: 'pass', revert: 'pass', bug: 'pass', red: 'pass' };

describe('the gates (plan 0009 §2)', () => {
  it('a candidate passing all four is promoted: its tag on the candidate\'s commit, its Release latest, v0 moved', () => {
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
      [runsPath('review.yml', CUT)]: { workflow_runs: [] },
      [runsPath('merge.yml', CUT)]: { workflow_runs: [] },
    };
    expect(run(4 * DAY, { over: unpinned }).outcome.gates[0]!.evidence)
      .toMatch(/^no merged pull request titled `ci\(deps\): run Kanon on candidate v0\.41\.0`/);
    const now = at(4 * DAY);
    const moved = check(ENV, { api: github(now).api, now, workflows: [{ file: 'review.yml', text: `    uses: ${REPO}/.github/workflows/agent-review.yml@v0.40.0\n` }] });
    expect(verdicts(moved).soak).toBe('hold');
    expect(moved.gates[0]!.evidence).toBe(`review.yml pins v0.40.0, not ${CANDIDATE}`);
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
      [runsPath('merge.yml')]: { workflow_runs: [{ id: 2, status: 'completed', conclusion: 'failure' }] },
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
      [runsPath('merge.yml')]: { workflow_runs: [{ id: 2, status: 'completed', conclusion: 'failure' }] },
      [`repos/${REPO}/actions/runs/2/jobs?per_page=100`]: { jobs: [{ id: 20, conclusion: 'success' }, { id: 21, conclusion: 'failure' }] },
      [`repos/${REPO}/check-runs/21/annotations?per_page=100`]: [{ title: UNREACHABLE_TITLE }],
    };
    const { outcome } = run(4 * DAY, { over: red });
    expect(verdicts(outcome).red).toBe('pass');
    expect(outcome.decision).toBe('promote');
  });

  it('a run re-run green counts by its latest attempt; one still in progress is no verdict', () => {
    const runs = { [runsPath('merge.yml')]: { workflow_runs: [{ id: 2, status: 'completed', conclusion: 'success', run_attempt: 2 }, { id: 4, status: 'in_progress', conclusion: null }] } };
    expect(verdicts(run(4 * DAY, { over: runs }).outcome).red).toBe('pass');
  });

  it('a truncated run listing holds the candidate and says so: more runs than were read, or the listing\'s cap', () => {
    const more = { [runsPath('merge.yml')]: { total_count: 3, workflow_runs: [{ id: 2, status: 'completed', conclusion: 'success' }] } };
    const short = run(4 * DAY, { over: more }).outcome;
    expect(verdicts(short).red).toBe('hold');
    expect(short.gates.find((g) => g.id === 'red')!.evidence).toBe('the run listing is truncated, so a red run may be unread: merge.yml (read 1 of 3)');
    const full = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, status: 'completed', conclusion: 'success' }));
    const capped: Record<string, unknown> = {};
    for (let n = 1; n * 100 <= RUN_LISTING_CAP; n += 1) capped[runsPath('merge.yml').replace(/page=1$/, `page=${n}`)] = { total_count: RUN_LISTING_CAP, workflow_runs: full };
    const atCap = run(4 * DAY, { over: capped }).outcome;
    expect(verdicts(atCap).red).toBe('hold');
    expect(atCap.gates.find((g) => g.id === 'red')!.evidence).toContain(`merge.yml (read ${RUN_LISTING_CAP} of ${RUN_LISTING_CAP})`);
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
    expect(verdicts(outcome)).toEqual({ revert: 'pass', bug: 'pass', red: 'pass', review: 'pass', soak: 'skipped' });
    expect(outcome.decision).toBe('promote');
    expect(outcome.plan!.notes).toContain('out of band (urgent): security fix for #140');
  });

  it('urgent still applies the other three gates, and needs a review run that succeeded at the candidate', () => {
    const urgent = { URGENT: 'true', REASON: 'fix' };
    const bug = { [page(`repos/${REPO}/issues?state=open&labels=bug`)]: [{ number: 131, labels: [{ name: 'bug' }, { name: 'sev:high' }], body: '### Introduced by\n\n#101\n' }] };
    expect(run(10 * HOUR, { env: urgent, over: bug }).outcome.decision).toBe('hold');
    const noReview = run(10 * HOUR, { env: urgent, over: { [runsPath('review.yml')]: { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'cancelled' }] } } }).outcome;
    expect(verdicts(noReview).review).toBe('hold');
    expect(noReview.decision).toBe('hold');
  });

  it("urgent's review gate needs the review job itself to have succeeded: a run the filter declined reviewed nothing", () => {
    const urgent = { URGENT: 'true', REASON: 'fix' };
    const ok = run(10 * HOUR, { env: urgent }).outcome;
    expect(ok.gates.find((g) => g.id === 'review')!.evidence).toBe(`review.yml run 1's \`review\` job succeeded, with the caller pinning ${CANDIDATE} at ${REVIEWED}`);
    const filtered = { [`repos/${REPO}/actions/runs/1/jobs?per_page=100`]: { jobs: [{ id: 11, name: 'review / filter', conclusion: 'success' }, { id: 12, name: 'review / review', conclusion: 'skipped' }] } };
    const out = run(10 * HOUR, { env: urgent, over: filtered }).outcome;
    expect(verdicts(out).review).toBe('hold');
    expect(out.decision).toBe('hold');
  });

  it("urgent's review gate needs the caller to pin the candidate at the reviewed run's commit", () => {
    const old = { [`repos/${REPO}/contents/.github/workflows/review.yml?ref=${REVIEWED}`]: `    uses: ${REPO}/.github/workflows/agent-review.yml@v0.40.0\n` };
    const out = run(10 * HOUR, { env: { URGENT: 'true', REASON: 'fix' }, over: old }).outcome;
    expect(verdicts(out).review).toBe('hold');
    expect(out.gates.find((g) => g.id === 'review')!.evidence).toBe(`no run of the review lane's caller since ${PIN} has a \`review\` job that succeeded with the caller pinning ${CANDIDATE}`);
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

  it('reads the newest candidate by version, not by listing order, and an annotated tag by the commit it names', () => {
    const over = {
      [`repos/${REPO}/git/matching-refs/tags/candidate-v`]: [{ ref: `refs/tags/${CANDIDATE}`, object: { sha: '9'.repeat(40), type: 'tag' } }, ref('candidate-v0.9.0', OLD), ref('candidate-v0.40.0', PREV)],
      [`repos/${REPO}/git/tags/${'9'.repeat(40)}`]: { object: { sha: SHA, type: 'commit' } },
    };
    expect(run(4 * DAY, { over }).outcome).toMatchObject({ decision: 'promote', plan: { sha: SHA, tag: STABLE } });
  });
});

describe('one table of gates, so plan 0012\'s end-to-end gate (E11) is one more entry', () => {
  afterEach(() => {
    while (GATES.length > 5) GATES.pop();
  });

  it('holds the four gates of plan 0009 §2 and the urgent path\'s review, in order', () => {
    expect(GATES.map((g) => [g.id, g.when])).toEqual([['soak', 'normal'], ['revert', 'always'], ['bug', 'always'], ['red', 'always'], ['review', 'urgent']]);
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
    for (const title of ['Soak', 'No revert', 'No serious bug', 'No unexplained red']) expect(text).toMatch(new RegExp(`^\\| ${title} \\| `, 'm'));
    expect(text).toContain('**Held:** held by soak.');
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

  it('runs daily and on dispatch, with `hold`, `urgent` and its reason', () => {
    expect(wf.on.schedule).toEqual([{ cron: '0 6 * * *' }]);
    expect(Object.fromEntries(Object.entries(wf.on.workflow_dispatch.inputs).map(([k, v]) => [k, v.type]))).toEqual({ hold: 'boolean', urgent: 'boolean', reason: 'string' });
  });

  it('reads with a read-only token, and mints the Releaser\'s, Contents write alone, only to promote', () => {
    expect(wf.permissions).toEqual({});
    expect(Object.values(job.permissions).every((p) => p === 'read')).toBe(true);
    expect(step('gates').run).toBe('node scripts/promote.mjs check');
    expect(step('gates').env!.GH_TOKEN).toBe('${{ github.token }}');
    const mint = step('releaser');
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(mint.if).toBe("steps.gates.outputs.decision == 'promote'");
    expect(mint.with).toEqual({ 'client-id': '${{ secrets.RELEASER_APP_ID }}', 'private-key': '${{ secrets.RELEASER_APP_PRIVATE_KEY }}', 'permission-contents': 'write' });
    const write = step('Tag, publish and move the major tag');
    expect(write.if).toBe("steps.gates.outputs.decision == 'promote'");
    expect(write.run).toBe('node scripts/promote.mjs apply');
    expect(write.env!.GH_TOKEN).toBe('${{ steps.releaser.outputs.token }}');
  });
});
