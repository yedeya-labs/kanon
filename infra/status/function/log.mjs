// The hosted status server's log (project #1327, Issue H, `[MCP-8]`): one JSON line per request,
// and only these fields: the route, the MCP method, the tool, the outcome, the duration, the
// number of GitHub requests and GitHub's remaining rate limit.
//
// EVERY VALUE IS FROM A CLOSED LIST OR A NUMBER. A route, a method or a tool the server doesn't
// know is `other`, so a client's own text never reaches the log; nor does a token, a login, an
// error's message or anything GitHub answered, because no field can hold one.

import { METHODS, TOOLS } from './index.mjs';

/** The fields of a line, in order. */
export const FIELDS = ['route', 'method', 'tool', 'outcome', 'durationMs', 'githubRequests', 'rateLimitRemaining'];

/** The server's routes, as a line names them. */
export const ROUTES = ['/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/register', '/authorize', '/callback', '/token', 'other'];

/**
 * What a request came to: `ok`; at `/mcp`, `tool_error`, `rpc_error`, `refused` (the transport's
 * 4xx), `unauthenticated` (no credential) or `invalid_token`; at the sign-in's routes, `denied`
 * (the person pressed Deny) or OAuth's error code; and `error`, for one the server failed.
 */
export const OUTCOMES = [
  'ok', 'tool_error', 'rpc_error', 'refused', 'unauthenticated', 'invalid_token', 'denied',
  'invalid_request', 'invalid_client', 'invalid_grant', 'unsupported_grant_type', 'unsupported_response_type',
  'invalid_target', 'invalid_redirect_uri', 'invalid_client_metadata', 'access_denied', 'not_found', 'error', 'other',
];

const KNOWN_METHODS = [...Object.keys(METHODS), 'notification', 'response'];
const KNOWN_TOOLS = TOOLS.map((t) => t.name);

/** A count, or null. @param {unknown} n */
const count = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null);

/**
 * One request's line.
 * @param {{ route?: unknown, method?: unknown, tool?: unknown, outcome?: unknown, durationMs?: unknown, githubRequests?: unknown, rateLimitRemaining?: unknown }} note
 */
export function logLine({ route, method, tool, outcome, durationMs, githubRequests, rateLimitRemaining }) {
  const prm = typeof route === 'string' && route.startsWith('/.well-known/oauth-protected-resource') ? '/.well-known/oauth-protected-resource' : route;
  return JSON.stringify({
    route: ROUTES.includes(/** @type {string} */ (prm)) ? prm : 'other',
    method: method === null || method === undefined ? null : KNOWN_METHODS.includes(/** @type {string} */ (method)) ? method : 'other',
    tool: tool === null || tool === undefined ? null : KNOWN_TOOLS.includes(/** @type {string} */ (tool)) ? tool : 'other',
    outcome: OUTCOMES.includes(/** @type {string} */ (outcome)) ? outcome : 'other',
    durationMs: count(durationMs) ?? 0,
    githubRequests: count(githubRequests) ?? 0,
    rateLimitRemaining: count(rateLimitRemaining),
  });
}

/**
 * The method and the tool an `/mcp` request names, for its line: a notification and a client's
 * response by their kind, and anything else as it parses, `logLine` closing the list.
 * @param {string} body
 * @returns {{ method: string | null, tool: string | null }}
 */
export function labelsOf(body) {
  /** @type {any} */
  let m;
  try {
    m = JSON.parse(body);
  } catch {
    return { method: null, tool: null };
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return { method: null, tool: null };
  if (typeof m.method !== 'string') return { method: Object.hasOwn(m, 'id') ? 'response' : null, tool: null };
  if (!Object.hasOwn(m, 'id')) return { method: 'notification', tool: null };
  return { method: m.method, tool: m.method === 'tools/call' && typeof m.params?.name === 'string' ? m.params.name : null };
}
