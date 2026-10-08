// The finding rows a lane's filing step writes for Kanon's telemetry store (plan 0006 §5, steps
// 1 and 2; F3). The Overseer's (`overseer-file.mjs`) and the telemetry Explorer's
// (`telemetry-file.mjs`) filing steps share this, so the two lanes send the same way.
//
// WHEN. Only when the repository's adoption record says `Upstream findings: sent` or `sent with
// evidence` (`K-LAYOUT-10`), as the lane's gate job read it from the default branch before any
// agent ran (`UPSTREAM`): `levelOf` turns that into the row's `evidence_level`. With `drafted` or
// `filed here` nothing here runs, and no artifact is uploaded.
//
// WHAT THE AGENT CHOOSES, AND WHAT IT CAN'T. The agent's report names each finding's codes; a
// code is kept only when it is in the schema's own list (`readUpstream`), so a steered agent can
// choose which codes to send, never send a value outside Kanon's vocabulary. A code it gave that
// isn't is dropped, never sent, and the draft names the field (never the value). A Kanon path
// is kept only when it is a file in the Kanon tree the lane runs from (`kanonFileIn`, `$KANON`,
// the release it pinned): the pattern alone would match an adopter's own `scripts/x.mjs`.
//
// THE TEXT, LEVEL 2 ONLY, THROUGH THE SCRUB (§4.2). `evidence` and `suggested_fix` are
// normalised (no control character but the newline), redacted, cut to the schema's size at the
// last whole line (`cutText`, §2.2), then verified with the same rules and context. FAIL CLOSED:
// if `verify` still fires, if the lane's own check refuses the text, if the scrub's context
// couldn't be read, or if the row then fails `validate`, the finding is sent at `codes`, without
// the text, and the draft says the text was withheld and why. Text is never sent on a guess.
//
// WHAT IS WRITTEN. Every row passes `validate` before it is written; one that doesn't is not
// sent, and the draft names its fields. At most `MAX_FINDINGS` (20) a run, the first ones; the
// draft of each one after says it was held back. The rows go into one file,
// `FINDING_ARTIFACT_FILE` (`kanon-finding.json`), which the lane's next step uploads as
// `findingArtifactName(reporter, run id, attempt)`, the artifact the telemetry collector lists and
// sends (plan 0006 §5, step 3; F4). Both come from `telemetry-artifacts.mjs`, which the collector
// reads them from too, so the two can't drift.
//
// `node:` builtins only, like every script under scripts/ (`K-SELF-8`).

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { kanonVersion } from '../../actions/agent-telemetry/agent-telemetry.mjs';
import { FIX_CATEGORIES, KANON_ERRORS, LANES, MAX_FINDINGS, REASONS, RULE_IDS, SCHEMAS, STAGES, TAGS, describeErrors, validate } from '../../actions/agent-telemetry/schema.mjs';
import { KANON_PATH, RULE_NAMES, SCRUB_VERSION, redact, verify } from '../../actions/agent-telemetry/scrub.mjs';

import { FINDING_ARTIFACT_FILE, FINDING_ARTIFACT_PREFIX, findingArtifactName } from './telemetry-artifacts.mjs';

// The artifact's name and file are the collector's (plan 0006 §5, step 3), so a lane and the
// collector can't disagree on them.
export { FINDING_ARTIFACT_FILE, FINDING_ARTIFACT_PREFIX, findingArtifactName };

/** A finding field's `max`, the schema's own. @param {string} name */
const maxOf = (name) => /** @type {Record<string, { max: number }>} */ (/** @type {unknown} */ (SCHEMAS.finding?.[1] ?? {}))[name]?.max ?? 0;
/** The most rule ids and Kanon paths a row carries (decision 10). */
const MAX_RULES = maxOf('rules');
const MAX_PATHS = maxOf('kanon_paths');
/** The two texts' sizes after the scrub (§2.2). */
const MAX_TEXT = { evidence: maxOf('evidence'), suggested_fix: maxOf('suggested_fix') };
/** The mark a cut text ends with (§2.2), which the scrub reads as a placeholder. */
const CUT = '[cut]';
/** A SHA-256, as the gate job hands the App register's names on. */
const HASH = /^[0-9a-f]{64}$/;

/**
 * @typedef {'codes' | 'evidence'} Level
 * @typedef {{ lane?: string, failed_stage?: string, kanon_error?: string, reason?: string,
 *   rules?: string[], kanon_paths?: string[], fix_category: string }} Codes
 * @typedef {{ codes: Codes, dropped: string[], evidence: string, suggested_fix: string }} Upstream
 * @typedef {Upstream & { subject: string, kanon_version?: string }} Item
 * @typedef {{ run: { id: number, attempt: number }, tag: string, recordedAt: string, kanonVersion: string,
 *   actor?: string, nameHashes: string[] | null, isKanonFile: (path: string) => boolean,
 *   write: (rows: Record<string, unknown>[]) => void }} Send
 * @typedef {{ index?: number, level?: Level, row?: Record<string, unknown>, fired?: string[],
 *   withheld?: string, error?: string, held?: boolean, dropped: string[] }} Outcome
 */

/**
 * The row's level for the gate job's `UPSTREAM`, or null when the repository sends nothing.
 * @param {string | undefined} value
 * @returns {Level | null}
 */
export function levelOf(value) {
  const v = String(value ?? '').trim();
  if (v === 'sent') return 'codes';
  if (v === 'sent with evidence') return 'evidence';
  return null;
}

/**
 * Whether a path is a file in the Kanon tree at `root` (§2.1): it matches the row's pattern,
 * which refuses a `.` or `..` segment, and is a file there.
 * @param {string | undefined} root
 * @returns {(path: string) => boolean}
 */
export const kanonFileIn = (root) => (path) => {
  if (!root || !KANON_PATH.test(path)) return false;
  return statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true;
};

/** @param {unknown} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text a row may carry: no control character but the newline, a tab as two spaces. */
const normalise = (/** @type {string} */ t) =>
  // eslint-disable-next-line no-control-regex
  t.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, '').trim();

/**
 * The agent's `upstream` object, held to Kanon's vocabulary (§5, step 2). Each code is kept only
 * when it is in the schema's list; one that isn't is dropped and its FIELD named in `dropped`. A
 * fix category outside the list, or none, is `other`, since a row needs one. Anything that isn't
 * an object reads as no codes at all.
 * @param {unknown} raw
 * @param {(path: string) => boolean} isKanonFile
 * @returns {Upstream}
 */
export function readUpstream(raw, isKanonFile) {
  const o = /** @type {Record<string, unknown>} */ (isObject(raw) ? raw : {});
  /** @type {string[]} */
  const dropped = [];
  /** @type {Record<string, unknown>} */
  const codes = {};
  const given = (/** @type {string} */ k) => o[k] !== undefined && o[k] !== null && o[k] !== '';
  for (const [field, list] of /** @type {const} */ ([['lane', LANES], ['failed_stage', STAGES], ['kanon_error', KANON_ERRORS], ['reason', REASONS]])) {
    if (!given(field)) continue;
    if (typeof o[field] === 'string' && /** @type {readonly string[]} */ (list).includes(/** @type {string} */ (o[field]))) codes[field] = o[field];
    else dropped.push(field);
  }
  for (const [field, keep, max] of /** @type {const} */ ([
    ['rules', (/** @type {string} */ x) => RULE_IDS.includes(x), MAX_RULES],
    ['kanon_paths', isKanonFile, MAX_PATHS],
  ])) {
    if (!given(field)) continue;
    const v = o[field];
    const items = Array.isArray(v) ? v : [];
    const kept = [...new Set(items.filter((x) => typeof x === 'string' && keep(x)))];
    if (!Array.isArray(v) || kept.length !== items.length || kept.length > max) dropped.push(field);
    if (kept.length) codes[field] = kept.slice(0, max);
  }
  if (typeof o.fix_category === 'string' && FIX_CATEGORIES.includes(o.fix_category)) codes.fix_category = o.fix_category;
  else {
    codes.fix_category = 'other';
    if (given('fix_category')) dropped.push('fix_category');
  }
  const text = (/** @type {string} */ k) => (typeof o[k] === 'string' ? normalise(/** @type {string} */ (o[k])) : '');
  return { codes: /** @type {Codes} */ (codes), dropped, evidence: text('evidence'), suggested_fix: text('suggested_fix') };
}

/**
 * A text cut to `max` code points (§2.2): at the last whole line that fits with the mark after it,
 * or inside the first line when even that is too long. Text within the limit is unchanged.
 * @param {string} text
 * @param {number} max
 */
export function cutText(text, max) {
  if ([...text].length <= max) return text;
  const room = max - CUT.length - 1;
  let out = '';
  for (const line of text.split('\n')) {
    const next = out === '' ? line : `${out}\n${line}`;
    if ([...next].length > room) break;
    out = next;
  }
  if (out.trim() === '') out = [...text].slice(0, room).join('');
  return `${out.trimEnd()}\n${CUT}`;
}

/**
 * One text through the scrub: redacted, cut, then verified with the same context and the lane's
 * own check. Returns the text, or why it is withheld.
 * @param {string} raw
 * @param {number} max
 * @param {import('../../actions/agent-telemetry/scrub.mjs').Context} context
 * @param {((text: string) => string | null) | undefined} check
 * @returns {{ text: string, fired: string[] } | { withheld: string }}
 */
function scrubbed(raw, max, context, check) {
  const { text, fired } = redact(raw, context);
  const cut = cutText(text.trim(), max);
  const still = verify(cut, context);
  if (still.length) return { withheld: `the scrub's ${still.map((r) => `\`${r}\``).join(', ')} rule${still.length > 1 ? 's' : ''} still fired on it` };
  const problem = check?.(cut);
  if (problem) return { withheld: problem };
  return { text: cut, fired };
}

/**
 * The finding rows for one run (§5, step 1), and what happened to each item, in order.
 * `context` is the scrub's (§4.2), used only at `evidence`; `contextProblem` says why it couldn't
 * be read, which withholds every text. `check` is the lane's own test of a scrubbed text.
 * @param {{ reporter: string, level: Level, items: Item[], send: Pick<Send, 'run' | 'tag' | 'recordedAt' | 'kanonVersion'>,
 *   context?: import('../../actions/agent-telemetry/scrub.mjs').Context, contextProblem?: string,
 *   check?: (text: string) => string | null }} o
 * @returns {{ rows: Record<string, unknown>[], outcomes: Outcome[] }}
 */
export function buildRows({ reporter, level, items, send, context = {}, contextProblem, check }) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {Outcome[]} */
  const outcomes = [];
  for (const item of items) {
    if (rows.length >= MAX_FINDINGS) {
      outcomes.push({ held: true, dropped: item.dropped });
      continue;
    }
    const index = rows.length;
    const c = item.codes;
    /** @type {Record<string, unknown>} */
    const codes = {
      schema_version: 1, row_kind: 'finding', tag: send.tag, recorded_at: send.recordedAt,
      run_id: send.run.id, run_attempt: send.run.attempt, finding_index: index,
      reporter, subject: item.subject,
      ...(c.lane ? { lane: c.lane } : {}), ...(c.failed_stage ? { failed_stage: c.failed_stage } : {}),
      ...(c.kanon_error ? { kanon_error: c.kanon_error } : {}), ...(c.reason ? { reason: c.reason } : {}),
      kanon_version: item.kanon_version ?? send.kanonVersion,
      ...(c.rules?.length ? { rules: c.rules.join(',') } : {}),
      ...(c.kanon_paths?.length ? { kanon_paths: c.kanon_paths.join(',') } : {}),
      fix_category: c.fix_category,
      evidence_level: 'codes',
    };
    /** @type {Outcome} */
    const outcome = { index, dropped: item.dropped };
    /** @type {Record<string, unknown> | null} */
    let row = codes;
    if (level === 'evidence' && (item.evidence || item.suggested_fix)) {
      if (contextProblem) outcome.withheld = contextProblem;
      else {
        /** @type {Record<string, string>} */
        const texts = {};
        /** @type {string[]} */
        const fired = [];
        for (const k of /** @type {const} */ (['evidence', 'suggested_fix'])) {
          if (!item[k] || outcome.withheld) continue;
          const s = scrubbed(item[k], MAX_TEXT[k], context, check);
          if ('withheld' in s) outcome.withheld = s.withheld;
          else { texts[k] = s.text; fired.push(...s.fired.filter((r) => !fired.includes(r))); }
        }
        if (!outcome.withheld) {
          const withText = { ...codes, evidence_level: 'evidence', ...texts, scrub_version: SCRUB_VERSION };
          const v = validate(withText);
          if (v.ok) { row = withText; outcome.fired = RULE_NAMES.filter((r) => fired.includes(r)); } else outcome.withheld = `the row with its text failed the schema: ${describeErrors(v.errors)}`;
        }
      }
    }
    const v = validate(row);
    if (!v.ok) { outcomes.push({ ...outcome, index: undefined, error: describeErrors(v.errors) }); continue; }
    rows.push(row);
    outcomes.push({ ...outcome, level: /** @type {Level} */ (row.evidence_level), row });
  }
  return { rows, outcomes };
}

/** A fence longer than any run of backticks in the text, so the text shows exactly. */
const fenced = (/** @type {string} */ text) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

/** The codes a row carries, as the draft lists them. */
const CODE_FIELDS = ['subject', 'lane', 'failed_stage', 'kanon_error', 'reason', 'kanon_version', 'rules', 'kanon_paths', 'fix_category'];

/**
 * What a draft shows of a finding sent to Kanon (§3.1): exactly what was sent, the codes and, at
 * level 2, the text after the scrub; or why it wasn't, or why its text was withheld.
 * @param {Outcome} o
 * @returns {string}
 */
export function renderSent(o) {
  if (o.held) return `**Not sent to Kanon:** a run sends at most ${MAX_FINDINGS} findings, and this one came after them.`;
  if (o.error !== undefined || !o.row) return `**Not sent to Kanon:** its row failed the schema (${o.error ?? 'unknown'}).`;
  const row = o.row;
  const codes = CODE_FIELDS.filter((k) => Object.hasOwn(row, k)).map((k) => `\`${k}: ${row[k]}\``);
  const out = [`**Sent to Kanon** as finding row ${o.index} of this run, at \`${o.level}\` level. Its codes: ${codes.join(', ')}.`];
  if (o.dropped.length) out.push('', `Not sent, outside Kanon's vocabulary: ${o.dropped.map((d) => `\`${d}\``).join(', ')}.`);
  if (o.withheld) out.push('', `The evidence and suggested fix were withheld, and the finding was sent as codes only: ${o.withheld}.`);
  if (typeof row.evidence === 'string') out.push('', 'Its evidence, as sent:', '', fenced(row.evidence));
  if (typeof row.suggested_fix === 'string') out.push('', 'Its suggested fix, as sent:', '', fenced(row.suggested_fix));
  return out.join('\n');
}

/**
 * What a draft says when the rows couldn't be written: nothing of this run was sent.
 * @param {string} why
 */
export const notWritten = (why) => `**Not sent to Kanon:** the finding rows could not be written (${why}), so nothing of this run was sent.`;

/**
 * The sentence that says what was sent, at which level, and who reads it (§3.1).
 * @param {Level} level
 */
export function sentSentence(level) {
  const value = level === 'codes' ? 'sent' : 'sent with evidence';
  const what = level === 'codes'
    ? 'as the codes shown under it and no text'
    : 'as the codes shown under it and its evidence and suggested fix exactly as shown, after the scrub';
  const readers = level === 'codes'
    ? 'Kanon\'s operator\'s private job reads it'
    : 'Kanon\'s operator\'s private job reads it, and the text is read by Kanon\'s maintainer and by a third-party decision provider, which decides whether a finding becomes a public Kanon issue holding the codes alone';
  return `This repository's adoption record says \`Upstream findings: ${value}\` (K-LAYOUT-10). Each finding marked "Sent to Kanon" was also written as a finding row for Kanon's telemetry store, ${what}. This repository's telemetry collector sends the row to Kanon from this run's artifact on its next sweep. Once sent, ${readers}. Nothing here was filed.`;
}

/**
 * The lane's run, for its rows, from the filing job's environment: the run and attempt, the tag
 * (`TAG`, `run` unless a smoke run says otherwise), the Kanon release the job's workflow is
 * (`kanonVersion` of `job.workflow_sha` and `job.workflow_ref`, as the telemetry row reads it),
 * the App register's names the gate job hashed (`APP_NAME_HASHES`: hashes, `none`, or nothing
 * when it couldn't read them), Kanon's tree (`KANON`), and where to write the rows
 * (`FINDINGS_PATH`, a file named `FINDING_ARTIFACT_FILE`, or the write throws), counting them in the step's `finding-rows` output for the upload.
 * @param {Record<string, string | undefined>} env
 * @param {() => string} [now]
 * @returns {Send}
 */
export function sendFromEnv(env, now = () => new Date().toISOString()) {
  const names = String(env.APP_NAME_HASHES ?? '').trim();
  const hashes = names === 'none' ? [] : names.split(',').map((h) => h.trim()).filter(Boolean);
  const tag = String(env.TAG ?? '').trim();
  const sha = String(env.KANON_WORKFLOW_SHA ?? '').trim();
  return {
    run: { id: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    tag: TAGS.includes(tag) ? tag : 'run',
    recordedAt: now(),
    kanonVersion: kanonVersion(sha, env.KANON_WORKFLOW_REF ?? '', sha),
    actor: env.GITHUB_ACTOR ?? '',
    nameHashes: names !== '' && hashes.every((h) => HASH.test(h)) ? hashes : null,
    isKanonFile: kanonFileIn(env.KANON),
    write: (rows) => {
      const at = env.FINDINGS_PATH;
      if (!at) throw new Error('FINDINGS_PATH is not set');
      if (basename(at) !== FINDING_ARTIFACT_FILE) throw new Error(`FINDINGS_PATH must name ${FINDING_ARTIFACT_FILE}, the file the collector reads`);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, JSON.stringify(rows));
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `finding-rows=${rows.length}\n`);
    },
  };
}
