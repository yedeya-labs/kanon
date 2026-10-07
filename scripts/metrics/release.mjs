// Whether a pull request is a release pull request, which the metrics leave out (plan 0003 §1.2;
// the Owner, 2026-10-07, on kanon#538).
//
// A release PR is the release workflow's bookkeeping, not work: §1.2's counts leave release
// commits out, and a release PR is never a fix's cause. It is recognised by WHAT THE RELEASE
// WORKFLOW PRODUCES, never by a repository's name:
//   1. release-please's labels, `autorelease: pending` or `autorelease: tagged`; or
//   2. an author that is the register's Releaser App (`K-LAYOUT-6`), which opens nothing else; or
//   3. `github-actions[bot]`, which opened release PRs before a Releaser App existed, with a
//      conventional release title, `chore(<branch>): release <version>`.
// The title is a supporting signal only: a person's PR with that title is not a release PR.

import { slugOf } from '../lib/role-marker.mjs';

/** release-please's labels on the pull requests it opens. */
export const RELEASE_LABELS = Object.freeze(['autorelease: pending', 'autorelease: tagged']);

/** A conventional release title, `chore(<branch>): release <version>`. */
export const RELEASE_TITLE = /^chore\([^)]+\): release v?\d+\.\d+\.\d+\S*$/;

/** The Actions token's account, which opened release PRs before the Releaser App. */
const ACTIONS_BOT = 'github-actions';

/**
 * Whether `pr` is a release pull request.
 * @param {import('./types.mjs').PullRequest} pr
 * @param {Map<string, string>} register role name → App slug (`parseAppRegister`)
 */
export function isReleasePr(pr, register) {
  if (pr.labels.some((l) => RELEASE_LABELS.includes(l))) return true;
  const author = pr.author ? slugOf(pr.author.login).toLowerCase() : '';
  const bot = !!pr.author && (pr.author.type === 'Bot' || /\[bot\]$/i.test(pr.author.login));
  const releaser = register.get('Releaser')?.toLowerCase();
  if (bot && releaser && author === releaser) return true;
  return bot && author === ACTIONS_BOT && RELEASE_TITLE.test(pr.title ?? '');
}
