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
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
// #90: every other release commit Kanon has made (0.4.0 to 0.15.1, the squash commits of its
// release PRs). Releases before 0.4.0 didn't come from a release PR.
const HISTORY = readdirSync(new URL('../fixtures/release-pr-guard/history/', import.meta.url))
  .filter((f) => f.endsWith('.diff'))
  .map((f) => [f.replace(/\.diff$/, ''), prFiles(read(`tests/fixtures/release-pr-guard/history/${f}`))] as const);

/** The manifest change of a release PR, which names the versions it releases. */
const manifest = (...moves: Array<[string, string, string]>): PrFile => ({
  filename: '.release-please-manifest.json',
  status: 'modified',
  patch: `@@ -1,${moves.length + 2} +1,${moves.length + 2} @@\n {\n${moves.map(([path, from]) => `-  "${path}": "${from}"`).join(',\n')}\n${moves.map(([path, , to]) => `+  "${path}": "${to}"`).join(',\n')}\n }`,
});
const MANIFEST_0_10 = manifest(['.', '0.9.1', '0.10.0']);

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

type Pr = { number: number; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string; sha: string } };
const BASE_SHA = 'c0ffee00';
const MERGE_BASE = 'ba5eba11';
const releasePr = (number = 68, ref = BRANCH, owner = REPO): Pr => ({
  number,
  head: { ref, sha: SHA, repo: { full_name: owner } },
  base: { ref: 'main', sha: BASE_SHA },
});

/**
 * The manifest at the merge base and at the head, rebuilt from its patch: the context and `-`
 * lines, and the context and `+` lines. Every manifest patch here is one hunk over the whole
 * file, which the rebuilt JSON parsing confirms.
 */
const manifestSides = (patch: string) => {
  const base: string[] = [];
  const head: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\')) continue;
    if (!line.startsWith('+')) base.push(line.slice(1));
    if (!line.startsWith('-')) head.push(line.slice(1));
  }
  return { base: `${base.join('\n')}\n`, head: `${head.join('\n')}\n` };
};
const contents = (text: string) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') });

const responses = (opts: { prs?: Pr[]; files?: PrFile[]; comments?: Array<{ body: string }>; manifest?: { base: string; head: string } }): Record<string, unknown> => {
  const patch = opts.files?.find((f) => f.filename === '.release-please-manifest.json')?.patch;
  const sides = opts.manifest ?? (patch === undefined ? undefined : manifestSides(patch));
  return {
    [`repos/${REPO}/pulls?state=open&per_page=100`]: opts.prs ?? [releasePr()],
    [`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`]: contents(config),
    [`repos/${REPO}/pulls/68/files?per_page=100`]: opts.files ?? [],
    [`repos/${REPO}/issues/68/comments?per_page=100`]: opts.comments ?? [],
    ...(sides && {
      [`repos/${REPO}/compare/${BASE_SHA}...${SHA}?per_page=1`]: { merge_base_commit: { sha: MERGE_BASE } },
      [`repos/${REPO}/contents/.release-please-manifest.json?ref=${MERGE_BASE}`]: contents(sides.base),
      [`repos/${REPO}/contents/.release-please-manifest.json?ref=${SHA}`]: contents(sides.head),
    }),
  };
};

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

  // #129: a monorepo's first release of a package with no manifest entry. release-please's
  // ReleasePleaseManifest updater sets `parsed[path] = version` and re-serialises, so the new
  // key lands at the end with no `-` partner and the line before gains a comma.
  const FIRST_RELEASE: PrFile = {
    filename: '.release-please-manifest.json',
    status: 'modified',
    patch: '@@ -1,3 +1,4 @@\n {\n-  "packages/a": "1.1.0"\n+  "packages/a": "1.1.0",\n+  "packages/new": "0.1.0"\n }',
  };
  const NEW_PACKAGE_JSON: PrFile = { filename: 'packages/new/package.json', status: 'modified', patch: '@@ -3 +3 @@\n-  "version": "0.0.0",\n+  "version": "0.1.0",' };
  /** A manifest change given as the whole file on each side. */
  const sides = (base: Record<string, unknown>, head: Record<string, unknown>) => ({
    base: `${JSON.stringify(base, null, 2)}\n`,
    head: `${JSON.stringify(head, null, 2)}\n`,
  });

  it("passes a package's first release, whose manifest entry is new (#129)", () => {
    const result = runGuard(responses({ files: [FIRST_RELEASE, NEW_PACKAGE_JSON] }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('each to a version it releases (0.1.0)');
  });

  it('passes a first release beside a sibling bumped in the same PR, and takes both versions (#129)', () => {
    const files: PrFile[] = [
      { filename: '.release-please-manifest.json', status: 'modified', patch: '@@ -1,3 +1,4 @@\n {\n-  "packages/a": "1.0.0"\n+  "packages/a": "1.1.0",\n+  "packages/new": "0.1.0"\n }' },
      { filename: 'packages/a/package.json', status: 'modified', patch: '@@ -3 +3 @@\n-  "version": "1.0.0",\n+  "version": "1.1.0",' },
      NEW_PACKAGE_JSON,
    ];
    const result = runGuard(responses({ files }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('each to a version it releases (1.1.0, 0.1.0)');
  });

  it('reads the manifest at the merge base and the head, which is what the diff compares (#129)', () => {
    const result = runGuard(responses({ files: [FIRST_RELEASE] }));
    expect(result.calls).toContain(`api repos/${REPO}/compare/${BASE_SHA}...${SHA}?per_page=1`);
    expect(result.calls).toContain(`api repos/${REPO}/contents/.release-please-manifest.json?ref=${MERGE_BASE}`);
    expect(result.calls).toContain(`api repos/${REPO}/contents/.release-please-manifest.json?ref=${SHA}`);
  });

  it.each<[string, PrFile[], { base: string; head: string } | undefined, string]>([
    ['a stale line beside the first release', [FIRST_RELEASE, { filename: 'packages/a/package.json', status: 'modified', patch: '@@ -9 +9 @@\n-    "vitest": "5.0.2",\n+    "vitest": "5.0.1",' }], undefined,
      'packages/a/package.json: +    "vitest": "5.0.1",   <- 5.0.2 goes back to 5.0.1'],
    ['a line moved to a version only the new package has, backwards', [FIRST_RELEASE, { filename: 'packages/a/package.json', status: 'modified', patch: '@@ -4 +4 @@\n-  "dependencies": { "new": "^0.2.0" }\n+  "dependencies": { "new": "^0.1.0" }' }], undefined,
      '<- 0.2.0 goes back to 0.1.0'],
    ['a line moved to a version nobody releases', [FIRST_RELEASE, { filename: 'packages/a/package.json', status: 'modified', patch: '@@ -4 +4 @@\n-  "dependencies": { "c": "^3.0.0" }\n+  "dependencies": { "c": "^3.1.0" }' }], undefined,
      '<- 3.1.0 is not a version this release sets (0.1.0)'],
    ['a new entry that is not a version', [FIRST_RELEASE], sides({ 'packages/a': '1.1.0' }, { 'packages/a': '1.1.0', 'packages/new': 'latest' }),
      '.release-please-manifest.json: "packages/new": "latest" is not a version'],
    ['a new entry that only holds a version', [FIRST_RELEASE], sides({ 'packages/a': '1.1.0' }, { 'packages/a': '1.1.0', 'packages/new': '^0.1.0' }),
      '.release-please-manifest.json: "packages/new": "^0.1.0" is not a version'],
    ['a new entry with more after its version', [FIRST_RELEASE], sides({ 'packages/a': '1.1.0' }, { 'packages/a': '1.1.0', 'packages/new': '0.1.0 or later' }),
      '.release-please-manifest.json: "packages/new": "0.1.0 or later" is not a version'],
    ['a manifest the PR removes, which is never read as JSON', [{ filename: '.release-please-manifest.json', status: 'removed' }, NEW_PACKAGE_JSON], undefined,
      '.release-please-manifest.json: removed, and it is not in extra-files'],
    ['a new entry that is not a string', [FIRST_RELEASE], sides({ 'packages/a': '1.1.0' }, { 'packages/a': '1.1.0', 'packages/new': { version: '0.1.0' } }),
      '.release-please-manifest.json: "packages/new": {"version":"0.1.0"} is not a version'],
    ['an existing entry moved backwards beside a first release', [FIRST_RELEASE], sides({ 'packages/a': '1.1.0' }, { 'packages/a': '1.0.0', 'packages/new': '0.1.0' }),
      '.release-please-manifest.json: "packages/a": 1.1.0 goes back to 1.0.0'],
    ['an entry removed', [FIRST_RELEASE], sides({ 'packages/a': '1.1.0', 'packages/old': '2.0.0' }, { 'packages/a': '1.1.0', 'packages/new': '0.1.0' }),
      `.release-please-manifest.json: "packages/old" is removed, and a release never removes a package's entry`],
    ['a manifest that changes no value', [FIRST_RELEASE], sides({ 'packages/a': '1.1.0' }, { 'packages/a': '1.1.0' }),
      ".release-please-manifest.json: no version is added to it, so the guard can't tell which versions this release sets"],
  ])('still fails %s (#129)', (_, files, manifest, problem) => {
    const result = runGuard(responses({ files, manifest }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(problem);
  });

  it('fails closed when the manifest at the merge base cannot be read (#129)', () => {
    const answers = responses({ files: [FIRST_RELEASE, NEW_PACKAGE_JSON] });
    delete answers[`repos/${REPO}/contents/.release-please-manifest.json?ref=${MERGE_BASE}`];
    const result = runGuard(answers);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('changes only version strings');
  });

  it.each<[string, string, number]>([
    ['0.10.0-rc.2', '0.10.0-rc.10', 0],
    ['0.10.0-rc.10', '0.10.0-rc.2', 1],
    ['0.10.0-alpha', '0.10.0-beta', 0],
    ['0.10.0-rc.1', '0.10.0-rc.1.1', 0],
    ['0.10.0-1', '0.10.0-alpha', 0],
    ['0.9.10', '0.10.0', 0],
    ['0.10.0+build.2', '0.10.0+build.1', 0],
    ['0.10.1+build.1', '0.10.0+build.2', 1],
  ])('orders %s before %s by semver precedence (exit %i)', (from, to, status) => {
    const result = runGuard(responses({ files: [manifest(['.', '0.9.0', to]), { filename: 'docs/apps.md', status: 'modified', patch: `@@ -1 +1 @@\n-pin ${from}\n+pin ${to}` }] }));
    expect(result.status, result.stderr).toBe(status);
  });

  it.each(HISTORY.map(([v]) => v))("passes Kanon's %s release PR, as it merged (#90)", (version) => {
    const files = HISTORY.find(([v]) => v === version)![1];
    expect(files.map((f) => f.filename)).toContain('.release-please-manifest.json');
    const result = runGuard(responses({ files }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`each to a version it releases (${version})`);
  });

  it('holds every release from 0.4.0 on, besides the two fixtures above', () => {
    expect(HISTORY.map(([v]) => v).sort()).toEqual(
      ['0.4.0', '0.4.1', '0.4.2', '0.4.3', '0.4.4', '0.5.0', '0.5.1', '0.6.0', '0.6.1', '0.7.0', '0.8.0', '0.8.1', '0.9.0', '0.9.1', '0.12.0', '0.13.0', '0.14.0', '0.15.0', '0.15.1'].sort(),
    );
  });

  it("passes another release type's own version file when only its version changed, so the workflow stays language-agnostic", () => {
    const files: PrFile[] = [
      MANIFEST_0_10,
      { filename: 'pyproject.toml', status: 'modified', patch: '@@ -1,3 +1,3 @@\n [project]\n-version = "0.9.1"\n+version = "0.10.0"\n name = "widget"' },
      { filename: 'Cargo.toml', status: 'modified', patch: '@@ -2 +2 @@\n-version = "0.9.1"\n+version = "0.10.0"' },
    ];
    const result = runGuard(responses({ files }));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it("skips version.txt whatever it holds only for the `simple` release type, which keeps its version there", () => {
    const file: PrFile = { filename: 'version.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+0.10.0' };
    expect(runGuard(responses({ files: [file] })).stderr).toContain('version.txt: added, and it is not in extra-files');
    const simple = JSON.parse(config) as { packages: Record<string, Record<string, unknown>> };
    simple.packages['.']!['release-type'] = 'simple';
    const answers = responses({ files: [MANIFEST_0_10, file] });
    answers[`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`] = {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(simple)).toString('base64'),
    };
    const result = runGuard(answers);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  // #17: the adopter's language picks the release type, and `simple` is the neutral default.
  // The guard has to hold for each type docs/release.md offers.
  const withType = (type: string | undefined, files: PrFile[]) => {
    const typed = JSON.parse(config) as { packages: Record<string, Record<string, unknown>> };
    if (type === undefined) delete typed.packages['.']!['release-type'];
    else typed.packages['.']!['release-type'] = type;
    const answers = responses({ files });
    answers[`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`] = {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(typed)).toString('base64'),
    };
    return runGuard(answers);
  };
  const TYPES = ['node', 'python', 'go', 'rust', 'simple'];

  it.each(TYPES)("fails 0.10.0's stale release PR, and passes 0.11.0's, for the `%s` release type", (type) => {
    const failed = withType(type, stale);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('docs/lanes.md: -| Review | `agent-review.yml` | Reviewer |');
    const passed = withType(type, clean);
    expect(passed.stderr).toBe('');
    expect(passed.status).toBe(0);
  });

  it.each<[string, PrFile[]]>([
    ['python', [
      { filename: 'pyproject.toml', status: 'modified', patch: '@@ -2 +2 @@\n-version = "0.9.1"\n+version = "0.10.0"' },
      { filename: 'src/widget/__init__.py', status: 'modified', patch: '@@ -1 +1 @@\n-__version__ = "0.9.1"\n+__version__ = "0.10.0"' },
      { filename: 'changelog.json', status: 'modified', patch: '@@ -1 +1,2 @@\n+{"entries": []}\n anything' },
    ]],
    ['go', [{ filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -1 +1,2 @@\n+## 0.10.0\n anything' }]],
    ['rust', [
      { filename: 'Cargo.toml', status: 'modified', patch: '@@ -3 +3 @@\n-version = "0.9.1"\n+version = "0.10.0"' },
      { filename: 'Cargo.lock', status: 'modified', patch: '@@ -7,2 +7,2 @@\n name = "widget"\n-version = "0.9.1"\n+version = "0.10.0"' },
    ]],
    ['simple', [{ filename: 'version.txt', status: 'modified', patch: '@@ -1 +1 @@\n-0.9.1\n+0.10.0 anything' }]],
  ])("passes a clean `%s` release PR, which touches that type's own version files", (type, files) => {
    const result = withType(type, [MANIFEST_0_10, ...files]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([...TYPES, undefined])(
    'reads package.json like any other file for the `%s` release type, `node` and unset included (#90)',
    (type) => {
      const result = withType(type, [{ filename: 'package.json', status: 'modified', patch: '@@ -1 +1 @@\n-"scripts": {}\n+"other": 1' }]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('package.json: -"scripts": {}');
    },
  );

  // #109: release-please's `node` and `python` strategies both add an entry to a
  // machine-readable `changelog.json` when one exists (`ChangelogJson` updater, `unshift`ing
  // a whole object, so not a version-only change), and both write it at the repository root
  // (`path: 'changelog.json'`, not `this.addPath(...)`), whatever the package's path.
  const CHANGELOG_JSON: PrFile = {
    filename: 'changelog.json',
    status: 'modified',
    patch: '@@ -1,2 +1,8 @@\n {\n-  "entries": [\n+  "entries": [\n+    {\n+      "version": "0.10.0",\n+      "language": "JAVASCRIPT",\n+      "changes": []\n+    },',
  };
  /** The fixture config with its one package moved to `path`, typed `type`. */
  const atPath = (path: string, type: string | undefined, files: PrFile[]) => {
    const typed = JSON.parse(config) as { packages: Record<string, Record<string, unknown>> };
    const pkg = typed.packages['.']!;
    if (type === undefined) delete pkg['release-type'];
    else pkg['release-type'] = type;
    typed.packages = { [path]: pkg };
    const answers = responses({ files });
    answers[`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`] = {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(typed)).toString('base64'),
    };
    return runGuard(answers);
  };

  it.each<[string, string | undefined]>([['node', 'node'], ['python', 'python'], ['unset (read as node)', undefined]])(
    'skips the root changelog.json release-please rewrites for the `%s` release type (#109)',
    (_, type) => {
      const result = withType(type, [MANIFEST_0_10, CHANGELOG_JSON]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it.each(['go', 'rust', 'simple'])("reads changelog.json like any other file for the `%s` release type, which doesn't write it", (type) => {
    const result = withType(type, [CHANGELOG_JSON]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changelog.json: +    {');
  });

  it.each(['node', 'python'])(
    'skips the ROOT changelog.json for a `%s` package that is not at the root, and reads one under its path (#109)',
    (type) => {
      const root = atPath('packages/widget', type, [manifest(['packages/widget', '0.9.1', '0.10.0']), CHANGELOG_JSON]);
      expect(root.stderr).toBe('');
      expect(root.status).toBe(0);
      const nested = atPath('packages/widget', type, [manifest(['packages/widget', '0.9.1', '0.10.0']), { ...CHANGELOG_JSON, filename: 'packages/widget/changelog.json' }]);
      expect(nested.status).toBe(1);
      expect(nested.stderr).toContain('packages/widget/changelog.json: +    {');
    },
  );

  it('skips the `simple` type\'s `version-file` when the config names one, and then reads version.txt like any other file', () => {
    const typed = JSON.parse(config) as { packages: Record<string, Record<string, unknown>> };
    typed.packages['.']!['release-type'] = 'simple';
    typed.packages['.']!['version-file'] = 'VERSION';
    const answers = responses({
      files: [
        { filename: 'VERSION', status: 'modified', patch: '@@ -1 +1 @@\n-0.9.1\n+0.10.0 anything' },
        { filename: 'version.txt', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
      ],
    });
    answers[`repos/${REPO}/contents/release-please-config.json?ref=${SHA}`] = {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(typed)).toString('base64'),
    };
    const result = runGuard(answers);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('VERSION:');
    expect(result.stderr).toContain('version.txt: -old');
  });

  it("names the files it skipped for the release type in its comment, not node's", () => {
    const result = withType('simple', stale);
    expect(result.comment).toContain('Outside `CHANGELOG.md`, `version.txt`, a release PR may change only version strings, each to a version it releases and never backwards');
    expect(result.comment).not.toContain('package.json');
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
