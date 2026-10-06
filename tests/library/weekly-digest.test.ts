/**
 * Locks the pure rendering of the weekly stakeholder digest (RA-502).
 *
 * The invariants here are editorial, not just mechanical — the digest's whole
 * value is that a co-founder can read it in ten seconds and learn whether the
 * week moved the launch gate. Most of these tests exist to stop a future change
 * from quietly reintroducing something the design ruled out: environment
 * vocabulary, a to-do-shaped open count, a raw commit scope, or a celebration
 * that fires every week.
 */
import { describe, expect, it } from 'vitest';
import {
  areaLabel,
  buildMessage,
  dropRef,
  formatWeek,
  groupByArea,
  internalPhrases,
  renderCompletions,
  renderDelivered,
  renderProgress,
  renderStats,
  weekWindow,
  completedInWindow,
  assertCountsSane,
  assertMilestoneSearchSane,
  assertGuardRan,
  pickCrossCheckMilestone,
  crossCheckFallback,
  restPopulated,
  sanitiseNarrative,
  collectMilestones,
  closedCountsByMilestone,
  gateCandidatesFrom,
  readGateCandidates,
  renderGateCandidates,
  severityOf,
  shortReason,
  GATE_CANDIDATE_QUERY,
} from '../../scripts/weekly-digest.mjs';

const bullet = (scope: string, prose: string) => `**${scope}:** ${prose}`;

describe('weekWindow', () => {
  // The bug this pins: bare dates in a search qualifier cover WHOLE UTC DAYS
  // inclusive at both ends, so the Monday 08:00 run measured eight days for the
  // counts and seven for Delivered — the boundary day landing in two consecutive
  // digests and inflating the headline flow by ~19% on real data.
  const MON_0800 = new Date('2026-08-03T08:00:00Z');

  it('spans exactly seven days', () => {
    const { weekStart, weekEnd } = weekWindow(MON_0800);
    expect(weekEnd.getTime() - weekStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(weekStart.toISOString()).toBe('2026-07-27T08:00:00.000Z');
  });

  it('emits full ISO timestamps, never bare dates', () => {
    const { qualifier } = weekWindow(MON_0800);
    expect(qualifier).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\.\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(qualifier).toBe('2026-07-27T08:00:00Z..2026-08-03T07:59:59Z');
  });

  it('stops one second short of weekEnd, because `a..b` is inclusive at both ends', () => {
    const { qualifier } = weekWindow(MON_0800);
    const [, end] = qualifier.split('..');
    expect(new Date(end).getTime()).toBe(MON_0800.getTime() - 1000);
  });

  it('partitions adjacent weeks — no instant belongs to two digests', () => {
    const thisWeek = weekWindow(MON_0800);
    const lastWeek = weekWindow(new Date(MON_0800.getTime() - 7 * 24 * 60 * 60 * 1000));
    const [, lastEnd] = lastWeek.qualifier.split('..');
    const [thisStart] = thisWeek.qualifier.split('..');
    // Last week ends strictly before this week starts, with no gap beyond the 1s.
    expect(new Date(lastEnd).getTime()).toBeLessThan(new Date(thisStart).getTime());
    expect(new Date(thisStart).getTime() - new Date(lastEnd).getTime()).toBe(1000);
  });

  it('never uses repeated qualifiers, which GitHub silently drops', () => {
    // `merged:>=a merged:<b` returns the UNFILTERED total (377 rather than 42
    // against this repo) — it fails open, reporting all history as one week.
    const { qualifier } = weekWindow(MON_0800);
    expect(qualifier).not.toMatch(/[<>]=?/);
    expect(qualifier.split('..')).toHaveLength(2);
  });
});

describe('completedInWindow', () => {
  const start = new Date('2026-07-27T08:00:00Z');
  const end = new Date('2026-08-03T08:00:00Z');
  const ms = (state: string, closed_at: string | null) => ({ state, closed_at });

  it('is true for a milestone closed inside the window', () => {
    expect(completedInWindow(ms('closed', '2026-07-30T12:00:00Z'), start, end)).toBe(true);
  });

  it('includes the start instant and EXCLUDES the end instant', () => {
    // Half-open, matching the search qualifier and the release filter. With `<=`
    // a milestone closed exactly at weekEnd was celebrated in two consecutive
    // digests — the double-count the window fix removed everywhere else.
    expect(completedInWindow(ms('closed', '2026-07-27T08:00:00Z'), start, end)).toBe(true);
    expect(completedInWindow(ms('closed', '2026-08-03T08:00:00Z'), start, end)).toBe(false);
  });

  it('is picked up by the NEXT window instead, so the celebration still fires exactly once', () => {
    const nextEnd = new Date('2026-08-10T08:00:00Z');
    expect(completedInWindow(ms('closed', '2026-08-03T08:00:00Z'), end, nextEnd)).toBe(true);
  });

  it('is false for a milestone that is still open, however complete its issues are', () => {
    expect(completedInWindow(ms('open', null), start, end)).toBe(false);
    expect(completedInWindow(ms('open', '2026-07-30T12:00:00Z'), start, end)).toBe(false);
  });

  it('is false for one closed in an earlier week', () => {
    expect(completedInWindow(ms('closed', '2026-07-01T12:00:00Z'), start, end)).toBe(false);
  });
});

describe('assertCountsSane', () => {
  // The guard exists because the first live run posted "0 PRs merged · 25
  // releases" — the workflow was missing `pull-requests: read`, and the search
  // API returns an EMPTY SET rather than a 403, so nothing errored anywhere.
  it('throws when there are releases but no merged PRs — every release packages a merge', () => {
    expect(() => assertCountsSane({ prsMerged: 0, releases: 25 })).toThrow(/pull-requests: read/);
  });

  it('names the count in the error so the cause is readable from the run log', () => {
    expect(() => assertCountsSane({ prsMerged: 0, releases: 25 })).toThrow(/25 releases but 0 merged PRs/);
  });

  it('permits a genuinely quiet week — all zeroes is possible, and must not fail', () => {
    expect(() => assertCountsSane({ prsMerged: 0, releases: 0 })).not.toThrow();
  });

  it('permits merges whose release lands the other side of the window edge', () => {
    // Previously a second rule threw on `PRs > 0 && releases === 0 && issues === 0`,
    // which hard-failed a week whose only activity was a late dependabot chore.
    expect(() => assertCountsSane({ prsMerged: 3, releases: 0 })).not.toThrow();
    expect(() => assertCountsSane({ prsMerged: 1, releases: 0 })).not.toThrow();
  });

  it('permits a normal week', () => {
    expect(() => assertCountsSane({ prsMerged: 42, releases: 20 })).not.toThrow();
  });
});

describe('assertMilestoneSearchSane', () => {
  // Guards the HEADLINE. If the issue search fails open, every milestone drops
  // out as empty and the post ships with NO Progress section — the burndown
  // gone, presenting as a missing section rather than a wrong number.
  const rest = (open: number, closed: number) => ({ title: 'Production Ready', open_issues: open, closed_issues: closed });

  it('throws when REST says the milestone is populated but search returned nothing', () => {
    expect(() => assertMilestoneSearchSane(rest(12, 33), 0, 0)).toThrow(/failing open/);
  });

  it('permits a genuinely empty milestone — empty on BOTH APIs is not a failure', () => {
    // This is what a quiet week cannot imitate: the mismatch needs two
    // independent APIs to disagree, not merely a low number.
    expect(() => assertMilestoneSearchSane(rest(0, 0), 0, 0)).not.toThrow();
  });

  it('permits the normal case where both agree it is populated', () => {
    expect(() => assertMilestoneSearchSane(rest(12, 33), 11, 27)).not.toThrow();
  });

  it('permits REST and search disagreeing on the NUMBER — only zero-vs-nonzero matters', () => {
    // REST counts PRs too (AGENTS.md), so the totals legitimately differ; the
    // guard compares shapes, never magnitudes.
    expect(() => assertMilestoneSearchSane(rest(12, 33), 11, 27)).not.toThrow();
    expect(() => assertMilestoneSearchSane(rest(1, 0), 0, 1)).not.toThrow();
  });

  it('tolerates a milestone payload missing the count fields', () => {
    expect(() => assertMilestoneSearchSane({ title: 'X' }, 0, 0)).not.toThrow();
  });

  it('blames the search, not a missing `issues: read` — that would 403 the REST call first', () => {
    // On a private repo /milestones needs issues:read, so if that scope were
    // missing the REST call throws before this guard is reachable. Naming it as
    // the remedy would send the responder to the one place it cannot be.
    const msg = (() => { try { assertMilestoneSearchSane(rest(12, 33), 0, 0); } catch (e) { return (e as Error).message; } })()!;
    expect(msg).toMatch(/malformed search qualifier|degraded search index/);
    expect(msg).toMatch(/NOT a missing `issues: read`/);
  });

  // RA-724 (re-review): "the guard ran" must mean "a check that COULD have failed
  // did not fail", not "a function was called". The distinction is restTotal > 0
  // — a milestone REST says is empty passes vacuously, providing no coverage.
  it('reports an EFFECTIVE comparison when REST said the milestone is populated', () => {
    expect(assertMilestoneSearchSane(rest(12, 33), 11, 27)).toBe(true);
  });

  it('reports NO coverage for a REST-empty milestone — the pass was vacuous', () => {
    // A fresh, still-empty gate milestone satisfies this call while being
    // structurally incapable of catching a failing-open search.
    expect(assertMilestoneSearchSane(rest(0, 0), 0, 0)).toBe(false);
    expect(assertMilestoneSearchSane({ title: 'X' }, 0, 0)).toBe(false);
  });

  it('names the search that came back empty, so the run log says which query ran', () => {
    const msg = (() => {
      try { assertMilestoneSearchSane(rest(12, 33), 0, 0, 'PR-inclusive fallback'); } catch (e) { return (e as Error).message; }
    })()!;
    expect(msg).toMatch(/PR-inclusive fallback search returned none/);
  });
});

describe('restPopulated / pickCrossCheckMilestone', () => {
  const m = (title: string, open: number, closed: number) => ({ title, open_issues: open, closed_issues: closed });

  it('treats a milestone with any REST items as populated', () => {
    expect(restPopulated(m('A', 0, 1))).toBe(true);
    expect(restPopulated(m('A', 0, 0))).toBe(false);
    expect(restPopulated({ title: 'A' })).toBe(false);
  });

  it('returns null when nothing is REST-populated — there is genuinely nothing to check', () => {
    expect(pickCrossCheckMilestone([])).toBe(null);
    expect(pickCrossCheckMilestone([m('A', 0, 0), { title: 'B' }])).toBe(null);
  });

  it('picks the most populated milestone — the strongest anchor available', () => {
    expect(pickCrossCheckMilestone([m('Small', 1, 0), m('Big', 40, 120), m('Mid', 5, 5)])?.title).toBe('Big');
  });

  it('is deterministic on a tie, so two runs of the same week pick the same anchor', () => {
    expect(pickCrossCheckMilestone([m('Zebra', 3, 3), m('Alpha', 3, 3)])?.title).toBe('Alpha');
  });
});

describe('crossCheckFallback', () => {
  // RA-724: when `Production Ready` is met and removed — exactly as
  // `Development Ready` was — no milestone reaches the per-milestone search
  // branch, the issue-side guard is never invoked, and a failing-open search
  // silently deletes the Progress section.
  //
  // RA-1638 narrowed this window without closing it: classifying by `due_on`
  // means a successor gate qualifies the moment it is created rather than when
  // someone edits weekly-digest.mjs. The gap that remains is the interval with
  // NO dated milestone at all — which is exactly what these fixtures model.
  const m = (title: string, open: number, closed: number) => ({ title, open_issues: open, closed_issues: closed });
  const repo = [m('Product Backlog', 40, 300), m('Development Automation', 10, 60), m('Empty Gate', 0, 0)];

  it('spends AT MOST ONE search — §12 keeps the request count flat as milestones are added', async () => {
    const calls: string[] = [];
    await crossCheckFallback(repo, async (q: string) => { calls.push(q); return 340; });
    expect(calls).toHaveLength(1);
  });

  it('catches the failing-open search that no in-loop guard would have seen', async () => {
    await expect(crossCheckFallback(repo, async () => 0)).rejects.toThrow(/failing open/);
  });

  it('permits a genuinely quiet week — no gate and nothing closed is not a failure', async () => {
    // The property that makes this safe is unchanged: two independent APIs
    // disagreeing about ZERO vs NON-ZERO, never a comparison of magnitudes.
    await expect(crossCheckFallback(repo, async () => 340)).resolves.toBe(true);
  });

  it('cannot false-fire on an all-PRs milestone — it searches issues AND PRs, like REST counts', async () => {
    // restTotal includes pull requests (AGENTS.md). An `is:issue` fallback landing
    // on a milestone whose REST items are all PRs would throw on a correct empty
    // issue search, so the fallback query is deliberately NOT `is:issue`-scoped.
    const calls: string[] = [];
    await crossCheckFallback([m('All PRs', 0, 6)], async (q: string) => { calls.push(q); return 6; });
    expect(calls[0]).not.toContain('is:issue');
    expect(calls[0]).toContain('milestone:"All PRs"');
  });

  it('reports no coverage, and spends no search, when no milestone is REST-populated', async () => {
    const calls: string[] = [];
    const ran = await crossCheckFallback([m('Empty', 0, 0)], async (q: string) => { calls.push(q); return 0; });
    expect(ran).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('assertGuardRan', () => {
  // RA-724: "did a guard actually run?" has to mean a check that COULD have failed
  // did not fail. Counting invocations made a REST-empty gate a rubber stamp.
  it('throws when REST says a milestone is populated but nothing was effectively cross-checked', () => {
    expect(() => assertGuardRan(0, 3)).toThrow(/issue-side search guard never ran/);
  });

  it('points at the fallback and the likely cause', () => {
    expect(() => assertGuardRan(0, 3)).toThrow(/due date[\s\S]*RA-724/);
  });

  it('passes once any milestone was EFFECTIVELY cross-checked', () => {
    expect(() => assertGuardRan(1, 3)).not.toThrow();
    expect(() => assertGuardRan(4, 4)).not.toThrow();
  });

  it('permits a repo where no milestone holds anything — there was nothing to cross-check', () => {
    // Hard-failing the digest every week over an unverifiable-by-construction
    // state would be a worse failure than the silent one this closes.
    expect(() => assertGuardRan(0, 0)).not.toThrow();
  });
});

describe('collectMilestones — the classification loop (RA-1642)', () => {
  // This loop used to sit inside the `c8 ignore` I/O block, so RA-1641 changed what
  // it does with a CLOSED, DATED milestone while every test stayed green. These
  // fixtures are REST-shaped (`due_on`, `state`, `closed_at`, `open_issues`), and
  // `count` is a fake search that records what it was asked.
  const weekStart = new Date('2026-09-14T08:00:00Z');
  const weekEnd = new Date('2026-09-21T08:00:00Z');
  type RestMilestone = {
    title: string; state: string; due_on: string | null; closed_at: string | null;
    open_issues: number; closed_issues: number;
  };
  const ms = (title: string, o: Partial<RestMilestone> = {}): RestMilestone => ({
    title, state: 'open', due_on: null, closed_at: null, open_issues: 0, closed_issues: 0, ...o,
  });
  const PR = ms('Production Ready', { due_on: '2026-07-31T07:00:00Z', open_issues: 30, closed_issues: 14 });
  const AI = ms('AI Capabilities', { due_on: '2026-12-31T08:00:00Z', open_issues: 3, closed_issues: 0 });
  const DEV_READY = ms('Development Ready', {
    state: 'closed', due_on: '2026-08-31T07:00:00Z', closed_at: '2026-08-05T10:00:00Z', open_issues: 0, closed_issues: 11,
  });
  const BACKLOG = ms('Product Backlog', { open_issues: 80, closed_issues: 200 });
  const AUTOMATION = ms('Development Automation', { open_issues: 60, closed_issues: 500 });

  /** A fake search: answers `is:issue is:open|closed milestone:"T"` from a table. */
  const fakeCount = (table: Record<string, [number, number]>) => {
    const asked: string[] = [];
    const count = async (q: string) => {
      asked.push(q);
      const title = /milestone:"([^"]*)"/.exec(q)?.[1] ?? '';
      const [open, closed] = table[title] ?? [0, 0];
      if (q.includes('is:open')) return open;
      if (q.includes('is:closed')) return closed;
      return open + closed; // the PR-inclusive fallback
    };
    return { count, asked };
  };
  const run = (
    all: RestMilestone[],
    closed: Record<string, number>,
    table: Record<string, [number, number]>,
  ) => {
    const { count, asked } = fakeCount(table);
    const closedByMilestone = new Map(Object.entries(closed));
    return { asked, result: collectMilestones(all, { closedByMilestone, weekStart, weekEnd, count }) };
  };

  it('spends a search PAIR per open roadmap milestone, and nothing on a bucket', async () => {
    const { asked, result } = run(
      [PR, AI, BACKLOG, AUTOMATION],
      { 'Product Backlog': 4 },
      { 'Production Ready': [24, 14], 'AI Capabilities': [1, 0] },
    );
    const { milestones, crossChecked, searches } = await result;
    expect(searches).toBe(4);
    expect(asked.every((q) => /milestone:"(Production Ready|AI Capabilities)"/.test(q))).toBe(true);
    expect(crossChecked, 'both roadmap milestones are REST-populated, so both checks were effective').toBe(2);
    expect(milestones.map((m) => m.title)).toEqual(['Production Ready', 'AI Capabilities', 'Product Backlog']);
    expect(milestones[0]).toMatchObject({ open: 24, closed: 14, closedThisWeek: 0, completedThisWeek: false });
    expect(milestones[2], 'a bucket carries flow only, no invented denominator')
      .toMatchObject({ open: 0, closed: 0, closedThisWeek: 4 });
  });

  it('drops a bucket that did not move this week, without searching for it', async () => {
    const { asked, result } = run([PR, AUTOMATION], {}, { 'Production Ready': [24, 14] });
    const { milestones } = await result;
    expect(milestones.map((m) => m.title)).toEqual(['Production Ready']);
    expect(asked.some((q) => q.includes('Development Automation'))).toBe(false);
  });

  it('treats a met gate (closed, dated, closed weeks ago) as a bucket, not a burndown (RA-1641)', async () => {
    const { asked, result } = run([PR, DEV_READY], {}, { 'Production Ready': [24, 14], 'Development Ready': [0, 11] });
    const { milestones, searches } = await result;
    expect(milestones.map((m) => m.title), 'no permanent "11 of 11 done" line').toEqual(['Production Ready']);
    expect(searches).toBe(2);
    expect(asked.some((q) => q.includes('Development Ready'))).toBe(false);
  });

  it('still searches a milestone that COMPLETED this week, so the celebration has its total', async () => {
    const justClosed = { ...DEV_READY, closed_at: '2026-09-16T10:00:00Z' };
    const { result } = run([PR, justClosed], {}, { 'Production Ready': [24, 14], 'Development Ready': [0, 11] });
    const { milestones, searches } = await result;
    expect(searches).toBe(4);
    expect(milestones.find((m) => m.title === 'Development Ready'))
      .toMatchObject({ open: 0, closed: 11, completedThisWeek: true });
  });

  it('refuses to post when the issue search fails open, rather than dropping Progress (RA-721)', async () => {
    // Every search returns 0 — the "no 403, just an empty set" shape. Without the
    // cross-check the gate would `continue` out as empty and the post would ship with
    // no Progress section at all.
    const { result } = run([PR, BACKLOG], {}, {});
    await expect(result).rejects.toThrow(/Production Ready[\s\S]*failing open/);
  });

  it('refuses via the fallback when no roadmap milestone exists to check (RA-724)', async () => {
    const { asked, result } = run([BACKLOG, AUTOMATION], {}, {});
    await expect(result).rejects.toThrow(/PR-inclusive fallback/);
    expect(asked, 'the fallback anchors on the REST-heaviest milestone').toEqual(['milestone:"Development Automation"']);
  });

  it('counts only EFFECTIVE checks, and spends exactly one fallback search after a vacuous one', async () => {
    // A fresh, still-empty gate passes the in-loop check vacuously — it could not
    // have failed — so the fallback must still run against a populated milestone.
    const freshGate = ms('Launch', { due_on: '2027-01-31T08:00:00Z' });
    const { result } = run([freshGate, BACKLOG], {}, { 'Product Backlog': [80, 200] });
    const { crossChecked, searches, milestones } = await result;
    expect(crossChecked).toBe(1);
    expect(searches).toBe(3);
    expect(milestones).toEqual([]);
  });

  it('groups the window search by milestone title, ignoring un-milestoned items', () => {
    const byTitle = closedCountsByMilestone([
      { milestone: { title: 'A' } }, { milestone: { title: 'A' } }, { milestone: null }, { milestone: { title: 'B' } },
    ]);
    expect(Object.fromEntries(byTitle)).toEqual({ A: 2, B: 1 });
  });
});

describe('groupByArea', () => {
  it('groups product work by scope and strips the repeated scope prefix', () => {
    const { areas } = groupByArea([bullet('payments', 'tax line'), bullet('payments', 'billing address')]);
    expect(areas).toEqual([{ area: 'payments', items: ['tax line', 'billing address'] }]);
  });

  it('routes internal scopes out of the product areas entirely', () => {
    const { areas, internalScopes } = groupByArea([bullet('ci', 'a'), bullet('infra', 'b'), bullet('payments', 'c')]);
    expect(areas.map((a) => a.area)).toEqual(['payments']);
    expect(internalScopes).toEqual(['ci', 'infra']);
  });

  it('treats `process` and `lint` as internal — they are our own tooling, not product', () => {
    // Regression: the first live run surfaced "Process" and "Lint" as headline
    // product areas, which were this repo's own milestone-rule and lint work.
    const { areas, internalScopes } = groupByArea([bullet('process', 'a'), bullet('lint', 'b')]);
    expect(areas).toEqual([]);
    expect(internalScopes).toEqual(['lint', 'process']);
  });

  it('keeps `security` as a product area — a security fix is worth telling this reader', () => {
    const { areas } = groupByArea([bullet('security', 'rotate a key')]);
    expect(areas.map((a) => a.area)).toEqual(['security']);
  });

  it('keeps `jobs` as a product area — this repo’s cron work IS product behaviour', () => {
    // Same mistake as process/lint, running the other way: "no visible surface"
    // is not "not worth telling this reader". Dunning partially-paid students is
    // money being chased; course completion rolls enrollments.
    const { areas } = groupByArea([
      bullet('jobs', 'dun partially-paid students in payment reminders'),
      bullet('jobs', 'cron rolls enrollments and emits course.completed'),
    ]);
    expect(areas.map((a) => a.area)).toEqual(['jobs']);
  });

  it('drops the PR reference, which this reader does not follow', () => {
    const { areas } = groupByArea(['**payments:** tax ([#12](https://x/pull/12))']);
    expect(areas[0].items).toEqual(['tax']);
  });

  it('dedupes identical items within an area', () => {
    const { areas } = groupByArea([bullet('payments', 'same'), bullet('payments', 'same')]);
    expect(areas[0].items).toEqual(['same']);
  });

  it('orders by item count, then name, so the ordering is stable week to week', () => {
    const { areas } = groupByArea([
      bullet('zebra', 'a'), bullet('zebra', 'b'),
      bullet('alpha', 'c'),
      bullet('beta', 'd'),
    ]);
    expect(areas.map((a) => a.area)).toEqual(['zebra', 'alpha', 'beta']);
  });

  it('ignores bullets with no scope rather than inventing an area', () => {
    expect(groupByArea(['no scope here']).areas).toEqual([]);
  });
});

describe('internalPhrases', () => {
  it('maps scopes to plain English and dedupes overlapping ones', () => {
    expect(internalPhrases(['ci', 'build', 'release'])).toEqual(['deployment & CI']);
  });
  it('falls back to "internal tooling" for an unmapped scope, never leaking it raw', () => {
    expect(internalPhrases(['wibble'])).toEqual(['internal tooling']);
  });
  it('never emits the raw "deps-dev" scope', () => {
    expect(internalPhrases(['deps-dev'])).toEqual(['dependency updates']);
  });
});

describe('dropRef', () => {
  it('removes a trailing Slack-formatted PR link', () => {
    expect(dropRef('add tax (<https://x/pull/12|#12>)')).toBe('add tax');
  });
  it('leaves a bullet with no ref untouched', () => {
    expect(dropRef('add tax')).toBe('add tax');
  });
});

describe('renderDelivered', () => {
  const grouped = (n: number) => ({
    areas: Array.from({ length: n }, (_, i) => ({ area: `area${i}`, items: ['x'] })),
    internalScopes: [] as string[],
  });

  it('is empty when nothing shipped, so the section vanishes', () => {
    expect(renderDelivered({ areas: [], internalScopes: [] })).toBe('');
  });

  it('caps areas and says how many were left out', () => {
    const out = renderDelivered(grouped(9), { maxAreas: 6, maxPerArea: 3 });
    expect(out).toContain('…and 3 other areas');
  });

  it('singularises a single hidden area', () => {
    expect(renderDelivered(grouped(7), { maxAreas: 6, maxPerArea: 3 })).toContain('1 other area');
  });

  it('caps items within an area — at ~49 PRs a week it must aggregate, not enumerate', () => {
    const out = renderDelivered(
      { areas: [{ area: 'payments', items: ['a', 'b', 'c', 'd', 'e'] }], internalScopes: [] },
      { maxPerArea: 2 },
    );
    expect(out).toContain('a · b');
    expect(out).toContain('(+3 more)');
    expect(out).not.toContain('· c');
  });

  it('states internal work honestly in one line rather than hiding or listing it', () => {
    const out = renderDelivered({ areas: [], internalScopes: ['ci', 'qa', 'deps'] });
    expect(out).toContain('automated testing, dependency updates and deployment & CI behind the scenes');
  });
});

describe('renderProgress', () => {
  // A roadmap milestone is one carrying a due date (RA-1638) — not one whose title
  // is on a list. `dueOn` is what makes this a gate, so it is what the fixture
  // sets; a fixture that only set the title would pass under the old title-list
  // implementation and fail under this one, which is the point.
  const gate = (o: number, c: number, w = 0) => ({ title: 'Production Ready', dueOn: '2026-07-31T00:00:00Z', state: 'open', open: o, closed: c, closedThisWeek: w, completedThisWeek: false });

  it('renders a gate as a burndown with a denominator', () => {
    expect(renderProgress([gate(11, 27)])).toContain('*Production Ready* — 27 of 38 done');
  });

  it('adds the week movement only when something actually moved', () => {
    expect(renderProgress([gate(11, 27, 4)])).toContain('_(+4 this week)_');
    expect(renderProgress([gate(11, 27, 0)])).not.toContain('this week)_');
  });

  it('reports a bucket as flow, never as a fraction — a bucket has no finish line', () => {
    const out = renderProgress([{ title: 'Product Backlog', dueOn: null, open: 0, closed: 0, closedThisWeek: 26, completedThisWeek: false }]);
    expect(out).toContain('*Product Backlog* — 26 closed this week');
    expect(out).not.toContain(' of ');
  });

  it('omits a bucket that did not move, so quiet buckets do not pad the post', () => {
    const out = renderProgress([{ title: 'Development Automation', dueOn: null, open: 0, closed: 0, closedThisWeek: 0, completedThisWeek: false }]);
    expect(out).toBe('');
  });

  /**
   * RA-1638 — this test previously used AI Capabilities as the example of "a
   * bucket that did not move" and asserted it rendered ''. It is a ROADMAP
   * milestone (due 2026-12-31), so that assertion locked in the defect: the
   * only weekly report of milestone progress showed it as nothing at all.
   */
  it('renders a quiet ROADMAP milestone as a burndown rather than omitting it', () => {
    const out = renderProgress([
      { title: 'AI Capabilities', dueOn: '2026-12-31T00:00:00Z', open: 1, closed: 0, closedThisWeek: 0, completedThisWeek: false },
    ]);
    expect(out).toContain('*AI Capabilities* — 0 of 1 done');
    expect(out).not.toContain('this week)_');
  });

  /**
   * RA-1641 review — the due date alone was too broad. The loop fetches
   * `?state=all`, and `Development Ready` is CLOSED (2026-08-05) with
   * `due_on: 2026-08-31`. On the date alone it rendered `11 of 11 done` in
   * Progress every week from now on: a static line about a gate met a month
   * ago, in the section a reader takes for this week's movement, plus two
   * wasted searches a week and one more permanent line per future met gate.
   */
  it('excludes a CLOSED milestone however dated — a met gate is not a destination', () => {
    const out = renderProgress([
      { title: 'Development Ready', dueOn: '2026-08-31T00:00:00Z', state: 'closed', open: 0, closed: 11, closedThisWeek: 0, completedThisWeek: false },
    ]);
    expect(out).toBe('');
  });

  it('still reports a milestone completed THIS week as flow, so the celebration is not doubled', () => {
    // completedInWindow forces it into the search branch, renderCompletions
    // fires the 🎉, and this renders the movement — the pre-RA-1638 behaviour,
    // deliberately unchanged.
    const out = renderProgress([
      { title: 'Development Ready', dueOn: '2026-08-31T00:00:00Z', state: 'closed', open: 0, closed: 11, closedThisWeek: 4, completedThisWeek: true },
    ]);
    expect(out).toContain('*Development Ready* — 4 closed this week');
    expect(out).not.toContain(' of ');
  });

  it('classifies by the due date, not by the title — a renamed gate still burns down', () => {
    const out = renderProgress([
      { title: 'Pilot Launch', dueOn: '2027-03-01T00:00:00Z', open: 3, closed: 7, closedThisWeek: 2, completedThisWeek: false },
    ]);
    expect(out).toContain('*Pilot Launch* — 7 of 10 done');
    expect(out).toContain('_(+2 this week)_');
  });

  it('never renders an open/remaining count that reads as a to-do list', () => {
    const out = renderProgress([gate(11, 27, 4)]);
    expect(out).not.toMatch(/remaining|awaiting|outstanding|still open/i);
  });
});

describe('renderCompletions', () => {
  it('celebrates a milestone that completed this week', () => {
    const out = renderCompletions([{ title: 'Development Ready', open: 0, closed: 11, closedThisWeek: 0, completedThisWeek: true }]);
    expect(out).toContain(':tada: *Development Ready is complete* — all 11 done.');
  });

  it('stays silent for a milestone finished in an earlier week', () => {
    // Otherwise a completed milestone re-announces itself every Monday forever.
    const out = renderCompletions([{ title: 'Development Ready', open: 0, closed: 11, closedThisWeek: 0, completedThisWeek: false }]);
    expect(out).toBe('');
  });

  it('stays silent for an empty milestone', () => {
    expect(renderCompletions([{ title: 'Empty', open: 0, closed: 0, closedThisWeek: 0, completedThisWeek: true }])).toBe('');
  });
});

describe('renderStats', () => {
  it('renders the one-line volume summary', () => {
    expect(renderStats({ prsMerged: 54, issuesClosed: 36, releases: 23 })).toContain('54 PRs merged · 36 issues closed · 23 releases');
  });
  it('singularises each count independently', () => {
    expect(renderStats({ prsMerged: 1, issuesClosed: 1, releases: 1 })).toContain('1 PR merged · 1 issue closed · 1 release');
  });
});

describe('areaLabel / formatWeek', () => {
  it('title-cases a scope for display', () => {
    expect(areaLabel('payments')).toBe('Payments');
    expect(areaLabel('training-site')).toBe('Training Site');
  });
  it('formats the week start in the reader’s terms, not ISO', () => {
    expect(formatWeek(new Date('2026-08-01T00:00:00Z'))).toBe('1 Aug');
  });
});

describe('sanitiseNarrative', () => {
  // RA-707. The digest states three editorial rules and claims they are "enforced
  // by tests, not comments". For the deterministic half that was true; for the
  // MODEL-WRITTEN narrative — the most prominent prose in the post, and the
  // first thing the reader sees — they were enforced by PROMPT ONLY. The old
  // "never mentions an environment" test below supplied its own hand-written
  // narrative, so it constrained the template and could never fail because of
  // what the model wrote. One bad generation was enough to ship "now live on
  // production" to the co-founder with every step green.
  const rejects = (s: string) => sanitiseNarrative(s).violations.length > 0;
  const kept = (s: string) => sanitiseNarrative(s).narrative;

  describe('environment vocabulary (weekly-digest.yml:79-81)', () => {
    it('rejects a claim that something is live to customers', () => {
      expect(rejects('Card payments are now live for customers.')).toBe(true);
      expect(rejects('The booking flow went live this week.')).toBe(true);
      expect(rejects('Tax at checkout is live.')).toBe(true);
    });

    it('rejects a named environment', () => {
      expect(rejects('The work is deployed to production.')).toBe(true);
      expect(rejects('Card payments landed on staging.')).toBe(true);
      expect(rejects('The new pricing is in production.')).toBe(true);
      expect(rejects('Everything is on prod.')).toBe(true);
      expect(rejects('A production deploy followed on Thursday.')).toBe(true);
    });

    it('rejects the promotion vocabulary the prompt calls out by name', () => {
      // "Whether it has been promoted to production is a separate decision this
      // post does not speak to" — weekly-digest.yml:80-81.
      expect(rejects('Card payments were promoted to production on Friday.')).toBe(true);
      expect(rejects('The change was rolled out to customers.')).toBe(true);
    });

    // kanon#54: the generic words are every project's; the name a project gives its reference
    // environment is its own, so it comes from the adoption record (K-LAYOUT-10), not a list.
    describe("the project's declared environment name", () => {
      const env = (s: string, environment: string | null) => sanitiseNarrative(s, { environment });

      it('rejects the declared name where it names an environment', () => {
        for (const s of ['Card payments were deployed to uat.', 'Tax at checkout landed on the UAT server.', 'The uat environment took the release.']) {
          expect(env(s, 'uat').violations.map((v) => v.rule), s).toContain('environment');
          expect(env(s, 'uat').narrative, s).toBe('');
          // Without the declaration the same sentence passes: the name is not a generic word.
          expect(env(s, null).violations, s).toEqual([]);
        }
      });

      it('names the declaration in the reason, so a rejected run says where the rule came from', () => {
        expect(env('Shipped to uat.', 'uat').violations[0]?.why).toMatch(/`uat`.*K-LAYOUT-10/);
      });

      it('keeps the name where it is an ordinary word, so a chosen name costs no prose', () => {
        expect(env('The QA pipeline gained a guard.', 'qa').narrative).toBe('The QA pipeline gained a guard.');
        expect(env('Card payments landed.', 'uat').violations).toEqual([]);
      });

      it('reads the name as text, never as a pattern', () => {
        expect(env('Shipped to uat.eu today.', 'uat.eu').violations).toHaveLength(1);
        expect(env('Shipped to uatXeu today.', 'uat.eu').violations).toEqual([]);
      });

      it('adds nothing for a name the generic words already reject, or for none', () => {
        expect(env('Shipped to staging.', 'staging').violations).toHaveLength(sanitiseNarrative('Shipped to staging.').violations.length);
        for (const none of [null, '', '  ']) expect(env('Shipped to uat.', none).violations).toEqual([]);
      });

      it('buildMessage passes the declaration through, so the post never carries the name', () => {
        const text = buildMessage({
          weekStart: new Date('2026-08-01T00:00:00Z'), narrative: 'Card payments were deployed to uat.', milestones: [],
          grouped: { areas: [], internalScopes: [] }, stats: { prsMerged: 1, issuesClosed: 1, releases: 1 }, environment: 'uat',
        });
        expect(text).not.toMatch(/uat/i);
      });
    });
  });

  describe('open/pending/to-do framing (weekly-digest.yml:86)', () => {
    it('rejects the RA-166 line — a to-do aimed at the reader’s own backlog', () => {
      // RA-166 was REJECTED because it nagged the human about their own backlog.
      // A narrative sentence reintroduces it just as effectively as a section.
      expect(rejects('Three PRs are still awaiting review.')).toBe(true);
    });

    it('rejects remaining/outstanding/pending framing', () => {
      expect(rejects('Two features remain before the gate is met.')).toBe(true);
      expect(rejects('The remaining work is enrollment reporting.')).toBe(true);
      expect(rejects('A payment fix is still pending.')).toBe(true);
      expect(rejects('There is outstanding work on certificates.')).toBe(true);
    });

    it('rejects future framing — the prompt says past tense', () => {
      expect(rejects('Refunds are in progress.')).toBe(true);
      expect(rejects('Certificates are next up.')).toBe(true);
      expect(rejects('More payment work is coming soon.')).toBe(true);
      expect(rejects('Enrollment reporting has yet to land.')).toBe(true);
      expect(rejects('The remainder will ship next week.')).toBe(true);
    });
  });

  describe('the word list survives contact with real output', () => {
    // A screen so broad that every week's prose trips it silently turns the
    // feature into "no narrative, ever". These are sentences the digest SHOULD
    // be able to post, and each is a near-miss of a rule above.
    it('keeps a legitimate sentence containing "production"', () => {
      // The issue's own example: /production/i alone would reject this.
      expect(kept('Work continued on the production of course certificates.')).not.toBe('');
    });

    it('keeps "live" used as a product word, not an environment claim', () => {
      // This is a training business: live classes and live-streamed sessions are
      // product vocabulary, so a bare /live/ would be unusable.
      expect(kept('Students can now book live classes from the course page.')).not.toBe('');
      expect(kept('Sessions are live-streamed to enrolled students.')).not.toBe('');
    });

    it('keeps ordinary past-tense delivery prose', () => {
      expect(kept('Card payments landed, with tax calculated at checkout.')).not.toBe('');
      expect(kept('A quiet week: most of the effort went into automated testing.')).not.toBe('');
      expect(kept('Customers will be able to pay by card at the kiosk.')).not.toBe('');
    });

    it('keeps an idiom that merely contains "to do"', () => {
      expect(kept('None of this had anything to do with billing.')).not.toBe('');
    });

    // THE GAP THAT SHIPPED IN THE FIRST PASS. `production` / `live` /
    // `outstanding` were narrowed to the CLAIM; `upcoming`, `pending`,
    // `awaiting`, `remaining` and `next week` were left as bare words — and all
    // five are first-class product vocabulary in this app, so the screen deleted
    // delivered-outcome prose. Each sentence below is the kind of thing
    // `weekly-digest.yml` explicitly instructs the model to write, and each names
    // the surface the word belongs to.
    it.each([
      // instructor/page.tsx:49 + instructor/classes/page.tsx:73 — "Upcoming classes"
      'Instructors can now see their upcoming classes at a glance.',
      // classes/type/[slug]/page.tsx:160 — "Upcoming dates"
      'Students can browse upcoming dates for each course and register online.',
      // admin/reviews/page.tsx:10 — the moderation tab is labelled "Pending"
      'Admins can moderate pending reviews before they appear on the storefront.',
      // commerce.ts:207 — `pending` is a paymentState value
      'Staff can see which registrations have a pending payment recorded against them.',
      // instructors.ts:464 — the natural verb for the 'pending' invitation state
      'Instructors are notified when an invitation is awaiting their answer.',
      // a student's remaining balance — the same word class as "outstanding
      // balance", which was already kept. Two treatments of one class was the
      // internal inconsistency.
      'Students see their remaining balance at the kiosk.',
      // a possessive, not a plan
      "Customers can now book next week's classes from the storefront.",
      // RA-1377: `reviews` is the moderation queue here (admin/reviews/page.tsx), so
      // the object-first `await` pattern must not read it as a PR review.
      'Reviews awaiting moderation now appear in a dedicated admin tab.',
      // RA-1377: the object-first `remain` candidate the issue measured dropped this —
      // `review` sits within reach of `remaining`. The complement-scoped form must not.
      'Admins can review a student remaining balance before issuing a refund.',
      // `unchanged` has the shape of `unfinished`, which is why the complements are
      // enumerated rather than `un\w+`.
      'Prices remain unchanged for existing students.',
      // A bare clause-ending `remains` is only a to-do with a to-do SUBJECT, and a time
      // complement only with a planning unit. Both of these are pricing prose.
      'Early-bird pricing remains for the next cohort.',
      'Existing bookings are unaffected; the old price remains.',
      // Seat availability is a shipped surface (`src/lib/seats.ts`), so a quantifier must
      // not reach across a noun to a clause-ending `remain` (the Reviewer, PR RA-2350).
      'The class page now shows how many seats remain.',
      'Students can see how many spots remain, per session.',
      'Only a few seats remain.',
      'Most of the discounts remain, now shown at checkout.',
      'Several discount codes remain (unchanged).',
      // `of` counts as a subject only with a NUMBER after it.
      'The perks members love most of all remain.',
    ])('keeps this app own product vocabulary: %s', (sentence) => {
      expect(kept(sentence)).not.toBe('');
    });

    // …and the to-do framing the rule actually targets still goes. Narrowing is
    // only safe if this half is pinned beside it: every sentence here differs
    // from one above by FRAMING, not by vocabulary.
    it.each([
      'Three PRs are still awaiting review.',
      'A payment fix is still pending.',
      'Two features remain before the gate is met.',
      'The remaining work is enrollment reporting.',
      'Certificates are next up.',
      'Card payments are now live on production.',
      // RA-1377: postfix `remain` escaped the verb-first pattern — every one of these
      // was KEPT before, and each is the RA-166 sentence this rule exists to stop.
      'Three PRs remain unreviewed.',
      'Some work remains.',
      'A handful of tasks remain for next month.',
      'Eleven of thirty-eight remain.',
      'Certificates remained unfinished.',
      // …whatever punctuation ends the clause.
      'Some work remains, mostly reporting.',
      'Some work remains — mostly reporting.',
      'Only three tasks remain (all reporting).',
      // A quantifier alone is enough of a subject: no to-do noun here.
      'Some remain, mostly minor.',
      'Some remain.',
      'Three of 40 remain.',
      'Some work remains\n\nOtherwise quiet.',
      // The product-ambiguous nouns still reject when the complement is a to-do.
      'Two fixes are awaiting deploy.',
      'Several changes await QA.',
      'Three reviews await a second look.',
    ])('still rejects to-do framing: %s', (sentence) => {
      expect(kept(sentence)).toBe('');
    });
  });

  it('drops the WHOLE narrative, never a half-sentence', () => {
    // Sentence-level surgery is the one option that can emit an incoherent
    // fragment, so a violation costs the prose entirely.
    const { narrative } = sanitiseNarrative(
      'Card payments landed this week. They are now live on production. Enrollment reporting followed.',
    );
    expect(narrative).toBe('');
  });

  it('names the rule and the text that tripped it, so the run log is diagnosable', () => {
    // Without this a persistently bad prompt produces a silently prose-less
    // digest every week and nothing says why.
    const { violations } = sanitiseNarrative('Now live on production.');
    expect(violations.map((v) => v.rule)).toContain('environment');
    expect(violations[0].match).toMatch(/live|production/i);
  });

  it('treats an absent narrative as clean, not as a violation', () => {
    // The degraded path (a model outage, `narrative.txt` missing) must stay
    // distinguishable from a rejection — one is expected, the other is a signal.
    for (const empty of [undefined, '', '   ']) {
      expect(sanitiseNarrative(empty).violations).toEqual([]);
      expect(sanitiseNarrative(empty).narrative).toBe('');
    }
  });

  it('trims the model’s trailing newline like buildMessage always did', () => {
    expect(kept('Card payments landed.\n')).toBe('Card payments landed.');
  });
});

describe('buildMessage', () => {
  const base = {
    weekStart: new Date('2026-08-01T00:00:00Z'),
    milestones: [{ title: 'Production Ready', dueOn: '2026-07-31T00:00:00Z', open: 11, closed: 27, closedThisWeek: 4, completedThisWeek: false }],
    grouped: { areas: [{ area: 'payments', items: ['tax at checkout'] }], internalScopes: [] as string[] },
    stats: { prsMerged: 54, issuesClosed: 36, releases: 23 },
  };

  it('assembles the post with the milestone burndown as the headline', () => {
    const out = buildMessage({ ...base, narrative: undefined });
    expect(out).toContain('*Week of 1 Aug*');
    expect(out.indexOf('Production Ready')).toBeLessThan(out.indexOf('54 PRs merged'));
  });

  it('includes the narrative when one is supplied and degrades cleanly without it', () => {
    expect(buildMessage({ ...base, narrative: 'Card payments landed.' })).toContain('Card payments landed.');
    const without = buildMessage({ ...base, narrative: undefined });
    expect(without).toContain('Production Ready');
    expect(without).not.toContain('undefined');
  });

  it('never mentions an environment — with CD, "staging" means nothing to this reader', () => {
    const out = buildMessage({ ...base, narrative: 'Shipped a lot.' });
    expect(out).not.toMatch(/staging|production deploy|promoted/i);
  });

  // RA-707: the three tests below are the ones the assertion above could not be.
  // It supplies its own narrative, so it constrains the TEMPLATE; these supply
  // the narrative a bad generation would write.
  it('screens the MODEL’S narrative, not just the template around it', () => {
    const out = buildMessage({ ...base, narrative: 'Card payments are now live on production.' });
    // NB: not a bare /production/i over the post — the burndown line legitimately
    // says "Production Ready". Asserting that would be the very mistake the
    // scoping test below pins.
    expect(out).not.toMatch(/staging|now live|on production|promoted/i);
    expect(out).not.toContain('Card payments are now live');
  });

  it('degrades to numbers-only on a violation — the numbers are the product', () => {
    // Identical to the path the workflow already supports when narrative.txt is
    // absent: a bad generation must never cost the week's burndown.
    const rejected = buildMessage({ ...base, narrative: 'Three PRs are still awaiting review.' });
    expect(rejected).toBe(buildMessage({ ...base, narrative: undefined }));
    expect(rejected).toContain('*Production Ready* — 27 of 38 done');
    expect(rejected).toContain('54 PRs merged');
  });

  it('screens the narrative only — the assembled post still renders "Production Ready"', () => {
    // The check must never be applied to the whole post: the digest legitimately
    // renders the milestone title, and a naive /production/i over the assembled
    // text would blank the headline this digest exists to deliver.
    const out = buildMessage({ ...base, narrative: 'Card payments landed, with tax at checkout.' });
    expect(out).toContain('Production Ready');
    expect(out).toContain('Card payments landed, with tax at checkout.');
  });

  it('truncates rather than letting Slack reject an oversized payload', () => {
    const huge = {
      ...base,
      narrative: 'x'.repeat(13000),
      grouped: { areas: [], internalScopes: [] as string[] },
    };
    const out = buildMessage(huge);
    expect(out.length).toBeLessThanOrEqual(12000);
    expect(out).toContain('truncated');
  });
});

// RA-2399: the gate-candidate list. Since RA-1616 a sev:critical/high reviewer
// follow-up is labelled `gate-candidate` rather than routed onto the gate, and
// the digest is the only scheduled place the developer sees it.
describe('gate candidates (RA-2399)', () => {
  const NOW = new Date('2026-09-28T08:00:00Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  const issue = (number: number, sev: string | null, age: number, extra: Record<string, unknown> = {}) => ({
    number,
    title: `Candidate ${number}`,
    html_url: `https://github.com/o/r/issues/${number}`,
    state: 'open',
    created_at: daysAgo(age),
    labels: [{ name: 'gate-candidate' }, ...(sev ? [{ name: `sev:${sev}` }] : []), { name: 'follow-up' }],
    ...extra,
  });

  describe('severityOf / gateCandidatesFrom', () => {
    it('reads the sev:* label in either REST or string form', () => {
      expect(severityOf(issue(1, 'high', 0))).toBe('high');
      expect(severityOf({ labels: ['sev:critical'] })).toBe('critical');
      expect(severityOf(issue(1, null, 0))).toBeNull();
    });

    it('sorts by severity, then oldest first, with an unlabelled severity last', () => {
      const rows = gateCandidatesFrom(
        [issue(1, 'high', 2), issue(2, null, 30), issue(3, 'critical', 1), issue(4, 'high', 9), issue(5, 'medium', 40)],
        NOW,
      );
      expect(rows.map((r) => r.number)).toEqual([3, 4, 1, 5, 2]);
      expect(rows.find((r) => r.number === 4)).toMatchObject({ sev: 'high', ageDays: 9, title: 'Candidate 4' });
    });

    it('drops pull requests, closed items and unlabelled items — and nothing else', () => {
      const rows = gateCandidatesFrom(
        [
          issue(1, 'high', 1),
          issue(2, 'high', 1, { pull_request: { url: 'x' } }),
          issue(3, 'high', 1, { state: 'closed' }),
          issue(4, 'high', 1, { labels: [{ name: 'sev:high' }] }),
          issue(5, null, 1),
        ],
        NOW,
      );
      expect(rows.map((r) => r.number)).toEqual([1, 5]);
    });

    it('matches labels case-insensitively, as GitHub does — a recapitalised label is not "none"', () => {
      const rows = gateCandidatesFrom([issue(1, null, 1, { labels: [{ name: 'Gate-Candidate' }, { name: 'sev:High' }] })], NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0].sev).toBe('high');
    });

    it('drops a candidate already placed on a roadmap milestone, but keeps one on a bucket', () => {
      const rows = gateCandidatesFrom(
        [
          issue(1, 'high', 1, { milestone: { title: 'Production Ready', due_on: '2026-10-31T00:00:00Z', state: 'open' } }),
          issue(2, 'high', 1, { milestone: { title: 'Product Backlog', due_on: null, state: 'open' } }),
        ],
        NOW,
      );
      expect(rows.map((r) => r.number)).toEqual([2]);
    });
  });

  describe('renderGateCandidates', () => {
    it('lists every candidate with number, title, severity and age, under the decision line', () => {
      const out = renderGateCandidates({ ok: true, candidates: gateCandidatesFrom([issue(7, 'critical', 12), issue(8, null, 1)], NOW) });
      expect(out).toContain('*Gate candidates*');
      expect(out).toMatch(/developer’s call/);
      expect(out).toContain('• <https://github.com/o/r/issues/7|#7> `sev:critical` Candidate 7 — opened 12 days ago');
      expect(out).toContain('• <https://github.com/o/r/issues/8|#8> `sev:?` Candidate 8 — opened 1 day ago');
    });

    it('says "none" when the list is empty — silence must not look like an empty queue', () => {
      const out = renderGateCandidates({ ok: true, candidates: [] });
      expect(out).toContain('*Gate candidates*');
      expect(out).toMatch(/^• none$/m);
    });

    it('says the list is unreadable — never "none" — when the read failed', () => {
      const out = renderGateCandidates({ ok: false, reason: 'GitHub GET /repos/o/r/labels/x → 502: {"message":"Bad Gateway"}' });
      expect(out).toContain('*Gate candidates*');
      expect(out).toContain('could not be read');
      expect(out).toContain('GitHub returned 502');
      expect(out).not.toContain('Bad Gateway'); // no raw API body in the stakeholder channel
      expect(out).toContain(GATE_CANDIDATE_QUERY);
      expect(out).not.toMatch(/• none/);
    });

    it('is fail-closed: a caller that never read the list gets "unreadable", not "none"', () => {
      for (const r of [undefined, null, {}, { ok: true }]) {
        const out = renderGateCandidates(r as never);
        expect(out).toContain('could not be read');
        expect(out).not.toMatch(/• none/);
      }
    });

    it('notes candidates already placed, so a shorter list is explained', () => {
      const out = renderGateCandidates({ ok: true, candidates: [], placed: 2 });
      expect(out).toMatch(/^• none$/m);
      expect(out).toContain('2 more already placed on a roadmap milestone');
    });

    it('shortReason keeps the status and drops the body', () => {
      expect(shortReason('GitHub GET /x → 404: {"message":"Not Found"}')).toBe('GitHub returned 404');
      expect(shortReason('fetch failed')).toBe('the request failed');
    });

    it('escapes Slack control characters in titles', () => {
      const rows = gateCandidatesFrom([issue(9, 'high', 0, { title: 'a <b> & c' })], NOW);
      expect(renderGateCandidates({ ok: true, candidates: rows })).toContain('a &lt;b&gt; &amp; c');
    });

    it('none of its fixed prose trips the RA-1377 narrative screen', () => {
      // The screen runs on the narrative only, but the section's own words should
      // not be the kind it rejects either — the digest's editorial rules apply.
      const texts = [
        renderGateCandidates({ ok: true, candidates: gateCandidatesFrom([issue(1, 'high', 3)], NOW) }),
        renderGateCandidates({ ok: true, candidates: [] }),
        renderGateCandidates({ ok: false, reason: 'boom' }),
      ];
      for (const t of texts) expect(sanitiseNarrative(t).violations).toEqual([]);
    });
  });

  describe('readGateCandidates', () => {
    const repo = 'o/r';
    const fakeApi = (pages: unknown[][], { labelMissing = false } = {}) => {
      const calls: string[] = [];
      const api = async (path: string) => {
        calls.push(path);
        if (path.includes('/labels/')) {
          if (labelMissing) throw new Error(`GitHub GET ${path} → 404`);
          return { name: 'gate-candidate' };
        }
        const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
        return pages[page - 1] ?? [];
      };
      return { api, calls };
    };

    it('reads every page — a candidate on page 2 is not missed', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => issue(1000 + i, 'medium', 1));
      const { api, calls } = fakeApi([page1, [issue(7, 'critical', 3)]]);
      const r = await readGateCandidates({ api, repo, now: NOW });
      expect(r.ok).toBe(true);
      expect(r.candidates ?? []).toHaveLength(101);
      expect(r.candidates?.[0]).toMatchObject({ number: 7, sev: 'critical' });
      expect(calls.every((c) => !c.startsWith('/search'))).toBe(true); // spends no search budget (§12)
    });

    it('reports a missing label as unreadable — `?labels=` on a deleted label is an empty 200', async () => {
      const { api } = fakeApi([[issue(7, 'critical', 3)]], { labelMissing: true });
      const r = await readGateCandidates({ api, repo, now: NOW });
      expect(r).toMatchObject({ ok: false });
      expect(r.reason).toContain('404');
    });

    it('reports an API failure as unreadable rather than throwing', async () => {
      const api = async (path: string) => {
        if (path.includes('/labels/')) return {};
        throw new Error('GitHub GET → 502');
      };
      await expect(readGateCandidates({ api, repo, now: NOW })).resolves.toMatchObject({ ok: false, reason: 'GitHub GET → 502' });
    });

    it('reports a list cut at the page cap as unreadable, not as a short list', async () => {
      const full = Array.from({ length: 100 }, (_, i) => issue(i + 1, 'low', 1));
      const { api } = fakeApi([full, full]);
      const r = await readGateCandidates({ api, repo, now: NOW, maxPages: 2 });
      expect(r.ok).toBe(false);
    });
  });

  describe('in the assembled post', () => {
    const base = {
      weekStart: new Date('2026-09-21T00:00:00Z'),
      narrative: 'Card payments landed, with tax at checkout.',
      milestones: [{ title: 'Production Ready', dueOn: '2026-10-31T00:00:00Z', open: 11, closed: 27, closedThisWeek: 4, completedThisWeek: false }],
      grouped: { areas: [{ area: 'payments', items: ['tax at checkout'] }], internalScopes: [] as string[] },
      stats: { prsMerged: 54, issuesClosed: 36, releases: 23 },
    };

    it('carries the section, between Progress and Delivered', () => {
      const out = buildMessage({ ...base, gateCandidates: { ok: true, candidates: gateCandidatesFrom([issue(7, 'high', 2)], NOW) } });
      expect(out).toContain('#7>');
      expect(out.indexOf('*Progress*')).toBeLessThan(out.indexOf('*Gate candidates*'));
      expect(out.indexOf('*Gate candidates*')).toBeLessThan(out.indexOf('*Delivered*'));
    });

    it('an oversized post truncates Delivered, never the candidate list', () => {
      const cand = gateCandidatesFrom(Array.from({ length: 30 }, (_, i) => issue(i + 1, 'high', i)), NOW);
      const out = buildMessage({
        ...base,
        grouped: { areas: Array.from({ length: 6 }, (_, i) => ({ area: `a${i}`, items: ['x'.repeat(3000)] })), internalScopes: [] as string[] },
        gateCandidates: { ok: true, candidates: cand },
      });
      expect(out.length).toBeLessThanOrEqual(12000);
      expect(out).toContain('truncated');
      for (let n = 1; n <= 30; n++) expect(out).toContain(`|#${n}>`);
      expect(out).toContain('36 issues closed');
    });

    it('says "unreadable" in the post when the read failed', () => {
      const out = buildMessage({ ...base, gateCandidates: { ok: false, reason: 'boom' } });
      expect(out).toContain('could not be read');
    });

    it('a candidate title in environment vocabulary does not cost the narrative', () => {
      const cand = gateCandidatesFrom([issue(7, 'high', 2, { title: 'staging webhook is live on prod' })], NOW);
      const out = buildMessage({ ...base, gateCandidates: { ok: true, candidates: cand } });
      expect(out).toContain('Card payments landed, with tax at checkout.');
      expect(out).toContain('staging webhook is live on prod');
    });
  });
});
