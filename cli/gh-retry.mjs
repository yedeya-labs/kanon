// Retrying `gh` when GitHub limits the rate or fails (kanon#1607, point 9).
//
// A burst of writes, such as `kanon init` creating 39 labels one after another, can meet
// GitHub's secondary rate limit: a 403 (or a 429) whose message says so. `gh` prints that
// message on standard error, with the status, and nothing of the `retry-after` header, so the
// message is what tells a rate limit from a permission the token lacks. A 5xx is GitHub failing,
// not the token either. So `withRetry` wraps a `gh` runner: it spaces writes out, about a second
// apart, and runs a call again, with a growing wait, while its answer is a secondary rate limit,
// a 429, a 5xx or a timeout. What still fails after the retries is reported by the caller as
// GitHub limiting the rate, never as a missing permission (`transient`).
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { setTimeout } from 'node:timers';

/** @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult */
/** @typedef {(args: string[], input?: string) => Promise<GhResult>} Gh */

/** How many times a call is run again after its first answer. */
export const RETRIES = 3;

/** The waits before each retry: a rate limit's, then GitHub failing's, in milliseconds. */
export const RATE_WAITS = [10_000, 30_000, 60_000];
export const SERVER_WAITS = [1_000, 2_000, 4_000];

/** How far apart writes start, in milliseconds. */
export const WRITE_PACE = 1_000;

/** A secondary rate limit, a 429, or GitHub failing: an answer worth asking again. @param {string} stderr */
export const retryable = (stderr) => /secondary rate limit|abuse detection|retry-after|HTTP 429|HTTP 50[0-4]|timed? ?out/i.test(stderr);

/** A rate limit of either kind, the primary one included. @param {string} stderr */
export const rateLimited = (stderr) => /rate limit|abuse detection|retry-after|HTTP 429/i.test(stderr);

/**
 * Whether a failed answer is GitHub limiting the rate or failing, not the token: a rate limit of
 * either kind, a 429, a 5xx or a timeout. A 403 or 404 without such a marker is the token's.
 * @param {string} stderr
 */
export const transient = (stderr) => retryable(stderr) || rateLimited(stderr);

/** What a step says when its last answer was `transient`. */
export const TRANSIENT_WHY = 'GitHub limited the rate (or failed); run kanon init again';

/**
 * Why the writes whose stderr `answers` holds failed (kanon#1607): `transient` when every one is
 * GitHub limiting the rate or failing (cli/gh-retry.mjs), `permission` on a 403 without a
 * rate-limit marker or a 404, or when no call was made; `other` for any other refusal.
 * @param {string[]} answers
 * @returns {'transient' | 'permission' | 'other'}
 */
export const failureCause = (answers) =>
  !answers.length ? 'permission'
  : answers.every((e) => transient(e)) ? 'transient'
  : answers.some((e) => !transient(e) && /\bHTTP 40[34]\b|Resource not accessible|Not Found/i.test(e)) ? 'permission'
  : 'other';

/** The first non-empty line of the first answer, for a step. @param {string[]} answers */
export const firstLine = (answers) => (answers.find((a) => a.trim()) ?? '').trim().split('\n')[0]?.slice(0, 200) ?? '';

const WRITE_VERBS = /^(create|edit|delete|set|remove|add|close|reopen|merge|comment)$/;

/**
 * Whether a `gh` call writes: `gh api` with a method other than GET, or with fields or input
 * and no method (which `gh api` sends as POST), or a subcommand such as `gh label create`.
 * @param {string[]} args
 */
export const writes = (args) => {
  if (args[0] !== 'api') return WRITE_VERBS.test(args[1] ?? '');
  const at = args.findIndex((a) => a === '-X' || a === '--method');
  const inline = args.find((a) => a.startsWith('--method='))?.slice('--method='.length);
  const method = inline ?? (at >= 0 ? args[at + 1] : undefined);
  if (method !== undefined) return method.toUpperCase() !== 'GET';
  return args.some((a) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a));
};

/**
 * Whether a write's answer says the thing it creates is there already: `gh label create`'s
 * `already exists`, or a 422 whose body names `already_exists` (kanon#1622). Sent again after a
 * 5xx or a timeout, a create GitHub had committed gets this answer.
 * @param {GhResult} r
 */
export const alreadyExists = (r) => /already[ _]exists/i.test(`${r.stderr}\n${r.stdout}`);

/**
 * Whether a write may be sent again after a 5xx or a timeout, when GitHub may have committed it:
 * a PUT, PATCH or DELETE, which do the same twice; a create whose duplicate GitHub refuses as
 * `already exists` (`gh label create`, a milestone's POST); or `gh secret set` and `gh variable
 * set`, which overwrite. Any other create, such as a ruleset's POST, could make a second one, so
 * it is retried only on a rate limit, which GitHub refused before doing anything (kanon#1622).
 * @param {string[]} args
 */
export const resendable = (args) => {
  if (args[0] !== 'api') return (args[0] === 'label' && args[1] === 'create') || ['set', 'delete', 'remove'].includes(args[1] ?? '');
  const at = args.findIndex((a) => a === '-X' || a === '--method');
  const method = (args.find((a) => a.startsWith('--method='))?.slice('--method='.length) ?? (at >= 0 ? args[at + 1] : 'POST') ?? 'POST').toUpperCase();
  if (['PUT', 'PATCH', 'DELETE'].includes(method)) return true;
  // A write here is a POST, by elimination.
  return args.some((a) => /^repos\/[^/]+\/[^/]+\/milestones$/.test(a));
};

/** Marks a runner `withRetry` built, so a test can tell. */
export const RETRYING = Symbol('kanon.gh-retry');

/**
 * `gh` with writes spaced out and transient answers asked again. Two rules keep a run short and
 * honest (kanon#1622):
 *
 * - **A rate limit that outlasts the retries ends the waiting.** Once one call has used up its
 *   retries on a rate limit, each call after it is tried once, with no backoff, until one
 *   succeeds: a limit that persists would otherwise cost every remaining call the full backoff,
 *   most of an hour for init's labels. The answer it gives is still the rate limit's, so the step
 *   says to run again, never a permission.
 * - **A create sent again isn't refused for having worked.** A write that got a 5xx or a timeout,
 *   then `already exists` on its retry, had been committed the first time: the answer counts as
 *   success. A write whose second copy could do more than the first (`resendable`) isn't sent
 *   again after a 5xx or a timeout at all.
 * @param {Gh} gh
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, progress?: (line: string) => void, pace?: number }} [o]
 * @returns {Gh}
 */
export const withRetry = (gh, o = {}) => {
  const sleep = o.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = o.now ?? Date.now;
  const pace = o.pace ?? WRITE_PACE;
  let lastWrite = -Infinity;
  /** Whether a call has used up its retries on a rate limit, since the last success. */
  let limited = false;
  /** @type {Gh} */
  const run = async (args, input) => {
    const write = writes(args);
    /** @type {GhResult} */
    let r = { status: null, stdout: '', stderr: '' };
    /** Whether an earlier try of this call failed in a way that may have committed it. */
    let unsure = false;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      if (write) {
        const wait = lastWrite + pace - now();
        if (wait > 0) await sleep(wait);
        lastWrite = now();
      }
      r = await gh(args, input);
      if (r.status !== 0 && write && unsure && alreadyExists(r)) r = { status: 0, stdout: r.stdout, stderr: '' };
      if (r.status === 0) {
        limited = false;
        break;
      }
      if (!retryable(r.stderr)) break;
      if (write && !rateLimited(r.stderr) && !resendable(args)) break;
      if (rateLimited(r.stderr) && (limited || attempt === RETRIES)) {
        limited = true;
        break;
      }
      if (attempt === RETRIES) break;
      if (!rateLimited(r.stderr)) unsure = true;
      const ms = (rateLimited(r.stderr) ? RATE_WAITS : SERVER_WAITS)[attempt] ?? 0;
      o.progress?.(`GitHub ${rateLimited(r.stderr) ? 'asked to slow down' : 'failed'} (${r.stderr.trim().split('\n')[0]?.slice(0, 120)}); trying again in ${Math.round(ms / 1000)} s.`);
      await sleep(ms);
    }
    return r;
  };
  return Object.assign(run, { [RETRYING]: true });
};
