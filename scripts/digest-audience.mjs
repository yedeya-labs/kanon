#!/usr/bin/env node
// Prints who the weekly digest is written for: the audience the adoption record on the default
// branch declares (`K-LAYOUT-10`, kanon#218), or Kanon's default when it declares none. For the
// weekly lane's prompt:
//
//   audience="$(node "$KANON/scripts/digest-audience.mjs")"
//
// Reads `GITHUB_REPOSITORY`, and `gh`'s token from the environment. Prints the audience and
// exits 0, saying on standard error when the audience is Kanon's default; exits 1 with the reader's message when the record is malformed or can't be read;
// exits 2 without `GITHUB_REPOSITORY`.

import { readDigestAudienceFrom } from './lib/digest-audience.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * @param {{ repo?: string, run?: (args: string[], opts?: object) => string }} [io]
 * @returns {{ code: number, out: string, notes?: string[] }}
 */
export function digestAudienceCli({ repo = process.env.GITHUB_REPOSITORY, run } = {}) {
  if (!repo) return { code: 2, out: 'digest-audience: GITHUB_REPOSITORY must be set' };
  try {
    /** @type {string[]} */
    const notes = [];
    const out = readDigestAudienceFrom(repo, run, (line) => notes.push(`digest-audience: ${line}`));
    return notes.length ? { code: 0, out, notes } : { code: 0, out };
  } catch (e) {
    return { code: 1, out: /** @type {Error} */ (e).message };
  }
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  const { code, out, notes = [] } = digestAudienceCli();
  for (const line of notes) process.stderr.write(`${line}\n`);
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
