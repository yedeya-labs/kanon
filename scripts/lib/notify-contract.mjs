// The notification contract, `kanon-notify` version 1 (plan 0011 §3, `K-OBS-19`).
//
// WHAT A KANON NOTIFICATION IS. One JSON object: a kind, a severity, a title, a summary, sections,
// links and its source, in plain text and Kanon text (a small fixed markup, below), with limits
// taken from Slack's. A lane builds one with this library and hands it to the `notify` job, which
// validates it and calls the adopter's hook at `.github/actions/notify`; no lane formats for a
// chat system (plan 0011 §4).
//
// ONE LIBRARY, USED THREE TIMES (§3.3), as `actions/agent-telemetry/schema.mjs` is: by the
// producers, through `fit`; by the `notify` job before any hook runs, through `validate`; and by
// the tests. So it imports nothing but `node:` built-ins, and nothing at all today.
//
// A MESSAGE IS VALID OR IT IS NOT POSTED. `validate` never repairs, and names the offending FIELDS
// only, never a value: a message can hold a model's prose, and a rejection reaches a log. `fit` is
// what repairs, and only by cutting: Kanon text refuses no character, so a draft that meets `fit`'s
// precondition can only break a limit, and what `fit` returns from it always validates.
//
// THE PUBLISHED JSON SCHEMA (decision 15). `docs/notify/message-v1.schema.json` is `jsonSchema(1)`,
// generated from `SCHEMAS` and held equal to it by `tests/library/notify-contract.test.ts`, so an
// adopter can write its hook in any language and test it offline. It states every rule `validate`
// checks but the two whole-message limits (12,000 characters of text and 64 KiB of JSON), which a
// JSON Schema cannot sum; it carries them under `x-kanon-whole-message`, and its description says so.
//
// KANON TEXT (§3.1): paragraphs separated by a blank line, one level of `- ` bullets, `**strong**`,
// `_emphasis_`, `` `code` `` and `[label](https://…)`. Everything else is literal text, never
// refused. A backslash makes a markup character literal: `\*`, `\_`, `` \` ``, `\[`, `\\`. `_`
// opens emphasis only at a word's start and closes only at a word's end. A span never crosses a
// line. Plain text (`title`, `heading`, field labels and values, link labels) is never interpreted.

/** The contract's versions, oldest first. A new version is a Kanon release that adds one (§3.4). */
export const VERSIONS = Object.freeze([1]);
/** The newest version, the one `fit` writes. */
export const CONTRACT_VERSION = 1;

/**
 * The message kinds of version 1 (§3.2). There is no `health` kind (decision 13): the health job
 * never posts. A kind is added with its producer and its secret, additively (§3.4): `release`, a
 * published release, for a repository that releases without deploying (kanon#1190).
 */
export const KINDS = Object.freeze(['project-digest', 'weekly-digest', 'deploy', 'release']);
export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);

/**
 * Each kind's secret's name (decision 3): `KANON_CHAT_` and the kind in capitals, so a future
 * kind's secret is named by the same rule. The `notify` job hands the hook its kind's and no other.
 * @type {Readonly<Record<string, string>>}
 */
export const KIND_SECRETS = Object.freeze(Object.fromEntries(
  KINDS.map((k) => [k, `KANON_CHAT_${k.toUpperCase().replaceAll('-', '_')}`]),
));

/**
 * The lanes a message may come from (`source.lane`): the lanes that produce a kind, a lane added
 * with its kind. The digests and the deploy lane are named for their kind (§3.2); the `release`
 * kind's lane is `release-announce`, named for what it does, as its telemetry partition is
 * (kanon#1190).
 */
export const SOURCE_LANES = Object.freeze(['project-digest', 'weekly-digest', 'deploy', 'release-announce']);

/**
 * Version 1's limits (§3.1), in characters (Unicode code points) unless named otherwise. Each is
 * Slack's, less a margin the Slack hook spends: a header of 150 holds a 20-character severity emoji
 * and a 120-character title; a section of 3,000 holds a 2,500-character body after escaping; a
 * field of 2,000 holds a label of 100 and a value of 1,800, together 1,900; a context block of 10
 * holds 9 links and the run.
 */
export const LIMITS = Object.freeze({
  title: 120,
  summary: 1000,
  sections: 20,
  heading: 150,
  body: 2500,
  fields: 10,
  fieldLabel: 100,
  fieldValue: 1800,
  links: 9,
  linkLabel: 75,
  url: 2000,
  repository: 140,
  /** Every string in the message, counted together. */
  messageChars: 12000,
  /** The message as JSON, in UTF-8 bytes. */
  messageBytes: 64 * 1024,
});

// ------------------------------------------------------------------ the field specs

/** @typedef {{ type: 'version', value: number }
 *   | { type: 'enum', values: readonly string[] }
 *   | { type: 'plain', max: number, oneLine: boolean }
 *   | { type: 'kanon', max: number }
 *   | { type: 'pattern', re: RegExp, max: number }
 *   | { type: 'array', max: number, items: Spec }
 *   | { type: 'object', fields: Readonly<Record<string, Field>> }
 * } Spec */
/** @typedef {Spec & { required?: boolean, about: string }} Field */

/** A line break, which a one-line field refuses and `fit` folds into a space. */
const LINE_BREAK = /[\r\n\u2028\u2029]/;
/**
 * An `https://` URL with no whitespace, C0 control character or DEL: it refuses U+0000 to U+0020,
 * U+007F, and every other character ECMA-262's `\s` matches. Its source is the JSON Schema's pattern
 * too, so it is written without flags, and names each character it refuses rather than using `\s`,
 * whose set differs between engines (#921). What no pattern makes portable: ECMA-262's `$` is the
 * string's end, but some engines' `$`, Python's for one, also matches before a final `\n`.
 */
// eslint-disable-next-line no-control-regex -- the URL refuses control characters by name
const HTTPS = /^https:\/\/[^\u0000-\u0020\u007f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/;
/** `owner/name`, as GitHub spells them. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** @returns {Field} */
const req = (/** @type {Field} */ f) => ({ ...f, required: true });
/** @returns {Field} */
const plain = (/** @type {number} */ max, /** @type {string} */ about, oneLine = true) => ({ type: 'plain', max, oneLine, about });
/** @returns {Field} */
const kanon = (/** @type {number} */ max, /** @type {string} */ about) => ({ type: 'kanon', max, about });
/** @returns {Field} */
const url = (/** @type {string} */ about) => ({ type: 'pattern', re: HTTPS, max: LIMITS.url, about });

/** The message, version 1: every field (§3.1). Any other is refused. */
const MESSAGE_V1 = Object.freeze(/** @type {Field} */ ({
  type: 'object',
  about: 'A Kanon notification, version 1 (plan 0011 §3.1).',
  fields: Object.freeze({
    schema_version: req({ type: 'version', value: 1, about: "The contract's version." }),
    kind: req({ type: 'enum', values: KINDS, about: 'What the message is; its kind chose the secret it is posted with.' }),
    severity: req({ type: 'enum', values: SEVERITIES, about: 'How much it matters.' }),
    title: req(plain(LIMITS.title, 'Plain text, one line.')),
    summary: req(kanon(LIMITS.summary, 'Kanon text: what a person must know if they read nothing else; the notification preview.')),
    sections: {
      type: 'array',
      max: LIMITS.sections,
      about: 'The body, in order.',
      items: {
        type: 'object',
        about: 'One section.',
        fields: Object.freeze({
          heading: plain(LIMITS.heading, 'Plain text, one line; optional.'),
          body: req(kanon(LIMITS.body, 'Kanon text.')),
          fields: {
            type: 'array',
            max: LIMITS.fields,
            about: 'Short label and value pairs.',
            items: {
              type: 'object',
              about: 'One label and its value.',
              fields: Object.freeze({
                label: req(plain(LIMITS.fieldLabel, 'Plain text, one line.')),
                value: req(plain(LIMITS.fieldValue, 'Plain text; may hold line breaks.', false)),
              }),
            },
          },
        }),
      },
    },
    links: {
      type: 'array',
      max: LIMITS.links,
      about: 'Links shown after the body.',
      items: {
        type: 'object',
        about: 'One link.',
        fields: Object.freeze({
          label: req(plain(LIMITS.linkLabel, 'Plain text, one line.')),
          url: req(url('An https:// URL.')),
        }),
      },
    },
    source: req({
      type: 'object',
      about: 'Where it came from: a hook may show it, route by it, or ignore it.',
      fields: Object.freeze({
        repository: req({ type: 'pattern', re: REPOSITORY, max: LIMITS.repository, about: 'owner/name.' }),
        lane: req({ type: 'enum', values: SOURCE_LANES, about: 'The Kanon lane that produced it.' }),
        run_url: req(url("The producing run's https:// URL.")),
      }),
    }),
  }),
}));

/**
 * Every message spec, by version (§3.4). Within a version, changes are additive only; anything else
 * is a new version, and the old one stays until no supported release writes it.
 * @type {Readonly<Record<number, Field>>}
 */
export const SCHEMAS = Object.freeze({ 1: MESSAGE_V1 });

// ------------------------------------------------------------------- validation

/** What a field name looks like. A key that doesn't is reported as `(unnamed)`, never echoed. */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Code points, as JSON Schema's `maxLength` counts them. */
const length = (/** @type {string} */ s) => [...s].length;

/**
 * @typedef {{ field: string, problem: string }} Problem
 */

/**
 * Check one value against its spec, pushing each problem by path. Never a value.
 * @param {Field | Spec} spec
 * @param {unknown} v
 * @param {string} path
 * @param {Problem[]} out
 */
function check(spec, v, path, out) {
  const bad = (/** @type {string} */ problem) => { out.push({ field: path, problem }); };
  switch (spec.type) {
    case 'version':
      if (typeof v !== 'number') return bad('type');
      if (v !== spec.value) bad('enum');
      return;
    case 'enum':
      if (typeof v !== 'string') return bad('type');
      if (!spec.values.includes(v)) bad('enum');
      return;
    case 'plain':
    case 'kanon':
    case 'pattern': {
      if (typeof v !== 'string') return bad('type');
      const n = length(v);
      const max = spec.max;
      if (n < 1 || n > max) return bad('range');
      if (spec.type === 'plain' && spec.oneLine && LINE_BREAK.test(v)) return bad('line-break');
      if (spec.type === 'pattern' && !spec.re.test(v)) bad('pattern');
      return;
    }
    case 'array':
      if (!Array.isArray(v)) return bad('type');
      if (v.length > spec.max) bad('range');
      v.forEach((item, i) => check(spec.items, item, `${path}[${i}]`, out));
      return;
    case 'object': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return bad('type');
      const o = /** @type {Record<string, unknown>} */ (v);
      const at = (/** @type {string} */ k) => (path ? `${path}.${k}` : k);
      for (const k of Object.keys(o)) {
        if (!Object.hasOwn(spec.fields, k)) {
          out.push({ field: FIELD_NAME.test(k) ? at(k) : at('(unnamed)'), problem: 'unknown' });
          continue;
        }
        check(/** @type {Field} */ (spec.fields[k]), o[k], at(k), out);
      }
      for (const [k, f] of Object.entries(spec.fields)) {
        if (f.required && !Object.hasOwn(o, k)) out.push({ field: at(k), problem: 'required' });
      }
      return;
    }
    default:
      bad('type');
  }
}

/** Every string in a value, depth first. */
function strings(/** @type {unknown} */ v, /** @type {string[]} */ out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** The two whole-message measures (§3.1). */
export function measure(/** @type {unknown} */ message) {
  return {
    chars: strings(message).reduce((n, s) => n + length(s), 0),
    bytes: Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8'),
  };
}

/**
 * Validate one message. Reads `schema_version` first, then checks the message against that
 * version's spec. Rejects the WHOLE message on any problem, and names fields only.
 * @param {unknown} message
 * @returns {{ ok: true } | { ok: false, errors: Problem[] }}
 */
export function validate(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, errors: [{ field: '(message)', problem: 'type' }] };
  }
  const m = /** @type {Record<string, unknown>} */ (message);
  const version = m.schema_version;
  const spec = typeof version === 'number' && Object.hasOwn(SCHEMAS, version) ? SCHEMAS[version] : undefined;
  if (!spec) return { ok: false, errors: [{ field: 'schema_version', problem: Object.hasOwn(m, 'schema_version') ? 'enum' : 'required' }] };
  /** @type {Problem[]} */
  const errors = [];
  check(spec, m, '', errors);
  const { chars, bytes } = measure(m);
  if (chars > LIMITS.messageChars) errors.push({ field: '(message)', problem: 'too-long' });
  if (bytes > LIMITS.messageBytes) errors.push({ field: '(message)', problem: 'too-large' });
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * A rejection as one line, field names and problem words only: what a log may carry.
 * @param {Problem[]} errors
 */
export const describeErrors = (errors) => errors.map((e) => `${e.field} (${e.problem})`).join(', ');

// ------------------------------------------------------------------ the JSON Schema

/**
 * The JSON Schema (2020-12) of one contract version, generated from its spec (decision 15).
 * @param {number} version
 */
export function jsonSchema(version) {
  const spec = SCHEMAS[version];
  if (!spec) throw new Error(`no contract version ${version}`);
  /** @returns {Record<string, unknown>} */
  const of = (/** @type {Field | Spec} */ s) => {
    const about = 'about' in s ? { description: s.about } : {};
    switch (s.type) {
      case 'version': return { ...about, type: 'integer', const: s.value };
      case 'enum': return { ...about, type: 'string', enum: [...s.values] };
      case 'plain': return { ...about, type: 'string', minLength: 1, maxLength: s.max, ...(s.oneLine ? { pattern: '^[^\\r\\n\\u2028\\u2029]*$' } : {}) };
      case 'kanon': return { ...about, type: 'string', minLength: 1, maxLength: s.max };
      case 'pattern': return { ...about, type: 'string', minLength: 1, maxLength: s.max, pattern: s.re.source };
      case 'array': return { ...about, type: 'array', maxItems: s.max, items: of(s.items) };
      case 'object': {
        const required = Object.entries(s.fields).filter(([, f]) => f.required).map(([k]) => k);
        return {
          ...about,
          type: 'object',
          properties: Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, of(f)])),
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        };
      }
      default: throw new Error('unknown spec type');
    }
  };
  const root = of(spec);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://github.com/yedeya-labs/kanon/blob/main/docs/notify/message-v${version}.schema.json`,
    title: `kanon-notify message, version ${version}`,
    ...root,
    description: `${root.description} Generated from scripts/lib/notify-contract.mjs; do not edit. `
      + 'Lengths count Unicode code points. It states every rule of the validator but the two whole-message limits in x-kanon-whole-message, '
      + 'which a JSON Schema cannot sum: every string in the message together, and the message as UTF-8 JSON.',
    'x-kanon-whole-message': { maxChars: LIMITS.messageChars, maxJsonBytes: LIMITS.messageBytes },
  };
}

/** The JSON Schema file's exact text: what `docs/notify/message-v<N>.schema.json` holds. */
export const jsonSchemaText = (/** @type {number} */ version) => `${JSON.stringify(jsonSchema(version), null, 2)}\n`;

// ------------------------------------------------------------------ Kanon text

/** The markup characters a backslash makes literal. */
const MARKUP = /[\\*_`[]/g;
const IS_MARKUP = (/** @type {string | undefined} */ c) => c !== undefined && '\\*_`['.includes(c);
/** A word character, for `_`'s word-boundary rule. */
const WORD = /[\p{L}\p{N}]/u;
const isWord = (/** @type {string | undefined} */ c) => c !== undefined && WORD.test(c);
const isSpace = (/** @type {string | undefined} */ c) => c === undefined || /\s/.test(c);

/**
 * @typedef {{ t: 'text', v: string }
 *   | { t: 'code', v: string }
 *   | { t: 'strong', c: Node[] }
 *   | { t: 'em', c: Node[] }
 *   | { t: 'link', c: Node[], url: string }
 * } Node
 */

/**
 * Text nobody controls, made safe to put in Kanon text (§3.1): every markup character is
 * backslash-escaped, so an issue titled `**urgent**` or `Support Array<string>` arrives as written.
 * @param {unknown} s
 */
export const literal = (s) => String(s ?? '').replace(MARKUP, '\\$&');

/**
 * Where the code span opened at `i` closes, or -1: the next backtick on the line, with something between.
 * @param {string} s
 * @param {number} i
 */
function codeEnd(s, i) {
  const j = s.indexOf('`', i + 1);
  return j > i + 1 ? j : -1;
}

/**
 * Where a link opened at `i` ends: its label's end, its URL and the index past its `)`, or null.
 * The label ends at the first unescaped `]` followed by `(https://…)` on the same line.
 * @param {string} s
 * @param {number} i
 */
function linkAt(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\' && IS_MARKUP(s[j + 1])) { j++; continue; }
    if (s[j] !== ']' || s[j + 1] !== '(') continue;
    const close = s.indexOf(')', j + 2);
    if (close === -1) return null;
    const href = s.slice(j + 2, close);
    if (j > i + 1 && HTTPS.test(href) && !/[()]/.test(href) && length(href) <= LIMITS.url) return { labelEnd: j, url: href, end: close + 1 };
  }
  return null;
}

/**
 * Where a span opened at `i` by `mark` closes, skipping escapes and code spans, or -1.
 * @param {string} s
 * @param {number} i
 * @param {'**' | '_'} mark
 */
function spanEnd(s, i, mark) {
  const from = i + mark.length;
  if (isSpace(s[from])) return -1;
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && IS_MARKUP(s[j + 1])) { j++; continue; }
    if (s[j] === '`') { const e = codeEnd(s, j); if (e !== -1) { j = e; continue; } }
    if (j > from && s.startsWith(mark, j) && !isSpace(s[j - 1])) {
      if (mark === '_' && isWord(s[j + 1])) continue;
      return j;
    }
  }
  return -1;
}

/**
 * Parse one line of Kanon text into nodes. A span never crosses a line, and anything that doesn't
 * form a construct is literal text. Exported for a hook that renders Kanon text into its own
 * system's markup (the Slack hook, `actions/notify/slack/slack.mjs`), so the subset is parsed in
 * one place: a `text` node holds its characters with every escape resolved.
 * @param {string} s
 * @param {{ strong?: boolean, em?: boolean, link?: boolean, code?: boolean }} [allow]
 * @returns {Node[]}
 */
export function parseInline(s, allow = { strong: true, em: true, link: true, code: true }) {
  /** @type {Node[]} */
  const out = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  for (let i = 0; i < s.length;) {
    const c = /** @type {string} */ (s[i]);
    if (c === '\\' && IS_MARKUP(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
    if (c === '`' && allow.code) {
      const e = codeEnd(s, i);
      if (e !== -1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, e) }); i = e + 1; continue; }
    }
    if (c === '*' && s[i + 1] === '*' && allow.strong) {
      const e = spanEnd(s, i, '**');
      if (e !== -1) {
        flush();
        out.push({ t: 'strong', c: parseInline(s.slice(i + 2, e), { em: true, link: true, code: true }) });
        i = e + 2;
        continue;
      }
    }
    if (c === '_' && allow.em && !isWord(s[i - 1])) {
      const e = spanEnd(s, i, '_');
      if (e !== -1) {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, e), { link: true, code: true }) });
        i = e + 1;
        continue;
      }
    }
    if (c === '[' && allow.link) {
      const l = linkAt(s, i);
      if (l) {
        flush();
        out.push({ t: 'link', c: parseInline(s.slice(i + 1, l.labelEnd), {}), url: l.url });
        i = l.end;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

/** The lines of a text, with `\r\n` and a lone `\r` read as a line break. */
export const linesOf = (/** @type {string} */ s) => s.split(/\r\n|\r|\n/);

/**
 * Nodes back to Kanon text, canonically: every markup character outside a construct is escaped.
 * @param {Node[]} nodes
 * @returns {string}
 */
function serialize(nodes) {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return literal(n.v);
      case 'code': return `\`${n.v}\``;
      case 'strong': return `**${serialize(n.c)}**`;
      case 'em': return `_${serialize(n.c)}_`;
      case 'link': return `[${serialize(n.c)}](${n.url})`;
      default: return '';
    }
  }).join('');
}

/**
 * A model's narrative, which is Kanon text by intent (§3.1): it keeps the subset's markup and
 * nothing else. Every construct the subset defines stays; every markup character that forms none
 * (an unclosed `**`, a lone `*`, a `[` with no `(https://…)`) is escaped, so a hook never has to
 * guess. Every other character is already literal. Idempotent.
 * @param {unknown} s
 */
export const prose = (s) => linesOf(String(s ?? '')).map((line) => serialize(parseInline(line))).join('\n');

/**
 * Nodes as plain text: markup removed, escapes resolved, a link `label (url)`.
 * @param {Node[]} nodes
 * @returns {string}
 */
function plainOf(nodes) {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
      case 'code': return n.v;
      case 'strong':
      case 'em': return plainOf(n.c);
      case 'link': return `${plainOf(n.c)} (${n.url})`;
      default: return '';
    }
  }).join('');
}

/** Kanon text as plain text, line by line. */
export const plainText = (/** @type {string} */ s) => linesOf(s).map((line) => plainOf(parseInline(line))).join('\n');

// ------------------------------------------------------------------ renderText

const TRUNCATED = '… truncated';

/**
 * The message as PLAIN text, at most 12,000 characters (§3.3), for a hook that posts one string:
 * the markup removed, the escapes resolved, a link written `label (url)`. Plain, not Kanon text, so
 * a system that renders Markdown can't turn a literal `#` into a heading.
 * @param {Record<string, any>} message a valid message
 * @returns {string}
 */
export function renderText(message) {
  const blocks = [];
  const lead = message.severity === 'warning' ? 'Warning: ' : message.severity === 'critical' ? 'Critical: ' : '';
  blocks.push(`${lead}${message.title}`);
  blocks.push(plainText(message.summary));
  for (const s of message.sections ?? []) {
    const lines = [];
    if (s.heading) lines.push(s.heading);
    lines.push(plainText(s.body));
    for (const f of s.fields ?? []) lines.push(`${f.label}: ${f.value}`);
    blocks.push(lines.join('\n'));
  }
  const links = (message.links ?? []).map((/** @type {{label: string, url: string}} */ l) => `${l.label} (${l.url})`);
  const run = message.source?.run_url;
  if (run && !(message.links ?? []).some((/** @type {{url: string}} */ l) => l.url === run)) links.push(`The run (${run})`);
  if (links.length) blocks.push(links.join('\n'));
  return cutLines(blocks.join('\n\n'), LIMITS.messageChars, TRUNCATED);
}

// ------------------------------------------------------------------ fit

/** A one-line field: line breaks folded into a space, then cut with `…`. */
function cutOne(/** @type {unknown} */ s, /** @type {number} */ max) {
  const v = String(s ?? '').replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  const cps = [...v];
  return cps.length <= max ? v : `${cps.slice(0, max - 1).join('')}…`;
}

/**
 * A multi-line text cut to `max` at a line boundary, ending with a visible `marker` line. A first
 * line longer than the room is cut by characters.
 * @param {string} s
 * @param {number} max
 * @param {string} marker
 */
function cutLines(s, max, marker) {
  if (length(s) <= max) return s;
  const room = max - length(marker) - 1;
  const kept = [];
  let used = 0;
  for (const line of linesOf(s)) {
    const n = length(line) + (kept.length ? 1 : 0);
    if (used + n > room) {
      if (!kept.length && room > 0) kept.push([...line].slice(0, room).join(''));
      break;
    }
    kept.push(line);
    used += n;
  }
  return kept.length ? `${kept.join('\n')}\n${marker}` : marker;
}

/** Kanon text, with its line breaks normalised and cut to `max`. */
const cutKanon = (/** @type {unknown} */ s, /** @type {number} */ max) => cutLines(linesOf(String(s ?? '')).join('\n'), max, TRUNCATED);

/** How many characters a value's strings hold. */
const charsOf = (/** @type {unknown} */ v) => measure(v).chars;

const plural = (/** @type {number} */ n, /** @type {string} */ one) => `${n} more ${one}${n === 1 ? '' : 's'}`;

/**
 * One section, each field within its limit; fields past the tenth fold into a last `… N more`.
 * @param {Record<string, any>} s
 */
function fitSection(s) {
  /** @type {Record<string, any>} */
  const out = {};
  if (s.heading !== undefined && s.heading !== '') out.heading = cutOne(s.heading, LIMITS.heading);
  out.body = cutKanon(s.body, LIMITS.body);
  if (Array.isArray(s.fields) && s.fields.length) {
    const fields = s.fields.map((/** @type {Record<string, unknown>} */ f) => ({
      label: cutOne(f.label, LIMITS.fieldLabel),
      value: cutLines(String(f.value ?? ''), LIMITS.fieldValue, TRUNCATED),
    }));
    out.fields = fields.length > LIMITS.fields
      ? [...fields.slice(0, LIMITS.fields - 1), { label: '…', value: plural(fields.length - LIMITS.fields + 1, 'field') }]
      : fields;
  }
  return out;
}

/** The smallest room a cut section is worth keeping for. */
const MIN_SECTION = 80;
/** Room kept back for the last section that says what was left out. */
const FOLD_ROOM = 120;

/**
 * A section cut to `room` characters: its fields while they fit (the rest in `… N more`), then its
 * body at a line boundary. Null when not even that fits.
 * @param {Record<string, any>} s a fitted section
 * @param {number} room
 */
function shrinkSection(s, room) {
  if (room < MIN_SECTION) return null;
  /** @type {Record<string, any>} */
  const out = {};
  let used = 0;
  if (s.heading) { out.heading = cutOne(s.heading, Math.min(LIMITS.heading, Math.floor(room / 4))); used += length(out.heading); }
  const bodyFloor = Math.min(length(s.body), 40);
  if (s.fields) {
    const kept = [];
    for (const f of s.fields) {
      const n = charsOf(f);
      if (used + n + bodyFloor + 20 > room) break;
      kept.push(f);
      used += n;
    }
    const left = s.fields.length - kept.length;
    // A fitted section holds at most ten fields, so with one left out at least one was cut, and
    // the marker takes its place within the ten.
    if (left) { const marker = { label: '…', value: plural(left, 'field') }; kept.push(marker); used += charsOf(marker); }
    if (kept.length) out.fields = kept;
  }
  const bodyRoom = room - used;
  if (bodyRoom < length(TRUNCATED) + 2) return null;
  out.body = cutLines(s.body, bodyRoom, TRUNCATED);
  return out;
}

/**
 * Cut a draft to the contract's limits, at line boundaries, with a visible `… N more` or
 * `… truncated` (§3.3). What producers call. Sets `schema_version` to the newest version.
 *
 * ITS PRECONDITION: the kind, severity and source are right; every required string (`title`,
 * `summary`, each section's `body`, each field's `label` and `value`, each link's `label`) is present
 * and non-empty; and each link's `url` is an `https://` URL that `HTTPS` accepts. Since Kanon text
 * refuses no character, the limits are then all a draft can break, so the result of a draft that
 * meets it always validates. Never repairs anything but a length or a line break in a one-line
 * field: a missing title, an `http:` link or a wrong kind is a producer's bug, which `validate`
 * then reports.
 * @param {Record<string, any>} draft
 * @returns {Record<string, any>}
 */
export function fit(draft) {
  const head = {
    schema_version: CONTRACT_VERSION,
    kind: draft.kind,
    severity: draft.severity,
    title: cutOne(draft.title, LIMITS.title),
    summary: cutKanon(draft.summary, LIMITS.summary),
  };
  const source = draft.source;
  const links = (Array.isArray(draft.links) ? draft.links : [])
    .filter((/** @type {Record<string, unknown>} */ l) => length(String(l?.url ?? '')) <= LIMITS.url)
    .map((/** @type {Record<string, unknown>} */ l) => ({ label: cutOne(l.label, LIMITS.linkLabel), url: l.url }));
  const droppedLinks = (Array.isArray(draft.links) ? draft.links.length : 0) - links.length;
  const sections = (Array.isArray(draft.sections) ? draft.sections : []).map(fitSection);

  for (let budget = /** @type {number} */ (LIMITS.messageChars); ; budget = Math.floor(budget * 0.75)) {
    const message = assemble(head, source, links, droppedLinks, sections, budget);
    if (measure(message).bytes <= LIMITS.messageBytes || budget < 200) return message;
  }
}

/**
 * The message within `budget` characters: the head and the source always, then links, then sections
 * in order, and a last section that names what was left out.
 * @param {Record<string, any>} head
 * @param {unknown} source
 * @param {{label: string, url: unknown}[]} links
 * @param {number} droppedLinks
 * @param {Record<string, any>[]} sections
 * @param {number} budget
 */
function assemble(head, source, links, droppedLinks, sections, budget) {
  let room = budget - charsOf(head) - charsOf(source) - FOLD_ROOM;
  const keptLinks = [];
  for (const l of links) {
    if (keptLinks.length === LIMITS.links) break;
    const n = charsOf(l);
    if (n > room) break;
    keptLinks.push(l);
    room -= n;
  }
  const leftLinks = links.length - keptLinks.length + droppedLinks;
  /** @type {Record<string, any>[]} */
  const kept = [];
  for (const s of sections) {
    if (kept.length === LIMITS.sections) break;
    const n = charsOf(s);
    if (n <= room) { kept.push(s); room -= n; continue; }
    const cut = shrinkSection(s, room);
    if (cut) { kept.push(cut); room -= charsOf(cut); }
    break;
  }
  let leftSections = sections.length - kept.length;
  if (leftSections || leftLinks) {
    // The fold takes the twentieth place, so a twentieth kept section folds with the rest.
    if (kept.length === LIMITS.sections) { kept.pop(); leftSections += 1; }
    const said = [leftSections && plural(leftSections, 'section'), leftLinks && plural(leftLinks, 'link')].filter(Boolean);
    kept.push({ body: `… ${said.join(' and ')}, left out to fit` });
  }
  /** @type {Record<string, any>} */
  const message = { ...head };
  if (kept.length) message.sections = kept;
  if (keptLinks.length) message.links = keptLinks;
  message.source = source;
  return message;
}
