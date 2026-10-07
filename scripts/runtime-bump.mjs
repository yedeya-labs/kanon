#!/usr/bin/env node
// Prints `true` when the Overseer's audit is due on this event, `false` when the runtime-version
// trigger finds the agent runtime unchanged (plan 0004 decision 12, amended 2026-10-06; kanon#423;
// `scripts/lib/runtime-bump.mjs` says how it decides). For the Overseer lane's gate job:
//
//   due="$(node "$KANON/scripts/runtime-bump.mjs")"
//
// Reads `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY`, `CAPABILITY_WATCH` (the gate job's reading of
// the adoption record's capability watch, `on` or `off`; kanon#477) and `gh`'s token from the
// environment, the
// capability ledger from the default branch (`K-MERGE-17`), and the runtime from the Kanon tree
// this file is in, which is the release the lane runs. Exits 0 with the answer, writing why as a
// notice and to the step summary when it is the runtime-version trigger; exits 2 without
// `GITHUB_REPOSITORY` on that trigger.

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defaultBranchFile } from './lib/declarations.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { LEDGER, reviewDue, runtimeOf } from './lib/runtime-bump.mjs';

/** This Kanon tree's root. */
const KANON_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {{ event?: string, repo?: string, root?: string, run?: (args: string[], opts?: object) => string, watch?: string }} [io]
 * @returns {{ code: number, out: string, note?: string }}
 */
export function runtimeBumpCli({ event = process.env.GITHUB_EVENT_NAME ?? '', repo = process.env.GITHUB_REPOSITORY, root = KANON_ROOT, run, watch = process.env.CAPABILITY_WATCH ?? '' } = {}) {
  if (event === 'pull_request_target' && !repo) return { code: 2, out: 'runtime-bump: GITHUB_REPOSITORY must be set' };
  const { due, note } = reviewDue({
    event,
    watch,
    runtime: () => runtimeOf(root),
    ledger: () => {
      const { branch, read } = defaultBranchFile(/** @type {string} */ (repo), run);
      if (!branch) throw new Error('the repository names no default branch');
      return read(LEDGER);
    },
  });
  return note ? { code: 0, out: String(due), note } : { code: 0, out: String(due) };
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  const { code, out, note } = runtimeBumpCli();
  if (note) {
    process.stderr.write(`::notice title=Overseer, runtime-version trigger::${note}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Runtime-version trigger:** ${note}\n`);
  }
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
