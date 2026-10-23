#!/usr/bin/env node
// The contract's `cost-rows` on Kanon's AWS store: one telemetry agent's `COST#<agent>` rows for
// a window, as `readCostRows` returns them, `{ rows: [{ ts, issue_number, outcome, run_id }], error }`.
//
// MOVED FROM THE LIBRARY (Kanon plan 0004 step P9, ADR 0009): this is `readCostRows`'s query in
// `scripts/dispatch-sweep.mjs`, which now calls `queryCostRows` here, so the sweep's own read and
// the store hook's answer are one query until step 9 moves the sweep onto the hook. Nothing in
// the query changed: the key condition, the projection and the parse are the sweep's.
//
// FAILS CLOSED AND SAYS WHY. On any failure the file holds no rows and an `error`, and the script
// exits 1, so Kanon's `qa-store` block reports `state: degraded` and keeps this error rather than
// a generic one (RA-2706: a read that didn't happen must say so).
//
// THIS REPOSITORY'S ROWS (kanon#1346, `keys.mjs`): the partition is `COST#<agent>#<repository id>`.
// While it holds no row at all, the query reads the unkeyed `COST#<agent>` written before
// kanon#1346 instead, as it did then; the repository's first row, or the Owner's migration, ends that.
//
// Env: QA_DYNAMO_TABLE, QA_AWS_REGION, KIND (the telemetry agent), FROM (exclusive), TO
// (inclusive, optional), DIR, GITHUB_REPOSITORY_ID (the runner's).

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';
import { keyed, repositoryId } from './keys.mjs';

/** Exactly the attributes the sweep reads (`dispatch-sweep.mjs`'s `COST_PROJECTION`). */
export const COST_PROJECTION = ['sk', 'issue_number', 'outcome', 'run_id'];

/**
 * One agent's cost rows for one repository after `since` (a store stamp), and up to `to` when it
 * is given; the unkeyed rows while the repository has none of its own. Throws on any failure of a
 * query or its parse.
 * @param {{ agent: string, since: string, to?: string, table: string, region: string, repository: string }} q
 * @returns {Array<{ ts: string|null, issue_number: string|null, outcome: string|null, run_id: string|null }>}
 */
export function queryCostRows({ agent, since, to = '', table, region, repository }) {
  const own = keyed(`COST#${agent}`, repository);
  let items = costItems({ pk: own, since, table, region });
  // An empty window is not an empty partition: read unkeyed only if the repository has no row at all.
  if (!items.length && !costItems({ pk: own, since: '', table, region, one: true }).length) {
    items = costItems({ pk: `COST#${agent}`, since, table, region });
  }
  const rows = items.map((/** @type {any} */ it) => ({
    ts: it.sk?.S ?? null,
    issue_number: it.issue_number?.N ?? null,
    outcome: it.outcome?.S ?? null,
    run_id: it.run_id?.S ?? null,
  }));
  // The upper bound is the contract's (`query(lane, from, to)`); the sweep passes none.
  return to ? rows.filter((/** @type {{ ts: string|null }} */ r) => r.ts !== null && r.ts <= to) : rows;
}

/**
 * One partition's cost items after `since`, projected; with `one`, at most one item.
 * @param {{ pk: string, since: string, table: string, region: string, one?: boolean }} q
 * @returns {Array<Record<string, any>>}
 */
function costItems({ pk, since, table, region, one = false }) {
  const raw = execFileSync('aws', [
    'dynamodb', 'query', '--table-name', table, '--region', region,
    '--key-condition-expression', 'pk = :p AND sk > :s',
    '--expression-attribute-values',
    JSON.stringify({ ':p': { S: pk }, ':s': { S: since } }),
    // `sk` too: a row's timestamp is what pairs a run with the sweep comment that
    // dispatched it (RA-1573 review, RA-1579) — and `run_id`, which says WHO triggered it.
    //
    // A CONSTANT, NOT A LITERAL (RA-1586). Two of the reference adopter's documents
    // recorded this bound as a claim a reader can check, and both said "two fields" for
    // as long as this projected three, because nothing failed when they disagreed.
    // `dispatch-sweep.test.ts` asserts the CONTENTS of this list; a widening here is now
    // a red test rather than a third round of the same drift.
    '--projection-expression', COST_PROJECTION.join(', '),
    ...(one ? ['--max-items', '1'] : []),
    '--output', 'json',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(raw).Items ?? [];
}

/** The first line of a failed command's stderr, which is where the CLI says why. @param {unknown} err */
const cause = (err) => {
  const e = /** @type {{ stderr?: unknown, message?: unknown }} */ (err);
  const text = String(e?.stderr || e?.message || '').trim();
  return text.split('\n').find((l) => l.trim()) ?? '';
};

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const out = join(env.DIR || '.', 'cost-rows.json');
  try {
    const rows = queryCostRows({
      agent: env.KIND ?? '', since: env.FROM ?? '', to: env.TO ?? '',
      table: env.QA_DYNAMO_TABLE ?? '', region: env.QA_AWS_REGION ?? '', repository: repositoryId(env),
    });
    writeFileSync(out, `${JSON.stringify({ rows, error: null })}\n`);
    console.log(`cost-rows: ${rows.length} COST#${env.KIND} rows after ${env.FROM}`);
  } catch (err) {
    writeFileSync(out, `${JSON.stringify({ rows: [], error: `the store query failed (${cause(err) || 'no stderr'})` })}\n`);
    console.log(`::warning title=qa-store cost-rows::the store query failed (${cause(err) || 'no stderr'})`);
    process.exit(1);
  }
}
