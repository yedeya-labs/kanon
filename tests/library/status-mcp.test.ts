/**
 * The hosted status server's handler (project #1327, Issue G): the MCP Streamable HTTP methods at
 * the two protocol revisions `docs/status.md` names (#1423), exactly the tools that page lists, each the same
 * object as its view's section of `kanon-status/v1` for the same reads, and nothing that writes.
 * The handler is driven directly, as a function URL's event, with no server started.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { laneFleet } from './helpers/status-world.js';
import { API, CASES, READ_AT, REPO, cli, fetchOver, type Reader } from './helpers/mcp-world.js';

const { handle, METHODS, LEGACY_VERSION, MODERN_VERSION, PROTOCOL_VERSIONS, DEPRECATION_NOTE, TOOLS } = await import('../../infra/status/function/index.mjs');
const { fetchReader } = await import('../../infra/status/function/reader.mjs');
const { ReadError, ownerAndName } = await import('../../scripts/status/reader.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const PAGE = () => readFileSync(join(ROOT, 'docs/status.md'), 'utf8');
const FUNCTION_DIR = join(ROOT, 'infra/status/function');

/** A function URL's event (payload 2.0), as Lambda hands one to the handler. */
function event({ method = 'POST', path = '/mcp', body, headers = {}, base64 = false }: { method?: string; path?: string; body?: unknown; headers?: Record<string, string>; base64?: boolean }) {
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    version: '2.0',
    rawPath: path,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    requestContext: { http: { method, path } },
    body: text !== undefined && base64 ? Buffer.from(text).toString('base64') : text,
    isBase64Encoded: base64,
  };
}

/** A reader that records each read, and fails a case that reads at all where nothing should be. */
const untouched = () => {
  const reads: string[] = [];
  const reader: Reader = {
    get: (p) => { reads.push(`GET ${p}`); throw new Error('read'); },
    pages: (p) => { reads.push(`PAGES ${p}`); throw new Error('read'); },
    graphql: (q) => { reads.push(`GraphQL ${q}`); throw new Error('read'); },
  };
  return { reader, reads };
};

/** POSTs one JSON-RPC message to the handler. */
async function post(body: unknown, { reader = untouched().reader as Reader, headers = {} as Record<string, string>, base64 = false, deprecated = DEPRECATED } = {}) {
  const res: Any = await handle(event({ body, headers, base64 }), { reader, now: () => new Date(READ_AT), release: 'v9.9.9', deprecated });
  return { ...res, json: () => JSON.parse(res.body) };
}
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args: Record<string, unknown>, reader: Reader) => post(rpc('tools/call', { name, arguments: args }), { reader });

/** The date the deploy names as 2025-11-25's deprecation, and its RFC 9745 header value. */
const DEPRECATED = '2026-11-02';
const DEPRECATION = `@${Date.UTC(2026, 10, 2) / 1000}`;
/** A 2026-07-28 request's `_meta`: its version and the client's capabilities, on every request. */
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } };
/** A 2026-07-28 request: `_meta` in its params, and the headers that mirror its body. */
const modern = (method: string, params: Record<string, unknown> = {}, { id = 1 as number | string, headers = {} as Record<string, string>, meta = META as Record<string, unknown> } = {}) => ({
  body: { jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } },
  headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}), ...headers },
});
const postModern = (m: { body: unknown; headers: Record<string, string> }, reader?: Reader) => post(m.body, { headers: m.headers, ...(reader ? { reader } : {}) });


/** The body of a Markdown section: from its heading to the next heading of its level or above. */
const section = (text: string, heading: string): string | null => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l === heading);
  if (at < 0) return null;
  const level = /^(#+) /.exec(lines[at]!)![1]!.length;
  const end = lines.findIndex((l, i) => i > at && /^(#+) /.test(l) && /^(#+) /.exec(l)![1]!.length <= level);
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
};


describe('[MCP-1] the Streamable HTTP methods, at the two protocol revisions the page names', () => {
  it('[MCP-1] answers initialize, tools/list, tools/call and ping at 2025-11-25, any other request with method-not-found, and a notification with 202 and no body', async () => {
    // The page names the two revisions, newest first, and the server serves them.
    const named = /protocol revisions, `(\d{4}-\d{2}-\d{2})` and `(\d{4}-\d{2}-\d{2})`/.exec(section(PAGE(), '## The hosted MCP server') ?? '');
    expect(named, 'docs/status.md\'s "## The hosted MCP server" names the two protocol revisions').not.toBeNull();
    expect(PROTOCOL_VERSIONS).toEqual([named![1], named![2]]);
    expect([MODERN_VERSION, LEGACY_VERSION]).toEqual(['2026-07-28', '2025-11-25']);

    // initialize: 2025-11-25, whatever version the client asked for, and the tools capability.
    for (const asked of [LEGACY_VERSION, '2025-03-26', '2099-01-01']) {
      const init = await post(rpc('initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
      expect(init.statusCode).toBe(200);
      expect(init.headers['content-type']).toBe('application/json');
      const body = init.json();
      expect(body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: LEGACY_VERSION, capabilities: { tools: { listChanged: false } } } });
      expect(body.result.serverInfo.name).toBe('kanon-status');
      // 2025-11-25's results have no resultType: that field is 2026-07-28's.
      expect(body.result).not.toHaveProperty('resultType');
      // Stateless: no session is minted.
      expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('mcp-session-id');
    }

    // ping, tools/list and tools/call each answer, echoing the request's id, a string one too.
    expect((await post(rpc('ping', undefined, 'p-1'))).json()).toEqual({ jsonrpc: '2.0', id: 'p-1', result: {} });
    expect((await post(rpc('tools/list', {}, 2))).json().result.tools.map((t: Any) => t.name).sort()).toEqual(TOOLS.map((t: Any) => t.name).sort());
    const lanes = await call('lanes', { repo: REPO }, laneFleet().reader);
    expect([lanes.statusCode, lanes.json().id, lanes.json().result.isError]).toEqual([200, 1, false]);

    // Any other request is method-not-found, by its id: no write method, no resource, no prompt,
    // and not 2026-07-28's discovery.
    for (const method of ['resources/list', 'prompts/list', 'tools/delete', 'completion/complete', 'logging/setLevel', 'subscriptions/listen', 'server/discover']) {
      const r = await post(rpc(method, {}, 9));
      expect([r.statusCode, r.json()], method).toEqual([200, { jsonrpc: '2.0', id: 9, error: { code: -32601, message: expect.stringContaining(method) } }]);
    }

    // A notification, a message with no id, is accepted with 202 and no body, whatever its method,
    // and reads nothing: even one naming a request's method or none Kanon knows.
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'tools/call', 'initialize', 'nonsense/thing']) {
      const { reader, reads } = untouched();
      const r = await post({ jsonrpc: '2.0', method, params: { name: 'lanes', arguments: { repo: REPO } } }, { reader });
      expect([r.statusCode, r.body ?? '', reads], method).toEqual([202, '', []]);
    }
    // A client's JSON-RPC response is accepted the same way.
    expect((await post({ jsonrpc: '2.0', id: 5, result: {} })).statusCode).toBe(202);

    // The protocol-version header: 2025-11-25, or none (an older client's first request), is
    // served at 2025-11-25; a version the server serves neither of is 400 and
    // UnsupportedProtocolVersionError, naming the two it serves.
    expect((await post(rpc('ping'), { headers: { 'mcp-protocol-version': LEGACY_VERSION } })).statusCode).toBe(200);
    for (const version of ['2024-01-01', '2025-06-18']) {
      const { reader, reads } = untouched();
      const unsupported = await post(rpc('tools/call', { name: 'lanes', arguments: { repo: REPO } }), { headers: { 'MCP-Protocol-Version': version }, reader });
      expect([unsupported.statusCode, unsupported.json(), reads], version).toEqual([400, { jsonrpc: '2.0', id: 1, error: { code: -32022, message: expect.any(String), data: { supported: ['2026-07-28', '2025-11-25'], requested: version } } }, []]);
    }

    // A base64 body, as a function URL may deliver one, reads the same.
    expect((await post(rpc('ping'), { base64: true })).json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    // What isn't one JSON-RPC message is refused by the transport: unparseable JSON, a batch
    // (which 2025-11-25 removed), a message that isn't JSON-RPC 2.0.
    const parse = await post('{"jsonrpc":');
    expect([parse.statusCode, parse.json()]).toEqual([400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: expect.any(String) } }]);
    for (const bad of [[rpc('ping')], { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: null, method: 'ping' }, 'null', '"ping"']) {
      const r = await post(bad);
      expect([r.statusCode, r.json().error.code], JSON.stringify(bad)).toEqual([400, -32600]);
    }

    // The one endpoint takes POST alone: no stream to GET, no session to DELETE.
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const r: Any = await handle(event({ method }), { reader: untouched().reader, now: () => new Date(READ_AT) });
      expect([r.statusCode, r.headers.allow], method).toEqual([405, 'POST']);
    }
    // Any other path is not the server's.
    const elsewhere: Any = await handle(event({ path: '/other', body: rpc('ping') }), { reader: untouched().reader, now: () => new Date(READ_AT) });
    expect(elsewhere.statusCode).toBe(404);
    // A browser page's request carries an Origin, and the server serves MCP clients, not pages
    // (the transport's DNS-rebinding rule).
    const browser = await post(rpc('ping'), { headers: { origin: 'https://evil.example' } });
    expect(browser.statusCode).toBe(403);
  });

  it('[MCP-1] answers server/discover, tools/list and tools/call at 2026-07-28, statelessly, from each request\'s _meta and the headers that mirror its body', async () => {
    const serverInfo = { name: 'kanon-status', title: 'Kanon status', version: 'v9.9.9' };

    // server/discover: the two revisions, the tools capability and the server's identity, with
    // caching hints, and no handshake: nothing came before it.
    const discover = await postModern(modern('server/discover', {}, { id: 'd-1' }));
    expect(discover.statusCode).toBe(200);
    expect(discover.headers['content-type']).toBe('application/json');
    expect(discover.json()).toEqual({
      jsonrpc: '2.0',
      id: 'd-1',
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: { listChanged: false } },
        instructions: expect.stringContaining('Kanon status'),
        ttlMs: expect.any(Number),
        cacheScope: 'public',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    expect(discover.json().result.ttlMs).toBeGreaterThan(0);
    expect(Object.keys(discover.headers).map((h) => h.toLowerCase())).not.toContain('mcp-session-id');

    // tools/list: the same tools as at 2025-11-25, with resultType and caching hints: the list is
    // the same for every person, so any cache may hold it.
    const list = (await postModern(modern('tools/list'))).json().result;
    expect(list.tools).toEqual((await post(rpc('tools/list'))).json().result.tools);
    expect(list).toMatchObject({ resultType: 'complete', ttlMs: expect.any(Number), cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } });

    // tools/call: the same answer as at 2025-11-25, with resultType, its read time and the server.
    const viaModern = (await postModern(modern('tools/call', { name: 'lanes', arguments: { repo: REPO } }), laneFleet().reader)).json().result;
    const viaLegacy = (await call('lanes', { repo: REPO }, laneFleet().reader)).json().result;
    expect(viaModern.structuredContent).toEqual(viaLegacy.structuredContent);
    expect(viaModern).toMatchObject({ resultType: 'complete', isError: false, _meta: { readAt: READ_AT, 'io.modelcontextprotocol/serverInfo': serverInfo } });
    expect(viaModern.content).toEqual(viaLegacy.content);
    // A tool's error is a complete result too.
    const refused = (await postModern(modern('tools/call', { name: 'lanes', arguments: { repo: 'acme' } }))).json().result;
    expect([refused.resultType, refused.isError]).toEqual(['complete', true]);
    // The tool's name may come base64-encoded in its header, as the transport allows any value.
    const encoded = modern('tools/call', { name: 'lanes', arguments: { repo: REPO } }, { headers: { 'mcp-name': `=?base64?${Buffer.from('lanes').toString('base64')}?=` } });
    expect((await postModern(encoded, laneFleet().reader)).json().result.isError).toBe(false);

    // Any other method is 404 and method-not-found, and reads nothing: 2025-11-25's handshake and
    // ping included, which 2026-07-28 removed.
    for (const method of ['initialize', 'ping', 'resources/list', 'prompts/list', 'tools/delete', 'logging/setLevel', 'subscriptions/listen']) {
      const { reader, reads } = untouched();
      const r = await postModern(modern(method, {}, { id: 9 }), reader);
      expect([r.statusCode, r.json(), reads], method).toEqual([404, { jsonrpc: '2.0', id: 9, error: { code: -32601, message: expect.stringContaining(method) } }, []]);
    }

    // A header that doesn't match the body, or a required one missing, is 400 and HeaderMismatch,
    // and reads nothing.
    const lanesCall = () => modern('tools/call', { name: 'lanes', arguments: { repo: REPO } });
    const without = (m: ReturnType<typeof modern>, name: string) => ({ ...m, headers: Object.fromEntries(Object.entries(m.headers).filter(([k]) => k !== name)) });
    for (const [why, m] of [
      ['no MCP-Protocol-Version', without(lanesCall(), 'mcp-protocol-version')],
      ['MCP-Protocol-Version 2025-11-25 under a 2026-07-28 _meta', { ...lanesCall(), headers: { ...lanesCall().headers, 'mcp-protocol-version': '2025-11-25' } }],
      ['no Mcp-Method', without(lanesCall(), 'mcp-method')],
      ['another Mcp-Method', { ...lanesCall(), headers: { ...lanesCall().headers, 'mcp-method': 'tools/list' } }],
      ['no Mcp-Name', without(lanesCall(), 'mcp-name')],
      ['another Mcp-Name', { ...lanesCall(), headers: { ...lanesCall().headers, 'mcp-name': 'release' } }],
      ['an Mcp-Name that is not a header value', { ...lanesCall(), headers: { ...lanesCall().headers, 'mcp-name': 'lanés' } }],
    ] as const) {
      const { reader, reads } = untouched();
      const r = await postModern(m, reader);
      expect([r.statusCode, r.json().id, r.json().error?.code, reads], why).toEqual([400, 1, -32020, []]);
    }

    // A request without the _meta fields 2026-07-28 requires is 400 and invalid-params.
    for (const [why, meta] of [
      ['no clientCapabilities', { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }],
      ['no _meta', undefined],
    ] as const) {
      const m = modern('tools/list', {}, { meta: meta as Record<string, unknown> });
      const body = meta === undefined ? { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } : m.body;
      const r = await post(body, { headers: m.headers });
      expect([r.statusCode, r.json().error?.code], why).toEqual([400, -32602]);
    }

    // A version the server doesn't serve is 400 and UnsupportedProtocolVersionError, naming the two.
    const future = modern('tools/list', {}, { id: 3, meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }, headers: { 'mcp-protocol-version': '2099-01-01' } });
    expect([(await postModern(future)).statusCode, (await postModern(future)).json()]).toEqual([400, { jsonrpc: '2.0', id: 3, error: { code: -32022, message: expect.any(String), data: { supported: ['2026-07-28', '2025-11-25'], requested: '2099-01-01' } } }]);

    // A notification is accepted with 202 and no body, and reads nothing.
    const { reader, reads } = untouched();
    const note = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, { headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'notifications/cancelled' }, reader });
    expect([note.statusCode, note.body, reads]).toEqual([202, '', []]);
  });

  it('[MCP-1] marks every response served at 2025-11-25 deprecated, with a Deprecation date and a Link to the note, and no 2026-07-28 response', async () => {
    // The Link points at the note, which docs/status.md holds.
    expect(DEPRECATION_NOTE).toBe('https://github.com/yedeya-labs/kanon/blob/main/docs/status.md#the-2025-11-25-revision-is-deprecated');
    expect(section(PAGE(), '### The 2025-11-25 revision is deprecated'), 'docs/status.md has the note the Link points at').not.toBeNull();
    const link = `<${DEPRECATION_NOTE}>; rel="deprecation"; type="text/html"`;

    // Every 2025-11-25 response: a result, an error, a notification's 202, a transport refusal,
    // with the version header or without it.
    const legacy: Array<[string, Any]> = [
      ['initialize', await post(rpc('initialize', { protocolVersion: LEGACY_VERSION }))],
      ['tools/list', await post(rpc('tools/list'), { headers: { 'mcp-protocol-version': LEGACY_VERSION } })],
      ['tools/call', await call('lanes', { repo: REPO }, laneFleet().reader)],
      ['method-not-found', await post(rpc('resources/list'))],
      ['a notification', await post({ jsonrpc: '2.0', method: 'notifications/initialized' })],
      ['unparseable', await post('{"jsonrpc":')],
      ['a batch', await post([rpc('ping')], { headers: { 'mcp-protocol-version': LEGACY_VERSION } })],
      ['a browser page', await post(rpc('ping'), { headers: { origin: 'https://evil.example' } })],
      ['GET', await handle(event({ method: 'GET', headers: { 'mcp-protocol-version': LEGACY_VERSION } }), { reader: untouched().reader, deprecated: DEPRECATED })],
    ];
    for (const [what, r] of legacy) {
      expect([r.headers.deprecation, r.headers.link], what).toEqual([DEPRECATION, link]);
      // No removal date has been chosen, so no Sunset.
      expect(Object.keys(r.headers).map((h) => h.toLowerCase()), what).not.toContain('sunset');
    }
    // The handshake's instructions say so too, for a client that shows them.
    const instructions = legacy[0]![1].json().result.instructions;
    expect(instructions).toMatch(/2025-11-25 is deprecated/);
    expect(instructions).toMatch(/2026-07-28/);

    // No 2026-07-28 response carries either: a result, an error, a refusal, a notification's 202.
    const modernReplies: Array<[string, Any]> = [
      ['server/discover', await postModern(modern('server/discover'))],
      ['tools/list', await postModern(modern('tools/list'))],
      ['tools/call', await postModern(modern('tools/call', { name: 'lanes', arguments: { repo: REPO } }), laneFleet().reader)],
      ['method-not-found', await postModern(modern('ping'))],
      ['HeaderMismatch', await postModern(modern('tools/list', {}, { headers: { 'mcp-method': 'ping' } }))],
      ['a notification', await post({ jsonrpc: '2.0', method: 'notifications/cancelled' }, { headers: { 'mcp-protocol-version': MODERN_VERSION } })],
      // A version neither revision is served at isn't 2025-11-25's either.
      ['unsupported', await post(rpc('ping'), { headers: { 'mcp-protocol-version': '2099-01-01' } })],
    ];
    for (const [what, r] of modernReplies) {
      const names = Object.keys(r.headers).map((h) => h.toLowerCase());
      expect([names.includes('deprecation'), names.includes('link'), names.includes('sunset')], what).toEqual([false, false, false]);
    }
    expect(modernReplies[0]![1].json().result.instructions).not.toMatch(/deprecated/);
  });
});

describe('[MCP-2] exactly the listed tools, read-only, each equal to its view\'s section', () => {
  it('[MCP-2] lists exactly the tools docs/status.md names, one per view, each annotated read-only', async () => {
    const table = section(PAGE(), '## The hosted server\'s tools');
    expect(table, 'docs/status.md has a "## The hosted server\'s tools" section').not.toBeNull();
    const rows = [...table!.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`/gm)].map((m) => [m[1]!, m[2]!]);
    const listed = (await post(rpc('tools/list'))).json().result.tools;
    expect(listed.map((t: Any) => t.name).sort()).toEqual(rows.map(([tool]) => tool).sort());
    // One per view: each row names the section of kanon-status/v1 the tool returns, and the six
    // sections are the six views.
    expect(rows.map(([, key]) => key).sort()).toEqual(['inbox', 'lanes', 'needsOwner', 'pr', 'project', 'release']);
    expect(Object.fromEntries(TOOLS.map((t: Any) => [t.name, t.view]))).toEqual(Object.fromEntries(rows));
    for (const t of listed) {
      expect(t.annotations, t.name).toEqual({ title: expect.any(String), readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.inputSchema.required, t.name).toContain('repo');
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
    expect(CASES.map((c) => c.tool).sort()).toEqual(listed.map((t: Any) => t.name).sort());
  });

  it('[MCP-2] each tool returns the same object as its view\'s section of kanon-status/v1 for the same reads, and a call over a recording reader asks GitHub nothing that writes', async () => {
    for (const c of CASES) {
      for (const world of c.worlds) {
        const expected = (await cli(c.argv, world().reader))[c.key];
        // Over the world's reader directly…
        const direct = (await call(c.tool, c.args, world().reader)).json().result;
        expect(direct.structuredContent, c.tool).toEqual(expected);
        expect(JSON.parse(direct.content[0].text), c.tool).toEqual(expected);
        expect(direct.content[0].type).toBe('text');
        // A view with no answer is the tool's error, and its section is still the object.
        expect(direct.isError, c.tool).toBe('error' in expected);

        // …and over the server's own reader, `fetch` with a token, against the same world: the
        // same object, and every request is a GET or a GraphQL query, each to GitHub's API.
        const http = fetchOver(world().reader);
        const reader = fetchReader({ token: 'gho_person', fetch: http.fetch });
        const viaFetch = (await call(c.tool, c.args, reader)).json().result;
        expect(viaFetch.structuredContent, `${c.tool} over fetch`).toEqual(expected);
        expect(http.requests.length, c.tool).toBeGreaterThan(0);
        for (const r of http.requests) {
          expect(r.url.startsWith(`${API}/`), r.url).toBe(true);
          expect(r.headers.authorization).toBe('Bearer gho_person');
          if (r.method === 'POST') {
            expect(r.url).toBe(`${API}/graphql`);
            expect(JSON.parse(r.body!).query, r.url).not.toMatch(/^\s*(mutation|subscription)\b/);
          } else expect(r.method, r.url).toBe('GET');
        }
      }
    }
  }, 60_000);

  it('[MCP-2] a call the tool can\'t run is the tool\'s error, naming what is wrong, and reads nothing', async () => {
    for (const [name, args, says] of [
      ['project', { repo: REPO }, /project/],
      ['project', { repo: REPO, project: 0 }, /project/],
      ['project', { repo: REPO, project: '7' }, /project/],
      ['pull_request', { repo: REPO, number: 1.5 }, /number/],
      ['lanes', {}, /repo/],
      ['lanes', { repo: 'acme' }, /owner\/name/],
      ['lanes', { repo: 'acme/shop/x' }, /owner\/name/],
      // A dot segment would name another path once `fetch` resolves the URL (#1422).
      ['lanes', { repo: 'acme/..' }, /owner\/name/],
      ['lanes', { repo: 'acme/.' }, /owner\/name/],
      ['release', { repo: '../shop' }, /owner\/name/],
      ['release', { repo: './shop' }, /owner\/name/],
      ['project', { repo: '../..', project: 7 }, /owner\/name/],
      ['release', { repo: REPO, extra: 1 }, /extra/],
    ] as const) {
      const { reader, reads } = untouched();
      const r = (await call(name, args, reader)).json();
      expect([r.result?.isError, reads], `${name} ${JSON.stringify(args)}`).toEqual([true, []]);
      expect(r.result.content[0].text).toMatch(says);
    }
    // The schema a client validates against refuses the same: one pattern, the core's own.
    for (const tool of TOOLS) {
      const pattern = new RegExp(tool.inputSchema.properties.repo.pattern);
      for (const bad of ['acme/..', 'acme/.', '../shop', './shop', '../..', 'acme', 'acme/shop/x']) expect(pattern.test(bad), `${tool.name} ${bad}`).toBe(false);
      for (const good of [REPO, 'acme/.github', 'acme/shop.js', 'a-b/c_d', 'acme/..shop']) expect(pattern.test(good), `${tool.name} ${good}`).toBe(true);
    }
    for (const bad of ['acme/..', 'acme/.', '../shop', './shop', 'acme', 'acme/shop/x', '']) expect(() => ownerAndName(bad), bad).toThrow(/owner\/name/);
    expect(ownerAndName('acme/.github')).toEqual({ owner: 'acme', name: '.github' });
    // An unknown tool is a protocol error, as the specification has it.
    const unknown = (await call('merge', { repo: REPO }, untouched().reader)).json();
    expect(unknown.error.code).toBe(-32602);
  });
});

describe('[MCP-3] no write and no store', () => {
  it('[MCP-3] the handler holds no write to a table, a bucket or a file, and no route or method that writes', async () => {
    const files = readdirSync(FUNCTION_DIR).filter((f) => f.endsWith('.mjs'));
    expect(files.sort()).toEqual(['auth.mjs', 'aws.mjs', 'cache.mjs', 'handler.mjs', 'index.mjs', 'kms.mjs', 'log.mjs', 'reader.mjs', 'seal.mjs', 'ssm.mjs']);
    for (const f of files) {
      const text = readFileSync(join(FUNCTION_DIR, f), 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
      const imports = [...code.matchAll(/(?:^import\s[^'"]*|import\()\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
      // Node's built-ins that can't write anything (`node:crypto` hashes and seals in memory, `node:perf_hooks` is a clock), the
      // status core, and the telemetry function's SigV4 signer, which only computes headers.
      for (const spec of imports) {
        expect(/^node:(buffer|url|crypto|perf_hooks)$/.test(spec) || /^\.\.\/\.\.\/\.\.\/scripts\/status\/[\w-]+\.mjs$/.test(spec) || /^\.\/[\w-]+\.mjs$/.test(spec) || spec === '../../telemetry/function/sigv4.mjs', `${f} imports ${spec}`).toBe(true);
      }
      // No store: nothing that writes a file, and no table's or bucket's API.
      expect(code, f).not.toMatch(/\b(writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|PutItem|UpdateItem|DeleteItem|BatchWriteItem|PutObject|DeleteObject|dynamodb|s3\.amazonaws)\b/i);
    }
    // The handler serves one route, by POST, and each revision's methods; anything else is refused, so
    // there is nothing else for a request to reach (`[MCP-1]` holds each answer).
    expect(Object.fromEntries(Object.entries(METHODS).map(([v, m]) => [v, Object.keys(m as object)]))).toEqual({
      '2026-07-28': ['server/discover', 'tools/list', 'tools/call'],
      '2025-11-25': ['initialize', 'ping', 'tools/list', 'tools/call'],
    });
    // Every tool is a view of the status core, and nothing else.
    expect(TOOLS.map((t: Any) => t.view).sort()).toEqual(['inbox', 'lanes', 'needsOwner', 'pr', 'project', 'release']);

    // The reader the server reads GitHub through asks only GETs and GraphQL queries: a mutation
    // is refused before anything is sent, and so is a next page off GitHub's API.
    const requests: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      requests.push(`${init.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify([{ n: 1 }]), { status: 200, headers: { link: '<https://elsewhere.example/steal?page=2>; rel="next"' } });
    }) as unknown as typeof fetch;
    const reader = fetchReader({ token: 't', fetch: fetchImpl });
    // Every ignored token GraphQL allows between one definition's `}` and the next counts (#1422):
    // a comma, a comment however its line ends, a byte-order mark; and a block string's escaped
    // `\"""` doesn't end the string, so it can't hide the definitions after it.
    for (const doc of [
      'mutation Merge { mergePullRequest(input: {}) { clientMutationId } }',
      '  subscription S { x }',
      'query A { a } mutation B { b }',
      'fragment F on Mutation { a },mutation { ...F }',
      'query A { a } , , mutation B { b }',
      '{ a },subscription S { x }',
      'query A { a } # note\nmutation B { b }',
      'query A { a } # note\rmutation B { b }',
      'query A { a } # note\r\nmutation B { b }',
      '\uFEFFmutation B { b }',
      'query A { a }\uFEFFmutation B { b }',
      'query A { a(s: """x\\""" """) } mutation B { b(s: """ """) }',
    ]) {
      await expect(reader.graphql(doc), JSON.stringify(doc)).rejects.toThrow(/writes nothing|only queries/);
    }
    expect(requests, 'a refused document sends nothing').toEqual([]);
    // A query is sent, whatever its strings and comments say.
    for (const doc of ['query A { a(s: "} mutation B") }', 'query A { a } # } mutation B', 'query A { a(s: """} ,mutation\\""" } subscription""") }', 'query A { a }, query B { b }', 'fragment F on Mutation { a } query { ...F }']) {
      await reader.graphql(doc);
    }
    expect(requests).toEqual(Array(5).fill(`POST ${API}/graphql`));
    requests.length = 0;
    await expect(reader.pages('repos/o/r/pulls')).rejects.toThrow(/GitHub's API/);
    expect(requests).toEqual([`GET ${API}/repos/o/r/pulls`]);
    expect(Object.keys(reader).sort()).toEqual(['get', 'graphql', 'pages']);
  });
});

describe('the server\'s reader', () => {
  it('reads REST, every page and GraphQL over fetch with the token, and fails a read by name as ReadError does', async () => {
    const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const routes: Record<string, () => Response> = {
      'GET https://api.github.com/repos/o/r': () => Response.json({ default_branch: 'main' }),
      'GET https://api.github.com/repos/o/r/pulls?per_page=100': () => Response.json([1], { headers: { link: '<https://api.github.com/repositories/1/pulls?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/pulls?per_page=100&page=3>; rel="last"' } }),
      'GET https://api.github.com/repositories/1/pulls?per_page=100&page=2': () => Response.json([2]),
      'POST https://api.github.com/graphql': () => Response.json({ data: { viewer: { login: 'octo' } } }),
      'GET https://api.github.com/repos/o/r/contents/x': () => Response.json({ message: 'Not Found' }, { status: 404 }),
      'GET https://api.github.com/repos/o/r/limited': () => Response.json({ message: 'API rate limit exceeded for user.' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792832400' } }),
      'GET https://api.github.com/repos/o/r/forbidden': () => Response.json({ message: 'Resource not accessible by integration' }, { status: 403, headers: { 'x-ratelimit-remaining': '4000' } }),
      'GET https://api.github.com/repos/o/r/html': () => new Response('<html>', { status: 200 }),
    };
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      seen.push({ method, url, headers: init.headers as Record<string, string> });
      const route = routes[`${method} ${url}`];
      if (!route) throw new TypeError('fetch failed');
      return route();
    }) as unknown as typeof fetch;
    const reader = fetchReader({ token: 'gho_x', fetch: fetchImpl });

    expect(await reader.get('repos/o/r')).toEqual({ default_branch: 'main' });
    expect(await reader.pages('repos/o/r/pulls?per_page=100')).toEqual([[1], [2]]);
    expect(await reader.graphql('query Who { viewer { login } }', { a: 1 })).toEqual({ viewer: { login: 'octo' } });
    expect(seen[0]!.headers).toMatchObject({ authorization: 'Bearer gho_x', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET https://api.github.com/repos/o/r',
      'GET https://api.github.com/repos/o/r/pulls?per_page=100',
      'GET https://api.github.com/repositories/1/pulls?per_page=100&page=2',
      'POST https://api.github.com/graphql',
    ]);

    const failure = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect(e).toBeInstanceOf(ReadError);
        const r = e as Any;
        return { read: r.read, why: r.why, status: r.status, resetAt: r.resetAt };
      }
      throw new Error('no failure');
    };
    expect(await failure(reader.get('repos/o/r/contents/x'))).toEqual({ read: 'GET repos/o/r/contents/x', why: 'Not Found', status: 404, resetAt: null });
    expect(await failure(reader.get('repos/o/r/limited'))).toEqual({ read: 'GET repos/o/r/limited', why: 'API rate limit exceeded for user.', status: 403, resetAt: new Date(1792832400 * 1000).toISOString() });
    expect(await failure(reader.get('repos/o/r/forbidden'))).toEqual({ read: 'GET repos/o/r/forbidden', why: 'Resource not accessible by integration', status: 403, resetAt: null });
    expect((await failure(reader.get('repos/o/r/html'))).why).toMatch(/isn't JSON/);
    expect(await failure(reader.get('repos/o/r/unreachable'))).toEqual({ read: 'GET repos/o/r/unreachable', why: 'fetch failed', status: null, resetAt: null });

    // A GraphQL answer carrying errors is a failed read, named by the query.
    const errs = fetchReader({ token: 't', fetch: (async () => Response.json({ data: null, errors: [{ message: 'Could not resolve' }, { type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792832400' } })) as unknown as typeof fetch });
    expect(await failure(errs.graphql('query Labels { a }'))).toEqual({ read: 'GraphQL Labels', why: 'Could not resolve; API rate limit exceeded', status: null, resetAt: new Date(1792832400 * 1000).toISOString() });
  });
});
