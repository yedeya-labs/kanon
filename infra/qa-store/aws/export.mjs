#!/usr/bin/env node
// The contract's `export` on Kanon's AWS store: what a lane's agent may read of the store, as the
// files `actions/qa-store/qa-store.mjs` fixes (`EXPORT_FILES`), into "$DIR/export".
//
// NEW AT P9, NOT MOVED. Until now the reference adopter's audit and Overseer agents queried the
// table and read the bucket themselves, from their prompts, with the store's credentials in the
// agent's job. The export replaces that: a store job reads the same partitions with the same
// queries the prompts gave (`pk = :p`), and the agent reads files (plan 0004 §3.2). The item
// model is `push-run.sh`'s:
//   RUN#explorer / <ts>  → runs-explorer.json, newest first, after `FROM`
//   RUN#audit    / <ts>  → runs-audit.json, newest first, after `FROM`
//   COVERAGE     / <route> → coverage.json (a ledger: every row)
//   AREAS        / <area>  → areas.json (a ledger: every row)
//   <kind>/<ts>.json in the bucket → reports/<kind>/<ts>.json, for each run in the window
// The audit's export is `areas.json` alone; the Overseer's is all of it.
//
// A ROW IS ITS ATTRIBUTES, UNMARSHALLED, AND ABSENT STAYS ABSENT. `S` is a string, `N` a number
// and `BOOL` a boolean; the sort key is renamed for what it is (`ts`, `route`, `area`) and `pk`
// is dropped. An attribute a row doesn't carry is not in its object, never `false` or 0: the
// audit's liveness flags and the telemetry columns depend on that difference (`push-run.sh`).
//
// A FAILED READ FAILS THE EXPORT, so Kanon's `qa-store` block reports it degraded and the agent
// reads none of it. One exception: a run whose raw report isn't in the bucket (a skip marker
// has none, and a backfilled row may not) is left out of `reports/` with a notice.
//
// Env: QA_DYNAMO_TABLE, QA_S3_BUCKET, QA_AWS_REGION, KIND (`audit` or `overseer`), FROM, DIR.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXPORT_FILES, EXPORT_REPORTS } from '../../../actions/qa-store/qa-store.mjs';
import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';

/**
 * A DynamoDB attribute value as plain JSON.
 * @param {any} v
 * @returns {unknown}
 */
export function unmarshal(v) {
  if (v === null || typeof v !== 'object') return v;
  if ('S' in v) return v.S;
  if ('N' in v) return Number(v.N);
  if ('BOOL' in v) return v.BOOL;
  if ('NULL' in v) return null;
  if ('L' in v) return v.L.map(unmarshal);
  if ('M' in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, unmarshal(x)]));
  if ('SS' in v) return [...v.SS];
  if ('NS' in v) return v.NS.map(Number);
  return undefined;
}

/**
 * One item as a row: its sort key under `keyName`, every other attribute but `pk`, unmarshalled.
 * @param {Record<string, any>} item
 * @param {string} keyName
 */
export function toRow(item, keyName) {
  /** @type {Record<string, unknown>} */
  const row = { [keyName]: unmarshal(item.sk) };
  for (const [k, v] of Object.entries(item)) {
    if (k === 'pk' || k === 'sk') continue;
    const value = unmarshal(v);
    if (value !== undefined) row[k] = value;
  }
  return row;
}

/** What each partition becomes, per export kind. */
export const PARTITIONS = {
  'runs-explorer.json': { pk: 'RUN#explorer', key: 'ts', windowed: true, reports: 'explorer' },
  'runs-audit.json': { pk: 'RUN#audit', key: 'ts', windowed: true, reports: 'audit' },
  'coverage.json': { pk: 'COVERAGE', key: 'route', windowed: false, reports: '' },
  'areas.json': { pk: 'AREAS', key: 'area', windowed: false, reports: '' },
};
/** Which files each kind of export holds: the contract's list, not a copy of it. */
export const KINDS = /** @type {Record<string, Array<keyof typeof PARTITIONS>>} */ (EXPORT_FILES);

/**
 * The partition's items, newest first for a windowed one. The CLI follows every page.
 * @param {{ table: string, region: string, pk: string, from?: string }} q
 * @returns {Array<Record<string, any>>}
 */
export function queryPartition({ table, region, pk, from }) {
  const values = from ? { ':p': { S: pk }, ':s': { S: from } } : { ':p': { S: pk } };
  const raw = execFileSync('aws', [
    'dynamodb', 'query', '--table-name', table, '--region', region,
    '--key-condition-expression', from ? 'pk = :p AND sk > :s' : 'pk = :p',
    '--expression-attribute-values', JSON.stringify(values),
    ...(from ? ['--no-scan-index-forward'] : []),
    '--output', 'json',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw).Items ?? [];
}

/**
 * Copy one raw report from the bucket. False when the object isn't there; throws otherwise.
 * @param {{ bucket: string, region: string, key: string, to: string }} q
 */
export function copyReport({ bucket, region, key, to }) {
  try {
    execFileSync('aws', ['s3', 'cp', `s3://${bucket}/${key}`, to, '--region', region, '--only-show-errors'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (err) {
    const e = /** @type {{ stderr?: unknown }} */ (err);
    if (/\(404\)|Not Found|NoSuchKey/.test(String(e?.stderr ?? ''))) return false;
    throw err;
  }
}

/**
 * Write the export. Returns what it wrote, for the log.
 * @param {{ table: string, bucket: string, region: string, kind: string, from: string, dir: string }} o
 */
export function exportStore({ table, bucket, region, kind, from, dir }) {
  const files = KINDS[kind];
  if (!files) throw new Error(`export kind '${kind}' is not one of ${Object.keys(KINDS).join(', ')}`);
  const root = join(dir, 'export');
  mkdirSync(root, { recursive: true });
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const missing = [];
  for (const file of files) {
    const p = PARTITIONS[file];
    const items = queryPartition({ table, region, pk: p.pk, from: p.windowed ? from : undefined });
    const rows = items.map((it) => toRow(it, p.key));
    writeFileSync(join(root, file), `${JSON.stringify(rows, null, 2)}\n`);
    written.push(`${file} (${rows.length})`);
    if (kind !== 'overseer' || !p.reports) continue;
    const at = join(root, EXPORT_REPORTS, p.reports);
    mkdirSync(at, { recursive: true });
    for (const row of rows) {
      if (row.skipped === true || typeof row.ts !== 'string' || !/^\d{8}T\d{6}Z$/.test(row.ts)) continue;
      const key = `${p.reports}/${row.ts}.json`;
      if (!copyReport({ bucket, region, key, to: join(at, `${row.ts}.json`) })) missing.push(key);
    }
  }
  return { written, missing };
}

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  try {
    const { written, missing } = exportStore({
      table: env.QA_DYNAMO_TABLE ?? '', bucket: env.QA_S3_BUCKET ?? '', region: env.QA_AWS_REGION ?? '',
      kind: env.KIND ?? '', from: env.FROM ?? '', dir: env.DIR ?? '.',
    });
    for (const key of missing) console.log(`::notice title=qa-store export::no raw report at ${key}; left out of reports/`);
    console.log(`export: ${written.join(', ')}`);
  } catch (err) {
    const e = /** @type {{ stderr?: unknown, message?: unknown }} */ (err);
    console.log(`::warning title=qa-store export::the export failed (${String(e?.stderr || e?.message || '').trim().split('\n')[0]})`);
    process.exit(1);
  }
}
