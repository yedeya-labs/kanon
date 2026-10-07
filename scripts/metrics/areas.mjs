// Each changed file's area, and the escalation categories a change touches (plan 0003 §3.7).
//
// AN AREA IS KANON'S, a FILE'S PLACE IS THE ADOPTER'S. The eight areas and their order are
// fixed and versioned with the band (`BAND_VERSION`). Where the adopter keeps its tests and its
// migrations is its own declaration: the `tests` trees under `## Code areas` in its stack
// document (`K-LAYOUT-17`, `scripts/lib/code-areas.mjs`), and the `migrations` entries of its
// escalation file (`K-LAYOUT-8`, `scripts/lib/escalation-paths.mjs`). Undeclared, each takes
// Kanon's default: a test is what its language's convention calls one, and a migration is a
// file under a `migrations/` directory. The row stores only the count per area and one
// boolean per escalation category, never a path or a pattern.

import { isTestPath } from '../lib/code-areas.mjs';
import { ESCALATION_CATEGORIES, escalationCategories } from '../lib/escalation-paths.mjs';

/** The areas, in the order a file is checked against them: the first that matches wins. */
export const AREAS = /** @type {const} */ (['deps', 'workflows', 'migrations', 'specs', 'tests', 'docs', 'config', 'code']);

/** @typedef {typeof AREAS[number]} Area */

/**
 * Lockfiles, by file name at any depth: JavaScript's, Python's, Go's, Rust's, Ruby's, PHP's,
 * the JVM's, .NET's, Elixir's and Erlang's, Swift's and Dart's. They are `deps` here, and the
 * band leaves them out of a diff's size (§3.6, `band.mjs`), so the two read one list.
 */
export const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock',
  'Pipfile.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock',
  'gradle.lockfile', 'packages.lock.json', 'paket.lock', 'mix.lock', 'rebar.lock',
  'Package.resolved', 'Podfile.lock', 'Cartfile.resolved', 'pubspec.lock',
]);
/** Dependency manifests, by file name at any depth, for the same stacks as `LOCKFILES`. */
const MANIFESTS = new Set([
  'package.json', 'Pipfile', 'pyproject.toml', 'setup.py', 'setup.cfg', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'libs.versions.toml', 'build.sbt',
  'packages.config', 'Directory.Packages.props', 'paket.dependencies', 'mix.exs', 'rebar.config',
  'Package.swift', 'Podfile', 'Cartfile', 'pubspec.yaml',
]);
/** `requirements.txt`, `requirements-dev.txt`, `requirements/base.txt`'s siblings named so. */
const REQUIREMENTS = /^requirements.*\.txt$/;
/** A .NET project file, which holds its package references: `*.csproj`, `*.fsproj`, `*.vbproj`. */
const DOTNET_PROJECT = /\.(?:cs|fs|vb)proj$/;
const WORKFLOWS = /^\.github\/(?:workflows|actions)\//;
const MIGRATIONS = /(?:^|\/)migrations\//;
const SPECS = /^docs\/qa\/specs\//;
const DOCS = /\.md$|^docs\//;
/** A root-level configuration file: `*.config.*`, or a data-format file. */
const ROOT_CONFIG = /\.config\.[a-z]+$|\.(?:json|jsonc|json5|ya?ml|toml|ini|cfg|conf)$/;

/** @param {string} path */
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * What `areaOf` reads besides the path: the adopter's parsed declarations. Each is optional,
 * and an absent one takes Kanon's default, as `UNDECLARED` and an escalation file with no
 * entries do.
 * @typedef {{
 *   codeAreas?: import('../lib/code-areas.mjs').CodeAreas,
 *   escalationFile?: import('../lib/escalation-paths.mjs').EscalationFile,
 * }} AreaContext
 */

/** @type {import('../lib/code-areas.mjs').CodeAreas} */
const NO_AREAS = { declared: false, code: [], tests: [], audit: [] };

/**
 * One changed file's area (§3.7), the first that matches of:
 *   deps        a dependency manifest or lockfile, at any depth;
 *   workflows   `.github/workflows/**`, `.github/actions/**`;
 *   migrations  a path the escalation file puts in the `migrations` category, or any
 *               `migrations/` directory;
 *   specs       the spec corpus, `docs/qa/specs/**` (`K-LAYOUT-2`);
 *   tests       under a declared `tests` tree, or, with none declared, a test by its
 *               language's convention (`isTestPath`);
 *   docs        `*.md`, `docs/**`;
 *   config      a dotfile, or a file in a dot-directory, unless it is inside a declared `code`
 *               tree; or a root-level configuration file;
 *   code        everything else.
 * A dot-directory the adopter declares as code (Kanon declares `.github/scripts/`) is code: the
 * declaration is the adopter saying so, and `config` is only Kanon's guess.
 * @param {string} path repository-relative
 * @param {AreaContext} [ctx]
 * @returns {Area}
 */
export function areaOf(path, { codeAreas = NO_AREAS, escalationFile } = {}) {
  const name = basename(path);
  if (LOCKFILES.has(name) || MANIFESTS.has(name) || REQUIREMENTS.test(name) || DOTNET_PROJECT.test(name)) return 'deps';
  if (WORKFLOWS.test(path)) return 'workflows';
  if (MIGRATIONS.test(path) || (escalationFile?.paths ?? []).some((e) => e.category === 'migrations' && e.pattern.test(path))) return 'migrations';
  if (SPECS.test(path)) return 'specs';
  if (isTestPath(path, codeAreas)) return 'tests';
  if (DOCS.test(path)) return 'docs';
  const inCodeTree = codeAreas.code.some((a) => path.startsWith(a.path));
  if (!inCodeTree && path.split('/').some((part) => part.startsWith('.'))) return 'config';
  if (!path.includes('/') && ROOT_CONFIG.test(name)) return 'config';
  return 'code';
}

/**
 * The row's per-area counts (§3.3, group 1): `files_<area>` for each of the eight, over every
 * changed file (the size exclusions don't apply: a lockfile is still a `deps` file), and the
 * test files added (`tests_added`) and modified or renamed (`tests_changed`).
 * @param {readonly import('./types.mjs').ChangedFile[]} files
 * @param {AreaContext} [ctx]
 * @returns {Record<`files_${Area}`, number> & { tests_added: number, tests_changed: number }}
 */
export function areaCounts(files, ctx = {}) {
  const counts = /** @type {Record<`files_${Area}`, number> & { tests_added: number, tests_changed: number }} */ (
    /** @type {unknown} */ (Object.fromEntries([...AREAS.map((a) => [`files_${a}`, 0]), ['tests_added', 0], ['tests_changed', 0]]))
  );
  for (const f of files) {
    const area = areaOf(f.path, ctx);
    counts[`files_${area}`] += 1;
    if (area !== 'tests') continue;
    if (f.status === 'added') counts.tests_added += 1;
    else if (f.status === 'modified' || f.status === 'renamed') counts.tests_changed += 1;
  }
  return counts;
}

/**
 * The row's escalation booleans (§3.7): `esc_<category>` for each of Kanon's eight categories,
 * true when a changed path matches an entry of that category, false otherwise. The matching is
 * `escalationCategories`', the one the escalation module owns, so a declared path counts
 * whether or not a human-gated promotion stops it escalating. A rename counts its old path too:
 * moving a file out of a risky directory touches that directory.
 * @param {import('../lib/escalation-paths.mjs').EscalationFile} file
 * @param {readonly import('./types.mjs').ChangedFile[]} files
 * @returns {Record<string, boolean>}
 */
export function escalationFlags(file, files) {
  const paths = files.flatMap((f) => (f.previous_path ? [f.path, f.previous_path] : [f.path]));
  const hit = new Set(escalationCategories(file, paths));
  return Object.fromEntries(ESCALATION_CATEGORIES.map((c) => [`esc_${c}`, hit.has(c)]));
}
