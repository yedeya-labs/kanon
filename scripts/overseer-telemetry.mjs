#!/usr/bin/env node
// The Overseer's own-adopter cost view (kanon#470; plan 0002 §6, plan 0004 §3.2 and step 13):
// `token-trend.md` and `cache-ttl.md`, computed from this repository's own telemetry rows, read
// with its telemetry reader role, and handed to the agent as two Markdown files, never as rows.
//
//   node "$KANON/scripts/overseer-telemetry.mjs" mask    the lane's `telemetry` job, first; it also
//                                                        resolves and checks the table and region
//   node "$KANON/scripts/overseer-telemetry.mjs" read    the lane's `telemetry` job, after the
//                                                        credentials step
//   node "$KANON/scripts/overseer-telemetry.mjs" report  the lane's `telemetry` job, last: the
//                                                        headline indicators, to its job summary
//   node "$KANON/scripts/overseer-telemetry.mjs" merge   the agent's job, before the agent
//
// WHO READS WHAT (the Owner's decision on kanon#470, option A). The lane's `telemetry` job is the
// only one that holds the reader role's credentials, a store job of its own whose shape the
// id-token guard holds (`tests/unit/helpers/store-jobs.ts`). It assumes the adopter's existing
// reader role, `kanon-telemetry-<key>-reader`, which the hosted store trusts for the adopter's
// default branch and allows to `Query` only partitions under `<key>#` (plan 0002 §3). The role's
// ARN is a secret the caller maps by name, `KANON_TELEMETRY_READER_ROLE` (like the aggregate
// invoker's, kanon#471); the key is read from the role's name, so nothing else is configured. It
// reads each of Kanon's lanes' partitions for the last `WINDOW_DAYS`, projected to the fields the
// two reports use, writes the two files, and uploads them as an artifact kept one day. The rows
// never leave the job: not to the log, not to the artifact, not to the agent (plan 0004 step 13).
//
// THE STATUS IS ALWAYS SAID. The agent's job adds the files to the QA store's export, and writes
// the read's status into the export's manifest as `telemetry`: `ran` (the read worked, and the two
// files are Kanon's), `not configured` (no reader role is mapped: the repository didn't opt in to
// telemetry, or hasn't mapped the secret), `not run on this trigger` (the runtime-version
// trigger's `pull_request_target`, whose token the reader role refuses, so the lane doesn't try;
// the Owner's decision on kanon#499) or `failed` (the table or region isn't valid, the role
// couldn't be assumed, or no partition could be read). The prompt reports that status and nothing more: a missing file never
// means the store is absent. A repository whose own store hook writes the two files keeps them
// whenever this read didn't run.
//
// THE HEADLINE INDICATORS, TO THE JOB SUMMARY (kanon#668; plan 0003 §6.4, option A). The same
// job, in its last step, runs `kanon metrics report` over this repository's own rows: the
// work-item partition, `<key>#work`, whole, and each lane's partition over the store's thirteen
// months (plan 0002 §10), every attribute, since the report reads most of them. It writes the
// report's Markdown to the job's summary, and nothing else anywhere: the rows stay in the step's
// memory, never in a file, the log or the artifact. A partition it can't read withholds the whole
// report, naming the partition: a report missing a lane's cost, or the work items, would print
// numbers that are wrong. It never fails the job, so the agent's two files are never held up by it
// (kanon#682): it holds a deadline of its own, `REPORT_BY_MS` after the mask step stamped the job's
// start, well inside the job's `timeout-minutes`; no query outlives it, and a report not read by
// then is withheld with a warning. Any throw on the way, from the report or from the summary's
// write, is a warning too, and the step exits 0.
//
// `node:` built-ins and the `aws` CLI on GitHub's runner only (`K-SELF-8`).

import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { RETENTION_MONTHS, addMonths } from '../infra/telemetry/function/index.mjs';
import { LANES, RESERVED_PARTITION } from '../infra/telemetry/function/schema.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { metricsReport, renderReport } from './metrics/report.mjs';
import { metricsViews, renderViews } from './metrics/views.mjs';
import { DAY_MS, TREND_ATTRIBUTES, render as renderTrend, summarize as summarizeTrend } from './lib/token-trend.mjs';
import { TTL_ATTRIBUTES, pinnedLanes, render as renderTtl, summarize as summarizeTtl } from './lib/cache-ttl.mjs';

/** The hosted store's table and region (docs/telemetry.md), the defaults. A repository reading a
 *  self-hosted telemetry store sets the variables KANON_TELEMETRY_TABLE and KANON_TELEMETRY_REGION
 *  (the Owner's decision on kanon#499); `checkStore` resolves and checks both before any use. */
export const TABLE = 'kanon-telemetry';
export const REGION = 'eu-central-1';
/** A DynamoDB table name, as AWS allows it. */
export const TABLE_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
/** An AWS region code: `eu-central-1`, `us-gov-west-1`, `ap-southeast-2`. */
export const REGION_PATTERN = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;

/**
 * The table and region to read, or why they can't be: an empty value is the default.
 * @param {{ TABLE?: string, REGION?: string }} env
 * @returns {{ table: string, region: string, problems: string[] }}
 */
export function checkStore(env) {
  const table = String(env.TABLE ?? '').trim() || TABLE;
  const region = String(env.REGION ?? '').trim() || REGION;
  /** @type {string[]} */
  const problems = [];
  if (!TABLE_PATTERN.test(table)) problems.push(`the KANON_TELEMETRY_TABLE variable \`${table.slice(0, 80)}\` is not a DynamoDB table name (3 to 255 of A-Z, a-z, 0-9, \`_\`, \`-\` and \`.\`)`);
  if (!REGION_PATTERN.test(region)) problems.push(`the KANON_TELEMETRY_REGION variable \`${region.slice(0, 80)}\` is not an AWS region code such as \`eu-central-1\``);
  return { table, region, problems };
}
/** Two weeks: the token trend compares this week with the one before. */
export const WINDOW_DAYS = 14;
/** The headline report reads back as far as the store keeps a row: thirteen months (plan 0002 §10). */
export const REPORT_MONTHS = RETENTION_MONTHS;
/** The `telemetry` job's `timeout-minutes` (`.github/workflows/agent-overseer.yml`). */
export const JOB_TIMEOUT_MINUTES = 10;
/** The report's deadline, counted from the mask step's stamp: two minutes short of the job's
 *  timeout, for the job's setup, the steps before the mask and the post-steps after the report. */
export const REPORT_BY_MS = (JOB_TIMEOUT_MINUTES - 2) * 60_000;
/** The report's own budget when the job's start can't be read: from the step's start. */
export const REPORT_FALLBACK_MS = 3 * 60_000;
/** One query's own limit, when the deadline is further off. */
export const QUERY_TIMEOUT_MS = 120_000;
/** Where the mask step stamps the job's start, under the runner's temp directory: never under the
 *  read's output directory, which is uploaded. */
export const STARTED_FILE = 'kanon-overseer-telemetry-started';

/**
 * When the report must have read every partition: `REPORT_BY_MS` after the job's start, as the mask
 * step stamped it, or `REPORT_FALLBACK_MS` after `at` when the stamp is missing or not a time
 * before `at` within the job's timeout.
 * @param {string | undefined} stamp the stamp's text, as the mask step wrote it
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

/** A reader role's ARN, and the key in its name (plan 0002 §3). */
const READER_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*kanon-telemetry-([a-z0-9][a-z0-9-]{0,31})-reader$/;

/**
 * The account id and the key in a reader role's ARN, or `null` when it isn't one.
 * @param {string | undefined} role
 * @returns {{ account: string, key: string } | null}
 */
export function readerOf(role) {
  const m = READER_ARN.exec(String(role ?? '').trim());
  return m ? { account: /** @type {string} */ (m[1]), key: /** @type {string} */ (m[2]) } : null;
}

/**
 * The values to mask before any other step names them: the ARN (a secret, masked already), the
 * account id inside it, and the adopter's key, which is in every partition name.
 * @param {{ ROLE?: string }} env
 * @returns {string[]}
 */
export function masksOf(env) {
  const role = String(env.ROLE ?? '').trim();
  if (!role) return [];
  const r = readerOf(role);
  const account = /^arn:aws[a-z-]*:iam::(\d{12}):/.exec(role)?.[1];
  return [...new Set([role, ...(account ? [account] : []), ...(r ? [r.key] : [])])];
}

/** @param {number} ms */
const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

/**
 * One `aws dynamodb query` of a partition, every page: since `from` when given, or the whole
 * partition; projected to `attributes` when given, or every attribute. The CLI is killed outright
 * once `timeout` milliseconds have passed, and the query throws.
 * @param {{ pk: string, from?: string, attributes?: readonly string[], table?: string, region?: string, timeout?: number }} q
 * @returns {import('./lib/token-trend.mjs').Item[]}
 */
export function awsQuery({ pk, from, attributes, table = TABLE, region = REGION, timeout = QUERY_TIMEOUT_MS }) {
  const names = Object.fromEntries((attributes ?? []).map((a, i) => [`#a${i}`, a]));
  const out = execFileSync('aws', [
    'dynamodb', 'query',
    '--table-name', table,
    '--region', region,
    '--key-condition-expression', from === undefined ? '#pk = :p' : '#pk = :p AND #sk > :from',
    ...(attributes ? ['--projection-expression', Object.keys(names).join(', ')] : []),
    '--expression-attribute-names', JSON.stringify({ ...names, '#pk': 'pk', ...(from === undefined ? {} : { '#sk': 'sk' }) }),
    '--expression-attribute-values', JSON.stringify({ ':p': { S: pk }, ...(from === undefined ? {} : { ':from': { S: from } }) }),
    '--output', 'json',
  ], { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out).Items ?? [];
}

/**
 * A stored item as the row it was written from: each attribute's value, without the store's own
 * key. The writer stores strings, numbers and booleans only (`toAttributes`).
 * @param {import('./lib/token-trend.mjs').Item} item
 * @returns {Record<string, string | number | boolean>}
 */
export function rowOf(item) {
  /** @type {Record<string, string | number | boolean>} */
  const row = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === 'pk' || k === 'sk' || !v) continue;
    if (v.S !== undefined) row[k] = v.S;
    else if (v.N !== undefined) row[k] = Number(v.N);
    else if (v.BOOL !== undefined) row[k] = v.BOOL;
  }
  return row;
}

/**
 * A failed query's reason, one line, with the key and any account id taken out: it goes into a
 * file the agent reads.
 * @param {unknown} e @param {string} key
 */
export function reasonOf(e, key) {
  const err = /** @type {{ stderr?: string | Buffer, message?: string }} */ (e);
  const raw = String(err?.stderr || err?.message || (e instanceof Error ? '' : e ?? '')).split('\n').map((l) => l.trim()).find(Boolean) ?? 'the query failed';
  return (key ? raw.split(key).join('<key>') : raw).replace(/\b\d{12}\b/g, '<account>').replace(/arn:aws[^\s"')]*/g, '<arn>').slice(0, 200);
}

/**
 * The read: both reports from this repository's own rows, or why there are none.
 * @param {{ ROLE?: string, CREDENTIALS?: string, OUT?: string, TABLE?: string, REGION?: string }} env
 * @param {{ query?: typeof awsQuery, now?: number, workflows?: string }} [io]
 * @returns {{ status: 'ran' | 'failed', lines: string[], files: Record<string, string> }}
 */
export function read(env, { query = awsQuery, now = Date.now(), workflows = WORKFLOWS } = {}) {
  const refused = refusalOf(env);
  if (refused) return { status: 'failed', files: {}, lines: [`The telemetry read failed: ${refused}`] };
  const store = checkStore(env);
  const reader = /** @type {{ key: string }} */ (readerOf(env.ROLE));
  const from = stamp(now - WINDOW_DAYS * DAY_MS);
  const attributes = [...new Set([...TREND_ATTRIBUTES, ...TTL_ATTRIBUTES])];
  /** @type {Array<{ lane: string, items: import('./lib/token-trend.mjs').Item[], error?: string }>} */
  const partitions = LANES.map((lane) => {
    try {
      return { lane, items: query({ pk: `${reader.key}#${lane}`, from, attributes, table: store.table, region: store.region }) };
    } catch (e) {
      return { lane, items: [], error: reasonOf(e, reader.key) };
    }
  });
  const read = partitions.filter((p) => !p.error);
  if (!read.length) {
    return { status: 'failed', files: {}, lines: [`The telemetry read failed: none of the ${LANES.length} lane partitions could be read (${partitions[0]?.error ?? 'no lanes'}).`] };
  }
  const rows = read.reduce((n, p) => n + p.items.length, 0);
  const trend = renderTrend(summarizeTrend(partitions, now));
  const ttl = renderTtl(summarizeTtl(read, pinnedLanes(workflows, LANES), partitions.filter((p) => p.error).map((p) => p.lane)), WINDOW_DAYS);
  return {
    status: 'ran',
    files: { 'token-trend.md': `${trend}\n`, 'cache-ttl.md': `${ttl}\n` },
    // Counts only: the rows themselves are never printed.
    lines: [`The telemetry read ran: ${read.length} of ${LANES.length} lane partitions read, ${rows} row(s) over the last ${WINDOW_DAYS} days, summarised into ${FILES.join(' and ')}.`],
  };
}

/**
 * Why a read can't start, or `null`: a malformed table or region, a role that isn't a reader
 * role, or credentials that weren't issued. The read and the report check the same.
 * @param {{ ROLE?: string, CREDENTIALS?: string, TABLE?: string, REGION?: string }} env
 */
function refusalOf(env) {
  const store = checkStore(env);
  if (store.problems.length) return `${store.problems.join('; ')}.`;
  if (!readerOf(env.ROLE)) return 'the KANON_TELEMETRY_READER_ROLE secret is not a telemetry reader role\'s ARN (`arn:aws:iam::<account>:role/kanon-telemetry-<key>-reader`, the stack\'s `ReaderRole<id>` output; docs/telemetry.md).';
  if (env.CREDENTIALS !== 'success') return 'the reader role could not be assumed. Its trust names the default branch\'s ref, so a run on another ref (a dispatch from a branch) is refused; on the default branch, check the role\'s trust and the secret.';
  return null;
}

/**
 * The headline report (kanon#668): `kanon metrics report`'s Markdown over this repository's own
 * work items and runs, or why there is none. Every partition is read, or no report is made.
 * Every partition is read by `deadline` too (kanon#682): none is started after it, and none is
 * given longer than what is left of it, so the step never holds the job past its timeout.
 * @param {{ ROLE?: string, CREDENTIALS?: string, TABLE?: string, REGION?: string }} env
 * @param {{ query?: typeof awsQuery, now?: number, clock?: () => number, deadline?: number }} [io]
 *   `now` dates the report; `clock` measures the time left before `deadline`
 * @returns {{ status: 'ran' | 'failed', markdown: string, lines: string[] }}
 */
export function headline(env, { query = awsQuery, now = Date.now(), clock = Date.now, deadline = Infinity } = {}) {
  const refused = refusalOf(env);
  if (refused) return { status: 'failed', markdown: '', lines: [`The headline report was not made: ${refused}`] };
  const { table, region } = checkStore(env);
  const { key } = /** @type {{ key: string }} */ (readerOf(env.ROLE));
  const from = stamp(addMonths(now, -REPORT_MONTHS));
  // A work item's sort key is its PR number, not a time, so its partition is read whole; the
  // store's TTL keeps it to thirteen months after each item closed.
  const partitions = [{ name: RESERVED_PARTITION, from: undefined }, ...LANES.map((lane) => ({ name: lane, from }))];
  /** @type {Record<string, string | number | boolean>[]} */
  const rows = [];
  let items = 0;
  /** @param {string} name @param {string} when */
  const late = (name, when) => ({ status: /** @type {const} */ ('failed'), markdown: '', lines: [`The headline report was not made: its time ran out ${when} the \`${name}\` partition was read (the step keeps inside the job's ${JOB_TIMEOUT_MINUTES}-minute timeout), and a report without it would be wrong.`] });
  for (const p of partitions) {
    const left = deadline - clock();
    if (!(left > 0)) return late(p.name, 'before');
    /** @type {import('./lib/token-trend.mjs').Item[]} */
    let got;
    try {
      got = query({ pk: `${key}#${p.name}`, ...(p.from === undefined ? {} : { from: p.from }), table, region, timeout: Math.ceil(Math.min(QUERY_TIMEOUT_MS, left)) });
    } catch (e) {
      if (!(deadline - clock() > 0)) return late(p.name, 'while');
      return { status: 'failed', markdown: '', lines: [`The headline report was not made: the \`${p.name}\` partition could not be read (${reasonOf(e, key)}), and a report without it would be wrong.`] };
    }
    if (p.name === RESERVED_PARTITION) items = got.length;
    for (const item of got) rows.push(rowOf(item));
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
 * @param {{ ROLE?: string, CREDENTIALS?: string, TABLE?: string, REGION?: string, GITHUB_STEP_SUMMARY?: string, RUNNER_TEMP?: string }} env
 * @param {{ query?: typeof awsQuery, now?: number, clock?: () => number, append?: (path: string, text: string) => void, log?: (line: string) => void, stamp?: () => string | undefined }} [io]
 */
export function reportStep(env, io = {}) {
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
    const { status, markdown, lines } = headline(env, { ...(io.query ? { query: io.query } : {}), now: io.now ?? at, clock, deadline: deadlineOf(started, at) });
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
    warn(`The headline report stopped on an error (${reasonOf(e, readerOf(env.ROLE)?.key ?? '')}); the job is not failed for it.`);
  }
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
  if (mode === 'mask') {
    // The job's start, for the report's deadline (kanon#682): this is the job's first step after
    // Kanon's path. Only a time, under the runner's temp directory, never the uploaded one.
    try {
      if (process.env.RUNNER_TEMP) writeFileSync(join(process.env.RUNNER_TEMP, STARTED_FILE), `${Date.now()}\n`);
    } catch { /* the report falls back to a budget of its own */ }
    for (const m of masksOf(process.env)) process.stdout.write(`::add-mask::${m}\n`);
    console.log('Masked the reader role, its account id and its key.');
    // THE TABLE AND REGION ARE RESOLVED HERE, ONCE (the Owner's decision on kanon#499): the
    // repository variables, or the hosted store's when unset or empty, checked, and written as this
    // step's outputs, which the credentials step and the read use. A value of the wrong shape stops
    // the job by name, and the agent's job reports the read `failed`.
    const { table, region, problems } = checkStore(process.env);
    if (problems.length) {
      for (const p of problems) console.log(`::error title=overseer telemetry::${p}`);
      process.exitCode = 1;
    } else {
      writeOutputs({ table, region });
      console.log(`Reading the telemetry table ${table} in ${region}.`);
    }
  } else if (mode === 'read') {
    const { status, files, lines } = read(process.env);
    const out = process.env.OUT ?? '';
    if (status === 'ran') {
      mkdirSync(out, { recursive: true });
      for (const [f, text] of Object.entries(files)) writeFileSync(join(out, f), text);
    } else {
      for (const l of lines) console.log(`::warning title=overseer telemetry::${l}`);
    }
    for (const l of lines) say(l);
    writeOutputs({ status });
  } else if (mode === 'report') {
    reportStep(process.env);
    process.exitCode = 0;
  } else if (mode === 'merge') {
    const { line } = merge(process.env);
    say(line);
  } else {
    console.error('usage: overseer-telemetry.mjs mask|read|report|merge');
    process.exitCode = 2;
  }
}
/* c8 ignore stop */
