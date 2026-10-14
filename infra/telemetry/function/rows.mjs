// A row's checks and stamps (plan 0002 §4, §10; plan 0003 §4; plan 0006 §5), shared by both of the
// ingest function's ways in: the SigV4 path (`index.mjs`) and the token path (`token.mjs`, plan
// 0008 §3). Moved here from `index.mjs`, which re-exports each name, so the two paths stamp a row
// exactly alike.
//
// Each row is validated with the schema module (the same file the lanes use, linked into this
// directory so `aws cloudformation package` zips it), checked against the `recorded_at` window,
// and stamped with `received_at`, `expires_at` and `source`. THE ROW CAN'T NAME A PARTITION:
// `pk` and `sk` are not schema fields, and `validate` rejects them like any other unknown field,
// so the partition is always built here from the key the caller's path chose.
//
// A FINDING ROW (plan 0006 §5, step 4) is stored from the collector only, never the importer or
// the backfill role, and only after intake's own checks, beyond `validate` (which already runs
// the scrub's `verify` with no context):
//   - `verify` again on its text, with THE SENDER'S CONTEXT: the SHA-256 of each word of its
//     repository's owner and name, never the words. Without hashes no finding is stored;
//   - `assertNoKey` (the aggregate's) over every field with every registered key, and each text
//     searched for a registered key joined to its neighbours by anything but a letter or a digit
//     (`holds-key.mjs`, the #41 job's and Jev's check too), since a key need not have the shape the
//     scrub's `key` rule refuses.
// Each failure is a rejected field, named with the rule or `key`, never the value.
//
// A DEPLOY ROW (plan 0010 §10, step D9) is stored under `<key>#deploy`, from the collector on
// either path and from the importer, like a run row; never from the backfill role. Its fields are
// numbers, times, booleans and closed words only, so `validate` is all its intake needs. The
// aggregate never reads it: no cross-adopter deploy figure is published (decision 11).

import { Buffer } from 'node:buffer';
import { assertNoKey } from './aggregate.mjs';
import { holdsKey } from './holds-key.mjs';
import { DEPLOY_PARTITION, FINDING_PARTITION, LANES, RESERVED_PARTITION, SCHEMAS, validate } from './schema.mjs';
import { verify } from './scrub.mjs';

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
/**
 * The row kinds this function stores, each in a partition `PARTITIONS` names, so erasure walks it.
 * A kind the schema knows but this list doesn't is refused with `row_kind (not-allowed)`: stored,
 * it would land outside every partition erasure walks. The deploy row joined at plan 0010 D9.
 */
export const STORED_KINDS = Object.freeze(['run', 'work_item', 'finding', 'deploy']);

/**
 * `writer` is the collector, on either path; `importer` and `backfill` are the Owner's roles.
 * @typedef {{ kind: 'writer' | 'importer' | 'backfill', key: string | null }} Caller
 * @typedef {{ nameHashes: Set<string> | null, keys: Set<string> }} FindingContext the sender's
 *   name hashes (null: none, so no finding is stored) and every registered key
 */

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

/** A SHA-256, as `nameContext` writes each word's. */
const HASH = /^[0-9a-f]{64}$/;

/**
 * Name hashes as a set, or null when there are none or any is not a hash: then no finding of that
 * sender is stored.
 * @param {unknown} hashes
 * @returns {Set<string> | null}
 */
export function hashSet(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0 || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) return null;
  return new Set(hashes);
}

/** A finding row's free-text fields (plan 0006 §2.2), read from the schema: the `text` type. */
export const TEXT_FIELDS = Object.freeze(Object.entries(/** @type {Record<string, { type: string }>} */ (SCHEMAS.finding?.[1] ?? {}))
  .filter(([, f]) => f.type === 'text').map(([name]) => name));

/**
 * Intake's own checks of a VALID finding row (plan 0006 §5, step 4), past `validate`: who sent it,
 * its text against the sender's context, and every registered key. Problems by field name and rule
 * name only.
 * @param {Record<string, any>} row
 * @param {{ caller: Caller } & FindingContext} ctx
 * @returns {{ field: string, problem: string }[]}
 */
export function findingProblems(row, { caller, nameHashes, keys }) {
  if (caller.kind !== 'writer') return [{ field: 'row_kind', problem: 'not-allowed' }];
  if (!nameHashes) return [{ field: 'row_kind', problem: 'no-sender-context' }];
  /** @type {{ field: string, problem: string }[]} */
  const out = [];
  for (const field of TEXT_FIELDS) {
    if (typeof row[field] === 'string') for (const rule of verify(row[field], { nameHashes })) out.push({ field, problem: rule });
  }
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
export const compact = (/** @type {string} */ iso) => `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;

/**
 * The row's key (§4, plan 0003 §4). A run row: `<key>#<lane>`, sorted by time, then run,
 * attempt and PR or issue number. A work item: `<key>#work`, one row per PR. A finding:
 * `<key>#finding`, sorted by time, then run, attempt and its place in the run's report
 * (plan 0006 §2.3). A deploy row: `<key>#deploy`, sorted by time, then run, attempt and the
 * environment's position, so each environment of one run is its own item (plan 0010 §10).
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
  if (row.row_kind === 'deploy') {
    return { pk: `${key}#${DEPLOY_PARTITION}`, sk: `${compact(row.recorded_at)}#${row.run_id}-${row.run_attempt}-${row.position}` };
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
 * @param {{ caller: Caller, key: string, now: number, finding?: FindingContext }} ctx `finding` for
 *   a finding row's checks; without it no finding is stored
 * @returns {{ ok: true, item: Record<string, any> } | { ok: false, errors: { field: string, problem: string }[] }}
 */
export function stamp(row, { caller, key, now, finding }) {
  // The importer's rows predate Kanon, so they carry no `kanon_version` (decision 17).
  const v = validate(row, { imported: caller.kind === 'importer' });
  if (!v.ok) return v;
  const r = /** @type {Record<string, any>} */ (row);
  if (!STORED_KINDS.includes(r.row_kind)) return { ok: false, errors: [{ field: 'row_kind', problem: 'not-allowed' }] };
  /** @type {{ field: string, problem: string }[]} */
  const errors = [];
  // A finding row: the collector only, its text against the sender's context, and no registered key.
  if (r.row_kind === 'finding') errors.push(...findingProblems(r, { caller, ...(finding ?? { nameHashes: null, keys: new Set() }) }));
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

/**
 * A plain item as DynamoDB attribute values. The schema has no nesting: a list is a
 * comma-separated string (`closing_issues: '12,34'`), so `validate` refuses an array before it
 * gets here. Any other value throws, naming the field only, so the row is reported failed rather
 * than stored without it (kanon#754). An undefined field is an absent one.
 */
export function toAttributes(/** @type {Record<string, unknown>} */ item) {
  /** @type {Record<string, object>} */
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === 'string') out[k] = { S: v };
    else if (typeof v === 'number') out[k] = { N: String(v) };
    else if (typeof v === 'boolean') out[k] = { BOOL: v };
    else if (v !== undefined) throw new Error(`toAttributes: ${k} is not a string, number or boolean`);
  }
  return out;
}

/**
 * The request's rows, as both paths take them: a JSON array of 1 to 25 rows, at most 256 KB.
 * @param {any} event a function URL event
 * @returns {{ ok: true, rows: unknown[] } | { ok: false, status: number, error: string }}
 */
export function rowsOf(event) {
  const raw = typeof event?.body === 'string' ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0);
  if (raw.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'body-size' };
  /** @type {unknown} */
  let rows;
  try {
    rows = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, status: 400, error: 'body-json' };
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return { ok: false, status: 400, error: 'body-rows' };
  return { ok: true, rows };
}

/** @typedef {{ status: 'stored' } | { status: 'rejected', errors: { field: string, problem: string }[] } | { status: 'failed' }} RowResult */

/**
 * Stamp each row, then write each that passed; the answer is per row. Rows are written only when
 * `admit` (the token path's day quota, plan 0008 §6) admits the count of rows that passed, all of
 * them or none.
 * @param {unknown[]} rows
 * @param {{ caller: Caller, key: string, now: number, finding?: FindingContext,
 *   put: (item: Record<string, any>) => Promise<void>, admit?: (n: number) => Promise<boolean> }} ctx
 * @returns {Promise<{ admitted: boolean, status: number, results: RowResult[], logged: object[] }>}
 */
export async function storeRows(rows, { caller, key, now, finding, put, admit }) {
  const stamped = rows.map((row) => stamp(row, { caller, key, now, finding }));
  const passed = stamped.filter((s) => s.ok).length;
  if (admit && passed > 0 && !(await admit(passed))) return { admitted: false, status: 429, results: [], logged: [] };
  /** @type {RowResult[]} */
  const results = [];
  /** @type {object[]} */
  const logged = [];
  for (const [index, s] of stamped.entries()) {
    if (!s.ok) {
      results.push({ status: 'rejected', errors: s.errors });
      logged.push({ index, rejected: s.errors.map((e) => e.field) });
      continue;
    }
    try {
      await put(s.item);
      results.push({ status: 'stored' });
      logged.push({ index, pk: s.item.pk, sk: s.item.sk });
    } catch {
      results.push({ status: 'failed' });
      logged.push({ index, pk: s.item.pk, sk: s.item.sk, failed: true });
    }
  }
  const status = results.some((r) => r.status === 'failed') ? 502 : results.some((r) => r.status === 'rejected') ? 422 : 200;
  return { admitted: true, status, results, logged };
}

// Kept so the lane list the erase script walks is the one this function writes (§10), and the
// finding and deploy partitions, which erasure must reach too (plan 0006 §2.3, plan 0010 D9).
export const PARTITIONS = Object.freeze([...LANES, RESERVED_PARTITION, FINDING_PARTITION, DEPLOY_PARTITION]);
