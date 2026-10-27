// The hosted status server's two KMS calls (project #1327, Issue H): `GenerateDataKey`, for the
// data key a container seals with, and `Decrypt`, for a data key another container generated.
// Over `aws.mjs`'s caller, with the telemetry function's SigV4 signer (decision 11: `node:`
// built-ins only, no SDK).
//
// AN ERROR NAMES THE OPERATION AND AWS'S ERROR CODE ONLY, as the telemetry function's do: nothing
// of AWS's message is kept, so nothing of a request reaches a log through one.

import { Buffer } from 'node:buffer';
import { jsonCaller } from './aws.mjs';

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
 * @param {import('./aws.mjs').AwsEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Kms}
 */
export function kmsOf(env, fetchImpl = fetch) {
  const call = jsonCaller(env, { service: 'kms', target: 'TrentService', fail: (op, code) => new KmsError(op, code) }, fetchImpl);
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
