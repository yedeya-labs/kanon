// Did any agent run write its prompt cache at the FIVE-MINUTE TTL when its lane doesn't pin it?
// The Overseer's cache-TTL facts (`cache-ttl.md`), moved from the reference adopter's
// `cache-ttl-check.mjs` (RA-1899) with plan 0002 §6's changes for the hosted store (kanon#470):
//
//   - the partition is `<key>#<lane>`, read with the adopter's reader role; an arm is a lane;
//   - the lane list is Kanon's lane enum, not a scan of the workflows for `agent:`;
//   - the lanes that pin the five-minute TTL are read from Kanon's own lane definitions, the
//     release the Overseer runs (`pinnedLanes`), since the pin is Kanon's (`prompt-cache-ttl: 5m`);
//   - only `tag: run` rows count, and only the query's window, not the whole partition.
//
// AND ONE THING LEFT BEHIND, said in the output: the pinned arms' health check (whether each pin
// took effect, and whether its arm idles past 300s), which dated each pin from the reference
// adopter's cutover ledger, a file of its own that Kanon has no counterpart for. A 5m write on a
// pinned arm is still counted as expected, and said so.
//
// WHY A DETECTOR AND NOT A SETTING. Claude Code requests the one-hour TTL for the main
// conversation only on a Claude subscription WITHIN the plan's included usage. Once it draws on
// usage credits it drops to the cheaper five-minute TTL. Every lane authenticates with
// `CLAUDE_CODE_OAUTH_TOKEN`, so the fleet is exactly the population that transition applies to. A
// drop to 5m shows up as a gradual rise in cost per run with no proximate cause; this makes it
// nameable.
//
// A LOOKUP WHERE THE FIELD EXISTS, A SUBTRACTION WHERE IT DOES NOT. A row carrying
// `cache_write_5m_tokens` is judged by it; an older row falls back to `cache_write_tokens -
// cache_write_1h_tokens`, since a lookup alone would call every older row clean.
//
// IT REPORTS WHAT IT EXAMINED, NOT ONLY WHAT IT FOUND: a detector that finds nothing is
// indistinguishable from one that did not look, so a clean result prints "0 of N rows", never
// silence. `node:` built-ins only (`K-SELF-8`).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { N, isRun } from './token-trend.mjs';

/** @typedef {import('./token-trend.mjs').Item} Item */

/** The store attributes this check reads, plus the tag: the query projects only these. */
export const TTL_ATTRIBUTES = /** @type {const} */ (['sk', 'tag', 'outcome', 'cache_write_tokens', 'cache_write_1h_tokens', 'cache_write_5m_tokens']);

/**
 * Does this workflow's text pin the five-minute TTL? Line-anchored and comment-excluding: the
 * string also appears inside explanatory comments, and counting one of those as a pin would
 * silence a real finding on an arm that never set it.
 * @param {string} text
 */
export const declaresPin = (text) => text.split('\n').some((line) => /^\s*(?:prompt-cache-ttl|CLAUDE_CODE_PROMPT_CACHE_TTL):\s*["']?5m["']?\s*$/.test(line));

/**
 * The lanes whose Kanon definition pins the five-minute TTL: each workflow under `dir` that
 * declares the pin, and the `lane:` its telemetry step names, of Kanon's lanes. DERIVED, not
 * hardcoded, so a lane that gains or drops the pin is followed; a unit test holds the answer.
 * @param {string} dir Kanon's `.github/workflows`
 * @param {readonly string[]} lanes Kanon's lane enum
 * @returns {Set<string>}
 */
export const pinnedLanes = (dir, lanes) => {
  /** @type {Set<string>} */
  const pinned = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    if (!declaresPin(text)) continue;
    for (const [, lane] of text.matchAll(/^\s+lane:\s*([a-z][a-z0-9-]*)\s*$/gm)) {
      if (lane && lanes.includes(lane)) pinned.add(lane);
    }
  }
  return pinned;
};

/**
 * How a row's cache write splits by TTL.
 *
 *   `none`      no cache write at all: not evidence either way.
 *   `unbroken`  a write, but NO TTL breakdown: 1h and 5m both 0. The normaliser zero-fills both
 *               halves of a missing `usage.cache_creation`, so this is "not reported", never "all
 *               at 5m". Only rows carrying the 5m field can be told apart.
 *   `judged`    `share` is the fraction written at 5m: the 5m field itself where the row carries
 *               it, else `total - 1h`.
 * @param {Item} item
 * @returns {{ kind: 'none' } | { kind: 'unbroken' } | { kind: 'judged', share: number }}
 */
export const ttlSplit = (item) => {
  const total = N(item, 'cache_write_tokens');
  if (!total) return { kind: 'none' };
  const oneHour = N(item, 'cache_write_1h_tokens');
  const fiveMin = N(item, 'cache_write_5m_tokens');
  if (fiveMin !== null) {
    if (!fiveMin && !oneHour) return { kind: 'unbroken' };
    return { kind: 'judged', share: fiveMin / total };
  }
  return { kind: 'judged', share: (total - (oneHour ?? 0)) / total };
};

/**
 * @param {Array<{ lane: string, items: Item[] }>} partitions the partitions that were read
 * @param {Set<string>} pinned the lanes that pin 5m deliberately
 * @param {string[]} [unreadable] the lanes whose partition could not be read
 */
export const summarize = (partitions, pinned, unreadable = []) => {
  /** @type {Array<{ lane: string, share: number }>} */
  const offenders = [];
  // A 5m WRITE ON A PINNED ARM IS THE SETTING WORKING, NOT A FINDING. Counted and reported so the
  // line still says what it saw, but never fired on: an alert always on for the pinned arms is an
  // alert nobody reads.
  /** @type {Array<{ lane: string, share: number }>} */
  const expected = [];
  let examined = 0;
  let skipped = 0;
  let unbroken = 0;
  for (const { lane, items } of partitions) {
    for (const item of items.filter(isRun)) {
      const split = ttlSplit(item);
      // A row with NO cache write at all can't answer the question either way; counting it as
      // clean would inflate the denominator with rows that were never evidence.
      if (split.kind === 'none') { skipped += 1; continue; }
      // A WRITE WITH NO TTL BREAKDOWN IS NOT A 5-MINUTE WRITE: read by subtraction it would be a
      // 100% offender, and if the model ever stops reporting the breakdown, EVERY row would fire.
      if (split.kind === 'unbroken') { unbroken += 1; continue; }
      examined += 1;
      if (split.share > 0) (pinned.has(lane) ? expected : offenders).push({ lane, share: split.share });
    }
  }
  return { examined, lanes: partitions.length, offenders, expected, skipped, unbroken, unreadable: [...unreadable].sort(), pinned: [...pinned].sort() };
};

/**
 * The lines the Overseer pastes into its audit verbatim, each finding prefixed `cache-ttl:`.
 * @param {ReturnType<typeof summarize>} summary
 * @param {number} days the window the rows were read over
 */
export const render = ({ examined, lanes, offenders, expected, skipped, unbroken, unreadable, pinned }, days) => {
  // AN UNREAD PARTITION IS NAMED ON THE LINE, NOT ONLY IN THE LOG: one throttled query must not
  // read as a healthy, smaller fleet.
  const missing = unreadable.length
    ? ` ${unreadable.length} partition(s) were UNREADABLE (${unreadable.join(', ')}), so this is PARTIAL, not clean.`
    : '';
  const scope = `${examined} row(s) across ${lanes} lane partition(s) over the last ${days} days`;
  const notes = [
    skipped ? `${skipped} row(s) carried no cache write and were skipped` : '',
    unbroken ? `${unbroken} row(s) wrote cache but reported NO TTL breakdown (1h and 5m both 0), so they were not judged; if that is most rows, the model stopped reporting \`usage.cache_creation\`, which is not a fallback` : '',
  ].filter(Boolean);
  const note = notes.length ? ` (${notes.join('; ')})` : '';
  // "OF THOSE N": the by-design rows are a SUBSET of the denominator, said so in both branches.
  const byDesign = expected.length
    ? ` Of those ${examined} row(s), ${expected.length} were written at 5m BY DESIGN on the lane(s) Kanon pins to it, ${pinned.join(', ')}, and are not a finding.`
    : '';
  const pins = 'cache-ttl: the pinned lanes\' own health (whether each pin took effect, and whether its runs idle past 300s) is NOT checked here: it needs each pin\'s date, which nothing records.';
  if (!examined) {
    return [`cache-ttl: NO ROWS CARRIED A JUDGEABLE CACHE WRITE across ${lanes} lane partition(s) over the last ${days} days${note}: this check looked and learned nothing; treat it as UNAVAILABLE, not as clean.${missing}`, pins].join('\n');
  }
  if (!offenders.length) {
    const verdict = unreadable.length
      ? 'No lane that was READ has fallen back; the unreadable ones were not examined.'
      : 'No unpinned lane has fallen back; no pin needed.';
    return [`cache-ttl: 0 of ${scope} were written at the 5-minute TTL UNEXPECTEDLY${note}.${missing}${byDesign} ${verdict}`, pins].join('\n');
  }
  // THE AFFECTED ARMS, NOT THE FIRST FIVE ROWS: the remedy below says "the lanes named".
  /** @type {Map<string, { rows: number, max: number }>} */
  const byLane = new Map();
  for (const o of offenders) {
    const a = byLane.get(o.lane) ?? { rows: 0, max: 0 };
    byLane.set(o.lane, { rows: a.rows + 1, max: Math.max(a.max, o.share) });
  }
  const arms = [...byLane]
    .sort((x, y) => y[1].rows - x[1].rows || x[0].localeCompare(y[0]))
    .map(([lane, a]) => `${lane} ${a.rows} row(s), up to ${Math.round(a.max * 100)}% at 5m`)
    .join('; ');
  return [
    `cache-ttl: ${offenders.length} of ${scope} were written at the 5-minute TTL UNEXPECTEDLY${note}, on ${byLane.size} lane(s): ${arms}.${missing}${byDesign}`,
    'REMEDY: the lanes named above do NOT pin the TTL, so this is the unintended fallback: the plan\'s included usage ran out and Claude Code dropped to the cheaper TTL, leaving them re-processing prefixes they could have read.',
    'Pin `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` on the affected lanes: in Kanon\'s lanes that is the `prompt-cache-ttl` input of `actions/agent-run`, so the pin is Kanon\'s to set (a finding with subject `lane`); on your side, check the subscription\'s included usage.',
    'IT NEEDS CLAUDE CODE >= v2.1.242: below it the variable is IGNORED RATHER THAN REJECTED, which looks exactly like the pin working. Check the version first.',
    pins,
  ].join('\n');
};

