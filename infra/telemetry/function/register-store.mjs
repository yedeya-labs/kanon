// The ingest function's reads and writes of the register table (plan 0008 §5, §6, §7), for both
// of its paths. Every write here is one the ingest role's IAM conditions admit
// (`register-fields.mjs`): it names no operator field, in its item, its update or its condition.
//
// THE OPERATOR'S FIELDS SURVIVE EVERY WRITE HERE, which IAM can't hold (`register-fields.mjs`):
//   - a registration is created by a `PutItem` conditional on NO item, or on a tombstone, which
//     holds no operator field (the CLI's `set` and `suspend` refuse an erased registration);
//   - every other write to a registration is an `UpdateItem` that SETs function fields only,
//     which leaves every other field as it is;
//   - the one whole-item `PutItem` over a registration is the tombstone (§7), which drops them by
//     design, conditional on the registration being `erased` under the same key.
// AND A SUSPENSION STAYS: the writes that set `status` are conditional on the status they replace
// (`active` for an erasure, a tombstone for a re-registration), so a suspension the operator wrote
// between the function's read and its write makes the write fail rather than undo it.
//
// THE COUNTERS (§6): `count#<key>#<window>` and `refused#<key>#<day>`, `count#owner#<owner id>#<day>`
// and `count#all#<day>`, each expiring two days out. A reservation is one conditional `ADD` of the
// whole amount: it fits or nothing is added.

import { AwsError, attr, itemOf, plainItem } from './aws.mjs';
import { KEY_ITEM_PREFIX, REGISTRATION_PREFIX } from './register-fields.mjs';

/** @typedef {import('./aws.mjs').Dynamo} Dynamo */
/** @typedef {{ REGISTER_TABLE?: string }} RegisterEnv */
/** @typedef {Record<string, any>} Registration a registration item, as plain values */

/** The defaults of §6 (Owner decision 6 of 2026-10-12), per key unless said otherwise. */
export const QUOTAS = Object.freeze({
  rows_per_day: 5_000,
  requests_per_hour: 120,
  erasures_per_day: 5,
  registrations_per_owner_per_day: 20,
  registrations_per_day: 100,
});
/** A counter outlives its window by this much (§5.2). */
const COUNTER_LIFE_S = 2 * 86_400;

const tableOf = (/** @type {RegisterEnv} */ env) => env.REGISTER_TABLE || 'kanon-telemetry-register';
export const registrationPk = (/** @type {string} */ repositoryId) => `${REGISTRATION_PREFIX}${repositoryId}`;
export const keyItemPk = (/** @type {string} */ key) => `${KEY_ITEM_PREFIX}${key}`;
const NAMES = { '#pk': 'pk', '#s': 'status', '#k': 'key', '#n': 'n', '#x': 'expires_at' };
/** The names an expression uses, so a request names no attribute it doesn't use. @param {string} expr */
const namesIn = (expr) => Object.fromEntries(Object.entries(NAMES).filter(([n]) => new RegExp(`${n}\\b`).test(expr)));

/** The UTC day, `YYYY-MM-DD`, and hour, `YYYY-MM-DDTHH`, of a time, and when each ends. @param {number} now */
export function windowsOf(now) {
  const iso = new Date(now).toISOString();
  const day = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  return { day: iso.slice(0, 10), hour: iso.slice(0, 13), dayEnds: day + 86_400_000, hourEnds: hour + 3_600_000 };
}

/**
 * A registration by repository id, read consistently, or undefined.
 * @param {Dynamo} db @param {RegisterEnv} env @param {string} repositoryId
 * @returns {Promise<Registration | undefined>}
 */
export async function getRegistration(db, env, repositoryId) {
  const r = await db('GetItem', { TableName: tableOf(env), Key: { pk: { S: registrationPk(repositoryId) } }, ConsistentRead: true });
  return plainItem(r.Item);
}

/**
 * A registration by its key, through the key item (§5.2), or undefined. The registration must
 * hold the same key: a key item left behind by an unfinished erasure finds nothing.
 * @param {Dynamo} db @param {RegisterEnv} env @param {string} key
 */
export async function registrationOfKey(db, env, key) {
  const k = await db('GetItem', { TableName: tableOf(env), Key: { pk: { S: keyItemPk(key) } }, ConsistentRead: true });
  const id = plainItem(k.Item)?.repository_id;
  if (typeof id !== 'string') return undefined;
  const reg = await getRegistration(db, env, id);
  return reg?.key === key ? reg : undefined;
}

/**
 * Every registered key, from the key items (§3.4): a `Scan` of `pk` alone, as the ingest role's
 * condition holds it.
 * @param {Dynamo} db @param {RegisterEnv} env
 */
export async function scanKeys(db, env) {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {any} */
  let start;
  do {
    const r = await db('Scan', {
      TableName: tableOf(env), ProjectionExpression: '#pk', ExpressionAttributeNames: { '#pk': 'pk' }, Select: 'SPECIFIC_ATTRIBUTES',
      ...(start ? { ExclusiveStartKey: start } : {}),
    });
    for (const item of r.Items ?? []) {
      const pk = item?.pk?.S;
      if (typeof pk === 'string' && pk.startsWith(KEY_ITEM_PREFIX)) keys.add(pk.slice(KEY_ITEM_PREFIX.length));
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return keys;
}

/** How long the registered keys are held per container (§3.4). */
export const KEYS_TTL_MS = 5 * 60_000;

/** The container's cache of registered keys. @returns {{ keys: (db: Dynamo, env: RegisterEnv, now: number) => Promise<Set<string>> }} */
export function keysCache() {
  /** @type {Set<string> | undefined} */
  let held;
  let at = -Infinity;
  return {
    async keys(db, env, now) {
      if (!held || now - at >= KEYS_TTL_MS) {
        held = await scanKeys(db, env);
        at = now;
      }
      return held;
    },
  };
}

/** The `UpdateItem` of one reservation or count. */
function counterUpdate(/** @type {RegisterEnv} */ env, /** @type {string} */ pk, /** @type {number} */ n, /** @type {number} */ now, /** @type {number | undefined} */ limit) {
  const update = 'ADD #n :n SET #x = :x';
  const condition = limit === undefined ? undefined : 'attribute_not_exists(#n) OR #n <= :room';
  return {
    TableName: tableOf(env),
    Key: { pk: { S: pk } },
    UpdateExpression: update,
    ...(condition ? { ConditionExpression: condition } : {}),
    ExpressionAttributeNames: namesIn(`${update} ${condition ?? ''}`),
    ExpressionAttributeValues: {
      ':n': { N: String(n) }, ':x': { N: String(Math.floor(now / 1000) + COUNTER_LIFE_S) },
      ...(limit === undefined ? {} : { ':room': { N: String(limit - n) } }),
    },
  };
}

/**
 * Reserve `n` on a counter whose limit is `limit`: one conditional `ADD`, so the whole `n` fits or
 * nothing is added. False when it doesn't fit.
 * @param {Dynamo} db @param {RegisterEnv} env
 * @param {{ pk: string, n: number, limit: number, now: number }} r
 */
export async function reserve(db, env, { pk, n, limit, now }) {
  if (n > limit) return false;
  try {
    await db('UpdateItem', counterUpdate(env, pk, n, now, limit));
    return true;
  } catch (e) {
    if (e instanceof AwsError && e.code === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/** Add `n` to a counter, with no limit: the refused rows (§6). @param {Dynamo} db @param {RegisterEnv} env @param {{ pk: string, n: number, now: number }} r */
export async function count(db, env, { pk, n, now }) {
  await db('UpdateItem', counterUpdate(env, pk, n, now, undefined));
}

/** A counter's value, or 0. @param {Dynamo} db @param {RegisterEnv} env @param {string} pk */
export async function counterValue(db, env, pk) {
  const r = await db('GetItem', { TableName: tableOf(env), Key: { pk: { S: pk } }, ConsistentRead: true });
  const n = plainItem(r.Item)?.n;
  return typeof n === 'number' ? n : 0;
}

/**
 * Register: in one transaction, the registration and the key item, each conditional on not
 * existing (or, over a tombstone, on the tombstone), and the two registration counters, each
 * reserving one (§3.3, §6). So two concurrent first runs make one registration.
 * @param {Dynamo} db @param {RegisterEnv} env
 * @param {{ registration: Registration, overTombstone: boolean, now: number, ownerLimit: number, allLimit: number }} r
 * @returns {Promise<'created' | 'exists' | 'key-taken' | 'quota'>}
 */
export async function createRegistration(db, env, { registration, overTombstone, now, ownerLimit, allLimit }) {
  const { day } = windowsOf(now);
  const table = tableOf(env);
  const regCondition = overTombstone ? '#s = :erased AND attribute_exists(rows_erased_at) AND attribute_not_exists(#k)' : 'attribute_not_exists(#pk)';
  try {
    await db('TransactWriteItems', {
      TransactItems: [
        {
          Put: {
            TableName: table, Item: itemOf(registration), ConditionExpression: regCondition, ExpressionAttributeNames: namesIn(regCondition),
            ...(overTombstone ? { ExpressionAttributeValues: { ':erased': { S: 'erased' } } } : {}),
          },
        },
        {
          Put: {
            TableName: table, Item: itemOf({ pk: keyItemPk(registration.key), repository_id: registration.repository_id }),
            ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' },
          },
        },
        { Update: counterUpdate(env, `count#owner#${registration.repository_owner_id}#${day}`, 1, now, ownerLimit) },
        { Update: counterUpdate(env, `count#all#${day}`, 1, now, allLimit) },
      ],
    });
    return 'created';
  } catch (e) {
    if (!(e instanceof AwsError) || e.code !== 'TransactionCanceledException') throw e;
    const failed = (/** @type {number} */ i) => e.reasons[i] === 'ConditionalCheckFailed';
    if (failed(0)) return 'exists';
    if (failed(2) || failed(3)) return 'quota';
    if (failed(1)) return 'key-taken';
    throw e;
  }
}

/**
 * SET function fields on an active registration, and nothing else: the operator's fields stay.
 * False when it is no longer active.
 * @param {Dynamo} db @param {RegisterEnv} env @param {string} repositoryId @param {Record<string, unknown>} fields
 */
export async function refreshRegistration(db, env, repositoryId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return true;
  /** @type {Record<string, string>} */
  const names = { '#s': 'status' };
  /** @type {Record<string, any>} */
  const values = { ':active': { S: 'active' } };
  const sets = entries.map(([f, v], i) => {
    names[`#f${i}`] = f;
    values[`:f${i}`] = attr(v);
    return `#f${i} = :f${i}`;
  });
  try {
    await db('UpdateItem', {
      TableName: tableOf(env), Key: { pk: { S: registrationPk(repositoryId) } },
      UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: '#s = :active',
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    });
    return true;
  } catch (e) {
    if (e instanceof AwsError && e.code === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/**
 * §7 step 1: `status: erased` and `erased_at`, only over `active`, so a suspension stays. False
 * when the registration was not active.
 * @param {Dynamo} db @param {RegisterEnv} env @param {string} repositoryId @param {string} erasedAt
 */
export async function markErased(db, env, repositoryId, erasedAt) {
  try {
    await db('UpdateItem', {
      TableName: tableOf(env), Key: { pk: { S: registrationPk(repositoryId) } },
      UpdateExpression: 'SET #s = :erased, erased_at = :t', ConditionExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':erased': { S: 'erased' }, ':active': { S: 'active' }, ':t': { S: erasedAt } },
    });
    return true;
  } catch (e) {
    if (e instanceof AwsError && e.code === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/**
 * §7 step 3: the key item goes, and the registration becomes its tombstone, a whole-item `PutItem`
 * of the two ids, the status and two dates, over an `erased` registration under the same key.
 * @param {Dynamo} db @param {RegisterEnv} env
 * @param {{ registration: Registration, rowsErasedAt: string }} r
 */
export async function writeTombstone(db, env, { registration, rowsErasedAt }) {
  const table = tableOf(env);
  const tombstone = {
    pk: registrationPk(registration.repository_id),
    repository_id: registration.repository_id,
    repository_owner_id: registration.repository_owner_id,
    status: 'erased',
    erased_at: registration.erased_at,
    rows_erased_at: rowsErasedAt,
  };
  await db('TransactWriteItems', {
    TransactItems: [
      {
        Put: {
          TableName: table, Item: itemOf(tombstone), ConditionExpression: '#k = :k AND #s = :erased',
          ExpressionAttributeNames: { '#k': 'key', '#s': 'status' },
          ExpressionAttributeValues: { ':k': { S: registration.key }, ':erased': { S: 'erased' } },
        },
      },
      { Delete: { TableName: table, Key: { pk: { S: keyItemPk(registration.key) } } } },
    ],
  });
}
