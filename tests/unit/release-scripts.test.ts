// Runs the release workflow's inline scripts exactly as the runner does (`shell: node {0}`
// writes the run body to an extension-less file and runs it with node), against a fake
// `gh` on PATH that answers from fixtures. The scripts are read out of release.yml, so
// what is tested is what runs.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { id?: string; name?: string; run?: string; shell?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const wf = parse(
  readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
) as Workflow;
const steps = Object.values(wf.jobs).flatMap((job) => job.steps);
const guard = steps.find((s) => s.id === 'merge-settings');
const explain = steps.find((s) => s.name === 'Explain a failed release');

const REPO = 'acme/widget';
const fileFor = (path: string) => `${path.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_DIR/calls.log"
f="$FAKE_GH_DIR/$(printf %s "$2" | tr -c 'A-Za-z0-9._-' '_').json"
if [ -f "$f" ]; then cat "$f"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
`;

const runStep = (step: Step | undefined, responses: Record<string, unknown>, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-release-'));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  for (const [path, body] of Object.entries(responses)) writeFileSync(join(dir, fileFor(path)), JSON.stringify(body));
  const script = join(dir, 'step');
  writeFileSync(script, step?.run ?? 'process.exit(99)');
  const output = join(dir, 'output');
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_GH_DIR: dir,
      GITHUB_REPOSITORY: REPO,
      GITHUB_REPOSITORY_OWNER: 'acme',
      GITHUB_OUTPUT: output,
      ...env,
    },
  });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return { ...result, output: read('output'), calls: read('calls.log') };
};

const good = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
};
const settings = (overrides: Record<string, unknown>) => ({ [`repos/${REPO}`]: { full_name: REPO, ...good, ...overrides } });

describe('K-SHIP-3 the merge-settings guard', () => {
  it('passes squash-only settings with the PR title and body, and records when it ran', () => {
    const result = runStep(guard, settings({}));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Merge settings OK');
    expect(result.calls.trim()).toBe(`api repos/${REPO}`);
    expect(result.output).toMatch(/^started=\d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
  });

  it.each([
    ['merge commits allowed', { allow_merge_commit: true }, 'allow_merge_commit is true, must be false'],
    ['rebase merges allowed', { allow_rebase_merge: true }, 'allow_rebase_merge is true, must be false'],
    ['squash merging off', { allow_squash_merge: false }, 'allow_squash_merge is false, must be true'],
    ['a wrong title source', { squash_merge_commit_title: 'COMMIT_OR_PR_TITLE' }, 'squash_merge_commit_title is "COMMIT_OR_PR_TITLE", must be "PR_TITLE"'],
    ['a wrong message source', { squash_merge_commit_message: 'COMMIT_MESSAGES' }, 'squash_merge_commit_message is "COMMIT_MESSAGES", must be "PR_BODY"'],
  ])('fails %s, naming the setting and the fix', (_, overrides, reason) => {
    const result = runStep(guard, settings(overrides));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error title=Merge settings break releases::');
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain(`gh api -X PATCH repos/${REPO} -F allow_squash_merge=true -F allow_merge_commit=false`);
    expect(result.output).toBe('');
  });

  it('lists every wrong setting, not only the first', () => {
    const result = runStep(guard, settings({ allow_merge_commit: true, squash_merge_commit_message: 'BLANK' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('allow_merge_commit is true');
    expect(result.stderr).toContain('squash_merge_commit_message is "BLANK"');
  });

  it('fails closed when the fields are missing, as they are to a token that cannot push', () => {
    const result = runStep(guard, { [`repos/${REPO}`]: { full_name: REPO, allow_forking: false } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error title=Merge settings unreadable::');
    expect(result.stderr).toContain(
      'could not read allow_squash_merge, allow_merge_commit, allow_rebase_merge, squash_merge_commit_title, squash_merge_commit_message',
    );
    expect(result.stderr).toContain('grant contents: write');
    expect(result.output).toBe('');
  });

  it('fails closed when a field comes back null, and names only that field', () => {
    const result = runStep(guard, settings({ squash_merge_commit_title: null }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not read squash_merge_commit_title from');
  });

  it('fails closed when the API call itself fails', () => {
    const result = runStep(guard, {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`could not read repos/${REPO}`);
    expect(result.output).toBe('');
  });
});

describe('K-SHIP-7 explaining a failed release', () => {
  const branch = 'release-please--branches--main--components--widget';
  const now = new Date();
  const later = new Date(now.getTime() + 5_000).toISOString();
  const lastWeek = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const api = (opts: { open?: string[]; branches?: string[]; date?: string }) => ({
    [`repos/${REPO}/pulls?state=open&per_page=100`]: (opts.open ?? []).map((ref) => ({ head: { ref } })),
    [`repos/${REPO}/git/matching-refs/heads/release-please--`]: (opts.branches ?? []).map((name) => ({
      ref: `refs/heads/${name}`,
      object: { sha: 'abc123' },
    })),
    [`repos/${REPO}/commits/abc123`]: { commit: { committer: { date: opts.date ?? later } } },
  });
  const started = { STARTED: now.toISOString() };

  it('says GitHub refused the release PR when the branch was pushed this run and has no PR, organisation first', () => {
    const result = runStep(explain, api({ branches: [branch] }), started);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error title=GitHub Actions may not create pull requests::');
    const org = result.stderr.indexOf('Organisation acme:');
    const repo = result.stderr.indexOf(`Repository ${REPO}:`);
    expect(org).toBeGreaterThan(-1);
    expect(repo).toBeGreaterThan(org);
    expect(result.stderr).toContain('gh api -X PUT orgs/acme/actions/permissions/workflow -F can_approve_pull_request_reviews=true');
    expect(result.stderr).toContain(`gh api -X PUT repos/${REPO}/actions/permissions/workflow -F can_approve_pull_request_reviews=true`);
  });

  it("allows for the runner's clock being ahead of GitHub's by up to two minutes", () => {
    const skewed = new Date(now.getTime() - 60_000).toISOString();
    const result = runStep(explain, api({ branches: [branch], date: skewed }), started);
    expect(result.stdout).toContain('may not create pull requests');
  });

  it.each([
    ['the release PR is open', api({ branches: [branch], open: [branch] }), started],
    ['the release branch is left over from a merged release', api({ branches: [branch], date: lastWeek }), started],
    ['there is no release branch', api({}), started],
    ['the run start is unknown', api({ branches: [branch] }), {}],
    ['the API cannot be read', {}, started],
  ])('falls back to a conditional hint, still failing, when %s', (_, responses, env) => {
    const result = runStep(explain, responses, env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error title=release-please failed::');
    expect(result.stdout).not.toContain('may not create pull requests');
    expect(result.stderr).toContain('If that log says "GitHub Actions is not permitted to create or approve pull requests"');
    expect(result.stderr.indexOf('Organisation acme:')).toBeLessThan(result.stderr.indexOf(`Repository ${REPO}:`));
  });
});
