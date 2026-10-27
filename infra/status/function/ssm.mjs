// The hosted status server's one SSM call (project #1327, Issue I): `GetParameter`, decrypted, for
// the status App's client secret. The Owner puts it by hand as a `SecureString` under the
// AWS-managed `aws/ssm` key, and the template names only the parameter, so the secret is in no
// template, stack parameter, function configuration or deploy (the Owner's Q1, 2026-10-26). Over
// `aws.mjs`'s caller (decision 11: `node:` built-ins only, no SDK).
//
// AN ERROR NAMES THE OPERATION AND AWS'S ERROR CODE ONLY, as `kms.mjs`'s does.

import { jsonCaller } from './aws.mjs';

/** A failed SSM call: `code` is AWS's error code (`ParameterNotFound`, …). */
export class SsmError extends Error {
  /** @param {string} op @param {string} code */
  constructor(op, code) {
    super(`SSM ${op} failed: ${code}`);
    this.name = 'SsmError';
    this.code = code;
  }
}

/**
 * SSM in the function's region, with the function's own credentials.
 * @param {import('./aws.mjs').AwsEnv} env
 * @param {typeof fetch} [fetchImpl]
 */
export function ssmOf(env, fetchImpl = fetch) {
  const call = jsonCaller(env, { service: 'ssm', target: 'AmazonSSM', fail: (op, code) => new SsmError(op, code) }, fetchImpl);
  return {
    /** A parameter's value, decrypted. @param {string} name @returns {Promise<string>} */
    getParameter: async (name) => {
      const r = await call('GetParameter', { Name: name, WithDecryption: true });
      const value = r?.Parameter?.Value;
      if (typeof value !== 'string' || !value) throw new SsmError('GetParameter', 'EmptyParameter');
      return value;
    },
  };
}
