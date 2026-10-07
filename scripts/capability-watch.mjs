#!/usr/bin/env node
// Prints whether the Overseer runs the capability watch: `on` or `off`, as the adoption record on
// the default branch declares it (`K-LAYOUT-10`, kanon#477), or Kanon's default, `off`, when it
// declares nothing. For the Overseer lane's gate job, which hands the value to the runtime-version
// check and the agent's job before any agent runs:
//
//   watch="$(node "$KANON/scripts/capability-watch.mjs")"
//
// Reads `GITHUB_REPOSITORY`, and `gh`'s token from the environment. Prints the value and exits 0,
// saying on standard error when the value is Kanon's default; exits 1 with the reader's message
// when the record is malformed or can't be read; exits 2 without `GITHUB_REPOSITORY`.

import { readCapabilityWatchFrom } from './lib/capability-watch.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * @param {{ repo?: string, run?: (args: string[], opts?: object) => string }} [io]
 * @returns {{ code: number, out: string, notes?: string[] }}
 */
export function capabilityWatchCli({ repo = process.env.GITHUB_REPOSITORY, run } = {}) {
  if (!repo) return { code: 2, out: 'capability-watch: GITHUB_REPOSITORY must be set' };
  try {
    /** @type {string[]} */
    const notes = [];
    const out = readCapabilityWatchFrom(repo, run, (line) => notes.push(`capability-watch: ${line}`));
    return notes.length ? { code: 0, out, notes } : { code: 0, out };
  } catch (e) {
    return { code: 1, out: /** @type {Error} */ (e).message };
  }
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  const { code, out, notes = [] } = capabilityWatchCli();
  for (const line of notes) process.stderr.write(`${line}\n`);
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
