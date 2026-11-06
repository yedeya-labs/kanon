// The spine's push job posts the agent's closing comment (kanon#1591).
//
// WHY HERE. The agent's token is minted when its run starts, and an installation token lives an
// hour, while a lane may let its agent run for three. A comment posted at the end of a long run was
// refused as `Bad credentials`, and the run's report never reached its issue. So on a lane that sets
// `closing-comment`, the agent writes the comment to `docs/.kanon-issue-comment.md` (git ignores it
// there), its job hands the file on with its commits, and this posts it from the push job, with the
// token that job minted after the run. It runs no agent and no project code, and posts the file's
// text as it is, on the one issue the lane names: the comment is the agent's, as it would have been
// had the agent posted it, and the App is its author.
//
// Usage: node scripts/lane-comment.mjs --comment <file> --issue <n>
// Reads `GH_TOKEN`, `REPO` and `GITHUB_API_URL`. Exits 1, naming why, when it can't post.

import { appendFileSync, readFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { githubRequest } from './lib/verified-commits.mjs';

/** Where the agent writes its closing comment: under `docs/`, beside the pull request's request. */
export const COMMENT_PATH = 'docs/.kanon-issue-comment.md';

/** GitHub's limit on a comment's body. */
export const COMMENT_MAX = 65536;

/**
 * The comment to post, or why there is none to post: the text must hold something, and fit
 * GitHub's limit, and the issue must be a positive whole number.
 * @param {string} text @param {string} issue
 * @returns {{ body: string, issue: number } | { problem: string }}
 */
export function readComment(text, issue) {
  const n = Number(issue);
  if (!/^\d+$/.test(issue) || n < 1) return { problem: `the lane names no issue to comment on (${JSON.stringify(issue)})` };
  if (!text.trim()) return { problem: 'the closing comment is empty' };
  if (text.length > COMMENT_MAX) return { problem: `the closing comment is ${text.length} characters, over GitHub's ${COMMENT_MAX}` };
  return { body: text, issue: n };
}

/**
 * Posts it. @param {{ api: ReturnType<typeof githubRequest>, repo: string, body: string, issue: number }} a
 * @returns {Promise<{ url: string } | { problem: string }>}
 */
export async function postComment({ api, repo, body, issue }) {
  const r = await api('POST', `repos/${repo}/issues/${issue}/comments`, { body });
  if (r.status === 201) return { url: String(r.json?.html_url ?? '') };
  return { problem: `GitHub answered ${r.status} posting the closing comment on #${issue}${r.json?.message ? `: ${r.json.message}` : ''}` };
}

if (isCliEntry(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? '' : (process.argv[i + 1] ?? '');
  };
  const fail = (/** @type {string} */ why) => {
    console.log(`::error title=lane-comment::${why.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    process.exit(1);
  };
  let text = '';
  try {
    text = readFileSync(arg('--comment'), 'utf8');
  } catch (e) {
    fail(`could not read the closing comment: ${/** @type {Error} */ (e).message}`);
  }
  const c = readComment(text, arg('--issue'));
  if ('problem' in c) fail(c.problem);
  else {
    const api = githubRequest({ token: process.env.GH_TOKEN ?? '', api: process.env.GITHUB_API_URL || 'https://api.github.com' });
    const posted = await postComment({ api, repo: process.env.REPO ?? '', body: c.body, issue: c.issue });
    if ('problem' in posted) fail(posted.problem);
    else {
      console.log(`Posted the agent's closing comment on #${c.issue}: ${posted.url}`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The agent's closing comment\n\nPosted on #${c.issue}: ${posted.url}\n`);
    }
  }
}
