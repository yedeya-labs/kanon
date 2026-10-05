// What every adopter declaration file shares (kanon#54): the escalation file (`K-LAYOUT-8`)
// and the exemptions file (`K-LAYOUT-15`) are markdown with fixed `##` headings and entries
// in a fixed shape, and each reader must fail by name on anything it can't read.
//
// ONE COPY OF THE READING RULES. Each file's own module says what an entry is. This one
// decides what a line, a section and a list item are, because every place those rules
// differed between two readers was a shape one of them read as "no entry" without an error:
// a CRLF file, an indented, `+`, numbered or blockquoted list item. For a declaration that
// narrows a guard, "no entry" fails open.

import { execFileSync } from 'node:child_process';

/** A missing or malformed declaration file. Its message names the file, and the line. */
export class DeclarationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DeclarationError';
  }
}

/** The file's lines. CRLF reads as LF, so a file saved on Windows means what it says. @param {string} text */
export const linesOf = (text) => text.split(/\r?\n/);

/** An entry bullet: `- ` or `* ` at the start of the line. */
const BULLET = /^[-*]\s+(.*)$/;

/** Anything Markdown reads as a list item: indented, `-`, `*`, `+`, numbered, or inside a blockquote. */
export const LIST_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s/;

/**
 * @typedef {{ file: string, rule: string }} Declaration the file's path and the rule that fixes its shape
 * @typedef {{ line: number, text: string }} Line a line and its 1-based number
 */

/**
 * The body lines of one `##` section, outside fenced blocks. Throws when the heading is missing
 * or appears more than once outside a fenced block. The section ends at the next `#` or `##`.
 * @param {Declaration} d
 * @param {string[]} lines
 * @param {Set<number>} fenced
 * @param {string} heading
 * @returns {Line[]}
 */
export function sectionOf(d, lines, fenced, heading) {
  const body = optionalSectionOf(d, lines, fenced, heading);
  if (body === null) throw new DeclarationError(`${d.file} has no \`${heading}\` heading (${d.rule})`);
  return body;
}

/**
 * The body lines of one `##` section, or `null` when the heading is missing: a section the
 * file may leave out, which then means its documented default (plan 0005 §5.2). A heading
 * written more than once still throws: that is a malformed section, not an omitted one.
 * @param {Declaration} d
 * @param {string[]} lines
 * @param {Set<number>} fenced
 * @param {string} heading
 * @returns {Line[] | null}
 */
export function optionalSectionOf(d, lines, fenced, heading) {
  const at = lines.flatMap((l, i) => (!fenced.has(i) && l.trimEnd() === heading ? [i] : []));
  if (at.length === 0) return null;
  if (at.length > 1) {
    throw new DeclarationError(`${d.file} has the \`${heading}\` heading ${at.length} times, on lines ${at.map((i) => i + 1).join(', ')} (${d.rule})`);
  }
  /** @type {Line[]} */
  const out = [];
  for (let i = /** @type {number} */ (at[0]) + 1; i < lines.length; i += 1) {
    const text = /** @type {string} */ (lines[i]);
    if (!fenced.has(i) && /^#{1,2}\s/.test(text)) break;
    if (!fenced.has(i)) out.push({ line: i + 1, text });
  }
  return out;
}

/**
 * The entry bullets of a section, each as the text after its `- `. Any other list item throws,
 * naming the line, rather than being read as prose; prose that isn't a list item is skipped.
 * @param {Declaration} d
 * @param {Line[]} body
 * @param {string} heading
 * @returns {Line[]}
 */
export function bulletsOf(d, body, heading) {
  return body.flatMap(({ line, text }) => {
    const bullet = BULLET.exec(text);
    if (bullet) return [{ line, text: /** @type {string} */ (bullet[1]).trim() }];
    if (!LIST_ITEM.test(text)) return [];
    throw new DeclarationError(
      `${d.file}:${line}, under \`${heading}\`, is a list item the file doesn't use: write each entry as \`- \` at the start of the line (${d.rule})`,
    );
  });
}

/** `gh`, as every default-branch read runs it. @param {string[]} args @param {object} [opts] */
const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', ...opts });

/**
 * A reader for files on the repository's default branch, for a lane that judges, or decides,
 * from a declaration a pull request mustn't choose (`K-MERGE-17`). `read` returns the file's
 * text, or `null` when it doesn't exist there (a 404 on the contents read), and throws on any
 * other failure. `branch` is empty when the repository names none; the caller fails on that by
 * name. `run` is `gh`, injected so the reader is testable.
 * @param {string} repo `owner/name`
 * @param {(args: string[], opts?: object) => string} [run]
 * @returns {{ branch: string, read: (path: string) => string | null }}
 */
export function defaultBranchFile(repo, run = gh) {
  const branch = run(['api', `repos/${repo}`, '--jq', '.default_branch']).trim();
  return {
    branch,
    read: (path) => {
      try {
        return run(['api', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, '-H', 'Accept: application/vnd.github.raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const err = /** @type {{ stderr?: unknown, message?: string }} */ (e);
        if (/\b404\b|Not Found/.test(String(err?.stderr ?? ''))) return null;
        throw new Error(String(err?.stderr || err?.message || e).trim());
      }
    },
  };
}
