import { describe, expect, it } from 'vitest';

import { DEFAULT_REDIRECTS } from '../../infra/status/function/auth.mjs';
import { ENV, depsFrom, handlerOf } from '../../infra/status/function/handler.mjs';
import { SsmError, ssmOf } from '../../infra/status/function/ssm.mjs';

/**
 * Project #1327, Issue I: the hosted status server's Lambda entry point. It builds `serve`'s deps
 * once per container from the environment the template sets: the client id, a sealer under the
 * stack's key, and the client secret, read once from the SSM parameter the template names and kept
 * in memory only (the Owner's Q1). A failed read is logged as AWS's error code alone.
 */

const SECRET = 'status-app-secret-0c9a7b5f1e';
const ENVIRONMENT = {
  AWS_REGION: 'eu-central-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI', AWS_SESSION_TOKEN: 'session',
  [ENV.keyId]: '1234abcd-12ab-34cd-56ef-1234567890ab',
  [ENV.clientId]: 'Iv23liStatusApp',
  [ENV.secretParameter]: '/kanon-status/github-client-secret',
  [ENV.redirects]: '',
  [ENV.release]: 'v0.43.0',
};

type Call = { url: string, target: string, body: Record<string, unknown>, authorization: string };

/** AWS over `fetch`: SSM's GetParameter answers `answer`; any other call is recorded and refused. */
function fakeAws(answer: () => { status: number, body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>, body: string }) => {
    calls.push({ url, target: init.headers['x-amz-target']!, body: JSON.parse(init.body), authorization: init.headers.authorization ?? init.headers.Authorization ?? '' });
    const { status, body } = init.headers['x-amz-target'] === 'AmazonSSM.GetParameter' ? answer() : { status: 400, body: { __type: 'UnexpectedCall' } };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const found = () => ({ status: 200, body: { Parameter: { Name: '/kanon-status/github-client-secret', Type: 'SecureString', Value: SECRET } } });

const unauthenticated = { rawPath: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', isBase64Encoded: false, requestContext: { http: { method: 'POST', path: '/mcp' }, domainName: 'abc.lambda-url.eu-central-1.on.aws' } };

describe("the hosted status server's entry point", () => {
  it('reads its deps from the environment, and the client secret from SSM, decrypted', async () => {
    const aws = fakeAws(found);
    const deps = await depsFrom(ENVIRONMENT, { fetch: aws.fetchImpl });
    expect(deps).toMatchObject({ clientId: 'Iv23liStatusApp', clientSecret: SECRET, redirects: DEFAULT_REDIRECTS, release: 'v0.43.0' });
    expect(typeof deps.sealer.seal).toBe('function');
    expect(aws.calls).toEqual([{
      url: 'https://ssm.eu-central-1.amazonaws.com/', target: 'AmazonSSM.GetParameter',
      body: { Name: '/kanon-status/github-client-secret', WithDecryption: true },
      authorization: expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/ssm\/aws4_request/),
    }]);
    const listed = await depsFrom({ ...ENVIRONMENT, [ENV.redirects]: 'https://claude.ai/api/mcp/auth_callback, http://localhost:*' }, { fetch: fakeAws(found).fetchImpl });
    expect(listed.redirects).toEqual(['https://claude.ai/api/mcp/auth_callback', 'http://localhost:*']);
  });

  it('refuses an environment the template did not set, before any read', async () => {
    for (const name of [ENV.keyId, ENV.clientId, ENV.secretParameter]) {
      const aws = fakeAws(found);
      await expect(depsFrom({ ...ENVIRONMENT, [name]: '' }, { fetch: aws.fetchImpl }), name).rejects.toMatchObject({ code: 'Unconfigured' });
      expect(aws.calls).toEqual([]);
    }
  });

  it('reads the secret once per container, and answers an unauthenticated request with no KMS call', async () => {
    const aws = fakeAws(found);
    const lines: string[] = [];
    const handler = handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) });
    for (let i = 0; i < 3; i += 1) {
      const reply = await handler(unauthenticated);
      expect(reply.statusCode).toBe(401);
      expect(reply.headers['www-authenticate']).toBe('Bearer resource_metadata="https://abc.lambda-url.eu-central-1.on.aws/.well-known/oauth-protected-resource/mcp"');
    }
    expect(aws.calls.map((c) => c.target)).toEqual(['AmazonSSM.GetParameter']);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it("answers 500 when the secret can't be read, logs AWS's error code alone, and reads again on the next request", async () => {
    let answer: () => { status: number, body: unknown } = () => ({ status: 400, body: { __type: 'com.amazonaws.ssm#ParameterNotFound', message: `no parameter /kanon-status/github-client-secret (${SECRET})` } });
    const aws = fakeAws(() => answer());
    const lines: string[] = [];
    const handler = handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) });
    const failed = await handler(unauthenticated);
    expect(failed).toEqual({ statusCode: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{"error":"server_error"}' });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { startup: 'client_secret', code: 'ParameterNotFound' },
      expect.objectContaining({ route: '/mcp', outcome: 'error', githubRequests: 0 }),
    ]);
    expect(lines.join('\n')).not.toMatch(/no parameter|kanon-status\/github|status-app-secret/);

    answer = found;
    expect((await handler(unauthenticated)).statusCode).toBe(401);
    expect(aws.calls).toHaveLength(2);
  });

  it("logs a code that isn't AWS's shape as unknown", async () => {
    const aws = fakeAws(() => ({ status: 500, body: { __type: 'Bad code: with text' } }));
    const lines: string[] = [];
    await handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) })(unauthenticated);
    expect(JSON.parse(lines[0]!)).toEqual({ startup: 'client_secret', code: 'unknown' });
  });

  it('names the operation and the code in an SSM error, and nothing of the message', async () => {
    const aws = fakeAws(() => ({ status: 400, body: { __type: 'AccessDeniedException', message: 'User: arn:aws:sts::1:assumed-role/x is not authorized' } }));
    const failure = await ssmOf(ENVIRONMENT, aws.fetchImpl).getParameter('/kanon-status/github-client-secret').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SsmError);
    expect(failure).toMatchObject({ code: 'AccessDeniedException', message: 'SSM GetParameter failed: AccessDeniedException' });
  });
});
