// The reference environment's deploy, declared in the adoption record, `docs/qa/adoption.md`
// (`K-LAYOUT-10`, `K-PROJ-11`; plan 0004 step P6, kanon#54).
//
// WHY A DECLARATION. A project is done when its merges are deployed to the reference environment
// (`K-PROJ-11`), and the reconciler confirms that by the deploy job itself, not by the
// workflow's conclusion. It used to find that job in the library, as one adopter's literals: the
// workflow `deploy-staging.yml`, and any job whose name contained `deploy`. On any other
// repository no run was ever found, so no project could close. Which workflow deploys there, and
// which job's success is the deploy, is the project's content; where it is written, and in what
// shape, is Kanon's (ADR 0002).
//
// THREE BULLETS UNDER `## Choices`, beside the record's other choices:
//
//   ## Choices
//   - **Reference environment:** `staging`
//   - **Reference deploy workflow:** `deploy-staging.yml`
//   - **Reference deploy job:** `deploy`
//
// The environment is the name the project gives it. The workflow is a file name in
// `.github/workflows/`. The job is the job's name exactly as a run lists it: its `name:`, or its
// key when it has none. Each value is one code span and nothing else on its line.
//
// ALL THREE, OR NONE. A record with none of the three declares no reference environment, which
// is valid (Kanon's own record is one), and then no project can close (`K-PROJ-11`): the
// reconciler fails, by name, when it reaches a project's deploy phase. A record with some of
// them, any of them twice, one written in another shape or outside `## Choices`, or a value that
// isn't one, throws `DeclarationError` naming the file and the line.
//
// WHERE IT IS READ FROM. The reconciler decides whether a project closes, so it reads the record
// from the repository's default branch (`readReferenceDeployFrom`), as the Merger reads the
// escalation file (`K-MERGE-17`). `lane-check` reads the checked-out tree, so a pull request that
// breaks the declaration fails on that pull request. The record is directly inside `docs/qa/`,
// so a pull request that edits it escalates to a human (`K-MERGE-4`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, defaultBranchFile, linesOf } from './declarations.mjs';

/** The adoption record's fixed path (`K-LAYOUT-1`, `K-LAYOUT-10`). */
export const ADOPTION_RECORD = 'docs/qa/adoption.md';

/** The section the declaration sits in. */
export const CHOICES_HEADING = '## Choices';

/** Each field's bold label, as written in the record. */
export const LABELS = /** @type {const} */ ({
  environment: 'Reference environment',
  workflow: 'Reference deploy workflow',
  job: 'Reference deploy job',
});

export { DeclarationError };

/**
 * @typedef {{ environment: string, workflow: string, job: string }} ReferenceDeploy
 */

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

const FIELDS = /** @type {Array<keyof typeof LABELS>} */ (Object.keys(LABELS));
const LABEL_TEXT = FIELDS.map((f) => LABELS[f]).join('|');

/** Any line that starts, as Markdown reads it, with one of the labels: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*(${LABEL_TEXT}):\\*\\*`);

/** The one shape a field is written in. */
const ENTRY = new RegExp(`^[-*] \\*\\*(${LABEL_TEXT}):\\*\\* \`([^\`]+)\`\\s*$`);

/** A workflow file name: no directory, a `.yml` or `.yaml` extension. */
const WORKFLOW = /^[A-Za-z0-9._-]+\.ya?ml$/;

/** The example the messages give. */
const EXAMPLE = `- **${LABELS.environment}:** \`staging\``;

/**
 * Parses the reference-deploy declaration out of an adoption record. Returns `null` when the
 * record declares no reference environment, and throws `DeclarationError` naming the line of
 * the first thing it can't read.
 * @param {string} text the adoption record's markdown
 * @returns {ReferenceDeploy | null}
 */
export function parseReferenceDeploy(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) throw fail(`${ADOPTION_RECORD}:${fenced.unclosed + 1} opens a code fence that never closes`);

  const mentions = lines.flatMap((l, i) => (!fenced.has(i) && MENTION.test(l) ? [i] : []));
  if (mentions.length === 0) return null;

  // The `## Choices` section's line range, outside fenced blocks.
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

  /** @type {Partial<Record<keyof typeof LABELS, { value: string, line: number }>>} */
  const found = {};
  for (const i of mentions) {
    const line = i + 1;
    if (i < start || i >= end || start === -1) {
      throw fail(`${ADOPTION_RECORD}:${line} declares the reference environment's deploy outside \`${CHOICES_HEADING}\`: write the three bullets under that heading`);
    }
    const entry = ENTRY.exec(/** @type {string} */ (lines[i]));
    if (!entry) {
      throw fail(`${ADOPTION_RECORD}:${line}, under \`${CHOICES_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, then the value as one code span and nothing after it, as in: ${EXAMPLE}`);
    }
    const field = /** @type {keyof typeof LABELS} */ (FIELDS.find((f) => LABELS[f] === entry[1]));
    const value = /** @type {string} */ (entry[2]);
    const first = found[field];
    if (first) throw fail(`${ADOPTION_RECORD}:${line} repeats \`${LABELS[field]}\`, already declared on line ${first.line}`);
    if (value.trim() !== value) {
      throw fail(`${ADOPTION_RECORD}:${line}: \`${LABELS[field]}\` has spaces around its value`);
    }
    if (field === 'workflow' && !WORKFLOW.test(value)) {
      throw fail(`${ADOPTION_RECORD}:${line}: \`${value}\` isn't a workflow file name: write the file's name in \`.github/workflows/\`, such as \`deploy.yml\`, with no directory`);
    }
    found[field] = { value, line };
  }

  const missing = FIELDS.filter((f) => !found[f]);
  if (missing.length) {
    throw fail(`${ADOPTION_RECORD} declares the reference environment's deploy without ${missing.map((f) => `\`${LABELS[f]}\``).join(' and ')}: declare all three, or none`);
  }
  return {
    environment: /** @type {{ value: string }} */ (found.environment).value,
    workflow: /** @type {{ value: string }} */ (found.workflow).value,
    job: /** @type {{ value: string }} */ (found.job).value,
  };
}

/**
 * The declaration a project needs to close (`K-PROJ-11`): throws when the record declares none.
 * @param {ReferenceDeploy | null} declared
 * @param {string} where where the record was read, for the message
 * @returns {ReferenceDeploy}
 */
export function requireReferenceDeploy(declared, where) {
  if (declared) return declared;
  throw new DeclarationError(
    `${ADOPTION_RECORD}${where} declares no reference environment, so no project can close (K-PROJ-11): add ${FIELDS.map((f) => `\`- **${LABELS[f]}:**\``).join(', ')} bullets under \`${CHOICES_HEADING}\` (K-LAYOUT-10)`,
  );
}

/**
 * Reads the declaration from a checked-out tree. A record that doesn't exist declares nothing,
 * so this returns `null` for it; a malformed one throws.
 * @param {string} [root] the repository root
 * @returns {ReferenceDeploy | null}
 */
export function readReferenceDeploy(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseReferenceDeploy(text);
}

/**
 * The declared reference environment's NAME, for a message, from the record on the default
 * branch: `null` when the record is missing, declares none, is malformed or can't be read. It
 * never throws, because only the deploy phase may fail on the record (`K-PROJ-11`): a project
 * whose issues are still open names the environment when it can, and says "the reference
 * environment" otherwise (kanon#219).
 * @param {string} repo `owner/name`
 * @param {(args: string[], opts?: object) => string} [run] `gh`, injected for tests
 * @returns {string | null}
 */
export function declaredEnvironmentFrom(repo, run) {
  try {
    return readReferenceDeployFrom(repo, run).environment;
  } catch {
    return null;
  }
}

/**
 * Reads the declaration from the repository's default branch, for the reconciler, which decides
 * whether a project closes. Throws `DeclarationError` when the record is missing there, declares
 * no reference environment, is malformed, or can't be read.
 * @param {string} repo `owner/name`
 * @param {(args: string[], opts?: object) => string} [run] `gh`, injected for tests
 * @returns {ReferenceDeploy}
 */
export function readReferenceDeployFrom(repo, run) {
  const { branch, read } = defaultBranchFile(repo, run);
  if (!branch) throw fail(`no default branch to read ${ADOPTION_RECORD} from`);
  let text;
  try {
    text = read(ADOPTION_RECORD);
  } catch (e) {
    throw fail(`${ADOPTION_RECORD} couldn't be read from \`${branch}\`: ${/** @type {Error} */ (e).message}`);
  }
  if (text === null) {
    throw new DeclarationError(
      `${ADOPTION_RECORD} doesn't exist on \`${branch}\`, so it declares no reference environment, and no project can close (K-PROJ-11, K-LAYOUT-10)`,
    );
  }
  return requireReferenceDeploy(parseReferenceDeploy(text), ` on \`${branch}\``);
}
