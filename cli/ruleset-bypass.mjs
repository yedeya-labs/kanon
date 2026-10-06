// The Releaser's ruleset bypass (`K-MERGE-8`, plan 0005 §3.1, #49): the optional Releaser App is
// the only actor that may bypass the default branch's ruleset, and only through a pull request.
// A manifest can't grant a bypass, so `kanon apps` adds it through the rulesets API when the
// Owner's token can administer the repository, and `kanon doctor` reports a ruleset that lacks
// it, or that still lets another actor (an admin role, typically) bypass.
//
// Shared by `kanon apps`, `kanon init` (its `inspect` reads the covering rulesets here) and
// `kanon doctor`, so the three read a ruleset one way. Node built-ins only, and no import of
// another `cli/` module, so any of them may import it.

/** @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult */
/** @typedef {(args: string[], input?: string) => Promise<GhResult>} Gh */
/** @typedef {{ actor_id?: number | null, actor_type?: string, bypass_mode?: string }} BypassActor */

/**
 * The bypass mode the Releaser gets: through a pull request only, never a direct push. That is
 * as close as GitHub comes to `K-MERGE-8`'s "only to merge its own release PRs": the Releaser
 * opens no other pull request.
 */
export const RELEASER_BYPASS_MODE = 'pull_request';

/**
 * @param {Gh} gh @param {string[]} args
 * @returns {Promise<{ ok: true, json: any, r?: undefined } | { ok: false, json?: undefined, r: GhResult }>}
 */
const ghJson = async (gh, args) => {
  const r = await gh(args);
  if (r.status !== 0) return { ok: false, r };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, r: { ...r, stderr: `GitHub's answer to ${args.join(' ')} was not JSON` } };
  }
};

/**
 * The branch rulesets that cover the default branch, each read whole (the list carries no rules
 * and no bypass list): `covering` the `active` ones, `inactive` the `disabled` or `evaluate` ones.
 * @param {Gh} gh @param {string} repo @param {any[]} list the answer of `GET repos/<repo>/rulesets` @param {string} defaultBranch
 */
export const coveringRulesets = async (gh, repo, list, defaultBranch) => {
  /** @type {any[]} */
  const covering = [];
  /** @type {any[]} */
  const inactive = [];
  for (const s of list.filter((x) => x?.target === 'branch')) {
    const full = await ghJson(gh, ['api', `repos/${repo}/rulesets/${s.id}`]);
    if (!full.ok) continue;
    const include = full.json?.conditions?.ref_name?.include ?? [];
    if (include.some((/** @type {string} */ p) => p === '~DEFAULT_BRANCH' || p === '~ALL' || p === `refs/heads/${defaultBranch}`)) {
      (full.json?.enforcement === 'active' ? covering : inactive).push(full.json);
    }
  }
  return { covering, inactive };
};

/**
 * Reads what `kanon apps` needs to set the Releaser's bypass on one repository: its default
 * branch and the active rulesets covering it, or why it can't.
 * @param {Gh} gh @param {string} repo
 * @returns {Promise<{ defaultBranch: string, covering: any[] } | { unreadable: string }>}
 */
export const readCovering = async (gh, repo) => {
  const meta = await ghJson(gh, ['api', `repos/${repo}`]);
  if (!meta.ok || typeof meta.json?.default_branch !== 'string') return { unreadable: `could not read ${repo} (${meta.r ? meta.r.stderr.trim() || `exit ${meta.r.status}` : 'no default branch'})` };
  const list = await ghJson(gh, ['api', `repos/${repo}/rulesets?includes_parents=true&per_page=100`]);
  if (!list.ok || !Array.isArray(list.json)) return { unreadable: `could not list ${repo}'s rulesets (${list.r ? list.r.stderr.trim() || `exit ${list.r.status}` : 'not a list'})` };
  const defaultBranch = String(meta.json.default_branch);
  return { defaultBranch, covering: (await coveringRulesets(gh, repo, list.json, defaultBranch)).covering };
};

/** @param {BypassActor} a @param {number} appId */
const isReleaser = (a, appId) => a?.actor_type === 'Integration' && Number(a?.actor_id) === appId;

/**
 * Where the covering rulesets stand against `K-MERGE-8`, for the Releaser App `appId`:
 * - `hidden`: rulesets whose bypass list the token can't see (GitHub shows it only to someone
 *   who can edit the ruleset), so nothing can be said about them;
 * - `lacking`: rulesets that don't list the Releaser;
 * - `others`: every other bypass actor, with its ruleset.
 * @param {any[]} covering @param {number} appId
 */
export const releaserBypass = (covering, appId) => {
  const visible = covering.filter((s) => Array.isArray(s?.bypass_actors));
  return {
    hidden: covering.filter((s) => !Array.isArray(s?.bypass_actors)),
    lacking: visible.filter((s) => !s.bypass_actors.some((/** @type {BypassActor} */ a) => isReleaser(a, appId))),
    others: visible.flatMap((s) => s.bypass_actors.filter((/** @type {BypassActor} */ a) => !isReleaser(a, appId)).map((/** @type {BypassActor} */ actor) => ({ ruleset: s, actor }))),
  };
};

/**
 * A bypass actor in words: `the admin role (pull requests only)`.
 * @param {BypassActor} a
 */
export const actorName = (a) => {
  const who =
    a.actor_type === 'RepositoryRole'
      ? Number(a.actor_id) === 5
        ? 'the admin role'
        : `the repository role ${a.actor_id}`
      : a.actor_type === 'OrganizationAdmin'
        ? "the organisation's admins"
        : a.actor_type === 'Integration'
          ? `the App ${a.actor_id}`
          : a.actor_type === 'Team'
            ? `the team ${a.actor_id}`
            : a.actor_type === 'DeployKey'
              ? 'deploy keys'
              : `${a.actor_type ?? 'an actor'} ${a.actor_id ?? ''}`.trim();
  return `${who} (${a.bypass_mode === 'pull_request' ? 'pull requests only' : a.bypass_mode ?? 'always'})`;
};

/** The Releaser's bypass actor entry. @param {number} appId @returns {BypassActor} */
export const releaserActor = (appId) => ({ actor_id: appId, actor_type: 'Integration', bypass_mode: RELEASER_BYPASS_MODE });

/**
 * The command that sets a ruleset's bypass list to `actors`, replacing the list. GitHub's update
 * takes the fields it is given and leaves the rest of the ruleset as it is.
 * @param {string} repo @param {any} ruleset @param {BypassActor[]} actors
 */
export const bypassCommand = (repo, ruleset, actors) => [
  `gh api -X PUT repos/${repo}/rulesets/${ruleset.id} --input - <<'JSON'`,
  JSON.stringify({ bypass_actors: actors.map((a) => ({ actor_id: a.actor_id ?? null, actor_type: a.actor_type, bypass_mode: a.bypass_mode ?? 'always' })) }),
  'JSON',
];

/** The page that edits a ruleset. @param {string} repo @param {any} ruleset */
export const rulesetUrl = (repo, ruleset) =>
  ruleset?.source_type === 'Organization' ? `https://github.com/organizations/${ruleset.source}/settings/rules/${ruleset.id}` : `https://github.com/${repo}/settings/rules/${ruleset.id}`;
