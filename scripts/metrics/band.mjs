// The amount of work in a pull request, and its complexity band (plan 0003 §3.6, decision 10).
//
// THE BAND IS COMPUTED FROM STORED COUNTS ONLY: `changed_lines`, `changed_files` and
// `changed_dirs`. So the collector, the store's aggregates and every report get the same band
// for the same row, and a new band version recomputes every stored row without collecting
// anything again. `diffSize` is the one place those counts are made from a file list.
//
// RISK IS NOT A BUMP (§3.6, step 5). On the reference adopter 240 of 336 PRs touch an
// escalation path; bumping them would put 146 in XL and leave 24 in S. Risk is the `esc_*`
// split instead (`areas.mjs`), and `bandOf` never reads it.

import { LOCKFILES } from './areas.mjs';

/** The band version this release writes (§3.6, "Versioning"). */
export const BAND_VERSION = 1;

/** The bands, smallest first. */
export const BANDS = /** @type {const} */ (['S', 'M', 'L', 'XL']);

/**
 * Each version's thresholds. `lines`: the most changed lines each band below XL holds, so S is
 * up to 200, M up to 500, L up to 1,200, and XL above. `files` and `dirs`: the spread bump, one
 * band up at either. A new version is a new entry, released with a changelog line, and the old
 * one stays so a report can say what a stored `band_version` meant.
 * @type {Readonly<Record<number, { lines: readonly [number, number, number], files: number, dirs: number }>>}
 */
export const BAND_THRESHOLDS = Object.freeze({
  1: Object.freeze({ lines: /** @type {const} */ ([200, 500, 1200]), files: 20, dirs: 8 }),
});

/**
 * The band of a row's counts under `version` (§3.6): the base band from `changed_lines`, one
 * up when `changed_files` or `changed_dirs` reaches its spread threshold, capped at XL.
 * Undefined when `changed_lines` is unknown, because absent means unknown, never zero; an
 * unknown spread count is no bump, since the three come from one file list and are known
 * together. Throws on a version this release doesn't know, rather than banding by another's
 * thresholds.
 * @param {{ changed_lines?: number, changed_files?: number, changed_dirs?: number }} row
 * @param {number} [version]
 * @returns {'S' | 'M' | 'L' | 'XL' | undefined}
 */
export function bandOf(row, version = BAND_VERSION) {
  const t = Object.hasOwn(BAND_THRESHOLDS, version) ? BAND_THRESHOLDS[version] : undefined;
  if (!t) throw new RangeError(`band version ${version} is not one this release knows (${Object.keys(BAND_THRESHOLDS).join(', ')})`);
  const lines = row.changed_lines;
  if (!Number.isInteger(lines) || /** @type {number} */ (lines) < 0) return undefined;
  let band = t.lines.findIndex((max) => /** @type {number} */ (lines) <= max);
  if (band === -1) band = t.lines.length;
  if ((row.changed_files ?? 0) >= t.files || (row.changed_dirs ?? 0) >= t.dirs) band += 1;
  return BANDS[Math.min(band, BANDS.length - 1)];
}

/** @param {string} path */
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
/** @param {string} path the directory part, `''` for the repository root */
const dirname = (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

/**
 * Whether a changed file is left out of the diff's size (§3.6, step 1): a lockfile, a test
 * snapshot or the changelog, at any depth. Counting them would put a dependency bump in XL.
 * The lockfiles are the `deps` area's (`areas.mjs`), every stack's that Kanon names, so no
 * stack's diff is measured with its lockfile in.
 * @param {string} path repository-relative
 */
export function isExcludedFromSize(path) {
  const name = basename(path);
  return LOCKFILES.has(name) || name === 'CHANGELOG.md' || name.endsWith('.snap');
}

/**
 * A diff's size, as the row stores it (§3.3, group 1): lines (additions plus deletions),
 * files and distinct directories, each over the files `isExcludedFromSize` keeps, and the
 * lines it left out, so nothing is hidden. The root is one directory.
 * @param {readonly import('./types.mjs').ChangedFile[]} files
 * @returns {{ changed_lines: number, changed_files: number, changed_dirs: number, excluded_lines: number }}
 */
export function diffSize(files) {
  let changed = 0;
  let excluded = 0;
  let count = 0;
  const dirs = new Set();
  for (const f of files) {
    const lines = f.additions + f.deletions;
    if (isExcludedFromSize(f.path)) { excluded += lines; continue; }
    changed += lines;
    count += 1;
    dirs.add(dirname(f.path));
  }
  return { changed_lines: changed, changed_files: count, changed_dirs: dirs.size, excluded_lines: excluded };
}
