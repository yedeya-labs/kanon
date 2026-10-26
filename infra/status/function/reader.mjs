// The hosted status server's reader (project #1327, Issue G): the status core's reader contract
// (`scripts/status/reader.mjs`) over `fetch`, holding the token of the person who asked. It is
// the only way the server reaches GitHub, and the core reads only through it.
//
// IT CAN ONLY READ (`[MCP-3]`, `[STAT-1]`). It asks three things, as every reader does: a REST
// `GET`, every page of one, and a GraphQL query, POSTed to GitHub's GraphQL endpoint, which is
// how GraphQL takes a query. A GraphQL document holding a mutation or a subscription is refused
// before anything is sent, and a next page is followed only on GitHub's API, so the token goes
// nowhere else.
//
// A FAILED READ IS A `ReadError` (`[STAT-3]`), as `ghReader`'s is: the read's name, GitHub's
// message, the HTTP status, and, when the rate limit is the cause, when it resets, from GitHub's
// own `x-ratelimit-reset` header. No answer's text is put in an error.
//
// WHERE THE TOKEN COMES FROM is not this file's. The server's authentication (`auth.mjs`) gives
// the person's own token to `fetchReader` per request; nothing here keeps it.
//
// CONDITIONAL, AND PER PERSON (`[MCP-9]`). Given the person's own cache (`cache.mjs`), every REST
// `GET` is still sent to GitHub, with the ETag of the answer it last got for that URL, and a 304
// serves that answer's body, which doesn't count against the person's rate limit. GraphQL is
// never cached. Each answer's body is parsed afresh, so a view can't change what the cache holds.
//
// WHAT IT COUNTS. `stats`, when given, counts the requests sent, keeps GitHub's last
// `x-ratelimit-remaining`, and notes a 401, which tells the server the person's token no longer
// opens GitHub (`[MCP-8]`, `[MCP-5]`).
//
// `node:` built-ins only (decision 11): `fetch` is Node's own.

import { RATE_LIMITED, ReadError, graphqlRead } from '../../../scripts/status/reader.mjs';

/** GitHub's REST and GraphQL API. */
export const GITHUB_API = 'https://api.github.com';

/** The REST API version the reads are written against. */
const API_VERSION = '2022-11-28';

/**
 * A GraphQL document that would write or subscribe: an operation definition, at the document's
 * top level, that isn't a query. Every definition but the first follows a `}`, so a mutation or
 * subscription starts the document or follows a `}`, with only ignored tokens between: white
 * space, line ends, commas and the byte-order mark (`\s` holds all but the comma). Strings and
 * comments are dropped first, as GraphQL reads them, so a word inside one doesn't count: a block
 * string's escaped `\"""` doesn't end it, and a comment ends at `\n` or `\r`.
 * @param {string} query
 */
const writes = (query) => /(^|\})[\s,]*(mutation|subscription)\b/.test(String(query).replace(/"""(?:\\"""|[\s\S])*?"""|"(?:\\.|[^"\\\n\r])*"|#[^\n\r]*/g, ''));

/** The `next` page's URL in a `Link` header, or null. @param {string | null} link */
const nextOf = (link) => /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;

/** @typedef {{ requests: number, rateLimitRemaining: number | null, unauthorized: boolean }} Stats */

/**
 * A reader over GitHub's API with `token`, the person's own.
 * @param {{ token: string, fetch?: typeof fetch, api?: string, cache?: import('./cache.mjs').PersonCache, stats?: Stats }} args
 * @returns {{ get: (path: string) => Promise<unknown>, pages: (path: string) => Promise<unknown[]>, graphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown> }}
 */
export function fetchReader({ token, fetch: fetchImpl = fetch, api = GITHUB_API, cache, stats }) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'kanon-status',
    'x-github-api-version': API_VERSION,
  };

  /**
   * One request: its parsed body and its `Link` header, or a `ReadError` naming `read`. A GET
   * carries the person's cached ETag for the URL, and a 304 answers with the cached body.
   * @param {string} read @param {string} url @param {RequestInit} [init]
   * @returns {Promise<{ body: any, link: string | null, res: Response }>}
   */
  const request = async (read, url, init = {}) => {
    const hit = !init.method && cache ? cache.get(url) : null;
    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(hit ? { 'if-none-match': hit.etag } : {}) } });
    } catch (e) {
      throw new ReadError(read, e instanceof Error ? e.message : String(e));
    }
    if (stats) {
      stats.requests += 1;
      const left = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
      if (res.headers.has('x-ratelimit-remaining') && Number.isFinite(left)) stats.rateLimitRemaining = left;
      if (res.status === 401) stats.unauthorized = true;
    }
    if (res.status === 304 && hit) return { body: JSON.parse(hit.text), link: hit.link, res };
    /** @type {string} */
    let text;
    /** @type {any} */
    let body;
    try {
      text = await res.text();
      body = JSON.parse(text);
    } catch {
      throw new ReadError(read, res.ok ? "the answer isn't JSON" : `HTTP ${res.status}`, { status: res.ok ? null : res.status });
    }
    if (!res.ok) {
      const why = typeof body?.message === 'string' && body.message ? body.message : `HTTP ${res.status}`;
      const limited = (res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || RATE_LIMITED.test(why));
      throw new ReadError(read, why, { status: res.status, resetAt: limited ? resetOf(res) : null });
    }
    const link = res.headers.get('link');
    const etag = res.headers.get('etag');
    if (!init.method && cache && etag) cache.put(url, { etag, text, link });
    return { body, link, res };
  };

  return {
    get: async (path) => (await request(`GET ${path}`, `${api}/${path}`)).body,
    pages: async (path) => {
      const read = `GET ${path}`;
      const pages = [];
      /** @type {string | null} */
      let url = `${api}/${path}`;
      while (url) {
        const { body, link } = await request(read, url);
        pages.push(body);
        url = nextOf(link);
        if (url && !url.startsWith(`${api}/`)) throw new ReadError(read, "a next page points off GitHub's API, so it isn't followed");
      }
      return pages;
    },
    graphql: async (query, variables = {}) => {
      if (writes(query)) throw new Error('the status core writes nothing: a GraphQL document it sends holds only queries');
      const read = graphqlRead(query);
      const { body, res } = await request(read, `${api}/graphql`, { method: 'POST', body: JSON.stringify({ query, variables }) });
      if (Array.isArray(body?.errors) && body.errors.length) {
        const why = body.errors.map((/** @type {{ message?: string }} */ e) => e?.message ?? 'an error').join('; ');
        const limited = res.headers.get('x-ratelimit-remaining') === '0' || body.errors.some((/** @type {{ type?: string }} */ e) => e?.type === 'RATE_LIMITED');
        throw new ReadError(read, why, { resetAt: limited ? resetOf(res) : null });
      }
      return body?.data;
    },
  };
}

/** When the exhausted limit resets, ISO 8601, from GitHub's header, or null. @param {Response} res */
function resetOf(res) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
}
