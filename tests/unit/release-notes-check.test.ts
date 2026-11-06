import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_GH, REPO, contents, steps } from './helpers/release-pr-guard.js';
import { writeStub } from './helpers/stub-bin.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * kanon#1662: release-please skips a `feat` or `fix` commit its parser can't read, logs it only
 * in its own output, and the release run went green with the commit missing from the release
 * notes. The release workflow's last step checks the effect: each such commit since the last
 * release appears, by its short SHA, in the release PR's body or changelog, or the step names it
 * in an error annotation and the summary, and fails. The step's script is read out of release.yml
 * and run against a fake `gh`, as the release-PR guard's tests run theirs.
 */
const step = steps.find((s) => s.name === 'Check every feat and fix reached the release notes')!;
const HEAD = 'abcdef0123456789';
const LAST = '1111111aaaa';
const commit = (sha: string, message: string) => ({ sha, commit: { message } });
const FEAT = commit('aaaaaaa0001', 'feat(viewer): load the model from the fetched GLB (#12)\n\nUses `JSON.stringify(build())`.');
const FIX = commit('bbbbbbb0002', 'fix: keep the camera inside the room (#13)');
const DOCS = commit('ccccccc0003', 'docs: say how to run it (#14)');
const CONFIG = JSON.stringify({ packages: { '.': { 'changelog-path': 'CHANGELOG.md' } } });

type Pr = { number: number; body: string; head: { ref: string; repo: { full_name: string } } };
const releasePr = (number: number, body: string, ref = 'release-please--branches--main'): Pr => ({ number, body, head: { ref, repo: { full_name: REPO } } });

const run = (opts: { commits?: unknown[]; prs?: Pr[]; changelog?: string | null; config?: string; noManifestHistory?: boolean; compareFails?: boolean; pages?: unknown[][] }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-release-notes-'));
  writeStub(join(dir, 'gh'), FAKE_GH);
  const answers: Record<string, unknown> = {
    [`repos/${REPO}/commits?sha=${HEAD}&path=.release-please-manifest.json&per_page=1`]: opts.noManifestHistory ? [] : [{ sha: LAST }],
    [`repos/${REPO}/contents/release-please-config.json?ref=${HEAD}`]: contents(opts.config ?? CONFIG),
    // The open pull requests, the release PR among them or not: never taken from release-please's `pr` output.
    [`repos/${REPO}/pulls?state=open&per_page=100`]: [...(opts.prs ?? [releasePr(68, '')]), { number: 3, body: 'aaaaaaa', head: { ref: 'feat/x', repo: { full_name: REPO } } }],
  };
  if (!opts.compareFails) answers[`repos/${REPO}/compare/${LAST}...${HEAD}?per_page=100`] = { commits: opts.commits ?? [] };
  if (opts.changelog !== null) answers[`repos/${REPO}/contents/CHANGELOG.md?ref=release-please--branches--main`] = contents(opts.changelog ?? '');
  for (const [path, body] of Object.entries(answers)) writeFileSync(join(dir, `${path.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), JSON.stringify(body));
  // Several pages of the compare, as `--paginate --slurp` joins them: the fake slurps one file, so a
  // multi-page answer is written as its pages' bodies separated by commas.
  if (opts.pages) writeFileSync(join(dir, `repos/${REPO}/compare/${LAST}...${HEAD}?per_page=100`.replace(/[^A-Za-z0-9._-]/g, '_') + '.json'), opts.pages.map((cs) => JSON.stringify({ commits: cs })).join(','));
  const script = join(dir, 'step');
  writeFileSync(script, step.run ?? 'process.exit(99)');
  const summary = join(dir, 'summary');
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: dir, GITHUB_REPOSITORY: REPO, HEAD_SHA: HEAD, GITHUB_STEP_SUMMARY: summary },
  });
  return { ...r, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' };
};

describe('every feat and fix reaches the release notes, or the release run says which did not (kanon#1662)', SPAWNS, () => {
  it('runs last, after release-please, unless it released, even after the release-PR guard fails, and reads no release-please output', () => {
    expect(step).toBeDefined();
    expect(steps.at(-1)).toBe(step);
    expect(step.if).toBe("${{ !cancelled() && steps.release.conclusion == 'success' && steps.release.outputs.release_created != 'true' }}");
    expect(step.env).toEqual({ GH_TOKEN: '${{ github.token }}', HEAD_SHA: '${{ github.sha }}' });
    // Its inputs reach it through the environment only, never an expression in the script.
    expect(step.run).not.toContain('${{');
  });

  it('passes when each feat and fix is in the release notes, by its short SHA', () => {
    const r = run({ commits: [FEAT, FIX, DOCS], prs: [releasePr(68, '* **viewer:** load the model ([aaaaaaa](x))')], changelog: '* keep the camera inside the room ([bbbbbbb](x))' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('All 2 feat and fix commit(s) since the last release are in the notes of release PR #68');
  });

  // The Reviewer's case: release-please leaves its `pr` output empty when an open release PR
  // "remained the same". The step lists the open PRs, so it reads that PR all the same.
  it("reads an open release PR this run didn't update, and names only the commit it dropped", () => {
    const r = run({ commits: [FEAT, FIX], prs: [releasePr(68, '* keep the camera inside the room ([bbbbbbb](x))')] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error title=Commit missing from the release notes::aaaaaaa "feat(viewer): load the model from the fetched GLB (#12)" is not in the notes of release PR #68.');
    expect(r.stdout).not.toContain('bbbbbbb "fix');
    expect(r.summary).toContain('### Release notes check: 1 commit(s) missing');
    expect(r.summary).toContain('BEGIN_COMMIT_OVERRIDE');
  });

  it('fails when no release PR is open though a feat or fix landed, and ignores other pull requests', () => {
    const r = run({ commits: [FEAT], prs: [] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('is not in any release PR: none is open');
  });

  it('reads every page of the commits since the last release', () => {
    const r = run({ pages: [[DOCS], [FEAT]], prs: [releasePr(68, '')] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('aaaaaaa "feat(viewer)');
  });

  it('only warns for a config where a commit can rightly be in no notes: another package, or exclude-paths', () => {
    for (const config of [
      JSON.stringify({ packages: { '.': {}, 'packages/a': { 'changelog-path': 'CHANGELOG.md' } } }),
      JSON.stringify({ 'exclude-paths': ['ci'], packages: { '.': {} } }),
      JSON.stringify({ packages: { '.': { 'exclude-paths': ['ci'] } } }),
    ]) {
      const r = run({ commits: [FEAT], config });
      expect(r.status, config).toBe(0);
      expect(r.stdout).toContain('::warning title=Release notes check::1 feat or fix commit(s) are in no release PR');
    }
  });

  it('passes with nothing releasable, and only warns when it cannot tell', () => {
    expect(run({ commits: [DOCS] }).status).toBe(0);
    for (const opts of [{ noManifestHistory: true }, { compareFails: true }]) {
      const r = run({ commits: [FEAT], ...opts });
      expect(r.status, JSON.stringify(opts)).toBe(0);
      expect(r.stdout).toContain('::warning title=Release notes check::');
    }
  });
});
