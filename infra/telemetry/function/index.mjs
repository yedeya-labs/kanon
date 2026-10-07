// The ingest function (plan 0002 §4): the only code that may write the telemetry table.
//
// It sits behind a function URL with `AWS_IAM` auth, so every request is SigV4-signed by a
// role, and Lambda puts that role in `requestContext.authorizer.iam`. The function maps the
// role to the adopter's key and builds the partition itself: the ROW CAN'T NAME A PARTITION,
// because `pk` and `sk` are not schema fields and `validate` rejects them like any other
// unknown field. So a writer can only ever write its own key.
//
// Each row is validated with the schema module (the same file the lanes use, linked into this
// directory so `aws cloudformation package` zips it), checked against the `recorded_at`
// window, stamped with `received_at`, `expires_at` and `source`, and written with `PutItem`.
// The answer is per row; any rejection makes the response 422, and the collector turns red.
//
// A FINDING ROW (plan 0006 §5, step 4) is stored from a writer only, never the importer or the
// backfill role, and only after intake's own checks, beyond `validate` (which already runs the
// scrub's `verify` with no context):
//   - `verify` again on its text, with THE SENDER'S CONTEXT: the SHA-256 of each word of the
//     registered repository's owner and name, which `render.mjs` writes into `NAME_HASHES` per key,
//     never the words. A key with no hashes there gets no finding stored: the check can't run;
//   - `assertNoKey` (the aggregate's) over every field with every registered key, and each text
//     searched for a registered key as a word, since a key need not have the shape the scrub's
//     `key` rule refuses.
// Each failure is a rejected field, named with the rule or `key`, never the value.
//
// LOGS HOLD KEYS AND FIELD NAMES ONLY (§9, §10). A rejected row may carry content, so nothing
// here logs or echoes a value.
//
// `node:` built-ins only: DynamoDB is called over HTTPS with the signer beside this file.

import { Buffer } from 'node:buffer';
import { assertNoKey } from './aggregate.mjs';
import { FINDING_PARTITION, LANES, RESERVED_PARTITION, SCHEMAS, validate } from './schema.mjs';
import { verify } from './scrub.mjs';
import { sign } from './sigv4.mjs';

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_ROWS = 25;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A row's `recorded_at` may be this far back: artifact retention plus slack (§4)... */
export const RECORDED_BACK_MS = 8 * DAY;
/** ...and this far ahead, for clock skew. */
export const RECORDED_AHEAD_MS = 10 * MINUTE;
/** Retention: 13 calendar months for `run` rows, 30 days for `smoke` and `test` (§10). */
export const RETENTION_MONTHS = 13;
export const SHORT_RETENTION_MS = 30 * DAY;

/** The writer role's name, from which the key is read (§3). */
const WRITER_ROLE = /^kanon-telemetry-([a-z0-9][a-z0-9-]{0,31})-writer$/;
const ASSUMED_ROLE = /^arn:aws[a-z-]*:sts::(\d+):assumed-role\/([^/]+)\/[^/]+$/;

/**
 * `date` plus `months` calendar months, clamped to the month's last day (31 Jan + 1 = 28 Feb).
 * @param {number} ms
 * @param {number} months
 */
export function addMonths(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * @typedef {{ kind: 'writer' | 'importer' | 'backfill', key: string | null }} Caller
 * @typedef {{ TABLE_NAME: string, ACCOUNT_ID: string, WRITER_KEYS: string, NAME_HASHES?: string, IMPORTER_ROLE?: string, BACKFILL_ROLE?: string, AWS_REGION?: string }} Env
 */

/**
 * Who is calling, from the role Lambda authenticated, or null for anyone else. A writer's key
 * comes from its role name and must be in the register; the importer and the backfill role
 * name no key of their own (§7).
 * @param {unknown} event
 * @param {Env} env
 * @returns {Caller | null}
 */
export function callerOf(event, env) {
  const arn = /** @type {any} */ (event)?.requestContext?.authorizer?.iam?.userArn;
  const m = typeof arn === 'string' ? ASSUMED_ROLE.exec(arn) : null;
  if (!m || m[1] !== env.ACCOUNT_ID) return null;
  const role = /** @type {string} */ (m[2]);
  if (env.IMPORTER_ROLE && role === env.IMPORTER_ROLE) return { kind: 'importer', key: null };
  if (env.BACKFILL_ROLE && role === env.BACKFILL_ROLE) return { kind: 'backfill', key: null };
  const w = WRITER_ROLE.exec(role);
  if (w && registeredKeys(env).includes(/** @type {string} */ (w[1]))) return { kind: 'writer', key: /** @type {string} */ (w[1]) };
  return null;
}

const registeredKeys = (/** @type {Env} */ env) => env.WRITER_KEYS.split(',').filter(Boolean);

/** A SHA-256, as `render.mjs` writes each word's. */
const HASH = /^[0-9a-f]{64}$/;

/**
 * The sender's name hashes (plan 0006 §4.2): `NAME_HASHES` is `<key>=<hash>:<hash>…`, one entry per
 * registered key, comma-separated, as `render.mjs` writes it. Null when the key has no entry, or
 * the entry holds anything but hashes: then no finding of that key is stored.
 * @param {Env} env
 * @param {string} key
 * @returns {Set<string> | null}
 */
export function nameHashesOf(env, key) {
  for (const entry of (env.NAME_HASHES ?? '').split(',')) {
    const at = entry.indexOf('=');
    if (at < 0 || entry.slice(0, at) !== key) continue;
    const hashes = entry.slice(at + 1).split(':');
    return hashes.length && hashes.every((h) => HASH.test(h)) ? new Set(hashes) : null;
  }
  return null;
}

/** A finding row's free-text fields (plan 0006 §2.2), read from the schema: the `text` type. */
export const TEXT_FIELDS = Object.freeze(Object.entries(/** @type {Record<string, { type: string }>} */ (SCHEMAS.finding?.[1] ?? {}))
  .filter(([, f]) => f.type === 'text').map(([name]) => name));

/**
 * Whether a text holds a key as a word: not inside a longer run of key characters.
 * @param {string} text
 * @param {string} key
 */
const holdsKey = (text, key) =>
  new RegExp(`(?<![a-z0-9-])${key.replace(/-/g, '\\-')}(?![a-z0-9-])`).test(text.toLowerCase());

/**
 * Intake's own checks of a VALID finding row (plan 0006 §5, step 4), past `validate`: who sent it,
 * its text against the sender's context, and every registered key. Problems by field name and rule
 * name only.
 * @param {Record<string, any>} row
 * @param {{ caller: Caller, key: string, env: Env }} ctx
 * @returns {{ field: string, problem: string }[]}
 */
export function findingProblems(row, { caller, key, env }) {
  if (caller.kind !== 'writer') return [{ field: 'row_kind', problem: 'not-allowed' }];
  const nameHashes = nameHashesOf(env, key);
  if (!nameHashes) return [{ field: 'row_kind', problem: 'no-sender-context' }];
  /** @type {{ field: string, problem: string }[]} */
  const out = [];
  for (const field of TEXT_FIELDS) {
    if (typeof row[field] === 'string') for (const rule of verify(row[field], { nameHashes })) out.push({ field, problem: rule });
  }
  const keys = new Set(registeredKeys(env));
  for (const [field, value] of Object.entries(row)) {
    let held = false;
    try {
      assertNoKey(value, keys);
    } catch {
      held = true;
    }
    if (!held && TEXT_FIELDS.includes(field) && typeof value === 'string') held = [...keys].some((k) => holdsKey(value, k));
    if (held && !out.some((e) => e.field === field && e.problem === 'key')) out.push({ field, problem: 'key' });
  }
  return out;
}

/** `2026-10-02T09:15:00Z` -> `20261002T091500Z`. */
const compact = (/** @type {string} */ iso) => `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;

/**
 * The row's key (§4, plan 0003 §4). A run row: `<key>#<lane>`, sorted by time, then run,
 * attempt and PR or issue number. A work item: `<key>#work`, one row per PR. A finding:
 * `<key>#finding`, sorted by time, then run, attempt and its place in the run's report
 * (plan 0006 §2.3).
 * @param {string} key
 * @param {Record<string, any>} row a VALID row
 */
export function keysOf(key, row) {
  if (row.row_kind === 'work_item') {
    return { pk: `${key}#${RESERVED_PARTITION}`, sk: `pr-${String(row.pr_number).padStart(10, '0')}` };
  }
  if (row.row_kind === 'finding') {
    return { pk: `${key}#${FINDING_PARTITION}`, sk: `${compact(row.recorded_at)}#${row.run_id}-${row.run_attempt}-${row.finding_index}` };
  }
  const n = row.pr_number ?? row.issue_number ?? 0;
  return { pk: `${key}#${row.lane}`, sk: `${compact(row.recorded_at)}#${row.run_id}-${row.run_attempt}-${n}` };
}

/**
 * `expires_at`, in epoch seconds for DynamoDB's TTL (§10). A work item expires 13 months after
 * `closed_at`, never `recorded_at`, so a rewrite can't extend it.
 * @param {Record<string, any>} row a VALID row
 */
export function expiresOf(row) {
  const recorded = Date.parse(row.recorded_at);
  if (row.tag !== 'run') return Math.floor((recorded + SHORT_RETENTION_MS) / 1000);
  const from = row.row_kind === 'work_item' ? Date.parse(row.closed_at) : recorded;
  return Math.floor(addMonths(from, RETENTION_MONTHS) / 1000);
}

/**
 * Check and stamp one row. Returns the item to store, or the problems by FIELD NAME only.
 * @param {unknown} row
 * @param {{ caller: Caller, key: string, now: number, env?: Env }} ctx `env` for a finding row's checks
 * @returns {{ ok: true, item: Record<string, any> } | { ok: false, errors: { field: string, problem: string }[] }}
 */
export function stamp(row, { caller, key, now, env }) {
  // The importer's rows predate Kanon, so they carry no `kanon_version` (decision 17).
  const v = validate(row, { imported: caller.kind === 'importer' });
  if (!v.ok) return v;
  const r = /** @type {Record<string, any>} */ (row);
  /** @type {{ field: string, problem: string }[]} */
  const errors = [];
  // A finding row: writers only, its text against the sender's context, and no registered key.
  if (r.row_kind === 'finding') errors.push(...findingProblems(r, { caller, key, env: env ?? { TABLE_NAME: '', ACCOUNT_ID: '', WRITER_KEYS: '' } }));
  else if (caller.kind === 'backfill' && r.row_kind !== 'work_item') errors.push({ field: 'row_kind', problem: 'not-allowed' });
  // Only the importer backdates, and only as far as retention reaches (§7).
  const earliest = caller.kind === 'importer' ? addMonths(now, -RETENTION_MONTHS) : now - RECORDED_BACK_MS;
  const recorded = Date.parse(r.recorded_at);
  if (recorded < earliest || recorded > now + RECORDED_AHEAD_MS) errors.push({ field: 'recorded_at', problem: 'window' });
  if (r.row_kind === 'work_item') {
    const closed = Date.parse(r.closed_at);
    if (closed > now || closed < addMonths(now, -RETENTION_MONTHS)) errors.push({ field: 'closed_at', problem: 'window' });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    item: {
      ...r,
      ...keysOf(key, r),
      source: caller.kind === 'writer' ? 'collector' : caller.kind === 'importer' ? 'import' : 'backfill',
      received_at: new Date(now).toISOString(),
      expires_at: expiresOf(r),
    },
  };
}

/** A plain item as DynamoDB attribute values. The schema has no nesting. */
export function toAttributes(/** @type {Record<string, unknown>} */ item) {
  /** @type {Record<string, object>} */
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === 'string') out[k] = { S: v };
    else if (typeof v === 'number') out[k] = { N: String(v) };
    else if (typeof v === 'boolean') out[k] = { BOOL: v };
  }
  return out;
}

/**
 * `PutItem` over HTTPS with the function's own credentials. A re-sent row has the same key and
 * overwrites (§4).
 * @param {Record<string, any>} item
 * @param {Env} env
 * @param {typeof fetch} fetchImpl
 */
export async function putItem(item, env, fetchImpl = fetch) {
  const region = env.AWS_REGION ?? 'eu-central-1';
  const url = `https://dynamodb.${region}.amazonaws.com/`;
  const body = JSON.stringify({ TableName: env.TABLE_NAME, Item: toAttributes(item) });
  const headers = { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.PutItem' };
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { ...headers, ...sign({ method: 'POST', url, headers, body, region, service: 'dynamodb', credentials }) },
    body,
  });
  if (!res.ok) throw new Error(`PutItem ${res.status}`);
}

const reply = (/** @type {number} */ statusCode, /** @type {unknown} */ body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * @param {any} event a function URL event
 * @param {{ env?: Env, now?: () => number, put?: (item: Record<string, any>, env: Env) => Promise<void>, log?: (line: string) => void }} [deps]
 */
export async function handle(event, deps = {}) {
  const env = deps.env ?? /** @type {Env} */ (/** @type {unknown} */ (process.env));
  const now = (deps.now ?? Date.now)();
  const put = deps.put ?? putItem;
  const log = deps.log ?? ((/** @type {string} */ line) => console.log(line));

  if (event?.requestContext?.http?.method !== 'POST') return reply(405, { error: 'method' });
  const caller = callerOf(event, env);
  if (!caller) {
    log(JSON.stringify({ rejected: 'caller' }));
    return reply(403, { error: 'caller' });
  }
  // Only the importer and the backfill role name the adopter's key, and only one in the register.
  const named = event.queryStringParameters?.key;
  if (caller.kind === 'writer' && named !== undefined) return reply(400, { error: 'key-not-allowed' });
  if (caller.kind !== 'writer' && !(typeof named === 'string' && registeredKeys(env).includes(named))) {
    return reply(400, { error: 'key' });
  }
  const key = /** @type {string} */ (caller.key ?? named);

  const raw = typeof event.body === 'string' ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0);
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: 'body-size' });
  /** @type {unknown} */
  let rows;
  try {
    rows = JSON.parse(raw.toString('utf8'));
  } catch {
    return reply(400, { error: 'body-json' });
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return reply(400, { error: 'body-rows' });

  /** @type {({ status: 'stored' } | { status: 'rejected', errors: { field: string, problem: string }[] } | { status: 'failed' })[]} */
  const results = [];
  /** @type {object[]} */
  const logged = [];
  for (const [index, row] of rows.entries()) {
    const s = stamp(row, { caller, key, now, env });
    if (!s.ok) {
      results.push({ status: 'rejected', errors: s.errors });
      logged.push({ index, rejected: s.errors.map((e) => e.field) });
      continue;
    }
    try {
      await put(s.item, env);
      results.push({ status: 'stored' });
      logged.push({ index, pk: s.item.pk, sk: s.item.sk });
    } catch {
      results.push({ status: 'failed' });
      logged.push({ index, pk: s.item.pk, sk: s.item.sk, failed: true });
    }
  }
  log(JSON.stringify({ caller: caller.kind, key, rows: logged }));
  const status = results.some((r) => r.status === 'failed') ? 502 : results.some((r) => r.status === 'rejected') ? 422 : 200;
  return reply(status, { results });
}

/** The Lambda entry point. */
export const handler = (/** @type {any} */ event) => handle(event);

// Kept so the lane list the erase script walks is the one this function writes (§10), and the
// finding partition, which erasure must reach too (plan 0006 §2.3).
export const PARTITIONS = Object.freeze([...LANES, RESERVED_PARTITION, FINDING_PARTITION]);
