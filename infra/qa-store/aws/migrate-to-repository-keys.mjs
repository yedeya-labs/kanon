#!/usr/bin/env node
// Move a QA store's unkeyed rows and raw reports under one repository's keys (kanon#1346).
//
// Before kanon#1346 the store keyed nothing by repository: `RUN#explorer`, `RUN#audit`, `COVERAGE`,
// `AREAS` and `COST#<agent>` in the table, `<kind>/<ts>.json` in the bucket. Since then every reader
// and writer uses the repository's own keys (`keys.mjs`), and reads the unkeyed rows only while a
// partition holds none of its own. This copies the unkeyed history under the named repository's
// keys, so its lanes keep it once they have written their first row, and MARKS each unkeyed row
// and report it copied, so no other repository's fallback reads them as its own (kanon#1377).
//
// THE ACCOUNT OWNER RUNS IT, with their own credentials: it scans the table and reads and puts the
// reports' tags, which the store's role may not. A DRY RUN BY DEFAULT: it prints what it would
// copy and mark, and writes nothing. `--apply` writes.
//
// IT COPIES AND MARKS, AND DELETES NOTHING. A row is put only where the repository has no row at
// that key (`attribute_not_exists`), so a row a lane wrote since the pin moved, which is newer,
// wins; a report is copied only where the repository has none at that key. Then each unkeyed row
// gets `migratedTo` = the repository id (`update-item`, only on a row that exists and is unmarked),
// and each unkeyed report the S3 tag `kanon-migrated-to` = the id, added to the tags it has. The
// readers' fallback skips marked rows (`keys.mjs`, `UNMARKED`), and a report is read only through
// its row, so after this a repository added to the store later reads none of this history. The
// marked originals stay as the pre-migration record, for an operator to read directly. It can be
// run again, before and after the pin moves: a second run copies and marks only what the first
// did not. A row or report already marked for ANOTHER repository is left alone, and counted.
//
// ONE REPOSITORY PER STORE'S HISTORY. The unkeyed rows carry no repository, so they can't be split.
// On a store that served one repository before kanon#1346, name that one. On a store that served
// several, the unkeyed rows are all of theirs, mixed: name the one that should keep them, or none.
// Marking is what makes that choice stick: once marked for one, a run for another copies none of it.
//
// Usage:
//   node infra/qa-store/aws/migrate-to-repository-keys.mjs --repository <owner>/<repo> \
//     --region <region> --bucket <BucketName> [--table <TableName>] [--profile <profile>] [--apply]

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';
import { MIGRATED_TAG, MIGRATED_TO, REPORTS_ROOT, isUnkeyed, keyed, reportKey } from './keys.mjs';

/** The raw reports' unkeyed prefixes, one per kind `push-run.sh` writes. */
export const REPORT_PREFIXES = ['explorer/', 'audit/', 'telemetry/'];

/**
 * What the migration would copy and mark, from the table's items, the bucket's keys and the
 * unkeyed reports' `kanon-migrated-to` tags (`tags`, key → id, absent when untagged). Pure.
 * @param {{ items: Array<Record<string, any>>, objects: string[], repository: string, tags?: Record<string, string> }} o
 */
export function migrationPlan({ items, objects, repository, tags = {} }) {
  const held = new Set(items.map((it) => `${it.pk?.S}\u0000${it.sk?.S}`));
  /** @type {Map<string, { copy: Array<Record<string, any>>, present: number, mark: Array<{ pk: { S: string }, sk: any }>, elsewhere: number }>} */
  const partitions = new Map();
  for (const it of items) {
    const pk = it.pk?.S;
    if (typeof pk !== 'string' || !isUnkeyed(pk)) continue;
    const to = keyed(pk, repository);
    const p = partitions.get(pk) ?? { copy: [], present: 0, mark: [], elsewhere: 0 };
    partitions.set(pk, p);
    const marked = it[MIGRATED_TO]?.S;
    // Already another repository's history: neither copied nor marked again.
    if (marked && marked !== repository) { p.elsewhere += 1; continue; }
    if (held.has(`${to}\u0000${it.sk?.S}`)) p.present += 1;
    else {
      // The copy is the repository's own row: it never carries the mark.
      /** @type {Record<string, any>} */
      const copy = { ...it, pk: { S: to } };
      delete copy[MIGRATED_TO];
      p.copy.push(copy);
    }
    if (!marked) p.mark.push({ pk: { S: pk }, sk: it.sk });
  }
  const have = new Set(objects);
  const unkeyedObjects = objects.filter((k) => REPORT_PREFIXES.some((p) => k.startsWith(p)));
  const ours = unkeyedObjects.filter((k) => !tags[k] || tags[k] === repository);
  const reports = ours.filter((k) => !have.has(reportKey(k, repository)));
  return {
    partitions,
    reports,
    reportsPresent: ours.length - reports.length,
    markReports: ours.filter((k) => !tags[k]),
    reportsElsewhere: unkeyedObjects.length - ours.length,
  };
}

/** @param {{ region: string, profile?: string }} o */
const awsRunner = ({ region, profile }) => (/** @type {string[]} */ args) => execFileSync('aws', [
  ...args, '--region', region, ...(profile ? ['--profile', profile] : []), '--output', 'json',
], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** A CLI answer as JSON, where an empty answer is `{}`. @param {string} raw */
const json = (raw) => (raw.trim() ? JSON.parse(raw) : {});

/** Whether a failed CLI call was a conditional write the table refused. @param {unknown} err */
const conditionFailed = (err) => /ConditionalCheckFailed/.test(String(/** @type {{ stderr?: unknown }} */ (err)?.stderr ?? ''));

/**
 * Run the migration: read, print the plan, and with `apply` copy, then mark.
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
  // Each unkeyed report's tags: which are marked already, and the set a mark is added to.
  /** @type {Record<string, Array<{ Key: string, Value: string }>>} */
  const tagSets = {};
  /** @type {Record<string, string>} */
  const tags = {};
  for (const key of objects.filter((k) => REPORT_PREFIXES.some((p) => k.startsWith(p)))) {
    /** @type {Array<{ Key: string, Value: string }>} */
    const set = json(aws(['s3api', 'get-object-tagging', '--bucket', bucket, '--key', key])).TagSet ?? [];
    tagSets[key] = set;
    const mark = set.find((t) => t.Key === MIGRATED_TAG);
    if (mark) tags[key] = mark.Value;
  }
  const plan = migrationPlan({ items, objects, repository: id, tags });

  const verb = apply ? 'copying' : 'would copy';
  const markVerb = apply ? 'marking' : 'would mark';
  let rows = 0;
  let marks = 0;
  for (const [pk, p] of [...plan.partitions].sort(([a], [b]) => a.localeCompare(b))) {
    const elsewhere = p.elsewhere ? ` ${p.elsewhere} row(s) already marked as migrated to another repository, left alone.` : '';
    log(`${pk} → ${keyed(pk, id)}: ${verb} ${p.copy.length} row(s); ${p.present} already there. ${markVerb} ${p.mark.length} unkeyed row(s) ${MIGRATED_TO}=${id}.${elsewhere}`);
    rows += p.copy.length;
    marks += p.mark.length;
  }
  if (!plan.partitions.size) log('No unkeyed rows in the table.');
  const reportsElsewhere = plan.reportsElsewhere ? ` ${plan.reportsElsewhere} already tagged as migrated to another repository, left alone.` : '';
  log(`Raw reports → ${REPORTS_ROOT}/${id}/: ${verb} ${plan.reports.length}; ${plan.reportsPresent} already there. ${markVerb} ${plan.markReports.length} unkeyed report(s) with the tag ${MIGRATED_TAG}=${id}.${reportsElsewhere}`);
  if (!apply) {
    log(`Dry run: nothing written. Re-run with --apply to copy ${rows} row(s) and ${plan.reports.length} report(s), and mark ${marks} row(s) and ${plan.markReports.length} report(s).`);
    return { rows: 0, reports: 0, raced: 0, markedRows: 0, markedReports: 0 };
  }

  // Copy everything first, then mark: a marked row is out of every fallback, so its copy must be there.
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
        if (conditionFailed(err)) raced += 1;
        else throw err;
      }
    }
  }
  for (const key of plan.reports) {
    execFileSync('aws', ['s3', 'cp', `s3://${bucket}/${key}`, `s3://${bucket}/${reportKey(key, id)}`, '--region', region,
      ...(profile ? ['--profile', profile] : []), '--only-show-errors'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  let markedRows = 0;
  let unmarkable = 0;
  for (const p of plan.partitions.values()) {
    for (const key of p.mark) {
      try {
        // Only a row that is there and unmarked: an update-item would otherwise create one, or
        // overwrite a mark another run made since the scan.
        aws(['dynamodb', 'update-item', '--table-name', table, '--key', JSON.stringify(key),
          '--update-expression', `SET ${MIGRATED_TO} = :id`,
          '--condition-expression', `attribute_exists(pk) AND attribute_not_exists(${MIGRATED_TO})`,
          '--expression-attribute-values', JSON.stringify({ ':id': { S: id } })]);
        markedRows += 1;
      } catch (err) {
        if (conditionFailed(err)) unmarkable += 1;
        else throw err;
      }
    }
  }
  for (const key of plan.markReports) {
    // A tag set is replaced whole, so the mark is added to the tags the report has.
    const TagSet = [...(tagSets[key] ?? []), { Key: MIGRATED_TAG, Value: id }];
    aws(['s3api', 'put-object-tagging', '--bucket', bucket, '--key', key, '--tagging', JSON.stringify({ TagSet })]);
  }
  log(`Copied ${copied} row(s) and ${plan.reports.length} report(s); ${raced} row(s) a lane had written meanwhile were left as the lane wrote them. Marked ${markedRows} unkeyed row(s) and ${plan.markReports.length} unkeyed report(s) as migrated to ${id}${unmarkable ? `; ${unmarkable} row(s) had gone or been marked since the scan` : ''}. Nothing was deleted.`);
  return { rows: copied, reports: plan.reports.length, raced, markedRows, markedReports: plan.markReports.length };
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
