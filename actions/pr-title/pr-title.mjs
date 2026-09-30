// Kanon's PR-title check (K-SHIP-4). A title must be a conventional commit whose type
// the release tool recognises, and must not end in an issue reference: the platform
// appends the PR number at squash time, and the release tool drops a double reference.
//
// The type table is Kanon's fixed table. It is not configurable (ADR 0002). Kanon's
// tests pin it, and fail when it disagrees with release-please-config.json.
//
// Usage: PR_TITLE="feat: ..." node pr-title.mjs   (the action's form)
//        node pr-title.mjs "feat: ..."             (local validation before opening a PR)
//
// Needs Node 18 or later (checked on 18, 20 and 24), and no dependencies.

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
 * Runs the check and reports it. Returns the process exit code.
 * @param {string} title
 * @param {{ log: (s: string) => void, error: (s: string) => void }} out
 */
export function main(title, out = console) {
  const result = checkTitle(title);
  if (result.ok) {
    out.log(`PR title OK: ${title}`);
    return 0;
  }
  out.error(`PR title "${title}" ${result.reason}.`);
  out.error(`Recognised types: ${Object.keys(TYPES).join(', ')}.`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.env.PR_TITLE ?? process.argv[2] ?? '');
}
