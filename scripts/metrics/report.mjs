// The report module (plan 0003 §7, M6): the three headline indicators by complexity band, from one
// adopter's stored rows. Rows in, report out: no network, no file, no clock but the `until` it is
// given (`K-SELF-8`). `kanon metrics report` prints it; the Overseer's weekly job is to run it.
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
import { BAND_VERSION, BANDS, bandOf } from './band.mjs';
import { joinRuns } from './join.mjs';
import { RESAMPLES, SEED, bootstrap, kendallTauB, median, orderStatisticInterval, quantile, wilson } from './stats.mjs';

/** The minimum samples (§2.2 to §2.4, decision 11). */
export const MINIMUM = Object.freeze({ median: 10, p90: 30, proportion: 20, yield: 20, escape: 50, validity: 10 });

/** The default window, by close date: four whole weeks (§2.1). */
export const WINDOW_DAYS = 28;

/** The escape-rate horizons, in days (§2.4). */
export const ESCAPE_DAYS = /** @type {const} */ ([30, 90]);

/**
 * The lanes whose spend is overhead, shown beside cost and never inside it, and left out of yield
 * (§2.2, §2.3): the Explorer's, the code audit, the telemetry Explorer, the Overseer and the
 * digests. Every other lane is a delivery lane.
 */
export const OVERHEAD_LANES = Object.freeze(['explore', 'code-audit', 'explore-telemetry', 'overseer', 'weekly-digest', 'project-digest']);
export const DELIVERY_LANES = Object.freeze(LANES.filter((l) => !OVERHEAD_LANES.includes(l)));

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
const round = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4;
const roundOrNull = (/** @type {number | null | undefined} */ n) => (typeof n === 'number' ? round(n) : null);

/** @param {unknown} v */
const isCount = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
/** @param {unknown} v */
const isTime = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

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
const bandKey = (item) => bandOf(/** @type {any} */ (item), BAND_VERSION) ?? 'none';

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
function quantileEstimate(sorted, q, minimum) {
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
 * Yield over settled units, each with its delivery cost and whether it merged: Σ merged cost /
 * Σ cost, with a bootstrap over units (each unit's runs resampled together).
 * @param {readonly { cost: number, merged: boolean }[]} units @returns {Estimate}
 */
function yieldEstimate(units) {
  const n = units.length;
  if (n < MINIMUM.yield) return { status: 'not-enough-data', n, minimum: MINIMUM.yield };
  const ratio = (/** @type {readonly { cost: number, merged: boolean }[]} */ us) => {
    let all = 0;
    let merged = 0;
    for (const u of us) { all += u.cost; if (u.merged) merged += u.cost; }
    return all > 0 ? merged / all : Number.NaN;
  };
  const value = ratio(units);
  if (!Number.isFinite(value)) return { status: 'no-spend', n };
  const ci = bootstrap(units, ratio);
  return { status: 'ok', n, value: round(value), low: roundOrNull(ci?.low), high: roundOrNull(ci?.high) };
}

/**
 * Cells per band, plus `pooled` with its band mix, for whatever `cell` makes of a group of units.
 * @template U, C
 * @param {readonly U[]} units @param {(u: U) => BandKey | 'noPr'} bandOfUnit @param {(us: U[]) => C}
 *   cell @param {{ noPr?: boolean }} [opts]
 */
function cellsByBand(units, bandOfUnit, cell, { noPr = false } = {}) {
  /** @type {Record<string, C>} */
  const out = {};
  for (const b of BANDS) out[b] = cell(units.filter((u) => bandOfUnit(u) === b));
  if (noPr) out.noPr = cell(units.filter((u) => bandOfUnit(u) === 'noPr'));
  const mix = bandMix(units.map(bandOfUnit).filter((b) => b !== 'noPr').map((b) => /** @type {BandKey} */ (b)));
  out.pooled = { ...cell([...units]), bandMix: noPr ? { ...mix, noPr: units.filter((u) => bandOfUnit(u) === 'noPr').length } : mix };
  return out;
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
  const inWindow = (/** @type {number} */ t, offset = 0) => t >= start - offset && t < end - offset;
  const { runs, items, ignored } = sortRows(rows);

  // The join (§3.4): each run's item, or none.
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
  const delivery = (/** @type {RunRow} */ r) => DELIVERY_LANES.includes(r.lane);
  const hasCost = (/** @type {RunRow} */ r) => typeof r.total_cost_usd === 'number';
  const costOf = (/** @type {readonly RunRow[]} */ rs) => rs.reduce((s, r) => s + (typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0), 0);

  // ── Cost per merged item (§2.2) ────────────────────────────────────────────────────────────
  const merged = items.filter((i) => i.fate === 'merged' && inWindow(Date.parse(i.closed_at)));
  const costed = merged
    .map((item) => ({ item, band: bandKey(item), runs: (runsOf.get(item.pr_number) ?? []).filter(delivery) }))
    // An item none of whose delivery runs reports a cost has an unknown cost, never $0 (§3.1).
    .filter((c) => c.runs.some(hasCost))
    .map((c) => ({ ...c, cost: costOf(c.runs) }));
  const costCell = (/** @type {{ cost: number }[]} */ cs) => {
    const sorted = cs.map((c) => c.cost).sort((a, b) => a - b);
    return { median: quantileEstimate(sorted, 0.5, MINIMUM.median), p90: quantileEstimate(sorted, 0.9, MINIMUM.p90) };
  };
  // Overhead: the overhead lanes' runs, and the Lead's runs that join no item (§3.4).
  const unjoinedLead = (/** @type {RunRow} */ r, /** @type {number} */ k) => LEAD_LANES.includes(r.lane) && joined[k] === null;
  const overheadRuns = runs.filter((r, k) => (!delivery(r) || unjoinedLead(r, k)) && inWindow(Date.parse(r.recorded_at)));

  // ── The band validity check (§3.6) ─────────────────────────────────────────────────────────
  const points = costed.filter((c) => c.band !== 'none').map((c) => ({ group: BANDS.indexOf(/** @type {any} */ (c.band)), value: c.cost }));
  const bandsSeen = new Set(points.map((p) => p.group)).size;
  /** @type {{ status: 'valid' | 'invalid' | 'not-enough-data', n: number, tau: number | null, low: number | null, high: number | null, medianCost: Record<string, Estimate> }} */
  const validity = { status: 'not-enough-data', n: points.length, tau: null, low: null, high: null, medianCost: {} };
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
  const banded = validity.status === 'valid';
  /** @type {string[]} */
  const warnings = [];
  if (!banded) {
    warnings.push(validity.status === 'invalid'
      ? `The band validity check failed: Kendall's τ between band and cost is ${validity.tau ?? 'undefined'}, and its 95% interval (${validity.low ?? '?'} to ${validity.high ?? '?'}) does not sit entirely above zero, so cost does not rise with the band in this window. The pooled view is shown instead of the banded one.`
      : `The band validity check could not run: it needs ${MINIMUM.validity} merged items with a cost and a band, in at least two bands, and has ${points.length} in ${bandsSeen}. The pooled view is shown instead of the banded one.`);
  }

  // ── Yield (§2.3) ───────────────────────────────────────────────────────────────────────────
  /** @type {{ band: BandKey | 'noPr', cost: number, merged: boolean }[]} */
  const yieldUnits = [];
  for (const item of items) {
    if (!inWindow(Date.parse(item.closed_at))) continue;
    const rs = (runsOf.get(item.pr_number) ?? []).filter(delivery);
    if (rs.some(hasCost)) yieldUnits.push({ band: bandKey(item), cost: costOf(rs), merged: item.fate === 'merged' });
  }
  // Delivery runs that join no item: a PR with no row yet, an issue that never got a PR, or a
  // run that names neither. Each settles, unmerged, 30 days after the last run on it.
  /** @type {Map<string, { band: BandKey | 'noPr', last: number, runs: RunRow[] }>} */
  const loose = new Map();
  runs.forEach((run, k) => {
    if (!delivery(run) || joined[k] !== null || unjoinedLead(run, k)) return;
    const key = Number.isInteger(run.pr_number) ? `pr:${run.pr_number}` : Number.isInteger(run.issue_number) ? `issue:${run.issue_number}` : `run:${k}`;
    const at = Date.parse(run.recorded_at);
    const g = loose.get(key);
    if (g) { g.runs.push(run); g.last = Math.max(g.last, at); }
    else loose.set(key, { band: key.startsWith('pr:') ? 'none' : 'noPr', last: at, runs: [run] });
  });
  for (const g of loose.values()) {
    if (inWindow(g.last + IDLE_DAYS * DAY_MS)) yieldUnits.push({ band: g.band, cost: costOf(g.runs), merged: false });
  }

  // ── Accuracy (§2.4) ────────────────────────────────────────────────────────────────────────
  const cohortOf = (/** @type {ItemRow} */ i) => (typeof i.author_kind === 'string' && AGENT_AUTHORS.has(i.author_kind) ? 'agent' : i.author_kind === 'human' ? 'human' : null);
  const escape = Object.fromEntries(ESCAPE_DAYS.map((d) => {
    const offset = d * DAY_MS;
    const matured = items.filter((i) => i.fate === 'merged' && inWindow(Date.parse(i.closed_at), offset));
    const escaped = (/** @type {ItemRow} */ i) => (isCount(i.revert_days) && /** @type {number} */ (i.revert_days) <= d)
      || (isCount(i.first_fix_days) && /** @type {number} */ (i.first_fix_days) <= d);
    const cell = (/** @type {ItemRow[]} */ is) => ({ rate: proportionEstimate(is.filter(escaped).length, is.length, MINIMUM.escape) });
    const cohort = (/** @type {'agent' | 'human'} */ c) => {
      const all = cellsByBand(matured.filter((i) => cohortOf(i) === c), bandKey, cell);
      return banded ? all : { pooled: all.pooled };
    };
    return [`d${d}`, {
      mergedFrom: new Date(start - offset).toISOString().slice(0, 10),
      mergedUntil: new Date(end - offset).toISOString().slice(0, 10),
      agent: cohort('agent'),
      human: cohort('human'),
    }];
  }));
  const withVerdict = merged.filter((i) => i.first_verdict === 'approved' || i.first_verdict === 'changes_requested');
  const approval = cellsByBand(withVerdict, bandKey, (is) => ({ rate: proportionEstimate(is.filter((i) => i.first_verdict === 'approved').length, is.length, MINIMUM.proportion) }));
  // A human correction (§3.3, group 3): a human commit on the agent's PR, or a human's change
  // request after the Reviewer approved. Unknown when neither says yes and either is absent.
  const correction = (/** @type {ItemRow} */ i) => {
    const commits = i.human_commits;
    const crs = i.human_cr_after_approval;
    if ((isCount(commits) && /** @type {number} */ (commits) > 0) || (isCount(crs) && /** @type {number} */ (crs) > 0)) return true;
    return isCount(commits) && isCount(crs) ? false : null;
  };
  const agentMerged = merged.filter((i) => cohortOf(i) === 'agent' && correction(i) !== null);
  const corrections = cellsByBand(agentMerged, bandKey, (is) => ({ rate: proportionEstimate(is.filter((i) => correction(i)).length, is.length, MINIMUM.proportion) }));

  /** @template {Record<string, any>} T @param {T} cells */
  const view = (cells) => (banded ? cells : Object.fromEntries(Object.entries(cells).filter(([k]) => k === 'pooled' || k === 'noPr')));

  return {
    window: { from: new Date(start).toISOString().slice(0, 10), until: new Date(end).toISOString().slice(0, 10), days },
    bandVersion: BAND_VERSION,
    costBasis: 'API list price',
    view: banded ? 'banded' : 'pooled',
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
      cells: view(cellsByBand(costed, (c) => c.band, costCell)),
      mergedWithoutRuns: merged.filter((i) => !(runsOf.get(i.pr_number) ?? []).some(delivery)).length,
      mergedWithoutCost: merged.filter((i) => { const rs = (runsOf.get(i.pr_number) ?? []).filter(delivery); return rs.length > 0 && !rs.some(hasCost); }).length,
      runsWithoutCost: costed.reduce((s, c) => s + c.runs.filter((r) => typeof r.total_cost_usd !== 'number').length, 0),
      overhead: { runs: overheadRuns.length, usd: round(costOf(overheadRuns)) },
    },
    yield: { cells: view(cellsByBand(yieldUnits, (u) => u.band, (us) => ({ yield: yieldEstimate(us) }), { noPr: true })) },
    escape,
    approval: { cells: view(approval) },
    correction: { cells: view(corrections) },
    bootstrap: { resamples: RESAMPLES, seed: SEED },
  };
}

/** @typedef {ReturnType<typeof metricsReport>} Report */

// ── The report as Markdown ───────────────────────────────────────────────────────────────────
// What `kanon metrics report` prints, and what the Overseer's weekly job is to write to its job
// summary (§6.4). Numbers, dates and field names only: a row holds nothing else (ADR 0007).

/** The "not enough data (N)" text every cell below its minimum shows (§2.1). @param {number} n */
export const notEnough = (n) => `not enough data (${n})`;

/** @param {number} v */
const dollars = (v) => `$${v.toFixed(2)}`;
/** @param {number} v */
const percent = (v) => `${(v * 100).toFixed(1)}%`;

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

/** @param {Record<string, number>} mix */
const mixText = (mix) => Object.entries(mix).filter(([, n]) => n > 0).map(([b, n]) => `${b === 'noPr' ? 'no PR' : b} ${n}`).join(', ') || 'none';

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
    `Band validity (§3.6): ${r.validity.status}. Kendall's τ between band and cost ${r.validity.tau === null ? 'not computed' : `${r.validity.tau} (${r.validity.low ?? '?'} to ${r.validity.high ?? '?'})`}, over ${r.validity.n} merged items. Median cost by band: ${BANDS.map((b) => `${b} ${cellText(r.validity.medianCost[b], dollars)}`).join('; ')}.`,
    '',
    `Overhead, beside cost and never inside it, and out of yield (the Explorer, the code audit, the telemetry Explorer, the Overseer, the digests, and the Lead's runs that join no item): ${dollars(r.cost.overhead.usd)} over ${r.cost.overhead.runs} runs. Left out of cost: ${r.cost.mergedWithoutRuns} merged items with no run row, and ${r.cost.mergedWithoutCost} whose runs report no cost (unknown, never $0); ${r.cost.runsWithoutCost} runs inside the costed items report no cost.`,
    '',
    `Rows read: ${r.rows.runs} runs (${r.rows.runsJoined} joined to a work item, ${r.rows.runsUnjoined} to none) and ${r.rows.workItems} work items; left out: ${r.rows.ignored.notRun} not \`tag: run\`, ${r.rows.ignored.otherKind} of another kind, ${r.rows.ignored.unreadable} unreadable. Yield's interval: a bootstrap over work items, ${r.bootstrap.resamples} resamples, seed ${r.bootstrap.seed}.`,
  ];
}
