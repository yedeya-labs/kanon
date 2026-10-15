// The report module (plan 0003 §7, M6): the three headline indicators by complexity band, from one
// adopter's stored rows. Rows in, report out: no network, no file, no clock but the `until` it is
// given (`K-SELF-8`). `kanon metrics report` prints it; the Overseer's weekly job runs it (kanon#668).
//
// THE THREE, ALWAYS TOGETHER (§2.1, decision 5): cost per merged work item (§2.2), yield (§2.3)
// and the escaped-defect rate (§2.4), with first-review approval and the human-correction rate
// beside it. Each cell is by band, plus pooled with the band mix printed beside it.
//
// A CELL BELOW ITS MINIMUM IS "NOT ENOUGH DATA (N)", never a number (§2.1, decision 11): medians
// from 10 items, p90 from 30, proportions and yield from 20, escape rates from 50. Every interval
// is 95%: order statistics for cost, a seeded bootstrap for yield, Wilson for proportions.
//
// THE BAND VALIDITY CHECK (§3.6). A band is a control only if cost rises with it. Every report
// computes Kendall's τ-b between band and cost per merged item, with its interval; unless the
// interval sits entirely above zero, the banded cells are withheld and the pooled view is shown,
// with a warning, never banded cells as if they meant something.
//
// THE BAND IS RECOMPUTED with the newest version (`BAND_VERSION`) from each row's stored counts,
// never read from the row's own `band`, so a view never mixes versions (§3.6, "Versioning").
//
// RUNS JOIN ITEMS through `joinRuns` (§3.4), the one join every reader uses. Only `tag: run` rows
// count (§2.1). Cost is the API list price the agent CLI reports (decision 1), and is labelled so.

import { LANES } from '../../actions/agent-telemetry/schema.mjs';
import { BAND_VERSION, BANDS } from './band.mjs';
import {
  MINIMUM, WINDOW_DAYS, bandKey, cellsByBand, costOf, deliveryLanes, headlineCells, isCount, measure, prepareRows as prepare, quantileEstimate, round,
} from './indicators.mjs';
import { cacheSavings, priceOf } from './prices.mjs';
import { STAGE_FIELDS } from './stages.mjs';
import { RESAMPLES, SEED } from './stats.mjs';

export {
  ESCAPE_DAYS, IDLE_DAYS, LEAD_LANES, MINIMUM, OVERHEAD_LANES, WINDOW_DAYS, cohortOf, escapedWithin, isCount, measure, pooledHeadline, round, roundOrNull,
  sortRows, yieldRatio,
} from './indicators.mjs';

/** The delivery lanes: the schema's lanes declared delivery (§2.2, §2.3). Loading this throws if one is on neither side. */
export const DELIVERY_LANES = deliveryLanes(LANES);

/**
 * @typedef {import('./indicators.mjs').RunRow} RunRow
 * @typedef {import('./indicators.mjs').ItemRow} ItemRow
 * @typedef {import('./indicators.mjs').Estimate} Estimate
 * @typedef {import('./indicators.mjs').BandKey} BandKey
 * @typedef {import('./indicators.mjs').Measured} Measured
 */

/** Days to milliseconds. */
const DAY_MS = 86_400_000;

/**
 * One adopter's rows, sorted and joined once, with the schema's delivery lanes
 * (`indicators.mjs`'s `prepareRows`).
 * @param {readonly unknown[]} rows
 */
export const prepareRows = (rows) => prepare(rows, DELIVERY_LANES);

/** @typedef {ReturnType<typeof prepareRows>} Prepared */

const delivery = (/** @type {RunRow} */ r) => DELIVERY_LANES.includes(r.lane);
const hasCost = (/** @type {RunRow} */ r) => typeof r.total_cost_usd === 'number';

/** The stages of the lead time, in the order that wins an overlap (§3.3, group 2). */
const STAGES = /** @type {readonly (keyof typeof STAGE_FIELDS)[]} */ (Object.keys(STAGE_FIELDS));

/**
 * A median (and a p90, when asked) of the values a cell's units carry.
 * @param {readonly { value: number }[]} us @param {{ p90?: boolean }} [opts]
 */
const quantiles = (us, { p90 = false } = {}) => {
  const sorted = us.map((u) => u.value).sort((a, b) => a - b);
  return { median: quantileEstimate(sorted, 0.5, MINIMUM.median), ...(p90 ? { p90: quantileEstimate(sorted, 0.9, MINIMUM.p90) } : {}) };
};

/**
 * Cache savings over the runs recorded in a window, every lane's, at list price (§4, group 8):
 * the dollars saved by the runs the price table prices, what share that is of what they would
 * have cost uncached, and the runs it can't price, with the models it doesn't hold.
 * @param {readonly RunRow[]} runs
 */
function cacheSavingsOf(runs) {
  let usd = 0;
  let paid = 0;
  let priced = 0;
  let unpriced = 0;
  /** @type {Set<string>} */
  const models = new Set();
  for (const run of runs) {
    const saved = cacheSavings(run);
    if (saved === null) {
      unpriced += 1;
      if (typeof run.model === 'string' && !priceOf(run.model, run.recorded_at)) models.add(run.model);
      continue;
    }
    priced += 1;
    usd += saved;
    paid += typeof run.total_cost_usd === 'number' ? run.total_cost_usd : 0;
  }
  return { usd: round(usd), runs: priced, share: usd + paid > 0 ? round(usd / (usd + paid)) : null, unpriced, unpricedModels: [...models].sort() };
}

/**
 * The report.
 * @param {readonly unknown[]} rows one adopter's stored rows, run and work-item, in any order
 * @param {{ until: Date, days?: number }} opts the window ends at `until` (not included) and
 *   reaches back `days`
 */
export function metricsReport(rows, { until, days = WINDOW_DAYS }) {
  const end = until.getTime();
  const start = end - days * DAY_MS;
  const inWindow = (/** @type {number} */ t) => t >= start && t < end;
  const ctx = prepareRows(rows);
  const { runs, items, ignored, joined, runsOf } = ctx;
  const m = measure(ctx, { start, end });
  const { merged, costed } = m;

  // Overhead: the overhead lanes' runs, and the Lead's runs that join no item (§3.4).
  const overheadRuns = runs.filter((r, k) => (!delivery(r) || ctx.unjoinedLead(r, k)) && inWindow(Date.parse(r.recorded_at)));

  // ── The headline, by band where the validity check holds (§3.6, §2.2 to §2.4) ───────────────
  const headline = headlineCells(m);
  const { bandsSeen, ...validity } = headline.validity;
  const banded = headline.view === 'banded';
  /** @type {string[]} */
  const warnings = [];
  if (!banded) {
    // With two bands or more, τ goes uncomputed only when every cost is tied (kanon#719).
    const failed = validity.tau === null
      ? "Kendall's τ between band and cost is not computed, because every merged item's cost is the same, so cost is not shown to rise with the band in this window"
      : `Kendall's τ between band and cost is ${validity.tau}, and its 95% interval (${validity.low ?? '?'} to ${validity.high ?? '?'}) does not sit entirely above zero, so cost does not rise with the band in this window`;
    warnings.push(validity.status === 'invalid'
      ? `The band validity check failed: ${failed}. The pooled view is shown instead of the banded one.`
      : `The band validity check could not run: it needs ${MINIMUM.validity} merged items with a cost and a band, in at least two bands, and has ${validity.n} in ${bandsSeen}. The pooled view is shown instead of the banded one.`);
  }

  /** @template {Record<string, any>} T @param {T} cells */
  const view = (cells) => (banded ? cells : Object.fromEntries(Object.entries(cells).filter(([k]) => k === 'pooled' || k === 'noPr')));

  // ── The secondary measures (§2.2, §2.3) ────────────────────────────────────────────────────
  // Beside cost: cost per acceptance criterion, over the costed items that have criteria, and
  // cache savings. Beside yield: review rounds to approval, the lead time to merge with its stages,
  // and human wait, over merged items that carry each. Each follows the view, as the indicators do.
  const withAc = costed.filter((c) => isCount(c.item.ac_count) && /** @type {number} */ (c.item.ac_count) > 0)
    .map((c) => ({ band: c.band, value: c.cost / /** @type {number} */ (c.item.ac_count) }));
  /** @param {string} field */
  const carrying = (field) => merged.filter((i) => isCount(i[field]))
    .map((i) => ({ item: i, band: bandKey(i), value: /** @type {number} */ (i[field]) }));
  // Rounds to approval: an item with no Reviewer verdict has none (`review_rounds` 0).
  const rounds = carrying('review_rounds').filter((u) => u.value >= 1);
  const leadCell = (/** @type {{ item: ItemRow, value: number }[]} */ us) => ({
    ...quantiles(us, { p90: true }),
    stages: Object.fromEntries(STAGES.map((st) => [st, quantiles(us.filter((u) => isCount(u.item[STAGE_FIELDS[st]])).map((u) => ({ value: /** @type {number} */ (u.item[STAGE_FIELDS[st]]) })), { p90: true })])),
  });
  const secondary = {
    costPerAc: { cells: view(cellsByBand(withAc, (u) => u.band, (us) => quantiles(us))) },
    cacheSavings: cacheSavingsOf(runs.filter((r) => inWindow(Date.parse(r.recorded_at)))),
    reviewRounds: { cells: view(cellsByBand(rounds, (u) => u.band, (us) => quantiles(us))) },
    leadTime: { cells: view(cellsByBand(carrying('lead_time_s'), (u) => u.band, leadCell)) },
    humanWait: { cells: view(cellsByBand(carrying('t_human_s'), (u) => u.band, (us) => quantiles(us))) },
  };

  return {
    window: { from: new Date(start).toISOString().slice(0, 10), until: new Date(end).toISOString().slice(0, 10), days },
    bandVersion: BAND_VERSION,
    costBasis: 'API list price',
    view: headline.view,
    warnings,
    rows: {
      runs: runs.length,
      workItems: items.length,
      ignored,
      runsJoined: joined.filter((j) => j !== null).length,
      runsUnjoined: joined.filter((j) => j === null).length,
    },
    validity,
    cost: {
      cells: headline.cost,
      mergedWithoutRuns: merged.filter((i) => !(runsOf.get(i.pr_number) ?? []).some(delivery)).length,
      mergedWithoutCost: merged.filter((i) => { const rs = (runsOf.get(i.pr_number) ?? []).filter(delivery); return rs.length > 0 && !rs.some(hasCost); }).length,
      runsWithoutCost: costed.reduce((s, c) => s + c.runs.filter((r) => typeof r.total_cost_usd !== 'number').length, 0),
      overhead: { runs: overheadRuns.length, usd: round(costOf(overheadRuns)) },
    },
    yield: {
      cells: headline.yield,
      closedWithoutCost: m.closedWithoutCost,
      unjoinedWithoutCost: m.unjoinedWithoutCost,
    },
    escape: headline.escape,
    approval: { cells: headline.approval },
    correction: { cells: headline.correction },
    secondary,
    bootstrap: { resamples: RESAMPLES, seed: SEED },
  };
}

/** @typedef {ReturnType<typeof metricsReport>} Report */

// ── The report as Markdown ───────────────────────────────────────────────────────────────────
// What `kanon metrics report` prints, and what the Overseer's weekly job writes to its job
// summary (§6.4). Numbers, dates and field names only: a row holds nothing else (ADR 0007).

/** The "not enough data (N)" text every cell below its minimum shows (§2.1). @param {number} n */
export const notEnough = (n) => `not enough data (${n})`;

/** @param {number} v */
export const dollars = (v) => `$${v.toFixed(2)}`;
/** @param {number} v */
export const percent = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * One estimate as a cell: the value and its interval, or why there is none.
 * @param {Estimate | undefined} e @param {(v: number) => string} fmt
 */
export function cellText(e, fmt) {
  if (!e) return '—';
  if (e.status === 'not-enough-data') return notEnough(e.n);
  if (e.status === 'no-spend') return `no spend (${e.n})`;
  const ci = e.low !== null && e.high !== null ? ` (${fmt(e.low)} to ${fmt(e.high)})` : '';
  return `${fmt(e.value)}${ci}, n ${e.n}`;
}

/** Seconds as hours, one decimal. @param {number} v */
const hours = (v) => `${(v / 3600).toFixed(1)} h`;
/** @param {number} v */
const plain = (v) => String(v);

/** @param {Record<string, number>} mix */
export const mixText = (mix) => Object.entries(mix).filter(([, n]) => n > 0).map(([b, n]) => `${b === 'noPr' ? 'no PR' : b} ${n}`).join(', ') || 'none';

/** @param {Report['secondary']['cacheSavings']} c */
function cacheText(c) {
  const share = c.share === null ? '' : `, ${percent(c.share)} of what the priced runs would have cost uncached`;
  const models = c.unpricedModels.length ? ` (models the price table doesn't hold: ${c.unpricedModels.join(', ')}; or runs with no cache count)` : '';
  return `Cache savings, at API list price: ${dollars(c.usd)} over ${c.runs} runs in the window${share}. ${c.unpriced} runs could not be priced${models}: unknown, never $0.`;
}

/** @param {Report['validity']['issueSide']} side */
function issueSideText(side) {
  /** @param {Report['validity']['issueSide']['acCount']} e */
  const one = (e) => (e.status === 'not-enough-data' ? notEnough(e.n) : `${e.status === 'rises' ? 'rises' : 'not shown to rise'}, τ ${e.tau === null ? 'not computed' : `${e.tau} (${e.low ?? '?'} to ${e.high ?? '?'})`}, n ${e.n}`);
  return `Issue-side cross-check (§3.6), over ${side.n} brief-driven merged items with criteria: cost against acceptance criteria ${one(side.acCount)}; against the issue's length ${one(side.bodyChars)}. A cross-check only: it never changes the view.`;
}

/**
 * The report as Markdown lines.
 * @param {Report} r
 * @returns {string[]}
 */
export function renderReport(r) {
  const banded = r.view === 'banded';
  const columns = [...(banded ? BANDS : []), 'noPr', 'pooled'];
  const head = columns.map((c) => (c === 'noPr' ? 'No PR' : c === 'pooled' ? 'Pooled' : c));
  /** @param {string} label @param {Record<string, any>} cells @param {(c: any) => Estimate | undefined} pick @param {(v: number) => string} fmt */
  const line = (label, cells, pick, fmt) => `| ${label} | ${columns.map((c) => (cells[c] ? cellText(pick(cells[c]), fmt) : '—')).join(' | ')} |`;
  const d30 = /** @type {any} */ (r.escape.d30);
  const d90 = /** @type {any} */ (r.escape.d90);
  return [
    `## Kanon metrics, ${r.window.from} to ${r.window.until} (${r.window.days} days, by close date)`,
    '',
    `Cost is the **API list price** the agent CLI reports for each run, not what anyone paid. Band version ${r.bandVersion}. Every interval is 95%; a cell below its minimum sample shows "not enough data (N)".`,
    '',
    ...r.warnings.flatMap((w) => [`> **Warning:** ${w}`, '']),
    `| Indicator | ${head.join(' | ')} |`,
    `|---|${columns.map(() => '---').join('|')}|`,
    line('Cost per merged item, median', r.cost.cells, (c) => c.median, dollars),
    line('Cost per merged item, p90', r.cost.cells, (c) => c.p90, dollars),
    line('Yield, share of delivery spend merged', r.yield.cells, (c) => c.yield, percent),
    line(`Escaped defects at 30 days (merged ${d30.mergedFrom} to ${d30.mergedUntil})`, d30.agent, (c) => c.rate, percent),
    line(`Escaped defects at 90 days (merged ${d90.mergedFrom} to ${d90.mergedUntil})`, d90.agent, (c) => c.rate, percent),
    line('First-review approval', r.approval.cells, (c) => c.rate, percent),
    line('Human-correction rate, agent-authored', r.correction.cells, (c) => c.rate, percent),
    '',
    `Band mix of the pooled cells: cost ${mixText(/** @type {any} */ (r.cost.cells.pooled).bandMix)}; yield ${mixText(/** @type {any} */ (r.yield.cells.pooled).bandMix)}; escapes at 30 days ${mixText(d30.agent.pooled.bandMix)}, at 90 days ${mixText(d90.agent.pooled.bandMix)}.`,
    '',
    `Escape rates are a **lower bound**: only an explicit revert or a linked fix counts (plan 0003 §3.5), on agent-authored items whose whole window has passed. Human-authored items, a comparison cohort and not a baseline, pooled: at 30 days ${cellText(d30.human.pooled.rate, percent)}, at 90 days ${cellText(d90.human.pooled.rate, percent)}.`,
    '',
    'Beside them (§2.2, §2.3):',
    '',
    `| Measure | ${head.join(' | ')} |`,
    `|---|${columns.map(() => '---').join('|')}|`,
    line('Cost per acceptance criterion, median', r.secondary.costPerAc.cells, (c) => c.median, dollars),
    line('Review rounds to approval, median', r.secondary.reviewRounds.cells, (c) => c.median, plain),
    line('Lead time to merge, median', r.secondary.leadTime.cells, (c) => c.median, hours),
    line('Lead time to merge, p90', r.secondary.leadTime.cells, (c) => c.p90, hours),
    ...STAGES.flatMap((st) => [
      line(`Stage: ${st}, median`, r.secondary.leadTime.cells, (c) => c.stages?.[st]?.median, hours),
      line(`Stage: ${st}, p90`, r.secondary.leadTime.cells, (c) => c.stages?.[st]?.p90, hours),
    ]),
    line('Human wait, median', r.secondary.humanWait.cells, (c) => c.median, hours),
    '',
    cacheText(r.secondary.cacheSavings),
    '',
    `Band validity (§3.6): ${r.validity.status}. Kendall's τ between band and cost ${r.validity.tau === null ? 'not computed' : `${r.validity.tau} (${r.validity.low ?? '?'} to ${r.validity.high ?? '?'})`}, over ${r.validity.n} merged items. Median cost by band: ${BANDS.map((b) => `${b} ${cellText(r.validity.medianCost[b], dollars)}`).join('; ')}.`,
    '',
    issueSideText(r.validity.issueSide),
    '',
    `Overhead, beside cost and never inside it, and out of yield (the Explorer, the code audit, the telemetry Explorer, the Overseer, the digests, the deploy diagnose lane, and the Lead's runs that join no item): ${dollars(r.cost.overhead.usd)} over ${r.cost.overhead.runs} runs. Left out of cost: ${r.cost.mergedWithoutRuns} merged items with no run row, and ${r.cost.mergedWithoutCost} whose runs report no cost (unknown, never $0); ${r.cost.runsWithoutCost} runs inside the costed items report no cost. Left out of yield: the ${r.cost.mergedWithoutCost} merged items and ${r.yield.closedWithoutCost} closed-unmerged items whose runs report no cost, and ${r.yield.unjoinedWithoutCost} settled groups of runs that join no item and report no cost (unknown, never $0).`,
    '',
    `Rows read: ${r.rows.runs} runs (${r.rows.runsJoined} joined to a work item, ${r.rows.runsUnjoined} to none) and ${r.rows.workItems} work items; left out: ${r.rows.ignored.notRun} not \`tag: run\`, ${r.rows.ignored.otherKind} of another kind, ${r.rows.ignored.unreadable} unreadable. Yield's interval: a bootstrap over work items, ${r.bootstrap.resamples} resamples, seed ${r.bootstrap.seed}.`,
  ];
}
