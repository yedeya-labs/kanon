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

import { BAND_VERSION } from './band.mjs';
import {
  MINIMUM, TREND_WINDOWS, WINDOW_DAYS, byVersionOf, deliveryLanes, headlineCells, measure, prepareRows, trendOf,
} from './indicators.mjs';
import { LANES } from './schema.mjs';
import { sign } from './sigv4.mjs';
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
 * The function's environment, as `render.mjs` writes it from the register: every key, and
 * `key=label` for each adopter that declared its own figures publishable.
 * @param {{ AGGREGATE_KEYS?: string, OWN_FIGURES?: string, INVOKER_KEYS?: string }} env
 */
export function configOf(env) {
  const list = (/** @type {string | undefined} */ s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const keys = list(env.AGGREGATE_KEYS);
  /** @type {Record<string, string>} */
  const own = {};
  for (const pair of list(env.OWN_FIGURES)) {
    const [k, label, ...rest] = pair.split('=');
    if (!k || !label || rest.length || !KEY.test(k) || !KEY.test(label) || !keys.includes(k)) throw new Error('OWN_FIGURES is malformed');
    own[k] = label;
  }
  if (!keys.every((k) => KEY.test(k))) throw new Error('AGGREGATE_KEYS is malformed');
  return { keys, own, invokers: list(env.INVOKER_KEYS) };
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

/**
 * One DynamoDB Query over HTTPS, signed with the function's own credentials.
 * @param {Record<string, any>} request
 * @param {string} region
 * @param {typeof fetch} [fetchImpl]
 */
export async function dynamoQuery(request, region, fetchImpl = fetch) {
  const url = `https://dynamodb.${region}.amazonaws.com/`;
  const body = JSON.stringify(request);
  const headers = { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.Query' };
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { ...headers, ...sign({ method: 'POST', url, headers, body, region, service: 'dynamodb', credentials }) },
    body,
  });
  if (!res.ok) throw new Error(`Query ${res.status}`);
  return res.json();
}

const reply = (/** @type {number} */ statusCode, /** @type {unknown} */ body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Whether a URL call comes from a registered invoker role, `kanon-telemetry-<key>-aggregates` in
 * this account. A direct invoke (no `requestContext`) needs `lambda:InvokeFunction` outside the
 * URL, which only the Owner holds.
 * @param {any} event
 * @param {{ ACCOUNT_ID?: string }} env
 * @param {string[]} invokers
 */
export function callerAllowed(event, env, invokers) {
  if (event?.requestContext === undefined) return true;
  const arn = event.requestContext?.authorizer?.iam?.userArn;
  const m = typeof arn === 'string' ? ASSUMED_ROLE.exec(arn) : null;
  const role = m ? INVOKER_ROLE.exec(/** @type {string} */ (m[2])) : null;
  return Boolean(m && role && m[1] === env.ACCOUNT_ID && invokers.includes(/** @type {string} */ (role[1])));
}

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

/**
 * The aggregate-only function: a GET answers `publicView` of the aggregate, or, asked for it by
 * name, the page view, and nothing else. It takes no other input, so a caller can't narrow a cell
 * to one adopter.
 * @param {any} event
 * @param {{ env?: Record<string, string | undefined>, now?: () => number,
 *   query?: (request: Record<string, any>) => Promise<any>, log?: (line: string) => void }} [deps]
 */
export async function handle(event, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((/** @type {string} */ line) => console.log(line));
  if (event?.requestContext !== undefined && event.requestContext?.http?.method !== 'GET') return reply(405, { error: 'method' });
  let config;
  try {
    config = configOf(env);
  } catch {
    log('configuration: malformed');
    return reply(500, { error: 'configuration' });
  }
  if (!callerAllowed(event, env, config.invokers)) return reply(403, { error: 'caller' });
  const view = viewOf(event);
  if (view === null) return reply(400, { error: 'view' });
  const now = (deps.now ?? Date.now)();
  const query = deps.query ?? ((/** @type {Record<string, any>} */ r) => dynamoQuery(r, env.AWS_REGION ?? 'eu-central-1'));
  const table = env.TABLE_NAME ?? 'kanon-telemetry';
  let result;
  try {
    if (view === 'page') {
      const page = pageView(await readPage(config.own, query, table), { now, own: config.own, keys: config.keys });
      log(`aggregate: page view, ${page.own.length} own`);
      return reply(200, page);
    }
    result = aggregate(await readAll(config.keys, query, table), { now, own: config.own });
  } catch (e) {
    // No detail but DynamoDB's status: any other message could carry a partition, and so a key.
    const status = e instanceof Error && /^Query \d{3}$/.test(e.message) ? e.message : 'error';
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

export const handler = (/** @type {any} */ event) => handle(event);
