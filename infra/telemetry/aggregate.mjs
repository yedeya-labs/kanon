#!/usr/bin/env node
// The aggregate (plan 0002 §6 and §6.1), run by the Owner.
//
//   node infra/telemetry/aggregate.mjs --register <register.json> [--profile kanon]
//
// The figures are `function/aggregate.mjs`'s, the same module the aggregate-only function
// serves, so the Owner sees exactly what the function would answer, plus `notes`:
// - `cross_adopter`: lane-and-model cells from `tag = run` run rows (run count, median and
//   90th-percentile cost per run), each only when AT LEAST THREE DISTINCT ADOPTERS contribute;
// - `own`: an adopter's own cells, only for an adopter whose register entry sets
//   `publish_own_figures_as`, under that label, never its key;
// - `signals`: the week's failures by lane, reason, stage, Kanon error and version, with how many
//   adopters each affected;
// - `notes`: the cells withheld and the runs left out (no model, no cost). They are totals over
//   every adopter, so they are the Owner's alone and never leave.
//
// It reads the store the way `erase.mjs` does: with the Owner's profile, which is the one role
// that reads every key (§6), walking `<key>#<lane>` for every key in the private register and
// every lane in the schema's enum, so it needs no scan. It never prints a row or a key.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { aggregate, readAll } from './function/aggregate.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

export const REGION = 'eu-central-1';
export const TABLE = 'kanon-telemetry';
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** @typedef {(args: string[]) => { code: number, stdout: string }} Aws */

/**
 * The same Query the function sends, through the AWS CLI with the Owner's profile, one page a
 * call.
 * @param {{ aws: Aws, profile: string }} opts
 * @returns {(request: Record<string, any>) => Promise<any>}
 */
export function cliQuery({ aws, profile }) {
  return async (request) => {
    const r = aws(['dynamodb', 'query', '--table-name', request.TableName,
      '--key-condition-expression', request.KeyConditionExpression,
      '--filter-expression', request.FilterExpression,
      '--projection-expression', request.ProjectionExpression,
      '--expression-attribute-names', JSON.stringify(request.ExpressionAttributeNames),
      '--expression-attribute-values', JSON.stringify(request.ExpressionAttributeValues),
      '--select', request.Select,
      ...(request.ExclusiveStartKey ? ['--exclusive-start-key', JSON.stringify(request.ExclusiveStartKey)] : []),
      '--no-paginate', '--profile', profile, '--region', REGION, '--output', 'json']);
    // The partition is not printed: it holds the key.
    if (r.code !== 0) throw new Error('a query failed');
    return JSON.parse(r.stdout);
  };
}

/**
 * The register's keys, and the label of each adopter that declared its own figures publishable.
 * Says what's wrong without echoing anything of the register.
 * @param {any} register
 * @returns {{ keys: string[], own: Record<string, string> }}
 */
export function fromRegister(register) {
  const entries = Array.isArray(register?.repositories) ? register.repositories : [];
  const keys = entries.map((/** @type {any} */ e) => e?.key);
  if (keys.length === 0 || !keys.every((/** @type {unknown} */ k) => typeof k === 'string' && KEY.test(k))) {
    throw new Error('the register has no repositories, or an entry without a valid key');
  }
  /** @type {Record<string, string>} */
  const own = {};
  for (const e of entries) {
    if (e.publish_own_figures_as === undefined) continue;
    if (typeof e.publish_own_figures_as !== 'string' || !KEY.test(e.publish_own_figures_as) || keys.includes(e.publish_own_figures_as)) {
      throw new Error('a publish_own_figures_as is not a label, or is a key');
    }
    own[e.key] = e.publish_own_figures_as;
  }
  return { keys: [...new Set(/** @type {string[]} */ (keys))], own };
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({ options: { register: { type: 'string' }, profile: { type: 'string', default: 'kanon' } } });
  if (!values.register) {
    console.error('usage: aggregate.mjs --register <register.json> [--profile kanon]');
    process.exit(2);
  }
  /** @type {Aws} */
  const aws = (args) => {
    const r = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, stdout: r.stdout ?? '' };
  };
  const { keys, own } = fromRegister(JSON.parse(readFileSync(values.register, 'utf8')));
  const rows = await readAll(keys, cliQuery({ aws, profile: values.profile }), TABLE);
  console.log(JSON.stringify(aggregate(rows, { now: Date.now(), own }), null, 2));
}
