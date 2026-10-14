// The indicators (plan 0003 §2, §3.6, §6.1): the three headline indicators by complexity band,
// their trend and their by-version view, from one adopter's stored rows. The core of the report
// (`report.mjs`) and its views (`views.mjs`), and of the aggregate function's page view
// (`infra/telemetry/function/aggregate.mjs`, plan 0003 M7), so the public page and an adopter's
// own report compute every indicator the same way.
//
// IT IMPORTS ONLY ITS OWN DIRECTORY'S IMPORT-FREE FILES (`band.mjs`, `join.mjs`, `stats.mjs`), so
// the aggregate function's package can link it beside them, as it links the schema (plan 0002
// §2.5). The lanes come in as an argument for the same reason: the schema that lists them lives
// elsewhere. Pure: rows in, figures out, no clock but the window it is given (`K-SELF-8`).
//
// THE THREE, ALWAYS TOGETHER (§2.1, decision 5): cost per merged work item (§2.2), yield (§2.3)
// and the escaped-defect rate (§2.4), with first-review approval and the human-correction rate
// beside it. Each cell is by band, plus pooled with the band mix printed beside it.
//
// THE DEPLOY METRICS (plan 0010 §11), at the end: deployment frequency, change-failure rate, time
// to restore and release lead time, from the deploy rows of production alone.
//
// A CELL BELOW ITS MINIMUM IS "NOT ENOUGH DATA (N)", never a number (§2.1, decision 11): medians
// from 10 items, p90 from 30, proportions and yield from 20, escape rates from 50. Every interval
// is 95%: order statistics for cost, a seeded bootstrap for yield, Wilson for proportions.
//
// THE BAND VALIDITY CHECK (§3.6). A band is a control only if cost rises with it: Kendall's τ-b
// between band and cost per merged item, with its interval; unless the interval sits entirely
// above zero, the banded cells are withheld and only the pooled ones are shown.
//
// THE BAND IS RECOMPUTED with the newest version (`BAND_VERSION`) from each row's stored counts,
// never read from the row's own `band`, so a view never mixes versions (§3.6, "Versioning").

import { BAND_VERSION, BANDS, bandOf } from './band.mjs';
import { joinRuns } from './join.mjs';
import { bootstrap, kendallTauB, median, orderStatisticInterval, quantile, wilson } from './stats.mjs';

/** The minimum samples (§2.2 to §2.4, decision 11). */
export const MINIMUM = Object.freeze({ median: 10, p90: 30, proportion: 20, yield: 20, escape: 50, validity: 10 });

/** The default window, by close date: four whole weeks (§2.1). */
export const WINDOW_DAYS = 28;

/** The trend's windows, by default: six of 28 days, about half a year. */
export const TREND_WINDOWS = 6;

/** The escape-rate horizons, in days (§2.4). */
export const ESCAPE_DAYS = /** @type {const} */ ([30, 90]);

/**
 * The lanes whose spend is overhead, shown beside cost and never inside it, and left out of yield
 * (§2.2, §2.3): the Explorer's, the code audit, the telemetry Explorer, the Overseer and the
 * digests. Every other lane is a delivery lane.
 */
export const OVERHEAD_LANES = Object.freeze(['explore', 'code-audit', 'explore-telemetry', 'overseer', 'weekly-digest', 'project-digest']);

/**
 * The delivery lanes among `lanes`, the schema's list, which the caller passes.
 * @param {readonly string[]} lanes
 */
export const deliveryLanes = (lanes) => Object.freeze(lanes.filter((l) => !OVERHEAD_LANES.includes(l)));

/**
 * The Lead's lanes. A Lead run that joins an item is in that item's cost and yield (§2.2 names
 * "the Lead's lead, lead-revise and lead-split runs that name the item"); one that joins nothing,
 * such as a brief run or a split of a tracking issue, is planning, and planning is overhead
 * (§3.4, "Ambiguity, stated"): on the overhead line, and out of yield's sums alike.
 */
export const LEAD_LANES = Object.freeze(['lead', 'lead-revise', 'lead-split']);

/** The roles that author agent work: an item authored by one is the agents' cohort (§2.4). */
const AGENT_AUTHORS = new Set(['explorer', 'implementer', 'reviewer', 'merger', 'lead', 'overseer']);

/** Days to milliseconds. */
const DAY_MS = 86_400_000;
/** A run on no settled item settles this long after the last run on it (§2.3). */
export const IDLE_DAYS = 30;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * @typedef {Record<string, unknown> & { recorded_at: string, lane: string, pr_number?: number, issue_number?: number, total_cost_usd?: number }} RunRow
 * @typedef {Record<string, unknown> & { pr_number: number, closed_at: string, fate: 'merged' | 'closed_unmerged', closing_issues?: string }} ItemRow
 * @typedef {{ status: 'ok', n: number, value: number, low: number | null, high: number | null }
 *   | { status: 'not-enough-data', n: number, minimum: number }
 *   | { status: 'no-spend', n: number }} Estimate
 * @typedef {'S' | 'M' | 'L' | 'XL' | 'none'} BandKey
 */

/** Dollars and shares to four decimals, so floating-point noise never reaches the output. */
export const round = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4;
export const roundOrNull = (/** @type {number | null | undefined} */ n) => (typeof n === 'number' ? round(n) : null);

/** @param {unknown} v */
export const isCount = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
/** @param {unknown} v */
const isTime = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

const date = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);

/**
 * Sorts stored rows into the run rows and work-item rows the report reads, and counts the rest.
 * Only `tag: run` counts (§2.1). A row missing what the report needs to place it is unreadable
 * and counted, never guessed at.
 * @param {readonly unknown[]} rows
 */
export function sortRows(rows) {
  /** @type {RunRow[]} */
  const runs = [];
  /** @type {Map<number, ItemRow>} */
  const items = new Map();
  const ignored = { notRun: 0, otherKind: 0, unreadable: 0 };
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) { ignored.unreadable += 1; continue; }
    const r = /** @type {Record<string, unknown>} */ (row);
    const kind = r.row_kind ?? (typeof r.lane === 'string' ? 'run' : undefined);
    if (kind !== 'run' && kind !== 'work_item') { ignored.otherKind += 1; continue; }
    if (r.tag !== 'run') { ignored.notRun += 1; continue; }
    if (kind === 'run') {
      const ok = isTime(r.recorded_at) && typeof r.lane === 'string'
        && (r.pr_number === undefined || isCount(r.pr_number)) && (r.issue_number === undefined || isCount(r.issue_number))
        && (r.total_cost_usd === undefined || (typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) && r.total_cost_usd >= 0));
      if (ok) runs.push(/** @type {RunRow} */ (r));
      else ignored.unreadable += 1;
      continue;
    }
    const ok = isCount(r.pr_number) && isTime(r.closed_at) && (r.fate === 'merged' || r.fate === 'closed_unmerged')
      && (r.closing_issues === undefined || typeof r.closing_issues === 'string');
    if (!ok) { ignored.unreadable += 1; continue; }
    // One row per PR by the store's key (§3.1); an export that holds two keeps the newer.
    const prior = items.get(/** @type {number} */ (r.pr_number));
    if (!prior || String(prior.recorded_at ?? '') < String(r.recorded_at ?? '')) items.set(/** @type {number} */ (r.pr_number), /** @type {ItemRow} */ (r));
  }
  return { runs, items: [...items.values()].sort((a, b) => a.pr_number - b.pr_number), ignored };
}

/** The band of an item under the newest version, or `none` when its counts are unknown. @param {ItemRow} item @returns {BandKey} */
export const bandKey = (item) => bandOf(/** @type {any} */ (item), BAND_VERSION) ?? 'none';

/** @param {BandKey[]} bands */
const bandMix = (bands) => {
  /** @type {Record<BandKey, number>} */
  const mix = { S: 0, M: 0, L: 0, XL: 0, none: 0 };
  for (const b of bands) mix[b] += 1;
  return mix;
};

/**
 * A quantile of costs with its order-statistic interval, or "not enough data" below `minimum`.
 * @param {readonly number[]} sorted @param {number} q @param {number} minimum @returns {Estimate}
 */
export function quantileEstimate(sorted, q, minimum) {
  const n = sorted.length;
  if (n < minimum) return { status: 'not-enough-data', n, minimum };
  const value = q === 0.5 ? median(sorted) : quantile(sorted, q);
  const ci = orderStatisticInterval(sorted, q);
  return { status: 'ok', n, value: round(value), low: roundOrNull(ci?.low), high: roundOrNull(ci?.high) };
}

/**
 * A proportion with its Wilson interval, or "not enough data" below `minimum`.
 * @param {number} x @param {number} n @param {number} minimum @returns {Estimate}
 */
function proportionEstimate(x, n, minimum) {
  if (n < minimum) return { status: 'not-enough-data', n, minimum };
  const ci = wilson(x, n);
  return { status: 'ok', n, value: round(x / n), low: round(ci.low), high: round(ci.high) };
}

/**
 * Yield's ratio of sums: Σ merged cost / Σ cost, NaN with no spend (§2.3).
 * @param {readonly { cost: number, merged: boolean }[]} units
 */
export function yieldRatio(units) {
  let all = 0;
  let merged = 0;
  for (const u of units) { all += u.cost; if (u.merged) merged += u.cost; }
  return all > 0 ? merged / all : Number.NaN;
}

/**
 * Yield over settled units, each with its delivery cost and whether it merged: Σ merged cost /
 * Σ cost, with a bootstrap over units (each unit's runs resampled together).
 * @param {readonly { cost: number, merged: boolean }[]} units @returns {Estimate}
 */
function yieldEstimate(units) {
  const n = units.length;
  if (n < MINIMUM.yield) return { status: 'not-enough-data', n, minimum: MINIMUM.yield };
  const value = yieldRatio(units);
  if (!Number.isFinite(value)) return { status: 'no-spend', n };
  const ci = bootstrap(units, yieldRatio);
  return { status: 'ok', n, value: round(value), low: roundOrNull(ci?.low), high: roundOrNull(ci?.high) };
}

/**
 * Cells per band, plus `pooled` with its band mix, for whatever `cell` makes of a group of units.
 * @template U, C
 * @param {readonly U[]} units @param {(u: U) => BandKey | 'noPr'} bandOfUnit @param {(us: U[]) => C}
 *   cell @param {{ noPr?: boolean }} [opts]
 */
export function cellsByBand(units, bandOfUnit, cell, { noPr = false } = {}) {
  /** @type {Record<string, C>} */
  const out = {};
  for (const b of BANDS) out[b] = cell(units.filter((u) => bandOfUnit(u) === b));
  if (noPr) out.noPr = cell(units.filter((u) => bandOfUnit(u) === 'noPr'));
  const mix = bandMix(units.map(bandOfUnit).filter((b) => b !== 'noPr').map((b) => /** @type {BandKey} */ (b)));
  out.pooled = { ...cell([...units]), bandMix: noPr ? { ...mix, noPr: units.filter((u) => bandOfUnit(u) === 'noPr').length } : mix };
  return out;
}

const hasCost = (/** @type {RunRow} */ r) => typeof r.total_cost_usd === 'number';
export const costOf = (/** @type {readonly RunRow[]} */ rs) => rs.reduce((s, r) => s + (typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0), 0);

/**
 * One adopter's rows, sorted and joined once, for the report and every view to read: the run
 * rows, the work items, each run's item (§3.4), each item's runs, and the delivery runs that join
 * no item, grouped by the PR or issue they name (a PR with no row yet, an issue that never got a
 * PR, or a run naming neither). Each group settles, unmerged, 30 days after its last run (§2.3).
 * @param {readonly unknown[]} rows
 * @param {readonly string[]} delivery the delivery lanes (`deliveryLanes` of the schema's list)
 */
export function prepareRows(rows, delivery) {
  const { runs, items, ignored } = sortRows(rows);
  const isDelivery = (/** @type {RunRow} */ r) => delivery.includes(r.lane);
  const joined = joinRuns(runs, items);
  /** @type {Map<number, RunRow[]>} */
  const runsOf = new Map();
  runs.forEach((run, k) => {
    const pr = joined[k];
    if (pr === null || pr === undefined) return;
    const list = runsOf.get(pr);
    if (list) list.push(run);
    else runsOf.set(pr, [run]);
  });
  const unjoinedLead = (/** @type {RunRow} */ r, /** @type {number} */ k) => LEAD_LANES.includes(r.lane) && joined[k] === null;
  /** @type {Map<string, { band: BandKey | 'noPr', last: number, runs: RunRow[] }>} */
  const loose = new Map();
  runs.forEach((run, k) => {
    if (!isDelivery(run) || joined[k] !== null || unjoinedLead(run, k)) return;
    const key = Number.isInteger(run.pr_number) ? `pr:${run.pr_number}` : Number.isInteger(run.issue_number) ? `issue:${run.issue_number}` : `run:${k}`;
    const at = Date.parse(run.recorded_at);
    const g = loose.get(key);
    if (g) { g.runs.push(run); g.last = Math.max(g.last, at); }
    else loose.set(key, { band: key.startsWith('pr:') ? 'none' : 'noPr', last: at, runs: [run] });
  });
  return { runs, items, ignored, joined, runsOf, unjoinedLead, isDelivery, loose: [...loose.values()] };
}

/** @typedef {ReturnType<typeof prepareRows>} Prepared */

/**
 * The units every indicator of one window is computed over: merged items closed in it, those
 * with a cost, yield's settled units, and each escape horizon's matured items. `keepItem` and
 * `keepRuns` narrow it to a subset, a Kanon version or a configuration arm (§6.1): an item is in
 * it when `keepItem` holds, a group of runs that joins no item when `keepRuns` holds.
 * @param {Prepared} ctx
 * @param {{ start: number, end: number, keepItem?: (i: ItemRow) => boolean, keepRuns?: (rs: readonly RunRow[]) => boolean }} opts
 */
export function measure(ctx, { start, end, keepItem = () => true, keepRuns = () => true }) {
  const inWindow = (/** @type {number} */ t, offset = 0) => t >= start - offset && t < end - offset;
  const items = ctx.items.filter(keepItem);
  const runsOfItem = (/** @type {ItemRow} */ i) => (ctx.runsOf.get(i.pr_number) ?? []).filter(ctx.isDelivery);
  const merged = items.filter((i) => i.fate === 'merged' && inWindow(Date.parse(i.closed_at)));
  const costed = merged
    .map((item) => ({ item, band: bandKey(item), runs: runsOfItem(item) }))
    // An item none of whose delivery runs reports a cost has an unknown cost, never $0 (§3.1).
    .filter((c) => c.runs.some(hasCost))
    .map((c) => ({ ...c, cost: costOf(c.runs) }));
  /** @type {{ band: BandKey | 'noPr', cost: number, merged: boolean }[]} */
  const yieldUnits = [];
  // A closed-unmerged item with delivery runs none of which reports a cost is unknown, never $0:
  // left out of yield and counted (§3.1), as a merged one is in cost's `mergedWithoutCost`. One
  // with no delivery run carries no delivery spend, so leaving it out changes no yield, and it is
  // not counted.
  let closedWithoutCost = 0;
  for (const item of items) {
    if (!inWindow(Date.parse(item.closed_at))) continue;
    const rs = runsOfItem(item);
    if (rs.some(hasCost)) yieldUnits.push({ band: bandKey(item), cost: costOf(rs), merged: item.fate === 'merged' });
    else if (item.fate !== 'merged' && rs.length > 0) closedWithoutCost += 1;
  }
  // A settled group whose runs report no cost is unknown, never $0, so it is left out like an
  // item and counted (§3.1).
  let unjoinedWithoutCost = 0;
  for (const g of ctx.loose) {
    if (!keepRuns(g.runs) || !inWindow(g.last + IDLE_DAYS * DAY_MS)) continue;
    if (g.runs.some(hasCost)) yieldUnits.push({ band: g.band, cost: costOf(g.runs), merged: false });
    else unjoinedWithoutCost += 1;
  }
  /** @type {Record<number, ItemRow[]>} */
  const matured = Object.fromEntries(ESCAPE_DAYS.map((d) => [d, items.filter((i) => i.fate === 'merged' && inWindow(Date.parse(i.closed_at), d * DAY_MS))]));
  return { start, end, merged, costed, yieldUnits, closedWithoutCost, unjoinedWithoutCost, matured };
}

/** @typedef {ReturnType<typeof measure>} Measured */

/** @param {{ cost: number }[]} cs */
const costCell = (cs) => {
  const sorted = cs.map((c) => c.cost).sort((a, b) => a - b);
  return { median: quantileEstimate(sorted, 0.5, MINIMUM.median), p90: quantileEstimate(sorted, 0.9, MINIMUM.p90) };
};

/** The authoring cohort an item is in for the escape rates (§2.4). @param {ItemRow} i */
export const cohortOf = (i) => (typeof i.author_kind === 'string' && AGENT_AUTHORS.has(i.author_kind) ? 'agent' : i.author_kind === 'human' ? 'human' : null);

/** Whether an item escaped within `d` days: an explicit revert or linked fix (§3.5). @param {number} d */
export const escapedWithin = (d) => (/** @type {ItemRow} */ i) => (isCount(i.revert_days) && /** @type {number} */ (i.revert_days) <= d)
  || (isCount(i.first_fix_days) && /** @type {number} */ (i.first_fix_days) <= d);

/** The escape rate of matured items (§2.4). @param {number} d @param {ItemRow[]} is */
const escapeRate = (d, is) => proportionEstimate(is.filter(escapedWithin(d)).length, is.length, MINIMUM.escape);

const hasVerdict = (/** @type {ItemRow} */ i) => i.first_verdict === 'approved' || i.first_verdict === 'changes_requested';
const approvalRate = (/** @type {ItemRow[]} */ is) => proportionEstimate(is.filter((i) => i.first_verdict === 'approved').length, is.length, MINIMUM.proportion);

/**
 * A human correction (§3.3, group 3): a human commit on the agent's PR, or a human's change
 * request after the Reviewer approved. Unknown when neither says yes and either is absent.
 * @param {ItemRow} i
 */
const correction = (i) => {
  const commits = i.human_commits;
  const crs = i.human_cr_after_approval;
  if ((isCount(commits) && /** @type {number} */ (commits) > 0) || (isCount(crs) && /** @type {number} */ (crs) > 0)) return true;
  return isCount(commits) && isCount(crs) ? false : null;
};
const correctable = (/** @type {ItemRow} */ i) => cohortOf(i) === 'agent' && correction(i) !== null;
const correctionRate = (/** @type {ItemRow[]} */ is) => proportionEstimate(is.filter((i) => correction(i)).length, is.length, MINIMUM.proportion);

/**
 * The headline of one window, pooled, with the band mix beside it: what the trend, by-version
 * and A/B views show for each of their cells (§6.1).
 * @param {Measured} m
 */
export function pooledHeadline(m) {
  const agent = (/** @type {number} */ d) => (m.matured[d] ?? []).filter((i) => cohortOf(i) === 'agent');
  return {
    cost: costCell(m.costed),
    yield: yieldEstimate(m.yieldUnits),
    escape: Object.fromEntries(ESCAPE_DAYS.map((d) => [`d${d}`, escapeRate(d, agent(d))])),
    approval: approvalRate(m.merged.filter(hasVerdict)),
    correction: correctionRate(m.merged.filter(correctable)),
    bandMix: bandMix(m.costed.map((c) => c.band)),
  };
}

/**
 * The issue-side band cross-check (§3.6): Kendall's τ-b between an issue-side size and cost per
 * merged item, with its bootstrap interval, over brief-driven items with acceptance criteria. It
 * "rises" when the interval sits entirely above zero. Printed beside the validity check; it never
 * changes the view.
 * @param {Measured['costed']} costed
 */
function issueSideCheck(costed) {
  const briefs = costed.filter((c) => c.item.origin === 'brief' && isCount(c.item.ac_count) && /** @type {number} */ (c.item.ac_count) > 0);
  /** @param {string} field */
  const side = (field) => {
    const points = briefs.filter((c) => isCount(c.item[field])).map((c) => ({ group: /** @type {number} */ (c.item[field]), value: c.cost }));
    if (points.length < MINIMUM.validity || new Set(points.map((p) => p.group)).size < 2) return { status: /** @type {const} */ ('not-enough-data'), n: points.length, minimum: MINIMUM.validity };
    const tau = kendallTauB(points);
    const ci = Number.isFinite(tau) ? bootstrap(points, kendallTauB) : null;
    return { status: ci && ci.low > 0 ? /** @type {const} */ ('rises') : /** @type {const} */ ('not-shown'), n: points.length, tau: Number.isFinite(tau) ? round(tau) : null, low: roundOrNull(ci?.low), high: roundOrNull(ci?.high) };
  };
  return { n: briefs.length, acCount: side('ac_count'), bodyChars: side('issue_body_chars') };
}

/**
 * The band validity check (§3.6) over a window's costed items: `valid` only when Kendall's τ-b
 * between band and cost has an interval entirely above zero; `not-enough-data` below its minimum
 * or with fewer than two bands; `invalid` otherwise. With the median cost per band, and the
 * issue-side cross-check beside it.
 * @param {Measured['costed']} costed
 */
export function validityCheck(costed) {
  const points = costed.filter((c) => c.band !== 'none').map((c) => ({ group: BANDS.indexOf(/** @type {any} */ (c.band)), value: c.cost }));
  const bandsSeen = new Set(points.map((p) => p.group)).size;
  /** @type {{ status: 'valid' | 'invalid' | 'not-enough-data', n: number, bandsSeen: number, tau: number | null, low: number | null, high: number | null, medianCost: Record<string, Estimate>, issueSide: ReturnType<typeof issueSideCheck> }} */
  const validity = { status: 'not-enough-data', n: points.length, bandsSeen, tau: null, low: null, high: null, medianCost: {}, issueSide: issueSideCheck(costed) };
  for (const b of BANDS) {
    validity.medianCost[b] = quantileEstimate(costed.filter((c) => c.band === b).map((c) => c.cost).sort((x, y) => x - y), 0.5, MINIMUM.median);
  }
  if (points.length >= MINIMUM.validity && bandsSeen >= 2) {
    const tau = kendallTauB(points);
    const ci = Number.isFinite(tau) ? bootstrap(points, kendallTauB) : null;
    validity.tau = Number.isFinite(tau) ? round(tau) : null;
    validity.low = roundOrNull(ci?.low);
    validity.high = roundOrNull(ci?.high);
    validity.status = ci && ci.low > 0 ? 'valid' : 'invalid';
  }
  return validity;
}

/**
 * The headline view of one window (§6.1): cost, yield and the escape rates by band, with
 * first-review approval and the human-correction rate beneath, each with its pooled cell and band
 * mix. The banded cells are kept only when the validity check holds; otherwise only the pooled
 * ones (and yield's "no PR" column, which has no band to be wrong about) are.
 * @param {Measured} m
 */
export function headlineCells(m) {
  const validity = validityCheck(m.costed);
  const banded = validity.status === 'valid';
  /** @template {Record<string, any>} T @param {T} cells */
  const view = (cells) => (banded ? cells : Object.fromEntries(Object.entries(cells).filter(([k]) => k === 'pooled' || k === 'noPr')));
  const escape = Object.fromEntries(ESCAPE_DAYS.map((d) => {
    const offset = d * DAY_MS;
    const matured = m.matured[d] ?? [];
    const cohort = (/** @type {'agent' | 'human'} */ c) => {
      const all = cellsByBand(matured.filter((i) => cohortOf(i) === c), bandKey, (is) => ({ rate: escapeRate(d, is) }));
      return banded ? all : { pooled: all.pooled };
    };
    return [`d${d}`, {
      mergedFrom: date(m.start - offset),
      mergedUntil: date(m.end - offset),
      agent: cohort('agent'),
      human: cohort('human'),
    }];
  }));
  return {
    view: banded ? /** @type {const} */ ('banded') : /** @type {const} */ ('pooled'),
    validity,
    cost: view(cellsByBand(m.costed, (c) => c.band, costCell)),
    yield: view(cellsByBand(m.yieldUnits, (u) => u.band, (us) => ({ yield: yieldEstimate(us) }), { noPr: true })),
    escape,
    approval: view(cellsByBand(m.merged.filter(hasVerdict), bandKey, (is) => ({ rate: approvalRate(is) }))),
    correction: view(cellsByBand(m.merged.filter(correctable), bandKey, (is) => ({ rate: correctionRate(is) }))),
  };
}

/**
 * Kanon versions in release order, `dev` last.
 * @param {string} a @param {string} b
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  if (a === 'dev') return 1;
  if (b === 'dev') return -1;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let k = 0; k < 3; k += 1) if ((pa[k] ?? 0) !== (pb[k] ?? 0)) return (pa[k] ?? 0) - (pb[k] ?? 0);
  return 0;
}

/** The Kanon version a row carries, or null. @param {Record<string, unknown>} r */
const versionOf = (r) => (typeof r.kanon_version === 'string' ? r.kanon_version : null);

/**
 * The trend (§6.1): the headline of each of `windows` windows of `days` days that end at `end`,
 * oldest first, pooled with the band mix, each marking the Kanon versions whose first item closed
 * in it. A version's boundary is the window its first item closed in, marked when some versioned
 * item closed before that first item, in an earlier window or the same one; the earliest
 * versioned item's version is never marked, since nothing came before it.
 * @param {Prepared} ctx @param {{ end: number, days: number, windows: number }} opts
 */
export function trendOf(ctx, { end, days, windows }) {
  const width = days * DAY_MS;
  const start = end - windows * width;
  /** @type {Map<string, number>} */
  const firstClosed = new Map();
  for (const item of ctx.items) {
    const v = versionOf(item);
    const t = Date.parse(item.closed_at);
    if (v !== null && !(t >= (firstClosed.get(v) ?? Infinity))) firstClosed.set(v, t);
  }
  const earliest = Math.min(...firstClosed.values());
  return Array.from({ length: windows }, (_, k) => {
    const s = start + k * width;
    const e = s + width;
    return {
      window: { from: date(s), until: date(e), days },
      ...pooledHeadline(measure(ctx, { start: s, end: e })),
      versionsIntroduced: [...firstClosed].filter(([, t]) => t >= s && t < e && earliest < t).map(([v]) => v).sort(compareVersions),
    };
  });
}

/**
 * By Kanon version (§6.1), over the span [start, end): the headline of each version with at
 * least the median's minimum of merged items, pooled with the band mix. An item's version is the
 * one its lanes pinned at its merge (§3.3); a group of runs that joins no item takes its last
 * run's.
 * @param {Prepared} ctx @param {{ start: number, end: number }} opts
 */
export function byVersionOf(ctx, { start, end }) {
  const inSpan = (/** @type {number} */ t) => t >= start && t < end;
  const mergedInSpan = ctx.items.filter((i) => i.fate === 'merged' && inSpan(Date.parse(i.closed_at)));
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of mergedInSpan) {
    const v = versionOf(item);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const lastRun = (/** @type {readonly RunRow[]} */ rs) => rs.reduce((a, b) => (a.recorded_at >= b.recorded_at ? a : b));
  const ordered = [...counts.keys()].sort(compareVersions);
  return {
    minimum: MINIMUM.median,
    versions: ordered.filter((v) => /** @type {number} */ (counts.get(v)) >= MINIMUM.median).map((v) => ({
      version: v,
      items: /** @type {number} */ (counts.get(v)),
      ...pooledHeadline(measure(ctx, { start, end, keepItem: (i) => versionOf(i) === v, keepRuns: (rs) => versionOf(lastRun(rs)) === v })),
    })),
    fewer: ordered.filter((v) => /** @type {number} */ (counts.get(v)) < MINIMUM.median).map((v) => ({ version: v, items: /** @type {number} */ (counts.get(v)) })),
    unversioned: mergedInSpan.filter((i) => versionOf(i) === null).length,
  };
}

// ── The deploy metrics (plan 0010 §11, decision 12) ──────────────────────────────────────────
//
// FOUR VIEWS, ON PRODUCTION ONLY. Plan 0003 defines no deploy metric; plan 0010 §11 adds four,
// from the deploy rows (§10) with `tag: run` and `role: production`: the last environment of each
// adopter's chain, whatever its length. Production is selected by `role`, never by `position`:
// the last position is 1 on a chain of one and 3 on a chain of three. A pre-production row counts
// in none of the four; it is only tallied, beside them, as left out.
//
// A CHANGE COUNTS ONCE. A rollback row and a `redeploy` row aren't changes: a redeploy puts a
// commit that already succeeded in production there again, as a two-release flow's promotion does
// (§4) on the commit its pre-release deployed. Neither counts in the frequency, the change-failure
// share or lead time, so a change counts at its first production deploy, the pre-release's under
// that flow; both still count in time to restore, an `ok` as the restore and a failure as one to
// restore (the Owner's decision on kanon#895).
//
// WHAT THEY CAN'T SEE: a production fault found days later and fixed forward, with no rollback and
// no failed smoke. The row carries no commit (§10), so it can't be joined to plan 0003's reverts
// and linked fixes.

/** The deployment frequency's weeks: the median over the last 13 (plan 0010 §11). */
export const DEPLOY_WEEKS = 13;

const WEEK_MS = 7 * DAY_MS;

/**
 * @typedef {Record<string, unknown> & { recorded_at: string, role: 'production' | 'pre-production', outcome: string,
 *   failed_stage?: string, redeploy?: boolean, rollback?: boolean, since_release_ms?: number, run_id?: number, run_attempt?: number }} DeployRow
 */

/** A rollback row: a dispatch to a commit older than the environment's last success (§10). @param {DeployRow} r */
const isRollback = (r) => r.rollback === true;
/** A change: neither a rollback nor a redeploy of a commit that already succeeded there (§10). @param {DeployRow} r */
const isChange = (r) => !isRollback(r) && r.redeploy !== true;
/** A forward `ok`: deployed, and a change. @param {DeployRow} r */
const isForwardOk = (r) => r.outcome === 'ok' && isChange(r);
/** Failed at the deploy stage itself, or its smoke check failed. @param {DeployRow} r */
const isDeployFailure = (r) => (r.outcome === 'failed' && r.failed_stage === 'deploy') || r.outcome === 'smoke_failed';

/**
 * One adopter's deploy rows: the production rows with `tag: run`, oldest first (by `recorded_at`,
 * then `run_id` and `run_attempt`); the pre-production rows apart, which no metric reads; and a
 * tally of the deploy rows that aren't `tag: run` or are unreadable (missing their time, role or
 * outcome). A row of another kind isn't a deploy row and isn't tallied.
 * @param {readonly unknown[]} rows
 */
export function productionDeploys(rows) {
  /** @type {DeployRow[]} */
  const production = [];
  /** @type {DeployRow[]} */
  const preProduction = [];
  const leftOut = { notRun: 0, unreadable: 0 };
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    if (r.row_kind !== 'deploy') continue;
    if (r.tag !== 'run') { leftOut.notRun += 1; continue; }
    if (!isTime(r.recorded_at) || typeof r.outcome !== 'string' || (r.role !== 'production' && r.role !== 'pre-production')) { leftOut.unreadable += 1; continue; }
    if (r.role !== 'production') { preProduction.push(/** @type {DeployRow} */ (r)); continue; }
    production.push(/** @type {DeployRow} */ (r));
  }
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' ? v : 0);
  production.sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : num(a.run_id) - num(b.run_id) || num(a.run_attempt) - num(b.run_attempt)));
  return { production, preProduction, leftOut };
}

/**
 * The four deploy metrics (plan 0010 §11) over the `weeks` weeks that end at `end`, on production
 * rows only. A row's time is its `recorded_at`, the end of its environment's job.
 * - **Deployment frequency:** forward `ok` rows (`ok`, neither `rollback` nor `redeploy` true) per
 *   week, the median over the weeks, a week with none counting as 0.
 * - **Change-failure rate:** of the changes in the span that reached the deploy stage (`ok`,
 *   `failed` at `deploy`, `smoke_failed`), the share that failed there, or are `ok` and followed by
 *   a rollback row before the next forward `ok`. A rollback or redeploy row isn't a change, so it
 *   isn't in the share itself, and a redeploy doesn't end the look ahead. The look ahead reads
 *   past the span's end.
 * - **Time to restore:** from each failed row in the span, a rollback's or redeploy's included, to
 *   the next `ok` row, a rollback's or redeploy's included, the median. A failure with no `ok`
 *   after it is counted as not restored.
 * - **Release lead time:** `since_release_ms` of the forward `ok` rows in the span, the median.
 * @param {readonly unknown[]} rows one adopter's stored rows, of any kind
 * @param {{ end: number, weeks?: number }} opts
 */
export function deployMetricsOf(rows, { end, weeks = DEPLOY_WEEKS }) {
  const start = end - weeks * WEEK_MS;
  const { production, preProduction, leftOut } = productionDeploys(rows);
  const at = (/** @type {DeployRow} */ r) => Date.parse(r.recorded_at);
  const inSpan = (/** @type {DeployRow} */ r) => at(r) >= start && at(r) < end;

  /** @type {number[]} */
  const perWeek = Array.from({ length: weeks }, () => 0);
  let reached = 0;
  let failed = 0;
  let rolledBack = 0;
  /** @type {number[]} */
  const restore = [];
  let unrestored = 0;
  /** @type {number[]} */
  const lead = [];
  let withoutLeadTime = 0;
  production.forEach((r, k) => {
    if (!inSpan(r)) return;
    const after = production.slice(k + 1);
    if (isForwardOk(r)) {
      const w = Math.floor((at(r) - start) / WEEK_MS);
      perWeek[w] = (perWeek[w] ?? 0) + 1;
      if (isCount(r.since_release_ms)) lead.push(/** @type {number} */ (r.since_release_ms));
      else withoutLeadTime += 1;
    }
    if (isChange(r) && (r.outcome === 'ok' || isDeployFailure(r))) {
      reached += 1;
      if (isDeployFailure(r)) failed += 1;
      else {
        const next = after.findIndex(isForwardOk);
        if ((next === -1 ? after : after.slice(0, next)).some(isRollback)) { failed += 1; rolledBack += 1; }
      }
    }
    if (isDeployFailure(r)) {
      const ok = after.find((x) => x.outcome === 'ok');
      if (ok) restore.push(at(ok) - at(r));
      else unrestored += 1;
    }
  });
  const sorted = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b);
  return {
    window: { from: date(start), until: date(end), weeks },
    rows: { production: production.filter(inSpan).length, preProduction: preProduction.filter(inSpan).length, ...leftOut },
    frequency: { perWeek, median: quantileEstimate(sorted(perWeek), 0.5, weeks) },
    changeFailure: { rate: proportionEstimate(failed, reached, MINIMUM.proportion), reached, failed, rolledBack },
    restore: { median: quantileEstimate(sorted(restore), 0.5, MINIMUM.median), unrestored },
    leadTime: { median: quantileEstimate(sorted(lead), 0.5, MINIMUM.median), withoutLeadTime },
  };
}
