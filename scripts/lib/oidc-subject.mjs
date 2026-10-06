// The GitHub OIDC subject a cloud role trusts: a repository's default-branch ref, in the form that
// repository actually issues (plan 0002 §3; plan 0004 decision 9, as the Owner changed it on
// 2026-10-05: no GitHub Environments).
//
// TWO FORMS, READ FROM GITHUB, NEVER GUESSED. A repository created before 2026-07-15 issues
// `repo:<owner>/<repo>:ref:refs/heads/<branch>`; one created after it issues the immutable
// `repo:<owner>@<owner id>/<repo>@<repo id>:ref:refs/heads/<branch>`, which a role naming
// `repo:<owner>/<repo>` refuses (measured on a sandbox, 2026-10-05). So the prefix comes from
// `repos/<o>/<r>/actions/oidc/customization/sub` and the branch from `repos/<o>/<r>`. A custom
// subject template (`use_default: false`) makes the subject something else entirely, so it is
// refused unless the caller names the exact subject.
//
// THE ONE HOME (kanon#295, `K-PRIN-2`). Both stores read their subjects here: the telemetry
// store's `infra/telemetry/render.mjs` and the QA store's `infra/qa-store/aws/provision.mjs`. A
// second copy would let a fix (a new subject form GitHub introduces, say) reach one store and not
// the other, so that one trusts a subject the other refuses. `tests/unit/oidc-subject.test.ts`
// holds the subject checks; each store's own test covers only how it calls them.

import { execFileSync } from 'node:child_process';

/** A branch name as a subject may carry it: no pattern characters, no spaces, no commas. */
export const BRANCH = /^[A-Za-z0-9._/-]+$/;
/** The immutable subject prefix GitHub gives a repository created after 2026-07-15. */
export const IMMUTABLE_PREFIX = /^repo:([A-Za-z0-9_.-]+)@(\d+)\/([A-Za-z0-9_.-]+)@(\d+)$/;

/**
 * The subject prefix GitHub puts in the repository's OIDC tokens.
 * @param {string} repository owner/name
 * @param {{ use_default?: boolean, use_immutable_subject?: boolean, sub_claim_prefix?: string, include_claim_keys?: string[] }} customization
 *   the answer of `repos/<o>/<r>/actions/oidc/customization/sub`
 * @returns {string}
 */
export function subjectPrefix(repository, customization) {
  if (customization.use_default === false) {
    throw new Error(`${repository} customizes its OIDC subject (include_claim_keys: ${JSON.stringify(customization.include_claim_keys ?? [])}), so its subject is not <prefix>:ref:refs/heads/<branch>; name the exact subjects instead`);
  }
  if (customization.use_immutable_subject) {
    const prefix = customization.sub_claim_prefix ?? '';
    if (!IMMUTABLE_PREFIX.test(prefix)) throw new Error(`${repository} has an immutable OIDC subject, but GitHub reported its prefix as '${prefix}', not repo:<owner>@<id>/<repo>@<id>`);
    return prefix;
  }
  return `repo:${repository}`;
}

/** @param {string[]} args */
const ghApi = (args) => execFileSync('gh', args, { encoding: 'utf8' });

/**
 * The repository's default branch and subject prefix, from GitHub's API through `gh`. GitHub's
 * `full_name` must equal `repository` exactly: `gh api` follows a rename's redirect, and IAM's
 * `StringEquals` is case-sensitive, so a renamed or differently cased entry would otherwise render
 * cleanly and fail only at the first collector run.
 * @param {string} repository owner/name
 * @param {(args: string[]) => string} [gh]
 * @returns {{ defaultBranch: string, prefix: string | null, problem: string | null }}
 *   `prefix` is null, and `problem` says why, when the repository customizes its subject.
 */
export function readRepositorySubject(repository, gh = ghApi) {
  const repo = JSON.parse(gh(['api', `repos/${repository}`]));
  if (repo.full_name !== repository) throw new Error(`GitHub calls ${repository} '${repo.full_name}': write the register entry as GitHub spells it`);
  const defaultBranch = String(repo.default_branch ?? '');
  if (!BRANCH.test(defaultBranch)) throw new Error(`GitHub reported ${repository}'s default branch as '${defaultBranch}'`);
  const customization = JSON.parse(gh(['api', `repos/${repository}/actions/oidc/customization/sub`]));
  try {
    return { defaultBranch, prefix: subjectPrefix(repository, customization), problem: null };
  } catch (e) {
    return { defaultBranch, prefix: null, problem: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * What's wrong with subjects a role would trust. Each must be exact (no pattern character, comma
 * or space), carry the claim `ref:refs/heads/<branch>` and no environment or pull request, and
 * name the repository in its `repo` claim, in the classic or the immutable form. When `branch` is
 * given, the ref must be that branch: a writer trusting another branch would let anyone who can
 * push to it write.
 * @param {string[]} subjects
 * @param {string} repository owner/name
 * @param {string | null} branch the one branch every subject must name, or null for any
 * @returns {string[]}
 */
export function subjectProblems(subjects, repository, branch) {
  /** @type {string[]} */
  const out = [];
  if (subjects.length === 0) out.push('no subject to trust');
  const [owner, repo] = repository.toLowerCase().split('/');
  for (const s of subjects) {
    if (typeof s !== 'string' || /[*?,\s[\]]/.test(s)) { out.push(`'${s}' is not a string free of pattern characters, commas and spaces`); continue; }
    const ref = /(?:^|:)ref:refs\/heads\/([A-Za-z0-9._/-]+)(?::|$)/.exec(s)?.[1];
    if (ref === undefined) { out.push(`'${s}' is not a branch ref subject (<prefix>:ref:refs/heads/<branch>)`); continue; }
    if (/(^|:)(environment|pull_request)(:|$)/.test(s)) { out.push(`'${s}' names an environment or a pull request`); continue; }
    if (branch !== null && ref !== branch) { out.push(`'${s}' names the branch '${ref}', not ${repository}'s default branch '${branch}'`); continue; }
    const claim = /(?:^|:)repo:([^:]+)/.exec(s)?.[1];
    if (claim === undefined) { out.push(`'${s}' names no repository, so it would trust others`); continue; }
    const immutable = IMMUTABLE_PREFIX.exec(`repo:${claim}`);
    const names = immutable ? [immutable[1], immutable[3]] : claim.split('/');
    if (names.length !== 2 || names[0]?.toLowerCase() !== owner || names[1]?.toLowerCase() !== repo) out.push(`'${s}' is not a subject of ${repository}`);
  }
  return out;
}
