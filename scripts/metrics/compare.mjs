// The comparisons the report's views and the aggregate's page view share (plan 0003 §6.1,
// kanon#669, kanon#1451): two arms' differences, new against old, cost at equal size, yield and the
// 30-day escape rate, with decision 11's quality margins; and the release comparison, each Kanon
// release against the one before it that has enough items.
//
// ONE IMPLEMENTATION. `kanon metrics report` (`views.mjs`) and the aggregate function's page view
// (`infra/telemetry/function/aggregate.mjs`, kanon#1453) both call `releaseComparisonOf`, so the
// public page and an adopter's own report decide a release the same way.
//
// IT IMPORTS ONLY ITS OWN DIRECTORY'S FILES (`indicators.mjs`, `stats.mjs`), so the aggregate
// function's package, which is zipped flat, can link it beside them, as it links `indicators.mjs`.
// The size-controlled fit comes in as an argument for the same reason: `fitPeriodEffect` lives in
// `scripts/lib/token-trend.mjs`, which the function links beside it. Pure: rows in, figures out.
//
// A RELEASE IS A WIN ONLY AS §6.1 SAYS A CONFIGURATION IS: its cost at equal size has an interval
// entirely below zero, AND its quality holds within decision 11's margins, new minus old. Cheaper
// alone is "cheaper, quality not shown to hold". A cost interval entirely above zero is "dearer";
// one that holds zero, "no measurable change". A release with fewer than the median's minimum of
// merged items is skipped and listed, never pooled with a neighbour (kanon#1451).

import { ESCAPE_DAYS, MINIMUM, cohortOf, compareVersions, escapedWithin, isCount, measure, pooledHeadline, round, yieldRatio } from './indicators.mjs';
import { bootstrapDifference, newcombe } from './stats.mjs';

/** @typedef {import('./indicators.mjs').RunRow} RunRow @typedef {import('./indicators.mjs').ItemRow} ItemRow */
/** @typedef {import('./indicators.mjs').Prepared} Prepared @typedef {import('./indicators.mjs').Measured} Measured */
/**
 * The size-controlled fit, `fitPeriodEffect` of `scripts/lib/token-trend.mjs`: log cost on
 * log(1 + changed lines) and the arm, the newer arm `current`. Its rows are `{ cost, lines, current }`.
 * @typedef {(rows: any[]) => ({ ok: true, n: number, pct: number, loPct: number, hiPct: number } | { ok: false, reason: string })} Fit
 */

/** Decision 11's quality margins for the A/B view, as differences new minus old (§6.1). */
export const AB_MARGINS = Object.freeze({ yield: -0.05, escape30: 0.02 });

/** What the release comparison calls a comparison (kanon#1451). */
export const RELEASE_VERDICTS = Object.freeze({
  win: 'win',
  'cheaper-quality-not-shown': 'cheaper, quality not shown to hold',
  'no-measurable-change': 'no measurable change',
  dearer: 'dearer',
  'not-enough-data': 'not enough data',
});

/**
 * Two arms' differences, new against old (§6.1): cost at equal size, yield and the 30-day escape
 * rate, rounded. What the A/B and the release comparison both decide on.
 * @param {Measured} older @param {Measured} newer
 * @param {{ noun: string, fit: Fit }} opts what an arm is, for the reason a fit can't be made, and the fit
 */
export function armDifferences(older, newer, { noun, fit }) {
  const costAtEqualSize = sizeControlledCost(older.costed, newer.costed, { noun, fit });
  const yieldDifference = yieldDiff(older.yieldUnits, newer.yieldUnits);
  const escapeDifference = escapeDiff(older.matured[30] ?? [], newer.matured[30] ?? []);
  return {
    costAtEqualSize: costAtEqualSize.ok
      ? { ok: /** @type {const} */ (true), status: /** @type {const} */ ('ok'), n: costAtEqualSize.n, pct: round(costAtEqualSize.pct), loPct: round(costAtEqualSize.loPct), hiPct: round(costAtEqualSize.hiPct) }
      : costAtEqualSize,
    yieldDifference: yieldDifference.status === 'ok' ? { ...yieldDifference, value: round(yieldDifference.value), low: round(yieldDifference.low), high: round(yieldDifference.high) } : yieldDifference,
    escapeDifference: escapeDifference.status === 'ok' ? { ...escapeDifference, value: round(escapeDifference.value), low: round(escapeDifference.low), high: round(escapeDifference.high) } : escapeDifference,
  };
}

/**
 * Whether quality is shown to hold within decision 11's margins, new minus old: yield's lower bound
 * above −5 points and the 30-day escape rate's upper bound below +2 points. Without it, cheaper is
 * never a win.
 * @param {ReturnType<typeof armDifferences>} d
 */
export const qualityHolds = (d) => d.yieldDifference.status === 'ok' && d.yieldDifference.low > AB_MARGINS.yield
  && d.escapeDifference.status === 'ok' && d.escapeDifference.high < AB_MARGINS.escape30;

/**
 * A release comparison's verdict from its differences: the one rule, which the report, the page
 * view and the page's check of the page view all apply (kanon#1451, kanon#1453).
 * @param {{ costAtEqualSize: { ok: boolean, loPct?: number, hiPct?: number }, yieldDifference: { status: string, low?: number }, escapeDifference: { status: string, high?: number } }} d
 * @returns {keyof typeof RELEASE_VERDICTS}
 */
export function releaseVerdict(d) {
  const c = d.costAtEqualSize;
  if (!c.ok) return 'not-enough-data';
  if (/** @type {number} */ (c.hiPct) < 0) return qualityHolds(/** @type {any} */ (d)) ? 'win' : 'cheaper-quality-not-shown';
  return /** @type {number} */ (c.loPct) > 0 ? 'dearer' : 'no-measurable-change';
}

/** The Kanon version a row carries, or null. @param {Record<string, unknown>} r */
const versionOf = (r) => (typeof r.kanon_version === 'string' ? r.kanon_version : null);

/**
 * The release comparison (kanon#1451): each Kanon release with at least the median's minimum of
 * merged items in the span, against the one before it that has as many, by the A/B's method with
 * the release as the arm. An item's release is the version its lanes pinned at its merge; a group
 * of runs that joins no item takes its last run's, as by version. `dev` is not a release: its items
 * are counted and left out. A release with fewer items is listed, and in neither arm.
 * @param {Prepared} ctx @param {{ start: number, end: number, fit: Fit }} opts
 */
export function releaseComparisonOf(ctx, { start, end, fit }) {
  const inSpan = (/** @type {number} */ t) => t >= start && t < end;
  const merged = ctx.items.filter((i) => i.fate === 'merged' && inSpan(Date.parse(i.closed_at)));
  /** @type {Map<string, string[]>} */
  const closedAt = new Map();
  for (const item of merged) {
    const v = versionOf(item);
    if (v === null || v === 'dev') continue;
    const list = closedAt.get(v) ?? [];
    closedAt.set(v, list);
    list.push(item.closed_at);
  }
  const ordered = [...closedAt.keys()].sort(compareVersions);
  const count = (/** @type {string} */ v) => /** @type {string[]} */ (closedAt.get(v)).length;
  const enough = ordered.filter((v) => count(v) >= MINIMUM.median);
  const lastRun = (/** @type {readonly RunRow[]} */ rs) => rs.reduce((a, b) => (a.recorded_at >= b.recorded_at ? a : b));
  const arm = (/** @type {string} */ v) => {
    const m = measure(ctx, { start, end, keepItem: (i) => versionOf(i) === v, keepRuns: (rs) => versionOf(lastRun(rs)) === v });
    const h = pooledHeadline(m);
    const times = [.../** @type {string[]} */ (closedAt.get(v))].sort();
    return {
      m,
      summary: { version: v, items: count(v), from: /** @type {string} */ (times[0]).slice(0, 10), until: /** @type {string} */ (times[times.length - 1]).slice(0, 10), cost: h.cost, yield: h.yield, escape: { rate: h.escape.d30 } },
    };
  };
  const arms = enough.map(arm);
  const comparisons = arms.slice(1).map((newer, k) => {
    const older = /** @type {(typeof arms)[number]} */ (arms[k]);
    const d = armDifferences(older.m, newer.m, { noun: 'release', fit });
    return { old: older.summary, new: newer.summary, ...d, verdict: releaseVerdict(d) };
  });
  return {
    minimum: MINIMUM.median,
    margins: AB_MARGINS,
    comparisons,
    fewer: ordered.filter((v) => count(v) < MINIMUM.median).map((v) => ({ version: v, items: count(v) })),
    dev: merged.filter((i) => versionOf(i) === 'dev').length,
  };
}

/**
 * Cost new against old at equal size (§6.1): the reference adopter's log-linear fit, log cost on
 * log(1 + changed lines) and the configuration, over merged items with a cost and a diff size.
 * The percentage is the configuration's effect, new against old, with its 95% interval. Each arm
 * needs the median's minimum of such items.
 * Below that, `not-enough-data` with the smaller count and the minimum; a fit the rows can't
 * identify, `no-fit` with the rows' count. Each failure carries its reason as a sentence, for the
 * report; the page view publishes the status and the counts alone.
 * @param {Measured['costed']} older @param {Measured['costed']} newer
 * @param {{ noun: string, fit: Fit }} opts what an arm is, a configuration or a release, and the fit
 * @returns {{ ok: true, n: number, pct: number, loPct: number, hiPct: number } | { ok: false, status: 'not-enough-data', n: number, minimum: number, reason: string } | { ok: false, status: 'no-fit', n: number, reason: string }}
 */
function sizeControlledCost(older, newer, { noun, fit }) {
  const sized = (/** @type {typeof older} */ cs, /** @type {boolean} */ current) => cs.filter((c) => isCount(c.item.changed_lines)).map((c) => ({ cost: c.cost, lines: c.item.changed_lines, current }));
  const a = sized(older, false);
  const b = sized(newer, true);
  const n = Math.min(a.length, b.length);
  if (n < MINIMUM.median) return { ok: false, status: 'not-enough-data', n, minimum: MINIMUM.median, reason: `not enough data (${n}): each ${noun} needs ${MINIMUM.median} merged items with a cost and a diff size, and they have ${a.length} and ${b.length}` };
  const e = fit(/** @type {any} */ ([...a, ...b]));
  return e.ok ? { ok: true, n: e.n, pct: e.pct, loPct: e.loPct, hiPct: e.hiPct } : { ok: false, status: 'no-fit', n: a.length + b.length, reason: e.reason };
}

/**
 * Yield new minus old, with a two-sample bootstrap interval. Each arm needs yield's minimum.
 * @param {readonly { cost: number, merged: boolean }[]} older @param {readonly { cost: number, merged: boolean }[]} newer
 */
function yieldDiff(older, newer) {
  const n = Math.min(older.length, newer.length);
  if (n < MINIMUM.yield) return { status: /** @type {const} */ ('not-enough-data'), n, minimum: MINIMUM.yield };
  const value = yieldRatio(newer) - yieldRatio(older);
  const ci = Number.isFinite(value) ? bootstrapDifference(older, newer, yieldRatio) : null;
  if (!ci) return { status: /** @type {const} */ ('no-spend'), n };
  return { status: /** @type {const} */ ('ok'), n, value, low: ci.low, high: ci.high };
}

/**
 * The 30-day escape rate new minus old, agent-authored items as the headline's, with Newcombe's
 * interval. Each arm needs the escape rate's minimum of matured items.
 * @param {readonly ItemRow[]} older @param {readonly ItemRow[]} newer
 */
function escapeDiff(older, newer) {
  const a = older.filter((i) => cohortOf(i) === 'agent');
  const b = newer.filter((i) => cohortOf(i) === 'agent');
  const n = Math.min(a.length, b.length);
  if (n < MINIMUM.escape) return { status: /** @type {const} */ ('not-enough-data'), n, minimum: MINIMUM.escape };
  const esc = escapedWithin(ESCAPE_DAYS[0]);
  const d = newcombe(b.filter(esc).length, b.length, a.filter(esc).length, a.length);
  return { status: /** @type {const} */ ('ok'), n, value: d.value, low: d.low, high: d.high };
}
