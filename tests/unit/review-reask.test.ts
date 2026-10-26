import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  DECISION_RUNS_READ, LEAD_LOGIN, REASK_LABEL, REVIEWER_LOGIN, declinedByDesign, filterDecision, filterDecisionFor,
  reaskMarker, reaskPlan, reaskedHeads, reviewedHead, run,
} from '../../scripts/review-reask.mjs';
import { headerLine } from '../../scripts/lib/role-marker.mjs';

/**
 * kanon#1197: the dispatch sweep re-asks the review for an open pull request that carries
 * `review:please`, has no Reviewer review on its current head, no Review run pending or in
 * progress on that head, and CI completed on it. Once per head: the sweep's marker comment names
 * the head it re-asked, and a second pass on that head asks nothing.
 */

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = Date.parse('2026-10-21T12:00:00Z');
const PUSHED = '2026-10-21T02:00:00Z';

type Review = { author: { login: string }; body: string; state: string; commit?: { oid: string } };
type Comment = { author: { login: string }; body: string };
type Pr = {
  number: number; headRefOid: string; isCrossRepository?: boolean; labels: { name: string }[];
  reviews: Review[]; comments: Comment[]; commits: { committedDate: string }[];
  closingIssuesReferences?: { number: number; repository: { owner: { login: string }; name: string } }[];
};

const pr = (number: number, extra: Partial<Pr> = {}): Pr => ({
  number, headRefOid: HEAD, isCrossRepository: false, labels: [{ name: REASK_LABEL }],
  reviews: [], comments: [], commits: [{ committedDate: PUSHED }], ...extra,
});
const reviewerReview = (sha: string, state = 'APPROVED'): Review => ({
  author: { login: REVIEWER_LOGIN }, state, commit: { oid: HEAD },
  body: `${headerLine('Reviewer')}\n\nLooks right.\n\n<!-- reviewed: sha=${sha} run=1 -->`,
});
const leadMarker = (sha: string, login = LEAD_LOGIN): Comment => ({
  author: { login }, body: `${headerLine('Lead')}\n\nRe-asked.\n\n${reaskMarker(sha)}`,
});

type Run = { id: number; status: string; conclusion: string | null };
const done = (id = 1, conclusion = 'failure'): Run => ({ id, status: 'completed', conclusion });

/** The plan for one pull request, with every read answering "go" unless overridden. */
const planFor = (p: Pr, io: { ci?: boolean | null; runs?: Run[] | null } = {}) =>
  reaskPlan([p], {
    ciSettled: () => (io.ci === undefined ? true : io.ci),
    runsFor: () => (io.runs === undefined ? [done()] : io.runs),
    now: NOW,
    hours: 4,
  });
const asked = (p: Pr, io: Parameters<typeof planFor>[1] = {}) => planFor(p, io).reask.map((r) => r.number);

describe('reaskPlan: one re-ask, or none, per state (kanon#1197)', () => {
  it('re-asks a labelled PR with no review on its head, no run pending and CI completed', () => {
    expect(planFor(pr(1))).toMatchObject({ reask: [{ number: 1, sha: HEAD }], held: [] });
  });

  it('asks nothing for a PR that does not carry review:please', () => {
    expect(asked(pr(2, { labels: [{ name: 'agent:implement' }] }))).toEqual([]);
  });

  it("asks nothing when a Reviewer review's trailer names the current head", () => {
    for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']) {
      expect(asked(pr(3, { reviews: [reviewerReview(HEAD, state)] })), state).toEqual([]);
    }
  });

  it("re-asks when the Reviewer's only review names an earlier head (the head check)", () => {
    expect(asked(pr(4, { reviews: [reviewerReview(OLD)] }))).toEqual([4]);
  });

  it('re-asks when the review on the head is not the Reviewer\'s', () => {
    const person: Review = { ...reviewerReview(HEAD), author: { login: 'a-person' } };
    const unmarked: Review = { ...reviewerReview(HEAD), body: `Looks right.\n\n<!-- reviewed: sha=${HEAD} -->` };
    expect(asked(pr(5, { reviews: [person] }))).toEqual([5]);
    expect(asked(pr(5, { reviews: [unmarked] }))).toEqual([5]);
  });

  it('asks nothing while a Review run on the head is queued or in progress', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      expect(asked(pr(6), { runs: [done(1), { id: 2, status, conclusion: null }] }), status).toEqual([]);
    }
  });

  it('re-asks when every Review run on the head has completed, however it ended', () => {
    for (const conclusion of ['failure', 'success', 'cancelled', 'skipped', 'startup_failure']) {
      expect(asked(pr(7), { runs: [done(1, conclusion)] }), conclusion).toEqual([7]);
    }
    expect(asked(pr(7), { runs: [] })).toEqual([7]);
  });

  it("asks nothing until CI on the head has completed, or when CI's runs can't be read", () => {
    expect(planFor(pr(8), { ci: false })).toMatchObject({ reask: [], held: [{ number: 8, why: expect.stringMatching(/CI has not finished/) }] });
    expect(planFor(pr(8), { ci: null })).toMatchObject({ reask: [], held: [{ number: 8, why: expect.stringMatching(/could not read CI/) }] });
  });

  it("asks nothing when the head's Review runs can't be read", () => {
    expect(planFor(pr(9), { runs: null })).toMatchObject({ reask: [], held: [{ number: 9, why: expect.stringMatching(/could not read/) }] });
  });

  it('asks nothing for a head the sweep already re-asked, and re-asks a new head', () => {
    expect(planFor(pr(10, { comments: [leadMarker(HEAD)] }))).toMatchObject({ reask: [], held: [{ number: 10, why: expect.stringMatching(/once per head/) }] });
    expect(asked(pr(10, { comments: [leadMarker(OLD)] }))).toEqual([10]);
  });

  it("reads only the Lead's own marker, so a quoted marker holds nothing", () => {
    expect(asked(pr(11, { comments: [leadMarker(HEAD, 'a-person')] }))).toEqual([11]);
    expect(reaskedHeads([leadMarker(HEAD), leadMarker(OLD, 'a-person')])).toEqual(new Set([HEAD]));
  });

  it('waits out the stall window after the push, and holds a head whose push time is unknown (K-MERGE-14)', () => {
    expect(asked(pr(12, { commits: [{ committedDate: '2026-10-21T10:00:00Z' }] }))).toEqual([]);
    expect(asked(pr(12, { commits: [] }))).toEqual([]);
  });

  it("asks nothing for a fork's head, which the review lane refuses", () => {
    expect(asked(pr(13, { isCrossRepository: true }))).toEqual([]);
  });

  it('decides each PR on its own', () => {
    const plan = reaskPlan([pr(1), pr(3, { reviews: [reviewerReview(HEAD)] }), pr(10, { comments: [leadMarker(HEAD)] })], {
      ciSettled: () => true, runsFor: () => [], now: NOW, hours: 4,
    });
    expect(plan.reask.map((r) => r.number)).toEqual([1]);
    expect(plan.reviewed).toEqual([3]);
    expect(plan.held.map((h) => h.number)).toEqual([10]);
  });
});

describe('reviewedHead', () => {
  it('falls back to the commit GitHub filed a trailer-less Reviewer review under', () => {
    const old: Review = { author: { login: REVIEWER_LOGIN }, state: 'APPROVED', body: `${headerLine('Reviewer')}\n\nok`, commit: { oid: HEAD } };
    expect(reviewedHead(pr(1, { reviews: [old] }))).toBe(true);
    expect(reviewedHead(pr(1, { reviews: [{ ...old, commit: { oid: OLD } }] }))).toBe(false);
  });
});

// ── run: the reads, the writes, and a second pass ─────────────────────────────────────────────

/** A fake repository: open PRs by number, CI done, and every `gh` call recorded. Comments the
 *  sweep posts are kept, so a second pass reads them. */
const fakeRepo = (prs: Pr[], { failComment = false, logs = {} as Record<number, string>, issues = {} as Record<number, { body?: string; labels?: string[] } | 'unreadable'> } = {}) => {
  const calls: string[][] = [];
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const gh = (args: string[]): string => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === 'pr' && a1 === 'list') {
      return JSON.stringify([...byNumber.values()].filter((p) => p.labels.some((l) => l.name === REASK_LABEL)).map(({ number, headRefOid, isCrossRepository, labels }) => ({ number, headRefOid, isCrossRepository, labels })));
    }
    if (a0 === 'pr' && a1 === 'view') return JSON.stringify(byNumber.get(Number(args[2])));
    if (a0 === 'issue' && a1 === 'view') {
      const issue = issues[Number(args[2])];
      if (issue === undefined || issue === 'unreadable') throw new Error('HTTP 502');
      return JSON.stringify({ body: issue.body ?? '', labels: (issue.labels ?? []).map((name) => ({ name })) });
    }
    if (a0 === 'run' && a1 === 'list') return JSON.stringify([{ headSha: args[args.indexOf('--commit') + 1], status: 'completed', conclusion: 'success', databaseId: 9 }]);
    if (a0 === 'api') {
      const path = args.find((x) => x.startsWith('repos/')) ?? '';
      const m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
      if (m) {
        if (failComment) throw new Error('HTTP 502');
        const body = args[args.indexOf('-f') + 1]!.replace(/^body=/, '');
        byNumber.get(Number(m[1]))!.comments.push({ author: { login: `${LEAD_LOGIN}` }, body });
        return '{}';
      }
      if (/\/labels/.test(path)) return '[]';
      const jobs = /^repos\/o\/r\/actions\/runs\/(\d+)\/jobs/.exec(path);
      if (jobs && logs[Number(jobs[1])] !== undefined) return JSON.stringify({ jobs: [{ id: Number(jobs[1]) * 10, name: 'review / filter' }] });
      const log = /^repos\/o\/r\/actions\/jobs\/(\d+)\/logs$/.exec(path);
      if (log && logs[Number(log[1]) / 10] !== undefined) return logs[Number(log[1]) / 10]!;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
};
const writes = (calls: string[][]) => calls.filter((c) => c[0] === 'api' && c.includes('-X')).map((c) => `${c[c.indexOf('-X') + 1]} ${c.find((x) => x.startsWith('repos/'))}`);

describe('run (kanon#1197)', () => {
  const io = { repo: 'o/r', now: NOW, runsFor: () => [done()] };

  it('posts the head marker, then removes and re-adds review:please, with apply', () => {
    const repo = fakeRepo([pr(1)]);
    const out = run({ ...io, apply: true, gh: repo.gh });
    expect(out.reasked).toEqual([1]);
    expect(writes(repo.calls)).toEqual([
      'POST repos/o/r/issues/1/comments',
      'DELETE repos/o/r/issues/1/labels/review%3Aplease',
      'POST repos/o/r/issues/1/labels',
    ]);
    const comment = repo.calls.find((c) => c.includes('repos/o/r/issues/1/comments'))!;
    const body = comment[comment.indexOf('-f') + 1]!;
    expect(body).toMatch(/^body=\*\*Lead\*\* <!-- kanon:role=lead -->/);
    expect(body).toContain(reaskMarker(HEAD));
    const add = repo.calls.find((c) => c.includes('repos/o/r/issues/1/labels'))!;
    expect(add).toContain(`labels[]=${REASK_LABEL}`);
  });

  it('a second pass on the same head dispatches nothing', () => {
    const repo = fakeRepo([pr(1)]);
    run({ ...io, apply: true, gh: repo.gh });
    const before = repo.calls.length;
    const second = run({ ...io, apply: true, gh: repo.gh });
    expect(second.reasked).toEqual([]);
    expect(writes(repo.calls.slice(before))).toEqual([]);
  });

  it('writes nothing on a dry run, and says what it would ask', () => {
    const repo = fakeRepo([pr(1)]);
    let text = '';
    const out = run({ ...io, apply: false, gh: repo.gh, summary: (t) => { text += t; } });
    expect(out.reasked).toEqual([]);
    expect(writes(repo.calls)).toEqual([]);
    expect(text).toMatch(/#1 `aaaaaaa`.*would re-ask \(dry run\)/);
  });

  it('touches no label when the marker could not be posted, so a head is never asked without its bound', () => {
    const repo = fakeRepo([pr(1)], { failComment: true });
    const out = run({ ...io, apply: true, gh: repo.gh });
    expect(out.reasked).toEqual([]);
    expect(out.failed).toEqual([1]);
    expect(repo.calls.some((c) => c.some((x) => /\/labels/.test(x)))).toBe(false);
  });

  it('never throws on a listing it cannot read', () => {
    const out = run({ ...io, apply: true, gh: () => { throw new Error('HTTP 502'); } });
    expect(out).toMatchObject({ plan: null, reasked: [] });
  });

  it("lists CI's runs from ci.yml for the head, as the review lane's filter does", () => {
    const repo = fakeRepo([pr(1)]);
    run({ ...io, apply: false, gh: repo.gh });
    const ci = repo.calls.find((c) => c[0] === 'run' && c[1] === 'list')!;
    expect(ci).toEqual(expect.arrayContaining(['--workflow', 'ci.yml', '--commit', HEAD]));
  });
});

// ── kanon#1431: a held project takes no actions (K-AGENT-32) ───────────────────────────────

describe('reaskPlan on a pull request of a held project (kanon#1431)', () => {
  const HELD_WHY = 'project #7 is held (`needs:human` on its tracking issue)';

  it('holds a pull request whose project is held, and says why', () => {
    const plan = reaskPlan([pr(1), pr(2)], { ciSettled: () => true, runsFor: () => [done()], heldBy: (p: { number: number }) => (p.number === 1 ? HELD_WHY : null), now: NOW, hours: 4 });
    expect(plan.reask).toEqual([{ number: 2, sha: HEAD }]);
    expect(plan.held).toEqual([{ number: 1, sha: HEAD, why: HELD_WHY }]);
  });

  it('asks the hold only of a pull request about to be re-asked, so a waiting one costs no read', () => {
    const asked: number[] = [];
    const heldBy = (p: { number: number }) => { asked.push(p.number); return null; };
    reaskPlan([pr(1), pr(2, { commits: [{ committedDate: '2026-10-21T11:00:00Z' }] })], { ciSettled: () => true, runsFor: () => [done()], heldBy, now: NOW, hours: 4 });
    expect(asked).toEqual([1]);
  });
});

describe('run on a pull request of a held project (kanon#1431)', () => {
  const io = { repo: 'o/r', now: NOW, runsFor: () => [done()] };
  const here = (number: number) => ({ number, repository: { owner: { login: 'o' }, name: 'r' } });
  const member = () => pr(1, { closingIssuesReferences: [here(40)] });
  const marked = { body: 'Do the thing.\n\n<!-- qa:project 7 -->' };

  it('posts nothing and churns no label when the tracking issue carries needs:human, and the summary says why', () => {
    const repo = fakeRepo([member()], { issues: { 40: marked, 7: { labels: ['needs:human'] } } });
    let text = '';
    const out = run({ ...io, apply: true, gh: repo.gh, summary: (t) => { text += t; } });
    expect(out.reasked).toEqual([]);
    expect(writes(repo.calls)).toEqual([]);
    expect(text).toMatch(/#1 `aaaaaaa`: not re-asked, project #7 is held/);
  });

  it('counts a tracking issue it cannot read as held', () => {
    const repo = fakeRepo([member()], { issues: { 40: marked, 7: 'unreadable' } });
    const out = run({ ...io, apply: true, gh: repo.gh });
    expect(out.reasked).toEqual([]);
    expect(out.plan?.held).toEqual([expect.objectContaining({ number: 1, why: expect.stringMatching(/could not read #7's labels/) })]);
    expect(writes(repo.calls)).toEqual([]);
  });

  it('counts a closing issue it cannot read as held', () => {
    const repo = fakeRepo([member()], { issues: { 40: 'unreadable' } });
    expect(run({ ...io, apply: true, gh: repo.gh }).reasked).toEqual([]);
    expect(writes(repo.calls)).toEqual([]);
  });

  it('still re-asks a pull request whose project is not held', () => {
    const repo = fakeRepo([member()], { issues: { 40: marked, 7: { labels: ['project'] } } });
    expect(run({ ...io, apply: true, gh: repo.gh }).reasked).toEqual([1]);
  });
});

// ── kanon#1213: a head the review lane declines by design is not a dropped review ───────────

/** The line the review filter's `decide` prints, as a job log carries it. */
const line = (review: boolean, reason: string, sha = HEAD) =>
  `2026-10-21T02:10:00.0000000Z → review=${review} (${reason}) pr=[1] head=[${sha}]`;
const SKIP = 'the head commit carries the skip marker, on its subject line or alone on a line of its own';
const DOCS = 'only docs changed since bbbbbbb, on a code PR';

describe('filterDecision and declinedByDesign (kanon#1213)', () => {
  it("reads the filter's decision for the head, the last one it printed", () => {
    const log = ['  PR: [1]', line(true, 'code changed since bbbbbbb'), line(false, SKIP)].join('\n');
    expect(filterDecision(log, HEAD)).toEqual({ review: false, reason: SKIP });
    expect(filterDecision(log, OLD), 'a decision on another head is not this one').toBeNull();
    expect(filterDecision('no decision here', HEAD)).toBeNull();
  });

  it('declines by design only on the skip marker and on a docs-only push to a code PR', () => {
    expect(declinedByDesign({ review: false, reason: SKIP })?.arm).toBe('skip-marker');
    expect(declinedByDesign({ review: false, reason: DOCS })?.arm).toBe('docs-only');
    for (const reason of [
      'CI still running (ci) — its completion fires the review', `already reviewed ${HEAD.slice(0, 7)}`,
      'PR #1 carries no review label', `${SKIP} too`,
    ]) expect(declinedByDesign({ review: false, reason }), reason).toBeNull();
    expect(declinedByDesign({ review: true, reason: SKIP }), 'a review is never a decline').toBeNull();
    expect(declinedByDesign(null)).toBeNull();
  });
});

describe('reaskPlan on a head the lane declines by design (kanon#1213)', () => {
  const withDecision = (decision: { review: boolean; reason: string } | null) =>
    reaskPlan([pr(1)], { ciSettled: () => true, runsFor: () => [done(7, 'success')], decisionFor: () => (decision ? { ...decision, run: 7 } : null), now: NOW, hours: 4 });

  it('holds a head whose filter declined it by the skip marker or as docs-only, and says which', () => {
    expect(withDecision({ review: false, reason: SKIP })).toMatchObject({ reask: [], held: [{ number: 1, why: expect.stringMatching(/declines this head by design: its head commit carries `\[skip-review\]` \(Review run 7/) }] });
    expect(withDecision({ review: false, reason: DOCS })).toMatchObject({ reask: [], held: [{ number: 1, why: expect.stringMatching(/by design: only docs changed/) }] });
  });

  it('still re-asks a CI deferral, a decision to review, and a head with no decision found (#1156)', () => {
    expect(withDecision({ review: false, reason: 'CI still running (ci) — its completion fires the review' }).reask).toEqual([{ number: 1, sha: HEAD }]);
    expect(withDecision({ review: true, reason: 'code changed since bbbbbbb' }).reask).toEqual([{ number: 1, sha: HEAD }]);
    expect(withDecision(null).reask).toEqual([{ number: 1, sha: HEAD }]);
  });
});

describe('filterDecisionFor (kanon#1213)', () => {
  const at = (id: number, createdAt: string, conclusion = 'success') => ({ id, status: 'completed', conclusion, createdAt });
  const repoWith = (logs: Record<number, string>, names: Record<number, string> = {}) => {
    const calls: string[] = [];
    const gh = (args: string[]) => {
      const path = args[1]!;
      calls.push(path);
      const jobs = /runs\/(\d+)\/jobs/.exec(path);
      if (jobs) return JSON.stringify({ jobs: [{ id: 1, name: 'review / review' }, { id: Number(jobs[1]) * 10, name: names[Number(jobs[1])] ?? 'review / filter' }] });
      const log = /jobs\/(\d+)\/logs/.exec(path);
      if (log && logs[Number(log[1]) / 10] !== undefined) return logs[Number(log[1]) / 10]!;
      throw new Error(`HTTP 404 ${path}`);
    };
    return { gh, calls };
  };

  it("takes the newest finished run's decision, from its filter job, and names the run", () => {
    const r = repoWith({ 1: line(false, SKIP), 2: line(true, 'code changed since bbbbbbb') });
    const runs = [at(1, '2026-10-21T02:05:00Z'), at(2, '2026-10-21T03:05:00Z')];
    expect(filterDecisionFor(HEAD, runs, { repo: 'o/r', gh: r.gh })).toEqual({ review: true, reason: 'code changed since bbbbbbb', run: 2 });
    expect(r.calls).toContain('repos/o/r/actions/jobs/20/logs');
    expect(r.calls).not.toContain('repos/o/r/actions/jobs/1/logs');
  });

  it('passes over a run whose filter printed no decision, and a skipped run, to an older decision', () => {
    const r = repoWith({ 1: line(false, SKIP), 2: 'the membership gate failed', 3: line(true, 'x') });
    const runs = [at(1, '2026-10-21T02:05:00Z'), at(2, '2026-10-21T03:05:00Z', 'failure'), at(3, '2026-10-21T04:05:00Z', 'skipped')];
    expect(filterDecisionFor(HEAD, runs, { repo: 'o/r', gh: r.gh })).toEqual({ review: false, reason: SKIP, run: 1 });
  });

  it("reads the lane's own filter job, called or not, and no other job", () => {
    expect(filterDecisionFor(HEAD, [at(1, 'x')], { repo: 'o/r', gh: repoWith({ 1: line(false, SKIP) }, { 1: 'filter' }).gh })?.run).toBe(1);
    expect(filterDecisionFor(HEAD, [at(1, 'x')], { repo: 'o/r', gh: repoWith({ 1: line(false, SKIP) }, { 1: 'review / prefilter' }).gh })).toBeNull();
  });

  it('reads at most DECISION_RUNS_READ runs', () => {
    const r = repoWith({});
    const runs = Array.from({ length: DECISION_RUNS_READ + 5 }, (_, i) => at(i + 1, `2026-10-21T02:${String(i).padStart(2, '0')}:00Z`));
    filterDecisionFor(HEAD, runs, { repo: 'o/r', gh: (a) => { try { return r.gh(a); } catch { return ''; } } });
    expect(r.calls.filter((c) => c.endsWith('/jobs?per_page=100'))).toHaveLength(DECISION_RUNS_READ);
  });

  it('reads an unreadable log as no decision, so the head is re-asked', () => {
    expect(filterDecisionFor(HEAD, [at(1, 'x')], { repo: 'o/r', gh: () => { throw new Error('HTTP 502'); } })).toBeNull();
  });
});

describe('run on a head the lane declines by design (kanon#1213)', () => {
  it('posts nothing and churns no label, and the summary says why', () => {
    const repo = fakeRepo([pr(1)], { logs: { 5: line(false, SKIP) } });
    let text = '';
    const out = run({ repo: 'o/r', now: NOW, runsFor: () => [{ id: 5, status: 'completed', conclusion: 'success' }], apply: true, gh: repo.gh, summary: (t) => { text += t; } });
    expect(out.reasked).toEqual([]);
    expect(writes(repo.calls)).toEqual([]);
    expect(text).toMatch(/#1 `aaaaaaa`: not re-asked, the review lane declines this head by design/);
  });

  it('still re-asks when the run\'s filter declined only to wait for CI', () => {
    const repo = fakeRepo([pr(1)], { logs: { 5: line(false, 'CI still running (ci) — its completion fires the review') } });
    const out = run({ repo: 'o/r', now: NOW, runsFor: () => [{ id: 5, status: 'completed', conclusion: 'success' }], apply: true, gh: repo.gh });
    expect(out.reasked).toEqual([1]);
  });
});

describe('the dispatch sweep runs the re-ask (kanon#1197)', () => {
  type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> };
  const lane = parse(readFileSync('.github/workflows/agent-dispatch-sweep.yml', 'utf8')) as { jobs: { sweep: { steps: Step[] } } };
  const steps = lane.jobs.sweep.steps;
  const step = steps.find((s) => s.run === 'node "$KANON/scripts/review-reask.mjs"');

  it('in the sweep job, on the Lead token, applying only where the sweep applies', () => {
    expect(step).toBeDefined();
    const sweep = steps.find((s) => s.run === 'node "$KANON/scripts/dispatch-sweep.mjs"')!;
    expect(step!.env?.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(step!.env?.APPLY).toBe(sweep.env?.APPLY);
    expect(step!.if).toBe("${{ !cancelled() && steps.app-token.outcome == 'success' }}");
  });

  it('needs no new grant on the sweep token', () => {
    const mint = steps.find((s) => s.name === 'Mint lead App token') as Step & { with?: Record<string, string> };
    expect(Object.entries(mint.with ?? {}).filter(([k]) => k.startsWith('permission-'))).toEqual([
      ['permission-issues', 'write'], ['permission-pull-requests', 'read'], ['permission-actions', 'read'],
    ]);
  });
});
