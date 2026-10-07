// Jev, TypeSafe's typed decision model, asked whether a private upstream finding is worth a public
// Kanon issue (plan 0006 §7, step F6). Public, in Kanon; the private #41 job imports it and is the
// only caller. This file holds no key and files nothing.
//
// WHAT JEV DECIDES, AND WHAT IT DOESN'T (§7.1). Whether a finding is SAFE to publish is settled
// before Jev is asked, by the job's deterministic gate; this module adds one more piece of it:
// `buildRequest` refuses a request that holds an adopter key, before anything is sent. Jev judges
// only whether a finding is WORTH publishing, and nothing it answers can make an unsafe one public.
//
// THE QUESTIONS (§7.2), one call per signature:
//   - a Choice, `kind`: Kanon bug, adopter configuration, platform or unclear. Only Kanon bug can
//     be promoted;
//   - a Noul, `actionable`: "a maintainer can act on this without asking the adopter".
//
// FAILING CLOSED (§7.3). `decide` answers `promote` only when the Choice is Kanon bug with a
// confidence of at least `THRESHOLD`, and the Noul is affirmed with at least `THRESHOLD`. Every
// other case is `keep`, with a reason for the job's ledger: a network error, a timeout or a non-2xx
// answer; a body that doesn't parse or lacks either answer; another Choice; a Noul not affirmed; a
// confidence under the threshold, or none at all. `judge` never throws once the request is built.
//
// THE WIRE, from TypeSafe's API reference (docs.typesafe.ai/api.md, read 2026-10-07):
//   POST https://api.typesafe.ai/v1/systemone, `Authorization: Bearer <key>`, JSON
//   in:  { model, state, questions: { <id>: { type: 'choice' | 'noul', instructions, criteria } } }
//   out: { model, answers: { <id>: <answer> }, usage }, where a Choice answer is
//        { type: 'choice', choice, probabilities, confidence? } and a Noul answer is
//        { type: 'noul', noul }, the probability of yes.
// A Noul has no confidence field: "the single `noul` value describes it completely". So a Noul is
// affirmed when `noul` is at least 0.5, and its confidence is the probability of the side it took,
// `max(noul, 1 - noul)`. Promotion therefore needs `noul >= THRESHOLD`. Both shapes are pinned by
// the fixtures under tests/fixtures/jev/, so a change in either fails a test, not a promotion.
//
// `node:` built-ins and the runtime's global `fetch` only, like every script under scripts/ (`K-SELF-8`).

import { assertNoKey } from '../../infra/telemetry/function/aggregate.mjs';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
/** Both answers must reach this confidence before a finding is promoted (Owner decision 20). */
export const THRESHOLD = 0.90;
/** The call's whole budget, in milliseconds (§7.3). */
export const TIMEOUT_MS = 30_000;

/** The Choice's options. Only `kanon_bug` can be promoted. */
export const KINDS = Object.freeze(['kanon_bug', 'adopter_configuration', 'platform', 'unclear']);
export const PROMOTABLE = 'kanon_bug';

/** The two questions, as sent. Their ids are for code; TypeSafe never shows them to the model. */
export const QUESTIONS = Object.freeze({
  kind: Object.freeze({
    type: 'choice',
    instructions: 'This is a problem report about Kanon, a framework that runs AI agents in GitHub Actions for the repositories '
      + 'that adopt it. The report was found in one or more adopting repositories, in Kanon\'s own vocabulary: the lane, the stage, '
      + 'the error and reason codes, the Kanon release, the Kanon rules and files involved, and, when present, a description '
      + 'written for a Kanon maintainer. What is the cause of the problem?',
    criteria: Object.freeze({
      kanon_bug: 'A defect in Kanon itself, in its code, workflows, rules, defaults or documentation, that a change to Kanon would fix.',
      adopter_configuration: 'The adopting repository\'s own setup, choices, secrets, permissions or content cause it, and the adopter would fix it.',
      platform: 'GitHub, the model provider or another service outside Kanon failed or limited the run: an outage, a rate limit, a quota.',
      unclear: 'The report does not say enough to tell which of the others it is.',
    }),
  }),
  actionable: Object.freeze({
    type: 'noul',
    instructions: 'A Kanon maintainer can act on this report as it stands, without asking the adopting repository for anything more.',
    criteria: Object.freeze({
      true: 'The report names what went wrong and where in Kanon well enough to reproduce or fix it.',
      false: 'Acting on it would need more from the adopter: their configuration, their logs, their content or an answer to a question.',
    }),
  }),
});

/** The signature's fields (plan 0006 §2.4), read from a finding as they are. */
const SIGNATURE = /** @type {const} */ (['lane', 'failed_stage', 'kanon_error', 'reason', 'kanon_version']);

/**
 * One finding row in plan 0006 §2.1's shape, as far as this module reads it. Every other field,
 * a run id, a time, a finding index, is never read, so it can't reach the request.
 * @typedef {{ reporter?: string, subject?: string, lane?: string | null, failed_stage?: string | null,
 *   kanon_error?: string | null, reason?: string | null, kanon_version?: string, rules?: string[],
 *   kanon_paths?: string[], fix_category?: string, evidence_level?: string, evidence?: string,
 *   suggested_fix?: string } & Record<string, unknown>} Finding
 * @typedef {{ classification?: string, runs?: number, adopters?: number } & Record<string, unknown>} Signal
 * @typedef {{ findings: Finding[], signal?: Signal | null, adopters?: number }} Input
 * @typedef {{ model: string, state: Record<string, unknown>, questions: typeof QUESTIONS }} JevRequest
 * @typedef {{ ok: true, choice: string, choice_confidence: number | null, noul: number }
 *   | { ok: false, reason: string }} Parsed
 * @typedef {{ call: 'promote' | 'keep', reason: string, choice: string | null, choice_confidence: number | null,
 *   noul: number | null, noul_confidence: number | null }} Decision
 */

/** A sorted list of the distinct strings among `lists`. */
const union = (/** @type {unknown[][]} */ lists) =>
  [...new Set(lists.flat().filter((x) => typeof x === 'string'))].sort();

/** Every string inside `value`, and every word of each, so a key inside a text is found as a value. */
function wordsOf(/** @type {unknown} */ value, /** @type {string[]} */ out = []) {
  if (typeof value === 'string') out.push(value, ...value.split(/[^A-Za-z0-9_-]+/).filter(Boolean));
  else if (value && typeof value === 'object') for (const v of Object.values(value)) wordsOf(v, out);
  return out;
}

/**
 * The request for one signature's findings (§7.2): its signature fields, its Kanon vocabulary, its
 * signal's counts and classification when there is one, the number of adopters, and the level-2
 * findings' scrubbed evidence and suggested fix. Never a key, a repository, a run id or a date:
 * only the fields named here are read.
 *
 * Throws, before anything is sent, when `keys` isn't given, or when any string in the request,
 * or any word of one, is an adopter key (`assertNoKey`).
 * @param {Input} input
 * @param {{ keys: Set<string>, model?: string }} options every adopter key the job knows
 * @returns {JevRequest}
 */
export function buildRequest(input, { keys, model = MODEL }) {
  if (!(keys instanceof Set)) throw new Error('jev: no adopter keys to check the request against; nothing is sent');
  const findings = Array.isArray(input?.findings) ? input.findings : [];
  const first = findings[0];
  if (!first) throw new Error('jev: no finding to ask about');
  /** @type {Record<string, unknown>} */
  const state = {};
  for (const f of SIGNATURE) state[f] = first[f] ?? null;
  state.reporters = union(findings.map((f) => [f.reporter]));
  state.subjects = union(findings.map((f) => [f.subject]));
  state.rules = union(findings.map((f) => f.rules ?? []));
  state.kanon_paths = union(findings.map((f) => f.kanon_paths ?? []));
  state.fix_categories = union(findings.map((f) => [f.fix_category]));
  state.findings = findings.length;
  state.adopters = typeof input.adopters === 'number' ? input.adopters : null;
  const s = input.signal;
  state.signal = s ? { classification: s.classification ?? null, runs: s.runs ?? null, adopters: s.adopters ?? null } : null;
  state.evidence = findings.filter((f) => f.evidence_level === 'evidence' && (f.evidence || f.suggested_fix))
    .map((f) => ({ evidence: f.evidence ?? null, suggested_fix: f.suggested_fix ?? null }));
  const request = { model, state, questions: QUESTIONS };
  assertNoKey(wordsOf(request), keys);
  return request;
}

/** A number from 0 to 1, or undefined when `v` isn't one. */
const unit = (/** @type {unknown} */ v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read TypeSafe's answer body, as text, into the two answers. The one place the response's shape
 * is known: a body that doesn't parse, or lacks either answer in its documented shape, is
 * `{ ok: false }` with the reason.
 * @param {string} text
 * @returns {Parsed}
 */
export function parseResponse(text) {
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed_body' };
  }
  const answers = isRecord(body) ? body.answers : undefined;
  if (!isRecord(answers)) return { ok: false, reason: 'no_answers' };
  const kind = answers.kind;
  if (!isRecord(kind) || kind.type !== 'choice' || typeof kind.choice !== 'string') return { ok: false, reason: 'no_choice' };
  if (kind.confidence !== undefined && unit(kind.confidence) === undefined) return { ok: false, reason: 'no_choice' };
  const actionable = answers.actionable;
  const noul = isRecord(actionable) && actionable.type === 'noul' ? unit(actionable.noul) : undefined;
  if (noul === undefined) return { ok: false, reason: 'no_noul' };
  return { ok: true, choice: kind.choice, choice_confidence: unit(kind.confidence) ?? null, noul };
}

/**
 * Promote or keep, failing closed (§7.3).
 * @param {Parsed} parsed
 * @param {{ threshold?: number }} [options]
 * @returns {Decision}
 */
export function decide(parsed, { threshold = THRESHOLD } = {}) {
  if (!parsed.ok) return { call: 'keep', reason: parsed.reason, choice: null, choice_confidence: null, noul: null, noul_confidence: null };
  const { choice, choice_confidence: choiceConfidence, noul } = parsed;
  const affirmed = noul >= 0.5;
  const noulConfidence = affirmed ? noul : 1 - noul;
  const seen = { choice, choice_confidence: choiceConfidence, noul, noul_confidence: noulConfidence };
  const keep = (/** @type {string} */ reason) => ({ call: /** @type {const} */ ('keep'), reason, ...seen });
  if (choice !== PROMOTABLE) return keep(`choice_${KINDS.includes(choice) ? choice : 'unknown'}`);
  if (choiceConfidence === null) return keep('no_confidence');
  if (choiceConfidence < threshold) return keep('low_choice_confidence');
  if (!affirmed) return keep('noul_not_affirmed');
  if (noulConfidence < threshold) return keep('low_noul_confidence');
  return { call: 'promote', reason: 'kanon_bug', ...seen };
}

/** A failed or abandoned call: the timeout's abort, or any other error on the way. */
const unreached = (/** @type {unknown} */ e) => {
  const name = /** @type {{ name?: string } | undefined} */ (e)?.name;
  return { ok: /** @type {const} */ (false), reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error' };
};

/**
 * Post one request to Jev. Never throws: a missing key, a network error, a timeout or a non-2xx
 * answer is `{ ok: false }` with the reason, and no key is sent anywhere but `ENDPOINT`.
 * @param {JevRequest} request
 * @param {{ apiKey?: string, fetch?: typeof globalThis.fetch, timeoutMs?: number, endpoint?: string }} options
 * @returns {Promise<Parsed>}
 */
export async function call(request, { apiKey, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, endpoint = ENDPOINT }) {
  if (!apiKey) return { ok: false, reason: 'no_provider_key' };
  /** @type {Response} */
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return unreached(e);
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };
  try {
    return parseResponse(await res.text());
  } catch (e) {
    return unreached(e);
  }
}

/**
 * Build, call and decide, for one signature. Throws only where `buildRequest` does, before any
 * call; every later failure is `keep`.
 * @param {Input} input
 * @param {{ keys: Set<string>, apiKey?: string, fetch?: typeof globalThis.fetch, timeoutMs?: number, threshold?: number }} options
 * @returns {Promise<Decision>}
 */
export async function judge(input, { keys, apiKey, fetch, timeoutMs, threshold }) {
  const request = buildRequest(input, { keys });
  return decide(await call(request, { apiKey, fetch, timeoutMs }), { threshold });
}
