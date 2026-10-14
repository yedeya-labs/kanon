#!/usr/bin/env node
// The Overseer's own-adopter cost view (kanon#470; plan 0002 §6, plan 0004 §3.2 and step 13):
// `token-trend.md` and `cache-ttl.md`, computed from this repository's own telemetry rows, and
// handed to the agent as two Markdown files, never as rows.
//
//   node "$KANON/scripts/overseer-telemetry.mjs" consent  the lane's `gate` job: does this
//                                                         repository send telemetry?
//   node "$KANON/scripts/overseer-telemetry.mjs" read     the lane's `telemetry` job, first
//   node "$KANON/scripts/overseer-telemetry.mjs" report   the lane's `telemetry` job, last: the
//                                                         headline indicators, to its job summary
//   node "$KANON/scripts/overseer-telemetry.mjs" merge    the agent's job, before the agent
//
// THROUGH THE STORE'S OWN-ROWS ENDPOINT, ON GITHUB'S TOKEN (plan 0008 §3.5, step J5). Both reads
// call `GET /v1/rows/self` on the store's ingest function with a fresh GitHub OIDC token for the
// store's audience on every request (`scripts/lib/telemetry-token.mjs`): no role, no secret, no
// table, no region. The function finds the repository's key from the token's `repository_id`,
// reads under a session policy scoped to that key, and never returns the key, so nothing here
// sees it or has it to mask. The store admits the token only from `agent-overseer.yml` at a Kanon
// release, from a schedule or a dispatch on the repository's default branch (§2.2). A self-hosted
// store is named by two repository variables together, `KANON_TELEMETRY_TOKEN_URL` (its
// `IngestTokenUrl` output) and `KANON_TELEMETRY_AUDIENCE`, never one without the other.
//
// WHO READS WHAT (the Owner's decision on kanon#470, option A). The lane's `telemetry` job is the
// only one that mints a token for the telemetry store, a job of its own whose shape the id-token
// guard holds (`tests/unit/helpers/store-jobs.ts`). It reads each of Kanon's lanes' rows for the
// last `WINDOW_DAYS`, projected to the fields the two reports use, writes the two files, and
// uploads them as an artifact kept one day. The rows never leave the job: not to the log, not to
// the artifact, not to the agent (plan 0004 step 13).
//
// ONLY WITH CONSENT (ADR 0007). The gate job reads whether the repository sends telemetry: a
// workflow on its default branch that calls Kanon's collector, whose caller is the consent (plan
// 0008 §3.3). Without one, no token is ever minted for the store, so a repository that didn't
// opt in never names itself to it.
//
// THE STATUS IS ALWAYS SAID. The agent's job adds the files to the QA store's export, and writes
// the read's status into the export's manifest as `telemetry`: `ran` (the read worked, and the two
// files are Kanon's), `not configured` (the repository doesn't send telemetry, isn't registered
// with the store yet, or this release doesn't publish the hosted store's URL), `not run on this
// trigger` (the runtime-version trigger's `pull_request_target`, whose token the store refuses,
// so the lane doesn't try; the Owner's decision on kanon#499) or `failed` (the store refused the
// read, or no partition could be read). The prompt reports that status and nothing more: a missing
// file never means the store is absent. A repository whose own store hook writes the two files
// keeps them whenever this read didn't run.
//
// THE HEADLINE INDICATORS, TO THE JOB SUMMARY (kanon#668; plan 0003 §6.4, option A). The same
// job, in its last step, runs `kanon metrics report` over this repository's own rows: the
// work-item partition, `work`, whole, and each lane's over the store's thirteen months (plan 0002
// §10), every field, since the report reads most of them. It writes the report's Markdown to the
// job's summary, and nothing else anywhere: the rows stay in the step's memory, never in a file,
// the log or the artifact. A partition it can't read withholds the whole report, naming the
// partition: a report missing a lane's cost, or the work items, would print numbers that are
// wrong. It never fails the job, so the agent's two files are never held up by it (kanon#682): it
// holds a deadline of its own, `REPORT_BY_MS` after the read stamped the job's start, well inside
// the job's `timeout-minutes`; no request outlives it, and a report not read by then is withheld
// with a warning. Any throw on the way, from the report or from the summary's write, is a warning
// too, and the step exits 0.
//
// `node:` built-ins, and `gh` for the gate's read of the default branch (`K-SELF-8`).

import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { RETENTION_MONTHS, addMonths } from '../infra/telemetry/function/index.mjs';
import { LANES, RESERVED_PARTITION } from '../infra/telemetry/function/schema.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { readSnapshot, resolveCaller } from './lib/lane-caller.mjs';
import { HOSTED_INGEST_URL, TokenError, codeOf, runnerMask, storeOf, storeRequest } from './lib/telemetry-token.mjs';
import { metricsReport, renderReport } from './metrics/report.mjs';
import { metricsViews, renderViews } from './metrics/views.mjs';
import { DAY_MS, TREND_ATTRIBUTES, render as renderTrend, summarize as summarizeTrend } from './lib/token-trend.mjs';
import { TTL_ATTRIBUTES, pinnedLanes, render as renderTtl, summarize as summarizeTtl } from './lib/cache-ttl.mjs';

/** Two weeks: the token trend compares this week with the one before. */
export const WINDOW_DAYS = 14;
/** The headline report reads back as far as the store keeps a row: thirteen months (plan 0002 §10). */
export const REPORT_MONTHS = RETENTION_MONTHS;
/** The `telemetry` job's `timeout-minutes` (`.github/workflows/agent-overseer.yml`). */
export const JOB_TIMEOUT_MINUTES = 10;
/** The report's deadline, counted from the read step's stamp: two minutes short of the job's
 *  timeout, for the job's setup, the step before the read and the post-steps after the report. */
export const REPORT_BY_MS = (JOB_TIMEOUT_MINUTES - 2) * 60_000;
/** The report's own budget when the job's start can't be read: from the step's start. */
export const REPORT_FALLBACK_MS = 3 * 60_000;
/** One request's own limit, when the deadline is further off. */
export const QUERY_TIMEOUT_MS = 120_000;
/** At most this many pages of one partition (1,000 rows each, plan 0008 §3.2): a cursor that never
 *  ends is a failed read, not a hung job. */
export const MAX_PAGES = 200;
/** Where the read stamps the job's start, under the runner's temp directory: never under the
 *  read's output directory, which is uploaded. */
export const STARTED_FILE = 'kanon-overseer-telemetry-started';

/** The variables that name a self-hosted store, together or not at all (plan 0008 §2.1). */
export const TOKEN_VARIABLES = /** @type {const} */ ({ url: 'KANON_TELEMETRY_TOKEN_URL', audience: 'KANON_TELEMETRY_AUDIENCE' });
/** Kanon's collector, whose caller on the default branch is the repository's consent (plan 0008 §3.3). */
export const COLLECTOR_LANE = 'telemetry-collect';

/**
 * When the report must have read every partition: `REPORT_BY_MS` after the job's start, as the read
 * step stamped it, or `REPORT_FALLBACK_MS` after `at` when the stamp is missing or not a time
 * before `at` within the job's timeout.
 * @param {string | undefined} stamp the stamp's text, as the read step wrote it
 * @param {number} at the step's start
 */
export function deadlineOf(stamp, at) {
  const started = Number(String(stamp ?? '').trim() || NaN);
  const fresh = Number.isFinite(started) && started <= at && at - started < JOB_TIMEOUT_MINUTES * 60_000;
  return fresh ? started + REPORT_BY_MS : at + REPORT_FALLBACK_MS;
}

/** The files the read writes and the export carries. */
export const FILES = /** @type {const} */ (['token-trend.md', 'cache-ttl.md']);
/** The statuses the manifest's `telemetry` takes. */
export const STATUSES = /** @type {const} */ (['ran', 'not configured', 'not run on this trigger', 'failed']);

/** Kanon's lane definitions, the release this runs from: where the 5m pins are read. */
const WORKFLOWS = fileURLToPath(new URL('../.github/workflows', import.meta.url));

/**
 * The fields the cost view asks for: the two reports' attributes, with the time each row was
 * recorded in place of the store's sort key, which the endpoint doesn't return (plan 0008 §3.2).
 */
export const VIEW_FIELDS = [...new Set([...TREND_ATTRIBUTES, ...TTL_ATTRIBUTES].filter((a) => a !== 'sk')), 'recorded_at'];

/**
 * The store this repository's rows are read from: Kanon's hosted one, or the self-hosted one the
 * two variables name together (`storeOf`). `hostedUrl` is the hosted ingest function's token URL,
 * the constant, which a test replaces.
 * @param {Record<string, string | undefined>} env @param {string} [hostedUrl]
 */
export const overseerStore = (env, hostedUrl = HOSTED_INGEST_URL) =>
  storeOf({ url: env[TOKEN_VARIABLES.url] ?? '', audience: env[TOKEN_VARIABLES.audience] ?? '', hostedUrl, names: { url: `the ${TOKEN_VARIABLES.url} variable`, audience: `the ${TOKEN_VARIABLES.audience} variable` } });

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();
/** The store's sort-key stamp of a row's `recorded_at`, compact ISO, as the reports read it. @param {string} at */
const compactOf = (at) => `${at.slice(0, 19).replace(/[-:]/g, '')}Z`;

/**
 * A row as the store's endpoint answers it, as the item the two reports read (`token-trend.mjs`
 * `Item`): each string, number and boolean as its attribute, and `sk` from `recorded_at`. Any
 * other value is left out.
 * @param {Record<string, unknown>} row
 * @returns {import('./lib/token-trend.mjs').Item}
 */
export function itemOf(row) {
  /** @type {import('./lib/token-trend.mjs').Item} */
  const item = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string') item[k] = { S: v };
    else if (typeof v === 'number' && Number.isFinite(v)) item[k] = { N: String(v) };
    else if (typeof v === 'boolean') item[k] = { BOOL: v };
  }
  if (typeof row.recorded_at === 'string') item.sk = { S: compactOf(row.recorded_at) };
  return item;
}

/**
 * A row as the store's endpoint answers it, kept to its string, number and boolean fields, as
 * the headline report reads them.
 * @param {Record<string, unknown>} row
 * @returns {Record<string, string | number | boolean>}
 */
export function rowOf(row) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [k, v] of Object.entries(row)) if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  return out;
}

/** The store refused the read for the whole registration (plan 0008 §3.1): no other partition is asked. */
export class RefusedError extends Error {
  /** @param {number} status @param {string | null} code */
  constructor(status, code) {
    super(`the store answered ${status}${code ? ` (${code})` : ''}`);
    this.status = status;
    this.code = code;
  }
}

/** The deadline passed before or while a partition was read. */
export class LateError extends Error {
  constructor() { super('out of time'); }
}

/**
 * What a refusal means, in a sentence for the summary: the store's code, and what to do.
 * @param {RefusedError} e
 */
export function refusalWords(e) {
  if (e.status === 404 && e.code === 'not-registered') return `${e.message}: this repository is not registered with the store yet, and its telemetry collector's first default-branch run registers it`;
  if (e.status === 403 && e.code === 'suspended') return `${e.message}: Kanon's operator has suspended this repository's registration`;
  if (e.status === 410 || e.code === 'erased') return `${e.message}: this repository's telemetry was erased`;
  if (e.status === 403 && e.code === 'ref') return `${e.message}: the store reads a repository's rows on its default branch only, so a dispatch from another branch reads nothing`;
  if (e.status === 403 && e.code === 'workflow') return `${e.message}: the store admits the Overseer's lane at a Kanon release no older than its minimum, so check the caller's pin`;
  if (e.status === 429) return `${e.message}: the repository's hourly request quota is spent; the next run reads again`;
  return e.message;
}

/**
 * Every page of one partition of this repository's own rows (`GET /v1/rows/self`), each request
 * with a fresh token, none started after `deadline` and none given longer than what is left of
 * it. Throws `RefusedError` on a 401, 403, 404, 410 or 429, which hold for the whole
 * registration, and `LateError` past the deadline; any other failure throws an `Error` naming it,
 * never with the URL or a token.
 * @param {import('./lib/telemetry-token.mjs').Store} store
 * @param {{ lane: string, from?: string, fields?: readonly string[] }} q
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (secret: string) => void, clock?: () => number, deadline?: number }} io
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readPartition(store, q, { env, fetchImpl = fetch, mask = runnerMask, clock = Date.now, deadline = Infinity }) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {string | undefined} */
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const left = deadline - clock();
    if (!(left > 0)) throw new LateError();
    const timeout = Math.ceil(Math.min(QUERY_TIMEOUT_MS, left));
    /** @type {typeof fetch} */
    const timed = /** @type {any} */ ((/** @type {any} */ url, /** @type {any} */ init) => fetchImpl(url, { ...init, signal: globalThis.AbortSignal.timeout(timeout) }));
    /** @type {Record<string, string>} */
    const query = { lane: q.lane, ...(q.from ? { from: q.from } : {}), ...(q.fields ? { fields: q.fields.join(',') } : {}), ...(cursor ? { cursor } : {}) };
    /** @type {import('./lib/telemetry-token.mjs').Answer} */
    let res;
    try {
      res = await storeRequest(store, { method: 'GET', path: 'v1/rows/self', query }, { env, fetchImpl: timed, mask });
    } catch (e) {
      if (!(deadline - clock() > 0)) throw new LateError();
      if (e instanceof TokenError) throw e;
      throw new Error(`the store could not be reached (${e instanceof Error ? e.name : 'error'})`);
    }
    if ([401, 403, 404, 410, 429].includes(res.status)) throw new RefusedError(res.status, codeOf(res.json));
    if (res.status !== 200) throw new Error(`the store answered ${res.status}${codeOf(res.json) ? ` (${codeOf(res.json)})` : ''}`);
    const got = res.json?.rows;
    if (!Array.isArray(got)) throw new Error('the store answered no list of rows');
    for (const r of got) if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r);
    cursor = typeof res.json?.cursor === 'string' ? res.json.cursor : undefined;
    if (!cursor) return rows;
  }
  throw new Error(`the store answered more than ${MAX_PAGES} pages`);
}

/**
 * @typedef {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (secret: string) => void, hostedUrl?: string }} StoreIo
 */

/**
 * The store to read, its URL masked when it is self-hosted, or the status and line that say why
 * there is none.
 * @param {StoreIo} io @param {string} what
 * @returns {{ store: import('./lib/telemetry-token.mjs').Store, refused?: undefined } | { store?: undefined, refused: { status: 'not configured' | 'failed', line: string } }}
 */
function storeFor({ env, mask = runnerMask, hostedUrl = HOSTED_INGEST_URL }, what) {
  const store = overseerStore(env, hostedUrl);
  if (!store.ok) return { refused: { status: store.unpublished ? 'not configured' : 'failed', line: `${what}: ${store.why}.` } };
  // A self-hosted store's URL is the adopter's to publish or not: masked before anything prints.
  if (!store.hosted) mask(store.url);
  return { store };
}

/**
 * The read: both reports from this repository's own rows, or why there are none.
 * @param {StoreIo & { now?: number, workflows?: string }} io
 * @returns {Promise<{ status: 'ran' | 'not configured' | 'failed', lines: string[], files: Record<string, string> }>}
 */
export async function read({ now = Date.now(), workflows = WORKFLOWS, ...io }) {
  const { store, refused } = storeFor(io, 'The telemetry read did not run');
  if (!store) return { status: refused.status, files: {}, lines: [refused.line] };
  const from = iso(now - WINDOW_DAYS * DAY_MS);
  /** @type {Array<{ lane: string, items: import('./lib/token-trend.mjs').Item[], error?: string }>} */
  const partitions = [];
  for (const lane of LANES) {
    try {
      const rows = await readPartition(store, { lane, from, fields: VIEW_FIELDS }, io);
      partitions.push({ lane, items: rows.map(itemOf) });
    } catch (e) {
      // A refusal holds for every partition: said once, and nothing more is asked.
      if (e instanceof RefusedError) {
        const words = refusalWords(e);
        return e.code === 'not-registered'
          ? { status: 'not configured', files: {}, lines: [`The telemetry read found nothing to read: ${words}.`] }
          : { status: 'failed', files: {}, lines: [`The telemetry read failed: ${words}.`] };
      }
      partitions.push({ lane, items: [], error: e instanceof Error ? e.message : 'the read failed' });
    }
  }
  const got = partitions.filter((p) => !p.error);
  if (!got.length) {
    return { status: 'failed', files: {}, lines: [`The telemetry read failed: none of the ${LANES.length} lane partitions could be read (${partitions[0]?.error ?? 'no lanes'}).`] };
  }
  const rows = got.reduce((n, p) => n + p.items.length, 0);
  const trend = renderTrend(summarizeTrend(partitions, now));
  const ttl = renderTtl(summarizeTtl(got, pinnedLanes(workflows, LANES), partitions.filter((p) => p.error).map((p) => p.lane)), WINDOW_DAYS);
  return {
    status: 'ran',
    files: { 'token-trend.md': `${trend}\n`, 'cache-ttl.md': `${ttl}\n` },
    // Counts only: the rows themselves are never printed.
    lines: [`The telemetry read ran: ${got.length} of ${LANES.length} lane partitions read, ${rows} row(s) over the last ${WINDOW_DAYS} days, summarised into ${FILES.join(' and ')}.`],
  };
}

/**
 * The headline report (kanon#668): `kanon metrics report`'s Markdown over this repository's own
 * work items and runs, or why there is none. Every partition is read, or no report is made.
 * Every partition is read by `deadline` too (kanon#682): no request is started after it, and none
 * is given longer than what is left of it, so the step never holds the job past its timeout.
 * @param {StoreIo & { now?: number, clock?: () => number, deadline?: number }} io
 *   `now` dates the report; `clock` measures the time left before `deadline`
 * @returns {Promise<{ status: 'ran' | 'failed', markdown: string, lines: string[] }>}
 */
export async function headline({ now = Date.now(), clock = Date.now, deadline = Infinity, ...io }) {
  const { store, refused } = storeFor(io, 'The headline report was not made');
  if (!store) return { status: 'failed', markdown: '', lines: [refused.line] };
  const from = iso(addMonths(now, -REPORT_MONTHS));
  // A work item's sort key is its PR number, not a time, so its partition is read whole; the
  // store's TTL keeps it to thirteen months after each item closed.
  const partitions = [{ name: RESERVED_PARTITION, from: undefined }, ...LANES.map((lane) => ({ name: lane, from }))];
  /** @type {Record<string, string | number | boolean>[]} */
  const rows = [];
  let items = 0;
  /** @param {string} name @param {string} when */
  const late = (name, when) => ({ status: /** @type {const} */ ('failed'), markdown: '', lines: [`The headline report was not made: its time ran out ${when} the \`${name}\` partition was read (the step keeps inside the job's ${JOB_TIMEOUT_MINUTES}-minute timeout), and a report without it would be wrong.`] });
  for (const p of partitions) {
    if (!(deadline - clock() > 0)) return late(p.name, 'before');
    /** @type {Record<string, unknown>[]} */
    let got;
    try {
      got = await readPartition(store, { lane: p.name, ...(p.from === undefined ? {} : { from: p.from }) }, { ...io, clock, deadline });
    } catch (e) {
      if (e instanceof LateError) return late(p.name, 'while');
      const why = e instanceof RefusedError ? refusalWords(e) : e instanceof Error ? e.message : 'the read failed';
      return { status: 'failed', markdown: '', lines: [`The headline report was not made: the \`${p.name}\` partition could not be read (${why}), and a report without it would be wrong.`] };
    }
    if (p.name === RESERVED_PARTITION) items = got.length;
    for (const r of got) rows.push(rowOf(r));
  }
  // The same Markdown as `kanon metrics report` with its defaults: the indicators, then the views
  // (kanon#669), so the summary and the command never differ.
  const until = new Date(now);
  const markdown = `${[...renderReport(metricsReport(rows, { until })), ...renderViews(metricsViews(rows, { until }))].join('\n')}\n`;
  return {
    status: 'ran',
    markdown,
    // Counts only: the rows themselves are never printed.
    lines: [`The headline report ran: ${partitions.length} partitions read, ${items} work item(s) and ${rows.length - items} run row(s) over the last ${REPORT_MONTHS} months, written to the job summary.`],
  };
}

/**
 * The report step, whole (kanon#682): the headline report's Markdown to the job summary, or a
 * warning saying why there is none. It never throws: a throw from the report or from a write is
 * a warning, so the step exits 0 and the job keeps its status.
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch, mask?: (secret: string) => void, hostedUrl?: string, now?: number, clock?: () => number, append?: (path: string, text: string) => void, log?: (line: string) => void, stamp?: () => string | undefined }} [io]
 */
export async function reportStep(env, io = {}) {
  const { clock = Date.now, append = appendFileSync, log = console.log } = io;
  const summary = env.GITHUB_STEP_SUMMARY;
  /** @param {string} line */
  const warn = (line) => {
    try {
      log(`::warning title=overseer metrics::${line}`);
    } catch { /* the summary may still take it */ }
    try {
      if (summary) append(summary, `${line}\n`);
    } catch { /* the log has it */ }
  };
  try {
    const at = clock();
    const readStamp = io.stamp ?? (() => (env.RUNNER_TEMP ? readFileSync(join(env.RUNNER_TEMP, STARTED_FILE), 'utf8') : undefined));
    /** @type {string | undefined} */
    let started;
    try { started = readStamp(); } catch { started = undefined; }
    const { status, markdown, lines } = await headline({
      env, now: io.now ?? at, clock, deadline: deadlineOf(started, at),
      ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}), ...(io.mask ? { mask: io.mask } : {}), ...(io.hostedUrl !== undefined ? { hostedUrl: io.hostedUrl } : {}),
    });
    // The Markdown goes to the summary only: the log says counts, or why there is no report.
    if (status === 'ran' && summary) append(summary, markdown);
    for (const l of lines) {
      if (status !== 'ran') warn(l);
      else {
        log(l);
        if (summary) append(summary, `${l}\n`);
      }
    }
  } catch (e) {
    warn(`The headline report stopped on an error (${e instanceof Error ? e.name : 'error'}); the job is not failed for it.`);
  }
}

/**
 * The gate's question (plan 0008 §3.3; ADR 0007): does this repository send telemetry, so that
 * the lane may ask the store for its rows? `true` when a workflow on its default branch calls
 * Kanon's collector and there is a store to read; `false` when none does, or this release
 * doesn't publish the hosted store's URL; `unknown` when the default branch can't be read or the
 * store's two variables are wrong, which the lane reports as a `failed` read.
 * @param {Record<string, string | undefined>} env
 * @param {{ json: (args: string[]) => any, hostedUrl?: string }} io
 * @returns {{ reader: 'true' | 'false' | 'unknown', line: string }}
 */
export function consentOf(env, { json, hostedUrl = HOSTED_INGEST_URL }) {
  const store = overseerStore(env, hostedUrl);
  if (!store.ok && store.unpublished) return { reader: 'false', line: `The telemetry read is not configured: ${store.why}.` };
  if (!store.ok) return { reader: 'unknown', line: `The telemetry read can't run: ${store.why}.` };
  /** @type {import('./lib/lane-caller.mjs').Snapshot} */
  let snapshot;
  try {
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('GITHUB_REPOSITORY must be set');
    snapshot = readSnapshot({ repo, json });
  } catch (e) {
    return { reader: 'unknown', line: `The telemetry read can't run: whether this repository sends telemetry could not be read (${String(e instanceof Error ? e.message : e).split('\n')[0]?.slice(0, 200)}).` };
  }
  const caller = resolveCaller(COLLECTOR_LANE, snapshot);
  if (caller.how === 'fallback') return { reader: 'false', line: "The telemetry read is not configured: no workflow on the default branch calls Kanon's telemetry collector, so this repository doesn't send telemetry, and no token is minted for the store." };
  return { reader: 'true', line: `This repository sends telemetry (${caller.file} calls Kanon's collector), so the lane reads its own rows.` };
}

/**
 * The agent's job's step: the read's files into the export, and its status into the manifest.
 * Kanon's files replace a hook's only when the read ran; otherwise a hook's own pass through.
 * @param {{ TELEMETRY_STATUS?: string, TELEMETRY_DIR?: string, EXPORT_DIR?: string }} env
 * @returns {{ status: typeof STATUSES[number], line: string }}
 */
export function merge(env) {
  const exportDir = env.EXPORT_DIR || 'qa-store-export';
  let status = /** @type {typeof STATUSES[number]} */ ((/** @type {readonly string[]} */ (STATUSES)).includes(env.TELEMETRY_STATUS ?? '') ? env.TELEMETRY_STATUS : 'failed');
  mkdirSync(exportDir, { recursive: true });
  if (status === 'ran') {
    const dir = env.TELEMETRY_DIR ?? '';
    if (FILES.every((f) => dir && existsSync(join(dir, f)))) for (const f of FILES) copyFileSync(join(dir, f), join(exportDir, f));
    else status = 'failed';
  }
  const at = join(exportDir, 'manifest.json');
  /** @type {Record<string, unknown>} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(at, 'utf8'));
  } catch {
    manifest = { store: 'unreadable' };
  }
  manifest.telemetry = status;
  manifest.files = readdirSync(exportDir).filter((f) => f !== 'manifest.json').sort();
  writeFileSync(at, `${JSON.stringify(manifest)}\n`);
  const own = status !== 'ran' && FILES.some((f) => existsSync(join(exportDir, f)));
  const line = status === 'ran'
    ? `Telemetry read: ran; ${FILES.join(' and ')} are from this repository's own rows.`
    : `Telemetry read: ${status}.${own ? ' The store hook\'s own files are passed on.' : ''}`;
  return { status, line };
}

/* c8 ignore start */
/** @param {Record<string, string>} outputs */
const writeOutputs = (outputs) => {
  const text = Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
};
/** @param {string} line */
const say = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

if (isCliEntry(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'consent') {
    // THE GATE'S READ (ADR 0007): the default branch's workflows, with the workflow token, before
    // any token is minted for the store. Its answer is this step's output, `reader`.
    const json = (/** @type {string[]} */ args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    const { reader, line } = consentOf(process.env, { json });
    if (reader === 'unknown') console.log(`::warning title=overseer telemetry::${line}`);
    else console.log(line);
    writeOutputs({ reader });
  } else if (mode === 'read') {
    // The job's start, for the report's deadline (kanon#682): this is the job's first step after
    // Kanon's path. Only a time, under the runner's temp directory, never the uploaded one.
    try {
      if (process.env.RUNNER_TEMP) writeFileSync(join(process.env.RUNNER_TEMP, STARTED_FILE), `${Date.now()}\n`);
    } catch { /* the report falls back to a budget of its own */ }
    const { status, files, lines } = await read({ env: process.env });
    const out = process.env.OUT ?? '';
    if (status === 'ran') {
      mkdirSync(out, { recursive: true });
      for (const [f, text] of Object.entries(files)) writeFileSync(join(out, f), text);
    } else if (status === 'failed') {
      for (const l of lines) console.log(`::warning title=overseer telemetry::${l}`);
    }
    for (const l of lines) say(l);
    writeOutputs({ status });
  } else if (mode === 'report') {
    await reportStep(process.env);
    process.exitCode = 0;
  } else if (mode === 'merge') {
    const { line } = merge(process.env);
    say(line);
  } else {
    console.error('usage: overseer-telemetry.mjs consent|read|report|merge');
    process.exitCode = 2;
  }
}
/* c8 ignore stop */
