// The turn budget a caller asked for, checked against Kanon's ceiling before the agent starts
// (kanon#891).
//
// Every agent lane sets its own turn cap, `--max-turns`, in its flags, and that number is the
// lane's default. How many turns a job needs depends on the adopter's repository: the size of
// its briefs, specs and rulebook, and how much the agent reads first. So a caller may set the
// lane's `max_turns` input in its job's `with:`, and the lane hands it here as `max-turns`, with
// the lane's ceiling as `max-turns-ceiling`. The ceiling is Kanon's, fixed per lane in the lane's
// own file, so the input can move the cost bound but never remove it.
//
//   - Empty: the caller set nothing, and the lane's flags run as they are.
//   - A positive integer at or under the ceiling: this run's `--max-turns` becomes that number,
//     and its `--max-budget-usd` is derived from it at Kanon's fixed per-turn rate, $0.40 a turn
//     rounded up to the next $5 (`K-OBS-12`), so the dollar cap follows the turn cap as it does
//     in every lane's own flags.
//   - Anything else (above the ceiling, zero, negative, not a whole number, or a value on a lane
//     that gives no ceiling) fails the step, by name, before any model call. Never clamped: a
//     silently lowered budget is the failure the input exists to end.
//
// The value reaches this script through `env:` only, never a `run:` line (`K-AGENT-45`), and the
// refusal prints it encoded, so a value can't write a workflow command of its own.
//
// Writes `claude-args` (the flags the agent runs with) and `max-turns` to `$GITHUB_OUTPUT`.
//
// Inputs, by environment only: CLAUDE_ARGS, MAX_TURNS, MAX_TURNS_CEILING, GITHUB_OUTPUT.

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** Kanon's per-turn rate for the dollar cap (`K-OBS-12`), and the step it rounds up to. */
export const PER_TURN_USD = 0.4;
export const BUDGET_STEP_USD = 5;

/** Where the default, the ceiling and the "split or raise" rule are written down. */
export const DOC = 'docs/lanes.md, "The turn budget"';

const TITLE = 'title=max_turns';
const POSITIVE = /^[1-9][0-9]*$/;
const TURNS_FLAG = /(^|\s)--max-turns(?:[ \t]+|=)(\d+)(?=\s|$)/g;
const BUDGET_FLAG = /(^|\s)--max-budget-usd(?:[ \t]+|=)(\d+(?:\.\d+)?)(?=\s|$)/g;

/** The dollar cap for `turns` turns: $0.40 a turn, rounded up to the next $5 (`K-OBS-12`). @param {number} turns */
export const budgetFor = (turns) =>
  // In cents, so the rounding is whole numbers: 0.4 × 300 is not exactly 120 in floating point.
  Math.ceil((turns * Math.round(PER_TURN_USD * 100)) / (BUDGET_STEP_USD * 100)) * BUDGET_STEP_USD;

/** A value as a workflow command may print it: quoted, with `%`, CR and LF encoded. @param {string} v */
const shown = (v) => JSON.stringify(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * Check a caller's `max_turns` against a lane's ceiling. Also what `lane-check` asks of a caller
 * that writes a number in its `with:`.
 * @param {string} value the caller's value, as the lane received it
 * @param {string} ceiling the lane's ceiling
 * @returns {{ ok: true, turns: number | null } | { ok: false, message: string }}
 */
export function checkMaxTurns(value, ceiling) {
  const v = String(value ?? '').trim();
  if (v === '') return { ok: true, turns: null };
  const c = String(ceiling ?? '').trim();
  if (!POSITIVE.test(c)) {
    return { ok: false, message: `max_turns is set to ${shown(v)}, but this lane gives no ceiling for it, so it takes no turn budget from its caller. Remove max_turns from the caller's with: (${DOC}).` };
  }
  if (!POSITIVE.test(v)) {
    return { ok: false, message: `max_turns must be a whole number of turns from 1 to ${c}, not ${shown(v)}. Leave it out to take the lane's default (${DOC}).` };
  }
  if (Number(v) > Number(c)) {
    return { ok: false, message: `max_turns is ${v}, above Kanon's ceiling of ${c} turns for this lane. The ceiling bounds what one run can spend; set max_turns to ${c} or less, or split the work into parts each finishable in one run (${DOC}).` };
  }
  return { ok: true, turns: Number(v) };
}

/**
 * The flags the agent runs with: the lane's own, or with the caller's turn budget and the dollar
 * cap derived from it in place of the lane's.
 * @param {{ claudeArgs: string, maxTurns?: string, ceiling?: string }} args
 * @returns {{ ok: true, claudeArgs: string, turns: number | null, message: string } | { ok: false, message: string }}
 */
export function turnBudget({ claudeArgs, maxTurns = '', ceiling = '' }) {
  const checked = checkMaxTurns(maxTurns, ceiling);
  if (!checked.ok) return { ok: false, message: `::error ${TITLE}::${checked.message}` };
  const own = [...claudeArgs.matchAll(TURNS_FLAG)];
  const ownTurns = own.length === 1 ? Number(own[0]?.[2]) : null;
  if (checked.turns === null) {
    return { ok: true, claudeArgs, turns: ownTurns, message: ownTurns === null ? 'The lane\'s flags run as they are.' : `The agent runs with the lane's default turn budget, ${ownTurns} turns.` };
  }
  const budgets = [...claudeArgs.matchAll(BUDGET_FLAG)];
  if (own.length !== 1 || budgets.length !== 1) {
    return { ok: false, message: `::error ${TITLE}::This lane's flags hold ${own.length} --max-turns and ${budgets.length} --max-budget-usd, not one of each, so the caller's max_turns has nothing to replace. This is a fault in the Kanon lane: report it (${DOC}).` };
  }
  const turns = checked.turns;
  const usd = budgetFor(turns);
  const out = claudeArgs
    .replace(TURNS_FLAG, (_, pre) => `${pre}--max-turns ${turns}`)
    .replace(BUDGET_FLAG, (_, pre) => `${pre}--max-budget-usd ${usd}`);
  return { ok: true, claudeArgs: out, turns, message: `The agent runs with the caller's turn budget, ${turns} turns (the lane's default is ${ownTurns}), and a dollar cap of $${usd}.` };
}

if (isCliEntry(import.meta.url)) {
  const r = turnBudget({
    claudeArgs: process.env.CLAUDE_ARGS ?? '',
    maxTurns: process.env.MAX_TURNS ?? '',
    ceiling: process.env.MAX_TURNS_CEILING ?? '',
  });
  console.log(r.message);
  if (!r.ok) process.exit(1);
  const delim = `EOF_${randomBytes(12).toString('hex')}`;
  appendFileSync(String(process.env.GITHUB_OUTPUT), `max-turns=${r.turns ?? ''}\nclaude-args<<${delim}\n${r.claudeArgs}\n${delim}\n`);
}
