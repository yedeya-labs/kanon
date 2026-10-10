import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  FEED_MARKER, feedComment, feedMilestones, feedValve, handledBefore, ineligibility, renderFeedSummary, run, selectFeed,
} from '../../scripts/backlog-feed.mjs';
import { AGENT_LOGIN, SWEEP_LOGIN } from '../../scripts/dispatch-sweep.mjs';
import { parkedRead } from '../../scripts/lead-reconcile.mjs';

/**
 * kanon#609: the backlog feeder. A step of the dispatch sweep that labels up to
 * `QA_BACKLOG_FEED` eligible reviewer follow-ups a day with `agent:implement`, only into an
 * implementer slot nothing else is using, and never while an issue it fed is still in flight.
 */
const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const BACKLOG = { title: 'Product Backlog', due_on: null, state: 'open' };
const GATE = { title: 'Product Backlog', due_on: '2026-12-31T00:00:00Z', state: 'open' };
const OTHER = { title: 'Development Automation', due_on: null, state: 'open' };
type Item = {
  number: number; title?: string; state?: string; pull_request?: unknown; body?: string | null;
  labels: { name: string }[]; milestone?: typeof BACKLOG | null; created_at?: string;
};
const followUp = (number: number, sev: string, created: string, extra: Partial<Item> & { more?: string[] } = {}): Item => {
  const { more = [], ...rest } = extra;
  return {
    number, title: `follow-up ${number}`, state: 'open', body: 'Surfaced by PR #1.',
    labels: ['follow-up', 'agent:reviewer', sev, ...more].map((name) => ({ name })),
    milestone: BACKLOG, created_at: created, ...rest,
  };
};
const MILESTONES = ['Product Backlog'];
const noComments = () => [];
const select = (o: Partial<Parameters<typeof selectFeed>[0]> = {}) => selectFeed({
  valve: 1, globalWip: 3, slots: [], issues: [], milestones: MILESTONES, commentsOf: noComments, ...o,
});

describe('feedValve and feedMilestones', () => {
  it('reads QA_BACKLOG_FEED as a count, unset or 0 as closed, anything else as closed and said', () => {
    expect(feedValve(undefined)).toEqual({ n: 0, note: null });
    expect(feedValve('')).toEqual({ n: 0, note: null });
    expect(feedValve('0')).toEqual({ n: 0, note: null });
    expect(feedValve('2')).toEqual({ n: 2, note: null });
    for (const bad of ['-1', '1.5', 'yes', 'NaN']) {
      const v = feedValve(bad);
      expect(v.n, bad).toBe(0);
      expect(v.note, bad).toContain(`\`${bad}\``);
    }
  });

  it('reads QA_BACKLOG_MILESTONES as comma-separated titles, defaulting to Product Backlog', () => {
    expect(feedMilestones(undefined)).toEqual(['Product Backlog']);
    expect(feedMilestones('  ')).toEqual(['Product Backlog']);
    expect(feedMilestones('Product Backlog, Tech Debt ,')).toEqual(['Product Backlog', 'Tech Debt']);
  });
});

describe('ineligibility', () => {
  const ok = followUp(1, 'sev:low', '2026-09-01T00:00:00Z');
  it('accepts an open reviewer follow-up on a fed bucket milestone', () => {
    expect(ineligibility(ok, { milestones: MILESTONES })).toBeNull();
  });

  it('refuses each excluded label, a gate severity and a missing severity', () => {
    for (const l of ['agent:implement', 'qa:needs-info', 'qa:human-action', 'qa:needs-split', 'blocked', 'qa:needs-triage', 'qa:verify', 'gate-candidate']) {
      expect(ineligibility(followUp(2, 'sev:low', '2026-09-01T00:00:00Z', { more: [l] }), { milestones: MILESTONES }), l).toContain(l);
    }
    expect(ineligibility(followUp(3, 'sev:high', '2026-09-01T00:00:00Z'), { milestones: MILESTONES })).toContain('sev:high');
    expect(ineligibility(followUp(4, 'sev:critical', '2026-09-01T00:00:00Z'), { milestones: MILESTONES })).toContain('sev:critical');
    // The most severe label decides, so a stray `sev:low` beside `sev:high` does not admit it.
    expect(ineligibility(followUp(5, 'sev:low', '2026-09-01T00:00:00Z', { more: ['sev:high'] }), { milestones: MILESTONES })).toContain('sev:high');
    expect(ineligibility(followUp(6, 'qa:needs-severity', '2026-09-01T00:00:00Z'), { milestones: MILESTONES })).toContain('severity');
    // Labels match case-insensitively, as GitHub's do.
    expect(ineligibility(followUp(7, 'sev:low', '2026-09-01T00:00:00Z', { more: ['Blocked'] }), { milestones: MILESTONES })).toContain('blocked');
  });

  it('refuses an issue that is not a reviewer follow-up', () => {
    const bug = { ...ok, labels: [{ name: 'follow-up' }, { name: 'sev:low' }] };
    expect(ineligibility(bug, { milestones: MILESTONES })).toContain('reviewer follow-up');
  });

  it('never selects a project member, by its body marker or its mirrored label', () => {
    expect(ineligibility({ ...ok, body: 'Surfaced by PR #1.\n\n<!-- qa:project 42 -->' }, { milestones: MILESTONES })).toContain('project');
    expect(ineligibility(followUp(8, 'sev:low', '2026-09-01T00:00:00Z', { more: ['project:42'] }), { milestones: MILESTONES })).toContain('project');
  });

  it('feeds only from the named milestones, and only from a bucket among them', () => {
    expect(ineligibility({ ...ok, milestone: null }, { milestones: MILESTONES })).toContain('milestone');
    expect(ineligibility({ ...ok, milestone: OTHER }, { milestones: MILESTONES })).toContain('Development Automation');
    expect(ineligibility({ ...ok, milestone: OTHER }, { milestones: ['Product Backlog', 'Development Automation'] })).toBeNull();
    expect(ineligibility({ ...ok, milestone: GATE }, { milestones: MILESTONES })).toContain('roadmap');
  });

  it('refuses a pull request and a closed issue', () => {
    expect(ineligibility({ ...ok, pull_request: {} }, { milestones: MILESTONES })).not.toBeNull();
    expect(ineligibility({ ...ok, state: 'closed' }, { milestones: MILESTONES })).not.toBeNull();
  });
});

describe('handledBefore', () => {
  it('reads the feeder\'s marker, and any Implementer post, whoever dispatched it', () => {
    expect(handledBefore([])).toBeNull();
    expect(handledBefore([{ body: 'a person writes' }])).toBeNull();
    expect(handledBefore([{ body: `**Lead** <!-- kanon:role=lead -->\n\n${FEED_MARKER}\nFed.` }])).toBe('fed');
    expect(handledBefore([{ body: '**Implementer** <!-- kanon:role=implementer -->\n\nStopping: this needs a vendor portal.' }])).toBe('implementer');
  });
});

describe('selectFeed', () => {
  const low = followUp(10, 'sev:low', '2026-08-01T00:00:00Z');
  const medium = followUp(20, 'sev:medium', '2026-10-01T00:00:00Z');
  const lowNewer = followUp(30, 'sev:low', '2026-09-01T00:00:00Z');

  it('feeds sev:medium before an older sev:low, then oldest first', () => {
    const plan = select({ valve: 3, issues: [lowNewer, low, medium] });
    expect(plan.chosen.map((c) => c.number)).toEqual([20, 10, 30]);
    expect(plan.why).toBe('fed');
    expect(plan.chosen[0]!.reason).toContain('sev:medium');
  });

  it('takes no more than the valve allows', () => {
    expect(select({ valve: 1, issues: [lowNewer, low, medium] }).chosen.map((c) => c.number)).toEqual([20]);
  });

  it('does nothing when the valve is closed, and reads no comment', () => {
    let reads = 0;
    const plan = select({ valve: 0, issues: [medium], commentsOf: () => { reads += 1; return []; } });
    expect(plan).toMatchObject({ why: 'closed', chosen: [] });
    expect(reads).toBe(0);
  });

  it('does nothing when every implementer slot is in use', () => {
    const slots = [1, 2, 3].map((number) => ({ number, occupies: true, fed: false }));
    const plan = select({ slots, issues: [medium] });
    expect(plan).toMatchObject({ why: 'full', chosen: [] });
    // Mutation: one of them parked on a human frees its slot.
    expect(select({ slots: [...slots.slice(0, 2), { number: 3, occupies: false, fed: false }], issues: [medium] }).chosen.map((c) => c.number)).toEqual([20]);
  });

  it('only uses the slots left free: two free of three, a valve of 5, feeds two', () => {
    const plan = select({ valve: 5, slots: [{ number: 1, occupies: true, fed: false }], issues: [lowNewer, low, medium] });
    expect(plan.chosen.map((c) => c.number)).toEqual([20, 10]);
  });

  it('does nothing while an issue it fed is still in flight', () => {
    const plan = select({ slots: [{ number: 99, occupies: true, fed: true }], issues: [medium] });
    expect(plan).toMatchObject({ why: 'fed-in-flight', chosen: [], fedInFlight: [99] });
  });

  it('a fed issue that bailed and is parked on a human does not hold the feeder (the adopter\'s first-bail bug)', () => {
    const plan = select({ slots: [{ number: 99, occupies: false, fed: true }], issues: [medium] });
    expect(plan.chosen.map((c) => c.number)).toEqual([20]);
  });

  it('never selects a project member', () => {
    const member = followUp(5, 'sev:medium', '2026-01-01T00:00:00Z', { body: 'x\n<!-- qa:project 7 -->' });
    const plan = select({ valve: 2, issues: [member, low] });
    expect(plan.chosen.map((c) => c.number)).toEqual([10]);
  });

  it('never re-feeds an issue carrying its marker, or one the Implementer already ran on', () => {
    const comments: Record<number, { body: string }[]> = {
      20: [{ body: `${FEED_MARKER}` }],
      10: [{ body: '**Implementer** <!-- kanon:role=implementer -->\n\nStopping.' }],
    };
    const plan = select({ valve: 3, issues: [lowNewer, low, medium], commentsOf: (n: number) => comments[n] ?? [] });
    expect(plan.chosen.map((c) => c.number)).toEqual([30]);
    expect(plan.skipped).toEqual([{ number: 20, why: 'fed' }, { number: 10, why: 'implementer' }]);
  });

  it('skips a candidate whose comments cannot be read, failing closed', () => {
    const plan = select({ issues: [medium, low], commentsOf: (n: number) => { if (n === 20) throw new Error('HTTP 502'); return []; } });
    expect(plan.chosen.map((c) => c.number)).toEqual([10]);
    expect(plan.skipped[0]).toMatchObject({ number: 20, why: 'unreadable' });
  });

  it('says why nothing was fed when nothing is eligible, or everything was handled', () => {
    expect(select({ issues: [] }).why).toBe('none-eligible');
    expect(select({ issues: [medium], commentsOf: () => [{ body: FEED_MARKER }] }).why).toBe('all-handled');
  });
});

describe('renderFeedSummary', () => {
  const medium = followUp(20, 'sev:medium', '2026-10-01T00:00:00Z');

  it('says the valve is closed, and how to open it', () => {
    const text = renderFeedSummary(select({ valve: 0 }), { apply: true });
    expect(text).toContain('valve is closed');
    expect(text).toContain('QA_BACKLOG_FEED');
  });

  it('names the slots in use, the candidates, and the one chosen and why', () => {
    const plan = select({ slots: [{ number: 4, occupies: true, fed: false }, { number: 5, occupies: false, fed: false }], issues: [medium] });
    const dry = renderFeedSummary(plan, { apply: false });
    expect(dry).toContain('1 of 3');
    expect(dry).toContain('#4');
    expect(dry).toContain('1 eligible');
    expect(dry).toContain('#20');
    expect(dry).toContain('dry run');
    expect(renderFeedSummary(plan, { apply: true, fed: [20] })).toContain('#20: fed');
  });

  it('never renders a silent no-op: every reason has its sentence', () => {
    for (const plan of [
      select({ slots: [1, 2, 3].map((number) => ({ number, occupies: true, fed: false })), issues: [medium] }),
      select({ slots: [{ number: 9, occupies: true, fed: true }], issues: [medium] }),
      select({ issues: [] }),
      select({ issues: [medium], commentsOf: () => [{ body: FEED_MARKER }] }),
    ]) {
      expect(renderFeedSummary(plan, { apply: true })).toMatch(/Nothing fed: \S/);
    }
  });
});

describe('feedComment', () => {
  it('is the Lead\'s, carries the marker, the tick and the reason', () => {
    const body = feedComment({ number: 20, title: 't', severity: 'sev:medium', reason: '`sev:medium`, the first of 1 eligible' }, { tick: 'https://github.com/o/r/actions/runs/7' });
    expect(body.split('\n')[0]).toContain('<!-- kanon:role=lead -->');
    expect(body).toContain(FEED_MARKER);
    expect(body).toContain('https://github.com/o/r/actions/runs/7');
    expect(body).toContain('the first of 1 eligible');
  });
});

describe('parkedRead (shared with the reconciler)', () => {
  it('reads an agent:implement issue with no PR and a stale agent stop as parked, one with a PR as not', () => {
    const lane = () => ({ state: 'awaiting-human', lastAt: '2026-10-01T00:00:00Z' });
    expect(parkedRead(1, { labels: ['agent:implement'], state: 'OPEN' }, { prs: () => ({ prs: [], ok: true }), lane }).parkedOnHuman).toBe(true);
    expect(parkedRead(1, { labels: ['agent:implement'], state: 'OPEN' }, { prs: () => ({ prs: [{}], ok: true }), lane }).parkedOnHuman).toBe(false);
    // An unreadable PR list keeps the slot (fail closed).
    expect(parkedRead(1, { labels: ['agent:implement'], state: 'OPEN' }, { prs: () => ({ prs: [], ok: false }), lane }).parkedOnHuman).toBe(false);
  });
});

describe('run', () => {
  type Fake = { implement?: Item[]; followUps?: Item[]; comments?: Record<number, { body: string; login?: string; at?: string }[]>; prs?: Record<number, number[]>; failLabel?: boolean; listFails?: boolean };
  const fake = (f: Fake = {}) => {
    const calls: string[][] = [];
    const gh = (args: string[]): string => {
      calls.push(args);
      const a = args.join(' ');
      if (args[0] === 'api' && /issues\?state=open&labels=agent%3Aimplement/.test(a)) {
        if (f.listFails) throw new Error('HTTP 502');
        return JSON.stringify(f.implement ?? []);
      }
      if (args[0] === 'api' && /issues\?state=open&labels=follow-up%2Cagent%3Areviewer/.test(a)) return JSON.stringify(f.followUps ?? []);
      if (args[0] === 'api' && args.includes('POST') && /\/labels$/.test(args[3] ?? '')) {
        if (f.failLabel) throw new Error('HTTP 403');
        return '[]';
      }
      if (args[0] === 'api' && args.includes('POST') && /\/comments$/.test(args[3] ?? '')) return '{}';
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({ closedByPullRequestsReferences: (f.prs?.[Number(args[2])] ?? []).map((number) => ({ number })) });
      }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: Number(args[2]), state: 'OPEN', headRefOid: 'a', reviews: [], commits: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('comments')) {
        const n = Number(args[2]);
        return JSON.stringify({ comments: (f.comments?.[n] ?? []).map((c) => ({ author: { login: c.login ?? 'someone' }, createdAt: c.at ?? '2026-01-01T00:00:00Z', body: c.body })) });
      }
      throw new Error(`unexpected gh ${a}`);
    };
    const writes = () => calls.filter((c) => c.includes('POST'));
    return { gh, calls, writes };
  };
  const env = (feed: string) => ({ QA_BACKLOG_FEED: feed, QA_BACKLOG_MILESTONES: '' });
  const medium = followUp(20, 'sev:medium', '2026-10-01T00:00:00Z');

  it('with the valve closed, reads nothing, writes nothing, and says the valve is closed', () => {
    const f = fake({ followUps: [medium] });
    let text = '';
    const r = run({ repo: 'o/r', apply: true, gh: f.gh, env: env('0'), summary: (t: string) => { text = t; } });
    expect(f.calls).toEqual([]);
    expect(r.plan?.why).toBe('closed');
    expect(text).toContain('valve is closed');
  });

  it('with apply, labels the chosen issue agent:implement and posts the marker, and nothing else', () => {
    const f = fake({ followUps: [medium] });
    const r = run({ repo: 'o/r', apply: true, gh: f.gh, env: env('1'), summary: () => {}, tick: 'https://x/runs/1' });
    expect(r.fed).toEqual([20]);
    const w = f.writes();
    expect(w).toHaveLength(2);
    expect(w[0]!.join(' ')).toContain('repos/o/r/issues/20/labels');
    expect(w[0]!.join(' ')).toContain('labels[]=agent:implement');
    expect(w[1]!.join(' ')).toContain('repos/o/r/issues/20/comments');
    expect(w[1]!.join(' ')).toContain(FEED_MARKER);
  });

  it('without apply, writes nothing (a manual dispatch is a dry run)', () => {
    const f = fake({ followUps: [medium] });
    const r = run({ repo: 'o/r', apply: false, gh: f.gh, env: env('1'), summary: () => {} });
    expect(r.plan?.chosen.map((c) => c.number)).toEqual([20]);
    expect(f.writes()).toEqual([]);
  });

  it('counts a fed issue with an open PR as in flight, and feeds nothing', () => {
    const fedIssue = { ...followUp(99, 'sev:low', '2026-09-01T00:00:00Z', { more: ['agent:implement'] }) };
    const f = fake({ implement: [fedIssue], followUps: [medium, fedIssue], comments: { 99: [{ body: FEED_MARKER }] }, prs: { 99: [500] } });
    const r = run({ repo: 'o/r', apply: true, gh: f.gh, env: env('1'), summary: () => {} });
    expect(r.plan?.why).toBe('fed-in-flight');
    expect(f.writes()).toEqual([]);
  });

  it('a fed issue whose Implementer stopped and went quiet is parked, so it frees the feeder (the first-bail bug)', () => {
    const fedIssue = followUp(99, 'sev:low', '2026-09-01T00:00:00Z', { more: ['agent:implement'] });
    const thread = [
      { login: SWEEP_LOGIN, body: feedComment({ number: 99, title: 't', severity: 'sev:low', reason: 'r' }), at: '2026-01-01T00:00:00Z' },
      { login: AGENT_LOGIN, body: '**Implementer** <!-- kanon:role=implementer -->\n\nStopping: the acceptance needs a vendor portal.', at: '2026-01-02T00:00:00Z' },
    ];
    const f = fake({ implement: [fedIssue], followUps: [medium, fedIssue], comments: { 99: thread } });
    const r = run({ repo: 'o/r', apply: false, gh: f.gh, env: env('1'), summary: () => {} });
    expect(r.plan?.inUse).toEqual([]);
    expect(r.plan?.chosen.map((c) => c.number)).toEqual([20]);
    // Mutation: the stop is fresh (inside the sweep's 48 hours), so the run may still be going,
    // and the fed issue holds its slot.
    const fresh = [thread[0]!, { ...thread[1]!, at: new Date().toISOString() }];
    const g = fake({ implement: [fedIssue], followUps: [medium, fedIssue], comments: { 99: fresh } });
    expect(run({ repo: 'o/r', apply: false, gh: g.gh, env: env('1'), summary: () => {} }).plan?.why).toBe('fed-in-flight');
  });

  it('an unreadable slot list feeds nothing and never throws', () => {
    const f = fake({ followUps: [medium], listFails: true });
    let text = '';
    expect(() => run({ repo: 'o/r', apply: true, gh: f.gh, env: env('1'), summary: (t: string) => { text = t; } })).not.toThrow();
    expect(f.writes()).toEqual([]);
    expect(text).toContain('could not');
  });

  it('a failed label write posts no marker, and says so', () => {
    const f = fake({ followUps: [medium], failLabel: true });
    let text = '';
    const r = run({ repo: 'o/r', apply: true, gh: f.gh, env: env('1'), summary: (t: string) => { text = t; } });
    expect(r.fed).toEqual([]);
    expect(f.writes().filter((c) => c.join(' ').includes('/comments'))).toEqual([]);
    expect(text).toContain('FAILED');
  });
});

describe('the dispatch sweep runs the feeder', () => {
  type Step = { name?: string; run?: string; if?: string; env?: Record<string, string> };
  const wf = parse(read('.github/workflows/agent-dispatch-sweep.yml')) as { jobs: Record<string, { steps?: Step[] }> };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
  const feed = steps.filter((s) => /scripts\/backlog-feed\.mjs/.test(s.run ?? ''));

  it('on the Lead\'s App token, behind the variable, applying on the schedule only', () => {
    expect(feed).toHaveLength(1);
    const s = feed[0]!;
    expect(s.run?.trim()).toBe('node "$KANON/scripts/backlog-feed.mjs"');
    expect(s.env?.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(s.env?.APPLY).toBe("${{ (github.event_name == 'schedule' || inputs.apply == 'true') && '1' || '' }}");
    expect(s.env?.QA_BACKLOG_FEED).toBe('${{ vars.QA_BACKLOG_FEED }}');
    expect(s.env?.QA_BACKLOG_MILESTONES).toBe('${{ vars.QA_BACKLOG_MILESTONES }}');
    expect(s.if).toContain('!cancelled()');
  });

  it('runs after the sweep, so the sweep never reads a dispatch the feeder made this tick', () => {
    const names = steps.map((s) => s.run ?? '');
    const sweep = names.findIndex((r) => r.includes('scripts/dispatch-sweep.mjs'));
    const at = names.findIndex((r) => r.includes('scripts/backlog-feed.mjs'));
    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(sweep);
  });

  it('is documented with its eligibility rule and its cost', () => {
    const doc = read('docs/lanes.md');
    expect(doc).toContain('QA_BACKLOG_FEED');
    expect(doc).toContain('QA_BACKLOG_MILESTONES');
    expect(doc).toMatch(/one implementer run/);
  });
});
