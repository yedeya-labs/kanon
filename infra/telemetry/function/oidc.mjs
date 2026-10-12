// The OIDC token verifier (plan 0008 §2.2 to §2.5, step J1): checks a GitHub Actions OIDC token
// claim by claim, against GitHub's published keys, for one endpoint of the store. The ingest
// function's five endpoints (`token.mjs`, J3) stand behind it; the aggregate function's are J4's.
//
// The checks run in §2.2's order and STOP AT THE FIRST FAILURE. A missing claim, a claim of the
// wrong type, or an extra value where one is expected is a refusal, never a skip, and each refusal
// answers its own status and code, so a live check can tell which claim refused a token. The codes
// are public, as this code is:
//   401 `token`     not a compact JWS of three base64url parts of JSON (§13's no-token check);
//   401 `alg`       check 1: `alg` is not exactly `RS256`, or `kid` is not a non-empty string;
//   503 `jwks-unavailable`, 401 `kid`, 401 `signature`   check 2 (§2.4 below);
//   401 `iss`, 401 `aud`, 401 `time`                     checks 3 to 5;
//   403 `event`     check 6: `event_name` is not `schedule` or `workflow_dispatch` (an allow-list);
//   403 `workflow`  check 7: `job_workflow_ref` is not one of the endpoint's workflows in Kanon's
//                   repository at a release tag `v<X>.<Y>.<Z>` at or above `MIN_TOKEN_VERSION`;
//   403 `owner`     check 8: `repository_id` or `repository_owner_id` is not a decimal string, or the
//                   owner differs from the registration's; 404 `not-registered`: no registration;
//   403 `ref`       check 9: `ref_type` is not `branch`, `ref` is not a branch's, or `ref` differs
//                   from the registration's `default_ref`, except on a `schedule` (§2.3, below).
//                   A TOMBSTONE (§7: `erased`, no key) keeps no `default_ref`, so its `ref` is held
//                   to a branch's form only: all a tombstone answers is that it is erased (J3).
//
// A NAME, NOT A JOB. A token names the workflow file it was minted in, so each endpoint admits its
// workflows (`ENDPOINT_WORKFLOWS`); which jobs of them may mint a token is the id-token guard's.
//
// THE DEFAULT BRANCH (§2.3). Registration reads no registration: it records the token's `ref`,
// which a `schedule` (or the collector's default-branch-only dispatch) proves is the default
// branch. Every other endpoint compares `ref` with the registration's `default_ref`. A `schedule`
// token whose `ref` differs is admitted with `ref_moved: true`, since GitHub runs a schedule only
// on the default branch, so the caller moves `default_ref` and a renamed branch heals; a dispatch
// token whose `ref` differs is refused.
//
// THE KEYS (§2.4), `keyCache`: GitHub's JWKS from its fixed URL, RSA keys with `use: sig` only,
// held 15 minutes per container. An unknown `kid` refetches, and every fetch, a refetch or a
// stale cache's, happens at most once a minute, with a 2-second timeout and no retry. FAIL
// CLOSED: with no set younger than 15 minutes and a failed fetch, every token answers 503
// `jwks-unavailable`; a stale key is never used.
//
// NOTHING IS LOGGED: no token, key or claim value. A refusal is its status and code alone.
//
// `node:` built-ins only (`createPublicKey` with a JWK, `verify` with `RSA-SHA256`): no JWT library.

import { createPublicKey, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** @typedef {import('node:crypto').KeyObject} KeyObject */
/** @typedef {{ ok: false, status: number, error: string }} Refusal */
/** @typedef {{ repository_owner_id?: unknown, default_ref?: unknown, status?: unknown, key?: unknown }} Registration */
/**
 * @typedef {{
 *   ok: true,
 *   caller: {
 *     repository_id: string, repository_owner_id: string, ref: string, event_name: string,
 *     workflow: string, version: string, repository: string | null,
 *   },
 *   registration: Registration | undefined,
 *   ref_moved: boolean,
 * }} Admitted
 */
/** @typedef {{ keyOf: (kid: string, now: number) => Promise<{ key: KeyObject } | { error: 'kid' | 'jwks-unavailable' }> }} KeyCache */

export const ISSUER = 'https://token.actions.githubusercontent.com';
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;
/** Allowed clock skew on `exp`, `nbf` and `iat`, and the maximum age on `iat` (Owner decision 9). */
export const SKEW_SECONDS = 60;
export const MAX_AGE_SECONDS = 600;
/** The JWKS cache's life, the least time between two fetches, and a fetch's timeout (decision 8). */
export const JWKS_TTL_MS = 15 * 60_000;
export const JWKS_REFETCH_MS = 60_000;
export const JWKS_TIMEOUT_MS = 2_000;
/** The collector caller's two triggers (check 6). */
export const EVENTS = ['schedule', 'workflow_dispatch'];
/** Check 7: the only repository whose workflows may call the store. */
export const WORKFLOW_REPOSITORY = 'yedeya-labs/kanon';
export const REGISTRATION = 'POST /v1/registrations';
/** §2.2's table: the workflow files each endpoint admits. */
export const ENDPOINT_WORKFLOWS = Object.freeze({
  [REGISTRATION]: ['telemetry-collect.yml'],
  'GET /v1/registrations/self': ['telemetry-collect.yml', 'agent-overseer.yml', 'agent-explore-telemetry.yml'],
  'DELETE /v1/registrations/self': ['telemetry-collect.yml'],
  'POST /v1/rows': ['telemetry-collect.yml'],
  'GET /v1/rows/self': ['agent-overseer.yml'],
  aggregate: ['agent-explore-telemetry.yml'],
});

const PART = /^[A-Za-z0-9_-]+$/;
const ID = /^[1-9][0-9]{0,19}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const JOB_WORKFLOW_REF = new RegExp(
  `^${WORKFLOW_REPOSITORY.replace(/[.-]/g, '\\$&')}/\\.github/workflows/([A-Za-z0-9_.-]+)@refs/tags/v((?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*))$`,
);
const BRANCH_REF = /^refs\/heads\/\S+$/;

/** @returns {Refusal} */
const refuse = (/** @type {number} */ status, /** @type {string} */ error) => ({ ok: false, status, error });
const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `a` at or above `b`, each `X.Y.Z`, compared as numbers. */
function atLeast(/** @type {string} */ a, /** @type {string} */ b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return /** @type {number} */ (x[i]) > /** @type {number} */ (y[i]);
  return true;
}

/** A base64url part decoded as a JSON object, or undefined. */
function jsonPart(/** @type {string} */ part) {
  if (!PART.test(part)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObject(v) ? /** @type {Record<string, unknown>} */ (v) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GitHub's signing keys, from one fetch of the JWKS: RSA keys with `use: sig` (and `alg`, if
 * given, `RS256`). Undefined for any failure, an error status, a body that isn't a JWKS, or a set
 * with no such key, so the cache counts it as a failed fetch.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @returns {Promise<Map<string, KeyObject> | undefined>}
 */
async function fetchKeys(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { signal: globalThis.AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = await res.json();
    if (!isObject(body) || !Array.isArray(body.keys)) return undefined;
    /** @type {Map<string, KeyObject>} */
    const keys = new Map();
    for (const jwk of body.keys) {
      if (!isObject(jwk) || jwk.kty !== 'RSA' || jwk.use !== 'sig' || typeof jwk.kid !== 'string' || jwk.kid === '') continue;
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        // A key Node can't read is not a key; the rest of the set still is.
      }
    }
    return keys.size > 0 ? keys : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The container's JWKS cache (§2.4). One per container: create it outside the handler.
 *
 * @param {{ fetchImpl?: typeof fetch, url?: string }} [opts]
 * @returns {KeyCache}
 */
export function keyCache({ fetchImpl = fetch, url = JWKS_URL } = {}) {
  /** @type {Map<string, KeyObject>} */
  let keys = new Map();
  let fetchedAt = -Infinity;
  let triedAt = -Infinity;
  return {
    async keyOf(kid, now) {
      const fresh = () => now - fetchedAt < JWKS_TTL_MS;
      if ((!fresh() || !keys.has(kid)) && now - triedAt >= JWKS_REFETCH_MS) {
        triedAt = now;
        const fetched = await fetchKeys(fetchImpl, url);
        if (fetched) {
          keys = fetched;
          fetchedAt = now;
        }
      }
      if (!fresh()) {
        keys = new Map();
        return { error: 'jwks-unavailable' };
      }
      const key = keys.get(kid);
      return key ? { key } : { error: 'kid' };
    },
  };
}

/**
 * Checks one token for one endpoint, in §2.2's order, and stops at the first failure.
 *
 * Throws on a configuration it can't hold (no audience, an unknown endpoint, a malformed
 * `minTokenVersion`, no key cache, no registration lookup where one is needed): the handler
 * answers 5xx, and nothing is admitted.
 *
 * @param {unknown} token the bearer token, as sent
 * @param {{
 *   audience: string,
 *   endpoint: string,
 *   now?: number,
 *   keys: KeyCache,
 *   minTokenVersion: string,
 *   registrationOf?: (repositoryId: string) => Promise<Registration | undefined | null>,
 * }} opts `audience` and `minTokenVersion` (`X.Y.Z`) are the template's `Audience` and
 *   `MIN_TOKEN_VERSION`; `endpoint` a key of `ENDPOINT_WORKFLOWS`; `now` in milliseconds;
 *   `registrationOf` finds a registration by `repository_id` (the register table, J2)
 * @returns {Promise<Admitted | Refusal>}
 */
export async function verifyToken(token, { audience, endpoint, now = Date.now(), keys, minTokenVersion, registrationOf }) {
  if (typeof audience !== 'string' || audience === '') throw new TypeError('verifyToken: audience must be a non-empty string');
  if (!Object.hasOwn(ENDPOINT_WORKFLOWS, endpoint)) throw new TypeError('verifyToken: endpoint is not one of ENDPOINT_WORKFLOWS');
  if (typeof minTokenVersion !== 'string' || !VERSION.test(minTokenVersion)) throw new TypeError('verifyToken: minTokenVersion must be X.Y.Z');
  if (typeof keys?.keyOf !== 'function') throw new TypeError('verifyToken: keys must be a keyCache');
  const registering = endpoint === REGISTRATION;
  if (!registering && typeof registrationOf !== 'function') throw new TypeError('verifyToken: registrationOf is needed on this endpoint');

  if (typeof token !== 'string') return refuse(401, 'token');
  const parts = token.split('.');
  if (parts.length !== 3) return refuse(401, 'token');
  const [headerPart, payloadPart, signaturePart] = /** @type {[string, string, string]} */ (parts);
  const header = jsonPart(headerPart);
  if (!header) return refuse(401, 'token');

  // 1. The algorithm, before any key is looked up.
  if (header.alg !== 'RS256') return refuse(401, 'alg');
  if (typeof header.kid !== 'string' || header.kid === '') return refuse(401, 'alg');

  // 2. The signature, with the key `kid` names in GitHub's set and no other.
  const found = await keys.keyOf(header.kid, now);
  if ('error' in found) return found.error === 'kid' ? refuse(401, 'kid') : refuse(503, 'jwks-unavailable');
  if (!PART.test(signaturePart)) return refuse(401, 'signature');
  /** @type {boolean} */
  let signed;
  try {
    signed = verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), found.key, Buffer.from(signaturePart, 'base64url'));
  } catch {
    signed = false;
  }
  if (!signed) return refuse(401, 'signature');
  const c = jsonPart(payloadPart);
  if (!c) return refuse(401, 'token');

  // 3. The issuer, compared whole.
  if (c.iss !== ISSUER) return refuse(401, 'iss');

  // 4. The audience: the store's own, as a string or the one element of an array.
  const aud = Array.isArray(c.aud) && c.aud.length === 1 ? c.aud[0] : c.aud;
  if (aud !== audience) return refuse(401, 'aud');

  // 5. The times: integers, within the skew, and no older than the maximum age.
  const t = now / 1000;
  const { exp, nbf, iat } = c;
  if (!Number.isInteger(exp) || !Number.isInteger(nbf) || !Number.isInteger(iat)) return refuse(401, 'time');
  if (!(/** @type {number} */ (exp) > t - SKEW_SECONDS)) return refuse(401, 'time');
  if (!(/** @type {number} */ (nbf) <= t + SKEW_SECONDS)) return refuse(401, 'time');
  if (!(/** @type {number} */ (iat) <= t + SKEW_SECONDS)) return refuse(401, 'time');
  if (!(/** @type {number} */ (iat) >= t - MAX_AGE_SECONDS)) return refuse(401, 'time');

  // 6. The trigger, from an allow-list.
  const eventName = c.event_name;
  if (typeof eventName !== 'string' || !EVENTS.includes(eventName)) return refuse(403, 'event');

  // 7. Kanon's own workflow for this endpoint, at a release tag at or above the floor.
  const workflowRef = typeof c.job_workflow_ref === 'string' ? JOB_WORKFLOW_REF.exec(c.job_workflow_ref) : null;
  if (!workflowRef) return refuse(403, 'workflow');
  const [, workflow, version] = /** @type {[string, string, string]} */ (/** @type {unknown} */ (workflowRef));
  if (!ENDPOINT_WORKFLOWS[/** @type {keyof typeof ENDPOINT_WORKFLOWS} */ (endpoint)].includes(workflow)) return refuse(403, 'workflow');
  if (!atLeast(version, minTokenVersion)) return refuse(403, 'workflow');

  // 8. The repository and its owner, by id; on every endpoint but registration, its registration.
  const repositoryId = c.repository_id;
  const ownerId = c.repository_owner_id;
  if (typeof repositoryId !== 'string' || !ID.test(repositoryId)) return refuse(403, 'owner');
  if (typeof ownerId !== 'string' || !ID.test(ownerId)) return refuse(403, 'owner');
  /** @type {Registration | undefined} */
  let registration;
  if (!registering) {
    registration = (await /** @type {NonNullable<typeof registrationOf>} */ (registrationOf)(repositoryId)) ?? undefined;
    if (!registration) return refuse(404, 'not-registered');
    if (registration.repository_owner_id !== ownerId) return refuse(403, 'owner');
  }

  // 9. A branch, and on every endpoint but registration, the registration's default branch.
  const ref = c.ref;
  if (c.ref_type !== 'branch') return refuse(403, 'ref');
  if (typeof ref !== 'string' || !BRANCH_REF.test(ref)) return refuse(403, 'ref');
  let refMoved = false;
  const tombstone = registration?.status === 'erased' && registration.key === undefined && registration.default_ref === undefined;
  if (registration && !tombstone) {
    if (typeof registration.default_ref !== 'string') return refuse(403, 'ref');
    if (ref !== registration.default_ref) {
      if (eventName !== 'schedule') return refuse(403, 'ref');
      refMoved = true;
    }
  }

  return {
    ok: true,
    // `repository` is not checked: it names the sender's words for its name hashes (§3.4), nothing more.
    caller: {
      repository_id: repositoryId, repository_owner_id: ownerId, ref, event_name: eventName, workflow, version,
      repository: typeof c.repository === 'string' ? c.repository : null,
    },
    registration,
    ref_moved: refMoved,
  };
}
