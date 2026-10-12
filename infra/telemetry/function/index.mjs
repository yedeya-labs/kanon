// The ingest function (plan 0002 §4): the only code that may write the telemetry table. It is
// reached three ways during plan 0008's overlap (§9), and tells them apart by the qualifier of the
// ARN Lambda says it was invoked through, NEVER by anything in the request:
//   - the UNQUALIFIED function, behind its `AWS_IAM` URL: the SigV4 path below, for any caller
//     still pinned below the token release, and the Owner's importer and backfill roles;
//   - the `live` alias, behind its public URL: the token path, the five endpoints of `token.mjs`
//     (plan 0008 §3), each behind GitHub's OIDC token;
//   - the `erase` alias, invoked by the function itself: the erasure walk (§7, `token.mjs`).
// An IAM-shaped request on the alias, a bearer token on the unqualified URL, and any other
// qualifier are refused.
//
// THE SIGV4 PATH. Every request is SigV4-signed by a role, and Lambda puts that role in
// `requestContext.authorizer.iam`. The function maps the role to the adopter's key, and since
// plan 0008 J3 that key must have an `active` registration in the register table (§9): a
// suspended key is refused here as on the token path, and `WRITER_KEYS` and `NAME_HASHES` are no
// longer read. The sender's name hashes, for a finding, are its registration's `name_hashes`.
// The rows are checked and stamped by `rows.mjs`, as on the token path.
//
// LOGS HOLD KEYS AND FIELD NAMES ONLY (§9, §10). A rejected row may carry content, so nothing
// here logs or echoes a value.
//
// `node:` built-ins only: DynamoDB is called over HTTPS with the signer beside this file.

import { dynamoOf, invokeOf, stsOf } from './aws.mjs';
import { registrationOfKey } from './register-store.mjs';
import { hashSet, rowsOf, storeRows, toAttributes } from './rows.mjs';
import { containerCaches, ERASE, eraseHandle, LIVE, mintKey, tokenHandle } from './token.mjs';

export {
  addMonths, expiresOf, findingProblems, keysOf, MAX_BODY_BYTES, MAX_ROWS, PARTITIONS, RECORDED_AHEAD_MS, RECORDED_BACK_MS,
  RETENTION_MONTHS, SHORT_RETENTION_MS, stamp, TEXT_FIELDS, toAttributes,
} from './rows.mjs';

/** The writer role's name, from which the key is read (§3). */
const WRITER_ROLE = /^kanon-telemetry-([a-z0-9][a-z0-9-]{0,31})-writer$/;
const ASSUMED_ROLE = /^arn:aws[a-z-]*:sts::(\d+):assumed-role\/([^/]+)\/[^/]+$/;

/**
 * @typedef {import('./rows.mjs').Caller} Caller
 * @typedef {import('./token.mjs').TokenEnv & { IMPORTER_ROLE?: string, BACKFILL_ROLE?: string, NAME_HASHES?: string }} Env
 */

/**
 * Who is calling, from the role Lambda authenticated, or null for anyone else. A writer's key
 * comes from its role name, and the register decides whether it may write (`handle`); the importer
 * and the backfill role name no key of their own (§7).
 * @param {unknown} event
 * @param {Env} env
 * @returns {Caller | null}
 */
export function callerOf(event, env) {
  const arn = /** @type {any} */ (event)?.requestContext?.authorizer?.iam?.userArn;
  const m = typeof arn === 'string' ? ASSUMED_ROLE.exec(arn) : null;
  if (!m || m[1] !== env.ACCOUNT_ID) return null;
  const role = /** @type {string} */ (m[2]);
  if (env.IMPORTER_ROLE && role === env.IMPORTER_ROLE) return { kind: 'importer', key: null };
  if (env.BACKFILL_ROLE && role === env.BACKFILL_ROLE) return { kind: 'backfill', key: null };
  const w = WRITER_ROLE.exec(role);
  return w ? { kind: 'writer', key: /** @type {string} */ (w[1]) } : null;
}

/** A SHA-256, as `render.mjs` writes each word's. */
const HASH = /^[0-9a-f]{64}$/;

/**
 * `render.mjs`'s `NAME_HASHES`, `<key>=<hash>:<hash>…` per key, read back. THE HANDLER NO LONGER
 * READS IT (plan 0008 J3: the hashes come from the token, or on the SigV4 path from the
 * registration); it stays, with the variable, until J9 removes `render.mjs`.
 * @param {{ NAME_HASHES?: string }} env
 * @param {string} key
 * @returns {Set<string> | null}
 */
export function nameHashesOf(env, key) {
  for (const entry of (env.NAME_HASHES ?? '').split(',')) {
    const at = entry.indexOf('=');
    if (at < 0 || entry.slice(0, at) !== key) continue;
    const hashes = entry.slice(at + 1).split(':');
    return hashes.length && hashes.every((h) => HASH.test(h)) ? new Set(hashes) : null;
  }
  return null;
}

/**
 * `PutItem` over HTTPS with the function's own credentials. A re-sent row has the same key and
 * overwrites (§4).
 * @param {Record<string, any>} item
 * @param {Env} env
 * @param {typeof fetch} fetchImpl
 */
export async function putItem(item, env, fetchImpl = fetch) {
  await dynamoOf(env, fetchImpl)('PutItem', { TableName: env.TABLE_NAME, Item: toAttributes(item) });
}

const reply = (/** @type {number} */ statusCode, /** @type {unknown} */ body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * The qualifier of the ARN Lambda invoked: undefined for the unqualified function, the alias's
 * name for an alias, and `''` for anything that isn't a function's ARN.
 * @param {unknown} arn
 * @returns {string | undefined}
 */
export function qualifierOf(arn) {
  if (typeof arn !== 'string') return undefined;
  const parts = arn.split(':');
  if (parts[0] !== 'arn' || parts[2] !== 'lambda' || parts[5] !== 'function') return '';
  if (parts.length === 7) return undefined;
  return parts.length === 8 ? parts[7] : '';
}

/**
 * @typedef {{
 *   env?: Env, now?: () => number, log?: (line: string) => void, invokedFunctionArn?: string,
 *   db?: import('./aws.mjs').Dynamo, put?: (item: Record<string, any>, env: Env) => Promise<void>,
 *   sts?: import('./token.mjs').TokenDeps['sts'], invoke?: import('./token.mjs').TokenDeps['invoke'],
 *   jwks?: import('./oidc.mjs').KeyCache, keys?: import('./token.mjs').TokenDeps['keys'], mintKey?: () => string,
 *   remainingMs?: () => number,
 * }} Deps
 */

/**
 * @param {any} event a function URL event, or the erasure walk's own event on the `erase` alias
 * @param {Deps} [deps]
 */
export async function handle(event, deps = {}) {
  const env = deps.env ?? /** @type {Env} */ (/** @type {unknown} */ (process.env));
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((/** @type {string} */ line) => console.log(line));
  const db = deps.db ?? dynamoOf(env);
  const caches = containerCaches();
  const keys = deps.keys ?? caches.keys;
  const qualifier = qualifierOf(deps.invokedFunctionArn);
  /** @returns {import('./token.mjs').TokenDeps} */
  const tokenDeps = () => ({
    env, now, log, db, keys,
    sts: deps.sts ?? stsOf(env),
    invoke: deps.invoke ?? invokeOf(env),
    jwks: deps.jwks ?? caches.jwks,
    mintKey: deps.mintKey ?? mintKey,
    remainingMs: deps.remainingMs ?? (() => 10_000),
  });

  if (qualifier === LIVE) {
    // The alias's URL takes the token alone: a request IAM authenticated is not for it.
    if (event?.requestContext?.authorizer?.iam !== undefined || event?.requestContext?.http === undefined) {
      log(JSON.stringify({ rejected: 'path' }));
      return reply(403, { error: 'path' });
    }
    return tokenHandle(event, tokenDeps());
  }
  if (qualifier === ERASE) return eraseHandle(event, tokenDeps());
  if (qualifier !== undefined) {
    log(JSON.stringify({ rejected: 'path' }));
    return reply(403, { error: 'path' });
  }
  // The unqualified function's IAM URL: SigV4 only, never a bearer token.
  const authorization = event?.headers?.authorization ?? event?.headers?.Authorization;
  if (typeof authorization === 'string' && /^Bearer\s/i.test(authorization)) {
    log(JSON.stringify({ rejected: 'path' }));
    return reply(403, { error: 'path' });
  }
  const put = deps.put ?? (async (/** @type {Record<string, any>} */ item, /** @type {Env} */ e) => {
    await db('PutItem', { TableName: e.TABLE_NAME, Item: toAttributes(item) });
  });

  if (event?.requestContext?.http?.method !== 'POST') return reply(405, { error: 'method' });
  const caller = callerOf(event, env);
  if (!caller) {
    log(JSON.stringify({ rejected: 'caller' }));
    return reply(403, { error: 'caller' });
  }
  // Only the importer and the backfill role name the adopter's key.
  const named = event.queryStringParameters?.key;
  if (caller.kind === 'writer' && named !== undefined) return reply(400, { error: 'key-not-allowed' });
  if (caller.kind !== 'writer' && typeof named !== 'string') return reply(400, { error: 'key' });
  const key = /** @type {string} */ (caller.key ?? named);
  // §9: the key must have a registration in the table, and an active one.
  const reg = await registrationOfKey(db, env, key);
  if (!reg) {
    log(JSON.stringify({ rejected: 'caller', kind: caller.kind }));
    return caller.kind === 'writer' ? reply(403, { error: 'caller' }) : reply(400, { error: 'key' });
  }
  if (reg.status === 'suspended') {
    log(JSON.stringify({ caller: caller.kind, key, rejected: 'suspended' }));
    return reply(403, { error: 'suspended' });
  }
  if (reg.status !== 'active') {
    log(JSON.stringify({ caller: caller.kind, key, rejected: 'erased' }));
    return reply(410, { error: 'erased' });
  }

  const parsed = rowsOf(event);
  if (!parsed.ok) return reply(parsed.status, { error: parsed.error });
  const finding = parsed.rows.some((r) => /** @type {any} */ (r)?.row_kind === 'finding')
    ? { nameHashes: hashSet(reg.name_hashes), keys: new Set([...(await keys.keys(db, env, now)), key]) }
    : undefined;
  // The Owner's paths are not counted against the key's quotas (plan 0008 §6), and the overlap's
  // SigV4 writers are counted as they were before it: not at all.
  const r = await storeRows(parsed.rows, { caller, key, now, finding, put: (item) => put(item, env) });
  log(JSON.stringify({ caller: caller.kind, key, rows: r.logged }));
  return reply(r.status, { results: r.results });
}

/** The Lambda entry point: the qualifier comes from the ARN Lambda invoked, never the event. */
export const handler = (/** @type {any} */ event, /** @type {any} */ context) => handle(event, {
  invokedFunctionArn: context?.invokedFunctionArn,
  remainingMs: () => (typeof context?.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : 10_000),
});
