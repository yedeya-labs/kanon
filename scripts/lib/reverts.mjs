// What a commit message or a pull request body says it reverts (kanon#161), read by the Lead's
// reconciler (`lead-reconcile.mjs`, whether a project's merges are still in a release) and by the
// metrics detectors (`metrics/detectors.mjs`, plan 0003 §3.5, whether a merged item was reverted).
// One parser, so the two can't disagree about what a revert is.

/**
 * What one commit message says it reverts (kanon#161): the commits git names
 * (`This reverts commit <sha>.`, which `git revert` and GitHub's Revert button both write)
 * and the pull requests GitHub names (`Reverts <owner>/<repo>#N`, the Revert button's PR
 * body, which a squash merge can carry instead). Only `repo`'s own pull requests count.
 *
 * @param {string} message @param {string} repo
 * @returns {{shas: string[], prs: number[]}}
 */
export function revertTargets(message, repo) {
  const shas = [...String(message).matchAll(/reverts commit ([0-9a-f]{7,40})\b/gi)].map((m) => String(m[1]).toLowerCase());
  const prs = [...String(message).matchAll(/^Reverts ([\w.-]+\/[\w.-]+)#(\d+)\b/gim)]
    .filter((m) => String(m[1]).toLowerCase() === String(repo).toLowerCase())
    .map((m) => Number(m[2]));
  return { shas, prs };
}

/**
 * The `--jq` prefilter for reverts, a regex that must hold every message `revertTargets`
 * accepts. Exported so a test evaluates the SAME pattern. It may use no anchor and no flag
 * but `i`, so that JavaScript and gojq read it the same way.
 */
export const REVERT_PREFILTER = 'reverts commit [0-9a-f]{7}|reverts [^ ]+#[0-9]';
