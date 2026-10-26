// The hosted status server's two KMS calls (project #1327, Issue H): `GenerateDataKey`, for the
// data key a container seals with, and `Decrypt`, for a data key another container generated.
// Over HTTPS with the telemetry function's SigV4 signer, imported rather than copied (decision
// 11: `node:` built-ins only, no SDK).
//
// AN ERROR NAMES THE OPERATION AND AWS'S ERROR CODE ONLY, as the telemetry function's do: nothing
// of AWS's message is kept, so nothing of a request reaches a log through one.

import { Buffer } from 'node:buffer';
import { sign } from '../../telemetry/function/sigv4.mjs';

/** A failed KMS call: `code` is AWS's error code (`InvalidCiphertextException`, …). */
export class KmsError extends Error {
  /** @param {string} op @param {string} code */
  constructor(op, code) {
    super(`KMS ${op} failed: ${code}`);
    this.name = 'KmsError';
    this.code = code;
  }
}

/**
 * @typedef {{
 *   generateDataKey: (req: { keyId: string, context: Record<string, string> }) => Promise<{ plaintext: Buffer, blob: Buffer }>,
 *   decrypt: (req: { keyId: string, blob: Buffer, context: Record<string, string> }) => Promise<Buffer>,
 * }} Kms
 */

/**
 * KMS in the function's region, with the function's own credentials, which Lambda puts in its
 * environment.
 * @param {{ AWS_REGION?: string, AWS_ACCESS_KEY_ID?: string, AWS_SECRET_ACCESS_KEY?: string, AWS_SESSION_TOKEN?: string }} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Kms}
 */
export function kmsOf(env, fetchImpl = fetch) {
  const region = env.AWS_REGION ?? 'eu-central-1';
  const url = `https://kms.${region}.amazonaws.com/`;
  /** @param {string} op @param {Record<string, unknown>} body @returns {Promise<any>} */
  const call = async (op, body) => {
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${op}` };
    const credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '', sessionToken: env.AWS_SESSION_TOKEN };
    const res = await fetchImpl(url, { method: 'POST', headers: { ...headers, ...sign({ method: 'POST', url, headers, body: text, region, service: 'kms', credentials }) }, body: text });
    /** @type {any} */
    let json;
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    if (!res.ok) throw new KmsError(op, String(json?.__type ?? `HTTP${res.status}`).split('#').pop() ?? 'unknown');
    return json;
  };
  return {
    generateDataKey: async ({ keyId, context }) => {
      const r = await call('GenerateDataKey', { KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: context });
      return { plaintext: Buffer.from(String(r.Plaintext), 'base64'), blob: Buffer.from(String(r.CiphertextBlob), 'base64') };
    },
    decrypt: async ({ keyId, blob, context }) => {
      const r = await call('Decrypt', { KeyId: keyId, CiphertextBlob: blob.toString('base64'), EncryptionContext: context });
      return Buffer.from(String(r.Plaintext), 'base64');
    },
  };
}
