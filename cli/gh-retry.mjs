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

/** Marks a runner `withRetry` built, so a test can tell. */
export const RETRYING = Symbol('kanon.gh-retry');

/**
 * `gh` with writes spaced out and transient answers asked again.
 * @param {Gh} gh
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, progress?: (line: string) => void, pace?: number }} [o]
 * @returns {Gh}
 */
export const withRetry = (gh, o = {}) => {
  const sleep = o.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const now = o.now ?? Date.now;
  const pace = o.pace ?? WRITE_PACE;
  let lastWrite = -Infinity;
  /** @type {Gh} */
  const run = async (args, input) => {
    const write = writes(args);
    /** @type {GhResult} */
    let r = { status: null, stdout: '', stderr: '' };
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      if (write) {
        const wait = lastWrite + pace - now();
        if (wait > 0) await sleep(wait);
        lastWrite = now();
      }
      r = await gh(args, input);
      if (r.status === 0 || !retryable(r.stderr) || attempt === RETRIES) break;
      const ms = (rateLimited(r.stderr) ? RATE_WAITS : SERVER_WAITS)[attempt] ?? 0;
      o.progress?.(`GitHub ${rateLimited(r.stderr) ? 'asked to slow down' : 'failed'} (${r.stderr.trim().split('\n')[0]?.slice(0, 120)}); trying again in ${Math.round(ms / 1000)} s.`);
      await sleep(ms);
    }
    return r;
  };
  return Object.assign(run, { [RETRYING]: true });
};
