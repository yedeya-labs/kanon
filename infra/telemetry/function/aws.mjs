// The ingest function's three AWS calls, over HTTPS with the signer beside this file (plan 0002
// §4: `node:` built-ins only, no SDK): DynamoDB, STS's `AssumeRole` for the self-read session
// (plan 0008 §3.5), and Lambda's asynchronous `Invoke` of the function's own `erase` alias (§7).
//
// AN ERROR NAMES THE OPERATION AND AWS'S ERROR CODE ONLY. A DynamoDB `ValidationException` can
// quote the request, and the request can hold a key, so nothing of AWS's message is kept.

import { URLSearchParams } from 'node:url';
import { sign } from './sigv4.mjs';

/** @typedef {import('./sigv4.mjs').Credentials} Credentials */
/** @typedef {(op: string, body: Record<string, any>, credentials?: Credentials) => Promise<any>} Dynamo */

/** A failed AWS call: `code` is AWS's error code (`ConditionalCheckFailedException`, …), `reasons` a cancelled transaction's. */
export class AwsError extends Error {
  /** @param {string} op @param {string} code @param {string[]} [reasons] */
  constructor(op, code, reasons = []) {
    super(`${op} failed: ${code}`);
    this.code = code;
    this.reasons = reasons;
  }
}

const regionOf = (/** @type {{ AWS_REGION?: string }} */ env) => env.AWS_REGION ?? 'eu-central-1';

/** The function's own credentials, which Lambda puts in its environment. @returns {Credentials} */
export const ownCredentials = () => ({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  sessionToken: process.env.AWS_SESSION_TOKEN,
});

/**
 * One DynamoDB call. Answers the parsed body; throws an `AwsError` naming the operation and code.
 * @param {{ AWS_REGION?: string }} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Dynamo}
 */
export function dynamoOf(env, fetchImpl = fetch) {
  return async (op, body, credentials = ownCredentials()) => {
    const region = regionOf(env);
    const url = `https://dynamodb.${region}.amazonaws.com/`;
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${op}` };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, ...sign({ method: 'POST', url, headers, body: text, region, service: 'dynamodb', credentials }) },
      body: text,
    });
    /** @type {any} */
    let json;
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    if (!res.ok) {
      const code = String(json?.__type ?? `HTTP${res.status}`).split('#').pop() ?? 'unknown';
      const reasons = Array.isArray(json?.CancellationReasons) ? json.CancellationReasons.map((/** @type {any} */ r) => String(r?.Code ?? 'None')) : [];
      throw new AwsError(op, code, reasons);
    }
    return json;
  };
}

/** The XML element's text, for STS's answer. */
const element = (/** @type {string} */ xml, /** @type {string} */ name) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1];

/**
 * STS `AssumeRole` with a session policy (plan 0008 §3.5): the session can do only what both the
 * role's policy and this one allow.
 * @param {{ AWS_REGION?: string }} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {(req: { roleArn: string, sessionName: string, policy: object }) => Promise<Credentials>}
 */
export function stsOf(env, fetchImpl = fetch) {
  return async ({ roleArn, sessionName, policy }) => {
    const region = regionOf(env);
    const url = `https://sts.${region}.amazonaws.com/`;
    const body = new URLSearchParams({
      Action: 'AssumeRole', Version: '2011-06-15', RoleArn: roleArn, RoleSessionName: sessionName,
      Policy: JSON.stringify(policy), DurationSeconds: '900',
    }).toString();
    const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, ...sign({ method: 'POST', url, headers, body, region, service: 'sts', credentials: ownCredentials() }) },
      body,
    });
    const xml = await res.text();
    const accessKeyId = element(xml, 'AccessKeyId');
    const secretAccessKey = element(xml, 'SecretAccessKey');
    const sessionToken = element(xml, 'SessionToken');
    if (!res.ok || !accessKeyId || !secretAccessKey || !sessionToken) throw new AwsError('AssumeRole', element(xml, 'Code') ?? `HTTP${res.status}`);
    return { accessKeyId, secretAccessKey, sessionToken };
  };
}

/**
 * Lambda's asynchronous `Invoke` (`InvocationType: Event`) of a qualified function.
 * @param {{ AWS_REGION?: string }} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {(functionName: string, qualifier: string, payload: object) => Promise<void>}
 */
export function invokeOf(env, fetchImpl = fetch) {
  return async (functionName, qualifier, payload) => {
    const region = regionOf(env);
    const url = `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(functionName)}/invocations?Qualifier=${encodeURIComponent(qualifier)}`;
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'x-amz-invocation-type': 'Event' };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, ...sign({ method: 'POST', url, headers, body, region, service: 'lambda', credentials: ownCredentials() }) },
      body,
    });
    if (res.status !== 202) throw new AwsError('Invoke', `HTTP${res.status}`);
  };
}

// ------------------------------------------------------------------------- DynamoDB's form

/** A plain value in DynamoDB's attribute-value form, or undefined for none. @param {unknown} v @returns {any} */
export function attr(v) {
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(attr) };
  if (v && typeof v === 'object') return { M: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, attr(x)])) };
  return undefined;
}

/** An attribute value as a plain value. @param {any} a @returns {any} */
export function plain(a) {
  if (!a || typeof a !== 'object') return undefined;
  if ('S' in a) return a.S;
  if ('N' in a) return Number(a.N);
  if ('BOOL' in a) return a.BOOL;
  if ('L' in a) return a.L.map(plain);
  if ('M' in a) return Object.fromEntries(Object.entries(a.M).map(([k, x]) => [k, plain(x)]));
  if ('NULL' in a) return null;
  return undefined;
}

/** A plain object as an item, dropping undefined fields. @param {Record<string, unknown>} o */
export const itemOf = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, attr(v)]));

/** An item as a plain object. @param {Record<string, any> | undefined} item */
export const plainItem = (item) => (item ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, plain(v)])) : undefined);
