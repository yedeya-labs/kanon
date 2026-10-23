// A GitHub search answer Kanon can act on (kanon#1322).
//
// WHY. GitHub's search API can answer 0 for a query that has matches. While fixing #1318, one
// repository-scoped query, `repo:… is:pr is:merged merged:<window>`, sent nine times with one
// person's token, answered 2 six times and 0 three times, and only one of those zeros said
// `incomplete_results: true`. GitHub's docs say a search that times out returns the matches it
// had found so far. Nothing in the answer tells a spurious zero from a true one, so a count or
// an action that rests on a search's zero rests on a coin toss.
//
// WHAT TO USE INSTEAD, IN ORDER:
//   1. A REST or GraphQL LISTING, when one answers the same question: the pulls list for merged
//      pull requests (`countMergedPrs` in `scripts/weekly-digest.mjs`), an issue listing by label
//      for a marker the body carries. A listing reads the repository's own records, and a token
//      that can't read them gets a 403 or a 404, not an empty answer.
//   2. This module, when search is the only way (a `closed:` window, an `in:body` phrase,
//      `-linked:pr`): `trustedSearch` (async) or `trustedSearchSync` read the search again when an
//      answer is doubtful, and refuse by name when the answers don't settle.
//
// HOW AN ANSWER IS SETTLED (`settle`, the one rule both readers apply):
//   - a first answer that found something and is complete is trusted at once, so a search with
//     matches costs one request, as before;
//   - a doubtful answer, one that found nothing or says `incomplete_results`, is read again, up
//     to `SEARCH_READS` reads in all, with a wait that doubles between them;
//   - after a doubtful answer, a count that found something is trusted once two complete reads
//     agree on it, and two complete reads that found different counts fail by name;
//   - a zero is trusted only when every read found nothing and at least one was complete;
//   - anything else when the reads are spent (one read that found something against the rest
//     that found nothing, or no complete read at all) fails by name: the count can't be known.
// So a true zero costs `SEARCH_READS` requests and a few seconds of waiting, against the search
// API's 30 requests a minute; a caller that sends many searches keeps that in mind.
//
// WAITS. `KANON_SEARCH_WAIT_MS` sets the first wait (500 ms by default), which a test sets to 0.
//
// `tests/unit/search-zero.test.ts` holds every search Kanon's scripts send to this module, or to
// a comment that says why its zero is safe. `node:` built-ins only (`K-SELF-8`).

import { setTimeout as delay } from 'node:timers/promises';

/** How many times a doubtful search is read, the first read included. */
export const SEARCH_READS = 4;
/** The wait before the first re-read, in ms, doubled before each later one. */
export const SEARCH_WAIT_MS = 500;

/** A search whose answers didn't settle on one count. Its message names the search and every answer. */
export class SearchUnsettled extends Error {}

/** @typedef {{ size: number, partial: boolean }} Reading what one answer found, and whether it said it was incomplete */

/**
 * @template T
 * @typedef {{ what: string, size?: (answer: T) => unknown, partial?: (answer: T) => unknown,
 *   reads?: number, sleep?: (ms: number) => void | Promise<void> }} Options
 *   `what` names the search in a refusal; `size` reads how much an answer found (default: REST's
 *   `total_count`); `partial` whether it said it was incomplete (default: REST's `incomplete_results`)
 */

/** REST search's total. @param {any} answer */
export const totalCount = (answer) => answer?.total_count;
/** REST search's own doubt. @param {any} answer */
export const incompleteResults = (answer) => answer?.incomplete_results === true;

/** The first wait: `KANON_SEARCH_WAIT_MS`, else `SEARCH_WAIT_MS`. */
const firstWait = () => {
  const v = Number(process.env.KANON_SEARCH_WAIT_MS);
  return process.env.KANON_SEARCH_WAIT_MS !== undefined && Number.isFinite(v) && v >= 0 ? v : SEARCH_WAIT_MS;
};

/** Block for `ms`, for the synchronous reader. @param {number} ms */
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Which reading to trust, `null` to read again; THROWS when the readings can't settle.
 * @param {Reading[]} readings every answer so far, first to last
 * @param {{ what: string, reads?: number }} opts
 * @returns {number | null} the index of the reading to trust
 */
export function settle(readings, { what, reads = SEARCH_READS }) {
  const said = () => readings.map((r) => `${r.size}${r.partial ? ' (incomplete)' : ''}`).join(', ');
  const found = readings.flatMap((r, i) => (r.size > 0 && !r.partial ? [{ size: r.size, i }] : []));
  if (readings.length === 1 && found.length === 1) return 0;
  if (new Set(found.map((f) => f.size)).size > 1) {
    throw new SearchUnsettled(`the search for ${what} answered ${said()} on ${readings.length} reads: the counts disagree, so none is trusted (kanon#1322)`);
  }
  if (found.length >= 2) return /** @type {{ i: number }} */ (found[found.length - 1]).i;
  if (readings.length < reads) return null;
  if (readings.every((r) => r.size === 0)) {
    const complete = readings.map((r, i) => (r.partial ? -1 : i)).filter((i) => i >= 0);
    if (complete.length) return /** @type {number} */ (complete[complete.length - 1]);
  }
  throw new SearchUnsettled(
    `the search for ${what} answered ${said()} on ${readings.length} reads, which don't settle on one count: ` +
    'GitHub search can answer 0 or a partial count for a query that has matches, so none is trusted (kanon#1322)',
  );
}

/**
 * One answer's reading. @template T @param {T} answer @param {Options<T>} opts @returns {Reading}
 */
const reading = (answer, { what, size = totalCount, partial = incompleteResults }) => {
  const n = size(answer);
  if (!Number.isInteger(n) || /** @type {number} */ (n) < 0) throw new SearchUnsettled(`the search for ${what} returned no count: ${JSON.stringify(answer)?.slice(0, 200)}`);
  return { size: /** @type {number} */ (n), partial: !!partial(answer) };
};

/**
 * A search answer to act on, read through `read` as often as `settle` asks.
 * @template T
 * @param {() => Promise<T>} read sends the search once
 * @param {Options<T>} opts
 * @returns {Promise<T>} the answer `settle` trusts
 */
export async function trustedSearch(read, opts) {
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => delay(ms));
  const wait = firstWait();
  /** @type {T[]} */
  const answers = [];
  /** @type {Reading[]} */
  const readings = [];
  for (;;) {
    if (answers.length) await sleep(wait * 2 ** (answers.length - 1));
    const answer = await read();
    answers.push(answer);
    readings.push(reading(answer, opts));
    const i = settle(readings, opts);
    if (i !== null) return /** @type {T} */ (answers[i]);
  }
}

/**
 * `trustedSearch` for a caller that reads synchronously (`execFileSync('gh', …)`).
 * @template T
 * @param {() => T} read sends the search once
 * @param {Options<T>} opts
 * @returns {T} the answer `settle` trusts
 */
export function trustedSearchSync(read, opts) {
  const sleep = opts.sleep ?? sleepSync;
  const wait = firstWait();
  /** @type {T[]} */
  const answers = [];
  /** @type {Reading[]} */
  const readings = [];
  for (;;) {
    if (answers.length) sleep(wait * 2 ** (answers.length - 1));
    const answer = read();
    answers.push(answer);
    readings.push(reading(answer, opts));
    const i = settle(readings, opts);
    if (i !== null) return /** @type {T} */ (answers[i]);
  }
}
