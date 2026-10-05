// The exemptions file, `docs/qa/exemptions.md` (`K-LAYOUT-15`): what a guard exempts by name
// on this repository, each entry with its reason (kanon#54).
//
// WHY A FILE THE ADOPTER OWNS. Two guards exempted the reference adopter's own files by name,
// in the library: the brief guard its six briefs written before the brief standard, and the
// doc-path guard seven mentions of paths that don't exist on purpose. On any other repository
// the first list meant nothing and the second failed every run with "stale exemption". Which
// files are exempt is the project's content; where it is written, and in what shape, is
// Kanon's (ADR 0002).
//
// TWO FIXED HEADINGS, each optional:
//
//   ## Pre-standard briefs
//   - `docs/projects/12.md` — approved before the brief standard; an immutable record
//
//   ## Path mentions
//   | File | Path | Reason |
//   |---|---|---|
//   | `docs/history.md` | `docs/TODO.md` | names the retired TODO file, as history |
//
// Prose may sit around the entries. A section with no entries says there are none. A heading
// that appears twice, a bullet or a table row that isn't an entry, and an entry listed twice
// each throw `DeclarationError`, whose message names the file and the line.
//
// AN OMITTED FILE OR SECTION IS KANON'S DEFAULT (plan 0005 §5.2): nothing is exempt there. The
// result's `defaults` names each default it took, and both guards print those lines.
//
// WHERE IT IS READ FROM. Both guards run as checks on a pull request and read the checked-out
// tree. The file is directly inside `docs/qa/`, so a pull request that adds an exemption for
// itself escalates to a human (`K-MERGE-4`), and that human reviews the entry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, LIST_ITEM, bulletsOf, linesOf, optionalSectionOf } from './declarations.mjs';

/** The file's fixed path (`K-LAYOUT-1`, `K-LAYOUT-15`). */
export const EXEMPTIONS_FILE = 'docs/qa/exemptions.md';

export const BRIEFS_HEADING = '## Pre-standard briefs';
export const MENTIONS_HEADING = '## Path mentions';

/** The path-mentions table's header row, exactly. */
const MENTIONS_HEADER = ['File', 'Path', 'Reason'];

export { DeclarationError };

/** @type {import('./declarations.mjs').Declaration} */
const FILE = { file: EXEMPTIONS_FILE, rule: 'K-LAYOUT-15' };

/**
 * @typedef {{ brief: string, reason: string, line: number }} BriefExemption
 * @typedef {{ file: string, path: string, reason: string, line: number }} MentionExemption
 * @typedef {{ briefs: BriefExemption[], mentions: MentionExemption[], defaults: string[] }} Exemptions
 *   `defaults`: one line per omitted file or section, naming the default it means
 */

/** What a repository without the file declares: Kanon's default, nothing exempt (plan 0005 §5.2). @returns {Exemptions} */
export const defaultExemptions = () => ({
  briefs: [],
  mentions: [],
  defaults: [`${EXEMPTIONS_FILE} doesn't exist, so Kanon's default applies: nothing is exempt (K-LAYOUT-15)`],
});

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-15)`);

/** A single code span, and nothing else. @param {string} cell */
const span = (cell) => /^`([^`]+)`$/.exec(cell.trim())?.[1] ?? null;

/**
 * The pre-standard briefs: one bullet each, the brief's path in backticks, an em dash, then
 * the reason.
 * @param {{ line: number, text: string }[]} body
 * @returns {BriefExemption[]}
 */
function briefs(body) {
  return bulletsOf(FILE, body, BRIEFS_HEADING).map(({ line, text }) => {
    const entry = /^`(docs\/projects\/\d+\.md)`\s+—\s+(\S.*)$/.exec(text);
    if (!entry) {
      throw fail(`${EXEMPTIONS_FILE}:${line}, under \`${BRIEFS_HEADING}\`, isn't an entry: write the brief's path (\`docs/projects/<n>.md\`) in backticks, an em dash, then the reason`);
    }
    return { brief: /** @type {string} */ (entry[1]), reason: /** @type {string} */ (entry[2]).trim(), line };
  });
}

/**
 * The path mentions: one table, with the header `| File | Path | Reason |`, a file and a path
 * in backticks, and a reason, in every row.
 * @param {{ line: number, text: string }[]} body
 * @returns {MentionExemption[]}
 */
function mentions(body) {
  // A list item here is an entry in the wrong shape, never prose: entries are table rows.
  const item = body.find(({ text }) => LIST_ITEM.test(text));
  if (item) throw fail(`${EXEMPTIONS_FILE}:${item.line}, under \`${MENTIONS_HEADING}\`, is a list item: each mention is a row of the \`| File | Path | Reason |\` table`);
  const rows = body.filter(({ text }) => /^\s*\|/.test(text));
  if (rows.length === 0) return [];
  const cells = (/** @type {string} */ text) => text.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [header, rule, ...entries] = rows;
  if (!header || cells(header.text).join('|') !== MENTIONS_HEADER.join('|')) {
    throw fail(`${EXEMPTIONS_FILE}:${header?.line}, under \`${MENTIONS_HEADING}\`, isn't the table's header: write \`| File | Path | Reason |\``);
  }
  if (!rule || !cells(rule.text).every((c) => /^:?-{3,}:?$/.test(c)) || cells(rule.text).length !== 3) {
    throw fail(`${EXEMPTIONS_FILE}:${rule?.line ?? header.line}, under \`${MENTIONS_HEADING}\`: the header needs a \`|---|---|---|\` row under it`);
  }
  return entries.map(({ line, text }) => {
    const c = cells(text);
    const file = c.length === 3 ? span(/** @type {string} */ (c[0])) : null;
    const path = c.length === 3 ? span(/** @type {string} */ (c[1])) : null;
    const reason = c[2] ?? '';
    if (!file || !path || reason === '') {
      throw fail(`${EXEMPTIONS_FILE}:${line}, under \`${MENTIONS_HEADING}\`, isn't an entry: write the citing file and the cited path in backticks, then the reason`);
    }
    return { file, path, reason, line };
  });
}

/**
 * Parses the exemptions file. Throws `DeclarationError` naming the file and the line of the
 * first thing it can't read.
 * @param {string} text
 * @returns {Exemptions}
 */
export function parseExemptions(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) throw fail(`${EXEMPTIONS_FILE}:${fenced.unclosed + 1} opens a code fence that never closes`);
  /** @type {string[]} */
  const defaults = [];
  /** @param {string} heading @param {string} what */
  const section = (heading, what) => {
    const body = optionalSectionOf(FILE, lines, fenced, heading);
    if (body === null) defaults.push(`${EXEMPTIONS_FILE} has no \`${heading}\` heading, so Kanon's default applies: no ${what} is exempt (K-LAYOUT-15)`);
    return body ?? [];
  };
  const out = { briefs: briefs(section(BRIEFS_HEADING, 'brief')), mentions: mentions(section(MENTIONS_HEADING, 'path mention')), defaults };
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const e of [...out.briefs.map((b) => ({ key: b.brief, line: b.line })), ...out.mentions.map((m) => ({ key: `${m.file} → ${m.path}`, line: m.line }))]) {
    const first = seen.get(e.key);
    if (first !== undefined) throw fail(`${EXEMPTIONS_FILE}:${e.line} repeats the entry on line ${first} (${e.key})`);
    seen.set(e.key, e.line);
  }
  return out;
}

/**
 * Reads and parses the exemptions file from a checked-out tree. No file is Kanon's default.
 * @param {string} [root] the repository root
 * @returns {Exemptions}
 */
export function readExemptions(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, EXEMPTIONS_FILE), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return defaultExemptions();
    throw fail(`${EXEMPTIONS_FILE} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseExemptions(text);
}
