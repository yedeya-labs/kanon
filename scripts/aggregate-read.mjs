#!/usr/bin/env node
// The telemetry Explorer's read of the aggregate (plan 0004 step 14, plan 0002 §6.1): one
// SigV4-signed `GET` to the aggregate-only function's URL, with the invoker role's credentials,
// and the answer checked and written to a file the agent's job reads.
//
// WHAT LEAVES THIS STEP IS WHAT THE FUNCTION MAY PUBLISH, AND NOTHING ELSE. The function answers
// only `cross_adopter` cells (at least three non-declaring adopters each), the `own` cells of
// adopters that declared them publishable, and failure `signals` that count adopters but carry
// no cost or run count (§6.1, items 1 to 3). This step doesn't trust that blindly: an answer
// with any other key, at any level, a field of the wrong type, or a threshold below three is
// refused whole, and the agent doesn't run. What it writes is rebuilt from the checked fields
// alone, so nothing the function might add later reaches the agent before this check knows it.
//
// IN A JOB OF ITS OWN, THE ONLY ONE OF THE LANE WITH `id-token: write` (K-OBS-17's shape, held by
// `tests/unit/helpers/store-jobs.ts`). The credentials are in this job's environment, from
// `aws-actions/configure-aws-credentials`; the agent's job gets the file, never them.
//
// LOGS HOLD COUNTS AND STATUSES, NEVER THE URL OR A FIGURE. The URL is masked by the step before
// the credentials; this script names it only by its variable.
//
//   node "$KANON/scripts/aggregate-read.mjs"
//   env: KANON_AGGREGATE_URL (the stack's `AggregateUrl` output), OUT (a directory, outside the
//        workspace), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN (the invoker
//        role's, from the credentials step), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY
//   writes: $OUT/aggregate.json; outputs `empty` (`true` when there is nothing to look at)
//
// `node:` built-ins only, like every script under scripts/ (`K-SELF-8`).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sign } from '../infra/telemetry/function/sigv4.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** Plan 0002 decision 7: a cross-adopter cell needs at least this many adopters. */
export const MIN_ADOPTERS = 3;
/** The file the agent's job reads. */
export const AGGREGATE_FILE = 'aggregate.json';

const TOP = ['computed_at', 'min_adopters', 'signal_days', 'cross_adopter', 'own', 'signals'];
const CELL = ['lane', 'model', 'runs', 'median_cost_usd', 'p90_cost_usd'];
const OWN = ['label', 'cells'];
const SIGNAL = ['lane', 'reason', 'failed_stage', 'kanon_error', 'kanon_version', 'adopters_affected'];
/** A label as the register holds it (`render.mjs`): the key's pattern. */
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A lane, a reason, a stage or an error code: a short code, never prose. Not the schema's enums,
 * so a lane a later release adds doesn't refuse a whole answer here. */
const CODE = /^[a-z][a-z0-9_-]{0,47}$/;
/** A model and a Kanon version, as the row schema has them (`actions/agent-telemetry/schema.mjs`). */
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}(\[1m\])?$/;
const VERSION = /^(\d+\.\d+\.\d+|dev)$/;

export class AggregateError extends Error {}

/**
 * The function URL's region: `https://<id>.lambda-url.<region>.on.aws/`, and nothing else.
 * @param {string} url
 * @returns {string | null}
 */
export function regionOfAggregateUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) return null;
    return /^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/.exec(u.host)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** @param {unknown} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Exactly these keys, or refused.
 * @param {unknown} v @param {string[]} keys @param {string} at
 * @returns {Record<string, unknown>}
 */
function exactly(v, keys, at) {
  if (!isObject(v)) throw new AggregateError(`${at} is not an object`);
  const o = /** @type {Record<string, unknown>} */ (v);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new AggregateError(`${at} holds ${extra.map((k) => `\`${k}\``).join(', ')}, which the aggregate never answers`);
  const missing = keys.filter((k) => !Object.hasOwn(o, k));
  if (missing.length) throw new AggregateError(`${at} lacks ${missing.map((k) => `\`${k}\``).join(', ')}`);
  return o;
}
/** @param {unknown} v @param {RegExp} re @param {string} at */
const code = (v, re, at) => {
  if (typeof v !== 'string' || !re.test(v)) throw new AggregateError(`${at} is not a code`);
  return v;
};
/** @param {unknown} v @param {RegExp} re @param {string} at */
const codeOrNull = (v, re, at) => (v === null ? null : code(v, re, at));
/** @param {unknown} v @param {string} at @param {boolean} [integer] */
const count = (v, at, integer = true) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) throw new AggregateError(`${at} is not a ${integer ? 'count' : 'figure'}`);
  return v;
};
/** @param {unknown} v @param {string} at */
const list = (v, at) => {
  if (!Array.isArray(v)) throw new AggregateError(`${at} is not a list`);
  return v;
};

/** @param {unknown} v @param {string} at */
const cellOf = (v, at) => {
  const c = exactly(v, CELL, at);
  return {
    lane: code(c.lane, CODE, `${at}.lane`),
    model: code(c.model, MODEL, `${at}.model`),
    runs: count(c.runs, `${at}.runs`),
    median_cost_usd: count(c.median_cost_usd, `${at}.median_cost_usd`, false),
    p90_cost_usd: count(c.p90_cost_usd, `${at}.p90_cost_usd`, false),
  };
};

/**
 * @typedef {{ lane: string, model: string, runs: number, median_cost_usd: number, p90_cost_usd: number }} Cell
 * @typedef {{ lane: string, reason: string | null, failed_stage: string | null, kanon_error: string | null,
 *   kanon_version: string | null, adopters_affected: number }} Signal
 * @typedef {{ computed_at: string, min_adopters: number, signal_days: number, cross_adopter: Cell[],
 *   own: { label: string, cells: Cell[] }[], signals: Signal[] }} Aggregate
 */

/**
 * The function's answer, checked field by field and rebuilt from what was checked. Throws
 * `AggregateError` naming the first problem, and never a value.
 * @param {unknown} body
 * @returns {Aggregate}
 */
export function checkAggregate(body) {
  const a = exactly(body, TOP, 'the answer');
  if (typeof a.computed_at !== 'string' || Number.isNaN(Date.parse(a.computed_at))) throw new AggregateError('`computed_at` is not a time');
  const min = count(a.min_adopters, '`min_adopters`');
  // Plan 0002 decision 7: a function that publishes a cross-adopter cell of fewer than three
  // adopters is refused whole, so its cells never reach the agent.
  if (min < MIN_ADOPTERS) throw new AggregateError(`\`min_adopters\` is below ${MIN_ADOPTERS}, so a cross-adopter cell could combine fewer than ${MIN_ADOPTERS} adopters`);
  const labels = new Set();
  return {
    computed_at: new Date(a.computed_at).toISOString(),
    min_adopters: min,
    signal_days: count(a.signal_days, '`signal_days`'),
    cross_adopter: list(a.cross_adopter, '`cross_adopter`').map((c, i) => cellOf(c, `cross_adopter[${i}]`)),
    own: list(a.own, '`own`').map((v, i) => {
      const o = exactly(v, OWN, `own[${i}]`);
      const label = code(o.label, LABEL, `own[${i}].label`);
      if (labels.has(label)) throw new AggregateError(`own[${i}].label repeats another entry's`);
      labels.add(label);
      return { label, cells: list(o.cells, `own[${i}].cells`).map((c, j) => cellOf(c, `own[${i}].cells[${j}]`)) };
    }),
    signals: list(a.signals, '`signals`').map((v, i) => {
      const s = exactly(v, SIGNAL, `signals[${i}]`);
      return {
        lane: code(s.lane, CODE, `signals[${i}].lane`),
        reason: codeOrNull(s.reason, CODE, `signals[${i}].reason`),
        failed_stage: codeOrNull(s.failed_stage, CODE, `signals[${i}].failed_stage`),
        kanon_error: codeOrNull(s.kanon_error, CODE, `signals[${i}].kanon_error`),
        kanon_version: codeOrNull(s.kanon_version, VERSION, `signals[${i}].kanon_version`),
        adopters_affected: count(s.adopters_affected, `signals[${i}].adopters_affected`),
      };
    }),
  };
}

/** Nothing to look at: no cell and no signal. @param {Aggregate} a */
export const isEmpty = (a) => a.cross_adopter.length === 0 && a.signals.length === 0 && a.own.every((o) => o.cells.length === 0);

/**
 * The read. Returns the checked aggregate; throws `AggregateError` naming what went wrong, with
 * no URL, credential or body in the message.
 * @param {{ url: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch, now?: Date }} o
 * @returns {Promise<Aggregate>}
 */
export async function readAggregate({ url, env, fetchImpl = fetch, now }) {
  const region = regionOfAggregateUrl(url);
  if (!region) throw new AggregateError("KANON_AGGREGATE_URL is not a Lambda function URL (https://<id>.lambda-url.<region>.on.aws/): set it to the telemetry stack's AggregateUrl output");
  const credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '', sessionToken: env.AWS_SESSION_TOKEN };
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new AggregateError('no AWS credentials in the environment: the credentials step for the invoker role did not run');
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: sign({ method: 'GET', url, region, service: 'lambda', credentials, ...(now ? { now } : {}) }) });
  } catch (e) {
    throw new AggregateError(`the aggregate function could not be reached (${e instanceof Error ? e.name : 'error'})`);
  }
  if (res.status !== 200) {
    const why = res.status === 403 ? ': the invoker role was refused. Check that KANON_AGGREGATE_ROLE names this repository\'s `AggregateInvokerRole<id>` output and that the register sets `aggregate_invoker`' : '';
    throw new AggregateError(`the aggregate function answered ${res.status}${why}`);
  }
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new AggregateError('the aggregate function answered something that is not JSON');
  }
  return checkAggregate(body);
}

/** The step summary's line: counts only, never a figure. @param {Aggregate} a */
export const summaryLine = (a) => {
  const own = a.own.reduce((n, o) => n + o.cells.length, 0);
  return `Aggregate computed ${a.computed_at}: ${a.cross_adopter.length} cross-adopter cell(s) (at least ${a.min_adopters} adopters each), ${own} own cell(s) of ${a.own.length} declaring adopter(s), ${a.signals.length} failure signal(s) over ${a.signal_days} days.`;
};

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const out = env.OUT ?? '';
  if (!out) {
    console.log('::error title=aggregate::OUT must name the directory the aggregate is written to');
    process.exit(2);
  }
  try {
    const a = await readAggregate({ url: env.KANON_AGGREGATE_URL ?? '', env });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, AGGREGATE_FILE), `${JSON.stringify(a, null, 2)}\n`);
    const empty = isEmpty(a);
    const line = summaryLine(a) + (empty ? ' Nothing to look at, so the agent does not run.' : '');
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `empty=${empty}\n`);
  } catch (e) {
    const why = e instanceof AggregateError ? e.message : `an unexpected error (${e instanceof Error ? e.name : 'error'})`;
    console.log(`::error title=aggregate::${why}. Nothing was handed to the agent.`);
    process.exit(1);
  }
}
/* c8 ignore stop */
