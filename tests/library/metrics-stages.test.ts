import { describe, expect, it } from 'vitest';
import {
  STAGE_FIELDS, STAGE_ORDER, dispatchedAt, partitionProblem, partitionStages, stageIntervals,
} from '../../scripts/metrics/stages.mjs';
import { roleMarker } from '../../scripts/lib/role-marker.mjs';

/**
 * Plan 0003 §3.3, group 2: every second of the lead time goes to exactly one stage, the first
 * in a fixed order where intervals overlap, so the stages sum to `lead_time_s`.
 */

const T0 = Date.parse('2026-09-10T00:00:00Z');
/** A time `s` seconds after T0. */
const t = (s: number) => new Date(T0 + s * 1000).toISOString();
const W = (end: number, start = 0) => ({ start: t(start), end: t(end) });
const sum = (r: Record<string, number>) => Object.values(STAGE_FIELDS).reduce((a, f) => a + (r[f] ?? 0), 0);

describe('partitionStages', () => {
  it('gives an empty item all to other', () => {
    expect(partitionStages(W(100), [])).toMatchObject({ lead_time_s: 100, t_other_s: 100, t_human_s: 0, human_waits: 0 });
  });

  it('lets the earlier stage win an overlap, in the plan\'s order', () => {
    expect(STAGE_ORDER).toEqual(['human', 'merge_queue', 'agent', 'review', 'ci', 'rework', 'queue', 'other']);
    const r = partitionStages(W(100), [
      { stage: 'ci', start: t(10), end: t(60) },
      { stage: 'human', start: t(40), end: t(50) },
      { stage: 'agent', start: t(0), end: t(20) },
    ]);
    // agent 0-20 beats ci 10-20; ci 20-40 and 50-60; human 40-50 beats ci; other 60-100.
    expect(r).toMatchObject({ t_agent_s: 20, t_ci_s: 30, t_human_s: 10, t_other_s: 40, lead_time_s: 100 });
    expect(sum(r)).toBe(100);
  });

  it('ranks every pair of stages by the order', () => {
    const stages = STAGE_ORDER.filter((s) => s !== 'other');
    for (const [i, hi] of stages.entries()) {
      for (const lo of stages.slice(i + 1)) {
        const r = partitionStages(W(10), [{ stage: lo, start: t(0), end: t(10) }, { stage: hi, start: t(0), end: t(10) }]);
        expect(r[STAGE_FIELDS[hi]], `${hi} over ${lo}`).toBe(10);
        expect(r[STAGE_FIELDS[lo]], `${hi} over ${lo}`).toBe(0);
      }
    }
  });

  it('clips intervals to the lead time', () => {
    const r = partitionStages(W(100, 50), [{ stage: 'agent', start: t(0), end: t(70) }, { stage: 'review', start: t(90), end: t(500) }]);
    expect(r).toMatchObject({ lead_time_s: 50, t_agent_s: 20, t_review_s: 10, t_other_s: 20 });
  });

  it('floors every time to its second, so fractions still sum exactly', () => {
    const r = partitionStages({ start: '2026-09-10T00:00:00.900Z', end: '2026-09-10T00:00:10.100Z' }, [
      { stage: 'agent', start: '2026-09-10T00:00:02.999Z', end: '2026-09-10T00:00:05.001Z' },
    ]);
    expect(r).toMatchObject({ lead_time_s: 10, t_agent_s: 3, t_other_s: 7 });
  });

  it('counts separate human waits, joining overlapping and touching ones', () => {
    const r = partitionStages(W(100), [
      { stage: 'human', start: t(0), end: t(10) },
      { stage: 'human', start: t(5), end: t(15) },
      { stage: 'human', start: t(15), end: t(20) },
      { stage: 'human', start: t(50), end: t(60) },
    ]);
    expect(r).toMatchObject({ t_human_s: 30, human_waits: 2 });
  });

  it('sums to the lead time on many random interval sets', () => {
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const stages = STAGE_ORDER.filter((s) => s !== 'other');
    for (let k = 0; k < 300; k += 1) {
      const end = 1 + rand(5000);
      const intervals = Array.from({ length: rand(12) }, () => {
        const a = rand(6000) - 500;
        return { stage: stages[rand(stages.length)], start: t(a), end: t(a + rand(2000)) };
      });
      const r = partitionStages(W(end), intervals);
      expect(sum(r)).toBe(end);
      expect(partitionProblem(r)).toBeNull();
    }
  });

  it('refuses a window that ends before it starts, an interval of no stage, and a time that is no time', () => {
    expect(() => partitionStages(W(0, 10), [])).toThrow(/ends before it starts/);
    expect(() => partitionStages(W(10), [{ stage: 'other' as never, start: t(0), end: t(1) }])).toThrow(/no stage/);
    expect(() => partitionStages(W(10), [{ stage: 'nap' as never, start: t(0), end: t(1) }])).toThrow(/no stage/);
    expect(() => partitionStages({ start: 'yesterday', end: t(1) }, [])).toThrow(/not a time/);
  });
});

describe('partitionProblem', () => {
  const full = (lead: number, parts: Partial<Record<string, number>>) => ({
    lead_time_s: lead, ...Object.fromEntries(Object.values(STAGE_FIELDS).map((f) => [f, parts[f] ?? 0])),
  });

  it('passes stages that sum to the lead time, and a row with no group 2 at all', () => {
    expect(partitionProblem(full(10, { t_agent_s: 4, t_other_s: 6 }))).toBeNull();
    expect(partitionProblem({ pr_number: 1 })).toBeNull();
  });

  it("fails stages that don't sum to the lead time (§7 mutation)", () => {
    expect(partitionProblem(full(10, { t_agent_s: 4, t_other_s: 5 }))).toMatch(/sum to 9 seconds, not the lead time's 10/);
    expect(partitionProblem(full(10, { t_agent_s: 4, t_other_s: 7 }))).toMatch(/sum to 11/);
  });

  it('fails a lead time missing a stage, and stages without a lead time', () => {
    const missing: Record<string, number> = full(10, { t_other_s: 10 });
    delete missing.t_queue_s;
    expect(partitionProblem(missing)).toMatch(/without t_queue_s/);
    expect(partitionProblem({ t_other_s: 10 })).toMatch(/without a lead time/);
  });
});

// ------------------------------------------------------------- reading the item's events

const REGISTER = new Map([['Implementer', 'acme-author'], ['Lead', 'acme-author'], ['Reviewer', 'acme-judge'], ['Merger', 'acme-judge']]);
const JUDGE = { login: 'acme-judge[bot]', type: 'Bot' };
const AUTHOR = { login: 'acme-author[bot]', type: 'Bot' };
const HUMAN = { login: 'octocat', type: 'User' };

const basePr = (over: object = {}) => ({
  number: 9, state: 'closed' as const, created_at: t(100), closed_at: t(1000), merged_at: t(1000),
  author: AUTHOR, labels: [], timeline: [], commits: [], reviews: [],
  closing_issues: [{ number: 4, labels: [], timeline: [{ event: 'labeled', label: 'agent:implement', created_at: t(0) }] }],
  ...over,
});
const input = (pr: object, over: object = {}) => ({ pr, declarations: { register: REGISTER }, tag: 'test', recorded_at: t(2000), ...over }) as never;
const review = (state: string, at: number, author = JUDGE, commit_id = 'h1') => ({ state, submitted_at: t(at), author, commit_id, body: roleMarker('Reviewer') });

describe('dispatchedAt', () => {
  it("is the first dispatch label on the first closing issue, at or before the close", () => {
    const pr = basePr({
      closing_issues: [{ number: 4, labels: [], timeline: [
        { event: 'labeled', label: 'bug', created_at: t(-50) },
        { event: 'labeled', label: 'agent:triage', created_at: t(20) },
        { event: 'labeled', label: 'agent:implement', created_at: t(10) },
        { event: 'labeled', label: 'agent:implement', created_at: t(5000) },
      ] }],
    });
    expect(dispatchedAt(pr)).toBe(t(10));
  });

  it('ignores a dispatch after the close', () => {
    expect(dispatchedAt(basePr({ closing_issues: [{ number: 4, labels: [], timeline: [{ event: 'labeled', label: 'agent:implement', created_at: t(1001) }] }] }))).toBeNull();
  });

  it('is null with no closing issue or no dispatch, and unknown when the issues or the timeline are unread', () => {
    expect(dispatchedAt(basePr({ closing_issues: [] }))).toBeNull();
    expect(dispatchedAt(basePr({ closing_issues: [{ number: 4, labels: [], timeline: [] }] }))).toBeNull();
    expect(dispatchedAt(basePr({ closing_issues: [{ number: 4, labels: [] }] }))).toBeUndefined();
    expect(dispatchedAt(basePr({ closing_issues: undefined }))).toBeUndefined();
  });
});

describe('stageIntervals', () => {
  it('opens human from needs:human to its removal, or the close', () => {
    const pr = basePr({ timeline: [
      { event: 'labeled', label: 'needs:human', created_at: t(200) },
      { event: 'unlabeled', label: 'needs:human', created_at: t(300) },
      { event: 'labeled', label: 'needs:human', created_at: t(800) },
    ] });
    expect(stageIntervals(input(pr)).filter((i) => i.stage === 'human')).toEqual([
      { stage: 'human', start: t(200), end: t(300) },
      { stage: 'human', start: t(800), end: t(1000) },
    ]);
  });

  it("opens human for an item the Merger may not merge, from approval with green checks to a human's act", () => {
    const pr = basePr({
      reviews: [review('APPROVED', 400)],
      commits: [{ sha: 'h2', message: 'x', committed_at: t(700), author: HUMAN, committer: HUMAN }],
    });
    const checks = [
      { name: 'test', head_sha: 'h1', started_at: t(350), completed_at: t(500), conclusion: 'success', required: true },
      { name: 'lint', head_sha: 'h1', started_at: t(350), completed_at: t(900), conclusion: 'success', required: false },
    ];
    const human = (over: object) => stageIntervals(input(pr, { check_runs: checks, ...over })).filter((i) => i.stage === 'human');
    expect(human({ merger_blocked: true })).toEqual([{ stage: 'human', start: t(500), end: t(700) }]);
    expect(human({ merger_blocked: false })).toEqual([]);
    // Not green: a required check failed on the approved head.
    expect(stageIntervals(input(pr, { merger_blocked: true, check_runs: [{ ...checks[0], conclusion: 'failure' }] })).filter((i) => i.stage === 'human')).toEqual([]);
  });

  it('opens merge_queue from added to removed, or the close', () => {
    const pr = basePr({ timeline: [
      { event: 'added_to_merge_queue', created_at: t(500) },
      { event: 'removed_from_merge_queue', created_at: t(550) },
      { event: 'added_to_merge_queue', created_at: t(900) },
    ] });
    expect(stageIntervals(input(pr)).filter((i) => i.stage === 'merge_queue')).toEqual([
      { stage: 'merge_queue', start: t(500), end: t(550) },
      { stage: 'merge_queue', start: t(900), end: t(1000) },
    ]);
  });

  it("opens agent for a non-Reviewer lane run, and review for the Reviewer's run up to its verdict", () => {
    const pr = basePr({ reviews: [review('CHANGES_REQUESTED', 450)] });
    const runs = [
      { lane: 'implement', started_at: t(30), completed_at: t(300) },
      { lane: 'review', started_at: t(400), completed_at: t(470) },
      { lane: 'review', started_at: t(600), completed_at: t(640) },
    ];
    const got = stageIntervals(input(pr, { runs }));
    expect(got.filter((i) => i.stage === 'agent')).toEqual([{ stage: 'agent', start: t(30), end: t(300) }]);
    expect(got.filter((i) => i.stage === 'review')).toEqual([
      { stage: 'review', start: t(400), end: t(450) },
      { stage: 'review', start: t(600), end: t(640) },
    ]);
    expect(got.filter((i) => i.stage === 'queue')).toEqual([{ stage: 'queue', start: t(0), end: t(30) }]);
    expect(() => stageIntervals(input(pr, { runs: [{ lane: 'nap', started_at: t(1), completed_at: t(2) }] }))).toThrow(/no lane/);
  });

  it("opens review from review:please to the Reviewer's next verdict, ignoring a human's", () => {
    const pr = basePr({
      timeline: [{ event: 'labeled', label: 'review:please', created_at: t(300) }],
      reviews: [review('APPROVED', 350, HUMAN), review('APPROVED', 420)],
    });
    expect(stageIntervals(input(pr)).filter((i) => i.stage === 'review')).toEqual([{ stage: 'review', start: t(300), end: t(420) }]);
  });

  it('opens ci per head, from its first check to its last required check', () => {
    const checks = [
      { name: 'a', head_sha: 'h1', started_at: t(200), completed_at: t(260), conclusion: 'success', required: true },
      { name: 'b', head_sha: 'h1', started_at: t(190), completed_at: t(400), conclusion: 'success', required: false },
      { name: 'c', head_sha: 'h1', started_at: t(210), completed_at: t(280), conclusion: 'failure', required: true },
      { name: 'a', head_sha: 'h2', started_at: t(600), completed_at: null, conclusion: null, required: true },
    ];
    expect(stageIntervals(input(basePr(), { check_runs: checks })).filter((i) => i.stage === 'ci')).toEqual([
      { stage: 'ci', start: t(190), end: t(280) },
    ]);
  });

  it('opens rework from a change request to the next push', () => {
    const pr = basePr({
      reviews: [review('CHANGES_REQUESTED', 400), review('APPROVED', 450), review('COMMENTED', 460), review('CHANGES_REQUESTED', 800)],
      commits: [{ sha: 'h1', message: 'x', committed_at: t(300), author: AUTHOR, committer: AUTHOR }],
      timeline: [{ event: 'head_ref_force_pushed', created_at: t(500) }],
    });
    expect(stageIntervals(input(pr)).filter((i) => i.stage === 'rework')).toEqual([
      { stage: 'rework', start: t(400), end: t(500) },
      { stage: 'rework', start: t(800), end: t(1000) },
    ]);
  });

  it('opens no agent, queue or ci interval when the runs and checks were not read', () => {
    expect(stageIntervals(input(basePr())).map((i) => i.stage)).toEqual([]);
  });
});
