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
// Delegated sign-off for the repository's own agents (K-AGENT-44). An adopter may record a
// standing delegation naming one person in `docs/qa/sign-off-delegation.md` (K-LAYOUT-14).
// A commit authored by an App listed in the App register (`docs/qa/agent-identities.md`,
// K-LAYOUT-6) must then carry that person's sign-off, and nobody else's counts for it. An
// agent commit is recognised by its author: the login `<slug>[bot]`, or the noreply email
// `<id>+<slug>[bot]@users.noreply.github.com`, with `<slug>` in the register. Every other
// commit is checked exactly as above.
// - Both files are read from the repository's DEFAULT branch over the API (`repos/{o}/{r}`
//   -> `default_branch`), never from the PR and never from the PR's base (K-MERGE-17). Only
//   merged, reviewed changes reach the default branch. A PR's base is not enough: on a
//   stacked PR it is another PR's branch, whose author can write a register row or a
//   delegation record there. They are read only when some commit has a bot author, so a PR
//   of human commits costs no extra call.
// - A missing or malformed record, or a register that lists no App, delegates nothing:
//   agent commits are then judged like any other, and fail on their bot sign-off. A read
//   that errors, including the read of the default branch's name, fails the check
//   (K-PRIN-10).
// - The delegate must be a person: a record naming an AI or bot identity is malformed.
//
// Usage (the action's form):
//   GITHUB_TOKEN=... REPOSITORY=owner/repo PR_NUMBER=12 BASE_REF=main node dco.mjs
//
// Needs Node 18 or later (for the global fetch), and no dependencies.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Bot accounts whose GitHub-created commits need no sign-off. Fixed (ADR 0002). */
export const EXEMPT_BOTS = /** @type {const} */ (['dependabot[bot]', 'github-actions[bot]']);

/** The App register (K-LAYOUT-6) and the sign-off delegation (K-LAYOUT-14), read from the default branch. */
export const REGISTER_PATH = 'docs/qa/agent-identities.md';
export const DELEGATION_PATH = 'docs/qa/sign-off-delegation.md';

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
 * @typedef {{ name: string, email: string }} Person
 * @typedef {{ slugs: string[], delegate: (Person & { date: string }) | null }} Trust
 *   What the default branch says: the register's App slugs, and the delegate, if one is recorded.
 */

/** No register and no delegation: every commit is checked as a person's. */
export const NO_TRUST = /** @type {Trust} */ ({ slugs: [], delegate: null });

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BOT_LOGIN = /^([a-z0-9]+(?:-[a-z0-9]+)*)\[bot\]$/;
const BOT_NOREPLY = /^\d+\+([a-z0-9]+(?:-[a-z0-9]+)*)\[bot\]@users\.noreply\.github\.com$/i;

/**
 * The cells of the markdown table rows outside fenced blocks, grouped by table. Each table is
 * its header cells and its data rows (the separator row dropped).
 * @param {string} text
 * @returns {{ header: string[], rows: string[][] }[]}
 */
function tables(text) {
  /** @type {{ header: string[], rows: string[][] }[]} */
  const found = [];
  let fenced = false;
  /** @type {{ header: string[], rows: string[][] } | null} */
  let current = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      fenced = !fenced;
      current = null;
      continue;
    }
    if (fenced) continue;
    if (!/^[ \t]*\|/.test(line)) {
      current = null;
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (current === null) {
      current = { header: cells, rows: [] };
      found.push(current);
    } else if (!cells.every((c) => /^:?-+:?$/.test(c))) {
      current.rows.push(cells);
    }
  }
  return found;
}

/** A cell's text without surrounding bold. */
const unbold = (/** @type {string} */ s) => (/^(\*\*|__).*\1$/.test(s) ? s.slice(2, -2).trim() : s);
/** A cell's text without surrounding backticks, or null when it has none. */
const unquote = (/** @type {string} */ s) => (/^`[^`]*`$/.test(s) ? s.slice(1, -1) : null);

/**
 * The App slugs in the App register: every row of its one table headed `| Role | App slug |`,
 * read as `actions/lane-check/app-register.awk` reads one role.
 * @param {string} text
 * @returns {{ slugs: string[] } | { problem: string }}
 */
export function parseRegister(text) {
  const heads = tables(text).filter((t) => t.header[0] === 'Role' && t.header[1] === 'App slug');
  if (heads.length !== 1) return { problem: `${REGISTER_PATH} has ${heads.length} tables headed | Role | App slug |, not one` };
  /** @type {string[]} */
  const slugs = [];
  for (const row of heads[0]?.rows ?? []) {
    const slug = unquote(unbold(row[1] ?? ''));
    if (slug === null || !SLUG.test(slug)) {
      return { problem: `${REGISTER_PATH} gives the role ${unbold(row[0] ?? '')} no App slug in backticks` };
    }
    slugs.push(slug);
  }
  return { slugs };
}

/**
 * The delegation record (K-LAYOUT-14): one table headed `| Delegate | Email | Delegated on |`
 * with exactly one row, naming a person, an email and a real date.
 * @param {string} text
 * @returns {{ delegate: Person & { date: string } } | { problem: string }}
 */
export function parseDelegation(text) {
  const heads = tables(text).filter(
    (t) => t.header.length === 3 && t.header[0] === 'Delegate' && t.header[1] === 'Email' && t.header[2] === 'Delegated on',
  );
  if (heads.length !== 1) {
    return { problem: `${DELEGATION_PATH} has ${heads.length} tables headed | Delegate | Email | Delegated on |, not one` };
  }
  const rows = heads[0]?.rows ?? [];
  if (rows.length !== 1) return { problem: `${DELEGATION_PATH} names ${rows.length} delegates, not one` };
  const [name = '', email = '', date = ''] = rows[0] ?? [];
  if (name === '' || /[<>]/.test(name)) return { problem: `${DELEGATION_PATH} gives no delegate's name` };
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) return { problem: `${DELEGATION_PATH} gives no valid email for ${name}` };
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const real = day && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!real) return { problem: `${DELEGATION_PATH} gives no date as YYYY-MM-DD for the delegation` };
  if (isAutomated({ name, email })) {
    return { problem: `${DELEGATION_PATH} names ${name} <${email}>, an AI or bot identity; only a person can be delegated to` };
  }
  return { delegate: { name, email, date } };
}

/**
 * Whether a commit's author looks like a GitHub App at all, by login or noreply email.
 * Such a commit is the only kind for which the default branch's files are read.
 * @param {Commit} c
 */
export function hasBotAuthor(c) {
  return BOT_LOGIN.test(c.author?.login ?? '') || BOT_NOREPLY.test(c.commit.author?.email ?? '');
}

/**
 * The register slug of the App that authored a commit, or null when its author is not one
 * of the repository's own Apps.
 * @param {Commit} c
 * @param {string[]} slugs
 */
export function agentSlug(c, slugs) {
  const byLogin = BOT_LOGIN.exec(c.author?.login ?? '')?.[1];
  const byEmail = BOT_NOREPLY.exec(c.commit.author?.email ?? '')?.[1]?.toLowerCase();
  return [byLogin, byEmail].find((s) => s !== undefined && slugs.includes(s)) ?? null;
}

/** Whether a sign-off names this person: the name exactly, the email ignoring case. */
const isPerson = (/** @type {Person} */ s, /** @type {Person} */ who) =>
  s.name === who.name.trim() && s.email.toLowerCase() === who.email.trim().toLowerCase();

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
 * @param {Trust} trust What the default branch says (NO_TRUST when it says nothing).
 * @returns {{ ok: true, skipped?: 'merge' | 'bot', delegated?: string } | { ok: false, reason: string }}
 */
export function checkCommit(c, trust = NO_TRUST) {
  if (c.parents.length > 1) return { ok: true, skipped: 'merge' };
  if (isExemptBot(c)) return { ok: true, skipped: 'bot' };
  const slug = agentSlug(c, trust.slugs);
  if (slug !== null && trust.delegate !== null) {
    const delegate = trust.delegate;
    const want = `${delegate.name} <${delegate.email}>`;
    if (signOffs(c.commit.message).some((s) => isPerson(s, delegate))) return { ok: true, delegated: slug };
    return {
      ok: false,
      reason: `is by the repository's own App ${slug}, so it needs the delegate's sign-off "${want}" (${DELEGATION_PATH}), and lacks it`,
    };
  }
  const result = checkAsPerson(c);
  if (slug !== null && !result.ok) {
    return { ok: false, reason: `${result.reason}. It is by the repository's own App ${slug}, and the default branch records no sign-off delegation (${DELEGATION_PATH})` };
  }
  return result;
}

/**
 * The check every commit gets unless a delegation covers it: signed off by its author, a person.
 * @param {Commit} c
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkAsPerson(c) {
  const author = c.commit.author;
  if (!author) return { ok: false, reason: 'has no author to match a sign-off against' };
  const found = signOffs(c.commit.message);
  const want = `${author.name} <${author.email}>`;
  if (found.length === 0) return { ok: false, reason: `has no Signed-off-by trailer (expected "${want}")` };
  const matches = found.filter((s) => isPerson(s, author));
  if (matches.some((s) => !isAutomated(s))) return { ok: true };
  const seen = found.map((s) => `${s.name} <${s.email}>`).join(', ');
  if (found.every(isAutomated)) {
    return { ok: false, reason: `is signed off only by ${seen}, an AI or bot identity; a person must sign off` };
  }
  return { ok: false, reason: `is signed off by ${seen}, not by its author "${want}"` };
}

/**
 * @param {Commit[]} commits
 * @param {Trust} trust
 * @returns {{ commit: Commit, reason: string }[]}
 */
export function offending(commits, trust = NO_TRUST) {
  return commits.flatMap((commit) => {
    const result = checkCommit(commit, trust);
    return result.ok ? [] : [{ commit, reason: result.reason }];
  });
}

const apiHeaders = (/** @type {string} */ token, accept = 'application/vnd.github+json') => ({
  accept,
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28',
});

/**
 * Reads every commit of a pull request and its commit count through the REST API.
 * @param {{ api: string, repository: string, number: string, token: string }} where
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ commits: Commit[], expected: number }>}
 */
export async function fetchCommits({ api, repository, number, token }, fetchImpl = fetch) {
  const headers = apiHeaders(token);
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
 * The repository's default branch (`GET /repos/{owner}/{repo}` -> `default_branch`). Throws
 * when it can't be read or names no branch, so the check fails closed (K-PRIN-10).
 * @param {{ api: string, repository: string, token: string }} where
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string>}
 */
export async function fetchDefaultBranch({ api, repository, token }, fetchImpl = fetch) {
  const res = await fetchImpl(`${api}/repos/${repository}`, { headers: apiHeaders(token) });
  if (!res.ok) throw new Error(`GET /repos/${repository} returned HTTP ${res.status}`);
  const repo = await res.json();
  const branch = repo?.default_branch;
  if (typeof branch !== 'string' || branch === '') throw new Error(`GET /repos/${repository} names no default_branch`);
  return branch;
}

/**
 * Reads one file from a branch through the REST API. Returns null when the file doesn't
 * exist there, and throws on any other failure (K-PRIN-10).
 * @param {{ api: string, repository: string, token: string, ref: string, path: string }} where
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string | null>}
 */
export async function fetchFile({ api, repository, token, ref, path }, fetchImpl = fetch) {
  const url = `${api}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await fetchImpl(url, { headers: apiHeaders(token, 'application/vnd.github.raw+json') });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET .../contents/${path}?ref=${ref} returned HTTP ${res.status}`);
  return res.text();
}

/**
 * What the default branch says about the repository's own agents: the register's slugs and the
 * delegate. A missing or malformed file contributes nothing, and each such file is reported
 * in `notes`, so a delegation that didn't take is visible in the log.
 * @param {{ api: string, repository: string, token: string, ref: string }} where
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ trust: Trust, notes: string[] }>}
 */
export async function readTrust(where, fetchImpl = fetch) {
  /** @type {string[]} */
  const notes = [];
  const register = await fetchFile({ ...where, path: REGISTER_PATH }, fetchImpl);
  if (register === null) return { trust: NO_TRUST, notes: [`${REGISTER_PATH} doesn't exist on ${where.ref}, so no commit is an agent's.`] };
  const apps = parseRegister(register);
  if ('problem' in apps) return { trust: NO_TRUST, notes: [`${apps.problem}, so no commit is an agent's.`] };
  const record = await fetchFile({ ...where, path: DELEGATION_PATH }, fetchImpl);
  if (record === null) {
    notes.push(`${DELEGATION_PATH} doesn't exist on ${where.ref}, so agent commits are checked like any other.`);
    return { trust: { slugs: apps.slugs, delegate: null }, notes };
  }
  const delegation = parseDelegation(record);
  if ('problem' in delegation) {
    notes.push(`${delegation.problem}, so it delegates nothing, and agent commits are checked like any other.`);
    return { trust: { slugs: apps.slugs, delegate: null }, notes };
  }
  return { trust: { slugs: apps.slugs, delegate: delegation.delegate }, notes };
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

  let trust = NO_TRUST;
  if (commits.some((c) => c.parents.length <= 1 && !isExemptBot(c) && hasBotAuthor(c))) {
    // Only the default branch's copy counts (K-MERGE-17): not the PR's, and not its base's,
    // which on a stacked PR is another PR's branch. Without it, fail closed rather than judge
    // an agent commit with no register (K-PRIN-10).
    let ref;
    try {
      ref = await fetchDefaultBranch({ api, repository, token }, fetchImpl);
    } catch (e) {
      out.error(`A commit has a bot author, and the repository's default branch can't be read, so the App register can't be read: ${e instanceof Error ? e.message : String(e)}.`);
      return 1;
    }
    try {
      const read = await readTrust({ api, repository, token, ref }, fetchImpl);
      trust = read.trust;
      for (const note of read.notes) out.log(note);
    } catch (e) {
      out.error(`Could not read the App register or the sign-off delegation from ${ref}: ${e instanceof Error ? e.message : String(e)}.`);
      return 1;
    }
  }

  const bad = offending(commits, trust);
  if (bad.length === 0) {
    const by = trust.delegate === null ? 'their authors' : `their authors, or for an agent's commit by ${trust.delegate.name}`;
    out.log(`DCO OK: all ${commits.length} commit(s) are signed off by ${by}, or exempt.`);
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

// The realpath idiom inline rather than `scripts/lib/cli-entry.mjs`'s `isCliEntry`, because
// this action has no dependencies by design (see the header): run through a symlinked
// path, a raw `argv[1]` comparison exits 0 having done nothing (kanon#191).
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (IS_CLI) {
  process.exitCode = await main(process.env);
}
