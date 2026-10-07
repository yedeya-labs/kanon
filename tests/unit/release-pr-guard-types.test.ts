import { describe, expect, it } from 'vitest';
import { type PrFile, REPO, SHA, config, stale, clean, manifest, MANIFEST_0_10, responses, runGuard } from './helpers/release-pr-guard.js';
import { SPAWNS } from './helpers/spawns.js';

// #73's guard for each release type docs/release.md offers (#17), and the changelog.json
// they write.
//
// One of the release-pr-guard files split by area (kanon#381): vitest runs one file's cases
// serially. tests/unit/release-pr-guard.test.ts says what the guard is and how it is run; the
// helpers they share are in tests/unit/helpers/release-pr-guard.ts.
// Each case runs the guard in `node`, with `git`, so the block takes the spawn budget (#436).
describe('#73 the release workflow refuses a release PR that changes more than version strings', SPAWNS, () => {
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
});
