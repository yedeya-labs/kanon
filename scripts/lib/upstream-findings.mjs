// Where upstream findings go, the Overseer's and the telemetry Explorer's, as the adoption record
// declares it (`K-LAYOUT-10`, `K-SELF-11`; plan 0004 decision 12 as amended on 2026-10-06, kanon#423;
// kanon#471 for the telemetry Explorer).
//
// WHY A DECLARATION. A finding only Kanon can act on (a lane's behaviour, a guard, a rule,
// Kanon's library) is, by default, drafted and never filed (each lane says where it drafts:
// the Overseer under its audit issue's `## Upstream` heading, the telemetry Explorer in its run's
// summary): in an adopter's repository it is noise the adopter can't act on, and filing it on Kanon
// would carry the adopter's data across ADR 0007's boundary. A repository that can act on such
// findings itself (one that maintains Kanon, or a fork of it) would get every one of them as a
// draft and none as an issue. So the repository says so, and the filing step reads what it says.
// Nothing checks which repository it is: any repository may declare it.
//
// ONE OPTIONAL BULLET UNDER `## Choices`, its value one code span and nothing after it:
//
//   ## Choices
//   - **Upstream findings:** `filed here`
//
// or `drafted`. `filed here` files them IN THIS REPOSITORY, as the adopter's own findings are
// filed; it never files anything in another repository, so ADR 0007's boundary is unchanged. A
// record with it twice, outside `## Choices`, in another shape or with another value throws
// `DeclarationError` naming the file and the line.
//
// OMITTED, IT IS KANON'S DEFAULT, `drafted` (plan 0005 §5.2): a record without the bullet, or no
// record, routes upstream findings exactly as before the choice existed.
//
// WHERE IT IS READ FROM. The Overseer's lane reads the record from the default branch
// (`readUpstreamFindingsFrom`), like every declaration a lane acts on (`K-MERGE-17`), in its gate
// job, before any agent runs, and hands the value to its filing job as a job output. `lane-check`
// and `kanon doctor` read the checked-out tree, so a pull request that breaks the bullet fails on
// that pull request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, defaultBranchFile, linesOf } from './declarations.mjs';
import { ADOPTION_RECORD, CHOICES_HEADING } from './reference-deploy.mjs';

/** The bullet's bold label. */
export const LABEL = 'Upstream findings';

/** The two values it takes. */
export const VALUES = /** @type {const} */ (['drafted', 'filed here']);

/** Kanon's default when the record doesn't say: upstream findings are drafts, never issues. */
export const DEFAULT_VALUE = 'drafted';

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

/** Any line that starts, as Markdown reads it, with the label: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${LABEL}:\\*\\*`);

/** The one shape the bullet is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*${LABEL}:\\*\\* \`([^\`]*)\`\\s*$`);

const EXAMPLE = `- **${LABEL}:** \`filed here\``;

/**
 * Parses the declaration out of an adoption record. Returns `null` when the record doesn't
 * declare it, and throws `DeclarationError` naming the line of a malformed one.
 * @param {string} text the adoption record's markdown
 * @returns {'drafted' | 'filed here' | null}
 */
export function parseUpstreamFindings(text) {
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
    throw fail(`${ADOPTION_RECORD}:${line} declares where upstream findings go outside \`${CHOICES_HEADING}\`: write the bullet under that heading`);
  }
  const entry = ENTRY.exec(/** @type {string} */ (lines[at]));
  if (!entry) {
    throw fail(`${ADOPTION_RECORD}:${line}, under \`${CHOICES_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, then the value as one code span and nothing after it, as in: ${EXAMPLE}`);
  }
  const value = /** @type {string} */ (entry[1]);
  if (value !== 'drafted' && value !== 'filed here') {
    throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` is \`${value}\`; write \`drafted\` or \`filed here\``);
  }
  return value;
}

/**
 * Reads the declaration from a checked-out tree, for `lane-check` and `kanon doctor`. A missing
 * record declares nothing; a malformed one throws.
 * @param {string} [root] the repository root
 * @returns {'drafted' | 'filed here' | null}
 */
export function readUpstreamFindings(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseUpstreamFindings(text);
}

/**
 * Where the Overseer's lane routes upstream findings: what the record on the default branch
 * declares, or `DEFAULT_VALUE` when the record is missing there or declares nothing. Throws
 * `DeclarationError` when the record is malformed or can't be read: the lane must not file, or
 * keep from filing, on a guess. `note` is given one line naming the default when the lane takes
 * it (plan 0005 §5.2).
 * @param {string} repo `owner/name`
 * @param {(args: string[], opts?: object) => string} [run] `gh`, injected for tests
 * @param {(line: string) => void} [note]
 * @returns {'drafted' | 'filed here'}
 */
export function readUpstreamFindingsFrom(repo, run, note = () => {}) {
  const { branch, read } = defaultBranchFile(repo, run);
  if (!branch) throw fail(`no default branch to read ${ADOPTION_RECORD} from`);
  let text;
  try {
    text = read(ADOPTION_RECORD);
  } catch (e) {
    throw fail(`${ADOPTION_RECORD} couldn't be read from \`${branch}\`: ${/** @type {Error} */ (e).message}`);
  }
  const declared = text === null ? null : parseUpstreamFindings(text);
  if (declared !== null) return declared;
  note(`${ADOPTION_RECORD} on \`${branch}\` ${text === null ? "doesn't exist" : "doesn't say where upstream findings go"}, so Kanon's default applies: they are \`${DEFAULT_VALUE}\`, never filed (K-LAYOUT-10)`);
  return DEFAULT_VALUE;
}
