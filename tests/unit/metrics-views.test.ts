import { describe, expect, it } from 'vitest';
import { validate } from '../../actions/agent-telemetry/schema.mjs';
import { parseReportArgs } from '../../cli/metrics-report.mjs';
import { metrics } from '../../cli/metrics.mjs';
import { PRICES, cacheSavings, priceOf } from '../../scripts/metrics/prices.mjs';
import { MINIMUM, metricsReport, renderReport } from '../../scripts/metrics/report.mjs';
import { bootstrapDifference, newcombe } from '../../scripts/metrics/stats.mjs';
import { AB_MARGINS, metricsViews, renderViews } from '../../scripts/metrics/views.mjs';
import { DAY, UNTIL, ago, itemRow, mergedWithRuns, risingRows, runRow } from './helpers/metrics-rows.js';

/**
 * The report's secondary measures and its views (plan 0003 §2.2, §2.3, §3.6, §6.1, kanon#669):
 * cost per acceptance criterion and cache savings beside cost; review rounds, lead time by stage
 * and human wait beside yield; the issue-side band cross-check beside the validity check; and the
 * trend, by-version and configuration A/B views, the A/B with decision 11's margins.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the report's cells, read by known paths
type Cells = Record<string, any>;

const report = (rows: unknown[], days?: number) => metricsReport(rows, { until: UNTIL, ...(days ? { days } : {}) });
const views = (rows: unknown[], windows = 6) => metricsViews(rows, { until: UNTIL, windows });
const HOUR = 3600;

describe('the fixtures', () => {
  it('are rows the telemetry schema accepts', () => {
    const rows = [
      itemRow(1, { closed: ago(2), band: 'S', fields: { ac_count: 4, origin: 'brief', issue_body_chars: 900, review_rounds: 2, lead_time_s: 7200, t_human_s: 3600, t_agent_s: 3600, kanon_version: '0.39.0' } }),
      runRow('implement', { pr: 1, at: ago(3), cost: 1, fields: { config_fingerprint: 'aaaaaaaaaaaa', model: 'claude-sonnet-4-5-20250929', cache_read_tokens: 1000 } }),
    ];
    for (const row of rows) expect(validate(row), JSON.stringify(row)).toEqual({ ok: true });
  });
});

describe('the secondary measures beside cost (§2.2)', () => {
  it('reports cost per acceptance criterion over the costed items that have criteria, by band', () => {
    // Twenty S items costing $1 (risingRows' S average), ten of them with 4 criteria each.
    const rows = risingRows({ S: 20, M: 20, L: 20, XL: 20 }).map((r) =>
      r.row_kind === 'work_item' && (r.pr_number as number) <= 10 ? { ...r, ac_count: 4 } : r.row_kind === 'work_item' && (r.pr_number as number) === 11 ? { ...r, ac_count: 0 } : r);
    const r = report(rows);
    const cells = r.secondary.costPerAc.cells as Cells;
    expect(cells.S.median.status).toBe('ok');
    expect(cells.S.median.n).toBe(10);
    // The ten items' costs are 0.8 to 1.2 by k % 5; per criterion, a quarter of that.
    expect(cells.S.median.value).toBeCloseTo(0.25, 2);
    // An item with no criteria, or none recorded, has no cost per criterion: never a division by zero.
    expect(cells.M.median).toEqual({ status: 'not-enough-data', n: 0, minimum: MINIMUM.median });
    expect(cells.pooled.median.n).toBe(10);
  });

  it('reports cache savings at list price from the dated price table, and counts the runs it cannot price', () => {
    const at = ago(3);
    const rows = [
      itemRow(1, { closed: ago(2), band: 'S' }),
      runRow('implement', { pr: 1, at, cost: 2, fields: { model: 'claude-sonnet-4-5-20250929', cache_read_tokens: 1_000_000 } }),
      runRow('review', { pr: 1, at, cost: 1, fields: { model: 'claude-sonnet-4-5', cache_read_tokens: 500_000 } }),
      runRow('explore', { at, cost: 1, fields: { model: 'claude-haiku-4-5-20251001', cache_read_tokens: 0 } }),
      // Not in the table, a long-context variant, and a run with no cache count: unknown, never $0.
      runRow('implement', { pr: 1, at, cost: 1, fields: { model: 'claude-made-up-9', cache_read_tokens: 100 } }),
      runRow('implement', { pr: 1, at, cost: 1, fields: { model: 'claude-sonnet-4-5[1m]', cache_read_tokens: 100 } }),
      runRow('implement', { pr: 1, at, cost: 1, fields: { model: 'claude-sonnet-4-5' } }),
      // Outside the window: in no sum.
      runRow('implement', { pr: 1, at: ago(40), cost: 1, fields: { model: 'claude-sonnet-4-5', cache_read_tokens: 9_000_000 } }),
    ];
    const s = report(rows).secondary.cacheSavings;
    // Sonnet 4.5: $3 input, $0.30 a cache read, per million tokens: 1.5M reads save 1.5 × 2.70.
    expect(s.usd).toBeCloseTo(4.05, 4);
    expect(s.runs).toBe(3);
    expect(s.unpriced).toBe(3);
    expect(s.unpricedModels).toEqual(['claude-made-up-9', 'claude-sonnet-4-5[1m]']);
    // What the priced runs would have cost without cache reads: $4 paid, $4.05 saved.
    expect(s.share).toBeCloseTo(4.05 / 8.05, 4);
    const text = renderReport(report(rows)).join('\n');
    expect(text).toMatch(/Cache savings, at API list price: \$4\.05 over 3 runs/);
    expect(text).toMatch(/3 runs could not be priced/);
  });

  it('prices a run by the table entry in force when it ran, matching a model exactly or with its date', () => {
    const table = [
      { model: 'm-1', from: '2026-01-01', input: 10, cacheRead: 1 },
      { model: 'm-1', from: '2026-06-01', input: 4, cacheRead: 0.4 },
    ];
    expect(priceOf('m-1', '2025-12-31T00:00:00Z', table)).toBeNull();
    expect(priceOf('m-1', '2026-03-01T00:00:00Z', table)).toMatchObject({ input: 10 });
    expect(priceOf('m-1-20260301', '2026-07-01T00:00:00Z', table)).toMatchObject({ input: 4 });
    expect(priceOf('m-1-5', '2026-07-01T00:00:00Z', table)).toBeNull();
    expect(priceOf('m-1[1m]', '2026-07-01T00:00:00Z', table)).toBeNull();
    expect(cacheSavings({ model: 'm-1', recorded_at: '2026-07-01T00:00:00Z', cache_read_tokens: 2_000_000 }, table)).toBeCloseTo(7.2, 6);
    expect(cacheSavings({ model: 'm-1', recorded_at: '2026-07-01T00:00:00Z' }, table)).toBeNull();
    // Every entry Kanon ships saves something: a cache read is cheaper than an input token.
    for (const p of PRICES) expect(p.cacheRead).toBeLessThan(p.input);
  });
});

describe('the secondary measures beside yield (§2.3)', () => {
  const flow = (k: number) => ({
    review_rounds: 1 + (k % 3), lead_time_s: (10 + k) * HOUR, t_human_s: (k % 4) * HOUR, t_agent_s: 5 * HOUR,
    t_review_s: HOUR, t_ci_s: 0, t_rework_s: 0, t_queue_s: 0, t_merge_queue_s: 0, t_other_s: (10 + k) * HOUR - 6 * HOUR - (k % 4) * HOUR,
  });

  it('reports review rounds to approval, lead time and its stages, and human wait, by band', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, k) => mergedWithRuns(1 + k, 'S', 1, 1 + (k % 20), { verdict: 'approved', fields: flow(k) })).flat(),
      // No Reviewer verdict: no rounds to approval. Closed unmerged: no lead time to merge.
      itemRow(100, { closed: ago(2), band: 'S', verdict: 'none', fields: { review_rounds: 0 } }),
      itemRow(101, { closed: ago(2), band: 'S', fate: 'closed_unmerged', verdict: 'approved', fields: { review_rounds: 9, lead_time_s: 999 * HOUR } }),
    ];
    const r = report(rows);
    const rounds = r.secondary.reviewRounds.cells as Cells;
    expect(rounds.pooled.median).toMatchObject({ status: 'ok', n: 30, value: 2 });
    const lead = r.secondary.leadTime.cells as Cells;
    expect(lead.pooled.median).toMatchObject({ status: 'ok', n: 30, value: 24.5 * HOUR });
    expect(lead.pooled.p90).toMatchObject({ status: 'ok', n: 30, value: 36 * HOUR });
    expect(lead.pooled.stages.agent.median).toMatchObject({ status: 'ok', value: 5 * HOUR });
    expect(lead.pooled.stages.ci.median).toMatchObject({ status: 'ok', value: 0 });
    expect(Object.keys(lead.pooled.stages)).toEqual(['human', 'merge_queue', 'agent', 'review', 'ci', 'rework', 'queue', 'other']);
    const wait = r.secondary.humanWait.cells as Cells;
    // 8 items waited 0 h, 8 waited 1 h, 7 waited 2 h and 7 waited 3 h.
    expect(wait.pooled.median).toMatchObject({ status: 'ok', n: 30, value: HOUR });
    const text = renderReport(r).join('\n');
    expect(text).toMatch(/\| Review rounds to approval, median \|/);
    expect(text).toMatch(/\| Lead time to merge, median \|[^\n]*24\.5 h/);
    expect(text).toMatch(/\| Stage: agent, median \|[^\n]*5\.0 h/);
    expect(text).toMatch(/\| Human wait, median \|[^\n]*1\.0 h/);
  });

  it('holds each to its minimum: medians from 10, a p90 from 30', () => {
    const rows = Array.from({ length: 9 }, (_, k) => mergedWithRuns(1 + k, 'S', 1, 2, { verdict: 'approved', fields: flow(k) })).flat();
    const r = report(rows);
    expect((r.secondary.reviewRounds.cells as Cells).pooled.median).toEqual({ status: 'not-enough-data', n: 9, minimum: 10 });
    expect((r.secondary.leadTime.cells as Cells).pooled.p90).toEqual({ status: 'not-enough-data', n: 9, minimum: 30 });
    expect((r.secondary.humanWait.cells as Cells).pooled.median).toEqual({ status: 'not-enough-data', n: 9, minimum: 10 });
  });

  it('follows the view: no banded cell when the validity check pools the indicators', () => {
    const r = report(risingRows({ S: 3, M: 3, L: 0, XL: 0 }));
    expect(r.view).toBe('pooled');
    for (const m of [r.secondary.costPerAc, r.secondary.reviewRounds, r.secondary.leadTime, r.secondary.humanWait]) {
      expect(Object.keys(m.cells)).toEqual(['pooled']);
    }
  });
});

describe('the issue-side band cross-check (§3.6)', () => {
  /** Brief-driven merged items whose cost rises with their criteria and their issue's length. */
  const briefs = (n: number, opts: { origin?: string; rising?: boolean } = {}) => Array.from({ length: n }, (_, k) => {
    const ac = 1 + (k % 6);
    const cost = opts.rising === false ? 10 - ac + (k % 3) * 0.1 : ac + (k % 3) * 0.1;
    return mergedWithRuns(1 + k, 'M', cost, 1 + (k % 20), { fields: { origin: opts.origin ?? 'brief', ac_count: ac, issue_body_chars: 200 * ac + (k % 3) } });
  }).flat();

  it('prints, beside the validity check, whether cost rises with the issue-side size, with its interval', () => {
    const r = report(briefs(24));
    const side = r.validity.issueSide;
    expect(side.n).toBe(24);
    expect(side.acCount.status).toBe('rises');
    expect(side.acCount.low).toBeGreaterThan(0);
    expect(side.bodyChars.status).toBe('rises');
    expect(renderReport(r).join('\n')).toMatch(/Issue-side cross-check \(§3\.6\), over 24 brief-driven merged items with criteria: cost against acceptance criteria rises, τ /);
  });

  it('says "not shown" when cost does not rise with it, and "not enough data" below 10 brief-driven items with criteria', () => {
    expect(report(briefs(24, { rising: false })).validity.issueSide.acCount.status).toBe('not-shown');
    // A τ above zero whose interval reaches below it is not shown to rise either.
    const COSTS = [3, 1, 2, 4, 5, 2, 1, 3, 4, 6, 2, 2];
    const weak = report(COSTS.flatMap((cost, k) => mergedWithRuns(1 + k, 'M', cost, 1 + k, { fields: { origin: 'brief', ac_count: 1 + (k % 2) } }))).validity.issueSide.acCount;
    expect(weak.status).toBe('not-shown');
    if (weak.status === 'not-shown') {
      expect(weak.tau).toBeGreaterThan(0);
      expect(weak.low).toBeLessThan(0);
    }
    const few = report(briefs(9)).validity.issueSide;
    expect(few.acCount).toEqual({ status: 'not-enough-data', n: 9, minimum: MINIMUM.validity });
    // Items that are not brief-driven are not in it, however many have criteria.
    expect(report(briefs(24, { origin: 'explorer' })).validity.issueSide.n).toBe(0);
  });

  it('is a cross-check only: it never changes the view', () => {
    const rows = [...risingRows({ S: 20, M: 20, L: 20, XL: 20 }), ...briefs(24, { rising: false }).map((r) => ({ ...r, ...(r.pr_number !== undefined ? { pr_number: (r.pr_number as number) + 5000 } : {}) }))];
    const r = report(rows);
    expect(r.validity.issueSide.acCount.status).toBe('not-shown');
    expect(r.view).toBe('banded');
  });
});

describe('the trend view (§6.1)', () => {
  /** Ten merged items in window `w` (0 the latest), each costing `cost`, at `version`. */
  const windowRows = (w: number, cost: number, version: string) => Array.from({ length: 10 }, (_, k) =>
    mergedWithRuns(1000 * (w + 1) + k, 'S', cost, 28 * w + 1 + k, { fields: { kanon_version: version } })).flat();

  it('shows the headline over consecutive 28-day windows, oldest first, each with its interval', () => {
    const v = views([...windowRows(0, 3, '0.39.0'), ...windowRows(1, 2, '0.38.0'), ...windowRows(2, 1, '0.38.0')], 3);
    expect(v.trend.map((t: Cells) => t.window)).toEqual([
      { from: '2026-07-18', until: '2026-08-15', days: 28 },
      { from: '2026-08-15', until: '2026-09-12', days: 28 },
      { from: '2026-09-12', until: '2026-10-10', days: 28 },
    ]);
    expect(v.trend.map((t: Cells) => t.cost.median.value)).toEqual([1, 2, 3]);
    expect((v.trend as Cells[])[2]!.cost.median.low).not.toBeNull();
    expect(Object.keys((v.trend as Cells[])[0]!)).toEqual(expect.arrayContaining(['cost', 'yield', 'escape', 'approval', 'correction', 'bandMix', 'versionsIntroduced']));
  });

  it('marks a Kanon version boundary on the window its first item closed in, and none where nothing came before', () => {
    const v = views([...windowRows(0, 3, '0.39.0'), ...windowRows(1, 2, '0.38.0'), ...windowRows(2, 1, '0.38.0')], 3);
    expect(v.trend.map((t: Cells) => t.versionsIntroduced)).toEqual([[], [], ['0.39.0']]);
    // An item closed before the span makes the span's first version a boundary.
    const earlier = views([...windowRows(2, 1, '0.38.0'), itemRow(9, { closed: ago(200), fields: { kanon_version: '0.37.0' } })], 3);
    expect(earlier.trend[0]?.versionsIntroduced).toEqual(['0.38.0']);
    const text = renderViews(v).join('\n');
    expect(text).toMatch(/\| 2026-09-12 to 2026-10-10 \| [^\n]*\| Kanon 0\.39\.0 starts \|/);
  });
});

describe('the by-version view (§6.1)', () => {
  it('shows the headline per kanon_version, only for versions with enough items', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, k) => mergedWithRuns(1 + k, 'S', 2, 2 + k, { fields: { kanon_version: '0.38.0' } })).flat(),
      ...Array.from({ length: 5 }, (_, k) => mergedWithRuns(100 + k, 'S', 9, 2 + k, { fields: { kanon_version: '0.39.0' } })).flat(),
      itemRow(200, { closed: ago(3), band: 'S' }),
    ];
    const v = views(rows);
    expect(v.byVersion.versions.map((x: Cells) => [x.version, x.items])).toEqual([['0.38.0', 12]]);
    expect((v.byVersion.versions as Cells[])[0]!.cost.median).toMatchObject({ n: 12, value: 2 });
    expect(v.byVersion.fewer).toEqual([{ version: '0.39.0', items: 5 }]);
    expect(v.byVersion.unversioned).toBe(1);
    expect(v.byVersion.minimum).toBe(MINIMUM.median);
    expect(renderViews(v).join('\n')).toMatch(/\| 0\.38\.0 \| 12 \|/);
  });
});

describe('the configuration A/B view (§6.1, decision 11)', () => {
  const OLD = 'aaaaaaaaaaaa';
  const NEW = 'bbbbbbbbbbbb';
  const SIZES = [100, 300, 800, 2000];
  /**
   * One arm: `n` items closed evenly over `days` ago, each with an implement run on fingerprint
   * `fp` and a review run on none. Cost grows with the diff, times `scale`, with a spread.
   */
  const arm = (fp: string, prFrom: number, n: number, o: { days: [number, number]; scale: number; size?: (k: number) => number; escaped?: (k: number) => boolean; unmerged?: (k: number) => boolean }) =>
    Array.from({ length: n }, (_, k) => {
      const pr = prFrom + k;
      const closed = o.days[0] + ((o.days[1] - o.days[0]) * k) / n;
      const lines = o.size ? o.size(k) : (SIZES[k % 4] as number);
      const cost = (o.scale * Math.sqrt(1 + lines) * (0.8 + (k % 5) * 0.1)) / 10;
      return [
        itemRow(pr, { closed: ago(closed), fate: o.unmerged?.(k) ? 'closed_unmerged' : 'merged', fields: { changed_lines: lines, changed_files: 1, changed_dirs: 1 }, ...(o.escaped?.(k) ? { fixDays: 5 } : {}) }),
        runRow('implement', { pr, at: ago(closed + 1), cost: cost * 0.8, fields: { config_fingerprint: fp } }),
        runRow('review', { pr, at: ago(closed + 0.5), cost: cost * 0.2 }),
      ];
    }).flat();
  const lane = (v: Cells, name: string) => v.ab.lanes.find((l: Cells) => l.lane === name);

  it('calls a change a win only when it is cheaper at equal size and its quality holds within the margins', () => {
    const rows = [
      ...arm(OLD, 1, 100, { days: [100, 160], scale: 1, escaped: (k) => k % 5 === 0 }),
      ...arm(NEW, 1001, 100, { days: [31, 95], scale: 0.7 }),
    ];
    const ab = lane(views(rows), 'implement');
    expect(ab).toMatchObject({ old: { fingerprint: OLD }, new: { fingerprint: NEW } });
    expect(ab.costAtEqualSize.ok).toBe(true);
    expect(ab.costAtEqualSize.pct).toBeCloseTo(-30, 0);
    expect(ab.costAtEqualSize.hiPct).toBeLessThan(0);
    expect(ab.yieldDifference.low).toBeGreaterThan(AB_MARGINS.yield);
    expect(ab.escapeDifference.high).toBeLessThan(AB_MARGINS.escape30);
    expect(ab.verdict).toBe('win');
    expect(ab.old.cost.median.status).toBe('ok');
    expect(ab.new.escape.rate).toMatchObject({ status: 'ok', n: 100, value: 0 });
    // A lane with one fingerprint, or none, has nothing to compare.
    expect(lane(views(rows), 'review')).toBeUndefined();
    expect(renderViews(views(rows)).join('\n')).toMatch(/\| implement \| aaaaaaaaaaaa → bbbbbbbbbbbb \| −30\.\d% \(/);
  });

  it('shows a cheaper configuration whose 30-day escape rate is not shown within +2 points as "cheaper, quality not shown to hold"', () => {
    // No escapes in either arm, but 100 items each: the difference's upper bound is above +2 points.
    const rows = [...arm(OLD, 1, 100, { days: [100, 160], scale: 1 }), ...arm(NEW, 1001, 100, { days: [31, 95], scale: 0.7 })];
    const ab = lane(views(rows), 'implement');
    expect(ab.costAtEqualSize.hiPct).toBeLessThan(0);
    expect(ab.escapeDifference.high).toBeGreaterThan(AB_MARGINS.escape30);
    expect(ab.verdict).toBe('cheaper-quality-not-shown');
    expect(renderViews(views(rows)).join('\n')).toMatch(/cheaper, quality not shown to hold/);
    expect(renderViews(views(rows)).join('\n')).not.toMatch(/\| win \|/);
  });

  it('holds yield to its margin: a cheaper configuration that merges less is not a win', () => {
    const rows = [
      ...arm(OLD, 1, 100, { days: [100, 160], scale: 1, escaped: (k) => k % 5 === 0 }),
      ...arm(NEW, 1001, 100, { days: [31, 95], scale: 0.7, unmerged: (k) => k % 4 === 1 }),
    ];
    const ab = lane(views(rows), 'implement');
    expect(ab.costAtEqualSize.hiPct).toBeLessThan(0);
    expect(ab.escapeDifference.high).toBeLessThan(AB_MARGINS.escape30);
    expect(ab.yieldDifference.low).toBeLessThan(AB_MARGINS.yield);
    expect(ab.verdict).toBe('cheaper-quality-not-shown');
  });

  it('controls for size: a configuration handed smaller work is not called cheaper for it', () => {
    // The same cost at each size, but the new arm got the S and M work: its raw median is lower.
    const rows = [
      ...arm(OLD, 1, 100, { days: [100, 160], scale: 1, size: (k) => (SIZES[2 + (k % 2)] as number) }),
      ...arm(NEW, 1001, 100, { days: [31, 95], scale: 1, size: (k) => (SIZES[k % 2] as number) }),
    ];
    const ab = lane(views(rows), 'implement');
    expect(ab.new.cost.median.value).toBeLessThan(ab.old.cost.median.value);
    expect(ab.costAtEqualSize.loPct).toBeLessThan(0);
    expect(ab.costAtEqualSize.hiPct).toBeGreaterThan(0);
    expect(ab.verdict).toBe('not-shown-cheaper');
  });

  it('compares the newest fingerprint with the one before it, and says "not enough data" below the minimums', () => {
    const rows = [
      ...arm('cccccccccccc', 1, 5, { days: [150, 160], scale: 1 }),
      ...arm(OLD, 101, 5, { days: [100, 110], scale: 1 }),
      ...arm(NEW, 201, 5, { days: [31, 40], scale: 1 }),
    ];
    const ab = lane(views(rows), 'implement');
    expect([ab.old.fingerprint, ab.new.fingerprint]).toEqual([OLD, NEW]);
    expect(ab.verdict).toBe('not-enough-data');
    expect(ab.old.firstRun < ab.new.firstRun).toBe(true);
  });

  it('leaves out an item whose runs in the lane ran on two fingerprints, and counts it', () => {
    const rows = [
      ...arm(OLD, 1, 12, { days: [100, 110], scale: 1 }),
      ...arm(NEW, 101, 12, { days: [31, 40], scale: 1 }),
      runRow('implement', { pr: 1, at: ago(100), cost: 1, fields: { config_fingerprint: NEW } }),
    ];
    const ab = lane(views(rows), 'implement');
    expect(ab.mixed).toBe(1);
    expect(ab.old.items).toBe(11);
  });
});

describe('the difference intervals (§6.1)', () => {
  it("Newcombe's hybrid score interval for a difference of two proportions", () => {
    // Newcombe (1998), method 10: 56/70 − 48/80 = 0.2000, 95% interval 0.0524 to 0.3339.
    const d = newcombe(56, 70, 48, 80);
    expect(d.value).toBeCloseTo(0.2, 6);
    expect(d.low).toBeCloseTo(0.0524, 3);
    expect(d.high).toBeCloseTo(0.3339, 3);
    // 0 of 50 against 0 of 50: the difference reaches ±7.1 points.
    expect(newcombe(0, 50, 0, 50).high).toBeCloseTo(0.0713, 3);
  });

  it('a two-sample bootstrap of new minus old, seeded', () => {
    const a = Array.from({ length: 40 }, (_, k) => k);
    const b = Array.from({ length: 40 }, (_, k) => k + 10);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const d = bootstrapDifference(a, b, mean);
    expect(d).toEqual(bootstrapDifference(a, b, mean));
    expect(d!.low).toBeLessThan(10);
    expect(d!.high).toBeGreaterThan(10);
    expect(d!.low).toBeGreaterThan(0);
  });
});

describe('kanon metrics report prints the views', () => {
  it('takes --windows, and prints the views after the headline, in Markdown and JSON', async () => {
    expect(parseReportArgs(['--rows', 'a', '--windows', '3']).windows).toBe(3);
    expect(() => parseReportArgs(['--rows', 'a', '--windows', '0'])).toThrow(/--windows/);
    const files: Record<string, string> = { 'rows.json': JSON.stringify(risingRows({ S: 12, M: 12, L: 12, XL: 12 })) };
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const status = await metrics(['report', ...argv], { out: (l) => out.push(l), err: () => {}, readFile: (p) => files[p] ?? null, release: () => 'v9.9.9', now: () => UNTIL });
      return { status, out: out.join('\n') };
    };
    const text = (await run(['--rows', 'rows.json', '--windows', '2'])).out;
    expect(text).toMatch(/### Trend, 2 windows of 28 days/);
    expect(text).toMatch(/### By Kanon version/);
    expect(text).toMatch(/### Configuration A\/B/);
    expect(text.indexOf('### Trend')).toBeGreaterThan(text.indexOf('| Indicator |'));
    const doc = JSON.parse((await run(['--rows', 'rows.json', '--windows', '2', '--json'])).out);
    expect(doc.trend).toHaveLength(2);
    expect(doc).toHaveProperty('byVersion.versions');
    expect(doc).toHaveProperty('ab.lanes');
    expect(doc).toHaveProperty('secondary.leadTime.cells.pooled');
    expect(doc.span).toEqual({ from: new Date(UNTIL.getTime() - 56 * DAY).toISOString().slice(0, 10), until: '2026-10-10', windows: 2, days: 28 });
  });
});
