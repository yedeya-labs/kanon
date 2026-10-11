// Kanon's dated list-price table, and the cache savings it prices (plan 0003 §4, group 8; §2.2's
// secondary measure beside cost).
//
// CACHE SAVINGS = cache-read tokens × (input price − cache-read price): what a run's cache reads
// would have cost as uncached input, less what they did cost, at the API LIST PRICE (decision 1).
// It is computed in the reader from the run row's `cache_read_tokens` and `model`, never stored.
//
// DATED, SO A PRICE CHANGE NEVER REWRITES HISTORY. Each entry holds from its `from` date (UTC) until
// a later entry for the same model; a run is priced by the entry in force when it was recorded.
// A price change is a new entry, released with a changelog line, and the old one stays.
//
// A RUN THE TABLE CAN'T PRICE IS UNKNOWN, NEVER $0, and counted: a model the table doesn't hold, a
// run recorded before its model's first entry, a run with no `cache_read_tokens`, and a
// long-context (`[1m]`) variant, whose cache reads are priced by request size, which the row
// doesn't carry. A run is priced at its `model`, the one that billed most (`agent-telemetry`), so
// the reads of a second, cheaper model in the same run are priced at the first's rates.
//
// Pure, and imports nothing (`K-SELF-8`).

/**
 * @typedef {{ model: string, from: string, input: number, cacheRead: number }} Price US dollars per
 *   million tokens: `input` the base input price, `cacheRead` a cache hit's
 */

/**
 * The table. A model id matches an entry's `model` exactly, or with the API's `-YYYYMMDD` snapshot
 * date after it. Each entry's `from` is 2026-09-04, the first day of Kanon's cost rows (plan 0002
 * §1.3): these were each model's list prices then. A model not here is unpriced until a release
 * adds it.
 * @type {readonly Readonly<Price>[]}
 */
export const PRICES = Object.freeze([
  { model: 'claude-opus-4', from: '2026-09-04', input: 15, cacheRead: 1.5 },
  { model: 'claude-opus-4-1', from: '2026-09-04', input: 15, cacheRead: 1.5 },
  { model: 'claude-opus-4-5', from: '2026-09-04', input: 5, cacheRead: 0.5 },
  { model: 'claude-sonnet-4', from: '2026-09-04', input: 3, cacheRead: 0.3 },
  { model: 'claude-sonnet-4-5', from: '2026-09-04', input: 3, cacheRead: 0.3 },
  { model: 'claude-3-7-sonnet', from: '2026-09-04', input: 3, cacheRead: 0.3 },
  { model: 'claude-haiku-4-5', from: '2026-09-04', input: 1, cacheRead: 0.1 },
  { model: 'claude-3-5-haiku', from: '2026-09-04', input: 0.8, cacheRead: 0.08 },
].map((p) => Object.freeze(p)));

/** @param {string} id @param {string} model */
const matches = (id, model) => id === model || (id.startsWith(`${model}-`) && /^\d{8}$/.test(id.slice(model.length + 1)));

/**
 * The price in force for `model` when a run was recorded at `at`: of the entries matching the
 * model whose `from` is on or before that day, the latest. Null when none is.
 * @param {string | undefined} model @param {string} at an ISO time
 * @param {readonly Price[]} [table]
 * @returns {Price | null}
 */
export function priceOf(model, at, table = PRICES) {
  if (typeof model !== 'string') return null;
  const day = at.slice(0, 10);
  /** @type {Price | null} */
  let best = null;
  for (const p of table) {
    if (!matches(model, p.model) || p.from > day) continue;
    if (!best || p.from > best.from) best = p;
  }
  return best;
}

/**
 * One run's cache savings in US dollars at list price, or null when the run can't be priced.
 * @param {{ model?: unknown, recorded_at: string, cache_read_tokens?: unknown }} run
 * @param {readonly Price[]} [table]
 * @returns {number | null}
 */
export function cacheSavings(run, table = PRICES) {
  const tokens = run.cache_read_tokens;
  if (!Number.isInteger(tokens) || /** @type {number} */ (tokens) < 0) return null;
  const price = priceOf(typeof run.model === 'string' ? run.model : undefined, run.recorded_at, table);
  if (!price) return null;
  return (/** @type {number} */ (tokens) * (price.input - price.cacheRead)) / 1e6;
}
