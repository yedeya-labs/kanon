// Kanon's PR-title check (K-SHIP-4). A title must be a conventional commit whose type
// the release tool recognises, and must not end in an issue reference: the platform
// appends the PR number at squash time, and the release tool drops a double reference.
//
// It also checks the PR's head branch (K-WS-8): a working branch is named
// `<type>/<number>-<slug>`, its type one of the same table's. A branch a tool makes is
// exempt, by the fixed list below; the worktree script names the rest, and this catches
// a branch made by hand, a person's or an agent's.
//
// The type table and the tool list are Kanon's. Neither is configurable (ADR 0002).
// Kanon's tests pin both, and fail when the table disagrees with
// release-please-config.json or a listed tool stops naming its branch that way.
//
// Usage: PR_TITLE="feat: ..." PR_BRANCH="feat/12-x" node pr-title.mjs   (the action's form)
//        node pr-title.mjs "feat: ..." [feat/12-x]   (local validation before opening a PR)
//
// Needs Node 18 or later (checked on 18, 20 and 24), and no dependencies.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Types the release tool recognises, and whether each one deploys. */
export const TYPES = /** @type {const} */ ({
  feat: { bump: 'minor', deploys: true },
  fix: { bump: 'patch', deploys: true },
  perf: { bump: 'patch', deploys: true },
  refactor: { bump: 'patch', deploys: true },
  build: { bump: 'patch', deploys: true },
  revert: { bump: 'patch', deploys: true },
  docs: { bump: 'patch', deploys: false },
  style: { bump: 'patch', deploys: false },
  test: { bump: 'patch', deploys: false },
  ci: { bump: 'patch', deploys: false },
  chore: { bump: 'patch', deploys: false },
});

const SHAPE = /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9._/-]+)\))?!?: (?<description>\S.*)$/;
const TRAILING_REF = /\(#\d+\)\s*$/;

/** `<type>/<number>-<slug>`: an issue number, and a slug of lowercase words joined by single hyphens. */
const BRANCH = /^(?<type>[a-z]+)\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The branches tools make, which K-WS-8 doesn't hold: each tool names its own. */
export const TOOL_BRANCHES = /** @type {const} */ ([
  { pattern: /^dependabot\//, tool: 'Dependabot' },
  { pattern: /^release-please--branches--/, tool: 'release-please' },
  { pattern: /^lead\/split-[1-9][0-9]*$/, tool: "the Lead's split lane" },
  { pattern: /^kanon\/upgrade-./, tool: "Kanon's upgrade skill" },
  { pattern: /^kanon\/pins-./, tool: "Kanon's candidate pin pull request" },
  { pattern: /^kanon\/metrics-page$/, tool: "Kanon's metrics page" },
]);

/**
 * @param {string} title
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkTitle(title) {
  const trimmed = title.trim();
  if (TRAILING_REF.test(trimmed)) {
    return { ok: false, reason: 'ends in an issue reference such as "(#12)"; the platform adds the PR number itself' };
  }
  const match = SHAPE.exec(trimmed);
  const type = match?.groups?.type;
  if (type === undefined) {
    return { ok: false, reason: 'is not a conventional commit: expected "<type>[(<scope>)][!]: <description>"' };
  }
  if (!Object.hasOwn(TYPES, type)) {
    return { ok: false, reason: `uses the type "${type}", which the release tool does not recognise` };
  }
  return { ok: true };
}

/**
 * @param {string} branch
 * @returns {{ ok: true, tool?: string } | { ok: false, reason: string }}
 */
export function checkBranch(branch) {
  const tool = TOOL_BRANCHES.find((t) => t.pattern.test(branch))?.tool;
  if (tool !== undefined) return { ok: true, tool };
  const type = BRANCH.exec(branch)?.groups?.type;
  if (type === undefined) {
    return { ok: false, reason: 'is not named "<type>/<number>-<slug>", such as "fix/42-empty-cart-total"' };
  }
  if (!Object.hasOwn(TYPES, type)) {
    return { ok: false, reason: `uses the type "${type}", which is not one of the PR-title types` };
  }
  return { ok: true };
}

/**
 * Runs both checks and reports them. Returns the process exit code. An empty branch is
 * not checked: outside a pull request there is no head branch to read.
 * @param {string} title
 * @param {{ log: (s: string) => void, error: (s: string) => void }} out
 * @param {string} branch
 */
export function main(title, out = console, branch = '') {
  let failed = false;
  const result = checkTitle(title);
  if (result.ok) out.log(`PR title OK: ${title}`);
  else {
    out.error(`PR title "${title}" ${result.reason}.`);
    failed = true;
  }
  if (branch === '') out.log('No branch to check: the head branch is read only on a pull request.');
  else {
    const named = checkBranch(branch);
    if (!named.ok) {
      out.error(`Branch "${branch}" ${named.reason}.`);
      out.error('Name a working branch <type>/<issue>-<slug> (K-WS-8), and open the pull request again from a branch so named.');
      failed = true;
    } else if (named.tool !== undefined) out.log(`Branch ${branch} is made by ${named.tool}, so K-WS-8 doesn't hold it.`);
    else out.log(`Branch name OK: ${branch}`);
  }
  if (failed) out.error(`Recognised types: ${Object.keys(TYPES).join(', ')}.`);
  return failed ? 1 : 0;
}

// The realpath idiom inline rather than `scripts/lib/cli-entry.mjs`'s `isCliEntry`, because
// this action has no dependencies by design (see the header): run through a symlinked
// path, a raw `argv[1]` comparison exits 0 having done nothing (kanon#191).
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (IS_CLI) {
  process.exitCode = main(process.env.PR_TITLE ?? process.argv[2] ?? '', console, process.env.PR_BRANCH ?? process.argv[3] ?? '');
}
