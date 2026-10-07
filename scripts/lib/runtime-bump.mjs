// The Overseer's runtime-version trigger (plan 0004 decision 12, amended 2026-10-06; kanon#423):
// is a capability review due on a merged pull request that moved the caller's Kanon pin?
//
// WHY. The capability watch (`K-SELF-16`, `K-SELF-17`) reviews the agent runtime's releases for
// features the pipeline could adopt. A caller may run the Overseer when a merged pull request
// changes the caller file, which is how an adopter's runtime moves: Kanon pins the runtime per
// release (`actions/agent-run`'s exact `anthropics/claude-code-action` pin), so it changes only
// when Dependabot moves the caller's Kanon pin. Most Kanon releases don't move it. So, by the
// Owner's decisions on kanon#423, the lane audits on that trigger only when the runtime moved
// FORWARD: when the runtime of the release the lane now runs is newer than the capability ledger's
// watermark, the last runtime version the review went through. The same version, or an older one
// (a rollback, or a watermark the review already carried past it), skips, and says so. Versions
// compare numerically, part by part: 2.1.300 is newer than 2.1.29. Kanon's own caller works the same way: it runs Kanon's previous release, so its runtime
// moves when its pin does, and it compares that release's runtime with its own watermark.
//
// THE RUNTIME VERSION is the Claude Code CLI the release's `claude-code-action` pin installs, the
// version the capability review slices the CLI's changelog from (`scripts/cc-sweep.mjs`), as
// `.github/scripts/reviewer-grant-record.json` records it. That record is taken against the CLI
// the pin installs and is held to the pin by `tests/unit/reviewer-grant-probe.test.ts`, so a
// release ships with the two in step; a record that names another action version is refused here.
//
// THE WATERMARK is the ledger's bare `Watermark: <version>` line, alone in a fenced block
// (`K-LAYOUT-7`), read by exact match: a decorated line is no watermark.
//
// FAILING OPEN. Anything that can't be read, or compared, makes the review due, with a note
// naming why: the trigger exists so that a runtime change is never left unreviewed, and a spare
// audit costs less than a missed one. Only a runtime read and compared as not newer skips.
//
// Node built-ins only (`K-SELF-8`): the lane runs it from the action cache, with no install.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The capability ledger (`K-LAYOUT-7`, `K-SELF-16`). */
export const LEDGER = 'docs/qa/capability-ledger.md';

/** Where a Kanon release pins the agent runtime, and where it records the CLI that pin installs. */
export const AGENT_RUN = 'actions/agent-run/action.yml';
export const GRANT_RECORD = '.github/scripts/reviewer-grant-record.json';

/** A runtime version, as the CLI's changelog heads its releases: `2.1.289`. */
const VERSION = /^\d+\.\d+\.\d+$/;

/** The watermark line, exactly (`K-LAYOUT-7`). */
const WATERMARK = /^Watermark: (\S+)$/;

/** The one event that is the runtime-version trigger. */
export const TRIGGER_EVENT = 'pull_request_target';

/**
 * Compares two `VERSION`s numerically, part by part: negative when `a` is older, zero when equal,
 * positive when newer.
 * @param {string} a @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) {
    const d = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The ledger's watermark: the version on the one `Watermark: <version>` line that stands alone in
 * a fenced block, or the reason there is none to compare with.
 * @param {string} text the ledger's markdown
 * @returns {{ watermark: string } | { none: string }}
 */
export function parseWatermark(text) {
  const lines = text.split(/\r?\n/);
  /** @type {string[][]} */
  const blocks = [];
  /** @type {string | null} */
  let fence = null;
  /** @type {string[]} */
  let body = [];
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (m && !(m[1]?.[0] === '`' && m[2]?.includes('`'))) { fence = /** @type {string} */ (m[1]); body = []; }
      continue;
    }
    if (m && m[1]?.[0] === fence[0] && /** @type {string} */ (m[1]).length >= fence.length && m[2]?.trim() === '') {
      blocks.push(body);
      fence = null;
      continue;
    }
    body.push(line);
  }
  const found = blocks
    .map((b) => b.filter((l) => l.trim() !== ''))
    .filter((b) => b.length === 1 && WATERMARK.test(/** @type {string} */ (b[0])))
    .map((b) => /** @type {string} */ (WATERMARK.exec(/** @type {string} */ (b[0]))?.[1]));
  if (found.length === 0) return { none: `${LEDGER} carries no bare \`Watermark: <version>\` line alone in a fenced block (K-LAYOUT-7)` };
  if (found.length > 1) return { none: `${LEDGER} carries ${found.length} watermarks (${found.join(', ')}), so none of them is the one (K-LAYOUT-7)` };
  const watermark = /** @type {string} */ (found[0]);
  if (!VERSION.test(watermark)) return { none: `${LEDGER}'s watermark \`${watermark}\` isn't a runtime version like \`2.1.289\` (K-LAYOUT-7)` };
  return { watermark };
}

/**
 * The agent runtime a Kanon tree runs: its `claude-code-action` pin, and the CLI version that pin
 * installs, from the grant record. Throws, naming the file, when either can't be read or the
 * record was taken on another pin.
 * @param {string} root the Kanon tree
 * @returns {{ action: string, cli: string }}
 */
export function runtimeOf(root) {
  const pins = [...readFileSync(join(root, AGENT_RUN), 'utf8').matchAll(/^\s*(?:-\s*)?uses:\s*anthropics\/claude-code-action@(\S+)\s*$/gm)]
    .map((m) => /** @type {string} */ (m[1]));
  if (pins.length !== 1) throw new Error(`${AGENT_RUN} pins anthropics/claude-code-action ${pins.length} times, not once`);
  const action = /** @type {string} */ (pins[0]);
  const record = /** @type {{ action?: unknown, cli?: unknown }} */ (JSON.parse(readFileSync(join(root, GRANT_RECORD), 'utf8')));
  if (record.action !== action) throw new Error(`${GRANT_RECORD} was taken on claude-code-action ${String(record.action)}, but ${AGENT_RUN} pins ${action}`);
  if (typeof record.cli !== 'string' || !VERSION.test(record.cli)) throw new Error(`${GRANT_RECORD} names no CLI version like 2.1.289`);
  return { action, cli: record.cli };
}

/**
 * Whether the Overseer audits on this event. Any trigger but the runtime-version one is due as
 * before. On that one, it is due unless the runtime and the watermark are both read and equal.
 * @param {{
 *   event: string,
 *   runtime: () => { action: string, cli: string },
 *   ledger: () => string | null,
 * }} io the event's name, the runtime of the release the lane runs, and the ledger's text on the
 *   default branch (`null` when it doesn't exist there); each throws on a failed read
 * @returns {{ due: boolean, note: string }}
 */
export function reviewDue({ event, runtime, ledger }) {
  if (event !== TRIGGER_EVENT) return { due: true, note: '' };
  /** @param {string} why */
  const anyway = (why) => ({ due: true, note: `${why}, so the audit runs: a runtime change is never left unreviewed on a guess` });
  let rt;
  try {
    rt = runtime();
  } catch (e) {
    return anyway(`the agent runtime of this Kanon release couldn't be read (${/** @type {Error} */ (e).message})`);
  }
  let text;
  try {
    text = ledger();
  } catch (e) {
    return anyway(`${LEDGER} couldn't be read from the default branch (${/** @type {Error} */ (e).message})`);
  }
  if (text === null) return anyway(`${LEDGER} doesn't exist on the default branch, so there is no watermark to compare the runtime, Claude Code ${rt.cli}, with`);
  const mark = parseWatermark(text);
  if ('none' in mark) return anyway(`${mark.none}, so there is nothing to compare the runtime, Claude Code ${rt.cli}, with`);
  const order = compareVersions(rt.cli, mark.watermark);
  if (order === 0) {
    return { due: false, note: `the agent runtime is still Claude Code ${rt.cli} (claude-code-action ${rt.action}), the capability ledger's watermark: no runtime change to review, so this run skips the audit. The weekly run still audits.` };
  }
  if (order < 0) {
    return { due: false, note: `the agent runtime is Claude Code ${rt.cli} (claude-code-action ${rt.action}), older than the capability ledger's watermark, ${mark.watermark}, which the review has already gone through: nothing new to review, so this run skips the audit. The weekly run still audits.` };
  }
  return { due: true, note: `the agent runtime is now Claude Code ${rt.cli} (claude-code-action ${rt.action}), newer than the capability ledger's watermark, ${mark.watermark}: the capability review is due` };
}
