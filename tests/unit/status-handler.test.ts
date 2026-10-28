import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { DEFAULT_REDIRECTS } from '../../infra/status/function/auth.mjs';
import { ENV, depsFrom, handlerOf } from '../../infra/status/function/handler.mjs';
import { SsmError, ssmOf } from '../../infra/status/function/ssm.mjs';
import { SECRET, STATUS_ENV as ENVIRONMENT, denied, fakeAws, type AwsAnswer } from './helpers/status-aws.js';

/**
 * Project #1327, Issue I: the hosted status server's Lambda entry point. It builds `serve`'s deps
 * once per container from the environment the template sets: the client id, a sealer under the
 * stack's key, which it proves at startup by having KMS generate a data key and decrypt it back,
 * and the client secret, read once from the SSM parameter the template names and kept in memory
 * only (the Owner's Q1). A failed read or a key it can't use is logged as AWS's error code alone.
 */

const STARTUP = ['AmazonSSM.GetParameter', 'TrentService.Decrypt', 'TrentService.GenerateDataKey'];

const unauthenticated = { rawPath: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', isBase64Encoded: false, requestContext: { http: { method: 'POST', path: '/mcp' }, domainName: 'abc.lambda-url.eu-central-1.on.aws' } };
const SERVER_ERROR = { statusCode: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{"error":"server_error"}' };

describe("the hosted status server's entry point", () => {
  it('reads its deps from the environment, the client secret from SSM, decrypted, and proves its key with KMS', async () => {
    const aws = fakeAws();
    const deps = await depsFrom(ENVIRONMENT, { fetch: aws.fetchImpl });
    expect(deps).toMatchObject({ clientId: 'Iv23liStatusApp', clientSecret: SECRET, redirects: DEFAULT_REDIRECTS, release: 'v0.43.0', deprecated: '2026-11-02' });
    expect(typeof deps.sealer.seal).toBe('function');
    expect(aws.targets()).toEqual(STARTUP);
    expect(aws.calls.find((c) => c.target === 'AmazonSSM.GetParameter')).toEqual({
      url: 'https://ssm.eu-central-1.amazonaws.com/', target: 'AmazonSSM.GetParameter',
      body: { Name: '/kanon-status/github-client-secret', WithDecryption: true },
      authorization: expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/ssm\/aws4_request/),
    });
    // The Decrypt is of the data key KMS generated, under the same key and context: the fake opens no other.
    const generated = aws.calls.find((c) => c.target === 'TrentService.GenerateDataKey')!;
    expect(generated).toMatchObject({ url: 'https://kms.eu-central-1.amazonaws.com/', body: { KeyId: ENVIRONMENT[ENV.keyId], KeySpec: 'AES_256', EncryptionContext: { service: 'kanon-status' } } });
    expect(aws.calls.find((c) => c.target === 'TrentService.Decrypt')!.body).toEqual({ KeyId: ENVIRONMENT[ENV.keyId], CiphertextBlob: expect.any(String), EncryptionContext: { service: 'kanon-status' } });

    // The data key it proved is the one it seals with: sealing and opening make no more calls.
    const sealed = await deps.sealer.seal('client', 'https://status.example/mcp', { cid: 'c' }, null);
    expect(await deps.sealer.open('client', 'https://status.example/mcp', sealed, 0)).toMatchObject({ cid: 'c' });
    expect(aws.calls).toHaveLength(3);

    const listed = await depsFrom({ ...ENVIRONMENT, [ENV.redirects]: 'https://claude.ai/api/mcp/auth_callback, http://localhost:*' }, { fetch: fakeAws().fetchImpl });
    expect(listed.redirects).toEqual(['https://claude.ai/api/mcp/auth_callback', 'http://localhost:*']);
  });

  it('refuses an environment the template did not set, before any read', async () => {
    for (const name of [ENV.keyId, ENV.clientId, ENV.secretParameter, ENV.deprecated]) {
      const aws = fakeAws();
      await expect(depsFrom({ ...ENVIRONMENT, [name]: '' }, { fetch: aws.fetchImpl }), name).rejects.toMatchObject({ code: 'Unconfigured' });
      expect(aws.calls).toEqual([]);
    }
    // The date 2025-11-25 was deprecated, which every answer at that revision carries, is a date.
    for (const date of ['soon', '2026-11-2', '2026-13-01', '2026-02-30', '2026-11-02T00:00:00Z']) {
      const aws = fakeAws();
      await expect(depsFrom({ ...ENVIRONMENT, [ENV.deprecated]: date }, { fetch: aws.fetchImpl }), date).rejects.toMatchObject({ code: 'Unconfigured' });
      expect(aws.calls).toEqual([]);
    }
  });

  it('reads the secret and proves the key once per container, and answers an unauthenticated request with no call of its own', async () => {
    const aws = fakeAws();
    const lines: string[] = [];
    const handler = handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) });
    for (let i = 0; i < 3; i += 1) {
      const reply = await handler(unauthenticated);
      expect(reply.statusCode).toBe(401);
      expect(reply.headers['www-authenticate']).toBe('Bearer resource_metadata="https://abc.lambda-url.eu-central-1.on.aws/.well-known/oauth-protected-resource/mcp"');
    }
    expect(aws.targets()).toEqual(STARTUP);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it("answers 500 when the secret can't be read, logs AWS's error code alone, and reads again on the next request", async () => {
    let answer: AwsAnswer = () => ({ status: 400, body: { __type: 'com.amazonaws.ssm#ParameterNotFound', message: `no parameter /kanon-status/github-client-secret (${SECRET})` } });
    const aws = fakeAws({ 'AmazonSSM.GetParameter': (body) => answer(body) });
    const lines: string[] = [];
    const handler = handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) });
    const failed = await handler(unauthenticated);
    expect(failed).toEqual(SERVER_ERROR);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { startup: 'client_secret', code: 'ParameterNotFound' },
      expect.objectContaining({ route: '/mcp', outcome: 'error', githubRequests: 0 }),
    ]);
    expect(lines.join('\n')).not.toMatch(/no parameter|kanon-status\/github|status-app-secret/);

    answer = () => ({ status: 200, body: { Parameter: { Value: SECRET } } });
    expect((await handler(unauthenticated)).statusCode).toBe(401);
    expect(aws.calls.filter((c) => c.target === 'AmazonSSM.GetParameter')).toHaveLength(2);
  });

  it("answers 500 when KMS won't generate its data key, or won't decrypt it, logs AWS's error code alone, and tries again on the next request", async () => {
    for (const [op, code] of [['GenerateDataKey', 'AccessDeniedException'], ['Decrypt', 'AccessDeniedException'], ['Decrypt', 'IncorrectKeyException'], ['GenerateDataKey', 'KMSInvalidStateException']] as const) {
      const aws = fakeAws();
      aws.refuse[`TrentService.${op}`] = code;
      const lines: string[] = [];
      const handler = handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) });
      expect(await handler(unauthenticated), `${op} ${code}`).toEqual(SERVER_ERROR);
      expect(lines.map((l) => JSON.parse(l)), `${op} ${code}`).toEqual([
        { startup: 'key', code },
        expect.objectContaining({ route: '/mcp', outcome: 'error', githubRequests: 0 }),
      ]);
      expect(lines.join('\n')).not.toMatch(/not authorized|assumed-role/);

      delete aws.refuse[`TrentService.${op}`];
      expect((await handler(unauthenticated)).statusCode, `${op} ${code}`).toBe(401);
      expect(aws.calls.filter((c) => c.target === `TrentService.${op}`), `${op} ${code}`).toHaveLength(2);
    }
  });

  it('answers 500 when KMS decrypts its data key to another key', async () => {
    const aws = fakeAws({ 'TrentService.Decrypt': () => ({ status: 200, body: { Plaintext: Buffer.alloc(32, 7).toString('base64') } }) });
    const lines: string[] = [];
    expect(await handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) })(unauthenticated)).toEqual(SERVER_ERROR);
    expect(JSON.parse(lines[0]!)).toEqual({ startup: 'key', code: 'KeyMismatch' });
  });

  it("logs a code that isn't AWS's shape as unknown", async () => {
    const aws = fakeAws({ 'AmazonSSM.GetParameter': () => ({ status: 500, body: { __type: 'Bad code: with text' } }) });
    const lines: string[] = [];
    await handlerOf(ENVIRONMENT, { fetch: aws.fetchImpl, log: (l) => lines.push(l) })(unauthenticated);
    expect(JSON.parse(lines[0]!)).toEqual({ startup: 'client_secret', code: 'unknown' });
  });

  it('names the operation and the code in an SSM error, and nothing of the message', async () => {
    const aws = fakeAws({ 'AmazonSSM.GetParameter': denied() });
    const failure = await ssmOf(ENVIRONMENT, aws.fetchImpl).getParameter('/kanon-status/github-client-secret').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SsmError);
    expect(failure).toMatchObject({ code: 'AccessDeniedException', message: 'SSM GetParameter failed: AccessDeniedException' });
  });
});
