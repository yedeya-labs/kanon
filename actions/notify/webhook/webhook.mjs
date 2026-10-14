// Kanon's generic webhook hook (plan 0011 §7.3): one Kanon notification, posted as the contract's
// own JSON to one URL, for any system that can take a JSON body at a URL: a receiver of the
// adopter's own, a workflow tool, a relay to another chat system.
//
// WHERE IT RUNS. In the `notify` job only (plan 0011 §5), through the hook an adopter keeps at
// `.github/actions/notify/action.yml`, which `kanon init --chat webhook` writes from
// `actions/notify/hooks/webhook.yml`: that file's one step is this action, at a Kanon release. It
// reads the hook interface's four inputs (§6.1) and nothing else, through the environment:
// `MESSAGE_FILE` (`message-v1`), `TEXT_FILE` (`text`, unused: the receiver gets the message
// itself and can compute any text it needs), `KIND` and `SECRET`.
//
// THE BODY IS THE MESSAGE, BYTE FOR BYTE. The `notify` block validated the message and wrote it to
// `message-v1`; this hook posts that file's contents as they are, so a receiver can validate what it
// gets against `docs/notify/message-v1.schema.json`. Nothing is rendered and nothing is escaped:
// the receiver gets Kanon text as Kanon text. The hook checks only that the file is a JSON object,
// and does not re-validate it, for the Slack hook's reason: a hook pinned at an older release may be
// handed a message with an additive field, and must post a kind it doesn't know (§3.4).
//
// ONE URL, THE ONE IT IS GIVEN. `secret` is one `https://` URL of at most 2,000 characters; anything
// else is refused by name, never echoed. Routing is by the kind's secret, as with Slack. A redirect
// is not followed, so the URL is never re-sent to a host it doesn't name.
//
// NO SIGNATURE in version 1 (decision 20): the URL is the secret, as Slack's is. Signing may come
// later as an optional input, which is additive.
//
// ERRORS name the status alone: never the URL, and never the response body, which a receiver Kanon
// knows nothing about could fill with anything. A 429 is retried once, as the Slack hook's is.
//
// Needs Node 20 or later (for `fetch`), and no dependencies.

import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { URL } from 'node:url';
import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';
import { retryAfter } from '../slack/slack.mjs';

/** The longest URL the hook posts to (§7.3). */
export const URL_MAX = 2000;

/** The only headers the request carries: nothing that identifies the adopter beyond the message's own `source`. */
export const HEADERS = Object.freeze({ 'Content-Type': 'application/json', 'User-Agent': 'kanon-notify/1' });

const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** A failure the hook reports as it is: its message never holds the URL, a response body or the message's text. */
export class HookError extends Error {}

/**
 * The URL in `secret`, or the refusal. The refusal names the input, never its value.
 * @param {unknown} secret
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function urlOf(secret) {
  const url = str(secret).trim();
  if (url === '') return { ok: false, reason: 'The secret input is empty: there is no URL to post to.' };
  if ([...url].length > URL_MAX) return { ok: false, reason: `The secret input is longer than ${URL_MAX} characters, so Kanon's generic webhook hook won't post to it.` };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed === null || parsed.protocol !== 'https:' || !/^https:\/\//i.test(url) || /\s/.test(url)) {
    return { ok: false, reason: "The secret input is not an https:// URL, so Kanon's generic webhook hook won't post to it: store the receiver's https URL in this kind's secret." };
  }
  return { ok: true, url };
}

/**
 * @typedef {{
 *   fetch: (url: string, init: { method: string, headers: Record<string, string>, body: string, redirect: 'manual' }) => Promise<{ status: number, headers: { get(name: string): string | null } }>,
 *   sleep: (ms: number) => Promise<void>,
 * }} Io
 */

/**
 * POST the body to the URL. Retries once on a 429 whose `Retry-After` is at most 60 seconds; a
 * redirect is not followed and fails. Throws a `HookError` naming the status alone. The response
 * body is never read.
 * @param {string} url
 * @param {string} body
 * @param {Io} io
 */
export async function post(url, body, io) {
  const init = /** @type {const} */ ({ method: 'POST', headers: { ...HEADERS }, body, redirect: 'manual' });
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await io.fetch(url, init);
    } catch (e) {
      const code = /** @type {any} */ (e)?.cause?.code;
      throw new HookError(`The request to the webhook failed${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}.`);
    }
    if (res.status >= 200 && res.status < 300) return { attempts: attempt, status: res.status };
    if (res.status === 429 && attempt === 1) {
      const seconds = retryAfter(res.headers.get('retry-after'));
      if (seconds !== null) { await io.sleep(seconds * 1000); continue; }
    }
    // `redirect: 'manual'` in Node answers a redirect with its 3xx status (or 0, opaque, in a browser).
    const redirect = (res.status >= 300 && res.status < 400) || res.status === 0;
    throw new HookError(`The webhook refused the message: HTTP ${res.status}${redirect ? ', a redirect, which the hook does not follow' : ''}.`);
  }
}

/**
 * The action: read the inputs, refuse a URL that isn't https, post the message as it is. Returns
 * the exit code.
 * @param {{ env: Record<string, string | undefined>, io: Io, readFile?: (path: string) => string, out?: { log: (s: string) => void, error: (s: string) => void } }} args
 */
export async function main({ env, io, readFile = (p) => readFileSync(p, 'utf8'), out = console }) {
  const fail = (/** @type {string} */ why) => { out.error(`::error title=Kanon's generic webhook hook::${why}`); return 1; };
  const target = urlOf(env.SECRET);
  if (!target.ok) return fail(target.reason);
  if (!env.MESSAGE_FILE) return fail('The message-v1 input is empty: there is no message to post.');
  let body;
  /** @type {unknown} */
  let message;
  try {
    body = readFile(env.MESSAGE_FILE);
    message = JSON.parse(body);
  } catch {
    return fail('The message-v1 input is not a readable JSON file.');
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return fail('The message-v1 input is not a JSON object.');
  try {
    const { attempts, status } = await post(target.url, body, io);
    out.log(`Posted the ${str(env.KIND) || 'Kanon'} message to the webhook: HTTP ${status}${attempts > 1 ? ', after one retry' : ''}.`);
    return 0;
  } catch (e) {
    if (e instanceof HookError) return fail(e.message);
    return fail('The post to the webhook failed.');
  }
}

if (isCliEntry(import.meta.url)) {
  const io = /** @type {Io} */ ({ fetch: globalThis.fetch, sleep: (ms) => wait(ms).then(() => undefined) });
  process.exitCode = await main({ env: process.env, io });
}
