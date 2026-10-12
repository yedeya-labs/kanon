// Check the Claude credential before the agent starts (plan 0009 §10, step A1).
//
// A lane's caller maps exactly one of two secrets: `CLAUDE_CODE_OAUTH_TOKEN`, the subscription
// token `claude setup-token` makes, or `ANTHROPIC_API_KEY`, a key from the Claude Console. The lane
// hands each down by its own name to `agent-run`, as `claude-token` and `anthropic-api-key`, and
// this script reads both from its environment. It fails, before the agent starts and naming the
// secret:
//   - when both are set, or neither is;
//   - when the one that is set carries the other credential's fixed prefix, such as an API key
//     stored as the token.
// Otherwise it writes `auth=subscription` or `auth=api-key` to `$GITHUB_OUTPUT`, for the run's
// telemetry row (plan 0009 §12).
//
// NEVER A VALUE. Every message names a secret and nothing it holds: not the value, not its
// length, not the prefix found. GitHub masks both as secrets, and this holds without the mask.
//
// THE PREFIXES ARE NOT RUN. Plan 0009 step A0 measures both against a real token and a real key;
// until it does, these are the publicly documented forms (`sk-ant-oat…` for a subscription token,
// `sk-ant-api…` for an API key). So the shape check only rejects a value that carries the OTHER
// credential's prefix: a value with neither prefix passes, so a wrong guess here can't stop a
// caller that works today. A0 may tighten it to require each value's own prefix.
//
// Inputs, by environment only: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_OUTPUT.

import { appendFileSync } from 'node:fs';

import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

const TOKEN = Object.freeze({ secret: 'CLAUDE_CODE_OAUTH_TOKEN', input: 'claude-token', auth: 'subscription', prefix: 'sk-ant-oat', what: 'a Claude subscription token' });
const API_KEY = Object.freeze({ secret: 'ANTHROPIC_API_KEY', input: 'anthropic-api-key', auth: 'api-key', prefix: 'sk-ant-api', what: 'an Anthropic API key' });

/** The two credentials: the secret a caller maps, the input it reaches `agent-run` by, its `auth`. */
export const CREDENTIALS = Object.freeze([TOKEN, API_KEY]);

const TITLE = 'title=claude-credential';

/**
 * Decide which credential the run uses, or why it can't start.
 * @param {{ token?: string, apiKey?: string }} values the two secrets' values, empty when unmapped
 * @returns {{ ok: true, auth: 'subscription' | 'api-key', message: string } | { ok: false, message: string }}
 */
export function checkCredential({ token = '', apiKey = '' }) {
  if (token !== '' && apiKey !== '') {
    return { ok: false, message: `::error ${TITLE}::The caller maps both ${TOKEN.secret} and ${API_KEY.secret}; map one. The lane runs on exactly one Claude credential.` };
  }
  if (token === '' && apiKey === '') {
    return { ok: false, message: `::error ${TITLE}::No Claude credential: the caller maps neither ${TOKEN.secret} nor ${API_KEY.secret}, or maps an empty secret. Map one.` };
  }
  const [cred, other, value] = token !== '' ? [TOKEN, API_KEY, token] : [API_KEY, TOKEN, apiKey];
  if (value.startsWith(other.prefix)) {
    return { ok: false, message: `::error ${TITLE}::${cred.secret} holds what looks like ${other.what}. Store it as ${other.secret} and map that instead, or store ${cred.what} as ${cred.secret}.` };
  }
  return { ok: true, auth: cred.auth, message: `The agent runs on ${cred.secret} (${cred.auth}).` };
}

if (isCliEntry(import.meta.url)) {
  const result = checkCredential({
    token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  });
  console.log(result.message);
  if (!result.ok) process.exit(1);
  appendFileSync(String(process.env.GITHUB_OUTPUT), `auth=${result.auth}\n`);
}
