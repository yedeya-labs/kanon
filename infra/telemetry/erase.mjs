#!/usr/bin/env node
// Erase one adopter's rows (plan 0002 §10, step 2), run by the Owner.
//
//   node infra/telemetry/erase.mjs --key <key> [--profile kanon] [--apply]
//
// Without --apply it only counts. It walks every partition the ingest function can write for
// the key, `<key>#<lane>` for each lane in the schema's enum, `<key>#work` and `<key>#finding`
// (plan 0006 §2.3), so it is complete without a scan. The table's resource policy lets only the function's role and the
// Owner's role delete, so it runs with the Owner's profile. Remove the key from the register
// and redeploy first (step 1), so nothing writes while it runs. It prints counts only.

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { PARTITIONS } from './function/index.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

export const REGION = 'eu-central-1';
export const TABLE = 'kanon-telemetry';

/** @typedef {(args: string[]) => { code: number, stdout: string }} Aws */

/** Every partition the key can hold. */
export const partitionsOf = (/** @type {string} */ key) => PARTITIONS.map((p) => `${key}#${p}`);

/**
 * @param {string} key
 * @param {{ aws: Aws, profile: string, apply: boolean }} opts
 * @returns {{ partition: string, rows: number }[]}
 */
export function erase(key, { aws, profile, apply }) {
  const base = ['--profile', profile, '--region', REGION, '--output', 'json'];
  return partitionsOf(key).map((partition) => {
    /** @type {{ pk: object, sk: object }[]} */
    const keys = [];
    /** @type {string | undefined} */
    let start;
    do {
      const r = aws(['dynamodb', 'query', '--table-name', TABLE, '--key-condition-expression', 'pk = :p',
        '--expression-attribute-values', JSON.stringify({ ':p': { S: partition } }), '--projection-expression', 'pk, sk',
        ...(start ? ['--exclusive-start-key', start] : []), ...base]);
      if (r.code !== 0) throw new Error(`query failed on ${partition}`);
      const page = JSON.parse(r.stdout);
      keys.push(...page.Items);
      start = page.LastEvaluatedKey ? JSON.stringify(page.LastEvaluatedKey) : undefined;
    } while (start);
    if (apply) {
      for (let i = 0; i < keys.length; i += 25) {
        let requests = { [TABLE]: keys.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: k } })) };
        // BatchWriteItem may leave items unprocessed under throttling; retry those.
        for (let tries = 0; requests[TABLE]?.length; tries++) {
          if (tries === 5) throw new Error(`deletes still unprocessed on ${partition}`);
          const r = aws(['dynamodb', 'batch-write-item', '--request-items', JSON.stringify(requests), ...base]);
          if (r.code !== 0) throw new Error(`delete failed on ${partition}`);
          requests = JSON.parse(r.stdout).UnprocessedItems ?? {};
        }
      }
    }
    return { partition, rows: keys.length };
  });
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({
    options: { key: { type: 'string' }, profile: { type: 'string', default: 'kanon' }, apply: { type: 'boolean', default: false } },
  });
  if (!values.key) {
    console.error('usage: erase.mjs --key <key> [--profile kanon] [--apply]');
    process.exit(2);
  }
  /** @type {Aws} */
  const aws = (args) => {
    const r = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, stdout: r.stdout ?? '' };
  };
  const counts = erase(values.key, { aws, profile: values.profile, apply: values.apply });
  for (const c of counts) if (c.rows) console.log(`${c.partition}: ${c.rows} ${values.apply ? 'deleted' : 'found'}`);
  console.log(`${counts.reduce((n, c) => n + c.rows, 0)} rows ${values.apply ? 'deleted' : 'found (dry run; pass --apply to delete)'}`);
}
