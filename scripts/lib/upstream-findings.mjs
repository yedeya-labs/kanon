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
// or `drafted`, `sent` or `sent with evidence`. `filed here` files them IN THIS REPOSITORY, as the
// adopter's own findings are filed; it never files anything in another repository, so ADR 0007's
// boundary is unchanged. A record with it twice, outside `## Choices`, in another shape or with
// another value throws `DeclarationError` naming the file and the line.
//
// SENT (plan 0006 §3.1, kanon#585). `sent` and `sent with evidence` also draft each finding, and
// send it to Kanon's telemetry store over the telemetry channel: the collector sends the rows, so
// both need a workflow that calls Kanon's telemetry collector. Without one nothing is sent, and
// `lane-check` and `kanon doctor` say so (`upstream.unsent`, `unsentMessage`), naming both fixes.
// The lanes build the rows in plan 0006's F3, and the collector sends them in F4: until then a
// sent finding is drafted, and nothing is sent.
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

/** The four values it takes. */
export const VALUES = /** @type {const} */ (['drafted', 'filed here', 'sent', 'sent with evidence']);

/** The values that send findings to Kanon's telemetry store, and so need its collector (plan 0006 §3.1). */
export const SENT_VALUES = /** @type {const} */ (['sent', 'sent with evidence']);

/** @typedef {typeof VALUES[number]} Value */

/** Kanon's default when the record doesn't say: upstream findings are drafts, never issues. */
export const DEFAULT_VALUE = 'drafted';

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

/** Any line that starts, as Markdown reads it, with the label: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${LABEL}:\\*\\*`);

/** The one shape the bullet is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*${LABEL}:\\*\\* \`([^\`]*)\`\\s*$`);

const EXAMPLE = `- **${LABEL}:** \`filed here\``;

/** The values, as the error that names them writes them. */
const WRITE = `${VALUES.slice(0, -1).map((v) => `\`${v}\``).join(', ')} or \`${VALUES[VALUES.length - 1]}\``;

/**
 * Parses the declaration out of an adoption record. Returns `null` when the record doesn't
 * declare it, and throws `DeclarationError` naming the line of a malformed one.
 * @param {string} text the adoption record's markdown
 * @returns {Value | null}
 */
export function parseUpstreamFindings(text) {
  return declaredAt(text)?.value ?? null;
}

/**
 * The declaration and its line (1-based), or `null` when the record doesn't declare it. Throws as
 * `parseUpstreamFindings` does.
 * @param {string} text
 * @returns {{ value: Value, line: number } | null}
 */
export function declaredAt(text) {
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
  if (!(/** @type {readonly string[]} */ (VALUES)).includes(value)) {
    throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` is \`${value}\`; write ${WRITE}`);
  }
  return { value: /** @type {Value} */ (value), line };
}

/** @param {string | null | undefined} value @returns {boolean} whether it sends findings to Kanon */
export const sends = (value) => (/** @type {readonly (string | null | undefined)[]} */ (SENT_VALUES)).includes(value);

/**
 * What `lane-check` and `kanon doctor` say of a record that sends findings with no caller of
 * Kanon's telemetry collector (plan 0006 §3.1, `upstream.unsent`): nothing is sent, and the two
 * fixes. `null` when the record doesn't send, or a workflow calls the collector.
 * @param {string} text the adoption record's markdown
 * @param {boolean} collector whether a workflow calls Kanon's telemetry collector
 * @returns {string | null}
 */
export function unsentMessage(text, collector) {
  const at = declaredAt(text);
  if (!at || !sends(at.value) || collector) return null;
  return `${ADOPTION_RECORD}:${at.line} says \`${LABEL}: ${at.value}\`, and no workflow calls Kanon's telemetry collector, so nothing is sent and the lanes only draft them: opt in to telemetry (\`kanon init --telemetry\`, docs/telemetry.md), or choose \`drafted\` (K-LAYOUT-10, upstream.unsent)`;
}

/**
 * The same, from a checked-out tree, for `lane-check`: throws `DeclarationError` with the message.
 * A missing record sends nothing.
 * @param {string} root the repository root @param {boolean} collector
 */
export function checkUpstreamSent(root, collector) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return;
    throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  const message = unsentMessage(text, collector);
  if (message) throw new DeclarationError(message);
}

/**
 * Reads the declaration from a checked-out tree, for `lane-check` and `kanon doctor`. A missing
 * record declares nothing; a malformed one throws.
 * @param {string} [root] the repository root
 * @returns {Value | null}
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
 * @returns {Value}
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
