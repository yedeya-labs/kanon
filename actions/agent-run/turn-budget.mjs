// A raised turn limit for one dispatched run, checked against Kanon's ceiling before the agent
// starts (kanon#891; ADR 0005 §2, amended 2026-10-15).
//
// Every agent lane sets its own turn cap, `--max-turns`, in its flags, and that number is the
// lane's limit. It is never a standing setting: adopters don't edit it. A person may raise it for
// ONE run, by dispatching the lane's caller with `max_turns` and a `reason`, which the caller
// passes through and the lane hands here as `max-turns` and `max-turns-reason`, with the lane's
// ceiling as `max-turns-ceiling`. The ceiling is Kanon's, fixed per lane in the lane's own file
// at twice its limit, so a raise moves the cost bound but never removes it.
//
//   - Empty: nothing was raised, and the lane's flags run as they are.
//   - A whole number from 1 to the ceiling, on a dispatched run, with a reason: this run's
//     `--max-turns` becomes that number, and its `--max-budget-usd` is derived from it at Kanon's
//     fixed per-turn rate, $0.40 a turn rounded up to the next $5 (`K-OBS-12`), so the dollar cap
//     follows the turn cap as it does in every lane's own flags. The raise and its reason go into
//     the run's step summary; the telemetry row records the cap through the flags.
//   - Anything else fails the step, by name, before any model call: above the ceiling, zero,
//     negative, not a whole number, no reason, a run that wasn't dispatched, or a lane that gives
//     no ceiling. Never clamped: a silently lowered budget is the failure a raise exists to end.
//
// The values reach this script through `env:` only, never a `run:` line (`K-AGENT-45`), and a
// refusal prints a value encoded, so it can't write a workflow command of its own.
//
// Writes `claude-args` (the flags the agent runs with) and `max-turns` to `$GITHUB_OUTPUT`.
//
// Inputs, by environment only: CLAUDE_ARGS, MAX_TURNS, MAX_TURNS_CEILING, MAX_TURNS_REASON,
// EVENT_NAME, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** Kanon's per-turn rate for the dollar cap (`K-OBS-12`), and the step it rounds up to. */
export const PER_TURN_USD = 0.4;
export const BUDGET_STEP_USD = 5;

/** Where the limit, the ceiling and the "split or raise" rule are written down. */
export const DOC = 'docs/lanes.md, "The turn budget"';

/** The only event a raise is taken on. */
export const DISPATCH = 'workflow_dispatch';

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
 * Check a raised `max_turns` against a lane's ceiling.
 * @param {string} value the dispatched value, as the lane received it
 * @param {string} ceiling the lane's ceiling
 * @returns {{ ok: true, turns: number | null } | { ok: false, message: string }}
 */
export function checkMaxTurns(value, ceiling) {
  const v = String(value ?? '').trim();
  if (v === '') return { ok: true, turns: null };
  const c = String(ceiling ?? '').trim();
  if (!POSITIVE.test(c)) {
    return { ok: false, message: `max_turns is set to ${shown(v)}, but this lane gives no ceiling for it, so its turn limit can't be raised (${DOC}).` };
  }
  if (!POSITIVE.test(v)) {
    return { ok: false, message: `max_turns must be a whole number of turns from 1 to ${c}, not ${shown(v)}. Leave it empty to run at the lane's limit (${DOC}).` };
  }
  if (Number(v) > Number(c)) {
    return { ok: false, message: `max_turns is ${v}, above Kanon's ceiling of ${c} turns for this lane. The ceiling bounds what one run can spend; dispatch again with max_turns at ${c} or less, or split the work into parts each finishable in one run (${DOC}).` };
  }
  return { ok: true, turns: Number(v) };
}

/**
 * The flags the agent runs with: the lane's own, or with the raised turn limit and the dollar cap
 * derived from it in place of the lane's.
 * @param {{ claudeArgs: string, maxTurns?: string, ceiling?: string, reason?: string, event?: string }} args
 * @returns {{ ok: true, claudeArgs: string, turns: number | null, raised: boolean, message: string } | { ok: false, message: string }}
 */
export function turnBudget({ claudeArgs, maxTurns = '', ceiling = '', reason = '', event = '' }) {
  const checked = checkMaxTurns(maxTurns, ceiling);
  if (!checked.ok) return { ok: false, message: `::error ${TITLE}::${checked.message}` };
  const own = [...claudeArgs.matchAll(TURNS_FLAG)];
  const ownTurns = own.length === 1 ? Number(own[0]?.[2]) : null;
  if (checked.turns === null) {
    return { ok: true, claudeArgs, turns: ownTurns, raised: false, message: ownTurns === null ? 'The lane\'s flags run as they are.' : `The agent runs at the lane's turn limit, ${ownTurns} turns.` };
  }
  // ONE DISPATCHED RUN, NEVER A STANDING SETTING: a value that arrives on any other event came
  // from somewhere a person didn't choose it for this run.
  if (event !== DISPATCH) {
    return { ok: false, message: `::error ${TITLE}::max_turns is raised only for one dispatched run, and this run's event is ${shown(event)}, not ${DISPATCH}. Remove max_turns from the caller's with: unless it passes its own dispatch input, \${{ inputs.max_turns }} (${DOC}).` };
  }
  if (String(reason ?? '').trim() === '') {
    return { ok: false, message: `::error ${TITLE}::max_turns is ${checked.turns}, but the dispatch gives no reason. A raised turn limit needs one, recorded with the run: dispatch again with reason set (${DOC}).` };
  }
  const budgets = [...claudeArgs.matchAll(BUDGET_FLAG)];
  if (own.length !== 1 || budgets.length !== 1) {
    return { ok: false, message: `::error ${TITLE}::This lane's flags hold ${own.length} --max-turns and ${budgets.length} --max-budget-usd, not one of each, so max_turns has nothing to replace. This is a fault in the Kanon lane: report it (${DOC}).` };
  }
  const turns = checked.turns;
  const usd = budgetFor(turns);
  const out = claudeArgs
    .replace(TURNS_FLAG, (_, pre) => `${pre}--max-turns ${turns}`)
    .replace(BUDGET_FLAG, (_, pre) => `${pre}--max-budget-usd ${usd}`);
  return { ok: true, claudeArgs: out, turns, raised: true, message: `This dispatched run raises the turn limit to ${turns} turns (the lane's is ${ownTurns}), with a dollar cap of $${usd}.` };
}

/**
 * The step summary of a raised run: the limit, the lane's own, the dollar cap and the reason, as
 * one line of text each (the reason is a person's words, so it is quoted and kept to one line).
 * @param {{ turns: number, own: number | null, reason: string }} r
 */
export function raiseSummary({ turns, own, reason }) {
  const said = String(reason).replace(/[\r\n]+/g, ' ').trim().slice(0, 500).replace(/[`<>|]/g, (c) => `&#${c.charCodeAt(0)};`);
  return [
    '### Turn limit raised for this run',
    '',
    `- **max_turns:** ${turns} (the lane's limit is ${own ?? 'unknown'}), dollar cap $${budgetFor(turns)}`,
    `- **Reason:** ${said}`,
    '',
  ].join('\n');
}

if (isCliEntry(import.meta.url)) {
  const claudeArgs = process.env.CLAUDE_ARGS ?? '';
  const reason = process.env.MAX_TURNS_REASON ?? '';
  const r = turnBudget({
    claudeArgs,
    maxTurns: process.env.MAX_TURNS ?? '',
    ceiling: process.env.MAX_TURNS_CEILING ?? '',
    reason,
    event: process.env.EVENT_NAME ?? '',
  });
  console.log(r.message);
  if (!r.ok) process.exit(1);
  if (r.raised && r.turns !== null && process.env.GITHUB_STEP_SUMMARY) {
    const own = [...claudeArgs.matchAll(TURNS_FLAG)].map((m) => Number(m[2]))[0] ?? null;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, raiseSummary({ turns: r.turns, own, reason }));
  }
  const delim = `EOF_${randomBytes(12).toString('hex')}`;
  appendFileSync(String(process.env.GITHUB_OUTPUT), `max-turns=${r.turns ?? ''}\nclaude-args<<${delim}\n${r.claudeArgs}\n${delim}\n`);
}
