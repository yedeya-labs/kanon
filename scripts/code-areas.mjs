#!/usr/bin/env node
// Prints what the code audit reads, from the stack document's `## Code areas` in the checked-out
// tree (`K-LAYOUT-17`; plan 0004 step 11, decision 6), one markdown bullet per area, for the
// code-audit lane's prompt:
//
//   node "$KANON/scripts/code-areas.mjs"
//
// The declared `audit` areas; without any, the declared `code` trees; without those, the whole
// repository (`scripts/lib/code-areas.mjs`). The first line of standard error says which.
// Exits 0; exits 1 with the reader's message when the section is malformed, so the lane fails
// by name before the agent rather than auditing areas nobody declared.

import { STACK_FILE, auditAreas, readCodeAreas } from './lib/code-areas.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

const SOURCES = {
  audit: `the \`audit\` areas ${STACK_FILE} declares`,
  code: `the \`code\` trees ${STACK_FILE} declares, which declares no \`audit\` area`,
  repository: `the whole repository: ${STACK_FILE} declares no code areas`,
};

/**
 * @param {{ root?: string }} [io]
 * @returns {{ code: number, out: string, note: string }}
 */
export function codeAreasCli({ root = process.cwd() } = {}) {
  try {
    const { source, lines } = auditAreas(readCodeAreas(root));
    return { code: 0, out: lines.join('\n'), note: `code-areas: auditing ${SOURCES[source]}` };
  } catch (e) {
    return { code: 1, out: '', note: `code-areas: ${/** @type {Error} */ (e).message}` };
  }
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  const { code, out, note } = codeAreasCli();
  process.stderr.write(`${note}\n`);
  if (out) process.stdout.write(`${out}\n`);
  process.exitCode = code;
}
