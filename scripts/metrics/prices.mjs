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
// long-context (`[1m]`) variant, which no entry matches: before Claude 4.6 its price depended on
// the request's size, which the row doesn't carry. A run is priced at its `model`, the one that
// billed most (`agent-telemetry`), so the reads of a second, cheaper model in the same run are
// priced at the first's rates.
//
// Pure, and imports nothing (`K-SELF-8`).

/**
 * @typedef {{ model: string, from: string, input: number, cacheRead: number }} Price US dollars per
 *   million tokens: `input` the base input price, `cacheRead` a cache hit's
 */

/**
 * The table. A model id matches an entry's `model` exactly, or with the API's `-YYYYMMDD` snapshot
 * date after it. An entry's `from` is 2026-09-04, the first day of Kanon's cost rows (plan 0002
 * §1.3), unless the price changed after it: then the later price is a second entry, from the day
 * it changed. A model not here is unpriced until a release adds it.
 *
 * SOURCE. Every price is the "Base input tokens" and "Cache hits and refreshes" column of the
 * "Model pricing" table at https://platform.claude.com/docs/en/about-claude/pricing, read on
 * 2026-10-12; the price changes since 2026-09-04 are from the API release notes,
 * https://platform.claude.com/docs/en/release-notes/overview, read the same day. Never enter a
 * price from memory: a price that can't be read there stays out, and its model's runs unpriced.
 *
 * LEFT OUT, SO UNPRICED: Claude Haiku 5.5 (`claude-haiku-5-5`), whose prices depend on the
 * request's prompt length (above 100,000 tokens a request pays more), which the run row doesn't
 * carry; and Claude Sonnet 3.7 (`claude-3-7-sonnet`), retired on 2026-02-19, before Kanon's first
 * cost row, and no longer on the page.
 * @type {readonly Readonly<Price>[]}
 */
export const PRICES = Object.freeze([
  { model: 'claude-fable-5-1', from: '2026-09-04', input: 10, cacheRead: 0.25 },
  { model: 'claude-fable-5', from: '2026-09-04', input: 10, cacheRead: 1 },
  { model: 'claude-opus-5-5', from: '2026-09-04', input: 4, cacheRead: 0.2 },
  { model: 'claude-opus-5', from: '2026-09-04', input: 5, cacheRead: 0.5 },
  { model: 'claude-opus-4-8', from: '2026-09-04', input: 5, cacheRead: 0.5 },
  { model: 'claude-opus-4-7', from: '2026-09-04', input: 5, cacheRead: 0.5 },
  { model: 'claude-opus-4-6', from: '2026-09-04', input: 5, cacheRead: 0.5 },
  { model: 'claude-opus-4-5', from: '2026-09-04', input: 5, cacheRead: 0.5 },
  { model: 'claude-opus-4-1', from: '2026-09-04', input: 15, cacheRead: 1.5 },
  { model: 'claude-opus-4', from: '2026-09-04', input: 15, cacheRead: 1.5 },
  // Sonnet 5.5's cache reads fell from $0.20 to $0.10 on 2026-10-07 (the release notes, that day).
  { model: 'claude-sonnet-5-5', from: '2026-09-04', input: 2, cacheRead: 0.2 },
  { model: 'claude-sonnet-5-5', from: '2026-10-07', input: 2, cacheRead: 0.1 },
  // $2 was Sonnet 5's introductory price, made its standard price on 2026-08-10.
  { model: 'claude-sonnet-5', from: '2026-09-04', input: 2, cacheRead: 0.2 },
  { model: 'claude-sonnet-4-6', from: '2026-09-04', input: 3, cacheRead: 0.3 },
  { model: 'claude-sonnet-4-5', from: '2026-09-04', input: 3, cacheRead: 0.3 },
  { model: 'claude-sonnet-4', from: '2026-09-04', input: 3, cacheRead: 0.3 },
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
