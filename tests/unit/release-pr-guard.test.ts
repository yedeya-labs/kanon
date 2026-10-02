// #73: the release workflow refuses a release PR that changes anything beyond version
// strings. The 0.10.0 release PR (#68) was built from stale copies of its `extra-files`, and
// its squash commit (db99870) reverted the review lane's documentation that #67 had just
// merged. Release PRs run no CI and merge through the admin bypass, so nothing compared them
// with main.
//
// The step's script is read out of release.yml and run as the runner runs it (`shell: node
// {0}`), against a fake `gh` that answers from fixtures. The two diffs under
// tests/fixtures/release-pr-guard/ are the real release commits: 0.10.0's, which reverted
// docs/lanes.md and actions/lane-check/README.md, and 0.11.0's, which changed only versions.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { id?: string; name?: string; run?: string; shell?: string; if?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
type PrFile = { filename: string; status: string; patch?: string };

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const steps = Object.values((parse(read('.github/workflows/release.yml')) as Workflow).jobs).flatMap((j) => j.steps);
const guard = steps.find((s) => s.id === 'release-pr-guard');

const REPO = 'acme/widget';
const SHA = 'feedface';
const BRANCH = 'release-please--branches--main--components--widget';
const config = read('tests/fixtures/release-pr-guard/release-please-config.json');

/** A `git diff` split into the per-file entries of GitHub's pull-request files API. */
const prFiles = (diff: string): PrFile[] =>
  diff
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => {
      const filename = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? '';
      const hunks = chunk.slice(chunk.indexOf('\n@@') + 1).replace(/\n$/, '');
      return { filename, status: 'modified', patch: hunks };
    });
const stale = prFiles(read('tests/fixtures/release-pr-guard/0.10.0-stale.diff'));
const clean = prFiles(read('tests/fixtures/release-pr-guard/0.11.0-clean.diff'));

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_DIR/calls.log"
path=""; slurp=""
for a in "$@"; do
  case "$a" in repos/*) path="$a" ;; --slurp) slurp=1 ;; esac
done
case "$*" in *"-X POST"*) echo '{}'; exit 0 ;; esac
f="$FAKE_GH_DIR/$(printf %s "$path" | tr -c 'A-Za-z0-9._-' '_').json"
[ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ -n "$slurp" ]; then printf '['; cat "$f"; printf ']'; else cat "$f"; fi
`;

type Pr = { number: number; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string } };
const releasePr = (number = 68, ref = BRANCH, owner = REPO): Pr => ({
  number,
  head: { ref, sha: SHA, repo: { full_name: owner } },
  base: { ref: 'main' },
});

const responses = (opts: { prs?: Pr[]; files?: PrFile[]; comments?: Array<{ body: string }> }): Record<string, unknown> => ({
  [`repos/${REPO}/pulls?state=open&per_page=100`]: opts.prs ?? [releasePr()],
  [`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`]: {
    encoding: 'base64',
    content: Buffer.from(config).toString('base64'),
  },
  [`repos/${REPO}/pulls/68/files?per_page=100`]: opts.files ?? [],
  [`repos/${REPO}/issues/68/comments?per_page=100`]: opts.comments ?? [],
});

const runGuard = (answers: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-release-pr-guard-'));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  for (const [path, body] of Object.entries(answers)) {
    writeFileSync(join(dir, `${path.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), JSON.stringify(body));
  }
  const script = join(dir, 'step');
  writeFileSync(script, guard?.run ?? 'process.exit(99)');
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: dir, GITHUB_REPOSITORY: REPO },
  });
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  const posted = calls.split('\n').filter((c) => c.includes('-X POST'));
  const bodyFile = /body=@(\S+)/.exec(posted[0] ?? '')?.[1];
  return { ...result, calls, posted, comment: bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : '' };
};

describe('#73 the release workflow refuses a release PR that changes more than version strings', () => {
  it('the fixtures are the real release commits, so the cases below are not vacuous', () => {
    expect(stale.map((f) => f.filename)).toEqual(expect.arrayContaining(['docs/lanes.md', 'actions/lane-check/README.md', 'CHANGELOG.md']));
    expect(clean.length).toBeGreaterThanOrEqual(15);
    expect(clean.every((f) => f.patch?.startsWith('@@'))).toBe(true);
  });

  it("fails 0.10.0's release PR, naming what it would revert, and comments on the PR", () => {
    const result = runGuard(responses({ files: stale }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error title=Release PR is stale::Release PR #68 would revert changes on main');
    // The review-lane section and the run-name rule that db99870 removed.
    expect(result.stderr).toContain('docs/lanes.md: -| Review | `agent-review.yml` | Reviewer |');
    expect(result.stderr).toContain('docs/lanes.md: -**The review lane** has three things the others don');
    expect(result.stderr).toContain('actions/lane-check/README.md: -- **Each caller**');
    expect(result.posted).toHaveLength(1);
    expect(result.posted[0]).toContain(`repos/${REPO}/issues/68/comments`);
    expect(result.comment).toContain(`<!-- kanon-release-pr-guard ${SHA} -->`);
    expect(result.comment).toContain('This release PR is stale: merging it would revert changes on `main`.');
    expect(result.comment).toContain('docs/lanes.md: -| Verify acceptance criteria |');
    expect(result.comment).toContain(`delete its branch, \`${BRANCH}\``);
  });

  it("does not flag 0.10.0's version-only lines in the same files", () => {
    const result = runGuard(responses({ files: stale }));
    expect(result.stderr).not.toContain('agent-implement-revise.yml@v0.9.1');
    expect(result.stderr).not.toContain('lane-check@v0.9.1');
    expect(result.stderr).not.toMatch(/^README\.md: /m);
    expect(result.stderr).not.toContain('CHANGELOG.md');
    expect(result.stderr).not.toContain('package.json');
  });

  it("passes 0.11.0's release PR, which changed only version strings", () => {
    const result = runGuard(responses({ files: clean }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release PR #68 changes only version strings');
    expect(result.posted).toEqual([]);
  });

  it('comments once per head: a re-run on the same stale head fails again without commenting again', () => {
    const result = runGuard(responses({ files: stale, comments: [{ body: `<!-- kanon-release-pr-guard ${SHA} -->\nold` }] }));
    expect(result.status).toBe(1);
    expect(result.posted).toEqual([]);
  });

  it.each<[string, PrFile, string]>([
    ['a file outside the release files', { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }, 'src/app.ts: modified, and it is not a release file'],
    ['an extra file deleted', { filename: 'docs/lanes.md', status: 'removed' }, 'docs/lanes.md: removed'],
    ['an extra file whose patch GitHub omits', { filename: 'docs/lanes.md', status: 'modified' }, "docs/lanes.md: its diff is too large for GitHub to return, so it can't be checked"],
    ['a removed line with no partner', { filename: 'docs/lanes.md', status: 'modified', patch: '@@ -1,2 +1,1 @@\n keep\n-gone' }, 'docs/lanes.md: -gone'],
    ['an added line with no partner', { filename: 'docs/lanes.md', status: 'modified', patch: '@@ -1 +1,2 @@\n keep\n+new' }, 'docs/lanes.md: +new'],
    ['a version line moved past unchanged lines', { filename: 'docs/lanes.md', status: 'modified', patch: '@@ -1,2 +1,2 @@\n-pin @v0.9.1\n keep\n+pin @v0.10.0' }, 'docs/lanes.md: -pin @v0.9.1'],
    ['an added line before a removed one, which is two changes, not one', { filename: 'docs/lanes.md', status: 'modified', patch: '@@ -1 +1 @@\n+pin @v0.10.0\n-pin @v0.9.1' }, 'docs/lanes.md: +pin @v0.10.0'],
    ['a line that changes text beside its version', { filename: 'docs/apps.md', status: 'modified', patch: '@@ -1 +1 @@\n-use @v0.9.1 here\n+use @v0.10.0 there' }, 'docs/apps.md: -use @v0.9.1 here'],
  ])('fails %s', (_, file, problem) => {
    const result = runGuard(responses({ files: [file] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(problem);
  });

  it('passes a version-only line, a prerelease version, and the excluded version files whatever they hold', () => {
    const files: PrFile[] = [
      { filename: 'docs/apps.md', status: 'modified', patch: '@@ -1,3 +1,3 @@\n a\n-npx kanon#v0.9.1 x 1.2.3-rc.1\n+npx kanon#v0.10.0 x 1.3.0\n b' },
      { filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -1 +1,2 @@\n+## 0.10.0\n anything' },
      { filename: 'package.json', status: 'modified', patch: '@@ -1 +1 @@\n-"scripts": {}\n+"other": 1' },
      { filename: 'package-lock.json', status: 'modified' },
      { filename: '.release-please-manifest.json', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
    ];
    const result = runGuard(responses({ files }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it("treats version.txt as a version file only for the `simple` release type, which keeps its version there", () => {
    const file: PrFile = { filename: 'version.txt', status: 'modified', patch: '@@ -1 +1 @@\n-0.9.1\n+0.10.0' };
    expect(runGuard(responses({ files: [file] })).stderr).toContain('version.txt: modified, and it is not a release file');
    const simple = JSON.parse(config) as { packages: Record<string, Record<string, unknown>> };
    simple.packages['.']!['release-type'] = 'simple';
    const answers = responses({ files: [file] });
    answers[`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`] = {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(simple)).toString('base64'),
    };
    const result = runGuard(answers);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it("checks only release-please's own branches in this repository, and passes when there is none", () => {
    const others = [releasePr(68, 'feat/72-x'), releasePr(68, BRANCH, 'someone/widget')];
    const result = runGuard(responses({ prs: others, files: stale }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No open release PR to check.');
    expect(result.calls).not.toContain('pulls/68/files');
  });

  it('reads the release-please config at the release branch head, from the calling repository', () => {
    const result = runGuard(responses({ files: clean }));
    expect(result.calls).toContain(`api repos/${REPO}/contents/release-please-config.json?ref=${SHA}`);
    expect(result.calls).toContain(`api --paginate --slurp repos/${REPO}/pulls/68/files?per_page=100`);
  });

  it('fails closed when the API cannot be read', () => {
    const result = runGuard({});
    expect(result.status).not.toBe(0);
  });

  it('runs last, on the workflow token, with no expression in its script', () => {
    expect(steps.at(-1)?.id).toBe('release-pr-guard');
    expect(guard?.shell).toBe('node {0}');
    expect(guard?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(guard?.if).toBeUndefined();
    expect(guard?.run).not.toContain('${{');
  });
});
