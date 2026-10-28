import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import { ENV } from '../../../infra/status/function/handler.mjs';

/**
 * The AWS a hosted status server's container meets at startup (project #1327, Issue I), over
 * `fetch`: SSM's `GetParameter`, which answers the App's client secret, and KMS's
 * `GenerateDataKey` and `Decrypt`, which open only a data key KMS generated, under the stack's key
 * and its encryption context. A test replaces any of the three with an answer of its own, or has
 * AWS refuse one with a code (`refuse`, which it may change between calls); any other call is
 * recorded and refused.
 */

export const SECRET = 'status-app-secret-0c9a7b5f1e';

/** The environment the template sets, with Lambda's credentials. */
export const STATUS_ENV = {
  AWS_REGION: 'eu-central-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI', AWS_SESSION_TOKEN: 'session',
  [ENV.keyId]: '1234abcd-12ab-34cd-56ef-1234567890ab',
  [ENV.clientId]: 'Iv23liStatusApp',
  [ENV.secretParameter]: '/kanon-status/github-client-secret',
  [ENV.redirects]: '',
  [ENV.release]: 'v0.43.0',
};

export type AwsCall = { url: string, target: string, body: Record<string, unknown>, authorization: string };
export type AwsAnswer = (body: Record<string, unknown>) => { status: number, body: unknown };

/** AWS's refusal of `op`, as the function's role would get it. */
export const denied = (code = 'AccessDeniedException'): AwsAnswer => () => ({ status: 400, body: { __type: code, message: 'User: arn:aws:sts::1:assumed-role/kanon-status is not authorized' } });

/** AWS over `fetch`, its three calls answered as a working stack's are unless `answers` replaces one. */
export function fakeAws(answers: Record<string, AwsAnswer> = {}) {
  const keys = new Map<string, Buffer>();
  const context = JSON.stringify({ service: 'kanon-status' });
  const working: Record<string, AwsAnswer> = {
    'AmazonSSM.GetParameter': () => ({ status: 200, body: { Parameter: { Name: STATUS_ENV[ENV.secretParameter], Type: 'SecureString', Value: SECRET } } }),
    'TrentService.GenerateDataKey': (body) => {
      if (body.KeyId !== STATUS_ENV[ENV.keyId] || body.KeySpec !== 'AES_256') return { status: 400, body: { __type: 'ValidationException' } };
      const plaintext = randomBytes(32);
      const blob = randomBytes(48).toString('base64');
      keys.set(blob, plaintext);
      return { status: 200, body: { KeyId: body.KeyId, Plaintext: plaintext.toString('base64'), CiphertextBlob: blob } };
    },
    'TrentService.Decrypt': (body) => {
      const plaintext = keys.get(String(body.CiphertextBlob));
      if (!plaintext || body.KeyId !== STATUS_ENV[ENV.keyId] || JSON.stringify(body.EncryptionContext) !== context) return { status: 400, body: { __type: 'InvalidCiphertextException' } };
      return { status: 200, body: { KeyId: body.KeyId, Plaintext: plaintext.toString('base64') } };
    },
  };
  const calls: AwsCall[] = [];
  /** The calls AWS refuses, by target, and with what code. */
  const refuse: Record<string, string> = {};
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>, body: string }) => {
    const target = init.headers['x-amz-target']!;
    const body = JSON.parse(init.body);
    calls.push({ url, target, body, authorization: init.headers.authorization ?? init.headers.Authorization ?? '' });
    const answer = refuse[target] ? denied(refuse[target]) : answers[target] ?? working[target];
    const reply = answer ? answer(body) : { status: 400, body: { __type: 'UnexpectedCall' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, refuse, targets: () => calls.map((c) => c.target).sort() };
}
