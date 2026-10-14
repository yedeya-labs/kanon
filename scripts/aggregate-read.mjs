#!/usr/bin/env node
// The telemetry Explorer's read of the aggregate (plan 0004 step 14, plan 0002 §6.1): one `GET`
// to the aggregate-only function's URL, and the answer checked and written to a file the agent's
// job reads.
//
// TWO WAYS IN (plan 0008 §3.6, §9, step J5). From vM the Explorer calls the function's token URL
// with a fresh GitHub OIDC token for the store's audience (`token`, below, through
// `scripts/lib/telemetry-token.mjs`), and holds no AWS credential. The SigV4 way, signed with an
// invoker role's credentials, stays for the overlap: Kanon's metrics page (`page`) reads through
// it until it moves in a pull request of its own after vM's deploy (J7), and the release after vM
// removes it (J9).
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
// `tests/unit/helpers/store-jobs.ts`). The token is minted in this job, masked before anything
// prints, and never written; the agent's job gets the file, never a token or a credential.
//
// LOGS HOLD COUNTS, STATUSES AND THE STORE'S CODES, NEVER A TOKEN OR A FIGURE. A self-hosted
// store's URL is masked before the first request; the hosted one is in the public tree.
//
//   node "$KANON/scripts/aggregate-read.mjs" check   the lane's gate: is there a store to call?
//   env: KANON_AGGREGATE_TOKEN_URL, KANON_TELEMETRY_AUDIENCE (a self-hosted store's `AggregateTokenUrl`
//        output and `Audience` parameter, together, or neither for Kanon's hosted store)
//   prints: `true`, or `false` while the hosted URL is not published; exits 1 naming a variable
//        given alone or of the wrong shape
//
//   node "$KANON/scripts/aggregate-read.mjs" token   the Explorer's `aggregate` job
//   env: the two above, OUT (a directory, outside the workspace), ACTIONS_ID_TOKEN_REQUEST_URL and
//        ACTIONS_ID_TOKEN_REQUEST_TOKEN (the runner's, with `id-token: write`), GITHUB_OUTPUT,
//        GITHUB_STEP_SUMMARY
//   writes: $OUT/aggregate.json; outputs `empty` (`true` when there is nothing to look at)
//
//   node "$KANON/scripts/aggregate-read.mjs"         the SigV4 way, for a caller below vM
//   env: KANON_AGGREGATE_URL (the stack's `AggregateUrl` output), OUT, AWS_ACCESS_KEY_ID,
//        AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN (the invoker role's, from the credentials step)
//
// THE METRICS PAGE'S READ (plan 0003 M7, kanon#661): `node "$KANON/scripts/aggregate-read.mjs"
// page` asks the same function for its page view (`?view=page`), the declaring adopters' work-item
// indicators, checks it as strictly (`checkPage`: exactly the page view's keys, codes, dates,
// versions and numbers, no text, a threshold of three, one adopter per entry) and writes
// $OUT/page.json, which the page job renders (`.github/scripts/metrics-page.mjs`). It signs with
// SigV4 until J7 moves the metrics page to the token (plan 0008 §9 step 4a).
//
// `node:` built-ins only, like every script under scripts/ (`K-SELF-8`).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sign } from '../infra/telemetry/function/sigv4.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { HOSTED_AGGREGATE_URL, TokenError, codeOf, runnerMask, storeOf, storeRequest } from './lib/telemetry-token.mjs';

/** Plan 0002 decision 7: a cross-adopter cell needs at least this many adopters. */
export const MIN_ADOPTERS = 3;
/** The file the agent's job reads. */
export const AGGREGATE_FILE = 'aggregate.json';
/** The file the metrics page's job reads (plan 0003 M7). */
export const PAGE_FILE = 'page.json';

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

// ── The page view (plan 0003 M7) ──────────────────────────────────────────────────────────────

const PAGE_TOP = ['computed_at', 'view', 'min_adopters', 'band_version', 'cost_basis', 'window_days', 'trend_windows', 'minimum', 'bootstrap', 'own'];
const PAGE_ENTRY = ['label', 'adopters', 'window', 'headline', 'trend', 'by_version'];
/** Every key the page view's figures use, at any depth below an entry: bands, indicators, estimates, windows and versions. */
const PAGE_KEYS = new Set([
  'S', 'M', 'L', 'XL', 'none', 'noPr', 'pooled', 'bandMix',
  'view', 'validity', 'cost', 'yield', 'escape', 'd30', 'd90', 'approval', 'correction', 'cells', 'merged_from', 'merged_until',
  'median', 'p90', 'rate', 'status', 'n', 'value', 'low', 'high', 'minimum', 'tau',
  'window', 'from', 'until', 'days', 'versionsIntroduced', 'versions', 'version', 'items', 'fewer', 'unversioned',
]);
/** The only strings a figure may hold: an estimate's or a check's status, the view, a date, a Kanon version. */
const PAGE_STRING = /^(ok|not-enough-data|no-spend|valid|invalid|banded|pooled|\d{4}-\d{2}-\d{2}|\d+\.\d+\.\d+|dev)$/;

/**
 * A figure tree, checked and copied: objects with only `PAGE_KEYS`, lists, finite numbers, null,
 * and `PAGE_STRING` strings. Throws naming the path, never the value.
 * @param {unknown} v @param {string} at
 * @returns {unknown}
 */
function figuresOf(v, at) {
  if (v === null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new AggregateError(`${at} is not a figure`);
    return v;
  }
  if (typeof v === 'string') {
    if (!PAGE_STRING.test(v)) throw new AggregateError(`${at} is not a code`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => figuresOf(x, `${at}[${i}]`));
  if (!isObject(v)) throw new AggregateError(`${at} is not a figure, a code, a list or an object`);
  const o = /** @type {Record<string, unknown>} */ (v);
  const extra = Object.keys(o).filter((k) => !PAGE_KEYS.has(k));
  if (extra.length) throw new AggregateError(`${at} holds ${extra.map((k) => `\`${k}\``).join(', ')}, which the page view never answers`);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, figuresOf(x, `${at}.${k}`)]));
}

/**
 * The page view's answer, checked and rebuilt from what was checked. Throws `AggregateError`
 * naming the first problem, and never a value.
 * @param {unknown} body
 * @returns {Record<string, any>}
 */
export function checkPage(body) {
  const a = exactly(body, PAGE_TOP, 'the answer');
  if (a.view !== 'page') throw new AggregateError('the answer is not the page view');
  if (typeof a.computed_at !== 'string' || Number.isNaN(Date.parse(a.computed_at))) throw new AggregateError('`computed_at` is not a time');
  const min = count(a.min_adopters, '`min_adopters`');
  if (min < MIN_ADOPTERS) throw new AggregateError(`\`min_adopters\` is below ${MIN_ADOPTERS}, so a figure could combine fewer than ${MIN_ADOPTERS} adopters`);
  if (a.cost_basis !== 'API list price') throw new AggregateError('`cost_basis` is not the API list price');
  const minimum = exactly(a.minimum, ['median', 'p90', 'proportion', 'yield', 'escape', 'validity'], '`minimum`');
  const bootstrap = exactly(a.bootstrap, ['resamples', 'seed'], '`bootstrap`');
  const labels = new Set();
  return {
    computed_at: new Date(a.computed_at).toISOString(),
    view: 'page',
    min_adopters: min,
    band_version: count(a.band_version, '`band_version`'),
    cost_basis: a.cost_basis,
    window_days: count(a.window_days, '`window_days`'),
    trend_windows: count(a.trend_windows, '`trend_windows`'),
    minimum: Object.fromEntries(Object.entries(minimum).map(([k, v]) => [k, count(v, `minimum.${k}`)])),
    bootstrap: { resamples: count(bootstrap.resamples, 'bootstrap.resamples'), seed: count(bootstrap.seed, 'bootstrap.seed') },
    own: list(a.own, '`own`').map((v, i) => {
      const o = exactly(v, PAGE_ENTRY, `own[${i}]`);
      const label = code(o.label, LABEL, `own[${i}].label`);
      if (labels.has(label)) throw new AggregateError(`own[${i}].label repeats another entry's`);
      labels.add(label);
      // An entry is one adopter's own figures (plan 0002 §6.1, item 2), never a combination.
      if (o.adopters !== 1) throw new AggregateError(`own[${i}].adopters is not 1, and an entry is one adopter's own figures`);
      return {
        label,
        adopters: 1,
        window: figuresOf(o.window, `own[${i}].window`),
        headline: figuresOf(o.headline, `own[${i}].headline`),
        trend: figuresOf(list(o.trend, `own[${i}].trend`), `own[${i}].trend`),
        by_version: figuresOf(o.by_version, `own[${i}].by_version`),
      };
    }),
  };
}

/** Nothing to look at: no cell and no signal. @param {Aggregate} a */
export const isEmpty = (a) => a.cross_adopter.length === 0 && a.signals.length === 0 && a.own.every((o) => o.cells.length === 0);

/**
 * The read. Returns the checked aggregate; throws `AggregateError` naming what went wrong, with
 * no URL, credential or body in the message.
 * With `view: 'page'`, asks for the page view and checks it as one (`checkPage`).
 * @param {{ url: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch, now?: Date, view?: 'page' }} o
 * @returns {Promise<any>}
 */
export async function readAggregate({ url, env, fetchImpl = fetch, now, view }) {
  const region = regionOfAggregateUrl(url);
  if (!region) throw new AggregateError("KANON_AGGREGATE_URL is not a Lambda function URL (https://<id>.lambda-url.<region>.on.aws/): set it to the telemetry stack's AggregateUrl output");
  const credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '', sessionToken: env.AWS_SESSION_TOKEN };
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new AggregateError('no AWS credentials in the environment: the credentials step for the invoker role did not run');
  const target = view === 'page' ? `${url.endsWith('/') ? url : `${url}/`}?view=page` : url;
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(target, { method: 'GET', headers: sign({ method: 'GET', url: target, region, service: 'lambda', credentials, ...(now ? { now } : {}) }) });
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
  return view === 'page' ? checkPage(body) : checkAggregate(body);
}

// ── The token way (plan 0008 §3.6, step J5) ──────────────────────────────────────────────────

/** The variables that name a self-hosted store's aggregate, together or not at all (plan 0008 §2.1). */
export const TOKEN_VARIABLES = /** @type {const} */ ({ url: 'KANON_AGGREGATE_TOKEN_URL', audience: 'KANON_TELEMETRY_AUDIENCE' });

/**
 * The store whose aggregate the Explorer reads: Kanon's hosted one, or the self-hosted one its two
 * variables name together (`storeOf`). `hostedUrl` is the hosted aggregate's token URL, the
 * constant, which a test replaces.
 * @param {Record<string, string | undefined>} env @param {string} [hostedUrl]
 */
export const aggregateStore = (env, hostedUrl = HOSTED_AGGREGATE_URL) =>
  storeOf({ url: env[TOKEN_VARIABLES.url] ?? '', audience: env[TOKEN_VARIABLES.audience] ?? '', hostedUrl, names: { url: `the ${TOKEN_VARIABLES.url} variable`, audience: `the ${TOKEN_VARIABLES.audience} variable` } });

/**
 * What a refusal on the token URL means, in the store's code: plan 0008 §3.1's list and §3.6's
 * `invoker`. Never a value from the answer.
 * @param {number} status @param {string | null} code
 */
export function tokenRefusal(status, code) {
  const said = `the aggregate function answered ${status}${code ? ` (${code})` : ''}`;
  if (status === 403 && code === 'invoker') return `${said}: this repository's registration doesn't set \`aggregate_invoker\`, which only Kanon's operator sets (docs/telemetry.md, "The token URL")`;
  if (status === 404 && code === 'not-registered') return `${said}: this repository is not registered with the store; its telemetry collector's first default-branch run registers it (docs/telemetry.md, "Collect the rows")`;
  if (status === 403 && code === 'suspended') return `${said}: Kanon's operator has suspended this repository's registration`;
  if (status === 410 || code === 'erased') return `${said}: this repository's telemetry was erased; a dispatch of its collector with register: yes registers it again`;
  if (status === 403 && code === 'ref') return `${said}: a dispatch runs on the repository's default branch only`;
  if (status === 403 && code === 'workflow') return `${said}: the store admits the Explorer's lane at a Kanon release no older than its minimum, so check the caller's pin`;
  if (status === 429) return `${said}: the repository's hourly request quota is spent; the next run reads again`;
  return said;
}

/**
 * The read on the token URL: a fresh OIDC token for the store's audience, sent to the store's
 * aggregate URL, and the answer checked as the SigV4 read checks it. Throws `AggregateError`
 * naming what went wrong, never with the URL, the token or the body in the message.
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (secret: string) => void, hostedUrl?: string, view?: 'page' }} o
 * @returns {Promise<any>}
 */
export async function readAggregateToken({ env, fetchImpl = fetch, mask = runnerMask, hostedUrl = HOSTED_AGGREGATE_URL, view }) {
  const store = aggregateStore(env, hostedUrl);
  if (!store.ok) throw new AggregateError(store.why);
  // A self-hosted store's URL is the adopter's to publish or not: masked before anything prints.
  if (!store.hosted) mask(store.url);
  /** @type {import('./lib/telemetry-token.mjs').Answer} */
  let res;
  try {
    res = await storeRequest(store, { method: 'GET', path: '', ...(view === 'page' ? { query: { view: 'page' } } : {}) }, { env, fetchImpl, mask });
  } catch (e) {
    if (e instanceof TokenError) throw new AggregateError(e.message);
    throw new AggregateError(`the aggregate function could not be reached (${e instanceof Error ? e.name : 'error'})`);
  }
  if (res.status !== 200) throw new AggregateError(tokenRefusal(res.status, codeOf(res.json)));
  if (res.json === null) throw new AggregateError('the aggregate function answered something that is not JSON');
  return view === 'page' ? checkPage(res.json) : checkAggregate(res.json);
}

/** The step summary's line: counts only, never a figure. @param {Aggregate} a */
export const summaryLine = (a) => {
  const own = a.own.reduce((n, o) => n + o.cells.length, 0);
  return `Aggregate computed ${a.computed_at}: ${a.cross_adopter.length} cross-adopter cell(s) (at least ${a.min_adopters} adopters each), ${own} own cell(s) of ${a.own.length} declaring adopter(s), ${a.signals.length} failure signal(s) over ${a.signal_days} days.`;
};

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  const env = process.env;
  if (process.argv[2] === 'check') {
    // THE GATE'S QUESTION, before any token is minted: a store to call, or not yet.
    const store = aggregateStore(env);
    if (store.ok) process.stdout.write('true\n');
    else if (store.unpublished) {
      process.stderr.write(`explore-telemetry: ${store.why}\n`);
      process.stdout.write('false\n');
    } else {
      console.log(`::error title=explore-telemetry::${store.why}.`);
      process.exit(1);
    }
    process.exit(0);
  }
  const out = env.OUT ?? '';
  if (!out) {
    console.log('::error title=aggregate::OUT must name the directory the aggregate is written to');
    process.exit(2);
  }
  if (process.argv[2] === 'page') {
    try {
      const p = await readAggregate({ url: env.KANON_AGGREGATE_URL ?? '', env, view: 'page' });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, PAGE_FILE), `${JSON.stringify(p, null, 2)}\n`);
      const line = `Page view computed ${p.computed_at}: the own figures of ${p.own.length} declaring adopter(s), each one adopter's.`;
      console.log(line);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
    } catch (e) {
      const why = e instanceof AggregateError ? e.message : `an unexpected error (${e instanceof Error ? e.name : 'error'})`;
      console.log(`::error title=aggregate::${why}. Nothing was handed to the page.`);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    const a = process.argv[2] === 'token' ? await readAggregateToken({ env }) : await readAggregate({ url: env.KANON_AGGREGATE_URL ?? '', env });
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
