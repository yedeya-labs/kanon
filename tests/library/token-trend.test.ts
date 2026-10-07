import { describe, expect, it } from 'vitest';
import * as trend from '../../scripts/lib/token-trend.mjs';

// The fixtures are the moved tests' own, partial rows and items, as the reference adopter's
// untyped tests wrote them; the functions are read loosely here so each case keeps its shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial fixtures, read by known fields
type Loose = (...args: any[]) => any;
const { ADOPTION, REGRESSORS, TREND_ATTRIBUTES, median, parseSk, tQuantile95, windowLabel } = trend;
const { fitPeriodEffect, isRun, render, sizeControl, summarize, toRow, validateSizeRegressor } = trend as unknown as Record<string, Loose>;

/**
 * The weekly token-efficiency report (`token-trend.md`), moved from the reference adopter
 * (RA-2081) with its tests, and plan 0002 §6's changes for the hosted store (kanon#470): an arm
 * is a lane, the rows are `<key>#<lane>`'s, and only `tag: run` rows count. Its cutover-ledger
 * tests stayed behind with the ledger; the report names that blind spot instead.
 *
 * THE TEST THAT JUSTIFIES THE WHOLE FILE is `survives the work-size trap` below. Everything
 * else here is ordinary coverage; that one encodes the mistake this report exists to stop
 * making, which was made for real on 2026-09-19: the reviewer's median cost/run read 6%
 * lower after a change and the drop was entirely a work-size shift (median `changed_lines`
 * 478 -> 302). At equal diff size cost had RISEN. A report that prints raw medians finds a
 * win every week from mix alone.
 */
const NOW = Date.UTC(2026, 8, 19, 12, 0, 0); // 2026-09-19T12:00:00Z
const DAY = 86_400_000;

/** A `<key>#<lane>` item as DynamoDB returns it, a real run. `daysAgo` places it in this week or last. */
const item = (daysAgo: number, cost: number, lines: number | null, extra: Record<string, unknown> = {}) => {
  const d = new Date(NOW - daysAgo * DAY);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const sk = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return {
    sk: { S: `${sk}#1-1-0` },
    tag: { S: 'run' },
    outcome: { S: 'ok' },
    total_cost_usd: { N: String(cost) },
    ...(lines === null ? {} : { changed_lines: { N: String(lines) } }),
    ...extra,
  };
};

describe('reading the store', () => {
  it('parses the compact-ISO sort key, which Date.parse rejects', () => {
    expect(parseSk('20260919T161052Z')).toBe(Date.UTC(2026, 8, 19, 16, 10, 52));
    // Not a silent 0/NaN: an unparseable key must drop the row, not date it to 1970.
    expect(parseSk('2026-09-19T16:10:52Z')).toBeNull();
    expect(parseSk(undefined as unknown as string)).toBeNull();
  });

  it('computes a median without a dependency', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('reads the run\'s time from the first 16 characters of the hosted store\'s sort key (plan 0002 §6)', () => {
    expect(parseSk('20260919T161052Z#33679229731-1-42')).toBe(Date.UTC(2026, 8, 19, 16, 10, 52));
  });

  it('counts only real runs: a smoke or test row is no spend (plan 0002 §2.4)', () => {
    expect(isRun(item(1, 1, 1))).toBe(true);
    expect(isRun(item(1, 1, 1, { tag: { S: 'smoke' } }))).toBe(false);
    expect(isRun({ sk: { S: '20260919T000000Z' } })).toBe(false);
    const s = summarize([{ lane: 'review', items: [item(1, 4, 300), item(1, 100, 300, { tag: { S: 'test' } })] }], NOW);
    expect(s.arms[0]!.spend).toBe(4);
  });

  it('projects the store to the fields it reads, and the tag', () => {
    for (const f of ['sk', 'tag', 'outcome', 'total_cost_usd', 'changed_lines', 'issue_body_chars', 'config_fingerprint']) expect(TREND_ATTRIBUTES, f).toContain(f);
  });
});

describe('the size control', () => {
  it('survives the work-size trap: raw cost falls while cost at equal diff size rises', () => {
    // LAST WEEK: big diffs, cheap per unit of size.  THIS WEEK: small diffs, dearer per
    // unit of size. Raw medians fall; the truth is that the work got more expensive.
    const prev = [800, 900, 1000, 1100, 1200].map((l) => ({ cost: l * 0.004, lines: l, current: false }));
    const cur = [200, 250, 300, 350, 400].map((l) => ({ cost: l * 0.008, lines: l, current: true }));

    const rawPrev = median(prev.map((r) => r.cost))!;
    const rawCur = median(cur.map((r) => r.cost))!;
    expect(rawCur).toBeLessThan(rawPrev); // the misleading headline: cost "fell"

    const fit = fitPeriodEffect([...prev, ...cur]);
    expect(fit.ok).toBe(true);
    expect(fit.pct!).toBeGreaterThan(0); // the truth: dearer at equal size
    expect(fit.detected).toBe(true);
  });

  it('reports NOT DETECTED when the two periods are the same but noisy', () => {
    const mk = (current: boolean, jitter: number[]) =>
      jitter.map((j, i) => ({ cost: (100 + i * 50) * 0.005 * j, lines: 100 + i * 50, current }));
    const fit = fitPeriodEffect([
      ...mk(false, [0.7, 1.3, 0.8, 1.2, 1.0, 0.9, 1.1, 1.25]),
      ...mk(true, [1.2, 0.8, 1.15, 0.85, 1.05, 0.95, 0.9, 1.1]),
    ]);
    expect(fit.ok).toBe(true);
    expect(fit.detected).toBe(false);
  });

  it('refuses a fit it cannot identify rather than returning a confident number', () => {
    // All rows in one period: the coefficient is not identified. A singular solve that
    // returned a number anyway would be reported with an interval and believed.
    const oneSided = [1, 2, 3, 4, 5].map((l) => ({ cost: 1, lines: l * 100, current: true }));
    expect(fitPeriodEffect(oneSided)).toMatchObject({ ok: false });
    // Too few rows.
    expect(fitPeriodEffect([{ cost: 1, lines: 10, current: true }])).toMatchObject({ ok: false });
    // No size signal at all — the issue-triggered arms. NOT a silent fallback to raw.
    expect(fitPeriodEffect([{ cost: 1, lines: null, current: true }] as never)).toMatchObject({ ok: false });
  });
});

describe('the line the Overseer pastes', () => {
  const partitions = (items: Record<string, unknown>[]) => [{ lane: 'review', items }];

  it('never renders an empty read as a quiet week', () => {
    const line = render(summarize([{ lane: 'review', items: [] }], NOW));
    // BINDS THE HEADLINE, NOT JUST THE PARAGRAPH. A first version asserted only that
    // the word UNAVAILABLE appeared somewhere, and a mutation that reworded the headline
    // to "A quiet week across …" passed — the reassuring sentence and the caveat can
    // coexist, and the reader takes the headline. Anchor on the claim itself.
    const headline = line.split('\n').find((l: string) => l.includes('lane partition(s)')) ?? '';
    expect(headline).toMatch(/NO ROWS IN EITHER WEEK/);
    expect(headline).toMatch(/UNAVAILABLE, not as a quiet week/);
    expect(headline).not.toMatch(/quiet week across|all quiet/i);
    expect(line).not.toMatch(/\$0\.00 across/);
  });

  it('says UNAVAILABLE for a partition it could not read, rather than omitting it', () => {
    const s = summarize([
      { lane: 'review', items: [item(1, 2, 300), item(2, 2, 300), item(9, 2, 300), item(10, 2, 300)] },
      { lane: 'implement', items: [], error: 'AccessDenied' },
    ], NOW);
    expect(render(s)).toMatch(/UNAVAILABLE[\s\S]*implement[\s\S]*AccessDenied/);
  });

  it("the headline total CONTAINS the 'of which' figure, and covers every outcome", () => {
    // THE ARITHMETIC, NOT A SUBSTRING. The first version asserted only
    // `/\$16\.00 bought nothing/`, which passed happily while the headline total was
    // computed over the disjoint `ok` set — so the report could print "$20.00 … of which
    // $16.00", a total smaller than its own subset, and never state the real $36.50 bill.
    // `unavailable` and `not-reached` rows bill real money too (agent-telemetry.mjs: four
    // runs in the 2026-09-03 outage; an Opus cap still bills a Haiku pre-flight).
    const s = summarize(partitions([
      item(1, 10, 300),
      item(2, 10, 300),
      item(1, 9, 300, { outcome: { S: 'failed' } }),
      item(2, 7, 300, { outcome: { S: 'exhausted' } }),
      item(2, 0.5, null, { outcome: { S: 'unavailable' } }),
    ]), NOW);
    const arm = s.arms.find((a: { lane: string }) => a.lane === 'review')!;
    expect(arm.curN).toBe(2);        // comparable runs
    expect(arm.curAllN).toBe(5);     // runs that happened
    expect(arm.spend).toBe(36.5);    // the week's real bill
    expect(arm.wastedSpend).toBe(16.5);
    expect(arm.wastedSpend).toBeLessThan(arm.spend); // "of which" must mean of which

    const line = render(s);
    const m = line.match(/\*\*\$([\d.]+) across (\d+) run\(s\)\*\*, of which \*\*\$([\d.]+) produced nothing/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(36.5);
    expect(Number(m![2])).toBe(5);
    expect(Number(m![3])).toBe(16.5);
    expect(Number(m![3])).toBeLessThan(Number(m![1]));
  });

  it('shows an arm whose every run failed, instead of dropping it from the report', () => {
    // THE WEEK THIS REPORT IS MOST USEFUL. Presence used to be counted on `ok` rows, so an
    // arm that ran and failed every time was filtered out before the table — absent from
    // the rows, absent from the waste line, and the waste line then said "$0.00 / 0 failed".
    const s = summarize([
      { lane: 'review', items: [item(1, 10, 300), item(2, 10, 300)] },
      { lane: 'implement', items: [
        item(1, 40, null, { outcome: { S: 'failed' } }),
        item(2, 35, null, { outcome: { S: 'exhausted' } }),
      ] },
    ], NOW);
    const line = render(s);
    expect(line).toMatch(/`implement`/);
    expect(line).toMatch(/\$75\.00 produced nothing/);
    expect(line).not.toMatch(/\$0\.00 produced nothing/);
    const arm = s.arms.find((a: { lane: string }) => a.lane === 'implement')!;
    expect(arm.curAllN).toBe(2);
    expect(arm.spend).toBe(75);
  });

  it('states the share of spend it cannot size-control, so a silent gap is not read as calm', () => {
    // `implement` fires on `issues` and carries no changed_lines — ~40% of fleet spend
    // invisible to the size-controlled column.
    const s = summarize([
      { lane: 'review', items: [item(1, 1, 300), item(2, 1, 300), item(9, 1, 300), item(10, 1, 300)] },
      { lane: 'implement', items: [item(1, 50, null), item(9, 50, null)] },
    ], NOW);
    const line = render(s);
    expect(line).toMatch(/cannot be size-controlled/);
    expect(line).toMatch(/`implement`/);
  });

  it('names the arms whose claude_args changed this week, and says so when none did', () => {
    const fp = (h: string) => ({ config_fingerprint: { S: h } });
    const changed = summarize(partitions([
      item(9, 1, 300, fp('old')), item(10, 1, 300, fp('old')),
      item(1, 1, 300, fp('new')), item(2, 1, 300, fp('new')),
    ]), NOW);
    expect(render(changed)).toMatch(/Configuration changed this week[\s\S]*old → new/);

    const same = summarize(partitions([
      item(9, 1, 300, fp('same')), item(10, 1, 300, fp('same')),
      item(1, 1, 300, fp('same')), item(2, 1, 300, fp('same')),
    ]), NOW);
    expect(render(same)).toMatch(/No arm changed its `claude_args`/);
  });

  it('prints a sub-10% bound to one decimal, so a DETECTED result never shows a CI touching zero', () => {
    // A lower bound of +0.4% rendered as "+0%" reads as an interval containing zero,
    // contradicting the verdict printed beside it. The reader believes the number.
    const prev = Array.from({ length: 30 }, (_, i) => item(8 + (i % 6), 1.0 * (1 + (i % 5) * 0.01), 300 + i));
    const cur = Array.from({ length: 30 }, (_, i) => item(1 + (i % 6), 1.05 * (1 + (i % 5) * 0.01), 300 + i));
    const line = render(summarize(partitions([...prev, ...cur]), NOW));
    const m = line.match(/95% CI ([+-][\d.]+)%/);
    expect(m).not.toBeNull();
    if (/\*\*[+-][\d.]+%\*\* \(95% CI/.test(line)) expect(m![1]).not.toBe('+0');
  });

  it('carries the detection floor when an arm IS testable', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => item(8 + (i % 6), 1 + i * 0.05, 250 + i * 20)),
      ...Array.from({ length: 8 }, (_, i) => item(1 + (i % 6), 1 + i * 0.05, 250 + i * 20)),
    ];
    const line = render(summarize(partitions(rows), NOW));
    expect(line).toMatch(/Detection floor this week/);
    expect(line).toMatch(/noise, not a trend/);
  });

  it('STILL states the floor when nothing is testable — the branch a reader misreads as calm', () => {
    // Too few rows to fit anything. A spend table with no floor beside it reads as a
    // quiet, well-understood week when in fact the week answered nothing. The first
    // version of the script omitted the line entirely here, and this test is why it
    // does not: silence in this branch is the failure the whole report is shaped against.
    const s = summarize(partitions([item(1, 2, 300), item(2, 2, 320), item(9, 2, 300), item(10, 2, 320)]), NOW);
    const line = render(s);
    expect(line).toMatch(/Detection floor this week: NOTHING WAS TESTABLE/);
    expect(line).toMatch(/do not act on the spend column/);
  });

  it('warns that a step-env pin, a prompt edit and a Kanon upgrade are invisible to config_fingerprint', () => {
    // A prompt-cache TTL pinned through step `env:` never reaches claude_args and so never
    // changes the fingerprint. A reader attributing a movement to "no config change" would be
    // wrong. The reference adopter's cutover ledger, which named such changes, didn't move.
    const s = summarize(partitions([item(1, 2, 300), item(9, 2, 300)]), NOW);
    expect(render(s)).toMatch(/cannot see a change made through a step's `env:` rather than `claude_args`[^\n]*nor a prompt edit, nor a Kanon upgrade/);
  });
});

describe('the interval means what it says', () => {
  it('uses the t quantile, which at low df is far from 1.96', () => {
    // The fit is admitted at n = 5, i.e. df = 2, where the 95% quantile is 4.303. Using
    // 1.96 there makes the printed interval up to 2.2x too narrow and its true coverage
    // ~78-89% — a false-positive machine on exactly the thin arms nobody has a prior for.
    expect(tQuantile95(2)).toBeCloseTo(4.303, 3);
    expect(tQuantile95(5)).toBeCloseTo(2.571, 3);
    expect(tQuantile95(30)).toBeCloseTo(2.042, 3);
    expect(tQuantile95(200)).toBe(1.96); // normal limit, where it no longer decides anything
    expect(tQuantile95(0)).toBeCloseTo(12.706, 3); // degenerate df must not widen to nothing
  });

  it('a thin arm does NOT print DETECTED where the normal quantile would have', () => {
    // A FIRST VERSION OF THIS TEST WAS CIRCULAR and a mutation proved it: it derived the
    // z half-width FROM the t half-width (`half * 1.96 / t`), so `t > z` held by
    // construction and reverting the call site to 1.96 passed. This one pins the
    // behaviour instead — data whose t-statistic lands between 1.96 and t(5) = 2.571, so
    // the z interval excludes zero and the honest t interval does not.
    const lines = [100, 150, 200, 250];
    const jitPrev = [0, 0.01, -0.01, 0.005];
    const jitCur = [0.004, -0.006, 0.008, -0.002];
    const mk = (mult: number, jit: number[], current: boolean) =>
      lines.map((l, i) => ({ cost: l * 0.005 * mult * (1 + jit[i]), lines: l, current }));
    const fit = fitPeriodEffect([...mk(1, jitPrev, false), ...mk(1.015, jitCur, true)]);

    expect(fit.ok).toBe(true);
    expect(fit.n).toBe(8); // df = 5

    // The point estimate sits OUTSIDE a 1.96-se band and INSIDE the t band. If the call
    // site reverts to 1.96 this flips to detected and the test fails, which is the point.
    const halfWidth = Math.abs(fit.hiPct! - fit.loPct!) / 2;
    const se = halfWidth / tQuantile95(fit.n! - 3);
    expect(Math.abs(fit.pct!)).toBeGreaterThan(1.96 * se); // z would call it a finding
    expect(Math.abs(fit.pct!)).toBeLessThan(halfWidth);    // the honest band spans zero
    expect(fit.detected).toBe(false);
  });
});

describe('what the report admits it could not do', () => {
  it('gives the real reason each arm is untestable, rather than asserting one cause', () => {
    // The sentence used to hardcode "carry no changed_lines" for all four reasons
    // `fitPeriodEffect` can return, contradicting the table three lines above it.
    const s = summarize([
      { lane: 'review', items: [item(1, 5, 300), item(2, 5, 320)] },      // too few rows
      { lane: 'implement', items: [item(1, 50, null), item(9, 50, null)] }, // no size signal
    ], NOW);
    const line = render(s);
    expect(line).toMatch(/cannot be size-controlled:/);
    // Both distinct reasons are named, and the false blanket claim is gone.
    expect(line).toMatch(/carry both a cost and a diff size/);
    expect(line).not.toMatch(/— `review` carry no `changed_lines`/);
  });

  it('keeps the arm names and the error when EVERY partition is unreadable', () => {
    // The likeliest real failure (a role or table-name change) used to render as
    // "0 lane partition(s)" with the names and error text dropped by an early return.
    const s = summarize([
      { lane: 'review', items: [], error: 'AccessDeniedException' },
      { lane: 'implement', items: [], error: 'ResourceNotFoundException' },
    ], NOW);
    const line = render(s);
    expect(line).toMatch(/NO ROWS IN EITHER WEEK/);
    expect(line).toMatch(/of 2 attempted/);
    expect(line).toMatch(/AccessDeniedException/);
    expect(line).toMatch(/ResourceNotFoundException/);
  });

  it('partitions rows by the widened window', () => {
    // `--weeks` was in the usage line and parsed nowhere. A row 10 days old belongs to
    // the current period at 4 weeks and to the prior one at 1.
    const rows = [{ lane: 'review', items: [item(10, 3, 300), item(1, 3, 300)] }];
    const oneWeek = summarize(rows, NOW, 7 * 86_400_000).arms[0];
    const fourWeeks = summarize(rows, NOW, 28 * 86_400_000).arms[0];
    expect(oneWeek.curAllN).toBe(1);
    expect(fourWeeks.curAllN).toBe(2);
  });

  it('LABELS the widened window it measured, rather than always saying 7 days (RA-2102)', () => {
    // THE TEST ABOVE USED TO CARRY THIS NAME AND NEVER RENDERED, which is how the defect
    // shipped: `--weeks 4` widened the DATA window while every label stayed hardcoded, so
    // a 28-day figure printed under a heading that said 7 days. The name overstated what
    // it pinned. This one asserts the rendered string, which is the thing a reader gets.
    // ENOUGH ROWS TO REACH THE TESTABLE DETECTION-FLOOR BRANCH. A first version of this
    // fixture had two rows, so only the NOTHING-WAS-TESTABLE branch rendered — and a
    // mutation that fixed the heading while leaving the other branch saying "this week"
    // passed all 24 tests. Both branches carry a window label, so both must be exercised.
    const current = Array.from({ length: 6 }, (_, i) => item(2 + i * 4, 1 + i * 0.1, 200 + i * 40));
    const prior = Array.from({ length: 6 }, (_, i) => item(30 + i * 4, 1 + i * 0.1, 200 + i * 40));
    const rows = [{ lane: 'review', items: [...current, ...prior] }];
    const wide = render(summarize(rows, NOW, 28 * 86_400_000));

    expect(wide).toMatch(/## Token efficiency — 28 days to /);
    expect(wide).not.toMatch(/7 days to/);
    // The testable branch really is the one that rendered, so the assertions below bind it.
    expect(wide).toMatch(/Detection floor this 28-day period:\*\* the tightest arm/);
    // Every other window label moves with it, not just the heading.
    expect(wide).not.toMatch(/this week/);
    expect(wide).not.toMatch(/prior week/);
    expect(wide).toMatch(/28-day period/);

    // …and the other detection-floor branch is labelled too (too few rows to fit).
    const thin = render(summarize([{ lane: 'review', items: [item(20, 6, 300), item(1, 5, 300)] }], NOW, 28 * 86_400_000));
    expect(thin).toMatch(/\$11\.00 across 2 run\(s\)/); // both rows inside the widened window
    expect(thin).toMatch(/Detection floor this 28-day period: NOTHING WAS TESTABLE/);
    expect(thin).not.toMatch(/this week/);
  });

  it('labels the two branches the widened fixture above never reaches (RA-2115)', () => {
    // THE SAME HOLE RA-2102 CLOSED FOR THE DETECTION FLOOR, on two more branches: the test
    // above has active arms (so the no-rows branch never renders) and no fingerprints (so
    // only the "no arm changed" arm renders). Measured on RA-2114's head: re-hardcoding
    // either label to `week` left all 24 tests green. The `WEEK` assertions elsewhere run
    // at the default window, where `week` is the correct output, so they cannot see it.
    const WIDE = 28 * 86_400_000;

    const empty = render(summarize([{ lane: 'review', items: [] }], NOW, WIDE));
    expect(empty).toMatch(/NO ROWS IN EITHER 28-DAY PERIOD/);
    expect(empty).toMatch(/not as a quiet 28-day period/);
    expect(empty).not.toMatch(/week/i);

    // `changed.length` is truthy only when BOTH periods carry fingerprinted `ok` rows and
    // the two sets differ — so the fixture puts one on each side of the 28-day boundary.
    const fp = (h: string) => ({ config_fingerprint: { S: h } });
    const changed = render(summarize([{ lane: 'review', items: [
      item(40, 1, 300, fp('old')), item(45, 1, 320, fp('old')),
      item(3, 1, 300, fp('new')), item(9, 1, 320, fp('new')),
    ] }], NOW, WIDE));
    expect(changed).toMatch(/\*\*Configuration changed this 28-day period:\*\* `review` \(old → new\)/);
    expect(changed).not.toMatch(/this week/);
  });

  it('leaves the DEFAULT report byte-identical, since the scheduled run passes no flags', () => {
    // The Overseer's read invokes it at the default window, so the weekly report is the one
    // anybody reads. Deriving the label must not churn it: at 7 days the noun is "week".
    const rows = [{ lane: 'review', items: [item(1, 5, 300)] }];
    const weekly = render(summarize(rows, NOW, 7 * 86_400_000));
    expect(weekly).toMatch(/## Token efficiency — 7 days to /);
    expect(weekly).toMatch(/Detection floor this week/);
    expect(weekly).not.toMatch(/7-day period/);
  });

  it('derives the noun from the window rather than assuming one', () => {
    expect(windowLabel(7 * 86_400_000)).toEqual({ days: 7, noun: 'week' });
    expect(windowLabel(28 * 86_400_000)).toEqual({ days: 28, noun: '28-day period' });
    expect(windowLabel(86_400_000)).toEqual({ days: 1, noun: '1-day period' });
    // Never zero or negative: a label of "0 days" would be worse than the bug it replaces.
    expect(windowLabel(0).days).toBe(1);
  });
});

/**
 * RA-2137 — a size control for the issue-triggered arms, adopted only once the data earns it.
 *
 * `implement` + `triage-fix` are ~40% of fleet spend and carry no `changed_lines`. Their
 * rows now record the issue's size; the report may fit on it ONLY where `log(cost)` shows a
 * positive, non-trivial slope on it. Until then those arms stay not-size-controllable, and
 * nothing — least of all `num_turns` — stands in.
 */
describe('the issue-size control and its adoption test (RA-2137)', () => {
  /** A deterministic spread of issue sizes and a cost that follows `elasticity`. */
  const issueRows = (n: number, elasticity: number, current = false, noise = 0.15) =>
    Array.from({ length: n }, (_, i) => {
      const chars = 800 + ((i * 7919) % 9000);
      const wobble = 1 + noise * Math.sin(i * 12.9898);
      return { cost: 2 * (chars / 1000) ** elasticity * wobble, lines: null, issueChars: chars, current };
    });

  it('the regressor list is closed: diff and issue size, never turns or the agent\'s own diff', () => {
    expect(Object.keys(REGRESSORS).sort()).toEqual(['diff', 'issue']);
    // A row carrying ONLY outcome measures must give every regressor nothing to fit on.
    const outcomeOnly = { cost: 5, lines: null, issueChars: null, produced: 400, turns: 120, num_turns: 120 };
    for (const r of Object.values(REGRESSORS)) expect(r.x(outcomeOnly as never)).toBeNull();
    // And the store's `produced_lines` is read as `produced`, not as `lines`.
    const row = toRow({ sk: { S: '20260919T000000Z' }, produced_lines: { N: '400' }, issue_body_chars: { N: '3000' } });
    expect(row.lines).toBeNull();
    expect(row.produced).toBe(400);
    expect(row.issueChars).toBe(3000);
  });

  it('adopts a clear positive slope on enough runs', () => {
    const v = validateSizeRegressor(issueRows(ADOPTION.minN, 0.5));
    expect(v.n).toBe(ADOPTION.minN);
    expect(v.slope!).toBeGreaterThan(0.4);
    expect(v.lo!).toBeGreaterThan(0);
    expect(v.adopted).toBe(true);
  });

  it('refuses the same slope on too few runs', () => {
    const v = validateSizeRegressor(issueRows(ADOPTION.minN - 1, 0.5));
    expect(v.lo!).toBeGreaterThan(0); // the ONLY failing test is n
    expect(v.adopted).toBe(false);
    expect(v.reason).toMatch(/n=29 of the 30 needed/);
  });

  it('refuses a flat or negative slope — the first real measurement\'s shape', () => {
    expect(validateSizeRegressor(issueRows(40, -0.3)).adopted).toBe(false);
    expect(validateSizeRegressor(issueRows(40, 0, false, 0.4)).adopted).toBe(false);
  });

  it('refuses a big point slope whose interval still reaches zero', () => {
    const v = validateSizeRegressor(issueRows(ADOPTION.minN, 0.4, false, 0.8));
    expect(v.slope!).toBeGreaterThanOrEqual(ADOPTION.minSlope);
    expect(v.lo!).toBeLessThanOrEqual(0); // the ONLY failing test is the interval
    expect(v.adopted).toBe(false);
    expect(v.reason).toBe('its 95% interval reaches zero or below');
  });

  it('refuses a slope that is real but trivial', () => {
    // Nearly noiseless, so the interval sits well above zero: only the size test fails.
    const v = validateSizeRegressor(issueRows(60, 0.05, false, 0.001));
    expect(v.lo!).toBeGreaterThan(0);
    expect(v.slope!).toBeLessThan(ADOPTION.minSlope);
    expect(v.adopted).toBe(false);
    expect(v.reason).toMatch(/slope is under 0\.1/);
  });

  it('an arm with a diff size keeps the diff control, whatever its issue size says', () => {
    const rows = [...issueRows(10, 0.5, false), ...issueRows(10, 0.5, true)].map((r, i) => ({ ...r, lines: 100 + i * 10 }));
    const { effect, sizeCheck } = sizeControl(rows);
    expect(sizeCheck).toBeNull();
    expect(effect).toMatchObject({ ok: true, regressor: 'diff' });
  });

  it('an unvalidated issue size leaves the arm NOT size-controllable, with no proxy', () => {
    const rows = [...issueRows(20, -0.3, false), ...issueRows(20, -0.3, true)];
    const { effect, sizeCheck } = sizeControl(rows);
    expect(sizeCheck?.adopted).toBe(false);
    expect(effect.ok).toBe(false);
    expect(effect.reason).toMatch(/issue size has not passed the adoption test/);
  });

  it('a validated issue size becomes the control, and the report says which control it is', () => {
    const items = [
      ...issueRows(20, 0.6, false).map((r, i) => item(8 + (i % 5), r.cost, null, { issue_body_chars: { N: String(r.issueChars) } })),
      ...issueRows(20, 0.6, true).map((r, i) => item(1 + (i % 5), r.cost * 1.5, null, { issue_body_chars: { N: String(r.issueChars) } })),
    ];
    const s = summarize([{ lane: 'implement', items }], NOW);
    const arm = s.arms[0];
    expect(arm.sizeCheck?.adopted).toBe(true);
    expect(arm.effect).toMatchObject({ ok: true, regressor: 'issue', detected: true });
    const line = render(s);
    const tableRow = line.split('\n').find((l: string) => l.startsWith('| `implement`')) ?? '';
    expect(tableRow).toMatch(/at equal ISSUE size/);
    expect(line).toMatch(/\*\*Issue-size control:\*\* `implement` — slope \+0\.\d\d .*n=40: \*\*ADOPTED\*\*/);
  });

  it('prints the adoption test every week it is not passed, and still names the arm untestable', () => {
    const items = [
      ...issueRows(15, -0.3, false).map((r, i) => item(8 + (i % 5), r.cost, null, { issue_body_chars: { N: String(r.issueChars) } })),
      ...issueRows(15, -0.3, true).map((r, i) => item(1 + (i % 5), r.cost, null, { issue_body_chars: { N: String(r.issueChars) } })),
    ];
    const line = render(summarize([{ lane: 'implement', items }], NOW));
    expect(line).toMatch(/cannot be size-controlled:\*\* `implement` — no diff size, and its issue size has not passed/);
    expect(line).toMatch(/\*\*Issue-size control:\*\* `implement` — slope −0\.\d\d .*n=30: \*\*not adopted\*\* \(its 95% interval reaches zero or below; the slope is under 0\.1\)/);
    expect(line).not.toMatch(/at equal ISSUE size/);
  });

  it('prints no adoption line for arms that carry no issue size', () => {
    const line = render(summarize([{ lane: 'review', items: [item(1, 5, 300), item(2, 5, 320)] }], NOW));
    expect(line).not.toMatch(/Issue-size control/);
  });
});
