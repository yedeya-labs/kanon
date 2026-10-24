// The status core's one way to read GitHub (project #1327, `[STAT-1]`): a reader its caller
// passes in. The reader can ask three things, a REST `GET`, every page of a REST `GET`, and a
// GraphQL query, and nothing else, so no code that reads through it can write.
//
// THREE READERS, ONE CONTRACT. The CLI and the reconciler pass `ghReader()`, which runs
// `gh api` with the person's or the App's own credential. The hosted server passes one over
// `fetch` holding the person's token. The tests pass a recording reader, and assert on what
// was asked. Each method may answer synchronously or with a promise; the core awaits both.
//
// A FAILED READ IS A `ReadError`, naming the read and why (`[STAT-3]`): its HTTP status when
// there is one (404 is how a caller tells "not there" from "couldn't read"), and the rate
// limit's reset time when the limit is the cause. A read the core can't complete is never an
// empty answer: `watched` records every failure, so a view whose read was swallowed by a caller
// that tolerates it (the reconciler does, by design) still errors by name.

import { execFileSync } from 'node:child_process';

/**
 * @typedef {object} Reader
 * @property {(path: string) => unknown} get one REST `GET`, its parsed body; `path` is relative
 *   to the API's root, as `gh api` takes it, and may carry a query string
 * @property {(path: string) => unknown} pages every page of a REST `GET`, following `Link: next`,
 *   as an array of the pages' parsed bodies
 * @property {(query: string, variables?: Record<string, unknown>) => unknown} graphql one
 *   GraphQL query, its `data`; a response carrying `errors` is a failed read
 * @property {(failure: ReadError) => void} [failed] told of a read that answered, and that its
 *   caller found incomplete (a listing cut short); `watched` counts it as it counts a thrown one
 */

/** A read that couldn't complete: what was read, and why. */
export class ReadError extends Error {
  /**
   * @param {string} read what was read, e.g. `GET repos/o/r/releases`
   * @param {string} why the cause, as the API or the transport gave it
   * @param {{ status?: number | null, resetAt?: string | null }} [detail]
   */
  constructor(read, why, { status = null, resetAt = null } = {}) {
    super(`${read} failed: ${why}${resetAt ? ` (the rate limit resets at ${resetAt})` : ''}`);
    this.name = 'ReadError';
    this.read = read;
    this.why = why;
    /** The HTTP status, when there is one. */
    this.status = status;
    /** When the exhausted rate limit resets, ISO 8601, when that is the cause. */
    this.resetAt = resetAt;
    /** Set by a caller that reads this failure as an answer (a 404 read as "no such file"). */
    this.expected = false;
  }
}

/** Is this the API saying "not there", as opposed to "couldn't read"? @param {unknown} e */
export const isNotFound = (e) => e instanceof ReadError && e.status === 404;

/** A REST read's short name. @param {string} path */
const restRead = (path) => `GET ${path}`;

/** A GraphQL read's short name: the query's own name, or its first field. @param {string} query */
export const graphqlRead = (query) => `GraphQL ${/query\s+(\w+)/.exec(query)?.[1] ?? /{\s*(\w+)/.exec(query)?.[1] ?? 'query'}`;

/** A rate limit, as GitHub words one in a REST message or a GraphQL error. */
const RATE_LIMITED = /rate limit|RATE_LIMITED|abuse detection/i;

/**
 * A reader over `gh api`. `run` takes `gh`'s arguments and its standard input, and returns its
 * standard output; injected so the reader is testable without `gh`.
 * @param {{ run?: (args: string[], input?: string) => string }} [io]
 * @returns {Reader}
 */
export function ghReader({ run = ghApi } = {}) {
  /**
   * @param {string} read @param {string[]} args @param {string} [input]
   * @returns {unknown}
   */
  const call = (read, args, input) => {
    let out;
    try {
      out = run(args, input);
    } catch (e) {
      throw ghFailure(read, e, run);
    }
    try {
      return JSON.parse(out);
    } catch {
      throw new ReadError(read, `the answer isn't JSON: ${String(out).slice(0, 120)}`);
    }
  };
  return {
    get: (path) => call(restRead(path), ['api', path]),
    pages: (path) => call(restRead(path), ['api', '--paginate', '--slurp', path]),
    graphql: (query, variables = {}) => {
      const body = /** @type {{ data?: unknown, errors?: Array<{ message?: string }> }} */ (call(graphqlRead(query), ['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })));
      if (body?.errors?.length) throw new ReadError(graphqlRead(query), body.errors.map((e) => e?.message ?? 'an error').join('; '));
      return body?.data;
    },
  };
}

/** `gh`, as the reader runs it. @param {string[]} args @param {string} [input] */
function ghApi(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
  });
}

/**
 * A `gh` failure as a `ReadError`: the first line of its standard error, the HTTP status it
 * names, and, for a rate limit, when the limit resets, read with one more `GET`.
 * @param {string} read @param {unknown} e @param {(args: string[]) => string} run
 */
function ghFailure(read, e, run) {
  const err = /** @type {{ stderr?: unknown, message?: unknown }} */ (e);
  const stderr = String(err?.stderr ?? '') || String(err?.message ?? '');
  const why = stderr.split('\n').map((l) => l.replace(/^gh:\s*/, '').trim()).find(Boolean) ?? 'gh failed with no message';
  const status = Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || null;
  const limited = RATE_LIMITED.test(stderr) || status === 429;
  return new ReadError(read, why, { status, resetAt: limited ? resetOf(read, run) : null });
}

/**
 * When the exhausted limit resets, ISO 8601, or null when that can't be read. GraphQL and the
 * search API each have a limit of their own; every other read spends the core one.
 * @param {string} read @param {(args: string[]) => string} run
 */
function resetOf(read, run) {
  try {
    const { resources } = JSON.parse(run(['api', 'rate_limit']));
    const kind = read.startsWith('GraphQL') ? 'graphql' : /^GET search\//.test(read) ? 'search' : 'core';
    const reset = Number(resources?.[kind]?.reset);
    return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * A reader that remembers every read that failed, for a view whose reads go through code that
 * tolerates a failure (`[STAT-3]`). A failure its caller marks `expected` (a 404 read as "no
 * such file") isn't one. Answers are always promises.
 * @param {Reader} reader
 * @returns {{ reader: Reader, failures: () => ReadError[] }}
 */
export function watched(reader) {
  /** @type {ReadError[]} */
  const seen = [];
  /**
   * @template {unknown[]} A
   * @param {(...args: A) => unknown} fn @param {(...args: A) => string} name
   */
  const wrap = (fn, name) => async (/** @type {A} */ ...args) => {
    try {
      return await fn.apply(reader, args);
    } catch (e) {
      // A reader that throws its own error keeps its HTTP status: 404 is how a caller tells "not
      // there" from "couldn't read".
      const status = /** @type {{ status?: unknown }} */ (e)?.status;
      const failure = e instanceof ReadError ? e : new ReadError(name(...args), e instanceof Error ? e.message : String(e), {
        status: typeof status === 'number' ? status : null,
      });
      seen.push(failure);
      throw failure;
    }
  };
  return {
    reader: {
      get: wrap(reader.get, restRead),
      pages: wrap(reader.pages, restRead),
      graphql: wrap(reader.graphql, graphqlRead),
      failed: (failure) => {
        seen.push(failure);
        reader.failed?.(failure);
      },
    },
    failures: () => seen.filter((f) => !f.expected),
  };
}

/** `owner` and `name` of an `owner/name` repository. @param {string} repo */
export function ownerAndName(repo) {
  const [owner, name, ...rest] = String(repo ?? '').split('/');
  if (!owner || !name || rest.length) throw new Error(`a repository is \`owner/name\`, not \`${repo}\``);
  return { owner, name };
}

/**
 * @typedef {{ nodes?: unknown[], pageInfo?: { hasNextPage?: boolean, endCursor?: string | null }, totalCount?: number, issueCount?: number }} Connection
 */

/**
 * Every node of a GraphQL connection, page by page. The query takes an `$after: String`
 * variable and asks the connection for `pageInfo { hasNextPage endCursor }`; `at` picks the
 * connection out of the answer. A connection that isn't there is a failed read, and so is one
 * that ends before the count it reports, `totalCount` or a search's `issueCount`, when the
 * query asks for it (`[STAT-3]`): the search API stops at 1,000.
 * @param {Reader} reader
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @param {(data: any) => Connection | null | undefined} at
 * @returns {Promise<any[]>}
 */
export async function allNodes(reader, query, variables, at) {
  /** @type {unknown[]} */
  const nodes = [];
  /** @type {string | null} */
  let after = null;
  for (;;) {
    const conn = at(await reader.graphql(query, { ...variables, after }));
    if (!conn || !Array.isArray(conn.nodes)) throw incomplete(reader, graphqlRead(query), 'the answer has no such connection');
    nodes.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) {
      requireComplete(graphqlRead(query), nodes.length, conn.issueCount ?? conn.totalCount, reader);
      return nodes;
    }
    after = conn.pageInfo.endCursor ?? null;
    if (!after) throw incomplete(reader, graphqlRead(query), 'a page says more follow, and gives no cursor to them');
  }
}

/**
 * Throws when a listing holds fewer entries than it says it has (`[STAT-3]`), telling the reader
 * it came through, so a caller that tolerates the throw can't hide it from a watched reader.
 * @param {string} read @param {number} got @param {number | null | undefined} total
 * @param {Reader} [reader]
 */
export function requireComplete(read, got, total, reader) {
  if (typeof total === 'number' && got < total) {
    throw incomplete(reader, read, `the listing was cut short: ${got} of ${total} entries`);
  }
}

/**
 * A read that answered and is incomplete, told to the reader it came through (`[STAT-3]`).
 * @param {Reader | undefined} reader @param {string} read @param {string} why
 */
export function incomplete(reader, read, why) {
  const failure = new ReadError(read, why);
  reader?.failed?.(failure);
  return failure;
}
