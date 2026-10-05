#!/usr/bin/env node
// Prints one field of the reference environment's deploy, as the adoption record on the
// default branch declares it (`K-LAYOUT-10`, `K-PROJ-11`; plan 0004 P6). For a workflow step
// that needs what the reconciler reads, such as its Actions probe, so the step names no
// workflow of its own:
//
//   workflow="$(node "$KANON/scripts/reference-deploy.mjs" workflow)"
//   gh run list --repo "$GITHUB_REPOSITORY" --workflow "$workflow" --limit 1
//
//   node scripts/reference-deploy.mjs <environment|workflow|job>
//
// Reads `GITHUB_REPOSITORY`, and `gh`'s token from the environment. Prints the value and exits 0;
// exits 1 with the reader's message when the record is missing, declares no reference
// environment, is malformed or can't be read; exits 2 on a usage error.

import { LABELS, readReferenceDeployFrom } from './lib/reference-deploy.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * @param {string[]} argv the arguments after the script
 * @param {{ repo?: string, run?: (args: string[], opts?: object) => string }} [io]
 * @returns {{ code: number, out: string }}
 */
export function referenceDeployCli(argv, { repo = process.env.GITHUB_REPOSITORY, run } = {}) {
  const field = /** @type {keyof typeof LABELS} */ (argv[0] ?? '');
  if (!Object.hasOwn(LABELS, field) || argv.length !== 1) {
    return { code: 2, out: `usage: reference-deploy.mjs <${Object.keys(LABELS).join('|')}>` };
  }
  if (!repo) return { code: 2, out: 'reference-deploy: GITHUB_REPOSITORY must be set' };
  try {
    return { code: 0, out: readReferenceDeployFrom(repo, run)[field] };
  } catch (e) {
    return { code: 1, out: /** @type {Error} */ (e).message };
  }
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  const { code, out } = referenceDeployCli(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
