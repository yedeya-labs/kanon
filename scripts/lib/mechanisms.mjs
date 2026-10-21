// The adoption record's mechanism list (`K-ADOPT-9`, `K-LAYOUT-10`), and the reasons it gives
// for the mechanisms that don't apply to the repository.
//
// THE LIST is the table under `## Mechanisms`, headed `| Mechanism | Rules | Status |`: one row
// per mechanism a rule's "Enforced by" line names, the rules that name it, and its status, one of
//
//   installed YYYY-MM-DD   it runs on this repository, since that date
//   not yet installed      it doesn't run here yet, so its rules are prose only here
//   not applicable         the repository has nothing it would act on, so it never will
//
// A NOT-APPLICABLE ROW CARRIES ITS REASON UNDER `## Choices`, beside the record's other choices
// and its doctor waivers, in one bullet per mechanism: the bold label, the row's rules, each a
// code span, separated by `, `, and then in parentheses why the repository has nothing for it to
// act on, on one line:
//
//   ## Choices
//
//   - **Mechanism not applicable:** `K-SHIP-8`, `K-SHIP-9` (the repository deploys nothing)
//
// The rules name the row: the bullet's rules are exactly the rules of one row, in any order. So
// the reason is the repository's own, written where a reader looks for its choices, and the
// pull request that writes it goes to a human, as a waiver's does (`docs/qa/` is the Maintainer's).
// Any repository may say it, about any mechanism; Kanon knows no repository's special case.
//
// MALFORMED, each reported by its line: a bullet in another shape, outside `## Choices`, naming
// rules no row lists exactly, naming a row that isn't marked `not applicable`, or naming one row
// twice; a row marked `not applicable` with no bullet, or with no rules to name it by; and two
// such rows with the same rules, since a bullet couldn't tell them apart. A record with no
// mechanism table, or one headed otherwise, has no rows: then any bullet names no row.
//
// What else a row says, and whether an `installed` status is true, this module doesn't check:
// Kanon's own record is held to its format by `tests/unit/adoption-record.test.ts`.
//
// Node built-ins only: `kanon doctor` imports it.

import { fencedLines } from '../spec-lib.mjs';
import { linesOf } from './declarations.mjs';
import { ADOPTION_RECORD, CHOICES_HEADING } from './reference-deploy.mjs';

export const MECHANISMS_HEADING = '## Mechanisms';

/** The mechanism table's header row, exactly. */
export const TABLE_HEADER = '| Mechanism | Rules | Status |';

/** The bullet's bold label, under `## Choices`. */
export const NOT_APPLICABLE_LABEL = 'Mechanism not applicable';

/** The three statuses a row may carry, its backticks dropped. */
export const STATUS = /^(installed \d{4}-\d{2}-\d{2}|not yet installed|not applicable)$/;

export const NOT_APPLICABLE = 'not applicable';

const RULE_ID = /K-[A-Z]+-\d+/g;

/** Any line that starts, as Markdown reads it, with the label: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${NOT_APPLICABLE_LABEL}:\\*\\*`);

/** The one shape the bullet is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*${NOT_APPLICABLE_LABEL}:\\*\\* (\`K-[A-Z]+-\\d+\`(?:, \`K-[A-Z]+-\\d+\`)*) \\((.*\\S.*)\\)\\s*$`);

export const EXAMPLE = `- **${NOT_APPLICABLE_LABEL}:** \`K-SHIP-8\`, \`K-SHIP-9\` (the repository deploys nothing)`;

/** @param {string[]} ids @returns {string} the set's key: its ids, sorted */
const keyOf = (ids) => [...new Set(ids)].sort().join(' ');

/** @param {string[]} ids */
const spans = (ids) => ids.map((id) => `\`${id}\``).join(', ');

/**
 * @typedef {{ mechanism: string, rules: string[], status: string, line: number }} Row
 * @typedef {{ rules: string[], reason: string, line: number }} Reason
 */

/**
 * The rows of a record's mechanism table, each with its 1-based line. An empty list when the
 * record has no `## Mechanisms` section, or no table headed `TABLE_HEADER` in it.
 * @param {string} text the adoption record's markdown
 * @returns {Row[]}
 */
export function mechanismRows(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  const start = lines.findIndex((l, i) => !fenced.has(i) && l.trimEnd() === MECHANISMS_HEADING);
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!fenced.has(i) && /^#{1,2}\s/.test(/** @type {string} */ (lines[i]))) { end = i; break; }
  }
  const head = lines.findIndex((l, i) => i > start && i < end && l.trim() === TABLE_HEADER);
  if (head === -1) return [];
  /** @type {Row[]} */
  const rows = [];
  for (let i = head + 2; i < end; i += 1) {
    const line = /** @type {string} */ (lines[i]);
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows.push({
      mechanism: cells[0] ?? '',
      rules: (cells[1] ?? '').match(RULE_ID) ?? [],
      status: (cells[cells.length - 1] ?? '').replace(/`/g, '').trim(),
      line: i + 1,
    });
  }
  return rows;
}

/**
 * The mechanism list and its not-applicable reasons, with every problem as a message naming its
 * line. Never throws: the readers report the errors.
 * @param {string | null} text the adoption record's markdown, or `null` when there is none
 * @returns {{ rows: Row[], reasons: Reason[], errors: string[] }}
 */
export function readMechanisms(text) {
  /** @type {Reason[]} */
  const reasons = [];
  /** @type {string[]} */
  const errors = [];
  if (!text) return { rows: [], reasons, errors };
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) {
    errors.push(`${ADOPTION_RECORD}:${fenced.unclosed + 1} opens a code fence that never closes`);
    return { rows: [], reasons, errors };
  }
  const rows = mechanismRows(text);

  // The rows that don't apply, by their rules. Two with the same rules can't be told apart.
  /** @type {Map<string, Row>} */
  const notApplicable = new Map();
  for (const row of rows.filter((r) => r.status === NOT_APPLICABLE)) {
    if (row.rules.length === 0) {
      errors.push(`${ADOPTION_RECORD}:${row.line} marks a mechanism \`${NOT_APPLICABLE}\` but lists no rules, so no \`${NOT_APPLICABLE_LABEL}\` bullet can name it: list the rules that name it`);
      continue;
    }
    const key = keyOf(row.rules);
    const twin = notApplicable.get(key);
    if (twin) {
      errors.push(`${ADOPTION_RECORD}:${row.line} marks a mechanism \`${NOT_APPLICABLE}\` with the same rules as line ${twin.line}, so a \`${NOT_APPLICABLE_LABEL}\` bullet can't tell them apart: make them one row`);
      continue;
    }
    notApplicable.set(key, row);
  }
  /** @type {Map<string, Row>} every row by its rules, the first of any that share them */
  const byRules = new Map();
  for (const row of rows) if (row.rules.length && !byRules.has(keyOf(row.rules))) byRules.set(keyOf(row.rules), row);

  // The bullets, which must sit inside `## Choices`, which ends at the next `#` or `##` heading.
  const choices = lines.findIndex((l, i) => !fenced.has(i) && l.trimEnd() === CHOICES_HEADING);
  let end = lines.length;
  if (choices !== -1) {
    for (let i = choices + 1; i < lines.length; i += 1) {
      if (!fenced.has(i) && /^#{1,2}\s/.test(/** @type {string} */ (lines[i]))) { end = i; break; }
    }
  }
  /** @type {Set<string>} */
  const named = new Set();
  lines.forEach((l, i) => {
    if (fenced.has(i) || !MENTION.test(l)) return;
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    const m = ENTRY.exec(l);
    if (!m) return errors.push(`${where} is not \`- **${NOT_APPLICABLE_LABEL}:** \`<rule>\`, \`<rule>\` (<why the repository has nothing for it to act on>)\`, naming the rules of its row in \`${MECHANISMS_HEADING}\`, as in: ${EXAMPLE}`);
    if (choices === -1 || i < choices || i >= end) return errors.push(`${where} says a mechanism doesn't apply outside \`${CHOICES_HEADING}\`: write the bullet under that heading`);
    const ids = /** @type {string} */ (m[1]).match(RULE_ID) ?? [];
    const key = keyOf(ids);
    if (named.has(key)) return errors.push(`${where} names the mechanism of ${spans(ids)} a second time`);
    named.add(key);
    const row = byRules.get(key);
    if (!row) return errors.push(`${where} names ${spans(ids)}, which no row of \`${MECHANISMS_HEADING}\` lists as exactly its rules: name the rules of the row that doesn't apply, all of them`);
    if (row.status !== NOT_APPLICABLE) return errors.push(`${where} says the mechanism of ${spans(ids)} doesn't apply, but ${ADOPTION_RECORD}:${row.line} marks it \`${row.status}\`: mark the row \`${NOT_APPLICABLE}\`, or remove the bullet`);
    reasons.push({ rules: ids, reason: /** @type {string} */ (m[2]).trim(), line: i + 1 });
    return undefined;
  });
  for (const [key, row] of notApplicable) {
    if (!named.has(key)) errors.push(`${ADOPTION_RECORD}:${row.line} marks a mechanism \`${NOT_APPLICABLE}\` with no reason: say why under \`${CHOICES_HEADING}\`, as \`- **${NOT_APPLICABLE_LABEL}:** ${spans([...new Set(row.rules)])} (<why>)\``);
  }
  return { rows, reasons, errors };
}
