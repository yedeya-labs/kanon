// The scrub: the deterministic backstop on an upstream finding's evidence text (plan 0006 §4.2,
// ADR 0007 as amended 2026-10-07, `K-OBS-16`).
//
// THE TEXT IS EXTRACTED, NOT REDACTED (plan 0006 §4, decision 15). The lane writes the evidence
// for Kanon's maintainer, in Kanon's terms, from the `upstream-finding` skill. This module runs
// AFTER that, as a backstop, and is not trusted to make arbitrary prose safe: it removes what its
// rules recognise and nothing else.
//
// TWO HALVES, ONE LIST OF RULES, so what the lane removes and what intake refuses are the same
// rules at the same release:
//   - `redact(text, context)`, in the adopter's lane, replaces what each rule finds with its
//     placeholder and returns the text and the names of the rules that fired;
//   - `verify(text, context)`, at intake, in the #41 job and in the schema's `validate`, returns
//     the names of the rules that would still fire, NEVER the text. Any name refuses the text.
// Each rule is one replacement function; `verify` asks whether it would change the text, so the
// two halves can't disagree about what a rule finds.
//
// DETERMINISTIC. No model, no network, no clock: the same text and context always give the same
// answer. Where a rule can match, it removes too much rather than too little (a commit SHA has a
// token's shape, a date a key's).
//
// WHAT IT CAN'T PROMISE. The `name` rule removes only the logins and names in the context, the ones
// the lane can see. A name the lane never saw gets through unless the skill kept it out, so level-2
// text may rarely still contain personal data, and every place that describes it says so.
//
// FILES. ONE MODULE, beside the schema and linked into the ingest function's directory with it
// (`infra/telemetry/function/scrub.mjs`), like `public-words.mjs`, whose `namesForbiddenWord` the
// `name` rule is: so it imports only `node:` built-ins and its own directory's files (`K-SELF-8`).
// The adopter key is not this module's: intake and the #41 job check a row with `assertNoKey`
// (`infra/telemetry/function/aggregate.mjs`) against the keys they hold; the lane holds none, which
// is why the `key` rule refuses a key's SHAPE.

import { namesForbiddenWord, sha256 } from './public-words.mjs';

/** The rules' version, carried in a finding row's `scrub_version`. A new or changed rule is a new version. */
export const SCRUB_VERSION = 1;

/**
 * A path in Kanon's tree, by its top-level directory (plan 0006 §2.1): the finding row's
 * `kanon_paths` pattern, and the `path` rule's check where no tree is at hand (intake). A `.` or
 * `..` segment is refused, so a path can't climb out of the directory it names.
 */
export const KANON_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:actions|cli|scripts|skills|rulebook|docs|infra|\.github\/(?:workflows|scripts))\/[A-Za-z0-9._/-]{1,200}$/;

/**
 * What the scrub is told, all of it from the lane's own run.
 * @typedef {{
 *   nameHashes?: Iterable<string>,
 *   kanonFiles?: Iterable<string> | ((path: string) => boolean),
 * }} Context
 * - `nameHashes`: the SHA-256 of each word of each name the lane can see (`nameContext`). Hashes
 *   only: no name is ever written into the scrub, a test or a log.
 * - `kanonFiles`: the files in the Kanon tree the lane runs from (`$KANON`), as paths relative to
 *   it, or a test of one. Absent, a path is Kanon's when it matches `KANON_PATH`, as at intake,
 *   which holds no tree.
 */

/**
 * The words the `name` rule removes, as hashes (plan 0006 §4.2): the repository's owner and name;
 * the logins and slugs of its App register; the run's actor; its collaborators, where the filing
 * job's token may list them; the logins of the run's issue and PR participants (authors, assignees,
 * reviewers and commenters); and the logins and names of the commit authors the lane read. Each
 * name counts as its lowercase `[a-z0-9]` runs, as `namesForbiddenWord` reads text, and an App's
 * `[bot]` suffix is not a name.
 * @param {{ repository?: string, apps?: readonly string[], actor?: string, collaborators?: readonly string[],
 *   participants?: readonly string[], commitAuthors?: readonly string[] }} sources
 * @returns {Set<string>}
 */
export function nameContext({ repository = '', apps = [], actor = '', collaborators = [], participants = [], commitAuthors = [] } = {}) {
  const names = [repository, ...apps, actor, ...collaborators, ...participants, ...commitAuthors];
  return new Set(names.flatMap((n) => String(n).replace(/\[bot\]/gi, ' ').toLowerCase().match(/[a-z0-9]+/g) ?? []).map(sha256));
}

// ------------------------------------------------------------------------- the rules

/** Every placeholder `redact` writes, and the truncation mark. `verify` reads past them. */
const PLACEHOLDER = /(\[(?:url|email|login|key|token|path|name|cut)\])/;

/** An adopter key as `openssl rand -hex 4` makes one (docs/telemetry.md), as `telemetry-file.mjs` refuses it. */
const KEY_LIKE = /(?<![0-9A-Za-z])[0-9a-f]{8}(?![0-9A-Za-z])/gi;
/** A stored partition, `<key>#<lane>`: lowercase, as every key and lane is. */
const PARTITION_LIKE = /[a-z0-9][a-z0-9-]*#[a-z][a-z0-9-]*/g;

/** A credential's documented prefix: GitHub, AWS, Google, Slack and the common `sk-` keys. */
const TOKEN_PREFIXED = /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,})/g;
/**
 * An unbroken run of 32 or more base64 or hex characters. `/` is left out, because it would make a
 * long path one run; a base64 run holding a `/` is path-shaped, so the `path` rule takes it.
 */
const TOKEN_RUN = /(?<![A-Za-z0-9+=_])[A-Za-z0-9+=_]{32,}/g;

/** A path-shaped token's span: no space, quote, bracket or list punctuation. */
const PATH_TOKEN = /[^\s`'"()<>[\]{},;|*]+/g;
/** A file name with an extension, `name.ext`. */
const FILE_NAME = /^[\w.-]*[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]{0,7}$/;
/** Prose abbreviations that have a file name's shape. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'cf', 'vs', 'etc']);

/** A run of letters, digits and marks, which holds every `[a-z0-9]` run `namesForbiddenWord` reads. */
const WORD_TOKEN = /@?[\p{L}\p{N}\p{M}_-]+(?:\[bot\])?/gu;

/**
 * @typedef {{ names: Set<string>, isKanon: (path: string) => boolean }} Resolved
 * @typedef {{ name: string, apply: (text: string, ctx: Resolved) => string }} Rule
 */

/** Whether a token is path-shaped (plan 0006 §4.2): it holds a `/` or `\`, starts `~`, or is a file name. */
const pathShaped = (/** @type {string} */ t) =>
  t.includes('/') || t.includes('\\') || /^~[A-Za-z/]/.test(t) || (FILE_NAME.test(t) && !ABBREVIATIONS.has(t.toLowerCase()));

/** A path as the tree names it: no `$KANON/` or `./` before it, no line or anchor after it. */
const treePath = (/** @type {string} */ t) =>
  t.replace(/^(?:\$KANON\/|\$\{KANON\}\/|\.\/)/, '').replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '');

/**
 * THE RULES, IN ORDER (`scrub_version` 1). Each replaces what it finds with its placeholder, and
 * `redact` runs them in this order, each on what the ones before left.
 * @type {readonly Rule[]}
 */
const RULES = Object.freeze([
  {
    // An HTML comment's opening, which could forge an issue marker. Removed, until none is left.
    name: 'marker',
    apply: (t) => { let s = t; while (s.includes('<!--')) s = s.replaceAll('<!--', ''); return s; },
  },
  {
    name: 'url',
    apply: (t) => t
      .replace(/(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]*/g, '[url]')
      .replace(/(?<![A-Za-z0-9._%+-])git@[^\s<>"'`]*/gi, '[url]')
      .replace(/(?<![A-Za-z0-9.-])www\.[^\s<>"'`]*/gi, '[url]'),
  },
  {
    name: 'email',
    apply: (t) => t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]'),
  },
  {
    name: 'mention',
    apply: (t) => t.replace(/@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?/g, '[login]'),
  },
  {
    name: 'key',
    apply: (t) => t.replace(PARTITION_LIKE, '[key]').replace(KEY_LIKE, '[key]'),
  },
  {
    name: 'token',
    apply: (t) => t.replace(TOKEN_PREFIXED, '[token]').replace(TOKEN_RUN, '[token]'),
  },
  {
    // A path-shaped token, kept only when it is a file in Kanon's tree. `owner/name` falls here.
    name: 'path',
    apply: (t, ctx) => t.replace(PATH_TOKEN, (tok) => {
      const core = tok.replace(/[.:!?]+$/, '');
      if (core === '' || !pathShaped(core) || ctx.isKanon(treePath(core))) return tok;
      return `[path]${tok.slice(core.length)}`;
    }),
  },
  {
    // `public-words.mjs`'s check, once with the context's hashes and once with its own list.
    name: 'name',
    apply: (t, ctx) => t.replace(WORD_TOKEN, (tok) =>
      (namesForbiddenWord(tok, ctx.names) || namesForbiddenWord(tok) ? '[name]' : tok)),
  },
]);

/** The rules' names, in order. */
export const RULE_NAMES = Object.freeze(RULES.map((r) => r.name));

/** @param {Context} [context] @returns {Resolved} */
function resolve(context = {}) {
  const names = new Set(context.nameHashes ?? []);
  const files = context.kanonFiles;
  /** @type {(path: string) => boolean} */
  let isKanon;
  if (typeof files === 'function') isKanon = files;
  else if (files) { const set = new Set(files); isKanon = (p) => set.has(p); }
  else isKanon = (p) => KANON_PATH.test(p);
  return { names, isKanon };
}

/** Apply `fn` to the text between placeholders, never to a placeholder. */
const outsidePlaceholders = (/** @type {string} */ text, /** @type {(s: string) => string} */ fn) =>
  text.split(PLACEHOLDER).map((s, i) => (i % 2 ? s : fn(s))).join('');

/** @param {unknown} text */
const asText = (text) => {
  if (typeof text !== 'string') throw new TypeError('the scrub reads a string');
  return text;
};

/**
 * The lane's half: replace what each rule finds, in order.
 * @param {string} text
 * @param {Context} [context]
 * @returns {{ text: string, fired: string[] }} the scrubbed text, and the rules that changed it
 */
export function redact(text, context) {
  let out = asText(text);
  const ctx = resolve(context);
  /** @type {string[]} */
  const fired = [];
  for (const rule of RULES) {
    const next = outsidePlaceholders(out, (s) => rule.apply(s, ctx));
    if (next !== out) fired.push(rule.name);
    out = next;
  }
  return { text: out, fired };
}

/**
 * The checking half: the names of the rules that would still fire on the text, never the text.
 * A placeholder is read as a space, so `redact`'s own output never fires.
 * @param {string} text
 * @param {Context} [context]
 * @returns {string[]}
 */
export function verify(text, context) {
  const plain = asText(text).split(PLACEHOLDER).map((s, i) => (i % 2 ? ' ' : s)).join('');
  const ctx = resolve(context);
  return RULES.filter((rule) => rule.apply(plain, ctx) !== plain).map((r) => r.name);
}
