// Which token `gh` uses, and whose it is (plan 0005 §5.1).
//
// `gh` takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored login, so a stale
// GH_TOKEN left in a shell wins over a fresh `gh auth login` and shows up only as a 401. The
// `kanon` commands that call GitHub through `gh` (`kanon apps`, `kanon milestones`) say, before
// they change anything, where the token came from and the login it belongs to, and when GitHub
// refuses it, how to fix that. The token itself is never read, printed or passed on: the
// login comes from `gh api user`, which uses whichever token `gh` would.

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
