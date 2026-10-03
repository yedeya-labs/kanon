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

  it("passes another release type's own version file when only its version changed, so the workflow stays language-agnostic", () => {
    const files: PrFile[] = [
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
    const answers = responses({ files: [file] });
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
    const result = withType(type, files);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each(['python', 'go', 'rust', 'simple'])(
    "reads package.json like any other file for the `%s` release type, which doesn't own it",
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
      const result = withType(type, [CHANGELOG_JSON]);
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
      const root = atPath('packages/widget', type, [CHANGELOG_JSON]);
      expect(root.stderr).toBe('');
      expect(root.status).toBe(0);
      const nested = atPath('packages/widget', type, [{ ...CHANGELOG_JSON, filename: 'packages/widget/changelog.json' }]);
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

  it("reads an unset release type as `node`, release-please's own default", () => {
    const result = withType(undefined, [{ filename: 'package.json', status: 'modified', patch: '@@ -1 +1 @@\n-"scripts": {}\n+"other": 1' }]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it("names the files it skipped for the release type in its comment, not node's", () => {
    const result = withType('simple', stale);
    expect(result.comment).toContain('Outside `.release-please-manifest.json`, `CHANGELOG.md`, `version.txt`, a release PR may change only version strings');
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
