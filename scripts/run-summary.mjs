// A safe summary of an agent's run, for a short-retention artifact (kanon#1593, the Owner's decision
// of 2026-11-06).
//
// WHY. An adopter's implement runs ended `ok` with no comment and no pull request, and the log GitHub
// kept stopped about twelve minutes in, so nothing showed why the agent stopped. The agent's result
// file (`claude-execution-output.json`, which `agent-classify` already reads) holds the whole
// transcript, but it holds each tool call's raw input and output too, where a token the agent
// printed is not masked as it is in the log. So it is never uploaded. This keeps what says how the
// run went and nothing a tool read or wrote: the agent's final message, each tool call's name and
// whether it errored, in order, and the run's turn and cost counts.
//
// Usage: node scripts/run-summary.mjs --execution-file <path> --out <path>
// Writes the summary as JSON to `--out`; writes nothing, and says so, when there is no result file.
// Always exits 0: a summary must never red a run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseObjects } from '../actions/agent-classify/classify-agent-result.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** Its schema: a reader keys on it, and a change to the shape changes it. */
export const SUMMARY_SCHEMA = 'kanon-run-summary/v1';

/**
 * The summary of the result file's objects, or null when they hold no `result` event.
 * Each tool call is `{ name, error }`: `error` true or false from its `tool_result`, null when it
 * has none. Nothing of a call's input or output is read into it.
 * @param {any[]} objects
 */
export function runSummary(objects) {
  const result = [...objects].reverse().find((o) => o?.type === 'result');
  if (!result) return null;
  const blocks = (/** @type {any} */ o) => (Array.isArray(o?.message?.content) ? o.message.content : []);
  /** @type {Map<string, boolean>} */
  const errored = new Map();
  for (const o of objects) {
    if (o?.type !== 'user') continue;
    for (const b of blocks(o)) if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') errored.set(b.tool_use_id, b.is_error === true);
  }
  const tools = [];
  for (const o of objects) {
    if (o?.type !== 'assistant') continue;
    for (const b of blocks(o)) {
      if (b?.type !== 'tool_use') continue;
      const id = typeof b.id === 'string' ? b.id : '';
      tools.push({ name: typeof b.name === 'string' ? b.name.slice(0, 100) : 'unknown', error: errored.has(id) ? errored.get(id) : null });
    }
  }
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    schema: SUMMARY_SCHEMA,
    final_message: typeof result.result === 'string' ? result.result : null,
    subtype: typeof result.subtype === 'string' ? result.subtype : null,
    is_error: result.is_error === true,
    terminal_reason: typeof result.terminal_reason === 'string' ? result.terminal_reason : null,
    num_turns: num(result.num_turns),
    total_cost_usd: num(result.total_cost_usd),
    duration_ms: num(result.duration_ms),
    tool_calls: tools,
  };
}

if (isCliEntry(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? '' : (process.argv[i + 1] ?? '');
  };
  const file = arg('--execution-file');
  const out = arg('--out');
  try {
    const summary = file && out && existsSync(file) ? runSummary(parseObjects(readFileSync(file, 'utf8'))) : null;
    if (!summary) console.log('No result file to summarise, so no run summary was written.');
    else {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(`Wrote the run summary: ${summary.tool_calls.length} tool call(s), ${summary.num_turns ?? '?'} turn(s).`);
    }
  } catch (e) {
    console.log(`Could not write the run summary: ${/** @type {Error} */ (e).message}`);
  }
}
