// The telemetry store's token path, as Kanon's lanes call it (plan 0008 §2.1, §3, step J5): which
// store a job talks to, and a request to it carrying a fresh GitHub OIDC token.
//
// THE URL IS FIXED WITH THE AUDIENCE (§2.1). The hosted store's URLs are constants here, and a
// token minted for the hosted audience is only ever sent to them. A self-hosted store (`K-OBS-18`)
// is named by a URL and an audience together, never one without the other, and never with the
// hosted audience: so no input can point a token minted for Kanon's store at another host.
//
// THE HOSTED URLS WERE PUBLISHED ON 2026-10-16 (Owner decision 10 of 2026-10-12): they went into
// the public tree only once both functions' reserved concurrency was in place. An empty value is
// what a release from before then holds: there a job with no URL of its own says the hosted store
// isn't published and sends nothing, as the collector skipped before its variables were set.
//
// A FRESH TOKEN PER REQUEST (§2.1), from the runner's OIDC endpoint (`ACTIONS_ID_TOKEN_REQUEST_URL`
// with `&audience=`, which is what `core.getIDToken(audience)` calls), so each one is well inside
// its lifetime whatever a sweep's length. The token is registered with `::add-mask::` before
// anything else can print, and is never logged, written to a file or returned to a caller.
//
// `node:` built-ins only (`K-SELF-8`).

/** The title of the collector's annotation for a store's refusal, which `kanon doctor` reads (`telemetry.refused`). */
export const REFUSED_TITLE = 'telemetry-refused';
/**
 * The collect job's name while the hosted URL below is unpublished and the caller names no store
 * of its own (#843): the run skips, green, so `telemetry-collect.mjs` never takes it as a
 * watermark, and `kanon doctor` reads it (`telemetry.unpublished`). Here rather than there, as
 * `REFUSED_TITLE` is, so the CLI imports no more of the collector than these names.
 */
export const UNPUBLISHED_JOB = 'Collect telemetry rows (hosted store unpublished)';

/** The hosted store's audience (plan 0008 §5.1, Owner decision 3 of 2026-10-10). */
export const HOSTED_AUDIENCE = 'kanon-telemetry';
/**
 * The hosted ingest function's token URL, the `live` alias's (`IngestTokenUrl`), published on
 * 2026-10-16 after the store's first deploy through the operator's deployment lane, with reserved
 * concurrency in place first (Owner decision 10 of 2026-10-12;
 * docs/telemetry.md, "Publish the hosted URLs").
 * @type {string}
 */
export const HOSTED_INGEST_URL = 'https://doepcoqbpivm2b7x2rxiwitsn40tawde.lambda-url.eu-central-1.on.aws/';
/**
 * The hosted aggregate function's token URL (`AggregateTokenUrl`), published with the ingest URL.
 * @type {string}
 */
export const HOSTED_AGGREGATE_URL = 'https://swfz3z5qop5g7zcpole6xegf540ukewv.lambda-url.eu-central-1.on.aws/';

/** An audience as a store's `Audience` parameter takes it: a short token, never a URL. */
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A function URL, `https://<id>.lambda-url.<region>.on.aws/`, and nothing else: no path, query,
 * fragment or credentials.
 * @param {string} url
 */
export function isFunctionUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.search && !u.hash && !u.username && !u.password && (u.pathname === '/' || u.pathname === '')
      && /^[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws$/.test(u.host);
  } catch {
    return false;
  }
}

/**
 * @typedef {{ ok: true, url: string, audience: string, hosted: boolean }} Store
 * @typedef {{ ok: false, unpublished: true, why: string }} Unpublished
 * @typedef {{ ok: false, unpublished?: false, why: string }} Refused
 */

/**
 * The store a job talks to: the hosted one when neither `url` nor `audience` is given, or the
 * self-hosted one they name together. Refused, before any token is minted, when only one is
 * given, when the URL isn't a function URL, or when a URL of its own is paired with the hosted
 * audience. `hostedUrl` is the hosted constant for the function being called.
 * @param {{ url?: string, audience?: string, hostedUrl: string, names?: { url: string, audience: string } }} o
 * @returns {Store | Unpublished | Refused}
 */
export function storeOf({ url = '', audience = '', hostedUrl, names = { url: 'url', audience: 'audience' } }) {
  const u = url.trim();
  const a = audience.trim();
  if (!u && !a) {
    if (!hostedUrl) return { ok: false, unpublished: true, why: "the hosted store's URL is not published in this release of Kanon yet, so nothing is sent (docs/telemetry.md, \"Publish the hosted URLs\")" };
    return { ok: true, url: hostedUrl, audience: HOSTED_AUDIENCE, hosted: true };
  }
  if (!u || !a) return { ok: false, why: `\`${names.url}\` and \`${names.audience}\` name a self-hosted store together, and only \`${u ? names.url : names.audience}\` is given: give both, or neither for Kanon's hosted store (docs/telemetry.md)` };
  if (!isFunctionUrl(u)) return { ok: false, why: `\`${names.url}\` is not a function URL (https://<id>.lambda-url.<region>.on.aws/): give the self-hosted stack's token URL` };
  if (!AUDIENCE.test(a)) return { ok: false, why: `\`${names.audience}\` is not an audience (letters, digits, \`.\`, \`_\` and \`-\`, up to 64): give the self-hosted stack's \`Audience\` parameter` };
  // The hosted audience goes to the hosted URL only: a token minted for Kanon's store is never
  // pointed at another host by an input (§2.1).
  if (a === HOSTED_AUDIENCE && u !== hostedUrl) return { ok: false, why: `\`${names.audience}\` is the hosted store's, \`${HOSTED_AUDIENCE}\`, which is only ever sent to the hosted store's URL: a self-hosted store has an audience of its own` };
  return { ok: true, url: u, audience: a, hosted: u === hostedUrl && a === HOSTED_AUDIENCE };
}

export class TokenError extends Error {}

/**
 * A fresh OIDC token for `audience`, registered with `mask` before it is returned. Throws
 * `TokenError` naming why, never with the token or the request's credentials in it.
 * @param {string} audience
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask: (secret: string) => void }} io
 */
export async function mintToken(audience, { env, fetchImpl = fetch, mask }) {
  const at = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!at || !bearer) throw new TokenError('the job holds no OIDC token: it needs `id-token: write`, from its caller too');
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(`${at}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' } });
  } catch (e) {
    throw new TokenError(`the runner's OIDC endpoint could not be reached (${e instanceof Error ? e.name : 'error'})`);
  }
  if (res.status !== 200) throw new TokenError(`the runner's OIDC endpoint answered ${res.status}`);
  /** @type {unknown} */
  let value;
  try {
    value = /** @type {{ value?: unknown }} */ (JSON.parse(await res.text())).value;
  } catch {
    throw new TokenError("the runner's OIDC endpoint answered something that is not JSON");
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value)) throw new TokenError("the runner's OIDC endpoint gave no token");
  // MASKED FIRST: from here every line of the job prints `***` in its place.
  mask(value);
  return value;
}

/** The runner's own mask: a workflow command, which the runner consumes and never prints. @param {string} secret */
export const runnerMask = (secret) => {
  process.stdout.write(`::add-mask::${secret}\n`);
};

/**
 * @typedef {{ status: number, json: any, retryAfter: string | null }} Answer
 */

/**
 * One request to the store with a fresh token: `method` on `path` below the store's URL, with a
 * JSON body when one is given. The answer's JSON is null when it isn't JSON; its text is never
 * returned or printed.
 * @param {Store} store
 * @param {{ method: 'GET' | 'POST' | 'DELETE', path: string, query?: Record<string, string>, body?: unknown }} req
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (secret: string) => void }} io
 * @returns {Promise<Answer>}
 */
export async function storeRequest(store, req, { env, fetchImpl = fetch, mask = runnerMask }) {
  const token = await mintToken(store.audience, { env, fetchImpl, mask });
  const target = new URL(req.path, store.url.endsWith('/') ? store.url : `${store.url}/`);
  for (const [k, v] of Object.entries(req.query ?? {})) target.searchParams.set(k, v);
  /** @type {Record<string, string>} */
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const init = req.body === undefined ? { method: req.method, headers } : { method: req.method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(req.body) };
  const res = await fetchImpl(target.toString(), init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An answer that isn't JSON is judged by its status alone; its body is never printed.
  }
  return { status: res.status, json, retryAfter: res.headers?.get?.('retry-after') ?? null };
}

/** An error code from the store's closed list, or null: never a value from the answer. @param {any} json */
export const codeOf = (json) => (typeof json?.error === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(json.error) ? json.error : null);
