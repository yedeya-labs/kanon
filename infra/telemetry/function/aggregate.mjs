// The aggregate (plan 0002 §6, and §6.1 as the Owner decided on 2026-10-07, #443): one pure
// function over stored rows, and the aggregate-only function that serves it.
//
// WHAT MAY LEAVE, AND NOTHING ELSE (§6.1, items 1 to 3):
// 1. `cross_adopter`: a lane-and-model cell, from `tag = run` run rows OF ADOPTERS THAT DID NOT
//    DECLARE their own figures, only when AT LEAST THREE such DISTINCT ADOPTERS contribute to it
//    (decision 7, unchanged). A cell under that is withheld. A declaring adopter's rows are in
//    `own` only, so the two never overlap: were they in both, subtracting `own` from a cell
//    would recover a figure of fewer than three adopters (#449's review).
// 2. `own`: an adopter's own lane-and-model cells, only for an adopter whose register entry
//    declares its own figures publishable (`publish_own_figures_as`, off by default), labelled
//    with the label it declared, never its key. They are that adopter's figures, not
//    cross-adopter ones.
// 3. `signals`: what went wrong, by lane, stage, error code and Kanon version, with HOW MANY
//    ADOPTERS were affected, and no cost and no count of runs.
// Nothing names an adopter or carries a key, and `aggregate` refuses to return output that holds
// one as a value. `notes` (cells withheld, rows left out) are totals over every adopter, so they
// are the Owner's only: `publicView` drops them, and the function returns `publicView`.
//
// THE PAGE VIEW (plan 0003 M7, kanon#661), ONLY WHEN ASKED (`?view=page`): the work-item
// indicators the public page shows, cost per merged item, yield and the escape rates by band, with
// their trend and their by-version view, computed by `indicators.mjs` (the report's own core,
// linked into this package) over each DECLARING adopter's run partitions and its `#work`
// partition, under its label. No other adopter's partitions are read for it, so it holds no
// cross-adopter figure: the three-adopter rule holds by construction, and the subtraction guard
// with it. A figure combining adopters (plan 0003 decision 19) is not computed yet. The default
// answer is unchanged, so a reader pinned to an earlier release, which refuses any key it doesn't
// know, keeps reading it.
//
// The same module is the Owner's script's core (`infra/telemetry/aggregate.mjs`) and the
// aggregate-only function's code. The function reads the table with its own role, which IAM
// holds to `Query` with exactly `PROJECTION` (`dynamodb:Attributes`, `dynamodb:Select`), so it
// can't fetch any other field of a row. `node:` built-ins only, like the ingest function.
//
// WHO MAY ASK, AND WHOSE ROWS ARE READ (plan 0008 §3.6, §9, step J4). The function has two URLs
// during vM's overlap, and tells them apart by the qualifier of the ARN Lambda invoked it through
// (`invokedFunctionArn`), never by the request:
// - the unqualified function's URL, `AWS_IAM`, today's path: an invoker role
//   `kanon-telemetry-<key>-aggregates` in this account whose key is in `INVOKER_KEYS`, or the
//   Owner's direct invoke. A bearer token there is refused;
// - the `live` alias's URL, `NONE`, the token path: GitHub's OIDC token, checked by `verifyToken`
//   (`oidc.mjs`) for the `aggregate` endpoint, so the Explorer's `agent-explore-telemetry.yml` at
//   a release, from a registration whose `aggregate_invoker` is true; or, for `?view=page` only,
//   Kanon's `metrics-page.yml` at its registration's default branch, from a registration whose
//   `page_reader` is true (§2.2's exception, `pageReaderOf`). An IAM-shaped request there is
//   refused. The caller's registration is one `GetItem` per request, projected to `AGGREGATE_GET`.
// On BOTH paths, whose rows are read comes from the register table, not the environment: every
// registration whose `status` is `active` (`AGGREGATE_KEYS` no more), its `publish_own_figures_as`
// (`OWN_FIGURES` no more), from one `Scan` projected to `AGGREGATE_SCAN`. A SUSPENDED (or erased)
// key's partitions are never read, so its rows are in no cell, no signal and no page view; and an
// invoker role whose key isn't active is refused. The three-adopter rule counts keys (Owner
// decision 7 of 2026-10-12), so the scan needs no owner id.

import { Buffer } from 'node:buffer';

import { AwsError, dynamoOf, plain as plainAttribute } from './aws.mjs';
import { BAND_VERSION } from './band.mjs';
import {
  MINIMUM, TREND_WINDOWS, WINDOW_DAYS, byVersionOf, deliveryLanes, headlineCells, measure, prepareRows, trendOf,
} from './indicators.mjs';
import { keyCache, verifyToken, WORKFLOW_REPOSITORY } from './oidc.mjs';
import { AGGREGATE_GET, AGGREGATE_SCAN, REGISTER_TABLE, REGISTRATION_PREFIX } from './register-fields.mjs';
import { LANES } from './schema.mjs';
import { RESAMPLES, SEED } from './stats.mjs';

/** Plan 0002 decision 7: a cell that combines adopters is published only at this many or more. */
export const MIN_ADOPTERS = 3;
/** How far back `signals` look, by `recorded_at`: the Explorer's week. */
export const SIGNAL_DAYS = 7;
/** Every attribute the aggregate reads of a run row. `pr_number` and `issue_number` join a run to its work item (plan 0003 §3.4). */
export const PROJECTION = Object.freeze([
  'pk', 'row_kind', 'tag', 'recorded_at', 'lane', 'model', 'total_cost_usd', 'expires_at',
  'outcome', 'reason', 'failed_stage', 'kanon_error', 'kanon_version', 'pr_number', 'issue_number',
]);
/** Every attribute the page view reads of a work-item row: counts, times, enums and the joined numbers, no text. */
export const WORK_PROJECTION = Object.freeze([
  'pk', 'row_kind', 'tag', 'recorded_at', 'expires_at', 'pr_number', 'closed_at', 'fate', 'closing_issues',
  'changed_lines', 'changed_files', 'changed_dirs', 'author_kind', 'revert_days', 'first_fix_days', 'first_verdict',
  'human_commits', 'human_cr_after_approval', 'kanon_version',
]);
/** What the function's role may read, and nothing else: the template's `dynamodb:Attributes`, with `sk`. */
export const ATTRIBUTES = Object.freeze([...new Set([...PROJECTION, ...WORK_PROJECTION])]);
/** The one view a caller may ask for by name (`?view=page`); a GET without one is the aggregate. */
export const PAGE_VIEW = 'page';
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const INVOKER_ROLE = /^kanon-telemetry-([a-z0-9][a-z0-9-]{0,31})-aggregates$/;
const ASSUMED_ROLE = /^arn:aws[a-z-]*:sts::(\d+):assumed-role\/([^/]+)\/[^/]+$/;

/**
 * @typedef {{ pk: string, row_kind?: string, tag?: string, recorded_at?: string, lane?: string,
 *   model?: string, total_cost_usd?: number, expires_at?: number, outcome?: string, reason?: string,
 *   failed_stage?: string, kanon_error?: string, kanon_version?: string }} StoredRow
 * @typedef {{ lane: string, model: string, runs: number, median_cost_usd: number, p90_cost_usd: number }} Cell
 * @typedef {{ lane: string, reason: string | null, failed_stage: string | null, kanon_error: string | null,
 *   kanon_version: string | null, adopters_affected: number }} Signal
 * @typedef {{ cross_adopter: Cell[], own: { label: string, cells: Cell[] }[], signals: Signal[],
 *   notes: { withheld_cells: number, excluded: { no_model: number, no_cost: number } } }} Aggregate
 */

/** The adopter's key: a stored pk is `<key>#<lane>`, and a key never holds `#`. */
export const keyOf = (/** @type {unknown} */ pk) => (typeof pk === 'string' && pk.includes('#') ? pk.slice(0, pk.indexOf('#')) : '');

/**
 * The median: the middle value, or the mean of the two middle values.
 * @param {number[]} sorted ascending, not empty
 */
export function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? /** @type {number} */ (sorted[mid]) : (/** @type {number} */ (sorted[mid - 1]) + /** @type {number} */ (sorted[mid])) / 2;
}

/**
 * The p-th percentile by nearest rank: the smallest value with at least p% of the values at or
 * below it, so it is always a value some run cost.
 * @param {number[]} sorted ascending, not empty
 * @param {number} p in (0, 100]
 */
export function percentile(sorted, p) {
  return /** @type {number} */ (sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]);
}

/** Dollars to a hundredth of a cent, so floating-point noise never reaches the output. */
const usd = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4;

/** One cell's figures, from its costs. */
const figures = (/** @type {string} */ lane, /** @type {string} */ model, /** @type {number[]} */ costs) => {
  const sorted = [...costs].sort((a, b) => a - b);
  return { lane, model, runs: sorted.length, median_cost_usd: usd(median(sorted)), p90_cost_usd: usd(percentile(sorted, 90)) };
};
const byLaneModel = (/** @type {Cell} */ a, /** @type {Cell} */ b) => a.lane.localeCompare(b.lane) || a.model.localeCompare(b.model);
const orNull = (/** @type {unknown} */ v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Plan 0002 §6's aggregate over stored rows. Pure: no AWS, no clock but `now`.
 * @param {StoredRow[]} rows
 * @param {{ now: number, own?: Record<string, string> }} opts `now` in epoch milliseconds (a row
 *   expired by then is not read); `own` maps the key of each adopter that declared its own figures
 *   publishable to the label it declared
 * @returns {Aggregate}
 */
export function aggregate(rows, { now, own = {} }) {
  /** @type {Map<string, { lane: string, model: string, byAdopter: Map<string, number[]> }>} */
  const cells = new Map();
  /** @type {Map<string, { signal: Omit<Signal, 'adopters_affected'>, adopters: Set<string> }>} */
  const signals = new Map();
  const excluded = { no_model: 0, no_cost: 0 };
  /** @type {Set<string>} */
  const keys = new Set();
  const signalsFrom = now - SIGNAL_DAYS * 86_400_000;
  for (const row of rows) {
    if (row.tag !== 'run' || row.row_kind !== 'run') continue;
    if (typeof row.expires_at === 'number' && row.expires_at * 1000 <= now) continue;
    if (typeof row.lane !== 'string' || !LANES.includes(row.lane)) continue;
    const key = keyOf(row.pk);
    if (!key) continue;
    keys.add(key);
    if (row.outcome !== undefined && row.outcome !== 'ok' && Date.parse(row.recorded_at ?? '') >= signalsFrom) {
      const signal = { lane: row.lane, reason: orNull(row.reason), failed_stage: orNull(row.failed_stage), kanon_error: orNull(row.kanon_error), kanon_version: orNull(row.kanon_version) };
      const id = JSON.stringify(signal);
      const s = signals.get(id) ?? { signal, adopters: new Set() };
      signals.set(id, s);
      s.adopters.add(key);
    }
    if (typeof row.model !== 'string' || row.model === '') { excluded.no_model += 1; continue; }
    if (typeof row.total_cost_usd !== 'number' || !Number.isFinite(row.total_cost_usd)) { excluded.no_cost += 1; continue; }
    const id = `${row.lane}\u0000${row.model}`;
    const cell = cells.get(id) ?? { lane: row.lane, model: row.model, byAdopter: /** @type {Map<string, number[]>} */ (new Map()) };
    cells.set(id, cell);
    const mine = cell.byAdopter.get(key) ?? [];
    cell.byAdopter.set(key, mine);
    mine.push(row.total_cost_usd);
  }
  /** @type {Cell[]} */
  const cross = [];
  /** @type {Map<string, Cell[]>} */
  const ownCells = new Map();
  let withheld = 0;
  for (const cell of cells.values()) {
    // One entry per distinct adopter key, declaring adopters left out: that is what the rule counts.
    const others = [...cell.byAdopter].filter(([key]) => !Object.hasOwn(own, key));
    if (others.length >= MIN_ADOPTERS) cross.push(figures(cell.lane, cell.model, others.flatMap(([, costs]) => costs)));
    else if (others.length > 0) withheld += 1;
    for (const [key, costs] of cell.byAdopter) {
      if (!Object.hasOwn(own, key)) continue;
      const label = /** @type {string} */ (own[key]);
      const list = ownCells.get(label) ?? [];
      ownCells.set(label, list);
      list.push(figures(cell.lane, cell.model, costs));
    }
  }
  const result = {
    cross_adopter: cross.sort(byLaneModel),
    own: [...ownCells].map(([label, c]) => ({ label, cells: c.sort(byLaneModel) })).sort((a, b) => a.label.localeCompare(b.label)),
    signals: [...signals.values()].map((s) => ({ ...s.signal, adopters_affected: s.adopters.size }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    notes: { withheld_cells: withheld, excluded },
  };
  assertNoKey(result, keys);
  return result;
}

/** What may leave the Owner: everything but `notes`. */
export const publicView = (/** @type {Aggregate} */ a) => ({ cross_adopter: a.cross_adopter, own: a.own, signals: a.signals });

/**
 * Refuse output that holds an adopter key as a value. The output's shape can't name one, but a
 * `model` or a label is free to match the pattern a key matches, so this is checked, not assumed.
 * @param {unknown} value
 * @param {Set<string>} keys
 */
export function assertNoKey(value, keys) {
  if (typeof value === 'string' && keys.has(value)) throw new Error('the aggregate holds an adopter key; nothing is returned');
  if (value && typeof value === 'object') for (const v of Object.values(value)) assertNoKey(v, keys);
}

/**
 * The function's environment: the keys whose invoker role may call the IAM URL, as `render.mjs`
 * writes them from the register file (`INVOKER_KEYS`), for today's path until vM+1 removes the
 * roles. Which keys are aggregated, and under which labels, is the register table's
 * (`registrationsFrom`): `AGGREGATE_KEYS` and `OWN_FIGURES` are no longer read.
 * @param {{ INVOKER_KEYS?: string }} env
 */
export function configOf(env) {
  const invokers = (env.INVOKER_KEYS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!invokers.every((k) => KEY.test(k))) throw new Error('INVOKER_KEYS is malformed');
  return { invokers };
}

/**
 * @typedef {{ pk?: string, key?: string, status?: string, publish_own_figures_as?: string }} ScannedRegistration
 * @typedef {{ keys: string[], known: string[], own: Record<string, string> }} RegisterConfig
 */

/**
 * Whose rows the aggregate reads, from the register table's registrations (plan 0008 §3.6):
 * `keys`, every ACTIVE registration's key, which replaces `AGGREGATE_KEYS`; `own`, `key=label`
 * for each active registration with `publish_own_figures_as`, which replaces `OWN_FIGURES`; and
 * `known`, every key the table holds whatever its status, which no label may equal. A suspended
 * or erased registration's key is in neither `keys` nor `own`, so none of its partitions is read.
 * Items that aren't registrations (key items, counters) are skipped, and so is a registration with
 * no key (an erasure's tombstone). Throws on a registration it can't read, rather than guess: a
 * key or a label outside the key's pattern, a label that is a key, or a label two share.
 * @param {readonly ScannedRegistration[]} items
 * @returns {RegisterConfig}
 */
export function registrationsFrom(items) {
  const registrations = items.filter((i) => typeof i.pk === 'string' && i.pk.startsWith(REGISTRATION_PREFIX) && i.key !== undefined);
  /** @type {Set<string>} */
  const known = new Set();
  for (const r of registrations) {
    if (typeof r.key !== 'string' || !KEY.test(r.key)) throw new Error('a registration\'s key is malformed');
    known.add(r.key);
  }
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {Set<string>} */
  const labels = new Set();
  /** @type {Record<string, string>} */
  const own = {};
  for (const r of registrations) {
    const key = /** @type {string} */ (r.key);
    if (r.status !== 'active') continue;
    keys.add(key);
    const label = r.publish_own_figures_as;
    if (label === undefined) continue;
    if (typeof label !== 'string' || !KEY.test(label) || known.has(label) || labels.has(label)) throw new Error('a registration\'s label is malformed');
    labels.add(label);
    own[key] = label;
  }
  return { keys: [...keys], known: [...known], own };
}

/** The value of one DynamoDB attribute, or undefined. */
const plain = (/** @type {any} */ v) => (v === undefined ? undefined : 'S' in v ? v.S : 'N' in v ? Number(v.N) : undefined);

/**
 * A DynamoDB item, projected, as a plain row, with the attributes it holds.
 * @param {Record<string, any>} item @param {readonly string[]} [projection]
 */
export const rowOf = (item, projection = PROJECTION) =>
  /** @type {StoredRow} */ (Object.fromEntries(projection.map((a) => [a, plain(item[a])]).filter(([, v]) => v !== undefined)));

/**
 * The Query request for one partition: `tag = run` rows, exactly `projection`, and `Select`
 * named, because the role's policy requires it.
 * @param {string} table
 * @param {string} partition
 * @param {Record<string, any>} [start]
 * @param {readonly string[]} [projection]
 */
export function queryRequest(table, partition, start, projection = PROJECTION) {
  return {
    TableName: table,
    KeyConditionExpression: '#pk = :p',
    FilterExpression: '#tag = :run',
    ProjectionExpression: projection.map((a) => `#${a}`).join(', '),
    ExpressionAttributeNames: Object.fromEntries(projection.map((a) => [`#${a}`, a])),
    ExpressionAttributeValues: { ':p': { S: partition }, ':run': { S: 'run' } },
    Select: 'SPECIFIC_ATTRIBUTES',
    ...(start ? { ExclusiveStartKey: start } : {}),
  };
}

/**
 * Every key's run partitions, through `query` (one DynamoDB Query page per call).
 * @param {string[]} keys
 * @param {(request: Record<string, any>) => Promise<{ Items?: Record<string, any>[], LastEvaluatedKey?: Record<string, any> }>} query
 * @param {string} table
 */
export async function readAll(keys, query, table) {
  /** @type {StoredRow[]} */
  const rows = [];
  for (const key of keys) {
    for (const lane of LANES) {
      /** @type {Record<string, any> | undefined} */
      let start;
      do {
        const page = await query(queryRequest(table, `${key}#${lane}`, start));
        for (const item of page.Items ?? []) rows.push(rowOf(item));
        start = page.LastEvaluatedKey;
      } while (start);
    }
  }
  return rows;
}

/**
 * The page view's rows: each declaring adopter's run partitions, every lane, and its `#work`
 * partition, and no other adopter's (plan 0003 M7).
 * @param {Record<string, string>} own the declaring adopters' keys, to their labels
 * @param {(request: Record<string, any>) => Promise<{ Items?: Record<string, any>[], LastEvaluatedKey?: Record<string, any> }>} query
 * @param {string} table
 */
export async function readPage(own, query, table) {
  const keys = Object.keys(own);
  const rows = await readAll(keys, query, table);
  for (const key of keys) {
    /** @type {Record<string, any> | undefined} */
    let start;
    do {
      const page = await query(queryRequest(table, `${key}#work`, start, WORK_PROJECTION));
      for (const item of page.Items ?? []) rows.push(rowOf(item, WORK_PROJECTION));
      start = page.LastEvaluatedKey;
    } while (start);
  }
  return rows;
}

const DAY_MS = 86_400_000;
/** The schema's delivery lanes, for the indicators' cost and yield. */
const DELIVERY = deliveryLanes(LANES);

/**
 * The page view (plan 0003 M7, §6.1's headline, trend and by-version views): for each adopter
 * that declared its own figures, under its label, the indicators over its rows alone, as one
 * adopter. Rows of any other adopter are not read, so nothing here combines adopters. The window
 * ends at the start of the UTC day of `now`, so a page computed twice in a day is the same. Pure.
 * @param {readonly Record<string, unknown>[]} rows stored rows, run and work-item, in the projections
 * @param {{ now: number, own?: Record<string, string>, keys?: readonly string[] }} opts `keys`: every
 *   adopter's key, which no label may equal. The rows hold only the declaring adopters' keys, so
 *   without them a label equal to another adopter's key would pass.
 */
export function pageView(rows, { now, own = {}, keys: known = [] }) {
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const width = WINDOW_DAYS * DAY_MS;
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byKey = new Map();
  /** @type {Set<string>} */
  const keys = new Set(known);
  for (const row of rows) {
    const key = keyOf(row.pk);
    if (!key) continue;
    keys.add(key);
    if (!Object.hasOwn(own, key)) continue;
    if (typeof row.expires_at === 'number' && row.expires_at * 1000 <= now) continue;
    const { pk } = row;
    const plainRow = { ...row };
    delete plainRow.pk;
    delete plainRow.expires_at;
    if (row.row_kind === 'run' && (typeof row.lane !== 'string' || !LANES.includes(row.lane) || pk !== `${key}#${row.lane}`)) continue;
    if (row.row_kind === 'work_item' && pk !== `${key}#work`) continue;
    const list = byKey.get(key) ?? [];
    byKey.set(key, list);
    list.push(plainRow);
  }
  const entries = Object.entries(own).map(([key, label]) => {
    const ctx = prepareRows(byKey.get(key) ?? [], DELIVERY);
    const h = headlineCells(measure(ctx, { start: end - width, end }));
    const escape = (/** @type {any} */ e) => ({ merged_from: e.mergedFrom, merged_until: e.mergedUntil, cells: e.agent });
    return {
      label,
      adopters: 1,
      window: { from: new Date(end - width).toISOString().slice(0, 10), until: new Date(end).toISOString().slice(0, 10), days: WINDOW_DAYS },
      headline: {
        view: h.view,
        validity: { status: h.validity.status, n: h.validity.n, tau: h.validity.tau, low: h.validity.low, high: h.validity.high },
        cost: h.cost,
        yield: h.yield,
        escape: { d30: escape(h.escape.d30), d90: escape(h.escape.d90) },
        approval: h.approval,
        correction: h.correction,
      },
      trend: trendOf(ctx, { end, days: WINDOW_DAYS, windows: TREND_WINDOWS }),
      by_version: byVersionOf(ctx, { start: end - TREND_WINDOWS * width, end }),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const result = {
    computed_at: new Date(now).toISOString(),
    view: PAGE_VIEW,
    min_adopters: MIN_ADOPTERS,
    band_version: BAND_VERSION,
    cost_basis: 'API list price',
    window_days: WINDOW_DAYS,
    trend_windows: TREND_WINDOWS,
    minimum: { ...MINIMUM },
    bootstrap: { resamples: RESAMPLES, seed: SEED },
    own: entries,
  };
  assertNoKey(result, keys);
  return result;
}

/** A register item, as plain values, holding only `projection`'s attributes. @param {Record<string, any>} item @param {readonly string[]} projection */
const registerItemOf = (item, projection) =>
  Object.fromEntries(projection.map((a) => [a, plainAttribute(item[a])]).filter(([, v]) => v !== undefined));
const named = (/** @type {readonly string[]} */ projection) => ({
  ProjectionExpression: projection.map((a) => `#${a}`).join(', '),
  ExpressionAttributeNames: Object.fromEntries(projection.map((a) => [`#${a}`, a])),
});

/**
 * The Scan of the registrations: exactly `AGGREGATE_SCAN`, and `Select` named, because the role's
 * policy requires both (plan 0008 §5.3).
 * @param {string} table @param {Record<string, any>} [start]
 */
export const scanRequest = (table, start) => ({
  TableName: table, ...named(AGGREGATE_SCAN), Select: 'SPECIFIC_ATTRIBUTES', ...(start ? { ExclusiveStartKey: start } : {}),
});

/**
 * The GetItem of the caller's registration: exactly `AGGREGATE_GET` (GetItem takes no `Select`).
 * @param {string} table @param {string} repositoryId
 */
export const getRequest = (table, repositoryId) => ({
  TableName: table, Key: { pk: { S: `${REGISTRATION_PREFIX}${repositoryId}` } }, ...named(AGGREGATE_GET),
});

/**
 * Every item of the register, projected, through `scan` (one DynamoDB Scan page per call).
 * @param {(request: Record<string, any>) => Promise<{ Items?: Record<string, any>[], LastEvaluatedKey?: Record<string, any> }>} scan
 * @param {string} table
 * @returns {Promise<ScannedRegistration[]>}
 */
export async function scanRegister(scan, table) {
  /** @type {ScannedRegistration[]} */
  const items = [];
  /** @type {Record<string, any> | undefined} */
  let start;
  do {
    const page = await scan(scanRequest(table, start));
    for (const item of page.Items ?? []) items.push(registerItemOf(item, AGGREGATE_SCAN));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

/** How long a container keeps the register's scan, as the ingest function keeps its keys (plan 0008 §3.4, §3.6). */
export const REGISTER_TTL_MS = 5 * 60_000;

/**
 * A container's cache of the register's scan: the last answer, for `REGISTER_TTL_MS`. A failed
 * scan is not cached. A suspension reaches the cells within this time; the caller's own
 * registration is read on every request, so a suspended caller is refused on its next one.
 */
export function registerCache() {
  /** @type {{ at: number, items: ScannedRegistration[] } | undefined} */
  let held;
  return {
    /** @param {number} now @param {() => Promise<ScannedRegistration[]>} load */
    async get(now, load) {
      if (held && now - held.at < REGISTER_TTL_MS) return held.items;
      const items = await load();
      held = { at: now, items };
      return items;
    },
  };
}

/** The alias whose URL serves the token path (plan 0008 §9). */
export const TOKEN_ALIAS = 'live';
/** The token path's endpoint for `verifyToken`: the Explorer's workflow at a release. */
export const AGGREGATE_ENDPOINT = 'aggregate';
/** §2.2's exception: Kanon's own metrics page workflow, at its registration's default branch. */
export const METRICS_PAGE_WORKFLOW = `${WORKFLOW_REPOSITORY}/.github/workflows/metrics-page.yml`;
const METRICS_PAGE_REF = new RegExp(`^${METRICS_PAGE_WORKFLOW.replace(/[.-]/g, '\\$&')}@(refs/heads/\\S+)$`);
const ID = /^[1-9][0-9]{0,19}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const LAMBDA_ARN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d+:function:[A-Za-z0-9_-]+(?::([A-Za-z0-9$_-]+))?$/;

/**
 * Which URL the request came through, from the ARN Lambda invoked: `iam` for the unqualified
 * function (today's path), `token` for the `live` alias, `null` for any other qualifier or a
 * malformed ARN. With no ARN, `iam`: Lambda always passes one, and the tests that call `handle`
 * without one exercise today's path.
 * @param {unknown} arn
 * @returns {'iam' | 'token' | null}
 */
export function pathOf(arn) {
  if (arn === undefined) return 'iam';
  const m = typeof arn === 'string' ? LAMBDA_ARN.exec(arn) : null;
  if (!m) return null;
  if (m[1] === undefined) return 'iam';
  return m[1] === TOKEN_ALIAS ? 'token' : null;
}

/**
 * The bearer token of a request: `undefined` with no `Authorization` header, `''` for one that
 * isn't `Bearer <token>` (a SigV4 signature among them). Function URL events carry header names
 * in lower case.
 * @param {any} event
 */
export function bearerOf(event) {
  const headers = event?.headers ?? {};
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  if (value === undefined) return undefined;
  const m = typeof value === 'string' ? /^Bearer (\S+)$/.exec(value) : null;
  return m ? /** @type {string} */ (m[1]) : '';
}

/**
 * @typedef {{ key?: unknown, status?: unknown, repository_owner_id?: unknown, default_ref?: unknown,
 *   aggregate_invoker?: unknown, page_reader?: unknown }} CallerRegistration
 * @typedef {{ ok: false, status: number, error: string }} Refused
 */

/** The JSON payload of a compact JWS, or undefined; read only after `verifyToken` checked its signature. */
function payloadOf(/** @type {string} */ token) {
  try {
    const v = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : undefined;
  } catch {
    return undefined;
  }
}

/** @returns {Refused} */
const refused = (/** @type {number} */ status, /** @type {string} */ error) => ({ ok: false, status, error });

/** A registration that may read is `active`; otherwise, the refusal its status gives. */
function statusRefusal(/** @type {CallerRegistration} */ registration) {
  if (registration.status === 'active') return null;
  return registration.status === 'erased' ? refused(410, 'erased') : refused(403, 'suspended');
}

/**
 * §2.2's one exception: Kanon's metrics page workflow, which runs from Kanon's default branch and
 * so carries no release tag, may read the PAGE VIEW ONLY (`handle` holds it to `?view=page`).
 * The Owner's decision 11 of 2026-10-12 (plan 0008); without the operator's `page_reader` on a
 * registration it admits nothing.
 *
 * Called only when `verifyToken` refused the token at check 7 (403 `workflow`): it stops at the
 * first failure, so checks 1 to 6 (the algorithm, the signature against GitHub's keys, the
 * issuer, the audience, the times and the trigger) have passed, and the payload read here is
 * GitHub's. Answers `undefined` when the token isn't the metrics page's, so the caller keeps
 * check 7's refusal; otherwise the exception's own refusal, or the admitted registration. In
 * order: `workflow_ref` is exactly Kanon's `metrics-page.yml` at a branch; `job_workflow_ref` is
 * absent or equal to it, so no reusable workflow called inside it qualifies; check 8 (the ids and
 * the registration's owner); `workflow_ref`'s branch is the registration's `default_ref`; check 9
 * (`ref_type` and `ref`, strictly: no `schedule` leniency, since the aggregate never moves
 * `default_ref`); the registration is active; and its `page_reader` is true.
 * @param {string} token
 * @param {(repositoryId: string) => Promise<CallerRegistration | undefined>} registrationOf
 * @returns {Promise<Refused | { ok: true, registration: CallerRegistration } | undefined>}
 */
export async function pageReaderOf(token, registrationOf) {
  const c = payloadOf(token);
  const m = c && typeof c.workflow_ref === 'string' ? METRICS_PAGE_REF.exec(c.workflow_ref) : null;
  if (!c || !m) return undefined;
  if (c.job_workflow_ref !== undefined && c.job_workflow_ref !== c.workflow_ref) return refused(403, 'workflow');
  if (typeof c.repository_id !== 'string' || !ID.test(c.repository_id)) return refused(403, 'owner');
  if (typeof c.repository_owner_id !== 'string' || !ID.test(c.repository_owner_id)) return refused(403, 'owner');
  const registration = await registrationOf(c.repository_id);
  if (!registration) return refused(404, 'not-registered');
  if (registration.repository_owner_id !== c.repository_owner_id) return refused(403, 'owner');
  if (typeof registration.default_ref !== 'string' || m[1] !== registration.default_ref) return refused(403, 'workflow');
  if (c.ref_type !== 'branch' || c.ref !== registration.default_ref) return refused(403, 'ref');
  const status = statusRefusal(registration);
  if (status) return status;
  if (registration.page_reader !== true) return refused(403, 'workflow');
  return { ok: true, registration };
}

/**
 * The token path's caller (plan 0008 §3.6): `verifyToken` for the `aggregate` endpoint, then the
 * registration's status and its `aggregate_invoker`, READ FROM THE TABLE, never from the token;
 * or, refused at check 7, §2.2's metrics page exception, for the page view alone.
 * @param {string} token
 * @param {{ audience: string, minTokenVersion: string, now: number, keys: import('./oidc.mjs').KeyCache,
 *   registrationOf: (repositoryId: string) => Promise<CallerRegistration | undefined> }} opts
 * @returns {Promise<Refused | { ok: true, pageOnly: boolean }>}
 */
export async function tokenCaller(token, { audience, minTokenVersion, now, keys, registrationOf }) {
  const verdict = await verifyToken(token, { audience, endpoint: AGGREGATE_ENDPOINT, now, keys, minTokenVersion, registrationOf });
  if (verdict.ok) {
    const registration = /** @type {CallerRegistration} */ (verdict.registration);
    const status = statusRefusal(registration);
    if (status) return status;
    if (registration.aggregate_invoker !== true) return refused(403, 'invoker');
    return { ok: true, pageOnly: false };
  }
  if (verdict.status === 403 && verdict.error === 'workflow') {
    const page = await pageReaderOf(token, registrationOf);
    if (page) return page.ok ? { ok: true, pageOnly: true } : page;
  }
  return refused(verdict.status, verdict.error);
}

const reply = (/** @type {number} */ statusCode, /** @type {unknown} */ body, /** @type {Record<string, string>} */ extra = {}) => ({
  statusCode,
  headers: /** @type {Record<string, string>} */ ({ 'content-type': 'application/json', ...extra }),
  body: JSON.stringify(body),
});
/** A refusal's answer: its code alone, and on a 401 the bearer challenge (plan 0008 §3.1). */
const refusal = (/** @type {Refused} */ r) =>
  reply(r.status, { error: r.error }, r.status === 401 ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {});

/**
 * The key of a URL call from an invoker role, `kanon-telemetry-<key>-aggregates` in this account
 * whose key is in `invokers`; `''` for a direct invoke (no `requestContext`), which needs
 * `lambda:InvokeFunction` outside the URL, which only the Owner holds; `null` for anyone else.
 * @param {any} event
 * @param {{ ACCOUNT_ID?: string }} env
 * @param {string[]} invokers
 * @returns {string | null}
 */
export function invokerKeyOf(event, env, invokers) {
  if (event?.requestContext === undefined) return '';
  const arn = event.requestContext?.authorizer?.iam?.userArn;
  const m = typeof arn === 'string' ? ASSUMED_ROLE.exec(arn) : null;
  const role = m ? INVOKER_ROLE.exec(/** @type {string} */ (m[2])) : null;
  const key = role ? /** @type {string} */ (role[1]) : '';
  return m && role && m[1] === env.ACCOUNT_ID && invokers.includes(key) ? key : null;
}

/**
 * Whether a URL call comes from a registered invoker role, `kanon-telemetry-<key>-aggregates` in
 * this account. A direct invoke (no `requestContext`) needs `lambda:InvokeFunction` outside the
 * URL, which only the Owner holds.
 * @param {any} event
 * @param {{ ACCOUNT_ID?: string }} env
 * @param {string[]} invokers
 */
export const callerAllowed = (event, env, invokers) => invokerKeyOf(event, env, invokers) !== null;

/**
 * Which view a request asks for: the aggregate, with no query; the page view, with exactly
 * `view=page`; anything else is refused, so a caller can't name an adopter or narrow a cell.
 * @param {any} event
 * @returns {'aggregate' | 'page' | null}
 */
export function viewOf(event) {
  const params = event?.queryStringParameters ?? {};
  const names = Object.keys(params);
  if (names.length === 0) return 'aggregate';
  return names.length === 1 && params.view === PAGE_VIEW ? 'page' : null;
}

/** @typedef {(request: Record<string, any>) => Promise<any>} DynamoPage */

/**
 * What a failed DynamoDB call may log: the operation and AWS's error code (`AwsError`, which keeps
 * nothing of AWS's message) or an HTTP status, and otherwise `fallback`. Any other message could
 * carry a partition, and so a key.
 * @param {unknown} e @param {'Query' | 'Scan' | 'GetItem'} op @param {string} fallback
 */
function failureOf(e, op, fallback) {
  if (e instanceof AwsError && e.message.startsWith(`${op} failed: `) && /^[A-Za-z0-9]+$/.test(String(e.code))) return `${op} ${e.code}`;
  return e instanceof Error && new RegExp(`^${op} \\d{3}$`).test(e.message) ? e.message : fallback;
}

/** One JWKS cache per container (plan 0008 §2.4). */
const containerKeys = keyCache();

/**
 * The aggregate-only function: a GET answers `publicView` of the aggregate, or, asked for it by
 * name, the page view, and nothing else. It takes no other input, so a caller can't narrow a cell
 * to one adopter. Who may ask, and whose rows are read: the header above.
 * @param {any} event
 * @param {{ env?: Record<string, string | undefined>, now?: () => number,
 *   query?: DynamoPage, scan?: DynamoPage, getItem?: DynamoPage, log?: (line: string) => void,
 *   invokedArn?: string, keys?: import('./oidc.mjs').KeyCache,
 *   register?: { get: (now: number, load: () => Promise<ScannedRegistration[]>) => Promise<ScannedRegistration[]> } }} [deps]
 */
export async function handle(event, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((/** @type {string} */ line) => console.log(line));
  if (event?.requestContext !== undefined && event.requestContext?.http?.method !== 'GET') return reply(405, { error: 'method' });
  const path = pathOf(deps.invokedArn);
  if (path === null) return reply(403, { error: 'caller' });
  let config;
  try {
    config = configOf(env);
  } catch {
    log('configuration: malformed');
    return reply(500, { error: 'configuration' });
  }
  const now = (deps.now ?? Date.now)();
  const db = dynamoOf(env);
  const query = deps.query ?? ((/** @type {Record<string, any>} */ r) => db('Query', r));
  const scan = deps.scan ?? ((/** @type {Record<string, any>} */ r) => db('Scan', r));
  const getItem = deps.getItem ?? ((/** @type {Record<string, any>} */ r) => db('GetItem', r));
  const table = env.TABLE_NAME ?? 'kanon-telemetry';
  const registerTable = env.REGISTER_TABLE ?? REGISTER_TABLE;
  const bearer = bearerOf(event);

  // Who is asking: on the alias, a token and nothing else; on the IAM URL, a role and never a token.
  let pageOnly = false;
  /** @type {string | null} */
  let invokerKey = '';
  if (path === 'token') {
    if (event?.requestContext?.authorizer?.iam !== undefined) return reply(403, { error: 'caller' });
    if (!bearer) return refusal(refused(401, 'token'));
    const audience = env.AUDIENCE;
    const minTokenVersion = env.MIN_TOKEN_VERSION;
    // As the ingest function's token path (J3): an empty `MinTokenVersion` admits no token.
    if (!audience || typeof minTokenVersion !== 'string' || !VERSION.test(minTokenVersion)) {
      log('aggregate: refused (config)');
      return reply(503, { error: 'config' });
    }
    /** @param {string} repositoryId */
    const registrationOf = async (repositoryId) => {
      const res = await getItem(getRequest(registerTable, repositoryId));
      return res?.Item ? /** @type {CallerRegistration} */ (registerItemOf(res.Item, AGGREGATE_GET)) : undefined;
    };
    let caller;
    try {
      caller = await tokenCaller(bearer, { audience, minTokenVersion, now, keys: deps.keys ?? containerKeys, registrationOf });
    } catch (e) {
      const status = failureOf(e, 'GetItem', 'error');
      log(`aggregate: failed (${status})`);
      return reply(502, { error: 'aggregate' });
    }
    if (!caller.ok) {
      log(`aggregate: refused (${caller.status} ${caller.error})`);
      return refusal(caller);
    }
    pageOnly = caller.pageOnly;
  } else {
    if (bearer) return reply(403, { error: 'caller' });
    invokerKey = invokerKeyOf(event, env, config.invokers);
    if (invokerKey === null) return reply(403, { error: 'caller' });
  }
  const view = viewOf(event);
  if (view === null) return reply(400, { error: 'view' });
  // §2.2's exception reads the page view and nothing else.
  if (pageOnly && view !== 'page') return refusal(refused(403, 'workflow'));

  let register;
  try {
    const load = () => scanRegister(scan, registerTable);
    register = registrationsFrom(deps.register ? await deps.register.get(now, load) : await load());
  } catch (e) {
    const status = failureOf(e, 'Scan', 'register');
    log(`aggregate: failed (${status})`);
    return reply(502, { error: 'aggregate' });
  }
  // An invoker role reads only while its key's registration is active (plan 0008 §9's overlap).
  if (invokerKey && !register.keys.includes(invokerKey)) {
    return register.known.includes(invokerKey) ? reply(403, { error: 'suspended' }) : reply(404, { error: 'not-registered' });
  }
  let result;
  try {
    if (view === 'page') {
      const page = pageView(await readPage(register.own, query, table), { now, own: register.own, keys: register.known });
      log(`aggregate: page view, ${page.own.length} own`);
      return reply(200, page);
    }
    result = aggregate(await readAll(register.keys, query, table), { now, own: register.own });
  } catch (e) {
    // No detail but DynamoDB's status: any other message could carry a partition, and so a key.
    const status = failureOf(e, 'Query', 'error');
    log(`aggregate: failed (${status})`);
    return reply(502, { error: 'aggregate' });
  }
  log(`aggregate: ${result.cross_adopter.length} cross-adopter cells, ${result.own.length} own, ${result.signals.length} signals`);
  return reply(200, {
    computed_at: new Date(now).toISOString(),
    min_adopters: MIN_ADOPTERS,
    signal_days: SIGNAL_DAYS,
    ...publicView(result),
  });
}

/** One register cache per container (plan 0008 §3.6). */
const containerRegister = registerCache();

export const handler = (/** @type {any} */ event, /** @type {any} */ context) =>
  handle(event, { invokedArn: context?.invokedFunctionArn, keys: containerKeys, register: containerRegister });
