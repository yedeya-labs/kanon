/**
 * Project #1327, Issue I: the hosted status server's deploy smoke, `infra/status/smoke.mjs`. The
 * operator's smoke hook runs it against the deployed server, and a red smoke files the deploy
 * lane's failure issue there. It passes only when an unauthenticated `tools/list` gets 401 naming
 * the server's own protected-resource metadata, and that metadata names the server (`[MCP-11]`).
 *
 * It runs here as the hook runs it, a process given `--url`, against the real `serve` behind a
 * local `node:http` server, and against servers that each get one thing wrong.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { SPAWNS } from '../unit/helpers/spawns.js';
import { writeStub } from '../unit/helpers/stub-bin.js';

const { serve } = await import('../../infra/status/function/auth.mjs');
const { checkServer } = await import('../../infra/status/smoke.mjs');

const SMOKE = join(ROOT, 'infra/status/smoke.mjs');
const run = promisify(execFile);

type Handler = (req: IncomingMessage, body: string, origin: string) => Promise<{ statusCode: number, headers?: Record<string, string>, body?: string }>;
const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A local server answering with `handler`, and its `/mcp` address. */
async function listen(handler: Handler): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const { port } = server.address() as AddressInfo;
      const reply = await handler(req, body, `http://127.0.0.1:${port}`);
      res.writeHead(reply.statusCode, reply.headers ?? {});
      res.end(reply.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** The real server: `serve`, given a function URL's event. Nothing it answers here seals or opens. */
const real: Handler = async (req, body, origin) => {
  const url = new URL(req.url ?? '/', origin);
  const sealer = { seal: async () => { throw new Error('no seal in a smoke'); }, open: async () => null };
  return serve({
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: req.headers as Record<string, string>,
    body,
    isBase64Encoded: false,
    requestContext: { http: { method: req.method ?? 'GET', path: url.pathname }, domainName: url.host },
  }, { clientId: 'Iv23liSmoke', clientSecret: 'unused', sealer, origin, log: () => {} });
};

/** The real server, but with one route's answer replaced. */
const except = (path: string, reply: Awaited<ReturnType<Handler>>): Handler => async (req, body, origin) =>
  (new URL(req.url ?? '/', origin).pathname === path ? reply : real(req, body, origin));

const smoke = async (url: string) => {
  try {
    const { stdout } = await run(process.execPath, [SMOKE, '--url', url], { timeout: 20_000 });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code: number, stdout: string, stderr: string };
    return { code: err.code, out: `${err.stdout}${err.stderr}` };
  }
};

const METADATA = '/.well-known/oauth-protected-resource/mcp';

describe("the hosted status server's deploy smoke", SPAWNS, () => {
  it('[MCP-11] passes only when the deployed server answers an unauthenticated tools/list with 401 and serves its protected-resource metadata', async () => {
    const url = await listen(real);
    expect(await smoke(url)).toEqual({ code: 0, out: expect.stringContaining(`smoke: ok, ${url} answers 401 and serves its metadata`) });

    const wrong: Array<[string, Handler, RegExp]> = [
      ['answers tools/list', except('/mcp', { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' }), /tools\/list at \S+ got 200, not 401/],
      ['refuses it, but not as 401', async (req, body, origin) => (new URL(req.url ?? '/', origin).pathname === '/mcp'
        ? { statusCode: 403, headers: { 'www-authenticate': `Bearer resource_metadata="${origin}${METADATA}"` }, body: '' }
        : real(req, body, origin)), /tools\/list at \S+ got 403, not 401/],
      ['names no metadata', except('/mcp', { statusCode: 401, headers: { 'www-authenticate': 'Bearer' }, body: '' }), /names no resource_metadata/],
      ['names another resource', except(METADATA, { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource: 'https://elsewhere.example/mcp', authorization_servers: ['https://elsewhere.example'] }) }), /names the resource https:\/\/elsewhere\.example\/mcp/],
      ['serves no metadata', except(METADATA, { statusCode: 404, body: '' }), /metadata .* got 404/],
    ];
    for (const [what, handler, message] of wrong) {
      const result = await smoke(await listen(handler));
      expect(result.code, what).toBe(1);
      expect(result.out, what).toMatch(message);
    }
  });

  it('refuses metadata on another origin, and an authorisation server that is not the server', async () => {
    const elsewhere = await listen(except('/mcp', { statusCode: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://elsewhere.example/.well-known/oauth-protected-resource/mcp"' }, body: '' }));
    expect(await checkServer(elsewhere)).toEqual([expect.stringMatching(/names metadata on another origin/)]);

    let at = '';
    const otherIssuer = await listen(async (req, body, origin) => {
      at = origin;
      return new URL(req.url ?? '/', origin).pathname === METADATA
        ? { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: ['https://elsewhere.example'] }) }
        : real(req, body, origin);
    });
    expect(await checkServer(otherIssuer)).toEqual([`the metadata names authorization_servers ["https://elsewhere.example"], not ${at}`]);
  });

  it("with --stack, reads the server's address from the stack, and fails a stack that isn't complete", async () => {
    const url = await listen(real);
    const withStack = async (answer: string) => {
      const bin = mkdtempSync(join(tmpdir(), 'status-smoke-'));
      writeStub(join(bin, 'aws'), `#!/usr/bin/env bash\n[ "$2" = describe-stacks ] && printf '${answer}\\n'\n`);
      return run(process.execPath, [SMOKE, '--stack'], { env: { PATH: `${bin}:${process.env.PATH}` }, timeout: 20_000 })
        .then(({ stdout }) => ({ code: 0, out: stdout }), (e: { code: number, stdout: string }) => ({ code: e.code, out: e.stdout }));
    };
    expect(await withStack(`UPDATE_COMPLETE\\t${url}`)).toEqual({ code: 0, out: `smoke: ok, ${url} answers 401 and serves its metadata\n` });
    expect(await withStack('UPDATE_ROLLBACK_COMPLETE\\tNone')).toEqual({ code: 1, out: 'smoke: failed: kanon-status is UPDATE_ROLLBACK_COMPLETE, not CREATE_COMPLETE or UPDATE_COMPLETE with an address\n' });
  });

  it('fails, naming it, when the server answers nothing', async () => {
    const result = await smoke('http://127.0.0.1:9/mcp');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/smoke: failed: tools\/list .* could not be sent/);
  });

  it('refuses to run without a URL it can use', async () => {
    for (const args of [[], ['--url', 'not a url'], ['--url', 'https://status.example/']]) {
      const out = await run(process.execPath, [SMOKE, ...args]).then(() => ({ code: 0 }), (e: { code: number }) => ({ code: e.code }));
      expect(out.code, args.join(' ')).toBe(2);
    }
  });
});
