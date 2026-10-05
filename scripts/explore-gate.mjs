#!/usr/bin/env node
// The Explorer's change gate (RA-167, RA-702, RA-714; plan 0004 step 12): whether this run
// sweeps, from the QA store's newest green full sweep.
//
// The sweep is deterministic per commit, so a scheduled sweep of a commit already swept green
// surfaces nothing new: it is pure quota. A scheduled run on that commit is skipped, and the
// lane records the skip (`record-skip`), so bounded coverage doesn't read as full. A dispatch
// always sweeps: someone asked for it.
//
// THE STORE JOB READS, THIS DECIDES. `last-green` runs in a store job of its own, which holds
// the store's credentials and runs nothing but Kanon's `qa-store` block (plan 0004 §3.2). This
// runs in a job after it, with no credentials, reading the store job's outputs.
//
// EVERY ANSWER BUT ONE SWEEPS, AND SAYS WHY. Only `ok` with this very commit skips. A store
// that is absent (no hook) has no memory, so the lane always sweeps and says the store is
// absent. A read that failed or came back malformed is `degraded` (the block's tripwire turns
// a non-SHA into that, RA-702), and so is a store job that didn't finish: both sweep, with a
// warning, because a store hiccup must run the sweep, never skip it, and must never be silent
// (RA-702 was a broken baseline query that stayed invisible for two weeks).
//
// ENV  EVENT            github.event_name
//      HEAD_SHA         github.sha, the commit this run would sweep
//      BASELINE_RESULT  needs.<last-green job>.result: success, failure, cancelled or skipped
//      STATE            the block's `state` output: ok, absent or degraded
//      LAST_GREEN       the block's `commit` output, empty when no green full sweep is recorded
//
// Writes `sweep=true|false` to $GITHUB_OUTPUT and one line to the step summary.

import { appendFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ sweep: boolean, line: string, warning: string | null }}
 */
export function decide(env) {
  const event = env.EVENT ?? '';
  const head = env.HEAD_SHA ?? '';
  const result = env.BASELINE_RESULT ?? '';
  const state = env.STATE ?? '';
  const last = (env.LAST_GREEN ?? '').trim();
  /** @param {string} line @param {string | null} [warning] */
  const sweep = (line, warning = null) => ({ sweep: true, line, warning });

  if (event !== 'schedule') return sweep(`A ${event || 'non-scheduled'} run is not gated: sweeping.`);
  if (result !== 'success') {
    const why = `the store job that reads the last green sweep ended \`${result || 'unknown'}\`, so this commit cannot be compared with it`;
    return sweep(`Change gate degraded: ${why}. Sweeping.`, `${why}: running the full sweep.`);
  }
  if (state === 'absent') {
    return sweep('The QA store is absent: this repository has no store hook, so there is no last green sweep to compare with. Sweeping, without memory.');
  }
  if (state !== 'ok') {
    const why = `the store's last green sweep could not be read (state \`${state || 'unknown'}\`)`;
    return sweep(`Change gate degraded: ${why}. Sweeping.`, `${why}: running the full sweep.`);
  }
  if (!last) return sweep('No green full sweep is recorded in the store yet: sweeping.');
  if (last !== head) return sweep(`The commit changed since the last green full sweep (\`${last.slice(0, 12)}\`): sweeping.`);
  return { sweep: false, line: `\`${head.slice(0, 12)}\` was already swept green: skipping the sweep, and recording the skip.`, warning: null };
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  const { sweep, line, warning } = decide(process.env);
  if (warning) console.log(`::warning title=Explorer change gate degraded::${warning}`);
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sweep=${sweep}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}
