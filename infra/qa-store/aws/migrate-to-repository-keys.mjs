#!/usr/bin/env node
// Move a QA store's unkeyed rows and raw reports under one repository's keys (kanon#1346).
//
// Before kanon#1346 the store keyed nothing by repository: `RUN#explorer`, `RUN#audit`, `COVERAGE`,
// `AREAS` and `COST#<agent>` in the table, `<kind>/<ts>.json` in the bucket. Since then every reader
// and writer uses the repository's own keys (`keys.mjs`), and reads the unkeyed rows only while a
// partition holds none of its own. This copies the unkeyed history under the named repository's
// keys, so its lanes keep it once they have written their first row.
//
// THE ACCOUNT OWNER RUNS IT, with their own credentials: it scans the table, which the store's role
// may not. A DRY RUN BY DEFAULT: it prints what it would copy and writes nothing. `--apply` writes.
//
// IT ONLY COPIES. Nothing is deleted or overwritten: a row is put only where the repository has no
// row at that key (`attribute_not_exists`), so a row a lane wrote since the pin moved, which is
// newer, wins; a report is copied only where the repository has none at that key. So it can be run
// again, before and after the pin moves, and a second run copies only what the first did not. The
// unkeyed rows stay where they are; delete them by hand once the repository's lanes read their own,
// if you want them gone.
//
// ONE REPOSITORY PER STORE'S HISTORY. The unkeyed rows carry no repository, so they can't be split.
// On a store that served one repository before kanon#1346, name that one. On a store that served
// several, the unkeyed rows are all of theirs, mixed: name the one that should keep them, or none.
//
// Usage:
//   node infra/qa-store/aws/migrate-to-repository-keys.mjs --repository <owner>/<repo> \
//     --region <region> --bucket <BucketName> [--table <TableName>] [--profile <profile>] [--apply]

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';
import { REPORTS_ROOT, isUnkeyed, keyed, reportKey } from './keys.mjs';

/** The raw reports' unkeyed prefixes, one per kind `push-run.sh` writes. */
export const REPORT_PREFIXES = ['explorer/', 'audit/', 'telemetry/'];

/**
 * What the migration would copy, from the table's items and the bucket's keys. Pure.
 * @param {{ items: Array<Record<string, any>>, objects: string[], repository: string }} o
 */
export function migrationPlan({ items, objects, repository }) {
  const held = new Set(items.map((it) => `${it.pk?.S}\u0000${it.sk?.S}`));
  /** @type {Map<string, { copy: Array<Record<string, any>>, present: number }>} */
  const partitions = new Map();
  for (const it of items) {
    const pk = it.pk?.S;
    if (typeof pk !== 'string' || !isUnkeyed(pk)) continue;
    const to = keyed(pk, repository);
    const p = partitions.get(pk) ?? { copy: [], present: 0 };
    if (held.has(`${to}\u0000${it.sk?.S}`)) p.present += 1;
    else p.copy.push({ ...it, pk: { S: to } });
    partitions.set(pk, p);
  }
  const have = new Set(objects);
  const unkeyedObjects = objects.filter((k) => REPORT_PREFIXES.some((p) => k.startsWith(p)));
  const reports = unkeyedObjects.filter((k) => !have.has(reportKey(k, repository)));
  return { partitions, reports, reportsPresent: unkeyedObjects.length - reports.length };
}

/** @param {{ region: string, profile?: string }} o */
const awsRunner = ({ region, profile }) => (/** @type {string[]} */ args) => execFileSync('aws', [
  ...args, '--region', region, ...(profile ? ['--profile', profile] : []), '--output', 'json',
], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** A CLI answer as JSON, where an empty answer is `{}`. @param {string} raw */
const json = (raw) => (raw.trim() ? JSON.parse(raw) : {});

/**
 * Run the migration: read, print the plan, and with `apply` copy.
 * @param {{ repository: string, region: string, bucket: string, table: string, profile?: string, apply: boolean, log?: (line: string) => void }} o
 */
export function migrate({ repository, region, bucket, table, profile, apply, log = console.log }) {
  const gh = json(execFileSync('gh', ['api', `repos/${repository}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const id = String(gh.id ?? '');
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error(`GitHub gave no repository id for ${repository}`);
  log(`${gh.full_name ?? repository} is repository id ${id}: its keys end in #${id}, and its reports are under ${REPORTS_ROOT}/${id}/.`);
  const aws = awsRunner({ region, profile });

  const items = json(aws(['dynamodb', 'scan', '--table-name', table])).Items ?? [];
  /** @type {string[]} */
  const objects = [];
  for (const prefix of [...REPORT_PREFIXES, `${REPORTS_ROOT}/${id}/`]) {
    const listed = json(aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix]));
    for (const o of listed.Contents ?? []) objects.push(o.Key);
  }
  const plan = migrationPlan({ items, objects, repository: id });

  const verb = apply ? 'copying' : 'would copy';
  let rows = 0;
  for (const [pk, p] of [...plan.partitions].sort(([a], [b]) => a.localeCompare(b))) {
    log(`${pk} → ${keyed(pk, id)}: ${verb} ${p.copy.length} row(s); ${p.present} already there.`);
    rows += p.copy.length;
  }
  if (!plan.partitions.size) log('No unkeyed rows in the table.');
  log(`Raw reports → ${REPORTS_ROOT}/${id}/: ${verb} ${plan.reports.length}; ${plan.reportsPresent} already there.`);
  if (!apply) {
    log(`Dry run: nothing written. Re-run with --apply to copy ${rows} row(s) and ${plan.reports.length} report(s).`);
    return { rows: 0, reports: 0, raced: 0 };
  }

  let copied = 0;
  let raced = 0;
  for (const p of plan.partitions.values()) {
    for (const item of p.copy) {
      try {
        aws(['dynamodb', 'put-item', '--table-name', table, '--item', JSON.stringify(item),
          '--condition-expression', 'attribute_not_exists(pk)']);
        copied += 1;
      } catch (err) {
        // A lane wrote this key since the scan: its row is newer, and stays.
        if (/ConditionalCheckFailed/.test(String(/** @type {{ stderr?: unknown }} */ (err)?.stderr ?? ''))) raced += 1;
        else throw err;
      }
    }
  }
  for (const key of plan.reports) {
    execFileSync('aws', ['s3', 'cp', `s3://${bucket}/${key}`, `s3://${bucket}/${reportKey(key, id)}`, '--region', region,
      ...(profile ? ['--profile', profile] : []), '--only-show-errors'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  log(`Copied ${copied} row(s) and ${plan.reports.length} report(s); ${raced} row(s) a lane had written meanwhile were left as the lane wrote them. Nothing was deleted.`);
  return { rows: copied, reports: plan.reports.length, raced };
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' }, region: { type: 'string' }, bucket: { type: 'string' },
      table: { type: 'string', default: 'kanon-qa-store' }, profile: { type: 'string' }, apply: { type: 'boolean', default: false },
    },
  });
  const missing = ['repository', 'region', 'bucket'].filter((k) => !values[/** @type {'repository'|'region'|'bucket'} */ (k)]);
  if (missing.length || !/^[\w.-]+\/[\w.-]+$/.test(values.repository ?? '')) {
    console.error('usage: migrate-to-repository-keys.mjs --repository <owner>/<repo> --region <region> --bucket <BucketName> [--table <TableName>] [--profile <profile>] [--apply]');
    process.exit(2);
  }
  try {
    migrate({
      repository: /** @type {string} */ (values.repository), region: /** @type {string} */ (values.region),
      bucket: /** @type {string} */ (values.bucket), table: /** @type {string} */ (values.table),
      profile: values.profile, apply: values.apply === true,
    });
  } catch (err) {
    const e = /** @type {{ stderr?: unknown, message?: unknown }} */ (err);
    console.error(`migrate-to-repository-keys: ${String(e?.stderr || e?.message || err).trim().split('\n')[0]}`);
    process.exit(1);
  }
}
