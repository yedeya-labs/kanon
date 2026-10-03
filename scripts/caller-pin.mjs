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
// THE CHECK. The caller's path and the ref it ran from are `GITHUB_WORKFLOW_REF`
// (`owner/repo/<path>@<ref>`); in a called workflow it names the CALLER, as `GITHUB_WORKFLOW_SHA`
// names the caller's commit. When that ref is a branch other than the default, read the caller at
// that commit and at the default branch, and compare every Kanon reference in each
// (`yedeya-labs/kanon/<path>@<ref>`). Any difference refuses, and so does a caller the default
// branch doesn't have. The default branch's own runs read nothing.
//
// NOT CHECKED: a `pull_request` or `pull_request_review` run, whose ref is `refs/pull/<n>/merge`.
// There GitHub runs the pull request's own merge of the caller, which is a wider question than a
// stacked base (any pull request can edit its caller), and a Dependabot pull request that bumps the
// pin is exactly such a run. It is left to the Owner (see the pull request that added this).
//
// A FAILED READ THROWS, so the gate fails its step by name rather than guessing.
//
// NODE BUILTINS ONLY, like the gate that calls it.

/** Every Kanon reference in a workflow, sorted and de-duplicated. @param {string} text @returns {string[]} */
export function kanonRefsOf(text) {
  const refs = [...text.matchAll(/^[ \t-]*uses:[ \t]*['"]?(yedeya-labs\/kanon\/[^@\s'"#]+@[^\s'"#]+)/gm)].map((m) => m[1] ?? '');
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
  if (!workflowRef) return { ok: true, reason: 'no caller ref to check (not on a runner)' };
  const caller = parseWorkflowRef(workflowRef, repo);
  if (!caller) return { ok: false, reason: `the caller \`${workflowRef}\` is not a workflow of ${repo}` };
  if (!caller.ref.startsWith('refs/heads/')) return { ok: true, reason: `the caller ran from \`${caller.ref}\`, not a branch` };
  if (!defaultBranch) return { ok: false, reason: 'the event names no default branch to compare the caller with' };
  const branch = caller.ref.slice('refs/heads/'.length);
  if (branch === defaultBranch) return { ok: true, reason: 'the caller ran from the default branch' };

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
