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

const run = (opts: { commits?: unknown[]; body?: string; changelog?: string | null; pr?: boolean; noManifestHistory?: boolean; compareFails?: boolean }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-release-notes-'));
  writeStub(join(dir, 'gh'), FAKE_GH);
  const answers: Record<string, unknown> = {
    [`repos/${REPO}/commits?sha=${HEAD}&path=.release-please-manifest.json&per_page=1`]: opts.noManifestHistory ? [] : [{ sha: LAST }],
    [`repos/${REPO}/pulls/68`]: { body: opts.body ?? '' },
    [`repos/${REPO}/contents/release-please-config.json?ref=${HEAD}`]: contents(CONFIG),
  };
  if (!opts.compareFails) answers[`repos/${REPO}/compare/${LAST}...${HEAD}?per_page=250`] = { commits: opts.commits ?? [] };
  if (opts.changelog !== null) answers[`repos/${REPO}/contents/CHANGELOG.md?ref=release-please--branches--main`] = contents(opts.changelog ?? '');
  for (const [path, body] of Object.entries(answers)) writeFileSync(join(dir, `${path.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), JSON.stringify(body));
  const script = join(dir, 'step');
  writeFileSync(script, step.run ?? 'process.exit(99)');
  const summary = join(dir, 'summary');
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: dir, GITHUB_REPOSITORY: REPO, HEAD_SHA: HEAD, GITHUB_STEP_SUMMARY: summary,
      PR_JSON: opts.pr === false ? '' : JSON.stringify({ number: 68, headBranchName: 'release-please--branches--main' }),
    },
  });
  return { ...r, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' };
};

describe('every feat and fix reaches the release notes, or the release run says which did not (kanon#1662)', SPAWNS, () => {
  it('runs last, after release-please, unless it released, and even after the release-PR guard fails', () => {
    expect(step).toBeDefined();
    expect(steps.at(-1)).toBe(step);
    expect(step.if).toBe("${{ !cancelled() && steps.release.conclusion == 'success' && steps.release.outputs.release_created != 'true' }}");
    expect(step.env?.PR_JSON).toBe('${{ steps.release.outputs.pr }}');
    // Its inputs reach it through the environment only, never an expression in the script.
    expect(step.run).not.toContain('${{');
  });

  it('passes when each feat and fix is in the release notes, by its short SHA', () => {
    const r = run({ commits: [FEAT, FIX, DOCS], body: '* **viewer:** load the model ([aaaaaaa](x))', changelog: '* keep the camera inside the room ([bbbbbbb](x))' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('All 2 feat and fix commit(s) since the last release are in release PR #68');
  });

  it('fails, naming each commit release-please dropped, with the fix in the summary', () => {
    const r = run({ commits: [FEAT, FIX, DOCS], body: '* keep the camera inside the room ([bbbbbbb](x))', changelog: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error title=Commit missing from the release notes::aaaaaaa "feat(viewer): load the model from the fetched GLB (#12)" is not in release PR #68\'s notes.');
    expect(r.stdout).not.toContain('bbbbbbb "fix');
    expect(r.summary).toContain('### Release notes check: 1 commit(s) missing');
    expect(r.summary).toContain('BEGIN_COMMIT_OVERRIDE');
  });

  it('fails when release-please opened no release PR though a feat or fix landed', () => {
    const r = run({ commits: [FEAT], pr: false });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('is not in any release PR: release-please opened none');
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
