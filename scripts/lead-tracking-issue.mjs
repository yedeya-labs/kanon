#!/usr/bin/env node
// The brief lane's tracking issue, checked before any model call (kanon#1558, `K-AGENT-30`).
//
// The Lead writes a brief only for a project's tracking issue: the brief is named for its number,
// and the reconciler keys the whole project off it. A dispatch whose `context` named none ran the
// Lead anyway, and the prompt's "STOP and say so" ended the run green, with no pull request, no
// branch, no comment and a telemetry row saying `ok` (15 turns, about $0.66, found adopting Kanon
// in a new repository). Nobody who dispatched it could see why.
//
// So the lane's `filter` job runs this on the dispatch's `context`, and hands what it writes to
// the spine as `refusal`. `agent-run` fails on a refusal before the agent starts, as it does on a
// refused turn-limit raise, so the run is red, its error says what to do, and its telemetry row
// records `not-reached`. `context` is the lane's own input shape: issue numbers, comma-separated,
// the tracking issue's among them. Anything else is refused, and the refusal never repeats the
// value, so a context can't write a workflow command of its own.
//
// Writes `refusal` to `$GITHUB_OUTPUT`: empty for a context that names an issue, else the reason.
// Never fails the step: the refusal is `agent-run`'s to act on, where the cost row records it.
//
// Inputs, by environment only (`K-AGENT-45`): CONTEXT, GITHUB_OUTPUT.

import { appendFileSync } from 'node:fs';

import { isCliEntry } from './lib/cli-entry.mjs';

/** One issue number, with or without its `#`. */
const ISSUE = /^#?[1-9][0-9]*$/;

/** What to do, said in every refusal. */
const TODO = "File the project's tracking issue, then dispatch again with its number as `context` (docs/lanes.md, \"Start a project\").";

/**
 * Why the brief lane refuses this dispatch's `context`, or `''` when it names the tracking issue.
 * @param {string} context the dispatch's `context` input, as the lane received it
 * @returns {string}
 */
export function trackingIssueRefusal(context) {
  const v = String(context ?? '').trim();
  if (v === '') return `The Lead writes a brief only for a project's tracking issue (K-AGENT-30), and this dispatch's \`context\` is empty, so the agent was not started. ${TODO}`;
  if (!v.split(',').every((token) => ISSUE.test(token.trim()))) {
    return `The Lead writes a brief only for a project's tracking issue (K-AGENT-30), and this dispatch's \`context\` must hold issue numbers, comma-separated, the tracking issue's among them, so the agent was not started. ${TODO}`;
  }
  return '';
}

if (isCliEntry(import.meta.url)) {
  const refusal = trackingIssueRefusal(process.env.CONTEXT ?? '');
  if (refusal) console.log(refusal);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `refusal=${refusal}\n`);
}
