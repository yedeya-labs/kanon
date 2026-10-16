// The ingest function (plan 0002 §4): the only code that may write the telemetry table. It is
// reached four ways, and tells them apart by the qualifier of the ARN Lambda says it was invoked
// through, NEVER by anything in the request (plan 0008 §9):
//   - the `live` alias, behind its public URL: the token path, the five endpoints of `token.mjs`
//     (plan 0008 §3), each behind GitHub's OIDC token;
//   - the `erase` alias, invoked by the function itself: the erasure walk (§7, `token.mjs`);
//   - the `import` and `backfill` aliases, invoked directly by the Owner's importer and backfill
//     roles (plan 0002 §7, S5 and S7a), each role allowed `lambda:InvokeFunction` on its own alias
//     and nothing else. A direct invocation carries no caller identity, so IAM's grant per alias is
//     the whole gate, and the alias says which kind of caller it is;
//   - the UNQUALIFIED function, which has had no URL since plan 0008 J9 removed the SigV4 path,
//     and refuses every event.
// An IAM-shaped request on the alias's URL, a URL-shaped event on the Owner's aliases, and any
// other qualifier are refused.
//
// THE OWNER'S TWO ALIASES. The event is `{ key, rows }`: the adopter's key, which these two
// callers alone may name, and 1 to 25 rows. The key must have an `active` registration in the
// register table, so a suspension holds here as on the token path. The rows are checked and
// stamped by `rows.mjs` with the caller's own limits: the importer backdates up to thirteen
// months and never stores a finding; the backfill role stores work-item rows only, in the normal
// window. Neither counts against the key's quotas (plan 0008 §6).
//
// LOGS HOLD KEYS AND FIELD NAMES ONLY (§9, §10). A rejected row may carry content, so nothing
// here logs or echoes a value.
//
// `node:` built-ins only: DynamoDB is called over HTTPS with the signer beside this file.

import { Buffer } from 'node:buffer';

import { dynamoOf, invokeOf, stsOf } from './aws.mjs';
import { registrationOfKey } from './register-store.mjs';
import { MAX_BODY_BYTES, MAX_ROWS, storeRows, toAttributes } from './rows.mjs';
import { containerCaches, ERASE, eraseHandle, LIVE, mintKey, tokenHandle } from './token.mjs';

export {
  addMonths, expiresOf, findingProblems, keysOf, MAX_BODY_BYTES, MAX_ROWS, PARTITIONS, RECORDED_AHEAD_MS, RECORDED_BACK_MS,
  RETENTION_MONTHS, SHORT_RETENTION_MS, stamp, TEXT_FIELDS, toAttributes,
} from './rows.mjs';

/** The importer's alias (plan 0002 §7, S5), invoked directly with the importer role. */
export const IMPORT = 'import';
/** The backfill role's alias (S7a, plan 0003 M5), invoked directly with the backfill role. */
export const BACKFILL = 'backfill';
/** Which kind of caller each of the Owner's aliases serves (`rows.mjs`'s `Caller`). */
export const OWNER_ALIASES = Object.freeze({ [IMPORT]: 'importer', [BACKFILL]: 'backfill' });
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * @typedef {import('./rows.mjs').Caller} Caller
 * @typedef {import('./token.mjs').TokenEnv} Env
 */

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
 * The Owner's event, `{ key, rows }`: a key of the key's form, and a list of 1 to 25 rows of at
 * most 256 KB as JSON, the token path's limits. Anything else, a function URL's event among them,
 * is refused.
 * @param {any} event
 * @returns {{ ok: true, key: string, rows: unknown[] } | { ok: false, status: number, error: string }}
 */
export function ownerEventOf(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.requestContext !== undefined) return { ok: false, status: 400, error: 'event' };
  if (typeof event.key !== 'string' || !KEY.test(event.key)) return { ok: false, status: 400, error: 'key' };
  const rows = event.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return { ok: false, status: 400, error: 'body-rows' };
  if (Buffer.byteLength(JSON.stringify(rows)) > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'body-size' };
  return { ok: true, key: event.key, rows };
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
 * @param {any} event a function URL event on `live`, the erasure walk's own event on `erase`, or
 *   the Owner's `{ key, rows }` on `import` or `backfill`
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
  const kind = qualifier !== undefined && Object.hasOwn(OWNER_ALIASES, qualifier)
    ? OWNER_ALIASES[/** @type {keyof typeof OWNER_ALIASES} */ (qualifier)]
    : null;
  // The unqualified function, and any other qualifier: nothing reaches the table through them.
  if (!kind) {
    log(JSON.stringify({ rejected: 'path' }));
    return reply(403, { error: 'path' });
  }
  const parsed = ownerEventOf(event);
  if (!parsed.ok) {
    log(JSON.stringify({ caller: kind, rejected: parsed.error }));
    return reply(parsed.status, { error: parsed.error });
  }
  const { key, rows } = parsed;
  // The key must have a registration in the table, and an active one (plan 0008 §9).
  const reg = await registrationOfKey(db, env, key);
  if (!reg) {
    log(JSON.stringify({ caller: kind, rejected: 'key' }));
    return reply(400, { error: 'key' });
  }
  if (reg.status === 'suspended') {
    log(JSON.stringify({ caller: kind, key, rejected: 'suspended' }));
    return reply(403, { error: 'suspended' });
  }
  if (reg.status !== 'active') {
    log(JSON.stringify({ caller: kind, key, rejected: 'erased' }));
    return reply(410, { error: 'erased' });
  }
  const put = deps.put ?? (async (/** @type {Record<string, any>} */ item, /** @type {Env} */ e) => {
    await db('PutItem', { TableName: e.TABLE_NAME, Item: toAttributes(item) });
  });
  // Neither caller stores a finding (`rows.mjs` refuses one), so no sender context is read; and
  // neither is counted against the key's quotas (plan 0008 §6).
  const r = await storeRows(rows, { caller: { kind, key: null }, key, now, put: (item) => put(item, env) });
  log(JSON.stringify({ caller: kind, key, rows: r.logged }));
  return reply(r.status, { results: r.results });
}

/** The Lambda entry point: the qualifier comes from the ARN Lambda invoked, never the event. */
export const handler = (/** @type {any} */ event, /** @type {any} */ context) => handle(event, {
  invokedFunctionArn: context?.invokedFunctionArn,
  remainingMs: () => (typeof context?.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : 10_000),
});
