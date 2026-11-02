// The release workflow `kanon init` writes (kanon#1553, the Owner's decision of 2026-11-01): the
// caller of Kanon's release workflow, `.github/workflows/release.yml`, and release-please's
// starting configuration, `release-please-config.json`, `.release-please-manifest.json` and
// `version.txt`, each exactly as docs/release.md's "Use it" gives it (tests/unit/kanon-init-release.test.ts
// holds the four to the page byte for byte). `init` writes them when the person chooses releases
// (`--releaser`, `--releases`) or a deploy environment, since the deploy lane runs only on a
// published release.
//
// THE CALLER is the project's once it calls Kanon's release workflow: `init` doesn't plan it then,
// and Dependabot moves its pin as it moves every caller's. A file at its path that calls something
// else is planned, so the person sees it `differs`, and never overwritten.
//
// THE CONFIGURATION is release-please's `simple` type, Kanon's eleven changelog sections
// (`K-SHIP-4`), none hidden, and a `0.0.0` manifest, so the first release is `0.1.0`. After that,
// release-please owns the manifest and `version.txt`, so each is written only where no file is,
// and never compared: a project that keeps its version elsewhere changes the type (docs/release.md).
//
// Node built-ins only.

import { yamlScalar } from './callers.mjs';

/** Where the release caller lives: the path docs/release.md gives it, and doctor reads first. */
export const RELEASE_CALLER_PATH = '.github/workflows/release.yml';
/** release-please's configuration, at the repository root. */
export const RELEASE_CONFIG_PATH = 'release-please-config.json';
/** release-please's manifest, at the repository root. */
export const RELEASE_MANIFEST_PATH = '.release-please-manifest.json';
/** Where the `simple` type keeps the version; release-please updates it and never creates it. */
export const VERSION_PATH = 'version.txt';

/** The version a project starts from: its first release is `initial-version`, `0.1.0`. */
export const START_VERSION = '0.0.0';

/** Kanon's type table (`K-SHIP-4`), all eleven, in the changelog's order. */
export const CHANGELOG_SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['build', 'Build and Dependencies'],
  ['revert', 'Reverts'],
  ['docs', 'Documentation'],
  ['style', 'Styling'],
  ['test', 'Tests'],
  ['ci', 'CI'],
  ['chore', 'Chores'],
];

/** The Releaser's two secrets, which the caller maps by name, never through `secrets: inherit`. */
export const RELEASER_SECRETS = ['RELEASER_APP_ID', 'RELEASER_APP_PRIVATE_KEY'];

/**
 * The caller of Kanon's release workflow, as docs/release.md's "A thin caller" gives it, pinned to
 * `release`, on pushes to the default branch; with the Releaser, its two secrets mapped by name.
 * @param {string} release @param {string} defaultBranch @param {boolean} releaser
 */
export const releaseCallerFile = (release, defaultBranch, releaser) =>
  [
    'name: Release',
    '',
    'on:',
    '  push:',
    `    branches: [${yamlScalar(defaultBranch)}]`,
    '',
    'permissions: {}',
    '',
    'jobs:',
    '  release:',
    '    name: Release',
    '    permissions:',
    '      contents: write',
    '      pull-requests: write',
    `    uses: yedeya-labs/kanon/.github/workflows/release.yml@${release}`,
    ...(releaser ? ['    secrets:', ...RELEASER_SECRETS.map((s) => `      ${s}: \${{ secrets.${s} }}`)] : []),
    '',
  ].join('\n');

/**
 * release-please's configuration, as docs/release.md's "Your release configuration" gives it:
 * the `simple` type, the package named `packageName`, Kanon's eleven changelog sections.
 * @param {string} packageName
 */
export const releaseConfigFile = (packageName) =>
  [
    '{',
    '  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",',
    '  "packages": {',
    '    ".": {',
    '      "release-type": "simple",',
    `      "package-name": ${JSON.stringify(packageName)},`,
    '      "changelog-path": "CHANGELOG.md",',
    '      "initial-version": "0.1.0",',
    '      "include-component-in-tag": false,',
    '      "include-v-in-tag": true,',
    '      "bump-minor-pre-major": true,',
    '      "bump-patch-for-minor-pre-major": false,',
    '      "changelog-sections": [',
    ...CHANGELOG_SECTIONS.map(([type, section], i) => `        { "type": ${JSON.stringify(type)}, "section": ${JSON.stringify(section)} }${i < CHANGELOG_SECTIONS.length - 1 ? ',' : ''}`),
    '      ]',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

/** release-please's manifest, at the starting version. */
export const releaseManifestFile = () => `{\n  ".": "${START_VERSION}"\n}\n`;

/** `version.txt`, for the `simple` type, at the starting version. */
export const versionFile = () => `${START_VERSION}\n`;

/**
 * The release files `init` plans (kanon#1553): the caller, unless the repository calls Kanon's
 * release workflow already; and, where the repository has no release-please configuration, the
 * configuration, and the manifest and `version.txt` where each is missing. None of the three
 * where the caller's path holds a release workflow of the project's own, which reads none of them.
 * @param {{ release: string, defaultBranch: string, releaser: boolean, packageName: string, read: (rel: string) => string | null, calls: boolean }} c
 *   `calls`: whether the repository's caller already calls Kanon's release workflow
 * @returns {Map<string, string>}
 */
export const releaseFiles = ({ release, defaultBranch, releaser, packageName, read, calls }) => {
  /** @type {Map<string, string>} */
  const files = new Map();
  const own = !calls && read(RELEASE_CALLER_PATH) !== null;
  if (!calls) files.set(RELEASE_CALLER_PATH, releaseCallerFile(release, defaultBranch, releaser));
  // A configuration the project has is the project's, and so is where it keeps its version.
  if (own || read(RELEASE_CONFIG_PATH) !== null) return files;
  files.set(RELEASE_CONFIG_PATH, releaseConfigFile(packageName));
  if (read(RELEASE_MANIFEST_PATH) === null) files.set(RELEASE_MANIFEST_PATH, releaseManifestFile());
  if (read(VERSION_PATH) === null) files.set(VERSION_PATH, versionFile());
  return files;
};
