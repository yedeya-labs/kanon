// The hosted status server's request handler (project #1327, Issue G): Kanon's five status views,
// served read-only as MCP tools over the Streamable HTTP transport (docs/status.md).
//
// A SURFACE, NOT A SECOND CORE (`[MCP-2]`). Each tool is one view of the status core, built by
// `scripts/status/views.mjs` exactly as `kanon status` builds its section of `kanon-status/v1`,
// over the reader the caller passes: the server's own `fetchReader` (`reader.mjs`), holding the
// person's token. A tool's answer is that section, as `structuredContent` and as its JSON text.
// A view whose reads didn't complete answers with its `{ error, reads }` section, as the tool's
// error (`[STAT-3]`).
//
// THE TRANSPORT (`[MCP-1]`). One endpoint, `/mcp`, by POST, at the protocol version
// `PROTOCOL_VERSION`, which docs/status.md names. A request is answered with one JSON object: the
// four methods in `METHODS`, and method-not-found for any other. A notification, or a client's
// response, is accepted with 202 and no body, whatever its method, and reads nothing. The server
// is stateless: it mints no session, offers no stream to GET, and has no session to DELETE, so
// both are 405. A request carrying an `Origin` is a browser page's, and is refused with 403, as the
// transport's DNS-rebinding rule asks; the server's clients send none.
//
// NOTHING WRITES (`[MCP-3]`). No tool, method or route writes to GitHub, and the handler keeps
// nothing: no table, no bucket, no file. What the reader asks is GETs and GraphQL queries alone.
//
// NOT DEPLOYABLE ON ITS OWN. Authentication is Issue H's: it wraps `handle`, refuses a request
// without a valid credential, and passes the person's `fetchReader` in. The template and the
// deploy are Issue I's. Nothing here is a Lambda entry point, and no local server is shipped.
//
// `node:` built-ins only, and no MCP SDK (decision 11).

import { Buffer } from 'node:buffer';
import { VIEWS, section } from '../../../scripts/status/views.mjs';

/** The MCP protocol version the server speaks, as docs/status.md names it. */
export const PROTOCOL_VERSION = '2025-11-25';

/** The one endpoint's path. */
export const MCP_PATH = '/mcp';

/** JSON-RPC's error codes the server answers with. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** A repository, `owner/name`, as `kanon status --repo` takes one. */
const REPO = { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$', description: 'The repository, `owner/name`.' };
/** An issue or pull-request number. */
const NUMBER = (/** @type {string} */ what) => ({ type: 'integer', minimum: 1, description: what });

/**
 * @typedef {{
 *   name: string, title: string, description: string,
 *   view: keyof typeof VIEWS, n: string | null,
 *   inputSchema: { type: 'object', properties: Record<string, any>, required: string[], additionalProperties: false },
 * }} Tool a tool: the view whose section it returns, and the argument that is that view's own (`n`)
 */

/** @type {Tool[]} The tools, one per view (docs/status.md, "The hosted server's tools"). */
export const TOOLS = [
  {
    name: 'project',
    title: 'Project progress',
    description: "A project's progress, from its tracking issue's brief on the default branch: the phase the Lead's reconciler is in, the gating work, and each item with its issue, pull requests, dependencies, acceptance criteria and what holds it.",
    view: 'project',
    n: 'project',
    inputSchema: { type: 'object', properties: { repo: REPO, project: NUMBER("The project's tracking issue.") }, required: ['repo', 'project'], additionalProperties: false },
  },
  {
    name: 'release',
    title: 'Release status',
    description: 'What is about to ship, what shipped, and where: the open release pull request, the latest release and pre-release, each declared environment\'s last deploy, and the promotion\'s gates where the repository runs Kanon\'s promotion.',
    view: 'release',
    n: null,
    inputSchema: { type: 'object', properties: { repo: REPO }, required: ['repo'], additionalProperties: false },
  },
  {
    name: 'pull_request',
    title: 'Pull-request readiness',
    description: "One pull request as the Merger would read it: its checks, the Reviewer's verdict and whether it is current, the criteria of the issues it closes, the merge gate's verdict, and whether it is ready to merge, and by whom.",
    view: 'pr',
    n: 'number',
    inputSchema: { type: 'object', properties: { repo: REPO, number: NUMBER('The pull request.') }, required: ['repo', 'number'], additionalProperties: false },
  },
  {
    name: 'lanes',
    title: 'Lane health',
    description: "Each lane caller's recent runs, as the workflow-health check judges them, with each failure classed `infra` (the model unreachable, an API error, no verdict, or fixed by a re-run) or `real`.",
    view: 'lanes',
    n: null,
    inputSchema: { type: 'object', properties: { repo: REPO }, required: ['repo'], additionalProperties: false },
  },
  {
    name: 'needs_owner',
    title: 'Needs the Owner',
    description: "What waits on a person, each with its link and reason: the pull requests ready for a person's merge, the Implementer's stops, the Lead's holds, the open decisions in brief pull requests, and the red lanes.",
    view: 'needsOwner',
    n: null,
    inputSchema: { type: 'object', properties: { repo: REPO }, required: ['repo'], additionalProperties: false },
  },
];

/** Every tool reads, and only reads, GitHub, the same answer for the same state. */
const annotations = (/** @type {Tool} */ t) => ({ title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });

/**
 * @typedef {{
 *   reader: import('../../../scripts/status/reader.mjs').Reader,
 *   now?: () => Date,
 *   release?: string,
 * }} Deps the person's reader, the clock, and the Kanon release the server runs, as its wrapper knows it
 * @typedef {{ statusCode: number, headers: Record<string, string>, body: string }} Reply
 */

/** A JSON reply. @param {number} statusCode @param {unknown} body @returns {Reply} */
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** A reply with no body. @param {number} statusCode @param {Record<string, string>} [headers] @returns {Reply} */
const empty = (statusCode, headers = {}) => ({ statusCode, headers, body: '' });
/** A JSON-RPC error. @param {string | number | null} id @param {number} code @param {string} message */
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * The four methods the server answers, each a request's `result`, or a JSON-RPC error as
 * `{ error }`.
 * @type {Record<string, (params: any, deps: Required<Deps>) => Promise<unknown> | unknown>}
 */
export const METHODS = {
  initialize: (_params, { release }) => ({
    // The one version the server speaks, whatever version the client asked for: a client that
    // can't speak it disconnects.
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'kanon-status', title: 'Kanon status', version: release },
    instructions: 'Kanon status, read-only: where a repository that runs Kanon stands, read live from GitHub with your own access. Every tool takes the repository as `owner/name`.',
  }),
  ping: () => ({}),
  'tools/list': () => ({
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: annotations(t) })),
  }),
  'tools/call': (params, deps) => callTool(params, deps),
};

/**
 * The handler: one function URL event in, one reply out.
 * @param {any} event a function URL event (payload 2.0)
 * @param {Deps} deps
 * @returns {Promise<Reply>}
 */
export async function handle(event, { reader, now = () => new Date(), release = 'unreleased' }) {
  const headers = Object.fromEntries(Object.entries(event?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if ((event?.rawPath ?? event?.requestContext?.http?.path) !== MCP_PATH) return empty(404);
  if (headers.origin !== undefined) return json(403, failure(null, INVALID_REQUEST, 'a request from a browser page is refused'));
  if (event?.requestContext?.http?.method !== 'POST') return empty(405, { allow: 'POST' });
  const version = headers['mcp-protocol-version'];
  if (version !== undefined && version !== PROTOCOL_VERSION) {
    return json(400, failure(null, INVALID_REQUEST, `unsupported protocol version ${version}; this server speaks ${PROTOCOL_VERSION}`));
  }

  /** @type {any} */
  let message;
  try {
    const raw = event?.isBase64Encoded ? Buffer.from(String(event.body ?? ''), 'base64').toString('utf8') : String(event?.body ?? '');
    message = JSON.parse(raw);
  } catch {
    return json(400, failure(null, PARSE_ERROR, 'the body is not JSON'));
  }
  if (Array.isArray(message)) return json(400, failure(null, INVALID_REQUEST, `a batch is not accepted at protocol version ${PROTOCOL_VERSION}`));
  if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') return json(400, failure(null, INVALID_REQUEST, 'the body is not a JSON-RPC 2.0 message'));

  const hasId = Object.hasOwn(message, 'id');
  if (typeof message.method === 'string') {
    // A notification: accepted, never answered, and nothing is read for it.
    if (!hasId) return empty(202);
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return json(400, failure(null, INVALID_REQUEST, 'a request id is a string or a number'));
  } else {
    // A client's response to a request: the server sends none, so there is nothing to match it to.
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return empty(202);
    return json(400, failure(null, INVALID_REQUEST, 'the body is not a JSON-RPC request, notification or response'));
  }

  const { id, method, params } = message;
  const run = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
  if (!run) return json(200, failure(id, METHOD_NOT_FOUND, `method not found: ${method}`));
  const answer = /** @type {any} */ (await run(params ?? {}, { reader, now, release }));
  return json(200, answer && Object.hasOwn(answer, 'error') ? { jsonrpc: '2.0', id, error: answer.error } : { jsonrpc: '2.0', id, result: answer });
}

/**
 * `tools/call`: the tool's view, as its section of `kanon-status/v1`. An unknown tool is a
 * protocol error; arguments the tool can't take, and a view with no answer, are the tool's error.
 * @param {any} params @param {Required<Deps>} deps
 */
async function callTool(params, { reader, now }) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) return { error: { code: INVALID_PARAMS, message: `unknown tool: ${params?.name}` } };
  const args = params.arguments ?? {};
  const wrong = problems(tool, args);
  if (wrong.length) return toolError(`${tool.name} can't run: ${wrong.join('; ')}`);
  const reads = { reader, repo: String(args.repo), readAt: now().toISOString(), ...(tool.n ? { n: Number(args[tool.n]) } : {}) };
  /** @type {object} */
  let answer;
  try {
    answer = await section(() => VIEWS[tool.view](reads));
  } catch (e) {
    return toolError(`the ${tool.name} view stopped on an unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer, isError: 'error' in answer };
}

/** A tool's error, as text. @param {string} text */
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * What is wrong with a tool's arguments against its input schema, one sentence each.
 * @param {Tool} tool @param {unknown} args
 * @returns {string[]}
 */
function problems(tool, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['its arguments are an object'];
  const given = /** @type {Record<string, unknown>} */ (args);
  const { properties, required } = tool.inputSchema;
  const out = Object.keys(given).filter((k) => !Object.hasOwn(properties, k)).map((k) => `it takes no argument \`${k}\``);
  for (const key of Object.keys(properties)) {
    const v = given[key];
    if (v === undefined) {
      if (required.includes(key)) out.push(`\`${key}\` is required`);
    } else if (properties[key].type === 'string') {
      if (typeof v !== 'string' || !new RegExp(properties[key].pattern).test(v)) out.push(`\`${key}\` is \`owner/name\`, not ${JSON.stringify(v)}`);
    } else if (!Number.isSafeInteger(v) || /** @type {number} */ (v) < properties[key].minimum) {
      out.push(`\`${key}\` is a positive whole number, not ${JSON.stringify(v)}`);
    }
  }
  return out;
}
