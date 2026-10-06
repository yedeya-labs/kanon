import { describe, expect, it } from 'vitest';
import { type PrFile, steps, guard, REPO, SHA, BRANCH, stale, clean, manifest, MANIFEST_0_10, type Pr, BASE_SHA, MERGE_BASE, releasePr, responses, runGuard } from './helpers/release-pr-guard.js';

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
//
// Split by area across tests/unit/release-pr-guard*.test.ts (kanon#381), with the helpers they
// share in tests/unit/helpers/release-pr-guard.ts.
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
    expect(result.stderr).not.toMatch(/^CHANGELOG\.md: /m);
    expect(result.stderr).not.toMatch(/^package(-lock)?\.json: /m);
    expect(result.stderr).not.toMatch(/^\.release-please-manifest\.json: /m);
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
    ['a file outside the release files that changes more than a version', { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a 1.0.0\n+b 1.1.0' }, 'src/app.ts: -a 1.0.0'],
    ['a file added outside the release files', { filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' }, 'src/new.ts: added, and it is not in extra-files'],
    ['a file outside the release files whose patch GitHub omits', { filename: 'Cargo.lock', status: 'modified' }, "Cargo.lock: its diff is too large for GitHub to return, so it can't be checked"],
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

  it('passes a version-only line moved to the release version, from a prerelease too, and the changelog whatever it holds', () => {
    const files: PrFile[] = [
      MANIFEST_0_10,
      { filename: 'docs/apps.md', status: 'modified', patch: '@@ -1,3 +1,3 @@\n a\n-npx kanon#v0.9.1 x 0.10.0-rc.1\n+npx kanon#v0.10.0 x 0.10.0\n b' },
      { filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -1 +1,2 @@\n+## 0.10.0\n anything' },
      { filename: 'package.json', status: 'modified', patch: '@@ -2,3 +2,3 @@\n   "name": "kanon",\n-  "version": "0.9.1",\n+  "version": "0.10.0",\n   "private": true,' },
      { filename: 'package-lock.json', status: 'modified', patch: '@@ -3 +3 @@\n-  "version": "0.9.1",\n+  "version": "0.10.0",\n@@ -9 +9 @@\n-      "version": "0.9.1",\n+      "version": "0.10.0",' },
    ];
    const result = runGuard(responses({ files }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('each to a version it releases (0.10.0)');
  });

  // #90: release-please rewrites these files from its own copy, so a stale copy reverts a
  // dependency bump on main with a line whose only change is a version.
  it.each<[string, PrFile, string]>([
    ['a Cargo.toml dependency', { filename: 'Cargo.toml', status: 'modified', patch: '@@ -9 +9 @@\n-serde = "1.0.190"\n+serde = "1.0.188"' }, 'Cargo.toml: +serde = "1.0.188"   <- 1.0.190 goes back to 1.0.188'],
    ['a pyproject.toml dependency', { filename: 'pyproject.toml', status: 'modified', patch: '@@ -7 +7 @@\n-  "requests>=2.31.0",\n+  "requests>=2.30.0",' }, 'pyproject.toml: +  "requests>=2.30.0",   <- 2.31.0 goes back to 2.30.0'],
    ['a package.json dependency, now read rather than skipped', { filename: 'package.json', status: 'modified', patch: '@@ -12 +12 @@\n-    "vitest": "5.0.2",\n+    "vitest": "5.0.1",' }, 'package.json: +    "vitest": "5.0.1",   <- 5.0.2 goes back to 5.0.1'],
    ['a package-lock.json nested version', { filename: 'package-lock.json', status: 'modified', patch: '@@ -40 +40 @@\n-      "version": "5.0.2",\n+      "version": "5.0.1",' }, 'package-lock.json: +      "version": "5.0.1",   <- 5.0.2 goes back to 5.0.1'],
    ['a prerelease of the version it replaces', { filename: 'docs/apps.md', status: 'modified', patch: '@@ -1 +1 @@\n-pin 0.10.0\n+pin 0.10.0-rc.1' }, 'docs/apps.md: +pin 0.10.0-rc.1   <- 0.10.0 goes back to 0.10.0-rc.1'],
    ['a dependency moved FORWARD to a version this release does not set', { filename: 'pyproject.toml', status: 'modified', patch: '@@ -7 +7 @@\n-  "requests>=2.30.0",\n+  "requests>=2.31.0",' }, 'pyproject.toml: +  "requests>=2.31.0",   <- 2.31.0 is not a version this release sets (0.10.0)'],
  ])('fails %s whose version goes backwards or is not this release\'s (#90)', (_, file, problem) => {
    const result = runGuard(responses({ files: [MANIFEST_0_10, file] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(problem);
  });

  it('holds the manifest itself to the rule: a package moved backwards fails (#90)', () => {
    const result = runGuard(responses({ files: [manifest(['.', '0.10.0', '0.9.1'])] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.release-please-manifest.json: ".": 0.10.0 goes back to 0.9.1');
  });

  it("fails when the manifest isn't changed, since then no version is this release's (#90)", () => {
    const result = runGuard(responses({ files: [{ filename: 'docs/apps.md', status: 'modified', patch: '@@ -1 +1 @@\n-pin 0.9.1\n+pin 0.10.0' }] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".release-please-manifest.json: no version is added to it, so the guard can't tell which versions this release sets");
    expect(result.stderr).toContain('docs/apps.md: +pin 0.10.0   <- 0.10.0 is not a version this release sets (none)');
  });

  it('in a monorepo, takes every released package\'s version, and still refuses one moved backwards to a sibling\'s (#90)', () => {
    const two = manifest(['packages/a', '1.0.0', '1.1.0'], ['packages/b', '2.0.0', '2.1.0']);
    const sibling: PrFile = { filename: 'packages/a/package.json', status: 'modified', patch: '@@ -3,4 +3,4 @@\n-  "version": "1.0.0",\n-  "dependencies": { "b": "^2.0.0" }\n+  "version": "1.1.0",\n+  "dependencies": { "b": "^2.1.0" }' };
    expect(runGuard(responses({ files: [two, sibling] })).status).toBe(0);
    const back: PrFile = { filename: 'packages/a/package.json', status: 'modified', patch: '@@ -4 +4 @@\n-  "dependencies": { "b": "^2.2.0" }\n+  "dependencies": { "b": "^1.1.0" }' };
    const result = runGuard(responses({ files: [two, back] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('<- 2.2.0 goes back to 1.1.0');
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
    expect(result.calls).toContain(`api repos/${REPO}/compare/${BASE_SHA}...${SHA}?per_page=1`);
    expect(result.calls).not.toContain('pulls/68/files');
  });

  it('fails closed when the API cannot be read', () => {
    const result = runGuard({});
    expect(result.status).not.toBe(0);
  });

  // #86: release-please force-pushes the release branch earlier in the same job, and GitHub
  // records a PR's new head asynchronously. So the PR list can name the head before the one
  // an Owner is about to merge, and a guard that judged it would pass a stale PR unchecked.
  describe('#86 judges the release branch\'s current head, not a lagging PR record', () => {
    const OLD = 'deadbeef';
    const lagging = (): Pr => ({ ...releasePr(), head: { ...releasePr().head, sha: OLD } });

    it('fails closed, unjudged and without a comment, when the PR never records the branch head', () => {
      const answers = { ...responses({ prs: [lagging()], files: clean }), [`repos/${REPO}/pulls/68`]: lagging() };
      const result = runGuard(answers);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`::error title=Release PR not at its branch head::Release PR #68 records head ${OLD}, but its branch ${BRANCH} is at ${SHA}`);
      expect(result.calls.match(new RegExp(`api repos/${REPO}/pulls/68\\n`, 'g')), 'it re-reads the PR before giving up').toHaveLength(3);
      expect(result.calls, 'the lagging head is never judged').not.toContain('/compare/');
      expect(result.calls).not.toContain(`ref=${OLD}`);
      expect(result.posted).toEqual([]);
    });

    it('judges the branch head once a re-read of the PR records it', () => {
      const answers = { ...responses({ prs: [lagging()], files: stale }), [`repos/${REPO}/pulls/68`]: releasePr() };
      const result = runGuard(answers);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error title=Release PR is stale::Release PR #68');
      expect(result.calls).toContain(`api repos/${REPO}/contents/release-please-config.json?ref=${SHA}`);
      expect(result.comment).toContain(`<!-- kanon-release-pr-guard ${SHA} -->`);
    });

    it('does not re-read a PR that already records the branch head', () => {
      const result = runGuard(responses({ files: clean }));
      expect(result.status).toBe(0);
      expect(result.calls).toContain(`api repos/${REPO}/git/ref/heads/${BRANCH}`);
      expect(result.calls).not.toMatch(new RegExp(`api repos/${REPO}/pulls/68\\n`));
    });
  });

  // #246: `pulls/<n>/files` names no SHA, and GitHub recomputes it asynchronously after a
  // push, so it can still be the previous head's list once `head.sha` has moved.
  describe('#246 judges the diff of the head it confirmed, not a lagging file list', () => {
    it('goes red on the confirmed head\'s diff while the PR\'s file list still holds the previous, clean head', () => {
      const answers = { ...responses({ files: stale }), [`repos/${REPO}/pulls/68/files?per_page=100`]: clean };
      const result = runGuard(answers);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error title=Release PR is stale::Release PR #68');
      expect(result.stderr).toContain('docs/lanes.md:');
      expect(result.calls).toContain(`api repos/${REPO}/compare/${BASE_SHA}...${SHA}?per_page=1`);
      expect(result.calls).not.toContain('pulls/68/files');
    });

    it('fails closed when the comparison lists no files', () => {
      const answers = responses({ files: clean });
      answers[`repos/${REPO}/compare/${BASE_SHA}...${SHA}?per_page=1`] = { merge_base_commit: { sha: MERGE_BASE } };
      const result = runGuard(answers);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('returned no file list');
    });

    it('fails closed at 300 files, where GitHub may have cut the list', () => {
      const many = Array.from({ length: 300 - clean.length }, (_, i) => ({ filename: `pad/${i}.md`, status: 'modified', patch: '@@ -1 +1 @@\n-0.10.0\n+0.11.0' }));
      const under = runGuard(responses({ files: [...clean, ...many.slice(1)] }));
      expect(under.stderr).not.toContain('past what GitHub lists');
      const at = runGuard(responses({ files: [...clean, ...many] }));
      expect(at.status).toBe(1);
      expect(at.stderr).toContain('it changes 300 files or more, past what GitHub lists in one comparison');
    });
  });

  it('runs last, on the workflow token, with no expression in its script', () => {
    expect(steps.at(-1)?.id).toBe('release-pr-guard');
    expect(guard?.shell).toBe('node {0}');
    expect(guard?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(guard?.if).toBeUndefined();
    expect(guard?.run).not.toContain('${{');
  });
});
