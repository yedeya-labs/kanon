import { describe, expect, it } from 'vitest';
import { LANES, validate } from '../../actions/agent-telemetry/schema.mjs';
import { EXIT, SCHEMA, parseReportArgs, parseRows } from '../../cli/metrics-report.mjs';
import { metrics } from '../../cli/metrics.mjs';
import { closingIssues, joinRuns } from '../../scripts/metrics/join.mjs';
import { DELIVERY_LANES, MINIMUM, OVERHEAD_LANES, metricsReport, renderReport, sortRows } from '../../scripts/metrics/report.mjs';
import { bootstrap, kendallTauB, orderStatisticInterval, quantile, wilson } from '../../scripts/metrics/stats.mjs';
import { UNTIL, ago, itemRow, mergedWithRuns, risingRows, runRow } from './helpers/metrics-rows.js';

/**
 * `kanon metrics report` (plan 0003 §7, M6, kanon#659): the report module, from fixture rows.
 * M6's falsifiable check is three tests here: a band with 9 items prints "not enough data (9)"
 * (§2.1); a window where cost falls with the band shows the pooled view with a warning (§3.6);
 * and the join of two PRs on one issue (§3.4).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the report's cells, read by known paths
type Cells = Record<string, any>;

const report = (rows: unknown[], days?: number) => metricsReport(rows, { until: UNTIL, ...(days ? { days } : {}) });
const md = (rows: unknown[]) => renderReport(report(rows)).join('\n');

describe('the fixtures', () => {
  it('are rows the telemetry schema accepts', () => {
    const rows = [...risingRows({ S: 2, M: 2, L: 2, XL: 2 }), itemRow(900, { closed: ago(3), issues: [7, 8], fixDays: 3, revertDays: 4, humanCr: 1 }), runRow('explore', { at: ago(2), cost: 1 })];
    for (const row of rows) expect(validate(row), JSON.stringify(row)).toEqual({ ok: true });
  });
});

describe('joining runs to work items (§3.4)', () => {
  // Issue 7 is closed by two PRs in turn: 101 closed unmerged ten days ago, 102 merged two days ago.
  const first = itemRow(101, { closed: ago(10), fate: 'closed_unmerged', issues: [7], band: 'S' });
  const second = itemRow(102, { closed: ago(2), issues: [7], band: 'S' });
  const before = runRow('implement', { issue: 7, at: ago(12), cost: 1 });
  const between = runRow('implement', { issue: 7, at: ago(5), cost: 2 });
  const after = runRow('implement', { issue: 7, at: ago(1), cost: 4 });

  it('sends an issue-only run recorded before the first close to the first PR only, and one between the closes to the second only', () => {
    expect(joinRuns([before, between], [first, second])).toEqual([101, 102]);
    // The order of the items doesn't matter.
    expect(joinRuns([before, between], [second, first])).toEqual([101, 102]);
  });

  it('joins a run after both closes to nothing, and a run naming a PR by its number alone', () => {
    expect(joinRuns([after], [first, second])).toEqual([null]);
    expect(joinRuns([runRow('review', { pr: 101, issue: 7, at: ago(1) })], [first, second])).toEqual([101]);
    expect(joinRuns([runRow('review', { pr: 555, at: ago(1) })], [first, second])).toEqual([null]);
  });

  it('breaks a tie on closed_at by the lowest PR number', () => {
    const a = itemRow(205, { closed: ago(2), issues: [9] });
    const b = itemRow(204, { closed: ago(2), issues: [9] });
    const run = runRow('triage', { issue: 9, at: ago(3) });
    expect(joinRuns([run], [a, b])).toEqual([204]);
    expect(joinRuns([run], [b, a])).toEqual([204]);
  });

  it('counts each run once: the report sums the first PR and the second apart', () => {
    const r = report([first, second, before, between]);
    expect(r.rows.runsJoined).toBe(2);
    expect(r.rows.runsUnjoined).toBe(0);
  });

  it('reads the stored list of closing issues', () => {
    expect(closingIssues('7,8,19')).toEqual([7, 8, 19]);
    expect(closingIssues(undefined)).toEqual([]);
    expect(closingIssues('')).toEqual([]);
  });
});

describe('minimum samples (§2.1, decision 11)', () => {
  it('prints "not enough data (9)" for a band with 9 items, and a number from 10', () => {
    const rows = risingRows({ S: 30, M: 9, L: 30, XL: 30 });
    const r = report(rows);
    expect(r.view).toBe('banded');
    expect((r.cost.cells as Cells).M.median).toEqual({ status: 'not-enough-data', n: 9, minimum: MINIMUM.median });
    expect((r.cost.cells as Cells).S.median.status).toBe('ok');
    expect(md(rows)).toMatch(/\| Cost per merged item, median \| [^|]+ \| not enough data \(9\) \|/);
    const ten = report(risingRows({ S: 30, M: 10, L: 30, XL: 30 }));
    expect((ten.cost.cells as Cells).M.median).toMatchObject({ status: 'ok', n: 10 });
  });

  it('holds p90 to 30 items, yield and proportions to 20, escape rates to 50', () => {
    const r = report(risingRows({ S: 29, M: 30, L: 19, XL: 20 }));
    const cells = r.cost.cells as Cells;
    expect(cells.S.p90).toEqual({ status: 'not-enough-data', n: 29, minimum: 30 });
    expect(cells.M.p90.status).toBe('ok');
    expect((r.yield.cells as Cells).L.yield).toEqual({ status: 'not-enough-data', n: 19, minimum: 20 });
    expect((r.yield.cells as Cells).XL.yield.status).toBe('ok');
    expect((r.approval.cells as Cells).L.rate.status).toBe('not-enough-data');
    expect((r.approval.cells as Cells).XL.rate.status).toBe('ok');
  });

  it('shows an escape rate pooled, with the band mix, when no band has 50 matured items', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, k) => itemRow(1 + k, { closed: ago(35 + (k % 20)), band: 'S', fixDays: k < 3 ? 10 : undefined })),
      ...Array.from({ length: 25 }, (_, k) => itemRow(100 + k, { closed: ago(35 + (k % 20)), band: 'L' })),
      ...risingRows({ S: 15, M: 15, L: 15, XL: 15 }, 500),
    ];
    const r = report(rows);
    expect(r.view).toBe('banded');
    const d30 = (r.escape as Cells).d30.agent;
    expect(d30.S.rate).toEqual({ status: 'not-enough-data', n: 30, minimum: 50 });
    expect(d30.pooled.rate).toMatchObject({ status: 'ok', n: 55, value: Math.round((3 / 55) * 1e4) / 1e4 });
    expect(d30.pooled.bandMix).toEqual({ S: 30, M: 0, L: 25, XL: 0, none: 0 });
  });
});

describe('the band validity check (§3.6)', () => {
  it('keeps the banded view when cost rises with the band', () => {
    const r = report(risingRows({ S: 20, M: 20, L: 20, XL: 20 }));
    expect(r.validity.status).toBe('valid');
    expect(r.validity.low).toBeGreaterThan(0);
    expect(r.warnings).toEqual([]);
    expect(Object.keys(r.cost.cells)).toEqual(['S', 'M', 'L', 'XL', 'pooled']);
  });

  it('replaces the banded view with the pooled one, and a warning, when cost falls with the band', () => {
    const base = { S: 10, M: 6, L: 3, XL: 1 } as const;
    const rows = (['S', 'M', 'L', 'XL'] as const).flatMap((band, b) =>
      Array.from({ length: 20 }, (_, k) => mergedWithRuns(1 + b * 100 + k, band, base[band] * (0.8 + (k % 5) * 0.1), 1 + k, { verdict: 'approved' })).flat());
    const r = report(rows);
    expect(r.validity.status).toBe('invalid');
    expect(r.validity.tau).toBeLessThan(0);
    expect(r.view).toBe('pooled');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/validity check failed.*pooled view is shown/);
    for (const cells of [r.cost.cells, r.yield.cells, r.approval.cells, r.correction.cells, (r.escape as Cells).d30.agent]) {
      expect(Object.keys(cells).filter((k) => ['S', 'M', 'L', 'XL'].includes(k))).toEqual([]);
    }
    expect((r.cost.cells as Cells).pooled.median.status).toBe('ok');
    const text = renderReport(r).join('\n');
    expect(text).toMatch(/> \*\*Warning:\*\* The band validity check failed/);
    expect(text).toMatch(/\| Indicator \| No PR \| Pooled \|/);
    expect(text).not.toMatch(/\| S \|/);
  });

  it('shows the pooled view, with a warning, when there is too little to check', () => {
    const r = report(risingRows({ S: 3, M: 3, L: 0, XL: 0 }));
    expect(r.validity.status).toBe('not-enough-data');
    expect(r.view).toBe('pooled');
    expect(r.warnings[0]).toMatch(/could not run/);
  });
});

describe('the indicators', () => {
  it('sums every delivery run of a merged item into its cost, overhead beside it, and smoke rows nowhere', () => {
    const rows = [
      itemRow(1, { closed: ago(2), band: 'S' }),
      runRow('implement', { pr: 1, at: ago(4), cost: 1 }),
      runRow('implement-revise', { pr: 1, at: ago(3), cost: 0.5 }),
      runRow('review', { pr: 1, at: ago(3), cost: 0.25 }),
      runRow('implement', { pr: 1, at: ago(3), cost: 100, tag: 'smoke' }),
      runRow('explore', { at: ago(5), cost: 2 }),
      runRow('overseer', { at: ago(6), cost: 3 }),
    ];
    const r = report(rows);
    expect(r.cost.overhead).toEqual({ runs: 2, usd: 5 });
    expect(r.rows.ignored.notRun).toBe(1);
    expect((r.cost.cells as Cells).pooled.bandMix).toEqual({ S: 1, M: 0, L: 0, XL: 0, none: 0 });
  });

  it('computes yield over settled items, with runs that never reached a PR in their own column', () => {
    const rows = [
      ...risingRows({ S: 20, M: 20, L: 20, XL: 20 }),
      // Twenty closed-unmerged S items, each costing $1: S's yield is its merged cost over all.
      ...Array.from({ length: 20 }, (_, k) => [itemRow(600 + k, { closed: ago(3), fate: 'closed_unmerged', band: 'S' }), runRow('implement', { pr: 600 + k, at: ago(4), cost: 1 })]).flat(),
      // Twenty issues whose runs never reached a PR, idle 30 days inside the window.
      ...Array.from({ length: 20 }, (_, k) => runRow('implement', { issue: 800 + k, at: ago(31 + (k % 20)), cost: 2 })),
      // One still active: not settled, so in no cell.
      runRow('implement', { issue: 900, at: ago(1), cost: 50 }),
    ];
    const r = report(rows);
    const cells = r.yield.cells as Cells;
    const sMerged = 20 * 1 * (0.8 + 0.1 * 2); // risingRows' S costs average $1
    expect(cells.S.yield.value).toBeCloseTo(sMerged / (sMerged + 20), 3);
    expect(cells.S.yield.low).toBeLessThanOrEqual(cells.S.yield.value);
    expect(cells.S.yield.high).toBeGreaterThanOrEqual(cells.S.yield.value);
    expect(cells.noPr.yield).toMatchObject({ status: 'ok', n: 20, value: 0 });
    expect(cells.pooled.bandMix.noPr).toBe(20);
  });

  it('counts an escape only once its window has passed, and only by an explicit revert or fix inside it', () => {
    const matured = (k: number, extra: Partial<Parameters<typeof itemRow>[1]>) => itemRow(1 + k, { closed: ago(40 + (k % 10)), band: 'M', ...extra });
    const rows = [
      ...Array.from({ length: 50 }, (_, k) => matured(k, k === 0 ? { fixDays: 12 } : k === 1 ? { revertDays: 45 } : k === 2 ? { author: 'human', fixDays: 1 } : {})),
      // Merged 10 days ago, with a fix: not matured at 30 days, so in no cell.
      itemRow(99, { closed: ago(10), band: 'M', fixDays: 2 }),
    ];
    const r = report(rows);
    const d30 = (r.escape as Cells).d30;
    expect(d30.agent.pooled.rate).toEqual({ status: 'not-enough-data', n: 49, minimum: 50 });
    const more = report([...rows, matured(60, {})]);
    expect((more.escape as Cells).d30.agent.pooled.rate).toMatchObject({ status: 'ok', n: 50, value: 0.02 });
    expect((more.escape as Cells).d30.human.pooled.rate).toEqual({ status: 'not-enough-data', n: 1, minimum: 50 });
    expect((more.escape as Cells).d30).toMatchObject({ mergedFrom: '2026-08-13', mergedUntil: '2026-09-10' });
  });

  it('reads first-review approval over items with a verdict, and human corrections over agent-authored items', () => {
    const rows = [
      ...risingRows({ S: 20, M: 20, L: 20, XL: 20 }),
      itemRow(700, { closed: ago(2), band: 'S', verdict: 'none', humanCommits: 0, humanCr: 0 }),
      itemRow(701, { closed: ago(2), band: 'S', author: 'human', verdict: 'approved' }),
      itemRow(702, { closed: ago(2), band: 'S', verdict: 'approved', humanCr: 0 }), // correction unknown
    ];
    const r = report(rows);
    const approval = (r.approval.cells as Cells).pooled.rate;
    expect(approval.n).toBe(82);
    expect(approval.value).toBeCloseTo((60 + 2) / 82, 3);
    const correction = (r.correction.cells as Cells).pooled.rate;
    expect(correction.n).toBe(81);
    expect(correction.value).toBeCloseTo((4 * 4) / 81, 3);
  });

  it("bands every item with the newest version from its counts, never the row's stored band", () => {
    const stale = { ...itemRow(1, { closed: ago(2), band: 'S' }), band: 'XL' };
    const r = report([stale, runRow('implement', { pr: 1, at: ago(3), cost: 1 })]);
    expect((r.cost.cells as Cells).pooled.bandMix).toEqual({ S: 1, M: 0, L: 0, XL: 0, none: 0 });
    expect(r.bandVersion).toBe(1);
  });

  it('is the same report every time: the bootstrap is seeded', () => {
    const rows = risingRows({ S: 25, M: 25, L: 25, XL: 25 });
    expect(report(rows)).toEqual(report(rows));
  });

  it('splits the lanes into delivery and overhead, every lane in exactly one', () => {
    expect([...DELIVERY_LANES, ...OVERHEAD_LANES].sort()).toEqual([...LANES].sort());
    expect(OVERHEAD_LANES.filter((l) => !LANES.includes(l))).toEqual([]);
  });

  it('reads rows of every kind and tag, and counts the ones it can not use', () => {
    const s = sortRows([null, [], { row_kind: 'finding', tag: 'run' }, { row_kind: 'work_item', tag: 'run', pr_number: 1 }, itemRow(2, { closed: ago(1) }), itemRow(2, { closed: ago(0.5) })]);
    expect(s.ignored).toEqual({ notRun: 0, otherKind: 1, unreadable: 3 });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]?.closed_at).toBe(ago(0.5));
  });
});

describe('the intervals (§2.2 to §2.4)', () => {
  const ranks = (n: number) => Array.from({ length: n }, (_, k) => k + 1);

  it('order statistics: a median from n = 6, a p90 from n = 29, the p90 at 30 reaching the maximum', () => {
    expect(orderStatisticInterval(ranks(5), 0.5)).toBeNull();
    expect(orderStatisticInterval(ranks(6), 0.5)).toMatchObject({ low: 1, high: 6 });
    expect(orderStatisticInterval(ranks(28), 0.9)).toBeNull();
    expect(orderStatisticInterval(ranks(29), 0.9)).toMatchObject({ high: 29 });
    expect(orderStatisticInterval(ranks(29), 0.9)!.coverage).toBeGreaterThanOrEqual(0.95);
    expect(orderStatisticInterval(ranks(30), 0.9)?.high).toBe(30);
    for (const n of [10, 30, 100, 400]) expect(orderStatisticInterval(ranks(n), 0.5)!.coverage).toBeGreaterThanOrEqual(0.95);
  });

  it('nearest-rank quantiles', () => {
    expect(quantile(ranks(10), 0.9)).toBe(9);
    expect(quantile(ranks(30), 0.9)).toBe(27);
  });

  it('Wilson: 0 of 50 is 0% to 7.1%', () => {
    const w = wilson(0, 50);
    expect(w.low).toBe(0);
    expect(w.high).toBeCloseTo(0.0713, 3);
  });

  it("Kendall's τ-b: +1 rising, −1 falling, with ties", () => {
    const rise = [0, 1, 2, 3].flatMap((g) => [{ group: g, value: g + 1 }, { group: g, value: g + 1 }]);
    expect(kendallTauB(rise)).toBeCloseTo(1, 6);
    // Spread inside a band is a tie on one side only, so τ-b falls below 1: 24 concordant of 28 pairs.
    const spread = [0, 1, 2, 3].flatMap((g) => [{ group: g, value: g + 1 }, { group: g, value: g + 1.5 }]);
    expect(kendallTauB(spread)).toBeCloseTo(24 / Math.sqrt(24 * 28), 6);
    expect(kendallTauB(rise.map((p) => ({ ...p, value: -p.value })))).toBeCloseTo(-1, 6);
    expect(Number.isNaN(kendallTauB([{ group: 0, value: 1 }, { group: 0, value: 2 }]))).toBe(true);
  });

  it('a bootstrap with the same seed draws the same interval', () => {
    const units = ranks(40);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(bootstrap(units, mean)).toEqual(bootstrap(units, mean));
    expect(bootstrap(units, mean, { seed: 1 })).not.toEqual(bootstrap(units, mean, { seed: 2 }));
  });
});

describe('kanon metrics report, the command', () => {
  const rows = [...risingRows({ S: 20, M: 9, L: 20, XL: 20 }), runRow('explore', { at: ago(2), cost: 1.5 })];
  const files: Record<string, string> = {
    'rows.json': JSON.stringify(rows),
    'rows.jsonl': rows.map((r) => JSON.stringify(r)).join('\n'),
    'wrapped.json': JSON.stringify({ rows }),
    'broken.jsonl': '{"tag":"run"}\nnot json\n',
  };
  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const status = metrics(['report', ...argv], {
      out: (l) => out.push(l), err: (l) => err.push(l), readFile: (p) => files[p] ?? null,
      release: () => 'v9.9.9', now: () => UNTIL,
    });
    return status.then((s) => ({ status: s, out: out.join('\n'), err: err.join('\n') }));
  };

  it('prints the report as Markdown, a band with 9 items as "not enough data (9)"', async () => {
    const r = await run(['--rows', 'rows.json']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^## Kanon metrics, 2026-09-12 to 2026-10-10 \(28 days, by close date\)/);
    expect(r.out).toMatch(/API list price/);
    expect(r.out).toMatch(/not enough data \(9\)/);
  });

  it('prints one JSON document with --json, the same from a JSON array, JSON Lines and a wrapped array', async () => {
    const docs = await Promise.all(['rows.json', 'rows.jsonl', 'wrapped.json'].map((f) => run(['--rows', f, '--json'])));
    const parsed = docs.map((d) => JSON.parse(d.out));
    expect(parsed[0]).toMatchObject({ schema: SCHEMA, kanon: 'v9.9.9', status: 'ok', exitCode: 0, view: 'banded', bandVersion: 1, costBasis: 'API list price' });
    expect(parsed[1]).toEqual(parsed[0]);
    expect(parsed[2]).toEqual(parsed[0]);
  });

  it('reads several files, and takes the window from --until and --days', async () => {
    const r = JSON.parse((await run(['--rows', 'rows.json', '--rows', 'wrapped.json', '--until', '2026-10-01', '--days', '7', '--json'])).out);
    expect(r.window).toEqual({ from: '2026-09-24', until: '2026-10-01', days: 7 });
  });

  it('says "pooled" in the status when the validity check swapped the view', async () => {
    files['few.json'] = JSON.stringify(risingRows({ S: 2, M: 2, L: 0, XL: 0 }));
    const r = JSON.parse((await run(['--rows', 'few.json', '--json'])).out);
    expect(r).toMatchObject({ status: 'pooled', exitCode: 0, view: 'pooled' });
  });

  it('stops with exit 3, naming the file and not its content, when a file is missing or not rows', async () => {
    const missing = await run(['--rows', 'nope.json', '--json']);
    expect(missing.status).toBe(EXIT.error);
    expect(JSON.parse(missing.out)).toEqual({ schema: SCHEMA, kanon: 'v9.9.9', status: 'error', exitCode: EXIT.error, error: 'nope.json is not a file that can be read' });
    const broken = await run(['--rows', 'broken.jsonl']);
    expect(broken.status).toBe(EXIT.error);
    expect(broken.err).toMatch(/broken\.jsonl is not JSON rows: line 2/);
    expect(broken.err).not.toMatch(/not json\b(?! rows)/);
  });

  it('refuses bad arguments with exit 2', async () => {
    expect(() => parseReportArgs([])).toThrow(/--rows <file> is required/);
    expect(() => parseReportArgs(['--rows', 'a', '--until', '2026-02-30'])).toThrow(/takes a date/);
    expect(() => parseReportArgs(['--rows', 'a', '--days', '0'])).toThrow(/--days/);
    expect(() => parseReportArgs(['--rows', 'a', '--bogus'])).toThrow(/unknown argument/);
    const usage = await run(['--json']);
    expect(usage.status).toBe(EXIT.usage);
    expect(JSON.parse(usage.out)).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: EXIT.usage });
    const help = await run(['--help']);
    expect(help.status).toBe(EXIT.ok);
    expect(help.out).toMatch(/not enough data \(N\)/);
  });

  it('parses an empty file as no rows', () => {
    expect(parseRows('', 'x')).toEqual([]);
    expect(parseRows('{"a":1}', 'x')).toEqual([{ a: 1 }]);
  });
});
