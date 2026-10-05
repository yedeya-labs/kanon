// The project's code areas, as its stack document declares them under `## Code areas`
// (`K-LAYOUT-17`; plan 0004 step 11, decision 6; kanon#54).
//
// WHY A DECLARATION. Three guards used to carry the reference adopter's tree as constants:
// `citation-shift` read code comments under `src/`, `e2e/`, `tests/`, `scripts/` and
// `.github/scripts/`; `doc-path-guard` skipped `tests/` and `e2e/` as fixtures; and the spec-id
// reference corpus walked `src/`, `e2e/`, `tests/` and `docs/`. The code audit's prompt named
// the same project's source directories as what to read. Where a project keeps its code and its
// tests is the project's content; where it is written down, and in what shape, is Kanon's
// (ADR 0002).
//
// ONE OPTIONAL SECTION OF THE STACK DOCUMENT, one bullet per area: a repository-relative path
// in backticks, an em dash, the area's kind, a colon, and what it holds:
//
//   ## Code areas
//   - `src/` — code: the application
//   - `scripts/` — code: build and release scripts
//   - `tests/` — tests: unit and integration tests
//   - `e2e/` — tests: the browser suite
//   - `src/server/services/` — audit: the service layer, where tenant scope and authorisation live
//
//   code    a tree of the project's own source. `citation-shift` reads its comments, and the
//           spec-id reference corpus walks it.
//   tests   a tree of tests, and of the fixtures they read. `doc-path-guard` doesn't hold its
//           files to rule 2, the spec-id sweeps don't count a tooling test in it, and the
//           corpus walks it.
//   audit   what the code audit reads first, in order: a directory ending in `/`, or a file.
//           The description is what the audit looks for there.
//
// A `code` or `tests` path is a directory, ending in `/`. No path holds a glob, `..`, `.` or a
// leading `/`, so each means one place. Prose between the bullets is allowed. A list item that
// isn't an entry, an unknown kind, a path written twice under one kind, or the heading written
// twice throws `DeclarationError` naming the file and the line, because a declaration a guard
// read as "no entry" would fail open.
//
// UNDECLARED, A GUARD READS MORE, NEVER LESS. A project with no `## Code areas`, or with no
// bullet of a kind, gets Kanon's rule for that kind:
//   code    the whole repository, which to all three of its readers is what git tracks
//           (kanon#266): every tracked file `citation-shift` can read comments in, and every
//           tracked file the corpus can read;
//   tests   what the file's language convention calls a test (`K-SPEC-6`,
//           `scripts/lib/test-conventions.mjs`), file by file;
//   audit   the declared `code` trees, or the whole repository when none is declared.
// A tree a guard should have read and didn't is the silent failure (kanon#180 was one), and
// one it read and shouldn't have is a finding the project answers by declaring its trees. So
// the default errs towards reading. It names no directory, so it holds on every stack.
//
// WHERE IT IS READ FROM. The guards read the checked-out tree (or the commit `citation-shift
// --head` names), as they read the escalation file. The code-audit lane reads its checkout of
// the default branch, which is what a scheduled run checks out.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, bulletsOf, linesOf } from './declarations.mjs';
import { isTestFile } from './test-conventions.mjs';

/** The stack document's fixed path (`K-LAYOUT-17`). */
export const STACK_FILE = 'docs/qa/stack.md';

/** The section this module reads, exactly as the document spells it. */
export const CODE_AREAS_HEADING = '## Code areas';

/** The kinds an area can be. */
export const KINDS = /** @type {const} */ (['code', 'tests', 'audit']);

/** @type {import('./declarations.mjs').Declaration} */
const FILE = { file: STACK_FILE, rule: 'K-LAYOUT-17' };

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-17)`);

const ENTRY = /^`([^`]+)`\s+—\s+([a-z]+):\s+(\S.*)$/;

const EXAMPLE = '- `src/` — code: the application';

/**
 * @typedef {{ path: string, what: string }} Area
 * @typedef {{ declared: boolean, code: Area[], tests: Area[], audit: Area[] }} CodeAreas
 *   `declared` is whether the section exists; a kind with no bullets is undeclared.
 */

/** No section at all: every kind takes Kanon's rule. @type {CodeAreas} */
export const UNDECLARED = Object.freeze({ declared: false, code: [], tests: [], audit: [] });

/**
 * One path: repository-relative, with no glob, `..`, `.` or leading `/`. A `code` or `tests`
 * path is a directory, ending in `/`.
 * @param {string} value
 * @param {string} kind
 * @param {number} line
 */
function checkPath(value, kind, line) {
  const ok =
    !/^\.?\//.test(value) &&
    !/[*?[\]{}\\\s]/.test(value) &&
    !value.replace(/\/$/, '').split('/').some((part) => part === '..' || part === '.' || part === '');
  if (!ok) {
    throw fail(`${STACK_FILE}:${line}: \`${value}\` isn't a repository-relative path: write it with no leading \`/\` or \`./\`, no \`..\` and no pattern characters`);
  }
  if (kind !== 'audit' && !value.endsWith('/')) {
    throw fail(`${STACK_FILE}:${line}: a \`${kind}\` area is a directory, so write \`${value}/\``);
  }
  return value;
}

/**
 * The body lines of `## Code areas`, or null when the document has no such heading. Throws when
 * the heading appears more than once outside a fenced block.
 * @param {string[]} lines
 * @param {Set<number> & { unclosed?: number }} fenced
 */
function sectionBody(lines, fenced) {
  const at = lines.flatMap((l, i) => (!fenced.has(i) && l.trimEnd() === CODE_AREAS_HEADING ? [i] : []));
  if (at.length === 0) return null;
  if (at.length > 1) throw fail(`${STACK_FILE} has the \`${CODE_AREAS_HEADING}\` heading ${at.length} times, on lines ${at.map((i) => i + 1).join(', ')}`);
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  for (let i = /** @type {number} */ (at[0]) + 1; i < lines.length; i += 1) {
    const text = /** @type {string} */ (lines[i]);
    if (!fenced.has(i) && /^#{1,2}\s/.test(text)) break;
    if (!fenced.has(i)) out.push({ line: i + 1, text });
  }
  return out;
}

/**
 * Parses the stack document's `## Code areas`. Returns `UNDECLARED` when the document has no such
 * section, and throws `DeclarationError` naming the line of anything it can't read.
 * @param {string} text the stack document's markdown
 * @returns {CodeAreas}
 */
export function parseCodeAreas(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) throw fail(`${STACK_FILE}:${fenced.unclosed + 1} opens a code fence that never closes`);
  const body = sectionBody(lines, fenced);
  if (body === null) return UNDECLARED;
  /** @type {CodeAreas} */
  const areas = { declared: true, code: [], tests: [], audit: [] };
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const { line, text: entryText } of bulletsOf(FILE, body, CODE_AREAS_HEADING)) {
    const entry = ENTRY.exec(entryText);
    if (!entry) {
      throw fail(`${STACK_FILE}:${line}, under \`${CODE_AREAS_HEADING}\`, isn't an area: write a path in backticks, an em dash, its kind (${KINDS.join(', ')}), a colon and what it holds, as in: ${EXAMPLE}`);
    }
    const [, value, kind, what] = /** @type {[string, string, string, string]} */ (/** @type {unknown} */ (entry));
    if (!(/** @type {readonly string[]} */ (KINDS)).includes(kind)) {
      throw fail(`${STACK_FILE}:${line}: \`${kind}\` isn't a kind of code area; write one of ${KINDS.join(', ')}`);
    }
    const path = checkPath(value, kind, line);
    const key = `${kind} ${path}`;
    if (seen.has(key)) throw fail(`${STACK_FILE}:${line} declares the ${kind} area \`${path}\` again, already declared on line ${seen.get(key)}`);
    seen.set(key, line);
    areas[/** @type {'code'|'tests'|'audit'} */ (kind)].push({ path, what: what.trim() });
  }
  return areas;
}

/**
 * Reads the declaration from a checked-out tree. A missing stack document declares nothing (the
 * lanes that need one fail on it themselves, `K-LAYOUT-17`); a malformed section throws.
 * @param {string} [root] the repository root
 * @returns {CodeAreas}
 */
export function readCodeAreas(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, STACK_FILE), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return UNDECLARED;
    throw fail(`${STACK_FILE} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseCodeAreas(text);
}

/**
 * The default a reader took, as one line for its summary (plan 0005 §5.2): none when the stack
 * document declares its code areas, and otherwise the line that names Kanon's rule.
 * @param {CodeAreas} areas
 * @returns {string[]}
 */
export function codeAreasDefaults(areas) {
  if (areas.declared) return [];
  return [`${STACK_FILE} declares no \`${CODE_AREAS_HEADING}\`, so Kanon's default applies: the code is the whole repository, and a test is what its language's convention calls one (K-LAYOUT-17)`];
}

/**
 * The trees a `code` read covers: the declared `code` and `tests` trees, or `null` for the whole
 * repository when no `code` tree is declared. Tests are code too: their comments carry
 * coordinates, and they cite spec ids.
 * @param {CodeAreas} areas
 * @returns {string[] | null}
 */
export function codeTrees(areas) {
  if (areas.code.length === 0) return null;
  return [...areas.code, ...areas.tests].map((a) => a.path);
}

/**
 * Whether a repository-relative path is in the project's code, by `codeTrees`.
 * @param {string} path
 * @param {CodeAreas} areas
 */
export function isCodePath(path, areas) {
  const trees = codeTrees(areas);
  return trees === null || trees.some((t) => path.startsWith(t));
}

/**
 * Whether a repository-relative path is a test, or a fixture beside one: under a declared `tests`
 * tree, or, when none is declared, a test by its language's convention.
 * @param {string} path
 * @param {CodeAreas} areas
 */
export function isTestPath(path, areas) {
  if (areas.tests.length === 0) return isTestFile(path);
  return areas.tests.some((a) => path.startsWith(a.path));
}

/**
 * What the code audit reads: the declared `audit` areas, or the `code` trees when none is, or
 * the whole repository, as one line each for its prompt.
 * @param {CodeAreas} areas
 * @returns {{ source: 'audit' | 'code' | 'repository', lines: string[] }}
 */
export function auditAreas(areas) {
  if (areas.audit.length) return { source: 'audit', lines: areas.audit.map((a) => `- \`${a.path}\`: ${a.what}`) };
  if (areas.code.length) return { source: 'code', lines: areas.code.map((a) => `- \`${a.path}\`: ${a.what}`) };
  return { source: 'repository', lines: ['- the whole repository: this project declares no code areas, so read its source wherever it is'] };
}
