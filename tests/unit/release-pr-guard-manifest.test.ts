import { describe, expect, it } from 'vitest';
import { type PrFile, REPO, SHA, config, HISTORY, manifest, MANIFEST_0_10, BASE_SHA, MERGE_BASE, responses, runGuard } from './helpers/release-pr-guard.js';

// #73's guard on the manifest: a package's first release (#129), Kanon's own release history
// (#90), and another release type's version file.
//
// One of the release-pr-guard files split by area (kanon#381): vitest runs one file's cases
// serially. tests/unit/release-pr-guard.test.ts says what the guard is and how it is run; the
// helpers they share are in tests/unit/helpers/release-pr-guard.ts.
describe('#73 the release workflow refuses a release PR that changes more than version strings', () => {
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
});
