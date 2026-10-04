// Whether the Overseer is installed, as the adoption record declares it (`K-LAYOUT-10`; plan 0004
// step 13, decision 12).
//
// WHY A DECLARATION. The Overseer is an optional lane: an adopter installs its caller or
// doesn't. Without a line saying which, a repository with no Overseer reads the same as one whose
// Overseer was deleted by mistake, and a reader of the record can't tell which mechanisms audit
// the pipeline. So the record says it, and `lane-check` holds it to the callers on disk.
//
// ONE REQUIRED BULLET UNDER `## Choices`, its value one code span and nothing after it:
//
//   ## Choices
//   - **Overseer:** `installed`
//
// or `not installed`. A record without it, with it twice, outside `## Choices`, in another shape
// or with another value throws `DeclarationError` naming the file and the line.
//
// WHERE IT IS READ FROM. Only `lane-check` reads it, from the checked-out tree, so a pull request
// that breaks it, or adds or removes the Overseer's caller without changing it, fails on that
// pull request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, linesOf } from './declarations.mjs';
import { ADOPTION_RECORD, CHOICES_HEADING } from './reference-deploy.mjs';

/** The bullet's bold label. */
export const LABEL = 'Overseer';

/** The two values it takes. */
export const VALUES = /** @type {const} */ (['installed', 'not installed']);

/** The Overseer's caller, by the file name every lane caller takes (`K-LAYOUT-18`). */
export const OVERSEER_CALLER = '.github/workflows/agent-overseer.yml';

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

/** Any line that starts, as Markdown reads it, with the label: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${LABEL}:\\*\\*`);

/** The one shape the bullet is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*${LABEL}:\\*\\* \`([^\`]*)\`\\s*$`);

const EXAMPLE = `- **${LABEL}:** \`installed\``;

/**
 * Parses the declaration out of an adoption record. Returns `null` when the record doesn't
 * declare it, and throws `DeclarationError` naming the line of a malformed one.
 * @param {string} text the adoption record's markdown
 * @returns {'installed' | 'not installed' | null}
 */
export function parseOverseerInstall(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) throw fail(`${ADOPTION_RECORD}:${fenced.unclosed + 1} opens a code fence that never closes`);

  const mentions = lines.flatMap((l, i) => (!fenced.has(i) && MENTION.test(l) ? [i] : []));
  if (mentions.length === 0) return null;
  if (mentions.length > 1) {
    throw fail(`${ADOPTION_RECORD}:${/** @type {number} */ (mentions[1]) + 1} repeats \`${LABEL}\`, already declared on line ${/** @type {number} */ (mentions[0]) + 1}`);
  }
  const at = /** @type {number} */ (mentions[0]);

  const heads = lines.flatMap((l, i) => (!fenced.has(i) && l.trimEnd() === CHOICES_HEADING ? [i] : []));
  if (heads.length > 1) {
    throw fail(`${ADOPTION_RECORD} has the \`${CHOICES_HEADING}\` heading ${heads.length} times, on lines ${heads.map((i) => i + 1).join(', ')}`);
  }
  const start = heads[0] ?? -1;
  let end = lines.length;
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i += 1) {
      if (!fenced.has(i) && /^#{1,2}\s/.test(/** @type {string} */ (lines[i]))) { end = i; break; }
    }
  }
  const line = at + 1;
  if (start === -1 || at < start || at >= end) {
    throw fail(`${ADOPTION_RECORD}:${line} declares whether the Overseer is installed outside \`${CHOICES_HEADING}\`: write the bullet under that heading`);
  }
  const entry = ENTRY.exec(/** @type {string} */ (lines[at]));
  if (!entry) {
    throw fail(`${ADOPTION_RECORD}:${line}, under \`${CHOICES_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, then the value as one code span and nothing after it, as in: ${EXAMPLE}`);
  }
  const value = /** @type {string} */ (entry[1]);
  if (value !== 'installed' && value !== 'not installed') {
    throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` is \`${value}\`; write \`installed\` or \`not installed\``);
  }
  return value;
}

/**
 * Reads the record from a checked-out tree and holds it to the callers on disk, for
 * `lane-check`. The record must say whether the Overseer is installed, and say what is true: a
 * caller of the Overseer's lane is `installed`, none is `not installed`. A repository with no
 * record and no Overseer caller declares nothing, which this accepts: the record's other rules
 * are `K-LAYOUT-10`'s, not this reader's.
 * @param {{ root?: string, caller: boolean }} o `caller`: whether a workflow calls the Overseer's lane
 */
export function checkOverseerInstall({ root = process.cwd(), caller }) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
    if (!caller) return null;
    throw fail(`${ADOPTION_RECORD} is missing, and a workflow calls the Overseer's lane: write the record, with a \`**${LABEL}:**\` bullet under \`${CHOICES_HEADING}\` whose value is \`installed\``);
  }
  const declared = parseOverseerInstall(text);
  if (declared === null) {
    throw fail(`${ADOPTION_RECORD} doesn't say whether the Overseer is installed: add a \`**${LABEL}:**\` bullet under \`${CHOICES_HEADING}\`, its value \`installed\` or \`not installed\` (plan 0004 decision 12)`);
  }
  if (caller && declared === 'not installed') {
    throw fail(`${ADOPTION_RECORD} says the Overseer is \`not installed\`, but a workflow calls its lane: change it to \`installed\`, or remove the caller`);
  }
  if (!caller && declared === 'installed') {
    throw fail(`${ADOPTION_RECORD} says the Overseer is \`installed\`, but no workflow calls its lane (${OVERSEER_CALLER}): add the caller, or change it to \`not installed\``);
  }
  return declared;
}
