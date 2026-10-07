// Where a work item came from: the row's `origin` (plan 0003 §3.3, group 1).
//
// THE FIRST CLOSING ISSUE'S LABELS, CHECKED IN THIS ORDER, FIRST MATCH WINS:
//   1. `follow-up` with `agent:reviewer`   reviewer_followup
//   2. `agent:explorer`                    explorer
//   3. `agent:overseer`                    overseer
//   4. `project:<n>`                       brief
//   5. otherwise, the issue author's class.
// A PR with no closing issue takes the PR author's class. The specific origins come first
// because the Lead's reconciler also puts `project:<n>` on follow-ups and Explorer issues
// inside a project, so `project:<n>` alone doesn't mean a brief filed the item.
//
// FROM A CLASS TO AN ORIGIN. `origin`'s list isn't the class list. `human` and `other_bot` are
// themselves, and a dependency-update bot is `dependency_bot`. Of the roles, the Explorer and
// the Overseer file their own kinds of issue, the Lead files a brief's, and the Reviewer files
// follow-ups, so each maps to that origin. The Implementer and the Merger file no issue and
// open no PR of their own (an Implementer PR closes the issue it was dispatched on), so an item
// they appear to originate has no origin Kanon can name, and the field is left out.

import { classifyActor, isDependencyBot } from './actors.mjs';

/** The origins, as the telemetry schema's `origin` lists them. */
export const ORIGINS = /** @type {const} */ (['brief', 'explorer', 'reviewer_followup', 'overseer', 'human', 'dependency_bot', 'other_bot']);

/** @typedef {typeof ORIGINS[number]} Origin */

/** @type {Readonly<Record<string, Origin>>} */
const ROLE_ORIGIN = Object.freeze({
  explorer: 'explorer',
  overseer: 'overseer',
  lead: 'brief',
  reviewer: 'reviewer_followup',
  human: 'human',
  other_bot: 'other_bot',
});

const PROJECT = /^project:\d+$/;

/**
 * An author's origin, from their class (`classifyActor`) and whether they are a dependency bot.
 * @param {import('./types.mjs').Actor | null | undefined} author
 * @param {string | null | undefined} body what they wrote, for the role marker
 * @param {Map<string, string>} register
 * @returns {Origin | undefined}
 */
function authorOrigin(author, body, register) {
  if (isDependencyBot(author)) return 'dependency_bot';
  // No role is implied: an App of several roles is told apart by its marker alone.
  const cls = classifyActor(author, register, { body });
  return cls && Object.hasOwn(ROLE_ORIGIN, cls) ? ROLE_ORIGIN[cls] : undefined;
}

/**
 * The item's origin (§3.3): the first closing issue's labels in the documented order, then
 * its author's class; with no closing issue, the PR author's. Undefined when the deciding
 * author is unknown or has no origin of its own.
 * @param {import('./types.mjs').PullRequest} pr
 * @param {Map<string, string>} register
 * @returns {Origin | undefined}
 */
export function originOf(pr, register) {
  // Unread closing issues are unknown, not "none": the PR author's class would be a guess.
  if (!pr.closing_issues) return undefined;
  const issue = pr.closing_issues[0];
  if (!issue) return authorOrigin(pr.author, pr.body, register);
  const labels = new Set(issue.labels);
  if (labels.has('follow-up') && labels.has('agent:reviewer')) return 'reviewer_followup';
  if (labels.has('agent:explorer')) return 'explorer';
  if (labels.has('agent:overseer')) return 'overseer';
  if (issue.labels.some((l) => PROJECT.test(l))) return 'brief';
  return authorOrigin(issue.author, issue.body, register);
}
