// Who the weekly digest is written for, as the adoption record declares it (`K-LAYOUT-10`;
// kanon#218, the Owner's decision of 2026-10-04).
//
// WHY A DECLARATION. The weekly digest's narrative is a few plain-language sentences for one
// reader, and who that reader is belongs to the project: one adopter writes for "a co-founder
// tracking runway", another for a client or a board. Kanon fixes where it is written and in what
// shape (ADR 0002), and the lane uses Kanon's own wording, `DEFAULT_AUDIENCE`, when the record
// declares none.
//
// ONE OPTIONAL BULLET UNDER `## Choices`, beside the record's other choices, its value as plain
// text after the bold label, on one line:
//
//   ## Choices
//   - **Weekly digest audience:** a co-founder tracking runway
//
// The value completes the prompt's sentence "The reader is …", so it reads as a noun phrase. A
// trailing full stop is dropped. A record with no such bullet declares nothing, which is valid.
// A bullet outside `## Choices`, in another shape, written twice, empty, longer than
// `MAX_LENGTH`, or holding a backtick, throws `DeclarationError` naming the file and the line.
//
// WHERE IT IS READ FROM. The lane reads the record from the repository's default branch
// (`readDigestAudienceFrom`), like every declaration a lane acts on (`K-MERGE-17`). `lane-check`
// reads the checked-out tree, so a pull request that breaks the bullet fails on that pull request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, defaultBranchFile, linesOf } from './declarations.mjs';
import { ADOPTION_RECORD, CHOICES_HEADING } from './reference-deploy.mjs';

/** The bullet's bold label. */
export const LABEL = 'Weekly digest audience';

/** Kanon's own audience, when the record declares none (kanon#216). */
export const DEFAULT_AUDIENCE = 'a stakeholder who follows the project from outside the day-to-day work';

/** The longest audience the prompt takes: a phrase, not a brief. */
export const MAX_LENGTH = 200;

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

/** Any line that starts, as Markdown reads it, with the label: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${LABEL}:\\*\\*`);

/** The one shape the bullet is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*${LABEL}:\\*\\* (.*)$`);

const EXAMPLE = `- **${LABEL}:** a co-founder tracking runway`;

/**
 * Parses the declared audience out of an adoption record. Returns `null` when the record
 * declares none, and throws `DeclarationError` naming the line of a malformed one.
 * @param {string} text the adoption record's markdown
 * @returns {string | null}
 */
export function parseDigestAudience(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) throw fail(`${ADOPTION_RECORD}:${fenced.unclosed + 1} opens a code fence that never closes`);

  const mentions = lines.flatMap((l, i) => (!fenced.has(i) && MENTION.test(l) ? [i] : []));
  if (mentions.length === 0) return null;
  if (mentions.length > 1) {
    throw fail(`${ADOPTION_RECORD}:${/** @type {number} */ (mentions[1]) + 1} repeats \`${LABEL}\`, already declared on line ${/** @type {number} */ (mentions[0]) + 1}`);
  }
  const at = /** @type {number} */ (mentions[0]);

  // The bullet must sit inside `## Choices`, which ends at the next `#` or `##` heading.
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
    throw fail(`${ADOPTION_RECORD}:${line} declares the weekly digest's audience outside \`${CHOICES_HEADING}\`: write the bullet under that heading`);
  }

  const entry = ENTRY.exec(/** @type {string} */ (lines[at]));
  if (!entry) {
    throw fail(`${ADOPTION_RECORD}:${line}, under \`${CHOICES_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, then the audience, as in: ${EXAMPLE}`);
  }
  const value = /** @type {string} */ (entry[1]).trim().replace(/\.$/, '').trim();
  if (!value) throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` names no audience: write who reads the digest, or remove the bullet for Kanon's default`);
  if (value.includes('`')) throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` is plain text, without a backtick`);
  if (value.length > MAX_LENGTH) {
    throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` is ${value.length} characters; name the reader in at most ${MAX_LENGTH}`);
  }
  return value;
}

/**
 * Reads the declaration from a checked-out tree, for `lane-check`. A missing record declares
 * nothing; a malformed one throws.
 * @param {string} [root] the repository root
 * @returns {string | null}
 */
export function readDigestAudience(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseDigestAudience(text);
}

/**
 * The audience the weekly lane writes for: the one the record on the default branch declares,
 * or `DEFAULT_AUDIENCE` when the record is missing there or declares none. Throws
 * `DeclarationError` when the record is malformed or can't be read: a lane must not quietly
 * write for the wrong reader.
 * `note` is given one line naming the default when the lane takes it (plan 0005 §5.2).
 * @param {string} repo `owner/name`
 * @param {(args: string[], opts?: object) => string} [run] `gh`, injected for tests
 * @param {(line: string) => void} [note]
 * @returns {string}
 */
export function readDigestAudienceFrom(repo, run, note = () => {}) {
  const { branch, read } = defaultBranchFile(repo, run);
  if (!branch) throw fail(`no default branch to read ${ADOPTION_RECORD} from`);
  let text;
  try {
    text = read(ADOPTION_RECORD);
  } catch (e) {
    throw fail(`${ADOPTION_RECORD} couldn't be read from \`${branch}\`: ${/** @type {Error} */ (e).message}`);
  }
  const declared = text === null ? null : parseDigestAudience(text);
  if (declared !== null) return declared;
  note(`${ADOPTION_RECORD} on \`${branch}\` ${text === null ? "doesn't exist" : 'declares no audience'}, so Kanon's default applies: the digest is written for ${DEFAULT_AUDIENCE} (K-LAYOUT-10)`);
  return DEFAULT_AUDIENCE;
}
