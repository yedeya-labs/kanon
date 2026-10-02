#!/usr/bin/env node
// Plan 0002 step S3's falsifiers, run by the Owner against the deployed store.
//
//   node infra/telemetry/verify.mjs --key <key> [--profile kanon]
//
// The stack must be deployed with EnableVerify=true (render.mjs --verify), which lets the
// Owner assume the key's writer and reader roles; redeploy without it afterwards. Every row it
// sends is `tag: test`, so it expires in 30 days and no read or aggregate counts it (§2.4).
//
// It prints PASS or FAIL per check and exits 1 on any FAIL. It never prints a credential, a
// row, or a response body: only the check, and on a FAIL the status or error code it saw.

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { keysOf, SHORT_RETENTION_MS } from './function/index.mjs';
import { sign } from './function/sigv4.mjs';

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

const json = (/** @type {string} */ s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const denied = (/** @type {Run} */ r) => r.code !== 0 && /AccessDenied/.test(r.stderr);
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
  const assume = (/** @type {string} */ kind) => {
    const arn = `arn:aws:iam::${who.Account}:role/kanon-telemetry-${key}-${kind}`;
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
  return results;
}

/** @type {Deps['aws']} */
function aws(args, creds) {
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
async function post(url, body, creds) {
  const headers = { 'content-type': 'application/json' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, ...sign({ method: 'POST', url, headers, body, region: REGION, service: 'lambda', credentials: creds }) },
    body,
  });
  return { status: res.status, json: json(await res.text()) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { key: { type: 'string' }, profile: { type: 'string', default: 'kanon' } } });
  if (!values.key) {
    console.error('usage: verify.mjs --key <key> [--profile kanon]');
    process.exit(2);
  }
  const results = await runChecks(values.key, values.profile, { aws, post, now: Date.now, runId: () => randomInt(1, 2 ** 31 - 1) });
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` (${r.why})`}`);
  process.exit(results.length && results.every((r) => r.pass) ? 0 : 1);
}
