// The hosted status server's Lambda entry point (project #1327, Issue I): `handler`, which the
// template names as `infra/status/function/handler.handler`. It builds `serve`'s deps once per
// container, from the environment the template sets, and hands every request to `serve`.
//
// THE CLIENT SECRET IS READ ONCE, AT A CONTAINER'S FIRST REQUEST, from the SSM parameter the
// template names, and kept in memory only (the Owner's Q1, 2026-10-26). A read that fails answers
// 500 and is tried again on the next request. It is logged as one line holding AWS's error code
// and nothing else: never AWS's message, the parameter's name or anything it holds (`[MCP-8]`).
// So a deploy whose secret can't be read fails its smoke, whose unauthenticated `tools/list`
// gets 500 rather than 401.
//
// The key's id, the client id, the parameter's name, the redirect allow-list and the release come
// from the environment; nothing secret does.

import { performance } from 'node:perf_hooks';
import { redirectsFrom, serve } from './auth.mjs';
import { kmsOf } from './kms.mjs';
import { logLine } from './log.mjs';
import { sealer } from './seal.mjs';
import { ssmOf } from './ssm.mjs';

/** The environment the template sets, by what each holds. */
export const ENV = {
  keyId: 'KEY_ID',
  clientId: 'GITHUB_CLIENT_ID',
  secretParameter: 'CLIENT_SECRET_PARAMETER',
  redirects: 'REDIRECTS',
  release: 'RELEASE',
};

/** AWS's shape of an error code, the only part of a failure that is logged. */
const CODE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * `serve`'s deps, from the environment: a sealer under the stack's key, and the client secret
 * from SSM. Refuses an environment the template didn't set, with code `Unconfigured`, before any
 * read.
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {Promise<import('./auth.mjs').ServeDeps>}
 */
export async function depsFrom(env, { fetch: fetchImpl = fetch } = {}) {
  const keyId = env[ENV.keyId];
  const clientId = env[ENV.clientId];
  const parameter = env[ENV.secretParameter];
  if (!keyId || !clientId || !parameter) throw Object.assign(new Error('the function is unconfigured'), { code: 'Unconfigured' });
  const clientSecret = await ssmOf(env, fetchImpl).getParameter(parameter);
  return {
    clientId,
    clientSecret,
    sealer: sealer({ kms: kmsOf(env, fetchImpl), keyId }),
    redirects: redirectsFrom(env[ENV.redirects]),
    release: env[ENV.release] || 'unreleased',
  };
}

/**
 * A Lambda handler over `env`, which builds its deps at its first request and keeps them.
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof fetch, log?: (line: string) => void }} [options]
 */
export function handlerOf(env, options = {}) {
  const log = options.log ?? ((/** @type {string} */ line) => console.log(line));
  /** @type {Promise<import('./auth.mjs').ServeDeps> | null} */
  let deps = null;
  /** @param {any} event */
  return async (event) => {
    const started = performance.now();
    deps ??= depsFrom(env, options).catch((/** @type {any} */ e) => {
      deps = null;
      throw e;
    });
    /** @type {import('./auth.mjs').ServeDeps} */
    let ready;
    try {
      ready = await deps;
    } catch (e) {
      const code = String(/** @type {any} */ (e)?.code ?? '');
      log(JSON.stringify({ startup: 'client_secret', code: CODE.test(code) ? code : 'unknown' }));
      log(logLine({ route: String(event?.rawPath ?? ''), method: null, tool: null, outcome: 'error', durationMs: performance.now() - started, githubRequests: 0, rateLimitRemaining: null }));
      return { statusCode: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: 'server_error' }) };
    }
    return serve(event, { ...ready, log, ...(options.fetch ? { fetch: options.fetch } : {}) });
  };
}

/** The function's handler, over Lambda's environment. */
export const handler = handlerOf(process.env);
