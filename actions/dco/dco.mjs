// Kanon's DCO check (ADR 0010). Every commit in a pull request must carry a
// `Signed-off-by:` trailer whose name and email are the commit author's.
//
// The commits come from the API (`GET /repos/{owner}/{repo}/pulls/{n}/commits`), so the
// action needs no deep checkout. The API returns at most 250 commits for a pull request,
// so the check compares what it read with the pull request's own commit count and fails
// closed when they differ.
//
// What counts as a sign-off follows git's own trailer rules (`git interpret-trailers`):
// trailers live in the message's last paragraph, never in the subject, and that paragraph
// counts as a trailer block only when it is all trailers, or holds a `Signed-off-by:` line
// and at least a quarter of its lines are trailers. A `Signed-off-by:` line anywhere else
// in the body is prose, not a sign-off, because git itself would not read it as one: a
// later `git commit -s` or `git interpret-trailers` would add a second block after it.
//
// The name must match exactly and the email ignoring case, because hosts and GitHub treat
// email addresses case-insensitively, and `git commit -s` reproduces the name exactly.
//
// A sign-off must be a person. Signing off certifies the DCO, which only someone who can
// take legal responsibility for the change can do, so a sign-off never counts when it
// names an automated identity, even when it matches the author. The list is fixed and
// short (ADR 0002):
// - An email at `anthropic.com` or a subdomain of it, such as `noreply@anthropic.com`:
//   the address Claude Code writes into the `Co-Authored-By:` trailer it adds. An agent
//   that copies it into a `Signed-off-by:` has certified nothing.
// - Any `[bot]` identity, in the name or the email: GitHub's convention for app and bot
//   accounts (`dependabot[bot]`, `github-actions[bot]`, `name[bot]@users.noreply...`).
// Trailers other than `Signed-off-by:` are ignored, so `Co-Authored-By: Claude ...` stays
// allowed: it is a credit, not a certification.
//
// Exempt, and nothing else (the list is fixed, ADR 0002):
// - Merge commits (more than one parent). They add no authored change of their own; the
//   commits they bring in are checked on their own.
// - Commits GitHub itself creates for two bots, when the commit is GitHub-signed:
//   - `dependabot[bot]`: Dependabot's upgrade PRs are how Kanon's pins move (K-ADOPT-11).
//     Dependabot does sign off, but as `dependabot[bot] <support@github.com>`, which is not
//     its author email, so without the exemption every upgrade PR would fail.
//   - `github-actions[bot]`: release-please commits the release PR with the workflow
//     token (K-SHIP-7), and adds no sign-off.
//   A bot author alone is not enough, because anyone can write that email into a commit.
//   The exemption also needs GitHub's committer (`web-flow`) and a verified signature,
//   which only GitHub can produce. A human commit pushed onto a bot's branch is checked.
//
// Usage (the action's form):
//   GITHUB_TOKEN=... REPOSITORY=owner/repo PR_NUMBER=12 BASE_REF=main node dco.mjs
//
// Needs Node 18 or later (for the global fetch), and no dependencies.

import { pathToFileURL } from 'node:url';

/** Bot accounts whose GitHub-created commits need no sign-off. Fixed (ADR 0002). */
export const EXEMPT_BOTS = /** @type {const} */ (['dependabot[bot]', 'github-actions[bot]']);

/** The committer GitHub records for commits it creates and signs itself. */
const GITHUB_COMMITTER = 'web-flow';

const TRAILER = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/;
const SIGN_OFF = /^Signed-off-by\s*:\s*(.*?)\s*<([^<>]*)>\s*$/i;
const IS_SIGN_OFF_KEY = /^Signed-off-by\s*:/i;

/** Sign-off identities that are never a person. Fixed (ADR 0002); see the header. */
const AUTOMATED_EMAIL_DOMAIN = /@(?:[a-z0-9-]+\.)*anthropic\.com$/i;
const BOT_MARK = '[bot]';

/**
 * Whether a sign-off names an AI or automated identity rather than a person.
 * @param {{ name: string, email: string }} who
 */
export function isAutomated(who) {
  return (
    AUTOMATED_EMAIL_DOMAIN.test(who.email) ||
    who.name.toLowerCase().includes(BOT_MARK) ||
    who.email.toLowerCase().includes(BOT_MARK)
  );
}

/**
 * @typedef {{
 *   sha: string,
 *   parents: unknown[],
 *   author: { login?: string, type?: string } | null,
 *   committer: { login?: string } | null,
 *   commit: {
 *     message: string,
 *     author: { name: string, email: string } | null,
 *     verification?: { verified?: boolean } | null,
 *   },
 * }} Commit
 */

/**
 * The trailer lines of a commit message, by git's rules: the last paragraph, not the
 * subject, all trailers, or a `Signed-off-by:` and at least 25% trailers. Continuation
 * lines (starting with whitespace) belong to the trailer before them.
 * @param {string} message
 * @returns {string[]}
 */
export function trailers(message) {
  const lines = message.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  let start = lines.length;
  while (start > 0 && lines[start - 1]?.trim() !== '') start -= 1;
  const firstParagraphEnds = lines.findIndex((l) => l.trim() === '');
  if (firstParagraphEnds === -1) return [];

  const block = lines.slice(start);
  /** @type {string[]} */
  const found = [];
  let trailerLines = 0;
  let otherLines = 0;
  let signOff = false;
  for (const line of block) {
    if (/^\s/.test(line) && found.length > 0) {
      found[found.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (TRAILER.test(line)) {
      trailerLines += 1;
      found.push(line);
      if (IS_SIGN_OFF_KEY.test(line)) signOff = true;
    } else {
      otherLines += 1;
    }
  }
  if (otherLines === 0) return found;
  if (signOff && trailerLines * 4 >= trailerLines + otherLines) return found;
  return [];
}

/**
 * The `Signed-off-by:` identities in a message's trailer block.
 * @param {string} message
 * @returns {{ name: string, email: string }[]}
 */
export function signOffs(message) {
  return trailers(message).flatMap((line) => {
    const m = SIGN_OFF.exec(line);
    return m ? [{ name: (m[1] ?? '').trim(), email: (m[2] ?? '').trim() }] : [];
  });
}

/**
 * Whether GitHub itself created this commit for one of the exempt bots.
 * @param {Commit} c
 */
export function isExemptBot(c) {
  return (
    c.author?.type === 'Bot' &&
    EXEMPT_BOTS.some((bot) => bot === c.author?.login) &&
    c.committer?.login === GITHUB_COMMITTER &&
    c.commit.verification?.verified === true
  );
}

/**
 * @param {Commit} c
 * @returns {{ ok: true, skipped?: 'merge' | 'bot' } | { ok: false, reason: string }}
 */
export function checkCommit(c) {
  if (c.parents.length > 1) return { ok: true, skipped: 'merge' };
  if (isExemptBot(c)) return { ok: true, skipped: 'bot' };
  const author = c.commit.author;
  if (!author) return { ok: false, reason: 'has no author to match a sign-off against' };
  const found = signOffs(c.commit.message);
  const want = `${author.name} <${author.email}>`;
  if (found.length === 0) return { ok: false, reason: `has no Signed-off-by trailer (expected "${want}")` };
  const matches = found.filter(
    (s) => s.name === author.name.trim() && s.email.toLowerCase() === author.email.trim().toLowerCase(),
  );
  if (matches.some((s) => !isAutomated(s))) return { ok: true };
  const seen = found.map((s) => `${s.name} <${s.email}>`).join(', ');
  if (found.every(isAutomated)) {
    return { ok: false, reason: `is signed off only by ${seen}, an AI or bot identity; a person must sign off` };
  }
  return { ok: false, reason: `is signed off by ${seen}, not by its author "${want}"` };
}

/**
 * @param {Commit[]} commits
 * @returns {{ commit: Commit, reason: string }[]}
 */
export function offending(commits) {
  return commits.flatMap((commit) => {
    const result = checkCommit(commit);
    return result.ok ? [] : [{ commit, reason: result.reason }];
  });
}

/**
 * Reads every commit of a pull request, and its commit count, through the REST API.
 * @param {{ api: string, repository: string, number: string, token: string }} where
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ commits: Commit[], expected: number }>}
 */
export async function fetchCommits({ api, repository, number, token }, fetchImpl = fetch) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const get = async (/** @type {string} */ path) => {
    const res = await fetchImpl(`${api}/repos/${repository}/pulls/${number}${path}`, { headers });
    if (!res.ok) throw new Error(`GET .../pulls/${number}${path} returned HTTP ${res.status}`);
    return res.json();
  };
  const pr = await get('');
  /** @type {Commit[]} */
  const commits = [];
  for (let page = 1; ; page += 1) {
    const batch = await get(`/commits?per_page=100&page=${page}`);
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return { commits, expected: pr.commits };
}

/**
 * Runs the check and reports it. Returns the process exit code.
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 * @param {{ log: (s: string) => void, error: (s: string) => void }} out
 */
export async function main(env, fetchImpl = fetch, out = console) {
  const { PR_NUMBER: number, REPOSITORY: repository, GITHUB_TOKEN: token } = env;
  if (!number || !repository || !token) {
    out.error('The DCO check runs on pull_request events, and needs PR_NUMBER, REPOSITORY and GITHUB_TOKEN.');
    return 1;
  }
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  let fetched;
  try {
    fetched = await fetchCommits({ api, repository, number, token }, fetchImpl);
  } catch (e) {
    out.error(`Could not read the pull request's commits: ${e instanceof Error ? e.message : String(e)}.`);
    return 1;
  }
  const { commits, expected } = fetched;
  if (commits.length !== expected) {
    out.error(
      `Read ${commits.length} of the pull request's ${expected} commits; the API lists at most 250. ` +
        'Split the pull request, or squash some of its commits, so every one can be checked.',
    );
    return 1;
  }

  const bad = offending(commits);
  if (bad.length === 0) {
    out.log(`DCO OK: all ${commits.length} commit(s) are signed off by their authors, or exempt.`);
    return 0;
  }
  out.error(`${bad.length} of ${commits.length} commit(s) lack their author's sign-off (DCO, ADR 0010):`);
  for (const { commit, reason } of bad) {
    const subject = commit.commit.message.split(/\r?\n/)[0];
    out.error(`  ${commit.sha.slice(0, 7)} ${subject}: ${reason}`);
  }
  const base = env.BASE_REF ? `origin/${env.BASE_REF}` : '<base>';
  out.error('');
  out.error('Sign off with the author identity, then force-push:');
  out.error('  one commit (the last):  git commit --amend -s');
  out.error(`  every commit:           git rebase --signoff ${base}`);
  out.error('  then:                   git push --force-with-lease');
  out.error('`git commit -s` signs off with your git user.name and user.email, which must be the author\'s.');
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.env);
}
