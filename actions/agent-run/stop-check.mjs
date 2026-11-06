// Whether the agent stopped on a precondition it found mid-run, and so did no work (kanon#1564).
//
// The CLI reports such a run as a clean `success`. Its prompt asks the agent to end its final
// message with a `KANON-STOP: <reason>` line then (`persona-prompt.mjs`, `STOP_RULE`), and this
// reads that line from the result file the action wrote: never the log. With it, the step writes a
// `::warning` with the agent's reason and a line in the step summary, so the run doesn't end green
// and silent. The row's outcome is `classifyResult`'s, `failed`, read in `agent-telemetry`.
//
// A warning, not a red: a red run starts each lane's crash route (the implement lane's retry, its
// WIP-slot release), which for a precondition would only run into it again. The warning is the
// person's signal, and the telemetry row is the count.
//
// Inputs, by environment only: EXECUTION_FILE, GITHUB_STEP_SUMMARY. ALWAYS EXITS 0.

import { appendFileSync } from 'node:fs';

import { preconditionStop, readResult } from '../agent-classify/classify-agent-result.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/**
 * The warning and summary for a run whose agent stopped on a precondition; null for any other.
 * The reason is the agent's text, so `%`, CR and LF are encoded in the annotation: it can't
 * write a workflow command of its own.
 * @param {unknown} result
 * @returns {{ annotation: string, summary: string } | null}
 */
export function stopNotice(result) {
  const why = preconditionStop(result);
  if (why === null) return null;
  const safe = why.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return {
    annotation: `::warning title=agent-run::The agent stopped on a precondition and did no work: ${safe}`,
    summary: `### The agent stopped on a precondition\n\n${why}\n\nNothing of this run's work was done. Fix what didn't hold, then run the lane again.\n`,
  };
}

if (isCliEntry(import.meta.url)) {
  try {
    const path = process.env.EXECUTION_FILE ?? '';
    if (!path) console.log('No result file to check for a precondition stop.');
    const notice = path ? stopNotice(readResult(path)) : null;
    if (notice) {
      console.log(notice.annotation);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, notice.summary);
    }
  } catch (e) {
    console.log(`Could not read the result file for a precondition stop: ${/** @type {Error} */ (e).message}`);
  }
}
