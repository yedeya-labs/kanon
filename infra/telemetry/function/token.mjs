// The token path (plan 0008 §3, step J3): the ingest function's five endpoints on the `live`
// alias's URL, each behind GitHub's OIDC token as `oidc.mjs` checks it, and the `erase` alias's
// handler that walks an erased key's rows (§7). `index.mjs` sends an invocation here by the alias
// Lambda says it came through, never by anything in the request (§9).
//
//   POST   /v1/registrations        register; active at once (§3.3)
//   GET    /v1/registrations/self   the registration's status, quota and flags
//   DELETE /v1/registrations/self   erase: status `erased` at once, the rows walked after (§7)
//   POST   /v1/rows                 up to 25 run, finding, work-item and deploy rows, mixed
//   GET    /v1/rows/self            the caller's own rows, a lane or `work` at a time (§3.5)
//
// THE KEY IS THE REGISTRATION'S, NEVER THE REQUEST'S. The token's `repository_id` finds the
// registration, and its `key` is the only key any endpoint uses: no parameter, header or row can
// name another. NO RESPONSE HOLDS IT, and no log line holds a token, a claim's value or a name.
// `GET /v1/rows/self` reads under a session of the self-read role whose policy's
// `dynamodb:LeadingKeys` is that key (Owner decision 2 of 2026-10-12), so a query can't leave it;
// its `cursor` is DynamoDB's `LastEvaluatedKey` sealed with AES-GCM under `CURSOR_KEY`, so it holds
// no key in clear and can't be forged to point at another partition.
//
// QUOTAS (§6): per key, 120 requests an hour on every endpoint, 5,000 rows stored a UTC day and 5
// erasures a day; per owner 20 new registrations a day, and 100 store-wide. Each is one counter
// reserved by a conditional `ADD` of the whole amount, BEFORE anything is written: a batch past the
// day's rows is refused whole (429), never half stored, and its rows are added to
// `refused#<key>#<day>` for the operator's daily report.
//
// Answers are JSON with `error` a code from a closed list on any non-2xx, never a value from the
// request: 400 `body-*` / `lane` / `fields` / `window` / `tag` / `cursor`; 401 checks 1 to 5
// (with `WWW-Authenticate`); 403 checks 6 to 9, `suspended`; 404 `not-registered`, `route`;
// 405 `method`; 409 `erased`, `erasing`; 410 `erased`; 413 `body-size`; 422 per row; 429 `quota`
// (with `Retry-After`); 502 a write failed, `erase-start`; 503 `jwks-unavailable`, `config`.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { plainItem } from './aws.mjs';
import { keyCache, REGISTRATION, verifyToken } from './oidc.mjs';
import {
  count, counterValue, createRegistration, getRegistration, keysCache, markErased, QUOTAS, refreshRegistration, registrationPk,
  reserve, windowsOf, writeTombstone,
} from './register-store.mjs';
import { addMonths, compact, hashSet, PARTITIONS, RETENTION_MONTHS, rowsOf, storeRows, toAttributes } from './rows.mjs';
import { ISO_UTC, LANES, RESERVED_PARTITION, SCHEMAS, TAGS } from './schema.mjs';
import { nameContext } from './scrub.mjs';

/** @typedef {import('./aws.mjs').Dynamo} Dynamo */
/** @typedef {import('./aws.mjs').Credentials} Credentials */
/** @typedef {import('./register-store.mjs').Registration} Registration */
/**
 * @typedef {{
 *   TABLE_NAME: string, ACCOUNT_ID: string, REGISTER_TABLE?: string, AUDIENCE?: string, MIN_TOKEN_VERSION?: string,
 *   SELF_READ_ROLE?: string, CURSOR_KEY?: string, AWS_REGION?: string, AWS_LAMBDA_FUNCTION_NAME?: string,
 * }} TokenEnv
 * @typedef {{
 *   env: TokenEnv, now: number, db: Dynamo, log: (line: string) => void,
 *   sts: (req: { roleArn: string, sessionName: string, policy: object }) => Promise<Credentials>,
 *   invoke: (functionName: string, qualifier: string, payload: object) => Promise<void>,
 *   jwks: import('./oidc.mjs').KeyCache, keys: ReturnType<typeof keysCache>, mintKey: () => string,
 *   remainingMs: () => number,
 * }} TokenDeps
 */

/** The alias whose URL serves this path, and the alias the erasure walk runs on (§7, §9). */
export const LIVE = 'live';
export const ERASE = 'erase';
/** At most this many rows a page of `GET /v1/rows/self` (§6). */
export const PAGE_ROWS = 1_000;
/** The function's name, when Lambda's environment doesn't say. */
const FUNCTION_NAME = 'kanon-telemetry-ingest';

/** Each path's endpoints, by method: the names `oidc.mjs`'s `ENDPOINT_WORKFLOWS` admits by. */
export const ROUTES = Object.freeze({
  '/v1/registrations': { POST: REGISTRATION },
  '/v1/registrations/self': { GET: 'GET /v1/registrations/self', DELETE: 'DELETE /v1/registrations/self' },
  '/v1/rows': { POST: 'POST /v1/rows' },
  '/v1/rows/self': { GET: 'GET /v1/rows/self' },
});

/** The container's caches: GitHub's keys (§2.4) and the registered keys (§3.4). */
const containerJwks = keyCache();
const containerKeys = keysCache();

/** A new key (§3.3): `k` and 16 hex characters, 64 bits. */
export const mintKey = () => `k${randomBytes(8).toString('hex')}`;

const reply = (/** @type {number} */ statusCode, /** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/**
 * 429 `quota` (§6), with `Retry-After` the window's end.
 * @param {'rows_per_day' | 'requests_per_hour' | 'erasures_per_day' | 'registrations'} limit
 * @param {number} resetsAt @param {number} now
 */
const quotaReply = (limit, resetsAt, now) =>
  reply(429, { error: 'quota', limit, resets_at: iso(resetsAt) }, { 'retry-after': String(Math.max(1, Math.ceil((resetsAt - now) / 1000))) });

// ------------------------------------------------------------------------- the cursor

/** The cursor's key, from `CURSOR_KEY` (64 hex characters), or null. @param {TokenEnv} env */
const cursorKeyOf = (env) => (typeof env.CURSOR_KEY === 'string' && /^[0-9a-f]{64}$/.test(env.CURSOR_KEY) ? Buffer.from(env.CURSOR_KEY, 'hex') : null);

/**
 * Seal a page's end: AES-256-GCM, so the cursor holds no key in clear, and any change to it fails.
 * @param {Buffer} secret @param {object} value
 */
export function sealCursor(secret, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Open a sealed cursor, or null for anything that isn't one of ours. @param {Buffer} secret @param {unknown} cursor */
export function openCursor(secret, cursor) {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{40,4096}$/.test(cursor)) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', secret, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------- the session

/**
 * The self-read session's policy (§3.5): `actions` on the rows table, for partitions of `key` only.
 * @param {TokenEnv} env @param {string} key @param {string[]} actions
 */
export function sessionPolicy(env, key, actions) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: actions,
      Resource: `arn:aws:dynamodb:${env.AWS_REGION ?? 'eu-central-1'}:${env.ACCOUNT_ID}:table/${env.TABLE_NAME}`,
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${key}#*`] } },
    }],
  };
}

/** A session held to one key's partitions. @param {TokenDeps} deps @param {string} key @param {string[]} actions */
const sessionFor = (deps, key, actions) =>
  deps.sts({ roleArn: /** @type {string} */ (deps.env.SELF_READ_ROLE), sessionName: 'kanon-telemetry-self', policy: sessionPolicy(deps.env, key, actions) });

// ------------------------------------------------------------------------- the entry

/**
 * One request on the `live` alias's URL.
 * @param {any} event a function URL event
 * @param {TokenDeps} deps
 */
export async function tokenHandle(event, deps) {
  const { env, now, log } = deps;
  const method = event?.requestContext?.http?.method;
  const path = typeof event?.rawPath === 'string' ? event.rawPath.replace(/\/+$/, '') : '';
  const route = /** @type {Record<string, Record<string, string>>} */ (ROUTES)[path];
  if (!route) return reply(404, { error: 'route' });
  const endpoint = typeof method === 'string' && Object.hasOwn(route, method) ? route[method] : undefined;
  if (!endpoint) return reply(405, { error: 'method' });

  const said = (/** @type {Record<string, unknown>} */ fields) => log(JSON.stringify({ path: 'token', endpoint, ...fields }));
  const authorization = event?.headers?.authorization ?? event?.headers?.Authorization;
  const bearer = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization)?.[1] : undefined;
  if (typeof env.AUDIENCE !== 'string' || !env.AUDIENCE || typeof env.MIN_TOKEN_VERSION !== 'string' || !/^\d+\.\d+\.\d+$/.test(env.MIN_TOKEN_VERSION)) {
    said({ refused: 'config' });
    return reply(503, { error: 'config' });
  }
  const v = await verifyToken(bearer, {
    audience: env.AUDIENCE, endpoint, now, keys: deps.jwks, minTokenVersion: env.MIN_TOKEN_VERSION,
    registrationOf: (id) => getRegistration(deps.db, env, id),
  });
  if (!v.ok) {
    said({ refused: v.error });
    return reply(v.status, { error: v.error }, v.status === 401 ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {});
  }
  if (endpoint === REGISTRATION) return register(event, v.caller, deps, said);

  const reg = /** @type {Registration} */ (v.registration);
  const key = typeof reg.key === 'string' ? reg.key : null;
  // Read by the collector to say why it stopped, so it answers a suspension and an erasure.
  if (endpoint === 'GET /v1/registrations/self') {
    if (key && !(await admitRequest(deps, reg, key))) return refusedRequest(deps, key, 0, said);
    said({ key, status: 200 });
    return reply(200, await statusOf(deps, reg, key));
  }
  if (reg.status === 'suspended') {
    said({ key, refused: 'suspended' });
    return reply(403, { error: 'suspended' });
  }
  if (endpoint === 'DELETE /v1/registrations/self') return erase(reg, key, deps, said);
  if (reg.status !== 'active' || !key) {
    said({ key, refused: 'erased' });
    return reply(410, { error: 'erased' });
  }

  if (endpoint === 'POST /v1/rows') {
    const parsed = rowsOf(event);
    if (!parsed.ok) return reply(parsed.status, { error: parsed.error });
    if (!(await admitRequest(deps, reg, key))) return refusedRequest(deps, key, parsed.rows.length, said);
    await refresh(deps, reg, v);
    return rows(parsed.rows, reg, key, v.caller, deps, said);
  }
  // GET /v1/rows/self
  if (!(await admitRequest(deps, reg, key))) return refusedRequest(deps, key, 0, said);
  await refresh(deps, reg, v);
  return ownRows(event, key, deps, said);
}

/** The registration's limits, the operator's where set (§5.2). @param {Registration} reg */
const limitsOf = (reg) => ({
  rows_per_day: Number.isInteger(reg.quota_rows_per_day) && reg.quota_rows_per_day > 0 ? reg.quota_rows_per_day : QUOTAS.rows_per_day,
  requests_per_hour: Number.isInteger(reg.quota_requests_per_hour) && reg.quota_requests_per_hour > 0 ? reg.quota_requests_per_hour : QUOTAS.requests_per_hour,
});

/** One request against the key's hourly limit. @param {TokenDeps} deps @param {Registration} reg @param {string} key */
const admitRequest = (deps, reg, key) =>
  reserve(deps.db, deps.env, { pk: `count#${key}#${windowsOf(deps.now).hour}`, n: 1, limit: limitsOf(reg).requests_per_hour, now: deps.now });

/**
 * 429 for the hour, with the request's rows counted as refused.
 * @param {TokenDeps} deps @param {string} key @param {number} n @param {(f: Record<string, unknown>) => void} said
 */
async function refusedRequest(deps, key, n, said) {
  if (n > 0) await countRefused(deps, key, n);
  said({ key, refused: 'quota', limit: 'requests_per_hour' });
  return quotaReply('requests_per_hour', windowsOf(deps.now).hourEnds, deps.now);
}

/** Add refused rows to `refused#<key>#<day>` (§6); a failure is logged, never answered. @param {TokenDeps} deps @param {string} key @param {number} n */
async function countRefused(deps, key, n) {
  try {
    await count(deps.db, deps.env, { pk: `refused#${key}#${windowsOf(deps.now).day}`, n, now: deps.now });
  } catch {
    deps.log(JSON.stringify({ path: 'token', key, failed: 'refused-count' }));
  }
}

/** The name hashes of a repository's words (§3.4), sorted, or undefined without a name. @param {string | null} repository */
const hashesOf = (repository) => (repository ? [...nameContext({ repository })].sort() : undefined);

/**
 * Keep the registration current (§2.3, §3.4, §5.2): the default branch a schedule moved, the
 * repository's name and hashes when the token's differ, and `last_seen_at` at most hourly. Function
 * fields only, on an active registration only.
 * @param {TokenDeps} deps @param {Registration} reg
 * @param {{ caller: { ref: string, repository: string | null }, ref_moved: boolean }} v
 */
async function refresh(deps, reg, v) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  if (v.ref_moved) fields.default_ref = v.caller.ref;
  if (v.caller.repository && v.caller.repository !== reg.repository) {
    fields.repository = v.caller.repository;
    fields.name_hashes = hashesOf(v.caller.repository);
  }
  const seen = typeof reg.last_seen_at === 'string' ? Date.parse(reg.last_seen_at) : NaN;
  if (Object.keys(fields).length || !(deps.now - seen < 3_600_000)) fields.last_seen_at = iso(deps.now);
  if (Object.keys(fields).length) await refreshRegistration(deps.db, deps.env, reg.repository_id, fields);
}

// ------------------------------------------------------------------------- POST /v1/registrations

/**
 * @param {any} event
 * @param {{ repository_id: string, repository_owner_id: string, ref: string, event_name: string, version: string, repository: string | null }} caller
 * @param {TokenDeps} deps @param {(f: Record<string, unknown>) => void} said
 */
async function register(event, caller, deps, said) {
  const { db, env, now } = deps;
  /** @type {unknown} */
  let body = {};
  const text = typeof event?.body === 'string' ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8').toString('utf8') : '';
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return reply(400, { error: 'body-json' });
    }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(400, { error: 'body-json' });
  const b = /** @type {Record<string, unknown>} */ (body);
  if (Object.keys(b).some((k) => k !== 'reregister') || (b.reregister !== undefined && typeof b.reregister !== 'boolean')) return reply(400, { error: 'body-fields' });
  const reregister = b.reregister === true;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getRegistration(db, env, caller.repository_id);
    if (existing && existing.status !== 'erased') return registered(existing, caller, deps, said);
    if (existing) {
      if (!reregister) {
        said({ refused: 'erased' });
        return reply(409, { error: 'erased' });
      }
      if (existing.repository_owner_id !== caller.repository_owner_id) return reply(403, { error: 'owner' });
      // A re-registration waits for the walk: the old key's rows go first.
      if (typeof existing.rows_erased_at !== 'string' || typeof existing.key === 'string') {
        said({ refused: 'erasing' });
        return reply(409, { error: 'erasing' });
      }
    }
    const registeredAt = iso(now);
    const registration = {
      pk: registrationPk(caller.repository_id),
      repository_id: caller.repository_id,
      repository_owner_id: caller.repository_owner_id,
      repository: caller.repository ?? undefined,
      key: deps.mintKey(),
      status: 'active',
      default_ref: caller.ref,
      name_hashes: hashesOf(caller.repository),
      registered_at: registeredAt,
      registered_by_version: caller.version,
      last_seen_at: registeredAt,
      source: 'api',
    };
    const made = await createRegistration(db, env, {
      registration, overTombstone: Boolean(existing), now,
      ownerLimit: QUOTAS.registrations_per_owner_per_day, allLimit: QUOTAS.registrations_per_day,
    });
    if (made === 'created') {
      said({ key: registration.key, status: 201 });
      return reply(201, { status: 'active', registered_at: registeredAt });
    }
    if (made === 'quota') {
      said({ refused: 'quota', limit: 'registrations' });
      return quotaReply('registrations', windowsOf(now).dayEnds, now);
    }
    // 'exists': a concurrent first run made it, so read it again; 'key-taken': mint another key.
  }
  said({ refused: 'register-retries' });
  return reply(503, { error: 'register-retries' });
}

/**
 * An existing registration, asked to register again: 200 for an active one, as for a new one.
 * @param {Registration} reg
 * @param {{ repository_owner_id: string, ref: string, event_name: string, repository: string | null }} caller
 * @param {TokenDeps} deps @param {(f: Record<string, unknown>) => void} said
 */
async function registered(reg, caller, deps, said) {
  const key = /** @type {string} */ (reg.key);
  // Checks 8 and 9, which the verifier leaves to registration's endpoint when one exists.
  if (reg.repository_owner_id !== caller.repository_owner_id) return reply(403, { error: 'owner' });
  if (reg.status === 'suspended') {
    said({ key, refused: 'suspended' });
    return reply(403, { error: 'suspended' });
  }
  const moved = reg.default_ref !== caller.ref;
  if (moved && caller.event_name !== 'schedule') return reply(403, { error: 'ref' });
  if (!(await admitRequest(deps, reg, key))) return refusedRequest(deps, key, 0, said);
  await refresh(deps, reg, { caller, ref_moved: moved });
  said({ key, status: 200 });
  return reply(200, { status: 'active', registered_at: reg.registered_at });
}

// ------------------------------------------------------------------------- GET /v1/registrations/self

/** @param {TokenDeps} deps @param {Registration} reg @param {string | null} key */
async function statusOf(deps, reg, key) {
  const limits = limitsOf(reg);
  const today = key ? await counterValue(deps.db, deps.env, `count#${key}#${windowsOf(deps.now).day}`) : 0;
  return {
    status: reg.status,
    ...(typeof reg.registered_at === 'string' ? { registered_at: reg.registered_at } : {}),
    ...(reg.status === 'suspended' && typeof reg.suspended_at === 'string' ? { suspended_at: reg.suspended_at } : {}),
    ...(reg.status === 'suspended' && typeof reg.suspended_reason === 'string' ? { suspended_reason: reg.suspended_reason } : {}),
    ...(typeof reg.erased_at === 'string' ? { erased_at: reg.erased_at } : {}),
    rows_erased: typeof reg.rows_erased_at === 'string',
    quota: { rows_per_day: limits.rows_per_day, rows_today: today },
    aggregate_invoker: reg.aggregate_invoker === true,
    ...(typeof reg.publish_own_figures_as === 'string' ? { publish_own_figures_as: reg.publish_own_figures_as } : {}),
  };
}

// ------------------------------------------------------------------------- DELETE /v1/registrations/self

/**
 * §7 steps 1 and 2: `erased` at once, then the walk on the `erase` alias.
 * @param {Registration} reg @param {string | null} key @param {TokenDeps} deps @param {(f: Record<string, unknown>) => void} said
 */
async function erase(reg, key, deps, said) {
  const { db, env, now } = deps;
  const answer = (/** @type {number} */ status, /** @type {Registration} */ r) =>
    reply(status, { status: 'erased', erased_at: r.erased_at, rows_erased: typeof r.rows_erased_at === 'string' });
  if (!key) return answer(200, reg); // a tombstone: done
  if (!(await admitRequest(deps, reg, key))) return refusedRequest(deps, key, 0, said);
  const { day, dayEnds } = windowsOf(now);
  if (!(await reserve(db, env, { pk: `count#${key}#erase-${day}`, n: 1, limit: QUOTAS.erasures_per_day, now }))) {
    said({ key, refused: 'quota', limit: 'erasures_per_day' });
    return quotaReply('erasures_per_day', dayEnds, now);
  }
  let current = reg;
  let status = 200;
  if (reg.status === 'active') {
    if (await markErased(db, env, reg.repository_id, iso(now))) {
      current = { ...reg, status: 'erased', erased_at: iso(now) };
      status = 202;
    } else {
      // Not active any more: suspended or erased since the read. A suspension stays.
      current = /** @type {Registration} */ (await getRegistration(db, env, reg.repository_id));
      if (current?.status === 'suspended') {
        said({ key, refused: 'suspended' });
        return reply(403, { error: 'suspended' });
      }
      if (current?.status !== 'erased') return reply(409, { error: 'erasing' });
      if (typeof current.key !== 'string') return answer(200, current);
    }
  }
  try {
    await deps.invoke(env.AWS_LAMBDA_FUNCTION_NAME || FUNCTION_NAME, ERASE, { kanon_erase: { repository_id: reg.repository_id } });
  } catch {
    said({ key, failed: 'erase-start' });
    return reply(502, { error: 'erase-start' });
  }
  said({ key, status });
  return answer(status, current);
}

/**
 * The `erase` alias (§7 steps 2 and 3): walk every partition of an ERASED registration's key with
 * `BatchWriteItem` deletes, under a session held to that key; when none is left, the tombstone.
 * It hands itself on when its time runs short, so a key of any size finishes.
 * @param {any} event `{ kanon_erase: { repository_id } }`, from `erase` above
 * @param {TokenDeps} deps
 * @returns {Promise<ReturnType<typeof reply>>} 200 `{ done: true }`, 202 `{ done: false }` handed on, 400 `{ error }`
 */
export async function eraseHandle(event, deps) {
  const { db, env, log } = deps;
  const id = event?.kanon_erase?.repository_id;
  if (event?.requestContext !== undefined || typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) return reply(400, { error: 'event' });
  const reg = await getRegistration(db, env, id);
  if (!reg) return reply(400, { error: 'not-registered' });
  // Only an erased registration's rows are walked: a stray invocation can't erase an active key.
  if (reg.status !== 'erased') return reply(400, { error: 'not-erased' });
  if (typeof reg.key !== 'string') return reply(200, { done: true });
  const key = reg.key;
  const credentials = await sessionFor(deps, key, ['dynamodb:Query', 'dynamodb:BatchWriteItem']);
  let deleted = 0;
  for (const partition of PARTITIONS.map((p) => `${key}#${p}`)) {
    for (;;) {
      if (deps.remainingMs() < 3_000) {
        await deps.invoke(env.AWS_LAMBDA_FUNCTION_NAME || FUNCTION_NAME, ERASE, { kanon_erase: { repository_id: id } });
        log(JSON.stringify({ path: 'erase', key, deleted, handed_on: true }));
        return reply(202, { done: false });
      }
      const page = await db('Query', {
        TableName: env.TABLE_NAME, KeyConditionExpression: '#pk = :p', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':p': { S: partition } }, ProjectionExpression: '#pk, #sk', Limit: 250,
      }, credentials);
      const keys = (page.Items ?? []).map((/** @type {any} */ i) => ({ pk: i.pk, sk: i.sk }));
      if (!keys.length) break;
      for (let i = 0; i < keys.length; i += 25) {
        /** @type {Record<string, any[]>} */
        let requests = { [env.TABLE_NAME]: keys.slice(i, i + 25).map((/** @type {any} */ k) => ({ DeleteRequest: { Key: k } })) };
        for (let tries = 0; requests[env.TABLE_NAME]?.length; tries += 1) {
          if (tries === 5) throw new Error('erase: deletes still unprocessed');
          requests = (await db('BatchWriteItem', { RequestItems: requests }, credentials)).UnprocessedItems ?? {};
        }
      }
      deleted += keys.length;
    }
  }
  await writeTombstone(db, env, { registration: reg, rowsErasedAt: iso(deps.now) });
  log(JSON.stringify({ path: 'erase', key, deleted, tombstone: true }));
  return reply(200, { done: true });
}

// ------------------------------------------------------------------------- POST /v1/rows

/**
 * @param {unknown[]} batch @param {Registration} reg @param {string} key
 * @param {{ repository: string | null }} caller @param {TokenDeps} deps @param {(f: Record<string, unknown>) => void} said
 */
async function rows(batch, reg, key, caller, deps, said) {
  const { db, env, now } = deps;
  const findings = batch.some((r) => /** @type {any} */ (r)?.row_kind === 'finding');
  // The sender's name hashes come from the token (§3.4), and its own key is always among the keys.
  const finding = findings
    ? { nameHashes: hashSet(hashesOf(caller.repository)), keys: new Set([...(await deps.keys.keys(db, env, now)), key]) }
    : undefined;
  const { day, dayEnds } = windowsOf(now);
  const limit = limitsOf(reg).rows_per_day;
  const r = await storeRows(batch, {
    caller: { kind: 'writer', key }, key, now, finding,
    put: async (item) => { await db('PutItem', { TableName: env.TABLE_NAME, Item: toAttributes(item) }); },
    admit: (n) => reserve(db, env, { pk: `count#${key}#${day}`, n, limit, now }),
  });
  if (!r.admitted) {
    await countRefused(deps, key, batch.length);
    said({ key, refused: 'quota', limit: 'rows_per_day', rows: batch.length });
    return quotaReply('rows_per_day', dayEnds, now);
  }
  said({ key, status: r.status, rows: r.logged });
  return reply(r.status, { results: r.results });
}

// ------------------------------------------------------------------------- GET /v1/rows/self

/** Every field a row kind's schema allows, over its versions. @param {'run' | 'work_item'} kind */
const fieldsOf = (kind) => [...new Set(Object.values(SCHEMAS[kind] ?? {}).flatMap((v) => Object.keys(v)))];

/**
 * @param {any} event @param {string} key @param {TokenDeps} deps @param {(f: Record<string, unknown>) => void} said
 */
async function ownRows(event, key, deps, said) {
  const { db, env, now } = deps;
  const secret = cursorKeyOf(env);
  if (!secret || !env.SELF_READ_ROLE) return reply(503, { error: 'config' });
  const q = event?.queryStringParameters ?? {};
  const lane = q.lane;
  if (typeof lane !== 'string' || !(LANES.includes(lane) || lane === RESERVED_PARTITION)) return reply(400, { error: 'lane' });
  const tag = q.tag ?? 'run';
  if (!TAGS.includes(tag)) return reply(400, { error: 'tag' });
  const from = q.from ?? iso(addMonths(now, -RETENTION_MONTHS));
  const to = q.to ?? iso(now);
  if (!ISO_UTC.test(from) || !ISO_UTC.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) > Date.parse(to)) {
    return reply(400, { error: 'window' });
  }
  const allowed = fieldsOf(lane === RESERVED_PARTITION ? 'work_item' : 'run');
  const fields = q.fields === undefined ? allowed : String(q.fields).split(',');
  if (!fields.length || fields.some((f) => !allowed.includes(f)) || new Set(fields).size !== fields.length) return reply(400, { error: 'fields' });
  const partition = `${key}#${lane}`;
  /** @type {any} */
  let start;
  if (q.cursor !== undefined) {
    const c = openCursor(secret, q.cursor);
    if (!c || c.p !== partition || typeof c.k !== 'object' || c.k?.pk?.S !== partition) return reply(400, { error: 'cursor' });
    start = c.k;
  }

  /** @type {Record<string, string>} */
  const names = { '#pk': 'pk', '#tag': 'tag', '#rec': 'recorded_at', '#exp': 'expires_at' };
  fields.forEach((f, i) => { names[`#f${i}`] = f; });
  /** @type {Record<string, any>} */
  const values = {
    ':p': { S: partition }, ':tag': { S: tag }, ':from': { S: from }, ':to': { S: to }, ':now': { N: String(Math.floor(now / 1000)) },
  };
  let keyCondition = '#pk = :p';
  if (lane !== RESERVED_PARTITION) {
    names['#sk'] = 'sk';
    values[':a'] = { S: compact(from) };
    values[':b'] = { S: `${compact(to)}~` };
    keyCondition += ' AND #sk BETWEEN :a AND :b';
  }
  const credentials = await sessionFor(deps, key, ['dynamodb:Query']);
  const page = await db('Query', {
    TableName: env.TABLE_NAME,
    KeyConditionExpression: keyCondition,
    FilterExpression: '#tag = :tag AND #exp > :now AND #rec >= :from AND #rec <= :to',
    ProjectionExpression: [...fields.map((_, i) => `#f${i}`), '#exp'].join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    Limit: PAGE_ROWS,
    ...(start ? { ExclusiveStartKey: start } : {}),
  }, credentials);
  const nowS = Math.floor(now / 1000);
  const out = /** @type {any[]} */ (page.Items ?? []).map((i) => /** @type {Record<string, any>} */ (plainItem(i)))
    // Never a row past its `expires_at`, whatever TTL has not yet swept.
    .filter((r) => typeof r.expires_at === 'number' && r.expires_at > nowS)
    .map((r) => Object.fromEntries(fields.filter((f) => r[f] !== undefined).map((f) => [f, r[f]])));
  const cursor = page.LastEvaluatedKey ? sealCursor(secret, { p: partition, k: page.LastEvaluatedKey }) : undefined;
  said({ key, status: 200, lane, rows: out.length });
  return reply(200, { rows: out, ...(cursor ? { cursor } : {}) });
}

/** The container's own caches, for Lambda: one of each per container. */
export const containerCaches = () => ({ jwks: containerJwks, keys: containerKeys });
