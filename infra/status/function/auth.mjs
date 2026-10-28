// The hosted status server's sign-in (project #1327, Issue H): `serve`, which wraps `handle`. The
// server is the MCP resource and its own OAuth 2.1 authorisation server, in front of Kanon's
// status App's user-to-server flow on GitHub (decision 1's option (a)), as the MCP authorisation
// specification at the server's protocol version asks: protected-resource metadata (RFC 9728),
// authorisation-server metadata (RFC 8414), dynamic client registration (RFC 7591), and PKCE.
//
// IT STORES NOTHING (`[MCP-3]`, `[MCP-6]`). Every piece of state the flow needs is sealed under
// the server's KMS key (`seal.mjs`) and carried by whoever holds it: the client id is the sealed
// registration, the consent form and the state sent to GitHub are sealed, and so are the code and
// the tokens. A person's GitHub tokens exist only inside the access and refresh tokens it issues.
// Single use, which OAuth asks of a code and which normally takes a store, is GitHub's: our code
// wraps GitHub's code, exchanged only when ours is, and GitHub refuses its own code a second time;
// our refresh token wraps GitHub's, which GitHub rotates and refuses a second time.
//
// ONLY THE PERSON'S OWN TOKEN (`[MCP-5]`). A request to `/mcp` is served only with a bearer that
// opens as an access token this server issued, for this resource, and unexpired (`[MCP-4]`), and
// its reads carry the GitHub token inside it, the one GitHub issued for that person's sign-in.
// The server holds no App key and mints no installation token. When GitHub refuses the person's
// token (they revoked the App's authorisation), the answer is 401, so the client signs in again.
//
// CONSENT, EVERY TIME. GitHub shows no screen to a person who has authorised the App already, so
// the server shows its own before anything goes to GitHub, naming the client and where its answer
// goes, as the specification asks of a server with one upstream client id. A redirect must be on
// the allow-list (`redirects`, the template's parameter), the Allow must be posted from the page
// itself (its `Origin`), and the callback must come back to the browser that pressed it (a
// `__Host-` cookie whose hash the sealed state carries).
//
// THE LOG (`[MCP-8]`). One line per request, `log.mjs`'s, of closed lists and numbers. Any
// failure inside the server is caught here and logged as `error`, with nothing of the failure.
//
// THE DEPRECATED REVISION (`[MCP-1]`, #1423). `/mcp`'s 401 to a request at 2025-11-25 carries the
// deprecation's headers, as every answer `handle` gives at that revision does.
//
// `node:` built-ins only (decision 11).

import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { URL, URLSearchParams } from 'node:url';
import { readCache } from './cache.mjs';
import { MCP_PATH, appReaches, bodyOf, deprecationHeaders, eraOf, handle } from './index.mjs';
import { labelsOf, logLine } from './log.mjs';
import { GITHUB_API, fetchReader } from './reader.mjs';

/** How long each sealed value lives, in seconds, as docs/status.md's "Token lifetimes" states. */
export const LIFETIMES = { code: 60, consent: 600, state: 600, access: 3600, refresh: 30 * 86_400 };

/**
 * The redirects a client may register, when the template names none: Claude's connector
 * callbacks, for claude.ai and the Claude apps, and any port on the loopback, for Claude Code. An
 * entry ending `:*` takes any port and any path; any other must match exactly.
 */
export const DEFAULT_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'http://localhost:*', 'http://127.0.0.1:*'];

/** The sign-in's routes. */
export const PATHS = {
  resource: '/.well-known/oauth-protected-resource',
  server: '/.well-known/oauth-authorization-server',
  register: '/register',
  authorize: '/authorize',
  callback: '/callback',
  token: '/token',
};

/** GitHub, where the person signs in. */
export const GITHUB = 'https://github.com';

/** The cookie that ties the callback to the browser that pressed Allow. */
const COOKIE = '__Host-kanon-status-flow';

/** A container's cache, kept while the container is warm. */
const CONTAINER_CACHE = readCache();

/**
 * The allow-list, from the template's parameter: comma-separated, or the defaults when it names none.
 * @param {string | undefined | null} text
 */
export const redirectsFrom = (text) => (text?.trim() ? text.split(',').map((s) => s.trim()).filter(Boolean) : [...DEFAULT_REDIRECTS]);

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Is `uri` on the allow-list? @param {unknown} uri @param {string[]} allowed */
export function redirectAllowed(uri, allowed) {
  if (typeof uri !== 'string' || uri.length > 512) return false;
  return allowed.some((p) => (p.endsWith(':*') ? new RegExp(`^${escapeRe(p.slice(0, -2))}:\\d{1,5}(?:/[^?#\\s]*)?$`).test(uri) : uri === p));
}

/**
 * @typedef {{
 *   clientId: string, clientSecret: string,
 *   sealer: import('./seal.mjs').Sealer,
 *   redirects?: string[],
 *   origin?: string,
 *   fetch?: typeof fetch,
 *   cache?: ReturnType<typeof readCache>,
 *   log?: (line: string) => void,
 *   now?: () => Date,
 *   release?: string,
 *   deprecated?: string | null,
 *   api?: string, github?: string,
 * }} ServeDeps the status App's OAuth client; the sealer; the redirect allow-list; the server's
 *   own origin, when it isn't the function URL's; the date 2025-11-25 was deprecated, `YYYY-MM-DD`,
 *   as the deploy names it; and what tests replace
 * @typedef {import('./index.mjs').Reply & { cookies?: string[] }} Reply
 * @typedef {{ route: string, method: string | null, era?: string | null, tool: string | null, outcome: string }} Note
 */

/** @param {number} statusCode @param {unknown} body @param {Record<string, string>} [headers] @returns {Reply} */
const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) });

/** @type {Record<string, string>} */
const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text, safe in HTML's text and in a quoted attribute. @param {string} s */
const html = (s) => s.replace(/[&<>"']/g, (c) => ENTITY[c] ?? c);

/**
 * A page, for the person's browser. Its referrer policy is `same-origin`, never `no-referrer`: a
 * form the page posts takes the page's policy, and under `no-referrer` the browser sends the POST
 * with `Origin: null` (the Fetch standard's "append a request `Origin` header"), which the Allow's
 * origin check refuses. `same-origin` keeps the real `Origin` on the post to this server, and
 * sends no referrer anywhere else.
 * @param {number} statusCode @param {string} title @param {string} inner @returns {Reply}
 */
const page = (statusCode, title, inner) => ({
  statusCode,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
  },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)}</title>`
    + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem}.warn{background:#fff4e5;padding:.75rem;border-radius:.25rem}</style>'
    + `</head><body><h1>${html(title)}</h1>${inner}</body></html>`,
});

/** A redirect to `uri`, with `params` added to its query. @param {string} uri @param {Record<string, string | null>} params @param {string[]} [cookies] @returns {Reply} */
const redirect = (uri, params, cookies) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return { statusCode: 302, headers: { location: u.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '', ...(cookies ? { cookies } : {}) };
};

/** An OAuth error. @param {string} error @param {string} description @param {number} [status] */
const oauthError = (error, description, status = 400) => json(status, { error, error_description: description });

/** @param {string} s */
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('base64url');
const random = (/** @type {number} */ n) => randomBytes(n).toString('base64url');
/** Unix seconds. @param {Date} d */
const seconds = (d) => Math.floor(d.getTime() / 1000);

/**
 * One parameter, or null when it is missing or repeated (OAuth's parameters are sent once).
 * @param {URLSearchParams} params @param {string} name
 */
const one = (params, name) => {
  const all = params.getAll(name);
  return all.length === 1 ? /** @type {string} */ (all[0]) : null;
};

/**
 * The server: one function URL event in, one reply out, and one log line.
 * @param {any} event a function URL event (payload 2.0)
 * @param {ServeDeps} deps
 * @returns {Promise<Reply>}
 */
export async function serve(event, deps) {
  const started = performance.now();
  /** @type {import('./reader.mjs').Stats} */
  const stats = { requests: 0, rateLimitRemaining: null, unauthorized: false };
  const route = String(event?.rawPath ?? event?.requestContext?.http?.path ?? '');
  /** @type {Note} */
  const note = { route, method: null, tool: null, outcome: 'error' };
  /** @type {Reply} */
  let reply;
  try {
    reply = await routeOf(event, deps, stats, note);
  } catch {
    note.outcome = 'error';
    reply = json(500, { error: 'server_error' });
  }
  (deps.log ?? ((/** @type {string} */ line) => console.log(line)))(logLine({ ...note, durationMs: performance.now() - started, githubRequests: stats.requests, rateLimitRemaining: stats.rateLimitRemaining }));
  return reply;
}

/**
 * @param {any} event @param {ServeDeps} deps @param {import('./reader.mjs').Stats} stats @param {Note} note
 * @returns {Promise<Reply>}
 */
async function routeOf(event, deps, stats, note) {
  const now = deps.now ?? (() => new Date());
  const origin = (deps.origin ?? `https://${event?.requestContext?.domainName}`).replace(/\/+$/, '');
  const resource = `${origin}${MCP_PATH}`;
  const headers = Object.fromEntries(Object.entries(event?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const method = String(event?.requestContext?.http?.method ?? '');
  const path = note.route;
  const allowed = deps.redirects ?? DEFAULT_REDIRECTS;
  const fetchImpl = deps.fetch ?? fetch;
  const github = deps.github ?? GITHUB;
  const metadata = `${origin}${PATHS.resource}${MCP_PATH}`;

  const seal = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ payload, /** @type {number | null} */ life) =>
    deps.sealer.seal(kind, resource, payload, life === null ? null : seconds(now()) + life);
  const open = (/** @type {string} */ kind, /** @type {unknown} */ sealed) => deps.sealer.open(kind, resource, sealed, seconds(now()));
  const done = (/** @type {string} */ outcome, /** @type {Reply} */ r) => {
    note.outcome = outcome;
    return r;
  };
  const query = new URLSearchParams(String(event?.rawQueryString ?? ''));
  const formOf = () => new URLSearchParams(bodyOf(event));

  // ---------------------------------------------------------------- the MCP endpoint
  if (path === MCP_PATH) {
    const deprecated = deps.deprecated ?? null;
    const challenge = (/** @type {boolean} */ invalid) => ({
      statusCode: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${metadata}"${invalid ? ', error="invalid_token"' : ''}`,
        ...(eraOf(event) === 'legacy' ? deprecationHeaders(deprecated) : {}),
      },
      body: JSON.stringify({ error: invalid ? 'invalid_token' : 'unauthorized' }),
    });
    const bearer = /^Bearer +(\S+)$/i.exec(headers.authorization ?? '')?.[1];
    if (!bearer) return done('unauthenticated', challenge(false));
    const access = await open('access', bearer);
    if (!access || typeof access.gh !== 'string') return done('invalid_token', challenge(true));
    Object.assign(note, labelsOf(bodyOf(event)), { era: eraOf(event) });
    const cache = deps.cache ?? CONTAINER_CACHE;
    const reader = fetchReader({ token: access.gh, fetch: fetchImpl, api: deps.api ?? GITHUB_API, cache: cache.for(access.gh), stats });
    const reply = await handle(event, { reader, now, release: deps.release ?? 'unreleased', reach: (repo) => appReaches(reader, repo), deprecated });
    if (stats.unauthorized) return done('invalid_token', challenge(true));
    return done(outcomeOf(reply), reply);
  }

  // ---------------------------------------------------------------- the metadata
  if (path === PATHS.resource || path === `${PATHS.resource}${MCP_PATH}`) {
    if (method !== 'GET') return done('refused', { statusCode: 405, headers: { allow: 'GET' }, body: '' });
    return done('ok', json(200, { resource, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Kanon status' }, { 'cache-control': 'max-age=3600' }));
  }
  if (path === PATHS.server) {
    if (method !== 'GET') return done('refused', { statusCode: 405, headers: { allow: 'GET' }, body: '' });
    return done('ok', json(200, {
      issuer: origin,
      authorization_endpoint: `${origin}${PATHS.authorize}`,
      token_endpoint: `${origin}${PATHS.token}`,
      registration_endpoint: `${origin}${PATHS.register}`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    }, { 'cache-control': 'max-age=3600' }));
  }

  // ---------------------------------------------------------------- registration (RFC 7591)
  if (path === PATHS.register) {
    if (method !== 'POST') return done('refused', { statusCode: 405, headers: { allow: 'POST' }, body: '' });
    /** @type {any} */
    let meta;
    try {
      meta = JSON.parse(bodyOf(event));
    } catch {
      return done('invalid_client_metadata', oauthError('invalid_client_metadata', 'the registration is not JSON'));
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return done('invalid_client_metadata', oauthError('invalid_client_metadata', 'the registration is a JSON object'));
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) return done('invalid_redirect_uri', oauthError('invalid_redirect_uri', 'a client registers between one and ten redirect URIs'));
    if (!uris.every((u) => redirectAllowed(u, allowed))) return done('invalid_redirect_uri', oauthError('invalid_redirect_uri', "a redirect URI isn't one this server sends a sign-in to"));
    if (meta.token_endpoint_auth_method !== undefined && meta.token_endpoint_auth_method !== 'none') return done('invalid_client_metadata', oauthError('invalid_client_metadata', 'only public clients register: token_endpoint_auth_method is none'));
    if (meta.grant_types !== undefined && !(Array.isArray(meta.grant_types) && meta.grant_types.every((/** @type {unknown} */ g) => g === 'authorization_code' || g === 'refresh_token'))) return done('invalid_client_metadata', oauthError('invalid_client_metadata', 'the grant types are authorization_code and refresh_token'));
    if (meta.response_types !== undefined && !(Array.isArray(meta.response_types) && meta.response_types.every((/** @type {unknown} */ r) => r === 'code'))) return done('invalid_client_metadata', oauthError('invalid_client_metadata', 'the response type is code'));
    const name = typeof meta.client_name === 'string' ? meta.client_name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100) : '';
    const client = { cid: random(16), name, redirects: uris };
    const client_id = await seal('client', client, null);
    return done('ok', json(201, {
      client_id,
      client_id_issued_at: seconds(now()),
      ...(name ? { client_name: name } : {}),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }));
  }

  // ---------------------------------------------------------------- the client's request, and consent
  if (path === PATHS.authorize && method === 'GET') {
    const client = await open('client', one(query, 'client_id'));
    if (!client) return done('invalid_client', page(400, 'Sign-in refused', "<p>The program asking you to sign in isn't registered with this server. Start again from it.</p>"));
    const to = one(query, 'redirect_uri');
    if (!to || !client.redirects.includes(to) || !redirectAllowed(to, allowed)) return done('invalid_request', page(400, 'Sign-in refused', "<p>The program asked to send your sign-in somewhere it didn't register. Start again from it.</p>"));
    const state = one(query, 'state');
    const back = (/** @type {string} */ error, /** @type {string} */ description) => done(error, redirect(to, { error, error_description: description, state, iss: origin }));
    if (one(query, 'response_type') !== 'code') return back('unsupported_response_type', 'the response type is code');
    const challenge = one(query, 'code_challenge');
    if (one(query, 'code_challenge_method') !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back('invalid_request', 'PKCE with S256 is required');
    const asked = query.getAll('resource');
    if (asked.length > 1 || (asked.length === 1 && asked[0] !== resource)) return back('invalid_target', `this server's one resource is ${resource}`);
    const consent = await seal('consent', { cid: client.cid, redirect: to, state, challenge }, LIFETIMES.consent);
    const where = new URL(to);
    const loopback = where.hostname === 'localhost' || where.hostname === '127.0.0.1';
    const who = client.name ? `<strong>${html(client.name)}</strong>` : 'A program';
    return done('ok', page(200, 'Sign in to Kanon status', [
      `<p>${who} asks to read Kanon status as you: what you can already read on GitHub, in repositories where Kanon's status App is installed. It can't write anything.</p>`,
      `<p>Your sign-in will be sent to <strong>${html(where.host)}</strong>.</p>`,
      loopback ? `<p class="warn">That is a program on this computer. Allow it only if you started it just now, such as Claude Code.</p>` : '',
      `<form method="post" action="${PATHS.authorize}"><input type="hidden" name="consent" value="${html(consent)}">`,
      '<button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Deny</button></form>',
      '<p>Next, GitHub signs you in with Kanon\'s status App.</p>',
    ].join('')));
  }

  // ---------------------------------------------------------------- the person's answer
  if (path === PATHS.authorize && method === 'POST') {
    const from = headers.origin ?? (headers['sec-fetch-site'] === 'same-origin' ? origin : null);
    if (from !== origin) return done('access_denied', page(403, 'Sign-in refused', '<p>That answer didn\'t come from this server\'s own page. Start again from the program you are signing in to.</p>'));
    const form = formOf();
    const consent = await open('consent', one(form, 'consent'));
    if (!consent || !redirectAllowed(consent.redirect, allowed)) return done('invalid_request', page(400, 'Sign-in expired', '<p>This sign-in has expired. Start again from the program you are signing in to.</p>'));
    if (one(form, 'decision') !== 'allow') return done('denied', redirect(consent.redirect, { error: 'access_denied', error_description: 'the person declined', state: consent.state, iss: origin }));
    const verifier = random(32);
    const nonce = random(24);
    const upstream = await seal('state', { ...consent, verifier, nonce: sha256(nonce) }, LIFETIMES.state);
    return done('ok', redirect(`${github}/login/oauth/authorize`, {
      client_id: deps.clientId,
      redirect_uri: `${origin}${PATHS.callback}`,
      state: upstream,
      code_challenge: sha256(verifier),
      code_challenge_method: 'S256',
    }, [`${COOKIE}=${nonce}; Max-Age=${LIFETIMES.state}; Path=/; Secure; HttpOnly; SameSite=Lax`]));
  }

  // ---------------------------------------------------------------- GitHub's answer
  if (path === PATHS.callback) {
    if (method !== 'GET') return done('refused', { statusCode: 405, headers: { allow: 'GET' }, body: '' });
    const state = await open('state', one(query, 'state'));
    if (!state) return done('invalid_request', page(400, 'Sign-in expired', '<p>This sign-in has expired. Start again from the program you are signing in to.</p>'));
    const cookie = cookiesOf(event)[COOKIE];
    if (!cookie || sha256(cookie) !== state.nonce) return done('invalid_request', page(400, 'Sign-in refused', "<p>This sign-in didn't start in this browser. Start again from the program you are signing in to.</p>"));
    const clear = [`${COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`];
    const code = one(query, 'code');
    if (query.has('error') || !code) return done('access_denied', redirect(state.redirect, { error: 'access_denied', error_description: 'GitHub did not sign the person in', state: state.state, iss: origin }, clear));
    const ours = await seal('code', { cid: state.cid, redirect: state.redirect, challenge: state.challenge, gh: code, verifier: state.verifier }, LIFETIMES.code);
    return done('ok', redirect(state.redirect, { code: ours, state: state.state, iss: origin }, clear));
  }

  // ---------------------------------------------------------------- the token endpoint
  if (path === PATHS.token) {
    if (method !== 'POST') return done('refused', { statusCode: 405, headers: { allow: 'POST' }, body: '' });
    const form = formOf();
    const grant = one(form, 'grant_type');
    const fail = (/** @type {string} */ error, /** @type {string} */ description, status = 400) => done(error, oauthError(error, description, status));
    if (grant !== 'authorization_code' && grant !== 'refresh_token') return fail('unsupported_grant_type', 'the grant types are authorization_code and refresh_token');
    const client = await open('client', one(form, 'client_id'));
    if (!client) return fail('invalid_client', "the client isn't registered with this server", 401);
    const asked = form.getAll('resource');
    if (asked.length > 1 || (asked.length === 1 && asked[0] !== resource)) return fail('invalid_target', `this server's one resource is ${resource}`);

    /** @type {Record<string, string>} */
    let upstream;
    if (grant === 'authorization_code') {
      const code = await open('code', one(form, 'code'));
      if (!code || code.cid !== client.cid || one(form, 'redirect_uri') !== code.redirect) return fail('invalid_grant', "the code isn't valid for this client and redirect, or has expired");
      const verifier = one(form, 'code_verifier');
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || sha256(verifier) !== code.challenge) return fail('invalid_grant', "the code verifier doesn't match the code's challenge");
      upstream = { code: code.gh, redirect_uri: `${origin}${PATHS.callback}`, code_verifier: code.verifier };
    } else {
      const refresh = await open('refresh', one(form, 'refresh_token'));
      if (!refresh || refresh.cid !== client.cid) return fail('invalid_grant', "the refresh token isn't valid for this client, or has expired");
      upstream = { grant_type: 'refresh_token', refresh_token: refresh.gh };
    }
    stats.requests += 1;
    const res = await fetchImpl(`${github}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'kanon-status' },
      body: JSON.stringify({ client_id: deps.clientId, client_secret: deps.clientSecret, ...upstream }),
    });
    /** @type {any} */
    const gh = await res.json().catch(() => null);
    if (!res.ok || typeof gh?.access_token !== 'string' || !gh.access_token) return fail('invalid_grant', 'GitHub refused the grant: sign in again');

    const t = seconds(now());
    const ghExpires = Number.isFinite(gh.expires_in) ? t + Number(gh.expires_in) : Infinity;
    const accessExp = Math.min(t + LIFETIMES.access, ghExpires);
    /** @type {Record<string, unknown>} */
    const body = {
      access_token: await deps.sealer.seal('access', resource, { cid: client.cid, gh: gh.access_token }, accessExp),
      token_type: 'Bearer',
      expires_in: Math.max(0, accessExp - t),
    };
    if (typeof gh.refresh_token === 'string' && gh.refresh_token) {
      const refreshExp = Math.min(t + LIFETIMES.refresh, Number.isFinite(gh.refresh_token_expires_in) ? t + Number(gh.refresh_token_expires_in) : Infinity);
      body.refresh_token = await deps.sealer.seal('refresh', resource, { cid: client.cid, gh: gh.refresh_token }, refreshExp);
    }
    return done('ok', json(200, body, { pragma: 'no-cache' }));
  }

  return done('not_found', { statusCode: 404, headers: {}, body: '' });
}

/**
 * What an `/mcp` reply came to, for the log: 2026-07-28's method-not-found is a 404 with its
 * JSON-RPC error. @param {import('./index.mjs').Reply} reply
 */
function outcomeOf(reply) {
  if (reply.statusCode === 202) return 'ok';
  if (reply.statusCode !== 200 && reply.statusCode !== 404) return 'refused';
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(reply.body);
  } catch {
    return 'other';
  }
  if (body?.error) return 'rpc_error';
  if (reply.statusCode !== 200) return 'refused';
  return body?.result?.isError ? 'tool_error' : 'ok';
}

/**
 * A function URL event's cookies, by name: payload 2.0 puts them in `cookies`, and an older
 * shape in the `Cookie` header.
 * @param {any} event @returns {Record<string, string>}
 */
function cookiesOf(event) {
  const header = Object.entries(event?.headers ?? {}).find(([k]) => k.toLowerCase() === 'cookie')?.[1];
  const list = Array.isArray(event?.cookies) ? event.cookies : String(header ?? '').split(';');
  /** @type {Record<string, string>} */
  const out = {};
  for (const c of list) {
    const at = String(c).indexOf('=');
    if (at > 0) out[String(c).slice(0, at).trim()] = String(c).slice(at + 1).trim();
  }
  return out;
}
