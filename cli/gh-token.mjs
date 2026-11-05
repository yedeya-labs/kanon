// Which token `gh` uses, and whose it is (plan 0005 §5.1).
//
// `gh` takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored login, so a stale
// GH_TOKEN left in a shell wins over a fresh `gh auth login` and shows up only as a 401. The
// `kanon` commands that call GitHub through `gh` (`kanon apps`, `kanon milestones`) say, before
// they change anything, where the token came from and the login it belongs to, and when GitHub
// refuses it, how to fix that. The token itself is never read, printed or passed on: the
// login comes from `gh api user`, which uses whichever token `gh` would.

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

/** @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult */
/** @typedef {'GH_TOKEN' | 'GITHUB_TOKEN' | 'gh'} TokenSource */

/**
 * Where `gh`'s token comes from, in `gh`'s own order of precedence.
 * @param {Record<string, string | undefined>} env
 * @returns {TokenSource}
 */
export const tokenSource = (env) => (env.GH_TOKEN ? 'GH_TOKEN' : env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'gh');

/** @param {TokenSource} source */
export const describeSource = (source) => (source === 'gh' ? "gh's stored login" : `the token in ${source}`);

/**
 * True when `gh`'s error says GitHub refused the credentials (401) or the token's access (403).
 * @param {string} stderr
 */
export const isAuthFailure = (stderr) => /\bHTTP 40[13]\b|Bad credentials/i.test(stderr);

/** @param {string} stderr */
const isUnauthorised = (stderr) => /\bHTTP 401\b|Bad credentials/i.test(stderr);

/**
 * How to fix a token GitHub refused, stale (401) or too narrow (403), for the source `gh` used.
 * @param {TokenSource} source
 * @returns {string[]}
 */
export const tokenFix = (source) =>
  source === 'gh'
    ? ["Check gh's stored login with `gh auth status`: `gh auth login` signs in again, and `gh auth refresh` renews it."]
    : [
        `${source} is set in this shell, and gh uses it before its stored login, whoever \`gh auth status\` says you are.`,
        `If it is stale, \`unset ${source}\` to use the stored login (check it with \`gh auth status\`), or export a fresh token as ${source}.`,
      ];

/**
 * Asks GitHub whose token `gh` holds. Returns the line to print, and the refusal lines when
 * GitHub answered 401: a token GitHub rejects outright can do nothing, so the caller stops.
 * Any other failure (a token that may not read /user, such as an installation token) is
 * reported and the caller carries on; the call that needs the access will say what it lacks.
 * @param {(args: string[]) => Promise<GhResult>} gh
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ source: TokenSource, login: string | null, line: string, refusal: string[] | null }>}
 */
export const whoami = async (gh, env) => {
  const source = tokenSource(env);
  /** @type {GhResult} */
  let r;
  try {
    r = await gh(['api', 'user', '--jq', '.login']);
  } catch (e) {
    r = { status: null, stdout: '', stderr: String(/** @type {Error} */ (e).message) };
  }
  const login = r.status === 0 ? r.stdout.trim() : '';
  if (login) return { source, login, line: `Using ${describeSource(source)}, which belongs to ${login}.`, refusal: null };
  const why = r.stderr.trim() || `exit ${r.status}`;
  if (isUnauthorised(why)) {
    return {
      source,
      login: null,
      line: `Using ${describeSource(source)}, which GitHub refuses (${why}).`,
      refusal: [`GitHub refuses ${describeSource(source)} (${why}). Nothing was changed.`, ...tokenFix(source)],
    };
  }
  return { source, login: null, line: `Using ${describeSource(source)}; its login could not be read (${why}).`, refusal: null };
};

// ── What a person's token needs (kanon#1607, point 17) ──────────────────────────────────────
//
// `docs/doctor.md`'s table under "A person's fine-grained token" is the one place that lists the
// repository permissions each skill's token needs. `kanon init` reports the adopt skill's in its
// JSON (`.token.needs`), read from that table, so the skill relays Kanon's list rather than one
// it infers. These are what the skill needs, not what the token holds: GitHub doesn't show a
// fine-grained token's permissions to anyone, the token included.

/** Where the table lives, beside this file in Kanon's tree. */
export const TOKEN_NEEDS_DOC = new URL('../docs/doctor.md', import.meta.url);

/** @typedef {{ permission: string, access: 'read' | 'read and write' }} TokenNeed */

/**
 * The repository permissions the table's row for `skill` names, in its order, each once at the
 * most it asks: its `;`- or `.`-separated clauses of the form `<Permission>: read` or
 * `<Permission>: read and write`, with `A and B: …` naming both. A clause that says more, such
 * as the organisation's permission or another repository's, is not one of this repository's.
 * Null when the document has no such table, or no row for the skill.
 * @param {string} doc docs/doctor.md's text
 * @param {string} skill
 * @returns {TokenNeed[] | null}
 */
export const tokenNeeds = (doc, skill) => {
  const at = doc.search(/^### A person's fine-grained token$/m);
  if (at < 0) return null;
  const section = doc.slice(at).split(/\n(?=#{1,3} )/)[0] ?? '';
  const row = section.split('\n').find((l) => l.startsWith(`| \`${skill}\``));
  if (!row) return null;
  const cell = row.replace(/\s*\|\s*$/, '').split(' | ')[1] ?? '';
  // The reasons in parentheses are prose, and can hold a `;` or a permission of their own.
  let text = cell;
  for (let before = ''; before !== text; ) {
    before = text;
    text = text.replace(/\s*\([^()]*\)/g, '');
  }
  /** @type {Map<string, TokenNeed['access']>} */
  const needs = new Map();
  const name = '[A-Z][a-z]+(?: [a-z]+)?';
  for (const clause of text.split(/;\s*|\.\s+|\.\s*$/).map((c) => c.trim())) {
    const m = new RegExp(`^(${name}(?:,? and ${name})*): (read and write|read)$`).exec(clause);
    if (!m) continue;
    const access = /** @type {TokenNeed['access']} */ (m[2]);
    for (const p of /** @type {string} */ (m[1]).split(/,? and /)) {
      if (needs.get(p) !== 'read and write') needs.set(p, access);
    }
  }
  return needs.size ? [...needs].map(([permission, access]) => ({ permission, access })) : null;
};

/** The table's row for `skill`, read from Kanon's own `docs/doctor.md`; null when it can't be read. @param {string} skill */
export const skillTokenNeeds = (skill) => {
  try {
    return tokenNeeds(readFileSync(TOKEN_NEEDS_DOC, 'utf8'), skill);
  } catch {
    return null;
  }
};
