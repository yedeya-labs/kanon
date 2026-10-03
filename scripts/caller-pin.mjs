// A lane started from a branch other than the default runs the Kanon version the default branch
// pins, or it does not run (kanon#69, `K-MERGE-17`'s default-branch principle, #62).
//
// THE GAP. A lane's code comes from its CALLER, the workflow in the adopter's repository that says
// `uses: yedeya-labs/kanon/.github/workflows/agent-<lane>.yml@vX.Y.Z`. On `pull_request_target`
// GitHub runs the base branch's copy of the caller, and on a stacked pull request the base is
// another pull request's branch. Its caller can pin a different Kanon version, older or newer,
// that the default branch never approved. A dispatch with `--ref <branch>` and a schedule on a
// non-default branch run that branch's caller too.
//
// ONLY BETWEEN VERSIONS THAT HAVE IT. The gate runs as `$KANON/scripts/lane-gate.mjs`, which is
// Kanon at the version the RUNNING caller pins. A caller pinning a release from before this check
// runs a gate without it, so this holds a stacked base to the default branch's pin only when the
// base's pin includes the check. Enforcing it from outside the lane is kanon#114.
//
// THE CHECK. The caller's path and the ref it ran from are `GITHUB_WORKFLOW_REF`
// (`owner/repo/<path>@<ref>`); in a called workflow it names the CALLER, as `GITHUB_WORKFLOW_SHA`
// names the caller's commit. When that ref is a branch other than the default, read the caller at
// that commit and at the default branch, and compare every Kanon reference in each
// (`yedeya-labs/kanon/<path>@<ref>`). Any difference refuses, and so does a caller the default
// branch doesn't have. A tag and a pull request's merge ref are checked the same way. The default
// branch's own runs read nothing.
//
// A PULL REQUEST'S MERGE REF IS CHECKED TOO (the Owner's decision on #112). On `pull_request`
// and `pull_request_review` GitHub runs the pull request's own merge of the caller, so a pull
// request could choose the Kanon version that acts on it; it never may (`K-MERGE-17`). Accepted
// consequence: on a pull request that bumps the pin (Dependabot's, for one) those lanes refuse,
// visibly, until it merges. Reviews are unaffected: they run from the base.
//
// A FAILED READ THROWS, so the gate fails its step by name rather than guessing.
//
// NODE BUILTINS ONLY, like the gate that calls it.

/** Every Kanon reference in a workflow, sorted and de-duplicated. @param {string} text @returns {string[]} */
export function kanonRefsOf(text) {
  // GitHub resolves a `uses:` owner and repository case-insensitively, so the match is too, and
  // the owner/repository part is lowercased before comparing: `Yedeya-Labs/kanon/…@<other>` is a
  // Kanon reference, not a way past the check.
  const refs = [...text.matchAll(/^[ \t-]*uses:[ \t]*['"]?(yedeya-labs\/kanon)(\/[^@\s'"#]+@[^\s'"#]+)/gim)]
    .map((m) => `${(m[1] ?? '').toLowerCase()}${m[2] ?? ''}`);
  return [...new Set(refs)].sort();
}

/**
 * The caller's path and ref, from `GITHUB_WORKFLOW_REF`.
 * @param {string} workflowRef `owner/repo/<path>@<ref>`
 * @param {string} repo `owner/repo`
 * @returns {{ path: string, ref: string } | null}
 */
export function parseWorkflowRef(workflowRef, repo) {
  const prefix = `${repo}/`;
  if (!workflowRef.startsWith(prefix)) return null;
  const rest = workflowRef.slice(prefix.length);
  const at = rest.indexOf('@');
  if (at <= 0) return null;
  return { path: rest.slice(0, at), ref: rest.slice(at + 1) };
}

/**
 * Does the caller pin what the default branch pins?
 *
 * @param {{ workflowRef?: string, workflowSha?: string, repo: string, defaultBranch?: string }} run
 * @param {(path: string, ref: string) => string | null} readFile the file at a ref, or null when it doesn't exist there
 * @returns {{ ok: true, reason: string } | { ok: false, reason: string }}
 */
export function checkCallerPin({ workflowRef, workflowSha, repo, defaultBranch }, readFile) {
  // The runner always sets it, so a missing one is refused rather than read as clear (`K-PRIN-10`).
  if (!workflowRef) return { ok: false, reason: 'GITHUB_WORKFLOW_REF is not set, so the caller and its pin are unknown' };
  const caller = parseWorkflowRef(workflowRef, repo);
  if (!caller) return { ok: false, reason: `the caller \`${workflowRef}\` is not a workflow of ${repo}` };
  if (!defaultBranch) return { ok: false, reason: 'the event names no default branch to compare the caller with' };
  if (caller.ref === `refs/heads/${defaultBranch}`) return { ok: true, reason: 'the caller ran from the default branch' };
  // A branch or a tag (a dispatch with `--ref v1.2.0` runs that tag's caller), named without its prefix.
  // Where it ran, for the messages: a branch or tag by name, a merge ref as `pull/<n>/merge`.
  const branch = caller.ref.replace(/^refs\/(heads|tags)\//, '').replace(/^refs\//, '');

  const theirs = readFile(caller.path, workflowSha || caller.ref);
  if (theirs === null) return { ok: false, reason: `\`${caller.path}\` could not be found at \`${branch}\`` };
  const ours = readFile(caller.path, defaultBranch);
  if (ours === null) {
    return { ok: false, reason: `the caller \`${caller.path}\` ran from \`${branch}\`, and the default branch \`${defaultBranch}\` has no such caller` };
  }
  const a = kanonRefsOf(theirs);
  const b = kanonRefsOf(ours);
  if (a.length === b.length && a.every((r, i) => r === b[i])) {
    return { ok: true, reason: `the caller on \`${branch}\` pins what \`${defaultBranch}\` pins` };
  }
  const show = (/** @type {string[]} */ xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(', ') : 'no Kanon reference');
  return {
    ok: false,
    reason: `the caller \`${caller.path}\` ran from \`${branch}\`, which pins ${show(a)}, but the default branch \`${defaultBranch}\` pins ${show(b)}. A lane runs only the Kanon version the default branch pins (kanon#69)`,
  };
}
