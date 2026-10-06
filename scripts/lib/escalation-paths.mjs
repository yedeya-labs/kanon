// The escalation file, `docs/qa/escalation-paths.md` (`K-LAYOUT-8`), read by the guards that
// need to know where the adopter's high-risk paths and its own pipeline code are (kanon#54).
//
// WHY A FILE THE ADOPTER OWNS. These used to be constants in the library, copied from the
// reference adopter: the Merger escalated `sst.config.ts`, `drizzle/` and `scripts/qa/` on every
// repository, the label guard scanned `scripts/qa/`, and `citation-shift` skipped it. Which
// paths are high-risk, and where a project keeps its own pipeline scripts, is the project's
// content; where it is written down, and in what shape, is Kanon's (ADR 0002).
//
// TWO FIXED HEADINGS, each optional:
//
//   ## Escalation paths
//   - `^migrations/` — database migrations
//   - `/^src/.*payments?/i` — payments
//
//   ## Pipeline code
//   - `scripts/pipeline/` — the project's own pipeline scripts
//
// An escalation path is a regular expression over repository-relative paths, in backticks,
// optionally written `/…/i` to match without regard to case. A pipeline-code entry is a
// repository-relative directory ending in `/`. Each bullet is followed by an em dash and the
// reason. Prose between the bullets is allowed. A list item that isn't an entry is not: an
// indented, `+` or numbered item, or a bullet that doesn't parse, would otherwise be read as
// prose and its path silently dropped, which for the Merger is a PR merged with no human.
// Neither is a heading that appears twice. CRLF line endings read as LF. A section with no
// bullets is a declaration that the project has none.
//
// AN OMITTED FILE OR SECTION IS KANON'S DEFAULT (plan 0005 §5.2): no file, or no heading, means
// the project declares no paths of its own there, so only the pipeline's own paths escalate.
// The result's `defaults` names each default it took, in one line, and every reader prints
// those lines, so a repository that relies on the default is told so on every run.
//
// THE PIPELINE'S OWN PATHS ARE KANON'S, NOT THE FILE'S (`K-MERGE-4`). Every file under
// `.github/`, every markdown file directly inside `docs/qa/`, `AGENTS.md`, `CLAUDE.md` and every
// file under `.claude/` escalates whatever the file says, and so does every pipeline-code
// directory it declares. An adopter whose production promotion is human-gated may declare so in
// its adoption record (kanon#158), and then only its high-risk paths stop escalating on their own
// (`escalatingPaths`, below); none of these do.
//
// FAILS BY NAME. Every reader throws `DeclarationError`, whose message names the file and,
// for a malformed entry, the line, so a guard that can't read the declaration fails saying
// which declaration and why, rather than running on an empty one.
//
// WHERE IT IS READ FROM. A guard that runs as a CI check reads the checked-out tree: the
// file is directly inside `docs/qa/`, so a pull request that edits it escalates to a human
// (`K-MERGE-4`). The Merger's verdict judges a pull request, so it reads the file from the
// repository's default branch (`K-MERGE-17`), never from the pull request or its base.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, bulletsOf, linesOf, optionalSectionOf } from './declarations.mjs';

/** The file's fixed path (`K-LAYOUT-1`, `K-LAYOUT-8`). */
export const ESCALATION_FILE = 'docs/qa/escalation-paths.md';

/** The two headings this module reads, exactly as the file spells them. */
export const PATHS_HEADING = '## Escalation paths';
export const PIPELINE_HEADING = '## Pipeline code';

/**
 * The pipeline's own paths, which escalate on every repository whatever the file says
 * (`K-MERGE-4`): every workflow and every other file under `.github/`, the pipeline documents
 * directly inside `docs/qa/`, and the agent instructions and agent configuration every lane
 * reads, `AGENTS.md`, `CLAUDE.md` and `.claude/` (`K-LAYOUT-9`, kanon#138). Together they cover
 * every path row of `K-MERGE-17`'s judging-inputs table (`scripts/judging-inputs.mjs`), and a
 * parity test fails if a row is added that none of them escalates. The table's last row, the
 * documents those inputs link to, is deliberately not escalated (`K-MERGE-4`, kanon#150): on
 * the reference adopter it is the project's ordinary documentation, which feature changes
 * update. The parity test names it as the one exception. `docs/qa/specs/` is
 * deliberately not here: specs are the project's deliverable, reviewed against its brief.
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
export const PIPELINE_ESCALATIONS = Object.freeze([
  Object.freeze(/** @type {const} */ ([/^\.github\//, 'the CI and agent pipeline'])),
  Object.freeze(/** @type {const} */ ([/^docs\/qa\/[^/]+\.md$/, 'the pipeline documents, which are agent instructions'])),
  Object.freeze(/** @type {const} */ ([/^(?:AGENTS|CLAUDE)\.md$/, 'the agent instructions'])),
  Object.freeze(/** @type {const} */ ([/^\.claude\//, 'the agent configuration'])),
]);

export { DeclarationError };

/** @type {import('./declarations.mjs').Declaration} */
const FILE = { file: ESCALATION_FILE, rule: 'K-LAYOUT-8' };

/**
 * @typedef {{ pattern: RegExp, reason: string }} EscalationPath
 * @typedef {{ dir: string, reason: string }} PipelineDir
 * @typedef {{ paths: EscalationPath[], pipeline: PipelineDir[], defaults: string[] }} EscalationFile
 *   `defaults`: one line per omitted file or section, naming the default it means
 */

/** What an omitted declaration means, said once for every reader (plan 0005 §5.2). */
const PIPELINE_ONLY = 'only the pipeline\'s own paths escalate (`.github/`, `docs/qa/`, the agent instruction files)';

/**
 * The declaration a repository without the file makes: Kanon's default (plan 0005 §5.2).
 * @param {string} where the file and, for a default-branch read, where it was looked for
 * @returns {EscalationFile}
 */
export function defaultEscalationFile(where = ESCALATION_FILE) {
  return { paths: [], pipeline: [], defaults: [`${where} doesn't exist, so Kanon's default applies: ${PIPELINE_ONLY} (K-LAYOUT-8)`] };
}

/**
 * Prints the defaults a declaration took, one line each, prefixed with the reader's name.
 * @param {string} reader
 * @param {{ defaults?: string[] }} file
 * @param {(line: string) => void} [print]
 */
export function printDefaults(reader, file, print = (line) => console.error(line)) {
  for (const d of file.defaults ?? []) print(`${reader}: ${d}`);
}

const ENTRY = /^`([^`]+)`\s+—\s+(\S.*)$/;

/**
 * The bullets of a section, each split into its code span and its reason.
 * @param {import('./declarations.mjs').Line[]} body
 * @param {string} heading
 * @returns {{ line: number, value: string, reason: string }[]}
 */
function entries(body, heading) {
  return bulletsOf(FILE, body, heading).map(({ line, text }) => {
    const entry = ENTRY.exec(text);
    if (!entry) {
      throw new DeclarationError(
        `${ESCALATION_FILE}:${line}, under \`${heading}\`, isn't an entry: write a pattern in backticks, an em dash, then the reason (K-LAYOUT-8)`,
      );
    }
    return { line, value: /** @type {string} */ (entry[1]), reason: /** @type {string} */ (entry[2]).trim() };
  });
}

/**
 * One escalation pattern: a regular expression, or `/…/i` for one that ignores case.
 * @param {string} value
 * @param {number} line
 */
function pattern(value, line) {
  const literal = /^\/(.+)\/(i?)$/.exec(value);
  // A LEADING `/` IS ONLY EVER THE `/…/` FORM (#141). A repository-relative path never starts
  // with `/`, so `/terraform/main.tf` (CODEOWNERS style) or `/…/g` read as a pattern would
  // compile and match nothing, which for the Merger fails open.
  if (!literal && value.startsWith('/')) {
    throw new DeclarationError(
      `${ESCALATION_FILE}:${line}: \`${value}\` begins with \`/\` but isn't \`/…/\` or \`/…/i\`: patterns are over repository-relative paths, with no leading \`/\`, and \`i\` is the only flag (K-LAYOUT-8)`,
    );
  }
  const source = literal ? /** @type {string} */ (literal[1]) : value;
  try {
    return new RegExp(source, literal?.[2] ?? '');
  } catch (e) {
    throw new DeclarationError(`${ESCALATION_FILE}:${line}: \`${value}\` isn't a regular expression (${/** @type {Error} */ (e).message}) (K-LAYOUT-8)`);
  }
}

/**
 * One pipeline-code directory: repository-relative, ending in `/`, with no glob, no `..` and
 * no leading `/` or `./`, so it means one directory and only one.
 * @param {string} value
 * @param {number} line
 */
function directory(value, line) {
  const ok =
    value.endsWith('/') &&
    !/^\.?\//.test(value) &&
    !/[*?[\]{}\\\s]/.test(value) &&
    !value.split('/').some((part) => part === '..' || part === '.');
  if (!ok) {
    throw new DeclarationError(
      `${ESCALATION_FILE}:${line}: \`${value}\` isn't a pipeline-code directory: write a repository-relative directory ending in \`/\`, with no pattern characters (K-LAYOUT-8)`,
    );
  }
  return value;
}

/**
 * Parses the escalation file. Throws `DeclarationError` naming the file and line of the first
 * thing it can't read.
 * @param {string} text
 * @returns {EscalationFile}
 */
export function parseEscalationFile(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) {
    throw new DeclarationError(`${ESCALATION_FILE}:${fenced.unclosed + 1} opens a code fence that never closes (K-LAYOUT-8)`);
  }
  /** @type {string[]} */
  const defaults = [];
  /** @param {string} heading @param {string} means */
  const section = (heading, means) => {
    const body = optionalSectionOf(FILE, lines, fenced, heading);
    if (body !== null) return entries(body, heading);
    defaults.push(`${ESCALATION_FILE} has no \`${heading}\` heading, so Kanon's default applies: ${means} (K-LAYOUT-8)`);
    return [];
  };
  const paths = section(PATHS_HEADING, 'the project declares no high-risk paths').map(({ line, value, reason }) => ({
    pattern: pattern(value, line),
    reason,
  }));
  const pipeline = section(PIPELINE_HEADING, 'the project declares no pipeline code of its own').map(({ line, value, reason }) => ({
    dir: directory(value, line),
    reason,
  }));
  return { paths, pipeline, defaults };
}

/**
 * Reads and parses the escalation file from a checked-out tree. No file is Kanon's default.
 * @param {string} [root] the repository root
 * @returns {EscalationFile}
 */
export function readEscalationFile(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, ESCALATION_FILE), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return defaultEscalationFile();
    throw new DeclarationError(`${ESCALATION_FILE} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseEscalationFile(text);
}

/**
 * Reads and parses the escalation file from the repository's default branch, for a lane that
 * judges a pull request (`K-MERGE-17`). `readFile` returns the file's text at a ref, or `null`
 * when it doesn't exist there, which is Kanon's default, and throws on any other failure.
 * @param {string} defaultBranch
 * @param {(path: string, ref: string) => string | null} readFile
 * @returns {EscalationFile}
 */
export function readEscalationFileAt(defaultBranch, readFile) {
  if (!defaultBranch) throw new DeclarationError(`no default branch to read ${ESCALATION_FILE} from (K-MERGE-17)`);
  let text;
  try {
    text = readFile(ESCALATION_FILE, defaultBranch);
  } catch (e) {
    throw new DeclarationError(`${ESCALATION_FILE} couldn't be read from \`${defaultBranch}\`: ${/** @type {Error} */ (e).message}`);
  }
  if (text === null) return defaultEscalationFile(`${ESCALATION_FILE} on \`${defaultBranch}\``);
  return parseEscalationFile(text);
}

/** Escapes a directory for use inside a regular expression. @param {string} s */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Every path that escalates, as `[pattern, reason]` pairs: the pipeline's own paths, then the
 * project's pipeline code, then its high-risk paths.
 *
 * A HUMAN-GATED PRODUCTION PROMOTION (`K-MERGE-4`, kanon#158). When the adoption record on the
 * default branch declares one, `promotion` is given, and the project's high-risk paths
 * (`## Escalation paths`) are no longer escalation paths: the human gate is the promotion,
 * which every deploy of them still waits for. Everything that decides how a PR is judged, or
 * whether the promotion is gated at all, still escalates, because a PR must never be able to
 * change its own rules:
 *   · the pipeline's own paths (`PIPELINE_ESCALATIONS`): every file under `.github/` (the
 *     workflows that run Kanon's lanes and pin its release, the project-setup hook, and the
 *     deploy workflow whose environment holds the human gate), every markdown file directly
 *     inside `docs/qa/` (the adoption record that makes this declaration, the escalation file,
 *     the identity register, the sign-off delegation and the playbooks), and the agent
 *     instructions and configuration (`AGENTS.md`, `CLAUDE.md`, `.claude/`);
 *   · the project's own pipeline code (`## Pipeline code`), the scripts its lanes run, and
 *     anything else outside `.github/` that keeps the promotion gated, which the project must
 *     list there to keep (kanon#344);
 *   · a declared high-risk path that is also a judging input on the default branch
 *     (`K-MERGE-17`'s delegation row): a document the instructions link to, which a project
 *     declared because it wanted a human to approve changes to it. `judgingInputs` is that
 *     set, read from the default branch, and only its files a declared path matches escalate,
 *     each as one exact path, so the declaration never relaxes a judging input.
 * The project briefs, the escalating labels and a spec promotion (`K-SPEC-9`) are the verdict's
 * own rules, and this changes none of them.
 * @param {EscalationFile} file
 * @param {{ judgingInputs: readonly string[] } | null} [promotion] `null`, or omitted, when the
 *   record declares no human-gated promotion: Kanon's default
 * @returns {Array<readonly [RegExp, string]>}
 */
export function escalatingPaths(file, promotion = null) {
  const own = [
    ...PIPELINE_ESCALATIONS,
    ...file.pipeline.map(({ dir, reason }) => /** @type {const} */ ([new RegExp(`^${escape(dir)}`), reason])),
  ];
  if (!promotion) return [...own, ...file.paths.map(({ pattern: re, reason }) => /** @type {const} */ ([re, reason]))];
  return [
    ...own,
    ...promotion.judgingInputs.flatMap((input) => {
      const hit = file.paths.find(({ pattern: re }) => re.test(input));
      return hit
        ? [/** @type {const} */ ([new RegExp(`^${escape(input)}$`), `${hit.reason}, and a judging input (K-MERGE-17), which a human-gated promotion never relaxes`])]
        : [];
    }),
  ];
}
