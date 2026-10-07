// The aggregate (plan 0002 §6, and §6.1 as the Owner decided on 2026-10-07, #443): one pure
// function over stored rows, and the aggregate-only function that serves it.
//
// WHAT MAY LEAVE, AND NOTHING ELSE (§6.1, items 1 to 3):
// 1. `cross_adopter`: a lane-and-model cell, from `tag = run` run rows, only when AT LEAST THREE
//    DISTINCT ADOPTERS contribute to it (decision 7, unchanged). A cell under that is withheld.
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
// The same module is the Owner's script's core (`infra/telemetry/aggregate.mjs`) and the
// aggregate-only function's code. The function reads the table with its own role, which IAM
// holds to `Query` with exactly `PROJECTION` (`dynamodb:Attributes`, `dynamodb:Select`), so it
// can't fetch any other field of a row. `node:` built-ins only, like the ingest function.

import { LANES } from './schema.mjs';
import { sign } from './sigv4.mjs';

/** Plan 0002 decision 7: a cell that combines adopters is published only at this many or more. */
export const MIN_ADOPTERS = 3;
/** How far back `signals` look, by `recorded_at`: the Explorer's week. */
export const SIGNAL_DAYS = 7;
/** Every attribute the aggregate reads. The function's role may read these and no others. */
export const PROJECTION = Object.freeze([
  'pk', 'row_kind', 'tag', 'recorded_at', 'lane', 'model', 'total_cost_usd', 'expires_at',
  'outcome', 'reason', 'failed_stage', 'kanon_error', 'kanon_version',
]);
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
  /** @type {Map<string, { lane: string, model: string, costs: number[], byAdopter: Map<string, number[]> }>} */
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
    const cell = cells.get(id) ?? { lane: row.lane, model: row.model, costs: /** @type {number[]} */ ([]), byAdopter: new Map() };
    cells.set(id, cell);
    cell.costs.push(row.total_cost_usd);
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
    // One entry per distinct adopter key: that is what the rule counts.
    if (cell.byAdopter.size >= MIN_ADOPTERS) cross.push(figures(cell.lane, cell.model, cell.costs));
    else withheld += 1;
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

/** A DynamoDB item, projected, as a plain row. */
export const rowOf = (/** @type {Record<string, any>} */ item) =>
  /** @type {StoredRow} */ (Object.fromEntries(PROJECTION.map((a) => [a, plain(item[a])])));

/**
 * The Query request for one partition: `tag = run` rows, exactly `PROJECTION`, and `Select`
 * named, because the role's policy requires it.
 * @param {string} table
 * @param {string} partition
 * @param {Record<string, any>} [start]
 */
export function queryRequest(table, partition, start) {
  return {
    TableName: table,
    KeyConditionExpression: '#pk = :p',
    FilterExpression: '#tag = :run',
    ProjectionExpression: PROJECTION.map((a) => `#${a}`).join(', '),
    ExpressionAttributeNames: Object.fromEntries(PROJECTION.map((a) => [`#${a}`, a])),
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
 * The aggregate-only function: a GET answers `publicView` of the aggregate, and nothing else.
 * It takes no input, so a caller can't narrow a cell to one adopter.
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
  const now = (deps.now ?? Date.now)();
  const query = deps.query ?? ((/** @type {Record<string, any>} */ r) => dynamoQuery(r, env.AWS_REGION ?? 'eu-central-1'));
  let result;
  try {
    result = aggregate(await readAll(config.keys, query, env.TABLE_NAME ?? 'kanon-telemetry'), { now, own: config.own });
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
