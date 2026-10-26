// The hosted status server's sealed values (project #1327, Issue H, `[MCP-6]`): everything its
// sign-in hands out, the client id, the consent form, the upstream state, the code and the access
// and refresh tokens, is a payload encrypted and authenticated under the server's KMS key and
// carried by the client, the browser or GitHub. The server keeps none of them.
//
// ENVELOPE ENCRYPTION. A container asks KMS for one data key the first time it seals, and keeps
// it in memory. A sealed value is `ks1.<data key, as KMS encrypted it>.<iv>.<ciphertext>.<tag>`:
// AES-256-GCM of the payload, under the data key. A container that meets a data key it doesn't
// hold asks KMS to decrypt it, once, and keeps that in memory too. So no key sits in
// configuration, and a warm container makes no KMS call per request.
//
// ONE KIND IS NEVER ANOTHER. The kind (`client`, `access`, …) and the audience (the server's
// `/mcp` resource) are the cipher's additional data, so a value sealed as one kind, or for
// another server, doesn't open as anything else. A value that doesn't open, has expired, or isn't
// one at all, opens as null: the caller refuses it, and nothing says why.

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The format's version, its first segment. */
const VERSION = 'ks1';
/** What every data key is bound to, as KMS's encryption context. */
const CONTEXT = { service: 'kanon-status' };
/** The data keys of other containers kept, at most. */
const MAX_KEYS = 32;
/** A base64url segment. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** KMS's answers for a data key it won't open: not its ciphertext, or not under this key. */
const UNOPENABLE = new Set(['InvalidCiphertextException', 'IncorrectKeyException', 'NotFoundException', 'ValidationException']);

/**
 * @typedef {{
 *   seal: (kind: string, audience: string, payload: Record<string, unknown>, expiresAt: number | null) => Promise<string>,
 *   open: (kind: string, audience: string, sealed: unknown, now: number) => Promise<Record<string, any> | null>,
 * }} Sealer `expiresAt` and `now` are Unix seconds; `null` never expires
 */

/**
 * A sealer under the KMS key `keyId`.
 * @param {{ kms: import('./kms.mjs').Kms, keyId: string }} args
 * @returns {Sealer}
 */
export function sealer({ kms, keyId }) {
  /** @type {Promise<{ key: Buffer, wire: string }> | null} */
  let current = null;
  /** @type {Map<string, Promise<Buffer | null>>} each data key by its KMS ciphertext, base64url */
  const known = new Map();

  const ownKey = () => {
    current ??= kms.generateDataKey({ keyId, context: CONTEXT }).then(({ plaintext, blob }) => {
      const wire = blob.toString('base64url');
      known.set(wire, Promise.resolve(plaintext));
      return { key: plaintext, wire };
    }, (e) => {
      current = null;
      throw e;
    });
    return current;
  };

  /** @param {string} wire @returns {Promise<Buffer | null>} */
  const keyOf = (wire) => {
    let key = known.get(wire);
    if (!key) {
      if (known.size >= MAX_KEYS) known.delete(/** @type {string} */ (known.keys().next().value));
      key = kms.decrypt({ keyId, blob: Buffer.from(wire, 'base64url'), context: CONTEXT }).catch((e) => {
        known.delete(wire);
        if (UNOPENABLE.has(/** @type {any} */ (e)?.code)) return null;
        throw e;
      });
      known.set(wire, key);
    }
    return key;
  };

  const aad = (/** @type {string} */ kind, /** @type {string} */ audience) => Buffer.from(`${VERSION}|${kind}|${audience}`, 'utf8');

  return {
    async seal(kind, audience, payload, expiresAt) {
      const { key, wire } = await ownKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(kind, audience));
      const text = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp: expiresAt }), 'utf8'), cipher.final()]);
      return [VERSION, wire, iv.toString('base64url'), text.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },

    async open(kind, audience, sealed, now) {
      if (typeof sealed !== 'string' || sealed.length > 16_384) return null;
      const parts = sealed.split('.');
      if (parts.length !== 5 || parts[0] !== VERSION || !parts.slice(1).every((p) => SEGMENT.test(p))) return null;
      const [, wire, iv, text, tag] = /** @type {[string, string, string, string, string]} */ (parts);
      const ivBytes = Buffer.from(iv, 'base64url');
      const tagBytes = Buffer.from(tag, 'base64url');
      if (ivBytes.length !== 12 || tagBytes.length !== 16) return null;
      const key = await keyOf(wire);
      if (!key) return null;
      /** @type {any} */
      let payload;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, ivBytes);
        decipher.setAAD(aad(kind, audience));
        decipher.setAuthTag(tagBytes);
        payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(text, 'base64url')), decipher.final()]).toString('utf8'));
      } catch {
        return null;
      }
      if (payload === null || typeof payload !== 'object') return null;
      if (payload.exp !== null && !(typeof payload.exp === 'number' && now < payload.exp)) return null;
      return payload;
    },
  };
}
