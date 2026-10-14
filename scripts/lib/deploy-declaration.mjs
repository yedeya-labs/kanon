// The deploy declaration: the adoption record's `## Deploy` section, `docs/qa/adoption.md`
// (`K-LAYOUT-10`, `K-PROJ-11`; plan 0010 §4, step D2). One parser, and every reader uses it: the
// reconciler (`K-PROJ-11`, from the default branch), `lane-check` and doctor (from the checkout),
// and, from plan 0010's later steps, the deploy lane's gate (from the release's commit) and
// `kanon init`.
//
//   ## Deploy
//   - **Environments:** `staging`, `production`
//   - **CI wait:** `90`
//   - **Reference environment:** `staging`
//   - **Reference deploy workflow:** `deploy.yml`
//   - **Reference deploy job:** `staging / deploy`
//   - **Fallback:** `no-reviewers`
//
// Each bullet is a `- ` at the start of its line, its bold label, and its value as one code span
// with nothing after it; the environments are code spans separated by `, `. Every bullet is
// optional.
//
// THE CHAIN (plan 0010 decision 2). The environments, in order, form a straight line: each deploys
// only after the one before it succeeded on the same release. The last is production; every other
// one is pre-production. No section, no `Environments` bullet, or one with no value, declares no
// environment, and then the repository has no deploy lane.
//
// THE CI WAIT (decision 9): how long the gate waits for the release commit's CI, in whole minutes
// from 1 to 360, a hosted job's limit. Absent, it is 90.
//
// THE REFERENCE DEPLOY (`K-PROJ-11`). A project is done when its merges are deployed to the
// reference environment, and the reconciler confirms it by the deploy job itself: the workflow's
// file name in `.github/workflows/`, and the job's name exactly as a run lists it. All three
// bullets, or none. It stands on its own: an adopter that deploys with its own workflow keeps a
// `## Deploy` section holding only these three, naming any environment, workflow and job. With an
// environment list, the reference environment must be one of the list.
//
// THE FALLBACK'S MARKER (plan 0010 §13): `no-environments` or `no-reviewers`, present only where
// the plan can't protect the chain; the record still states the fallback under `## Plan`.
//
// THE BULLETS MOVED AT ONCE (plan 0010, follow-up decision 1). The reference deploy's three
// bullets used to sit under `## Choices`. They are read from `## Deploy` only, with no period of
// reading both places: one left under `## Choices` throws, naming its line and the move, which
// the upgrade skill makes and doctor reports as `deploy.declaration-moved` (`movedReferenceBullets`).
//
// A list naming an environment twice, an empty code span, a wait outside 1 to 360, a reference
// environment not in a present list, some but not all of the reference bullets, a marker outside
// its two values, a bullet written twice or in another shape, or a deploy bullet outside
// `## Deploy` throws `DeclarationError` naming the file and the line. Outside the section, only a
// bullet in the declaration's shape counts as one: `## Plan`'s prose bullet
// `- **Environments:** no Kanon lane needs one.`, which `kanon init` writes, is prose.
//
// The record is directly inside `docs/qa/`, so a pull request that edits it escalates to a human
// (`K-MERGE-4`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedLines } from '../spec-lib.mjs';
import { DeclarationError, defaultBranchFile, LIST_ITEM, linesOf } from './declarations.mjs';

/** The adoption record's fixed path (`K-LAYOUT-1`, `K-LAYOUT-10`). */
export const ADOPTION_RECORD = 'docs/qa/adoption.md';

/** The section the record's other choices sit in, where the reference deploy used to. */
export const CHOICES_HEADING = '## Choices';

/** The section the deploy declaration sits in. */
export const DEPLOY_HEADING = '## Deploy';

/** The reference deploy's bold labels (`K-PROJ-11`). */
export const LABELS = /** @type {const} */ ({
  environment: 'Reference environment',
  workflow: 'Reference deploy workflow',
  job: 'Reference deploy job',
});

/** The chain's bold labels (plan 0010 §4). */
export const CHAIN_LABELS = /** @type {const} */ ({
  environments: 'Environments',
  ciWait: 'CI wait',
  fallback: 'Fallback',
});

/** The CI wait when the record declares none, and its bounds, in minutes (plan 0010 decision 9). */
export const DEFAULT_CI_WAIT = 90;
export const CI_WAIT_MIN = 1;
export const CI_WAIT_MAX = 360;

/** The fallback's two markers (plan 0010 §13). */
export const FALLBACKS = /** @type {const} */ (['no-environments', 'no-reviewers']);

/** An environment's role, from its position: the last is production (plan 0010 decision 11). */
export const ROLES = /** @type {const} */ ({ production: 'production', preProduction: 'pre-production' });

export { DeclarationError };

/**
 * @typedef {{ environment: string, workflow: string, job: string }} ReferenceDeploy
 * @typedef {{ environment: string, position: number, role: 'production' | 'pre-production' }} Link
 * @typedef {{
 *   environments: string[],
 *   chain: Link[],
 *   ciWait: number,
 *   reference: ReferenceDeploy | null,
 *   fallback: typeof FALLBACKS[number] | null,
 * }} DeployDeclaration
 */

/** @param {string} message */
const fail = (message) => new DeclarationError(`${message} (K-LAYOUT-10)`);

const REFERENCE_FIELDS = /** @type {Array<keyof typeof LABELS>} */ (Object.keys(LABELS));
const CHAIN_FIELDS = /** @type {Array<keyof typeof CHAIN_LABELS>} */ (Object.keys(CHAIN_LABELS));
/** @type {Record<string, string>} each label's field */
const FIELD_OF = Object.fromEntries([
  ...REFERENCE_FIELDS.map((f) => [LABELS[f], f]),
  ...CHAIN_FIELDS.map((f) => [CHAIN_LABELS[f], f]),
]);
/** @type {Set<string>} */
const REFERENCE_LABELS = new Set(Object.values(LABELS));
const LABEL_TEXT = Object.keys(FIELD_OF).join('|');

/** Any line that starts, as Markdown reads it, with one of the labels: the candidates. */
const MENTION = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*(${LABEL_TEXT}):\\*\\*(.*)$`);

/** The one shape a bullet is written in: its value is checked by its field. */
const ENTRY = new RegExp(`^[-*] \\*\\*(${LABEL_TEXT}):\\*\\*(.*)$`);

/** One code span and nothing after it. */
const ONE_SPAN = /^ `([^`]*)`\s*$/;

/** Code spans separated by `, `, and nothing after them. */
const SPAN_LIST = /^ `[^`]*`(?:, `[^`]*`)*\s*$/;

/** A workflow file name: no directory, a `.yml` or `.yaml` extension. */
const WORKFLOW = /^[A-Za-z0-9._-]+\.ya?ml$/;

/** The example the messages give. */
const EXAMPLE = `- **${LABELS.environment}:** \`staging\``;

/**
 * Each line's enclosing `#` or `##` section, by its heading's text, outside fenced blocks; `null`
 * before the first heading.
 * @param {string[]} lines @param {Set<number>} fenced
 * @returns {Array<string | null>}
 */
const sectionsOf = (lines, fenced) => {
  /** @type {string | null} */
  let current = null;
  return lines.map((l, i) => {
    if (!fenced.has(i) && /^#{1,2}\s/.test(l)) current = l.trimEnd();
    return current;
  });
};

/**
 * The reference deploy's bullets left under `## Choices`, each with its 1-based line and its text:
 * doctor's `deploy.declaration-moved`. It never throws, so doctor can report them beside whatever
 * else the record holds.
 * @param {string} text the adoption record's markdown
 * @returns {Array<{ line: number, label: string, text: string }>}
 */
export function movedReferenceBullets(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  const sections = sectionsOf(lines, fenced);
  return lines.flatMap((l, i) => {
    if (fenced.has(i) || sections[i] !== CHOICES_HEADING) return [];
    const m = MENTION.exec(l);
    return m && REFERENCE_LABELS.has(/** @type {string} */ (m[1])) ? [{ line: i + 1, label: /** @type {string} */ (m[1]), text: l.trim() }] : [];
  });
}

/**
 * A bullet left under `## Choices`, and where it goes, for a message.
 * @param {number} line @param {string} label
 */
const moveMessage = (line, label) =>
  `${ADOPTION_RECORD}:${line} declares \`${label}\` under \`${CHOICES_HEADING}\`, but the reference deploy is read from \`${DEPLOY_HEADING}\` only (plan 0010): move its three bullets into a \`${DEPLOY_HEADING}\` section, as the upgrade skill does; \`kanon doctor\` reports them as \`deploy.declaration-moved\``;

/**
 * A value read from one code span, checked for spaces and emptiness.
 * @param {string} value @param {number} line @param {string} label
 */
const spanValue = (value, line, label) => {
  if (value === '') throw fail(`${ADOPTION_RECORD}:${line}: \`${label}\` has an empty code span`);
  if (value.trim() !== value) throw fail(`${ADOPTION_RECORD}:${line}: \`${label}\` has spaces around its value`);
  return value;
};

/**
 * Parses the deploy declaration out of an adoption record. A record with no `## Deploy` section
 * declares no environment and no reference deploy. Throws `DeclarationError` naming the line of
 * the first thing it can't read.
 * @param {string} text the adoption record's markdown
 * @returns {DeployDeclaration}
 */
export function parseDeployDeclaration(text) {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  if (fenced.unclosed !== -1) throw fail(`${ADOPTION_RECORD}:${fenced.unclosed + 1} opens a code fence that never closes`);

  const heads = lines.flatMap((l, i) => (!fenced.has(i) && l.trimEnd() === DEPLOY_HEADING ? [i] : []));
  if (heads.length > 1) {
    throw fail(`${ADOPTION_RECORD} has the \`${DEPLOY_HEADING}\` heading ${heads.length} times, on lines ${heads.map((i) => i + 1).join(', ')}`);
  }
  const sections = sectionsOf(lines, fenced);

  /** @type {Partial<Record<string, { value: string, line: number }>>} */
  const found = {};
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced.has(i)) continue;
    const text = /** @type {string} */ (lines[i]);
    const line = i + 1;
    const mention = MENTION.exec(text);
    const inDeploy = sections[i] === DEPLOY_HEADING;
    if (!mention) {
      // The section holds the declaration and prose: a list item that is neither is a typo.
      if (inDeploy && LIST_ITEM.test(text)) {
        throw fail(`${ADOPTION_RECORD}:${line}, under \`${DEPLOY_HEADING}\`, is a list item that declares nothing: the section's bullets are ${Object.keys(FIELD_OF).map((l) => `\`${l}\``).join(', ')}`);
      }
      continue;
    }
    const label = /** @type {string} */ (mention[1]);
    if (!inDeploy) {
      if (REFERENCE_LABELS.has(label)) {
        if (sections[i] === CHOICES_HEADING) throw fail(moveMessage(line, label));
        throw fail(`${ADOPTION_RECORD}:${line} declares the reference environment's deploy outside \`${DEPLOY_HEADING}\`: write the three bullets under that heading`);
      }
      // `## Plan`'s prose bullets share the chain's labels; only one in the declaration's shape is a declaration.
      if (/^\s*`/.test(/** @type {string} */ (mention[2]))) {
        throw fail(`${ADOPTION_RECORD}:${line} declares \`${label}\` outside \`${DEPLOY_HEADING}\`: write it under that heading`);
      }
      continue;
    }
    const entry = ENTRY.exec(text);
    if (!entry) {
      throw fail(`${ADOPTION_RECORD}:${line}, under \`${DEPLOY_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, then the value as one code span and nothing after it, as in: ${EXAMPLE}`);
    }
    const first = found[label];
    if (first) throw fail(`${ADOPTION_RECORD}:${line} repeats \`${label}\`, already declared on line ${first.line}`);
    const rest = /** @type {string} */ (entry[2]);
    if (label === CHAIN_LABELS.environments) {
      if (rest.trim() !== '' && !SPAN_LIST.test(rest)) {
        throw fail(`${ADOPTION_RECORD}:${line}: \`${label}\` isn't a list of code spans: write each environment as a code span, in deploy order, separated by \`, \`, as in: - **${label}:** \`staging\`, \`production\``);
      }
      found[label] = { value: rest, line };
      continue;
    }
    const span = ONE_SPAN.exec(rest);
    if (!span) {
      throw fail(`${ADOPTION_RECORD}:${line}, under \`${DEPLOY_HEADING}\`, isn't a declaration: write a \`- \` bullet at the start of the line, the bold label, then the value as one code span and nothing after it, as in: ${EXAMPLE}`);
    }
    found[label] = { value: spanValue(/** @type {string} */ (span[1]), line, label), line };
  }

  // The chain, in the order written.
  /** @type {string[]} */
  const environments = [];
  const listed = found[CHAIN_LABELS.environments];
  if (listed) {
    for (const [, name = ''] of listed.value.matchAll(/`([^`]*)`/g)) {
      const value = spanValue(name, listed.line, CHAIN_LABELS.environments);
      if (environments.includes(value)) throw fail(`${ADOPTION_RECORD}:${listed.line}: \`${CHAIN_LABELS.environments}\` names \`${value}\` twice: each environment is one link of the chain`);
      environments.push(value);
    }
  }

  let ciWait = DEFAULT_CI_WAIT;
  const wait = found[CHAIN_LABELS.ciWait];
  if (wait) {
    const n = /^\d+$/.test(wait.value) ? Number(wait.value) : NaN;
    if (!(n >= CI_WAIT_MIN && n <= CI_WAIT_MAX)) {
      throw fail(`${ADOPTION_RECORD}:${wait.line}: \`${CHAIN_LABELS.ciWait}\` is \`${wait.value}\`; write a whole number of minutes from ${CI_WAIT_MIN} to ${CI_WAIT_MAX}, or remove it for ${DEFAULT_CI_WAIT}`);
    }
    ciWait = n;
  }

  /** @type {DeployDeclaration['fallback']} */
  let fallback = null;
  const marker = found[CHAIN_LABELS.fallback];
  if (marker) {
    if (!(/** @type {readonly string[]} */ (FALLBACKS)).includes(marker.value)) {
      throw fail(`${ADOPTION_RECORD}:${marker.line}: \`${CHAIN_LABELS.fallback}\` is \`${marker.value}\`; write ${FALLBACKS.map((f) => `\`${f}\``).join(' or ')}, or remove it where the plan protects the environments (plan 0010 §13)`);
    }
    fallback = /** @type {DeployDeclaration['fallback']} */ (marker.value);
  }

  /** @type {ReferenceDeploy | null} */
  let reference = null;
  const present = REFERENCE_FIELDS.filter((f) => found[LABELS[f]]);
  if (present.length) {
    const missing = REFERENCE_FIELDS.filter((f) => !found[LABELS[f]]);
    if (missing.length) {
      throw fail(`${ADOPTION_RECORD} declares the reference environment's deploy without ${missing.map((f) => `\`${LABELS[f]}\``).join(' and ')}: declare all three, or none`);
    }
    const at = (/** @type {keyof typeof LABELS} */ f) => /** @type {{ value: string, line: number }} */ (found[LABELS[f]]);
    if (!WORKFLOW.test(at('workflow').value)) {
      throw fail(`${ADOPTION_RECORD}:${at('workflow').line}: \`${at('workflow').value}\` isn't a workflow file name: write the file's name in \`.github/workflows/\`, such as \`deploy.yml\`, with no directory`);
    }
    // With no list, the reference names any environment, as an adopter's own deploy does.
    if (environments.length && !environments.includes(at('environment').value)) {
      throw fail(`${ADOPTION_RECORD}:${at('environment').line}: the reference environment \`${at('environment').value}\` isn't one of the \`${CHAIN_LABELS.environments}\` declared on line ${/** @type {{ line: number }} */ (listed).line}: name one of ${environments.map((e) => `\`${e}\``).join(', ')}`);
    }
    reference = { environment: at('environment').value, workflow: at('workflow').value, job: at('job').value };
  }

  const chain = environments.map((environment, i) => /** @type {Link} */ ({
    environment,
    position: i + 1,
    role: i === environments.length - 1 ? ROLES.production : ROLES.preProduction,
  }));
  return { environments, chain, ciWait, reference, fallback };
}

/**
 * Reads the deploy declaration from a checked-out tree. A record that doesn't exist declares
 * nothing; a malformed one throws.
 * @param {string} [root] the repository root
 * @returns {DeployDeclaration | null}
 */
export function readDeployDeclaration(root = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(root, ADOPTION_RECORD), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw fail(`${ADOPTION_RECORD} couldn't be read: ${/** @type {Error} */ (e).message}`);
  }
  return parseDeployDeclaration(text);
}

// ── The reference deploy (`K-PROJ-11`), as the reconciler and lane-check read it ─────────────

/**
 * The reference deploy out of an adoption record: `null` when the record declares none.
 * @param {string} text the adoption record's markdown
 * @returns {ReferenceDeploy | null}
 */
export const parseReferenceDeploy = (text) => parseDeployDeclaration(text).reference;

/**
 * The declaration a project needs to close (`K-PROJ-11`): throws when the record declares none.
 * @param {ReferenceDeploy | null} declared
 * @param {string} where where the record was read, for the message
 * @returns {ReferenceDeploy}
 */
export function requireReferenceDeploy(declared, where) {
  if (declared) return declared;
  throw new DeclarationError(
    `${ADOPTION_RECORD}${where} declares no reference environment, so no project can close (K-PROJ-11): add ${REFERENCE_FIELDS.map((f) => `\`- **${LABELS[f]}:**\``).join(', ')} bullets under \`${DEPLOY_HEADING}\` (K-LAYOUT-10)`,
  );
}

/**
 * The reference deploy from a checked-out tree: `null` for no record, or one that declares none.
 * @param {string} [root] the repository root
 * @returns {ReferenceDeploy | null}
 */
export const readReferenceDeploy = (root = process.cwd()) => readDeployDeclaration(root)?.reference ?? null;

/**
 * Reads the reference deploy from the repository's default branch, for the reconciler, which
 * decides whether a project closes (`K-MERGE-17`). Throws `DeclarationError` when the record is
 * missing there, declares no reference environment, is malformed, or can't be read.
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
