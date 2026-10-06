import { describe, expect, it } from 'vitest';
import { readRepositorySubject, subjectPrefix, subjectProblems } from '../../scripts/lib/oidc-subject.mjs';

// The one reading of a GitHub OIDC subject, shared by the QA store's `provision.mjs` and the
// telemetry store's `render.mjs` (kanon#295). The stores' own tests cover how each calls it.

const IMMUTABLE = 'repo:yedeya-labs@335343289/qa-store-sandbox@1405862401';

describe('subjectProblems: an exact default-branch ref subject of the repository', () => {
  it('accepts the classic and the immutable form of a default-branch ref subject', () => {
    expect(subjectProblems(['repo:o/r:ref:refs/heads/main'], 'o/r', 'main')).toEqual([]);
    expect(subjectProblems([`${IMMUTABLE}:ref:refs/heads/main`], 'yedeya-labs/qa-store-sandbox', 'main')).toEqual([]);
    // Both at once, while a repository migrates between the forms.
    expect(subjectProblems(['repo:O/R:ref:refs/heads/trunk', 'repo:o@1/r@2:ref:refs/heads/trunk'], 'o/r', 'trunk')).toEqual([]);
  });

  it('refuses an environment, a pull request, a tag, a pattern or another repository', () => {
    expect(subjectProblems([], 'o/r', 'main')).toEqual(['no subject to trust']);
    for (const s of ['repo:o/r:environment:kanon-qa-store', 'repo:o/r:pull_request', 'repo:o/r:ref:refs/tags/v1', 'repo:o/r:ref:refs/heads/']) {
      expect(subjectProblems([s], 'o/r', 'main')).toEqual([`'${s}' is not a branch ref subject (<prefix>:ref:refs/heads/<branch>)`]);
    }
    for (const s of ['repo:o/r:*', 'repo:o/r:ref:refs/heads/*', 'repo:o/r:ref:refs/heads/a,b', 'repo:o/r:ref:refs/heads/ma?n', 'repo:o/r:ref:refs/heads/[m]ain']) {
      expect(subjectProblems([s], 'o/r', 'main')).toEqual([`'${s}' is not a string free of pattern characters, commas and spaces`]);
    }
    expect(subjectProblems(['repo:o/r:environment:qa:ref:refs/heads/main'], 'o/r', 'main')).toEqual(["'repo:o/r:environment:qa:ref:refs/heads/main' names an environment or a pull request"]);
    expect(subjectProblems(['repo:x/r:ref:refs/heads/main'], 'o/r', 'main')).toEqual(["'repo:x/r:ref:refs/heads/main' is not a subject of o/r"]);
    expect(subjectProblems(['repo:o@1/x@2:ref:refs/heads/main'], 'o/r', 'main')).toEqual(["'repo:o@1/x@2:ref:refs/heads/main' is not a subject of o/r"]);
    expect(subjectProblems(['repository_owner:o:context:ref:refs/heads/main'], 'o/r', 'main')).toEqual(["'repository_owner:o:context:ref:refs/heads/main' names no repository, so it would trust others"]);
  });

  it('refuses a branch that is not the default branch, given explicitly or not (K-OBS-17)', () => {
    expect(subjectProblems(['repo:o/r:ref:refs/heads/feature-x'], 'o/r', 'main'))
      .toEqual(["'repo:o/r:ref:refs/heads/feature-x' names the branch 'feature-x', not o/r's default branch 'main'"]);
    expect(subjectProblems(['repo:o/r:ref:refs/heads/main', 'repo:o@1/r@2:ref:refs/heads/main'], 'o/r', 'trunk')).toHaveLength(2);
    // A branch whose name extends the default's is another branch.
    expect(subjectProblems(['repo:o/r:ref:refs/heads/main/x'], 'o/r', 'main')).toHaveLength(1);
    expect(subjectProblems(['repo:o/r:context:ref:refs/heads/dev:job_workflow_ref:o/r/.github/workflows/x.yml@refs/heads/main'], 'o/r', 'main')).toHaveLength(1);
  });

  it('accepts any branch when none is required (a telemetry reader)', () => {
    expect(subjectProblems(['repo:o/r:ref:refs/heads/feature-x'], 'o/r', null)).toEqual([]);
    expect(subjectProblems(['repo:o/r:environment:qa'], 'o/r', null)).toHaveLength(1);
  });

  it('accepts a custom template\'s exact subject that names the repository and the branch', () => {
    expect(subjectProblems(['repo:o/r:context:ref:refs/heads/main:job_workflow_ref:o/r/.github/workflows/x.yml@refs/heads/main'], 'o/r', 'main')).toEqual([]);
  });
});

describe('subjectPrefix and readRepositorySubject: the form GitHub reports', () => {
  it('reads the prefix from GitHub\'s customization answer', () => {
    // Measured on the sandbox, 2026-10-05: a repository created after 2026-07-15.
    expect(subjectPrefix('yedeya-labs/qa-store-sandbox', { use_default: true, use_immutable_subject: true, sub_claim_prefix: IMMUTABLE })).toBe(IMMUTABLE);
    expect(subjectPrefix('o/r', { use_default: true })).toBe('repo:o/r');
    expect(subjectPrefix('o/r', { use_default: true, use_immutable_subject: false, sub_claim_prefix: 'repo:o@1/r@2' })).toBe('repo:o/r');
    expect(() => subjectPrefix('o/r', { use_default: false, include_claim_keys: ['repo', 'context', 'job_workflow_ref'] })).toThrow(/customizes its OIDC subject/);
    expect(() => subjectPrefix('o/r', { use_default: true, use_immutable_subject: true, sub_claim_prefix: 'repo:o/r' })).toThrow(/immutable/);
  });

  it('returns a custom template as a problem rather than throwing, so given subjects still work', () => {
    const gh = (args: string[]) => JSON.stringify(args[1] === 'repos/o/r' ? { full_name: 'o/r', default_branch: 'trunk' } : { use_default: false });
    expect(readRepositorySubject('o/r', gh)).toEqual({ defaultBranch: 'trunk', prefix: null, problem: expect.stringMatching(/customizes its OIDC subject/) });
  });
});
