// Whether the Overseer is installed, as the adoption record declares it (`K-LAYOUT-10`; plan 0004
// step 13, decision 12).
//
// WHY A DECLARATION. The Overseer is an optional lane: an adopter installs its caller or
// doesn't. Without a line saying which, a repository with no Overseer reads the same as one whose
// Overseer was deleted by mistake, and a reader of the record can't tell which mechanisms audit
// the pipeline. So the record says it, and `lane-check` holds it to the callers on disk.
//
// ONE BULLET UNDER `## Choices`, its value one code span and nothing after it:
//
//   ## Choices
//   - **Overseer:** `installed`
//
// or `not installed`. A record with it twice, outside `## Choices`, in another shape or with
// another value throws `DeclarationError` naming the file and the line.
//
// OMITTED, IT IS KANON'S DEFAULT, `not installed` (plan 0005 §5.2). A record without the bullet,
// or no record at all, declares the default, and the check says so in one line. The callers still
// hold it to the truth: a workflow that calls the Overseer's lane needs the bullet, `installed`.
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

/** Kanon's default when the record doesn't say (plan 0005 §5.2). */
export const DEFAULT_VALUE = 'not installed';

/**
 * Reads the record from a checked-out tree and holds it to the callers on disk, for
 * `lane-check`. A record that says whether the Overseer is installed must say what is true: a
 * caller of the Overseer's lane is `installed`, none is `not installed`. A record without the
 * bullet, or no record, is Kanon's default, `not installed`, held to the callers the same way,
 * and `defaults` names it. The record's other rules are `K-LAYOUT-10`'s, not this reader's.
 * @param {{ root?: string, caller: boolean }} o `caller`: whether a workflow calls the Overseer's lane
 * @returns {{ value: 'installed' | 'not installed', defaults: string[] }}
 */
export function checkOverseerInstall({ root = process.cwd(), caller }) {
  /** @type {string | null} */
  let text = null;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  const declared = text === null ? null : parseOverseerInstall(text);
  if (declared === null) {
    const why = text === null ? `${ADOPTION_RECORD} doesn't exist` : `${ADOPTION_RECORD} doesn't say whether the Overseer is installed`;
    if (caller) {
      throw fail(`${why}, so it reads as Kanon's default, \`${DEFAULT_VALUE}\`, but a workflow calls the Overseer's lane: add a \`**${LABEL}:**\` bullet under \`${CHOICES_HEADING}\` whose value is \`installed\``);
    }
    return { value: DEFAULT_VALUE, defaults: [`${why}, so Kanon's default applies: the Overseer is \`${DEFAULT_VALUE}\` (K-LAYOUT-10)`] };
  }
  if (caller && declared === 'not installed') {
    throw fail(`${ADOPTION_RECORD} says the Overseer is \`not installed\`, but a workflow calls its lane: change it to \`installed\`, or remove the caller`);
  }
  if (!caller && declared === 'installed') {
    throw fail(`${ADOPTION_RECORD} says the Overseer is \`installed\`, but no workflow calls its lane (${OVERSEER_CALLER}): add the caller, or change it to \`not installed\``);
  }
  return { value: declared, defaults: [] };
}
