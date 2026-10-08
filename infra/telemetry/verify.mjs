#!/usr/bin/env node
// Plan 0002 step S3's falsifiers, and plan 0006 F4's (checks 8 to 13), run by the Owner against
// the deployed store.
//
//   node infra/telemetry/verify.mjs --key <key> [--profile kanon]
//
// The stack must be deployed with EnableVerify=true (render.mjs --verify), which lets the
// Owner assume the key's writer and reader roles and creates the write probe (check 7), and with
// EnableImporter=true (render.mjs --importer), which lets the Owner assume the importer (check
// 11); redeploy without both afterwards. Every row it sends is `tag: test`, so it expires in 30
// days and no read or aggregate counts it (§2.4).
//
// The finding checks (plan 0006 §8, F4): a valid finding is stored in `<key>#finding`; one with a
// URL in its evidence, or holding the key, is refused; the importer may not send one; the
// aggregate the Owner computes for the key is the same before and after a finding is stored; and
// `erase.mjs`'s walk of the key reaches the stored finding. That walk is a dry run: verify never
// erases a key. The erasure itself is held by the erase test.
//
// It prints PASS or FAIL per check and exits 1 on any FAIL. It never prints a credential, a
// row, or a response body: only the check, and on a FAIL the status or error code it saw.

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { aggregate, readAll } from './function/aggregate.mjs';
import { keysOf, SHORT_RETENTION_MS } from './function/index.mjs';
import { sign } from './function/sigv4.mjs';
import { cliQuery } from './aggregate.mjs';
import { erase } from './erase.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

export const REGION = 'eu-central-1';
export const STACK = 'kanon-telemetry';
/** A key no register holds: the reader must be denied it by IAM, not find it empty. */
export const OTHER_KEY = 'verify-other';

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} Run
 * @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken: string }} Creds
 * @typedef {{
 *   aws: (args: string[], creds?: Creds) => Run,
 *   post: (url: string, body: string, creds: Creds) => Promise<{ status: number, json: any }>,
 *   now: () => number,
 *   runId: () => number,
 * }} Deps
 */

/** A valid version-2 run row, tagged `test`. */
export function testRow(/** @type {number} */ now, /** @type {number} */ runId) {
  return {
    schema_version: 2,
    row_kind: 'run',
    tag: 'test',
    recorded_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    run_id: runId,
    run_attempt: 1,
    role: 'reviewer',
    lane: 'review',
    outcome: 'ok',
    reason: 'none',
    kanon_version: 'dev',
  };
}

/**
 * A valid finding row (plan 0006 §2.1), tagged `test`, at `evidence` with text in Kanon's terms that
 * names no repository, login or URL.
 * @param {number} now
 * @param {number} runId
 * @param {Record<string, unknown>} [over]
 */
export function testFinding(now, runId, over = {}) {
  return {
    schema_version: 1,
    row_kind: 'finding',
    tag: 'test',
    recorded_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    run_id: runId,
    run_attempt: 1,
    finding_index: 0,
    reporter: 'overseer',
    subject: 'lane',
    lane: 'review',
    failed_stage: 'agent',
    reason: 'did_not_finish',
    kanon_version: 'dev',
    rules: 'K-OBS-16',
    fix_category: 'other',
    evidence_level: 'evidence',
    evidence: 'Expected: the verify check stores this finding.\nObserved: nothing, it is a test.',
    suggested_fix: 'None: a test row, which expires in 30 days.',
    scrub_version: 1,
    ...over,
  };
}

const json = (/** @type {string} */ s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const denied = (/** @type {Run} */ r) => r.code !== 0 && /AccessDenied/.test(r.stderr);
/** Denied by a resource policy's explicit deny, as IAM's access-denied message says. */
const deniedByTable = (/** @type {Run} */ r) => denied(r) && /explicit deny in a resource-based policy/.test(r.stderr);

/** The four writes the table's resource policy denies to all but the function and the Owner (§4). */
export const DENIED_WRITES = ['PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem'];
/** The partition the probe aims at: no register holds it, so a write that lands is nobody's row. */
export const PROBE_PK = 'verify-probe#none';
const errorCode = (/** @type {Run} */ r) => r.code === 0 ? 'no error' : (/\(([A-Za-z]+)\)/.exec(r.stderr)?.[1] ?? `exit ${r.code}`);

/**
 * Run every check. Returns one result per check, in order.
 * @param {string} key
 * @param {string} profile
 * @param {Deps} deps
 * @returns {Promise<{ name: string, pass: boolean, why?: string }[]>}
 */
export async function runChecks(key, profile, deps) {
  /** @type {{ name: string, pass: boolean, why?: string }[]} */
  const results = [];
  const check = (/** @type {string} */ name, /** @type {boolean} */ pass, /** @type {string} */ why) =>
    results.push(pass ? { name, pass } : { name, pass, why });

  const owner = ['--profile', profile, '--region', REGION, '--output', 'json'];
  const who = json(deps.aws(['sts', 'get-caller-identity', ...owner]).stdout);
  const stack = json(deps.aws(['cloudformation', 'describe-stacks', '--stack-name', STACK, ...owner]).stdout);
  /** @type {Record<string, string>} */
  const outputs = Object.fromEntries((stack?.Stacks?.[0]?.Outputs ?? []).map((/** @type {any} */ o) => [o.OutputKey, o.OutputValue]));
  if (!who?.Account || !outputs.IngestUrl || !outputs.TableName) {
    check('the stack and the Owner credentials are reachable', false, 'describe-stacks or get-caller-identity failed');
    return results;
  }
  const assume = (/** @type {string} */ kind, arn = `arn:aws:iam::${who.Account}:role/kanon-telemetry-${key}-${kind}`) => {
    const c = json(deps.aws(['sts', 'assume-role', '--role-arn', arn, '--role-session-name', 'kanon-verify', ...owner]).stdout)?.Credentials;
    return c ? { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } : null;
  };
  const writer = assume('writer');
  const reader = assume('reader');
  if (!writer || !reader) {
    check('the Owner can assume the writer and reader roles', false, 'assume-role failed: is the stack deployed with --verify?');
    return results;
  }
  const url = outputs.IngestUrl;
  const table = outputs.TableName;
  const now = deps.now();
  const row = testRow(now, deps.runId());

  // 1. A valid row is stored.
  const ok = await deps.post(url, JSON.stringify([row]), writer);
  check('a valid row gets 200', ok.status === 200 && ok.json?.results?.[0]?.status === 'stored', `status ${ok.status}`);

  // 2. An extra field rejects the row, by name.
  const extra = await deps.post(url, JSON.stringify([{ ...testRow(now, deps.runId()), surplus_field: 1 }]), writer);
  const extraFields = (extra.json?.results?.[0]?.errors ?? []).map((/** @type {any} */ e) => e.field);
  check('a row with an extra field gets 422 naming that field', extra.status === 422 && extraFields.includes('surplus_field'), `status ${extra.status}`);

  // 3. A row can't name its partition.
  const named = await deps.post(url, JSON.stringify([{ ...testRow(now, deps.runId()), pk: `${OTHER_KEY}#review` }]), writer);
  const namedFields = (named.json?.results?.[0]?.errors ?? []).map((/** @type {any} */ e) => e.field);
  check('a row naming a partition gets 422', named.status === 422 && namedFields.includes('pk'), `status ${named.status}`);

  // 4. The reader is denied another key by IAM.
  const other = deps.aws(['dynamodb', 'query', '--region', REGION, '--table-name', table,
    '--key-condition-expression', 'pk = :p', '--expression-attribute-values', JSON.stringify({ ':p': { S: `${OTHER_KEY}#review` } })], reader);
  check('the reader querying another key gets AccessDeniedException', denied(other), errorCode(other));

  // 5. The writer can't write the table itself.
  const direct = deps.aws(['dynamodb', 'put-item', '--region', REGION, '--table-name', table,
    '--item', JSON.stringify({ pk: { S: `${key}#review` }, sk: { S: 'verify-direct' } })], writer);
  check('a direct PutItem with the writer role is denied', denied(direct), errorCode(direct));

  // 6. The stored row expires 30 days after it was recorded.
  const { pk, sk } = keysOf(key, row);
  const got = deps.aws(['dynamodb', 'get-item', '--region', REGION, '--table-name', table, '--output', 'json',
    '--key', JSON.stringify({ pk: { S: pk }, sk: { S: sk } }), '--projection-expression', 'expires_at'], reader);
  const expires = Number(json(got.stdout)?.Item?.expires_at?.N);
  const want = Math.floor((Date.parse(row.recorded_at) + SHORT_RETENTION_MS) / 1000);
  check("the stored row's expires_at is 30 days out", got.code === 0 && expires === want,
    got.code !== 0 ? errorCode(got) : Number.isFinite(expires) ? `off by ${expires - want} s` : 'no expires_at');

  // 7. The table's resource policy denies every write (kanon#101). Check 5 can't show it: the
  // writer holds no DynamoDB action, so IAM denies its PutItem before the table's policy is
  // read, and a table with no resource policy passes check 5. The probe role (EnableVerify only)
  // is ALLOWED all four writes by its own policy, so only the table's deny can stop it, and IAM's
  // message must say so. Each write aims at a partition no register holds and carries an
  // expiry an hour out, so a write that lands (a FAIL) is gone by TTL.
  const probe = assume('verify-probe', `arn:aws:iam::${who.Account}:role/kanon-telemetry-verify-probe`);
  const probeName = "every write by a role allowed them is denied by the table's resource policy";
  if (!probe) check(probeName, false, 'assume-role failed for kanon-telemetry-verify-probe: is the stack deployed with --verify?');
  else probeWrites(probe);

  // 8. to 13. Plan 0006 F4: the finding row at intake.
  const errorsOf = (/** @type {{ json: any }} */ r) => (r.json?.results?.[0]?.errors ?? []).map((/** @type {any} */ e) => `${e.field} (${e.problem})`);
  // The Owner's aggregate for the key, as `aggregate.mjs` computes it, or null when it can't be.
  const figures = () => readAll([key], cliQuery({ aws: deps.aws, profile }), table)
    .then((rows) => JSON.stringify(aggregate(rows, { now })), () => null);
  const before = await figures();

  // 8. A valid finding is stored, in the key's finding partition.
  const finding = testFinding(now, deps.runId());
  const stored = await deps.post(url, JSON.stringify([finding]), writer);
  const at = keysOf(key, finding);
  const landed = deps.aws(['dynamodb', 'get-item', '--region', REGION, '--table-name', table, '--output', 'json',
    '--key', JSON.stringify({ pk: { S: at.pk }, sk: { S: at.sk } }), '--projection-expression', 'row_kind'], reader);
  check(`a valid finding gets 200 and lands in <key>#finding`,
    stored.status === 200 && stored.json?.results?.[0]?.status === 'stored' && json(landed.stdout)?.Item?.row_kind?.S === 'finding',
    stored.status !== 200 ? `status ${stored.status}` : landed.code !== 0 ? errorCode(landed) : 'not found in the finding partition');

  // 9. A URL in the evidence is refused, by field and rule.
  const withUrl = await deps.post(url, JSON.stringify([testFinding(now, deps.runId(), { evidence: 'Observed: the lane read https://example.com/run before it stopped.' })]), writer);
  check('a finding with a URL in its evidence gets 422 naming evidence (url)', withUrl.status === 422 && errorsOf(withUrl).includes('evidence (url)'), `status ${withUrl.status}`);

  // 10. A registered key is refused wherever it is.
  const withKey = await deps.post(url, JSON.stringify([testFinding(now, deps.runId(), { evidence: `Observed: the row named ${key} as its partition.` })]), writer);
  check('a finding holding a registered key gets 422', withKey.status === 422 && errorsOf(withKey).includes('evidence (key)'), `status ${withKey.status}`);

  // 11. Only a writer stores a finding: never the importer.
  const importer = assume('importer', `arn:aws:iam::${who.Account}:role/kanon-telemetry-importer`);
  if (!importer) check('the importer sending a finding gets 422', false, 'assume-role failed for kanon-telemetry-importer: is the stack deployed with --importer?');
  else {
    const imported = await deps.post(`${url}?key=${encodeURIComponent(key)}`, JSON.stringify([testFinding(now, deps.runId())]), importer);
    check('the importer sending a finding gets 422', imported.status === 422 && errorsOf(imported).includes('row_kind (not-allowed)'), `status ${imported.status}`);
  }

  // 12. The aggregate never reads a finding.
  const after = await figures();
  check("the aggregate's answer is unchanged by a stored finding", before !== null && before === after,
    before === null || after === null ? 'the aggregate could not be computed' : 'it changed');

  // 13. Erasure walks the finding partition: a dry run of erase.mjs counts the stored finding.
  const walked = () => {
    try {
      return erase(key, { aws: (args) => deps.aws(args), profile, apply: false }).find((c) => c.partition === `${key}#finding`)?.rows ?? 0;
    } catch {
      return -1;
    }
  };
  const found = walked();
  check("erase.mjs's walk of the key reaches the stored finding in <key>#finding", found >= 1, found < 0 ? 'a query failed' : 'the finding partition is not walked, or is empty');
  return results;

  /** @param {Creds} probeCreds */
  function probeWrites(probeCreds) {
    const item = { pk: { S: PROBE_PK }, sk: { S: `verify-${deps.runId()}` }, expires_at: { N: String(Math.floor(now / 1000) + 3600) } };
    const itemKey = JSON.stringify({ pk: item.pk, sk: item.sk });
    /** @type {Record<string, string[]>} */
    const calls = {
      PutItem: ['put-item', '--table-name', table, '--item', JSON.stringify(item)],
      UpdateItem: ['update-item', '--table-name', table, '--key', itemKey,
        '--update-expression', 'SET expires_at = :e', '--expression-attribute-values', JSON.stringify({ ':e': item.expires_at })],
      DeleteItem: ['delete-item', '--table-name', table, '--key', itemKey],
      BatchWriteItem: ['batch-write-item', '--request-items', JSON.stringify({ [table]: [{ PutRequest: { Item: item } }] })],
    };
    const notDenied = DENIED_WRITES.flatMap((op) => {
      const r = deps.aws(['dynamodb', ...(calls[op] ?? []), '--region', REGION], probeCreds);
      return deniedByTable(r) ? [] : [`${op}: ${denied(r) ? 'denied, but not by a resource-based policy' : errorCode(r)}`];
    });
    check(probeName, notDenied.length === 0, notDenied.join('; '));
  }
}

/** @type {Deps['aws']} */
export function aws(args, creds) {
  const env = { ...process.env };
  if (creds) {
    delete env.AWS_PROFILE;
    delete env.AWS_DEFAULT_PROFILE;
    Object.assign(env, { AWS_ACCESS_KEY_ID: creds.accessKeyId, AWS_SECRET_ACCESS_KEY: creds.secretAccessKey, AWS_SESSION_TOKEN: creds.sessionToken });
  }
  const r = spawnSync('aws', args, { env, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** @type {Deps['post']} */
export async function post(url, body, creds) {
  const headers = { 'content-type': 'application/json' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, ...sign({ method: 'POST', url, headers, body, region: REGION, service: 'lambda', credentials: creds }) },
    body,
  });
  return { status: res.status, json: json(await res.text()) };
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({ options: { key: { type: 'string' }, profile: { type: 'string', default: 'kanon' } } });
  if (!values.key) {
    console.error('usage: verify.mjs --key <key> [--profile kanon]');
    process.exit(2);
  }
  const results = await runChecks(values.key, values.profile, { aws, post, now: Date.now, runId: () => randomInt(1, 2 ** 31 - 1) });
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` (${r.why})`}`);
  process.exit(results.length && results.every((r) => r.pass) ? 0 : 1);
}
