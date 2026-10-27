// The hosted status server's AWS calls (project #1327): one JSON request to a service's endpoint
// in the function's region, with the function's own credentials, which Lambda puts in its
// environment. Over HTTPS with the telemetry function's SigV4 signer, imported rather than copied
// (decision 11: `node:` built-ins only, no SDK). `kms.mjs` and `ssm.mjs` are its two callers.
//
// A FAILED CALL NAMES THE OPERATION AND AWS'S ERROR CODE ONLY: nothing of AWS's message is kept,
// so nothing of a request reaches a log through one.

import { sign } from '../../telemetry/function/sigv4.mjs';

/**
 * @typedef {{ AWS_REGION?: string, AWS_ACCESS_KEY_ID?: string, AWS_SECRET_ACCESS_KEY?: string, AWS_SESSION_TOKEN?: string }} AwsEnv
 */

/**
 * A caller of one AWS JSON 1.1 service: `call(op, body)` posts `body` as `<target>.<op>` and
 * answers AWS's JSON, or throws `fail(op, code)`.
 * @param {AwsEnv} env
 * @param {{ service: string, target: string, fail: (op: string, code: string) => Error }} api
 * @param {typeof fetch} [fetchImpl]
 */
export function jsonCaller(env, { service, target, fail }, fetchImpl = fetch) {
  const region = env.AWS_REGION ?? 'eu-central-1';
  const url = `https://${service}.${region}.amazonaws.com/`;
  /** @param {string} op @param {Record<string, unknown>} body @returns {Promise<any>} */
  return async (op, body) => {
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `${target}.${op}` };
    const credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '', sessionToken: env.AWS_SESSION_TOKEN };
    const res = await fetchImpl(url, { method: 'POST', headers: { ...headers, ...sign({ method: 'POST', url, headers, body: text, region, service, credentials }) }, body: text });
    /** @type {any} */
    let json;
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    if (!res.ok) throw fail(op, String(json?.__type ?? `HTTP${res.status}`).split('#').pop() ?? 'unknown');
    return json;
  };
}
