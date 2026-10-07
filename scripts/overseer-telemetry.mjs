#!/usr/bin/env node
// The Overseer's own-adopter cost view (kanon#470; plan 0002 §6, plan 0004 §3.2 and step 13):
// `token-trend.md` and `cache-ttl.md`, computed from this repository's own telemetry rows, read
// with its telemetry reader role, and handed to the agent as two Markdown files, never as rows.
//
//   node "$KANON/scripts/overseer-telemetry.mjs" mask    the lane's `telemetry` job, first
//   node "$KANON/scripts/overseer-telemetry.mjs" read    the lane's `telemetry` job, after the
//                                                        credentials step
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
// telemetry, or hasn't mapped the secret) or `failed` (the role couldn't be assumed, or no
// partition could be read). The prompt reports that status and nothing more: a missing file never
// means the store is absent. A repository whose own store hook writes the two files keeps them
// whenever this read didn't run.
//
// `node:` built-ins and the `aws` CLI on GitHub's runner only (`K-SELF-8`).

import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { LANES } from '../infra/telemetry/function/schema.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { DAY_MS, TREND_ATTRIBUTES, render as renderTrend, summarize as summarizeTrend } from './lib/token-trend.mjs';
import { TTL_ATTRIBUTES, pinnedLanes, render as renderTtl, summarize as summarizeTtl } from './lib/cache-ttl.mjs';

/** The hosted store's table and region (docs/telemetry.md): the account denies every other region. */
export const TABLE = 'kanon-telemetry';
export const REGION = 'eu-central-1';
/** Two weeks: the token trend compares this week with the one before. */
export const WINDOW_DAYS = 14;
/** The files the read writes and the export carries. */
export const FILES = /** @type {const} */ (['token-trend.md', 'cache-ttl.md']);
/** The statuses the manifest's `telemetry` takes. */
export const STATUSES = /** @type {const} */ (['ran', 'not configured', 'failed']);

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
 * One `aws dynamodb query` of a partition since `from`, projected to `attributes`, every page.
 * @param {{ pk: string, from: string, attributes: readonly string[] }} q
 * @returns {import('./lib/token-trend.mjs').Item[]}
 */
export function awsQuery({ pk, from, attributes }) {
  const names = Object.fromEntries(attributes.map((a, i) => [`#a${i}`, a]));
  const out = execFileSync('aws', [
    'dynamodb', 'query',
    '--table-name', TABLE,
    '--region', REGION,
    '--key-condition-expression', '#pk = :p AND #sk > :from',
    '--projection-expression', Object.keys(names).join(', '),
    '--expression-attribute-names', JSON.stringify({ ...names, '#pk': 'pk', '#sk': 'sk' }),
    '--expression-attribute-values', JSON.stringify({ ':p': { S: pk }, ':from': { S: from } }),
    '--output', 'json',
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out).Items ?? [];
}

/**
 * A failed query's reason, one line, with the key and any account id taken out: it goes into a
 * file the agent reads.
 * @param {unknown} e @param {string} key
 */
export function reasonOf(e, key) {
  const err = /** @type {{ stderr?: string | Buffer, message?: string }} */ (e);
  const raw = String(err?.stderr || err?.message || (e instanceof Error ? '' : e ?? '')).split('\n').map((l) => l.trim()).find(Boolean) ?? 'the query failed';
  return raw.split(key).join('<key>').replace(/\b\d{12}\b/g, '<account>').replace(/arn:aws[^\s"')]*/g, '<arn>').slice(0, 200);
}

/**
 * The read: both reports from this repository's own rows, or why there are none.
 * @param {{ ROLE?: string, CREDENTIALS?: string, OUT?: string }} env
 * @param {{ query?: typeof awsQuery, now?: number, workflows?: string }} [io]
 * @returns {{ status: 'ran' | 'failed', lines: string[], files: Record<string, string> }}
 */
export function read(env, { query = awsQuery, now = Date.now(), workflows = WORKFLOWS } = {}) {
  const reader = readerOf(env.ROLE);
  if (!reader) {
    return { status: 'failed', files: {}, lines: ['The telemetry read failed: the KANON_TELEMETRY_READER_ROLE secret is not a telemetry reader role\'s ARN (`arn:aws:iam::<account>:role/kanon-telemetry-<key>-reader`, the stack\'s `ReaderRole<id>` output; docs/telemetry.md).'] };
  }
  if (env.CREDENTIALS !== 'success') {
    return { status: 'failed', files: {}, lines: ['The telemetry read failed: the reader role could not be assumed. Its trust names the default branch\'s ref, so a run on another ref (a dispatch from a branch, the runtime-version trigger\'s pull request) is refused; on the default branch, check the role\'s trust and the secret.'] };
  }
  const from = stamp(now - WINDOW_DAYS * DAY_MS);
  const attributes = [...new Set([...TREND_ATTRIBUTES, ...TTL_ATTRIBUTES])];
  /** @type {Array<{ lane: string, items: import('./lib/token-trend.mjs').Item[], error?: string }>} */
  const partitions = LANES.map((lane) => {
    try {
      return { lane, items: query({ pk: `${reader.key}#${lane}`, from, attributes }) };
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
    for (const m of masksOf(process.env)) process.stdout.write(`::add-mask::${m}\n`);
    console.log('Masked the reader role, its account id and its key.');
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
  } else if (mode === 'merge') {
    const { line } = merge(process.env);
    say(line);
  } else {
    console.error('usage: overseer-telemetry.mjs mask|read|merge');
    process.exitCode = 2;
  }
}
/* c8 ignore stop */
