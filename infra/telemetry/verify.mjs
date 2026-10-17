#!/usr/bin/env node
// Plan 0002 step S3's falsifiers, as plan 0008 J9 leaves them (§13), run by the Owner against the
// deployed store.
//
//   node infra/telemetry/verify.mjs --key <key> [--profile kanon]
//
// The stack must be deployed with EnableVerify=true, which creates the write probe, and with
// EnableImporter=true, which creates the importer role and its `import` alias; redeploy without
// both afterwards. The key must have an `active` registration. Every row it sends is `tag: test`,
// so it expires in 30 days and no read or aggregate counts it (plan 0002 §2.4).
//
// SINCE J9 THERE IS NO WRITER ROLE TO SEND AS, so the row checks go through the importer's alias,
// which stamps a row as the token path does, with the importer's limits (no `kanon_version`, no
// finding); the expiry is read with the Owner's own profile. What a collector's token is refused,
// and the finding checks that need one (plan 0006 F4), are `telemetry-verify.yml`'s and the unit
// tests', since only Kanon's collector can mint a token the store accepts (plan 0008 §13).
//
// It checks, in order: both IAM URLs gone (J9); a valid row stored, a row with an extra field and a
// row naming its partition refused, by field; the stored row's expiry; the table's resource policy
// denying every write to a role allowed them (kanon#101); the importer refused a finding; the
// unqualified function refusing a direct invocation; and the `backfill` alias refusing the importer
// role, by IAM.
//
// It prints PASS or FAIL per check and exits 1 on any FAIL. It never prints a credential, a key, a
// row, or a response body: only the check, and on a FAIL the status or error code it saw.

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BACKFILL, IMPORT, keysOf, SHORT_RETENTION_MS } from './function/index.mjs';
import { SCRUB_VERSION } from './function/scrub.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

export const REGION = 'eu-central-1';
export const STACK = 'kanon-telemetry';
/** The ingest function, whose aliases the Owner's roles invoke. */
export const INGEST_FUNCTION = 'kanon-telemetry-ingest';
/** Both functions: neither may have an `AWS_IAM` URL, nor a URL on the unqualified function (J9). */
export const FUNCTIONS = /** @type {const} */ ([INGEST_FUNCTION, 'kanon-telemetry-aggregate']);

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} Run
 * @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken: string }} Creds
 * @typedef {{
 *   aws: (args: string[], creds?: Creds) => Run,
 *   now: () => number,
 *   runId: () => number,
 * }} Deps
 */

/** A valid version-2 run row, tagged `test`, as the importer may send it: no `kanon_version` (decision 17). */
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
    scrub_version: SCRUB_VERSION,
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
 * One direct invocation of the ingest function, on `alias`, or on the unqualified function when
 * `alias` is null, with `creds` or else the profile in `args`. The event goes through a file,
 * never the command line, since it names a key, and both files are removed after. Returns the
 * CLI's run, and the function's answer (its status and parsed body) when it answered.
 * @param {(args: string[], creds?: Creds) => Run | Promise<Run>} aws
 * @param {{ alias: string | null, event: unknown, creds?: Creds, args?: string[] }} o
 * @returns {Promise<{ run: Run, status: number | null, json: any }>}
 */
export async function invokeIngest(aws, { alias, event, creds, args = ['--region', REGION, '--output', 'json'] }) {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-invoke-'));
  try {
    const payload = join(dir, 'event.json');
    const out = join(dir, 'answer.json');
    writeFileSync(payload, JSON.stringify(event), { mode: 0o600 });
    const run = await aws(['lambda', 'invoke', '--function-name', INGEST_FUNCTION, ...(alias ? ['--qualifier', alias] : []),
      '--payload', `fileb://${payload}`, ...args, out], creds);
    if (run.code !== 0 || json(run.stdout)?.FunctionError) return { run, status: null, json: null };
    /** @type {any} */
    let answer = null;
    try { answer = json(readFileSync(out, 'utf8')); } catch { answer = null; }
    return { run, status: typeof answer?.statusCode === 'number' ? answer.statusCode : null, json: typeof answer?.body === 'string' ? json(answer.body) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
  if (!who?.Account || !outputs.TableName) {
    check('the stack and the Owner credentials are reachable', false, 'describe-stacks or get-caller-identity failed');
    return results;
  }
  const assume = (/** @type {string} */ name) => {
    const c = json(deps.aws(['sts', 'assume-role', '--role-arn', `arn:aws:iam::${who.Account}:role/kanon-telemetry-${name}`, '--role-session-name', 'kanon-verify', ...owner]).stdout)?.Credentials;
    return c ? { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } : null;
  };
  const table = outputs.TableName;
  const now = deps.now();

  // 1. Both functions' IAM URLs are gone (plan 0008 J9): no output names one, and each function's
  // only URL is on an alias, with no IAM auth.
  const left = [];
  for (const o of ['IngestUrl', 'AggregateUrl']) if (outputs[o] !== undefined) left.push(`output ${o}`);
  for (const fn of FUNCTIONS) {
    const r = deps.aws(['lambda', 'list-function-url-configs', '--function-name', fn, ...owner]);
    if (r.code !== 0) { left.push(`${fn}: ${errorCode(r)}`); continue; }
    for (const c of json(r.stdout)?.FunctionUrlConfigs ?? []) {
      const qualified = typeof c?.FunctionArn === 'string' && c.FunctionArn.split(':').length === 8;
      if (c?.AuthType === 'AWS_IAM' || !qualified) left.push(`${fn}: a ${c?.AuthType ?? 'URL'} URL${qualified ? '' : ' on the unqualified function'}`);
    }
  }
  check('both functions\' IAM URLs are gone', left.length === 0, left.join('; '));

  const importer = assume('importer');
  /** @param {unknown[]} rows */
  const send = async (rows) => (importer ? invokeIngest(deps.aws, { alias: IMPORT, event: { key, rows }, creds: importer }) : null);
  const errorsOf = (/** @type {{ json: any } | null} */ r) => (r?.json?.results?.[0]?.errors ?? []).map((/** @type {any} */ e) => `${e.field} (${e.problem})`);
  const fieldsOf = (/** @type {{ json: any } | null} */ r) => (r?.json?.results?.[0]?.errors ?? []).map((/** @type {any} */ e) => e.field);
  const statusOf = (/** @type {{ run: Run, status: number | null } | null} */ r) => (!r ? 'no importer' : r.status !== null ? `status ${r.status}` : errorCode(r.run));
  const noImporter = 'assume-role failed for kanon-telemetry-importer: is the stack deployed with EnableImporter=true?';

  // 2. A valid row is stored, through the importer's alias.
  const row = testRow(now, deps.runId());
  const ok = await send([row]);
  check('a valid row sent through the import alias gets 200', ok?.status === 200 && ok.json?.results?.[0]?.status === 'stored', importer ? statusOf(ok) : noImporter);

  // 3. An extra field rejects the row, by name.
  const extra = await send([{ ...testRow(now, deps.runId()), surplus_field: 1 }]);
  check('a row with an extra field gets 422 naming that field', extra?.status === 422 && fieldsOf(extra).includes('surplus_field'), importer ? statusOf(extra) : noImporter);

  // 4. A row can't name its partition.
  const named = await send([{ ...testRow(now, deps.runId()), pk: 'verify-other#review' }]);
  check('a row naming a partition gets 422', named?.status === 422 && fieldsOf(named).includes('pk'), importer ? statusOf(named) : noImporter);

  // 5. The stored row expires 30 days after it was recorded, read with the Owner's own profile.
  const { pk, sk } = keysOf(key, row);
  const got = deps.aws(['dynamodb', 'get-item', '--table-name', table,
    '--key', JSON.stringify({ pk: { S: pk }, sk: { S: sk } }), '--projection-expression', 'expires_at', ...owner]);
  const expires = Number(json(got.stdout)?.Item?.expires_at?.N);
  const want = Math.floor((Date.parse(row.recorded_at) + SHORT_RETENTION_MS) / 1000);
  check("the stored row's expires_at is 30 days out", got.code === 0 && expires === want,
    got.code !== 0 ? errorCode(got) : Number.isFinite(expires) ? `off by ${expires - want} s` : 'no expires_at');

  // 6. The table's resource policy denies every write (kanon#101). The probe role (EnableVerify
  // only) is ALLOWED all four writes by its own policy, so only the table's deny can stop it, and
  // IAM's message must say so. Each write aims at a partition no register holds and carries an
  // expiry an hour out, so a write that lands (a FAIL) is gone by TTL.
  const probe = assume('verify-probe');
  const probeName = "every write by a role allowed them is denied by the table's resource policy";
  if (!probe) check(probeName, false, 'assume-role failed for kanon-telemetry-verify-probe: is the stack deployed with EnableVerify=true?');
  else probeWrites(probe);

  // 7. Only a collector stores a finding: never the importer (plan 0006 F4).
  const finding = await send([testFinding(now, deps.runId())]);
  check('the importer sending a finding gets 422', finding?.status === 422 && errorsOf(finding).includes('row_kind (not-allowed)'), importer ? statusOf(finding) : noImporter);

  // 8. The unqualified function, invoked directly with the Owner's own grant, refuses the event
  // (plan 0008 §13, from vM+1): only an alias reaches the table.
  const direct = await invokeIngest(deps.aws, { alias: null, event: { key, rows: [testRow(now, deps.runId())] }, args: owner });
  check('a direct invocation of the unqualified ingest function is refused by the function', direct.status === 403 && direct.json?.error === 'path',
    direct.status !== null ? `status ${direct.status}` : errorCode(direct.run));

  // 9. The importer role may invoke its own alias and nothing else: IAM refuses it `backfill`.
  if (!importer) check('the importer role invoking the backfill alias is denied by IAM', false, noImporter);
  else {
    const other = await invokeIngest(deps.aws, { alias: BACKFILL, event: { key, rows: [testRow(now, deps.runId())] }, creds: importer });
    check('the importer role invoking the backfill alias is denied by IAM', denied(other.run),
      other.status !== null ? `status ${other.status}` : errorCode(other.run));
  }
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

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({ options: { key: { type: 'string' }, profile: { type: 'string', default: 'kanon' } } });
  if (!values.key) {
    console.error('usage: verify.mjs --key <key> [--profile kanon]');
    process.exit(2);
  }
  const results = await runChecks(values.key, values.profile, { aws, now: Date.now, runId: () => randomInt(1, 2 ** 31 - 1) });
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` (${r.why})`}`);
  process.exit(results.length && results.every((r) => r.pass) ? 0 : 1);
}
