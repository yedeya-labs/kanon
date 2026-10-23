#!/usr/bin/env node
// Is this a fork's pull request event, run in the fork's context? (kanon#1331)
//
// Merge reconcile and the Lead reconcile listen on `pull_request: closed`, and merge reconcile on
// `pull_request_review` too. For a pull request whose head is on a fork, GitHub runs those
// events in the fork's context: a read-only workflow token and NO secrets, whoever merged or
// reviewed it (measured on #1331). A lane that went on from there would mint its App token from
// empty secrets and fail red, and the merge would stay unreconciled. So both lanes ask this
// script after the membership gate, and before anything else, and skip on `fork=true`, with a
// notice naming the way the merge still gets reconciled from the default branch, where the
// secrets are:
//   merge-reconcile  dispatch the caller with `pr_number` (`gh workflow run`, whose default
//                    `--ref` is the default branch). The dispatch reads the pull request
//                    through the API, so a fork's is reconciled like any other.
//   lead-reconcile   the hourly schedule picks the merge up; a dispatch runs it sooner.
//
// A FORK, HERE, is a pull request whose `head.repo.full_name` is not this repository, compared
// without case, or whose head repository is gone (`head.repo: null`, a deleted fork). Every
// other event, and a pull request whose head is on this repository, is `fork=false`, so a
// same-repository pull request goes on exactly as before.
//
// Usage: node scripts/fork-event.mjs <merge-reconcile|lead-reconcile>
// Env: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF (the caller's,
// in a called workflow, named in the notice), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Writes
// `fork=true|false` to GITHUB_OUTPUT. Node built-ins only: it runs in a filter job with no install.

import { appendFileSync, readFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { callerFileOf } from './reask-due.mjs';

/** The events whose payload carries the pull request, and which GitHub runs in a fork's context. */
export const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_review'];

/**
 * The fork a pull request event's head is on, or null when it is not a fork's (or not a pull
 * request event at all).
 *
 * @param {string} eventName
 * @param {{ pull_request?: { head?: { repo?: { full_name?: string } | null } } }} event
 * @param {string} repo `owner/name` of this repository
 * @returns {string | null} the fork's `owner/name`, or `a deleted fork` when its repository is gone
 */
export function forkOf(eventName, event, repo) {
  if (!PULL_REQUEST_EVENTS.includes(eventName)) return null;
  const pr = event?.pull_request;
  if (!pr?.head) return null;
  const head = pr.head.repo?.full_name;
  if (!head) return 'a deleted fork';
  return head.toLowerCase() === repo.toLowerCase() ? null : head;
}

/**
 * The notice a skipped lane leaves, naming how the merge is still reconciled.
 *
 * @param {'merge-reconcile' | 'lead-reconcile'} lane
 * @param {{ fork: string, number?: number, caller?: string | null }} at
 */
export function noticeFor(lane, { fork, number, caller }) {
  const pr = number ? `#${number}` : 'this pull request';
  const file = caller ?? '<caller>.yml';
  const head = fork === 'a deleted fork' ? 'on a deleted fork' : `on a fork, ${fork}`;
  const context = `The head of ${pr} is ${head}, so GitHub runs this event in the fork's context, with no secrets. This run skips before minting any App token.`;
  if (lane === 'merge-reconcile') {
    return `${context} To reconcile it, dispatch merge reconcile from the default branch, where the secrets are: gh workflow run ${file} -f pr_number=${number ?? '<number>'}`;
  }
  return `${context} The Lead reconcile's hourly schedule picks the merge up from the default branch, where the secrets are. To run it sooner: gh workflow run ${file}`;
}

/** @param {Record<string, string | undefined>} [env] @param {string[]} [argv] @returns {number} */
export function main(env = process.env, argv = process.argv.slice(2)) {
  const lane = argv[0];
  if (lane !== 'merge-reconcile' && lane !== 'lead-reconcile') {
    console.error('usage: fork-event.mjs <merge-reconcile|lead-reconcile>');
    return 2;
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('fork-event: GITHUB_REPOSITORY must be set; the runner sets it');
    return 2;
  }
  const eventName = env.GITHUB_EVENT_NAME ?? '';
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const fork = forkOf(eventName, event, repo);
  /** @param {string} name @param {string} value */
  const output = (name, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  if (!fork) {
    output('fork', 'false');
    return 0;
  }
  const line = noticeFor(lane, { fork, number: event.pull_request?.number, caller: callerFileOf(env.GITHUB_WORKFLOW_REF) });
  output('fork', 'true');
  console.log(`::notice title=Fork pull request::${line}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `**Skipped: a fork's pull request** ([#1331](https://github.com/yedeya-labs/kanon/issues/1331)). ${line}\n`);
  return 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = main();
