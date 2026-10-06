// Whether the adopter's production promotion is human-gated, as the adoption record declares
// it (`K-LAYOUT-10`, `K-MERGE-4`; kanon#158, the Owner's decision of 2026-10-06).
//
// WHY A DECLARATION. `K-MERGE-4` sends a PR that touches one of the project's high-risk paths
// (`## Escalation paths` in `docs/qa/escalation-paths.md`) to a human, because a wrong merge
// there is the most expensive kind. An adopter whose every production deploy already waits for
// a person's approval has that person later in the line: a bad merge costs a revert and a
// staging blip, and can't reach production. The reference adopter measured the merge gate
// firing about 30 times as often as the promotion gate (RA-936). So the adopter may say, in the
// record, that the human gate is the promotion, and the Merger then merges those PRs in the
// green zone. It is a declaration, not a check: Kanon doesn't verify the environment's
// required reviewer, and the record is where a reader finds out what was claimed.
//
// ONE OPTIONAL BULLET UNDER `## Choices`, beside the record's other choices:
//
//   ## Choices
//   - **Production promotion:** human-gated (the `production` environment's required reviewer)
//
// `human-gated`, then, in parentheses, the environment or process that gates it. The value is
// fixed so a reader can't mistake another word for the opt-in; the parentheses say where the
// human gate is, so the claim can be checked by a person. A bullet outside `## Choices`, in
// another shape, written twice, with nothing in the parentheses or longer than `MAX_LENGTH`
// there throws `DeclarationError` naming the file and the line.
//
// OMITTED, IT IS KANON'S DEFAULT: not declared, so every escalation path escalates, exactly as
// before (plan 0005 §5.2). The Merger names that default in one line on every sweep.
//
// WHERE IT IS READ FROM. The Merger reads it from the repository's default branch
// (`readProductionPromotionAt`), like the escalation file (`K-MERGE-17`): a PR that adds the
// bullet is judged without it, and the record is directly inside `docs/qa/`, so that PR
// escalates whatever the record says. `lane-check` reads the checked-out tree, so a pull request
// that breaks the bullet fails on that pull request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, linesOf } from './declarations.mjs';
import { ADOPTION_RECORD, CHOICES_HEADING } from './reference-deploy.mjs';

/** The bullet's bold label. */
export const LABEL = 'Production promotion';

/** The one value it takes, before the parentheses. */
export const VALUE = 'human-gated';

/** The longest description of the gate: a name and a process, not an essay. */
export const MAX_LENGTH = 200;

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

/** Any line that starts, as Markdown reads it, with the label: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${LABEL}:\\*\\*`);

/** The one shape the bullet is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*${LABEL}:\\*\\* ${VALUE} \\((.*)\\)\\s*$`);

const EXAMPLE = `- **${LABEL}:** ${VALUE} (the \`production\` environment's required reviewer)`;

/**
 * Parses the declaration out of an adoption record. Returns what gates the promotion, as the
 * parentheses say it, or `null` when the record doesn't declare one, and throws
 * `DeclarationError` naming the line of a malformed one.
 * @param {string} text the adoption record's markdown
 * @returns {string | null}
 */
export function parseProductionPromotion(text) {
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
    throw fail(`${ADOPTION_RECORD}:${line} declares the production promotion outside \`${CHOICES_HEADING}\`: write the bullet under that heading`);
  }
  const entry = ENTRY.exec(/** @type {string} */ (lines[at]));
  if (!entry) {
    throw fail(`${ADOPTION_RECORD}:${line}, under \`${CHOICES_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, \`${VALUE}\`, then in parentheses what gates it, as in: ${EXAMPLE}. Remove the bullet for Kanon's default, where every escalation path escalates`);
  }
  const gate = /** @type {string} */ (entry[1]).trim();
  if (!gate) throw fail(`${ADOPTION_RECORD}:${line}: \`${LABEL}\` names nothing in its parentheses: say which environment or process holds the human approval`);
  if (gate.length > MAX_LENGTH) {
    throw fail(`${ADOPTION_RECORD}:${line}: what gates \`${LABEL}\` is ${gate.length} characters; name it in at most ${MAX_LENGTH}`);
  }
  return gate;
}

/**
 * Reads the declaration from a checked-out tree, for `lane-check`. A missing record declares
 * nothing; a malformed one throws.
 * @param {string} [root] the repository root
 * @returns {string | null}
 */
export function readProductionPromotion(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseProductionPromotion(text);
}

/**
 * Reads the declaration from the repository's default branch, for the Merger (`K-MERGE-17`).
 * `readFile` returns the record's text at a ref, or `null` when it doesn't exist there, and
 * throws on any other failure, which this rethrows by name: a sweep must not read a record it
 * couldn't fetch as "not declared", or as declared.
 * @param {string} defaultBranch
 * @param {(path: string, ref: string) => string | null} readFile
 * @returns {{ gate: string | null, defaults: string[] }} `defaults`: the line naming Kanon's
 *   default, when the record doesn't declare it
 */
export function readProductionPromotionAt(defaultBranch, readFile) {
  if (!defaultBranch) throw fail(`no default branch to read ${ADOPTION_RECORD} from (K-MERGE-17)`);
  let text;
  try {
    text = readFile(ADOPTION_RECORD, defaultBranch);
  } catch (e) {
    throw fail(`${ADOPTION_RECORD} couldn't be read from \`${defaultBranch}\`: ${/** @type {Error} */ (e).message}`);
  }
  const gate = text === null ? null : parseProductionPromotion(text);
  if (gate !== null) return { gate, defaults: [] };
  const why = text === null ? "doesn't exist" : `declares no \`${LABEL}\``;
  return {
    gate: null,
    defaults: [`${ADOPTION_RECORD} on \`${defaultBranch}\` ${why}, so Kanon's default applies: the production promotion isn't declared human-gated, and every escalation path escalates (K-MERGE-4)`],
  };
}
