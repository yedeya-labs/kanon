#!/usr/bin/env node
// A notice when a push to a pull request rewrites commits a reviewer read (`K-MERGE-15`, #1244).
//
// THE RULE'S PROSE HALF. `K-MERGE-15` says never to force-push over a branch a reviewer has read
// unless asked. A force-push detaches a review from the commits it cites: the review still says
// what it read, and the branch no longer has it. Measured on Kanon before this check: 155
// force-pushes on 100 pull requests came after a review had been submitted there (#1244).
//
// WHAT IT CHECKS. On a push to a pull request GitHub gives the old head (`before`) and the new one
// (`after`). When `before` is an ancestor of `after` the push only added commits, a merge of the
// base included, and nothing was rewritten. Otherwise the branch was rebased, amended or reset, and
// every review that read a commit `before` has and `after` hasn't is named. The commit a review
// read is its reviewed-sha stamp when it has one, else `commit_id` (`evidenceSha`, RA-1680). A
// review of a commit the new head still has is not named: it still cites the branch's history.
// The pull request's author is not a reviewer of their own branch, and a pending review was never
// submitted, so neither counts.
//
// IT NEVER FAILS THE RUN ON WHAT IT FINDS. The rule's "unless asked" can't be told apart in the
// events, so a force-push is reported, as a warning annotation and in the step summary, and the
// run stays green. It fails only when it can't read the reviews, so a broken check is seen rather
// than reporting nothing. When it can't tell (the old head is gone from the clone and GitHub no
// longer serves it), it says so in a notice and passes.
//
// THE GIT ANSWERS ARE THE REVIEW SCOPE'S. `gitFacts` from `incremental-review.mjs`, whose rewrite
// detection is the same ancestry question, resolves the commits, answers ancestry and fetches a
// force-pushed-away commit by its SHA from `origin`, which GitHub serves until it is collected.
// The checkout needs the history: `force-push-notice.yml` fetches it all.
//
//   BEFORE=<sha> AFTER=<sha> PR_NUMBER=<n> PR_AUTHOR=<login> REPO=<owner/repo> \
//     node scripts/force-push-notice.mjs

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { gitFacts } from './incremental-review.mjs';
import { evidenceSha } from './review-trailer.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * @typedef {{id?: number, user?: {login?: string}, state?: string, commit_id?: string, body?: string|null, html_url?: string}} Review
 * @typedef {{resolve: (sha: string) => string|null, isAncestor: (a: string, b: string) => boolean, fetch?: (sha: string) => void}} Git
 * @typedef {{review: Review, sha: string}} Detached
 * @typedef {{forced: boolean|null, reason: string, detached: Detached[]}} Result
 */

// Hex only, so nothing from the event or a review reaches git as an option.
const SHA = /^[0-9a-f]{7,64}$/i;
const ZERO = /^0+$/;
const short = (/** @type {string} */ sha) => sha.slice(0, 7);

/**
 * The reviews that count as a reviewer reading the branch: submitted, and not by its author.
 * @param {Review[]} reviews
 * @param {string} author
 * @returns {Review[]}
 */
export function readers(reviews, author) {
  return (reviews ?? []).filter((r) => r?.state !== 'PENDING' && String(r?.user?.login ?? '') !== author);
}

/**
 * Whether the push from `before` to `after` rewrote the branch, and which reviews it detached.
 * `forced` is null when it can't tell.
 * @param {{before: string, after: string, author: string, reviews: Review[], git: Git}} input
 * @returns {Result}
 */
export function checkPush({ before, after, author, reviews, git }) {
  /** @param {string} reason @returns {Result} */
  const unknown = (reason) => ({ forced: null, reason, detached: [] });
  if (!SHA.test(before ?? '') || ZERO.test(before)) return unknown('the push names no old head, so there is nothing it could have rewritten');
  if (!SHA.test(after ?? '')) return unknown('the push names no new head');

  /** @param {string} sha */
  const present = (sha) => {
    let got = git.resolve(sha);
    if (!got && git.fetch) {
      try { git.fetch(sha); } catch { /* absent stays absent */ }
      got = git.resolve(sha);
    }
    return got;
  };
  const old = present(before);
  if (!old) return unknown(`the old head ${short(before)} is not in the clone and could not be fetched, so whether the push rewrote the branch is unknown`);
  const head = present(after);
  if (!head) return unknown(`the new head ${short(after)} is not in the clone and could not be fetched`);
  if (git.isAncestor(old, head)) {
    return { forced: false, reason: `${short(old)}..${short(head)} only adds commits: not a force-push`, detached: [] };
  }

  /** @type {Detached[]} */
  const detached = [];
  for (const review of readers(reviews, author)) {
    const sha = String(evidenceSha(review) ?? '');
    if (!SHA.test(sha)) continue;
    // A commit the old head has is in the clone once the old head is. One that isn't was not on
    // the branch this push replaced.
    const read = git.resolve(sha);
    if (read && git.isAncestor(read, old) && !git.isAncestor(read, head)) detached.push({ review, sha: read });
  }
  return {
    forced: true,
    reason: `${short(head)} does not build on ${short(old)}: the branch was rebased, amended or reset, and force-pushed`,
    detached,
  };
}

// Workflow-command encoding: a value can't end the line it is on or start a command of its own.
const encode = (/** @type {string} */ s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const cell = (/** @type {string} */ s) => s.replace(/[|\r\n]/g, ' ');

/** @param {Detached} d */
const named = ({ review, sha }) => `review ${review.id ?? '?'} by ${review.user?.login ?? 'unknown'} (${review.state ?? '?'}) on ${short(sha)}`;

/**
 * The warning annotation and the step summary for a force-push that detached a review, or null.
 * @param {{before: string, after: string, number: string, result: Result}} input
 * @returns {{annotation: string, summary: string} | null}
 */
export function renderNotice({ before, after, number, result }) {
  if (result.forced !== true || !result.detached.length) return null;
  const n = result.detached.length;
  const message = [
    `The push to #${number} replaced ${short(before)} with ${short(after)}, which does not build on it, so it detached ${n} review${n === 1 ? '' : 's'} from the commits ${n === 1 ? 'it' : 'they'} read: ${result.detached.map(named).join('; ')}.`,
    'K-MERGE-15: never force-push over a branch a reviewer has read unless asked; resolve a conflict with a merge commit.',
    `If this force-push was asked for, nothing needs doing. Either way, ${n === 1 ? 'that review cites' : 'those reviews cite'} commits the branch no longer has, so ${n === 1 ? 'its reviewer' : 'each reviewer'} should read the pull request again in full.`,
  ].join(' ');
  const summary = [
    '### Force-push over a reviewed branch (`K-MERGE-15`)',
    '',
    `\`${short(before)}\` → \`${short(after)}\`: the new head does not build on the old one. These reviews read commits the branch no longer has. If the force-push was asked for, nothing needs doing; either way, each should be read again in full.`,
    '',
    '| Review | Reviewer | State | Read |',
    '|---|---|---|---|',
    ...result.detached.map(({ review, sha }) => {
      const id = `review ${review.id ?? '?'}`;
      return `| ${review.html_url ? `[${id}](${cell(review.html_url)})` : id} | ${cell(review.user?.login ?? 'unknown')} | ${cell(review.state ?? '?')} | \`${short(sha)}\` |`;
    }),
    '',
  ].join('\n');
  return { annotation: `::warning title=Force-push over a reviewed branch (K-MERGE-15)::${encode(message)}`, summary };
}

/**
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, readReviews?: () => Review[], log?: (line: string) => void, appendSummary?: (text: string) => void}} [io]
 * @returns {number} the exit code
 */
export function main({
  env = process.env,
  cwd = process.cwd(),
  readReviews = () => ghReviews(env),
  log = (line) => console.log(line),
  appendSummary = (text) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text); },
} = {}) {
  const before = env.BEFORE ?? '';
  const after = env.AFTER ?? '';
  const number = env.PR_NUMBER ?? '?';
  /** @type {Review[]} */
  let reviews;
  try {
    reviews = readReviews();
    if (!Array.isArray(reviews)) throw new Error('the reviews are not a list');
  } catch (e) {
    log(`::error title=Force-push notice::could not read the reviews of #${number}: ${encode(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
  const result = checkPush({ before, after, author: env.PR_AUTHOR ?? '', reviews, git: gitFacts({ cwd, baseRef: 'HEAD', remote: 'origin' }) });
  if (result.forced === null) {
    log(`::notice title=Force-push notice::${encode(result.reason)}`);
    return 0;
  }
  log(`force-push-notice: ${result.reason}`);
  const notice = renderNotice({ before, after, number, result });
  if (notice) {
    log(notice.annotation);
    appendSummary(notice.summary);
  } else if (result.forced) {
    log('force-push-notice: no review had read the commits it replaced');
  }
  return 0;
}

/** @param {NodeJS.ProcessEnv} env @returns {Review[]} */
function ghReviews(env) {
  const repo = env.REPO ?? env.GITHUB_REPOSITORY;
  if (!repo || !/^\d+$/.test(env.PR_NUMBER ?? '')) throw new Error('REPO and PR_NUMBER are required');
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${env.PR_NUMBER}/reviews?per_page=100`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).flat();
}

if (isCliEntry(import.meta.url)) process.exitCode = main();
