// Whether the Overseer runs the capability watch (`K-SELF-16`, `K-SELF-17`), as the adoption
// record declares it (`K-LAYOUT-10`; the Owner's decision on kanon#477, 2026-10-07).
//
// WHY A DECLARATION. The capability watch reviews the agent runtime's changelog since the
// capability ledger's watermark. An adopter's runtime is whatever its Kanon release pins
// (`actions/agent-run`'s `claude-code-action` pin), so every adopter's Overseer would review the
// same changelog after each runtime change, and every candidate would be one only the repository
// that maintains that pin can act on. So the watch is a choice, off by default, and a repository
// that wants it says so. Nothing checks which repository it is: any repository may declare it.
//
// ONE OPTIONAL BULLET UNDER `## Choices`, its value one code span and nothing after it:
//
//   ## Choices
//   - **Capability watch:** `on`
//
// or `off`. A record with it twice, outside `## Choices`, in another shape or with another value
// throws `DeclarationError` naming the file and the line.
//
// OMITTED, IT IS KANON'S DEFAULT, `off` (plan 0005 §5.2). Off, the Overseer's prompt skips the
// capability section and says so on its status line, the runtime-version trigger doesn't audit,
// and the capability ledger isn't required. `on` is the behaviour the lane had before the choice.
//
// WHERE IT IS READ FROM. The Overseer's lane reads the record from the default branch
// (`readCapabilityWatchFrom`), like every declaration a lane acts on (`K-MERGE-17`), in its gate
// job, before any agent runs, and hands the value to the agent's job and the runtime-version
// check. `lane-check` and `kanon doctor` read the checked-out tree, so a pull request that breaks
// the bullet fails on that pull request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, defaultBranchFile, linesOf } from './declarations.mjs';
import { ADOPTION_RECORD, CHOICES_HEADING } from './reference-deploy.mjs';

/** The bullet's bold label. */
export const LABEL = 'Capability watch';

/** The two values it takes. */
export const VALUES = /** @type {const} */ (['on', 'off']);

/** Kanon's default when the record doesn't say: no capability watch. */
export const DEFAULT_VALUE = 'off';

/** The capability ledger, which only a repository that runs the watch needs (`K-LAYOUT-7`). */
export const LEDGER = 'docs/qa/capability-ledger.md';

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

/** Any line that starts, as Markdown reads it, with the label: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${LABEL}:\\*\\*`);

/** The one shape the bullet is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*${LABEL}:\\*\\* \`([^\`]*)\`\\s*$`);

const EXAMPLE = `- **${LABEL}:** \`on\``;

/**
 * Parses the declaration out of an adoption record. Returns `null` when the record doesn't
 * declare it, and throws `DeclarationError` naming the line of a malformed one.
 * @param {string} text the adoption record's markdown
 * @returns {'on' | 'off' | null}
 */
export function parseCapabilityWatch(text) {
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
    throw fail(`${ADOPTION_RECORD}:${line} declares the capability watch outside \`${CHOICES_HEADING}\`: write the bullet under that heading`);
  }
  const entry = ENTRY.exec(/** @type {string} */ (lines[at]));
  if (!entry) {
    throw fail(`${ADOPTION_RECORD}:${line}, under \`${CHOICES_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, then the value as one code span and nothing after it, as in: ${EXAMPLE}`);
  }
  const value = /** @type {string} */ (entry[1]);
  if (value !== 'on' && value !== 'off') {
    throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` is \`${value}\`; write \`on\` or \`off\``);
  }
  return value;
}

/**
 * Reads the declaration from a checked-out tree, for `lane-check` and `kanon doctor`. A missing
 * record declares nothing; a malformed one throws.
 * @param {string} [root] the repository root
 * @returns {'on' | 'off' | null}
 */
export function readCapabilityWatch(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseCapabilityWatch(text);
}

/**
 * Whether the Overseer's lane runs the capability watch: what the record on the default branch
 * declares, or `DEFAULT_VALUE` when the record is missing there or declares nothing. Throws
 * `DeclarationError` when the record is malformed or can't be read: the lane must not run, or
 * skip, the review on a guess. `note` is given one line naming the default when the lane takes
 * it (plan 0005 §5.2).
 * @param {string} repo `owner/name`
 * @param {(args: string[], opts?: object) => string} [run] `gh`, injected for tests
 * @param {(line: string) => void} [note]
 * @returns {'on' | 'off'}
 */
export function readCapabilityWatchFrom(repo, run, note = () => {}) {
  const { branch, read } = defaultBranchFile(repo, run);
  if (!branch) throw fail(`no default branch to read ${ADOPTION_RECORD} from`);
  let text;
  try {
    text = read(ADOPTION_RECORD);
  } catch (e) {
    throw fail(`${ADOPTION_RECORD} couldn't be read from \`${branch}\`: ${/** @type {Error} */ (e).message}`);
  }
  const declared = text === null ? null : parseCapabilityWatch(text);
  if (declared !== null) return declared;
  note(`${ADOPTION_RECORD} on \`${branch}\` ${text === null ? "doesn't exist" : "doesn't declare the capability watch"}, so Kanon's default applies: it is \`${DEFAULT_VALUE}\`, and the Overseer skips the capability review (K-LAYOUT-10)`);
  return DEFAULT_VALUE;
}
