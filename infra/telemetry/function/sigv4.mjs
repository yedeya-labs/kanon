// AWS Signature Version 4, with `node:` built-ins only (plan 0002 §4: no SDK, no new
// dependency). The ingest function signs its DynamoDB `PutItem` with it, and the verify script
// signs its calls to the function URL. Its test checks it against AWS's published example.

import { createHash, createHmac } from 'node:crypto';
import { URL } from 'node:url';

/** @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} Credentials */

const sha256 = (/** @type {string} */ s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (/** @type {string | Buffer} */ key, /** @type {string} */ s) => createHmac('sha256', key).update(s, 'utf8').digest();
/** RFC 3986 encoding, which is what SigV4 asks for. */
const encode = (/** @type {string} */ s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The headers that sign one request. The caller sends them with its own.
 *
 * @param {{
 *   method: string, url: string, headers?: Record<string, string>, body?: string,
 *   region: string, service: string, credentials: Credentials, now?: Date,
 * }} req
 * @returns {Record<string, string>}
 */
export function sign({ method, url, headers = {}, body = '', region, service, credentials, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  /** @type {Record<string, string>} */
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  h.host = u.host;
  h['x-amz-date'] = amzDate;
  if (credentials.sessionToken) h['x-amz-security-token'] = credentials.sessionToken;

  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(h[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams]
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join('&');
  // Every service but S3 encodes each path segment twice; the pathname is already encoded once.
  const path = u.pathname.split('/').map(encode).join('/') || '/';
  const canonical = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256(body)].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');

  /** @type {Record<string, string>} */
  const out = { ...h };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
