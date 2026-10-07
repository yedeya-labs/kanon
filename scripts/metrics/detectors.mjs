// The revert and linked-fix detectors (plan 0003 §3.5, M2 part B, kanon#516): which later merged
// pull requests revert or fix an earlier merged item, read from GitHub's own records.
//
// PURE. Nothing here reads the network, git or a file. The dry run (`kanon metrics dry-run`,
// M2 part C) and later the collector's work-item step (M4) fetch the pull requests and pass them
// in, in the plain shape below; SZZ's blame is a function they pass too, so it can come from
// `git blame` on a checkout or from the API.
//
// TWO DETECTORS FOR A FIX, KEPT APART (decision 8).
//   explicit   the headline's: the fix closes an issue labelled `bug`; that issue or the fix
//              names the item, by GitHub's own `cross-referenced` event on the item or by the
//              bug form's "Introduced by" field (decision 9); and the fix changes a code-area
//              file the item also changed. It fills `fix_prs` and `first_fix_days`.
//   szz        a diagnostic, never stored or published: the old lines the fix changed in its
//              code-area files blame back to one of the item's commits. On the reference
//              adopter's history it linked 132 of 163 fixes (§1.2), because in a young
//              repository nearly every line was last touched in the month before. The dry run
//              prints its count beside the explicit one, so the gap between them is visible.
//
// THE CODE AREA (§3.7). Condition 3, and SZZ's restriction, need to know which files are code.
// `codeAreaTest` builds that test from the stack document's `## Code areas` (`parseCodeAreas`,
// `scripts/lib/code-areas.mjs`, `K-LAYOUT-17`), with Kanon's default when the project declares
// none: a file inside the declared code trees (or, undeclared, anywhere), that isn't a test and
// isn't in one of §3.7's other areas. Every detector takes the test as `isCode`, so a caller
// holding the work-item module's `areaOf` passes `(path) => areaOf(path) === 'code'` instead.
//
// WHAT IS NOT DONE HERE. The 13-month window, the 30- and 90-day maturity, and which items are
// re-derived are the collector's and the report's (§3.1, §2.4). The detectors return every link
// with its days, and the caller cuts.

import { UNDECLARED, isCodePath, isTestPath } from '../lib/code-areas.mjs';
import { revertTargets } from '../lib/reverts.mjs';

/**
 * @typedef {{ sha: string, message: string }} DetectorCommit one of a PR's head commits
 * @typedef {{ start: number, count: number }} LineRange old-side lines, as a hunk's `-start,count`
 * @typedef {{
 *   path: string,
 *   previousPath?: string | null,
 *   status?: string,
 *   patch?: string | null,
 *   ranges?: LineRange[],
 * }} DetectorFile a changed file. `previousPath` is a rename's old path. SZZ reads the old-side
 *   lines from `ranges` when given, else from the unified-diff hunks in `patch`.
 * @typedef {string | { name: string }} DetectorLabel
 * @typedef {{ number: number, labels: DetectorLabel[], body?: string | null }} DetectorIssue an
 *   issue the PR closes
 * @typedef {{ number: number, repository?: string | null }} DetectorSource what made a
 *   cross-reference: an issue or PR number, and its `owner/name` when known (another
 *   repository's never links)
 * @typedef {{ type: string, source?: DetectorSource | null }} DetectorEvent one of the PR's own
 *   timeline events; only `cross-referenced` is read
 * @typedef {{
 *   number: number,
 *   title?: string,
 *   body?: string | null,
 *   mergeCommitSha: string | null,
 *   parentSha?: string | null,
 *   mergedAt: string | null,
 *   commits: DetectorCommit[],
 *   files: DetectorFile[],
 *   closingIssues: DetectorIssue[],
 *   timeline: DetectorEvent[],
 * }} DetectorPr one pull request. `mergedAt` null means not merged, and such a PR is neither an
 *   item nor a revert or fix. `parentSha` is the commit SZZ blames at, default
 *   `<mergeCommitSha>^`.
 * @typedef {(path: string, ranges: LineRange[], atSha: string) => string[] | Promise<string[]>} Blame
 *   the commits that last touched `ranges` of `path` at `atSha`, one SHA per line or deduplicated
 * @typedef {{ pr: number, days: number }} Link a later PR and the whole days from the item's merge
 *   to its merge
 * @typedef {Link & { via: ('cross-reference' | 'introduced-by')[], files: string[] }} ExplicitLink
 *   `files`: the code-area files both changed
 */

const DAY_MS = 86_400_000;

/** The label a fix's closing issue must carry (§3.5, condition 1). */
export const BUG_LABEL = 'bug';

/** The bug issue form's field naming the PR that introduced the bug (decision 9, M3). */
export const INTRODUCED_BY = 'Introduced by';

/**
 * §3.7's areas before `code`, first match wins, so a file in one of them is never code. The
 * `tests` area comes from the stack document, in `codeAreaTest`. The `migrations` area's
 * adopter-declared paths come from the escalation list, which this pure module doesn't read:
 * any `migrations/` directory stands for it here, and a caller with the list passes its own
 * `isCode`.
 */
const NOT_CODE = [
  // deps: lockfiles and dependency manifests
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$/,
  // workflows
  /^\.github\/(workflows|actions)\//,
  // migrations
  /(^|\/)migrations\//,
  // specs (`K-LAYOUT-2`, `docs/qa/specs/`) and docs
  /\.md$|^docs\//,
  // config: dotfiles, and configuration files at the root
  /(^|\/)\.[^/]+$/,
  /^[^/]+\.(json|ya?ml|toml|ini|cfg|conf)$|^[^/]+\.config\.[cm]?[jt]s$/,
];

/**
 * The code-area test (§3.7) for a project, from its stack document's `## Code areas`
 * (`parseCodeAreas`), or Kanon's default when it declares none.
 * @param {import('../lib/code-areas.mjs').CodeAreas} [areas]
 * @returns {(path: string) => boolean}
 */
export function codeAreaTest(areas = UNDECLARED) {
  return (path) => isCodePath(path, areas) && !isTestPath(path, areas) && !NOT_CODE.some((re) => re.test(path));
}

/** @param {DetectorPr} pr */
const mergedTime = (pr) => (pr.mergedAt ? Date.parse(pr.mergedAt) : NaN);

/** @param {DetectorPr} item @param {DetectorPr} later */
const daysBetween = (item, later) => Math.floor((mergedTime(later) - mergedTime(item)) / DAY_MS);

/** @param {DetectorPr} a @param {DetectorPr} b */
const byMerge = (a, b) => mergedTime(a) - mergedTime(b) || a.number - b.number;

/** The merged PRs in `prs` that merged after `item` did, oldest first. @param {DetectorPr} item @param {DetectorPr[]} prs */
function after(item, prs) {
  const t = mergedTime(item); // NaN, unmerged, compares false with everything
  return prs.filter((p) => mergedTime(p) > t).sort(byMerge);
}

/** The merged PRs in `prs` that merged before `pr` did, oldest first. @param {DetectorPr} pr @param {DetectorPr[]} prs */
function before(pr, prs) {
  const t = mergedTime(pr); // NaN, unmerged, compares false with everything
  return prs.filter((p) => mergedTime(p) < t).sort(byMerge);
}

/** Whether two SHAs name the same commit, either being a prefix of 7 or more. @param {string} a @param {string} b */
function sameSha(a, b) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

// ── Reverts ──────────────────────────────────────────────────────────────────────────────────

/**
 * Whether `r` reverts `item` (§3.5): one of `r`'s commits says `This reverts commit <sha>.` with
 * `<sha>` the item's merge commit, or `r`'s body is the Revert button's `Reverts <repo>#<item>`.
 * A revert of ANOTHER commit is no revert of this item, whatever else the two share (§7).
 * The text is read by `revertTargets`, the parser the Lead's reconciler reads reverts with.
 * @param {DetectorPr} r @param {DetectorPr} item @param {string} repo `owner/name`
 */
export function reverts(r, item, repo) {
  const sha = item.mergeCommitSha;
  if (sha && r.commits.some((c) => revertTargets(c.message, repo).shas.some((t) => sameSha(t, sha)))) return true;
  return revertTargets(r.body ?? '', repo).prs.includes(item.number);
}

/**
 * Every later merged PR that reverts `item`, oldest first. A revert later re-applied still counts:
 * the item was reverted (§3.5).
 * @param {DetectorPr} item @param {DetectorPr[]} prs @param {{ repo: string }} opts
 * @returns {Link[]}
 */
export function revertsOf(item, prs, { repo }) {
  return after(item, prs).filter((r) => reverts(r, item, repo)).map((r) => ({ pr: r.number, days: daysBetween(item, r) }));
}

/**
 * The earlier merged items `r` reverts, oldest first: what the collector re-derives when `r` merges.
 * @param {DetectorPr} r @param {DetectorPr[]} prs @param {{ repo: string }} opts
 * @returns {Link[]}
 */
export function revertedBy(r, prs, { repo }) {
  return before(r, prs).filter((item) => reverts(r, item, repo)).map((item) => ({ pr: item.number, days: daysBetween(item, r) }));
}

// ── Explicit links ───────────────────────────────────────────────────────────────────────────

/** @param {DetectorLabel} l */
const labelName = (l) => (typeof l === 'string' ? l : l.name);

/** @param {DetectorPr} pr */
const bugIssues = (pr) => pr.closingIssues.filter((i) => i.labels.some((l) => labelName(l) === BUG_LABEL));

/**
 * The PR numbers the bug form's "Introduced by" field names (decision 9). GitHub renders an issue
 * form's field as a `### <label>` heading and its value. The value counts only when ALL of it
 * names pull requests of `repo`: `#N`, `N`, `<repo>#N` or `https://github.com/<repo>/pull/N`,
 * separated by commas or spaces. Prose ("similar to #12") and `_No response_` name nothing, since
 * a mention is not the statement the field makes.
 * @param {string | null | undefined} body @param {string} repo
 * @returns {number[]}
 */
export function introducedBy(body, repo) {
  const lines = String(body ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === `### ${INTRODUCED_BY}`);
  if (at === -1) return [];
  const end = lines.findIndex((l, i) => i > at && /^#{1,3}\s/.test(l));
  const value = lines.slice(at + 1, end === -1 ? undefined : end).join(' ').trim();
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ref = new RegExp(`^(?:#?|${esc}#|https://github\\.com/${esc}/pull/)(\\d{1,9})$`, 'i');
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  const numbers = tokens.map((t) => ref.exec(t)?.[1]);
  return numbers.every((n) => n !== undefined) ? numbers.map(Number) : [];
}

/**
 * The code-area files both PRs changed (§3.5, condition 3). A rename counts under either path.
 * @param {DetectorPr} fix @param {DetectorPr} item @param {(path: string) => boolean} isCode
 */
export function sharedCodeFiles(fix, item, isCode) {
  const paths = (/** @type {DetectorPr} */ pr) => pr.files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path]));
  const mine = new Set(paths(item).filter(isCode));
  return [...new Set(paths(fix).filter((p) => mine.has(p)))];
}

/**
 * Whether `fix` is an explicit linked fix of `item` (§3.5), and how. All three must hold:
 *   1. `fix` closes an issue labelled `bug`;
 *   2. that issue, or `fix`, cross-references `item`: a `cross-referenced` event on the item
 *      whose source is the issue or `fix` in this repository, or the issue's "Introduced by"
 *      field names the item;
 *   3. `fix` changes a code-area file `item` also changed. A shared doc, workflow or config file
 *      is not enough (§7).
 * @param {DetectorPr} fix @param {DetectorPr} item
 * @param {{ repo: string, isCode: (path: string) => boolean }} opts
 * @returns {ExplicitLink | null}
 */
export function explicitLink(fix, item, { repo, isCode }) {
  if (!(mergedTime(fix) > mergedTime(item))) return null;
  const bugs = bugIssues(fix);
  if (bugs.length === 0) return null;
  const sources = new Set([fix.number, ...bugs.map((i) => i.number)]);
  /** @type {ExplicitLink['via']} */
  const via = [];
  const sameRepo = (/** @type {DetectorSource} */ s) => !s.repository || s.repository.toLowerCase() === repo.toLowerCase();
  if (item.timeline.some((e) => e.type === 'cross-referenced' && e.source && sameRepo(e.source) && sources.has(e.source.number))) {
    via.push('cross-reference');
  }
  if (bugs.some((i) => introducedBy(i.body, repo).includes(item.number))) via.push('introduced-by');
  if (via.length === 0) return null;
  const files = sharedCodeFiles(fix, item, isCode);
  if (files.length === 0) return null;
  return { pr: item.number, days: daysBetween(item, fix), via, files };
}

/**
 * The earlier merged items `fix` is an explicit linked fix of, oldest first.
 * @param {DetectorPr} fix @param {DetectorPr[]} prs @param {{ repo: string, isCode: (path: string) => boolean }} opts
 * @returns {ExplicitLink[]}
 */
export function explicitLinks(fix, prs, opts) {
  return before(fix, prs).flatMap((item) => explicitLink(fix, item, opts) ?? []);
}

/**
 * The later merged PRs that are explicit linked fixes of `item`, oldest first, each with its days
 * from the item's merge.
 * @param {DetectorPr} item @param {DetectorPr[]} prs @param {{ repo: string, isCode: (path: string) => boolean }} opts
 * @returns {Link[]}
 */
export function fixesOf(item, prs, opts) {
  return after(item, prs).flatMap((fix) => (explicitLink(fix, item, opts) ? [{ pr: fix.number, days: daysBetween(item, fix) }] : []));
}

/** The most fix PRs one row stores: `fix_prs`'s pattern holds 20 (§3.3). */
export const MAX_FIX_PRS = 20;

/**
 * The item's group 3 accuracy fields from the detectors (§3.3): the first revert and the explicit
 * linked fixes. SZZ never reaches a row (decision 8). A field with nothing to say is absent.
 * @param {DetectorPr} item @param {DetectorPr[]} prs @param {{ repo: string, isCode: (path: string) => boolean }} opts
 * @returns {{ revert_pr?: number, revert_days?: number, fix_prs?: string, first_fix_days?: number }}
 */
export function accuracyFields(item, prs, opts) {
  const [revert] = revertsOf(item, prs, opts);
  const fixes = fixesOf(item, prs, opts);
  return {
    ...(revert ? { revert_pr: revert.pr, revert_days: revert.days } : {}),
    ...(fixes.length ? { fix_prs: fixes.slice(0, MAX_FIX_PRS).map((f) => f.pr).join(','), first_fix_days: /** @type {Link} */ (fixes[0]).days } : {}),
  };
}

// ── SZZ ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The old-side lines a changed file's diff removes or rewrites: `ranges` when given, else each
 * hunk's `-start,count` in `patch` (a count omitted is 1). A hunk that only adds lines (count 0)
 * has nothing to blame.
 * @param {DetectorFile} file
 * @returns {LineRange[]}
 */
export function oldRanges(file) {
  const all = file.ranges ?? [...String(file.patch ?? '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)]
    .map((m) => ({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) }));
  return all.filter((r) => r.count > 0);
}

/**
 * The earlier merged items SZZ links `fix` to: the old lines `fix` changed in its code-area files,
 * blamed at its parent, were last touched by one of the item's commits (its merge commit, or a
 * head commit, for a project that merges without squashing). A diagnostic only (decision 8).
 * @param {DetectorPr} fix @param {DetectorPr[]} prs
 * @param {{ isCode: (path: string) => boolean, blame: Blame }} opts
 * @returns {Promise<Link[]>}
 */
export async function szzLinks(fix, prs, { isCode, blame }) {
  const at = fix.parentSha ?? (fix.mergeCommitSha ? `${fix.mergeCommitSha}^` : null);
  if (at === null) return [];
  /** @type {string[]} */
  const blamed = [];
  for (const file of fix.files) {
    const path = file.previousPath ?? file.path;
    if (!isCode(path)) continue;
    const ranges = oldRanges(file);
    if (ranges.length === 0) continue;
    blamed.push(...(await blame(path, ranges, at)));
  }
  const own = (/** @type {DetectorPr} */ item) => [item.mergeCommitSha, ...item.commits.map((c) => c.sha)].filter((s) => typeof s === 'string');
  return before(fix, prs)
    .filter((item) => own(item).some((s) => blamed.some((b) => sameSha(s, b))))
    .map((item) => ({ pr: item.number, days: daysBetween(item, fix) }));
}

// ── Side by side ─────────────────────────────────────────────────────────────────────────────

/** A conventional-commit `fix` title: `fix:`, `fix(scope):`, `fix!:` (`K-SHIP-4`). */
const FIX_TITLE = /^fix(\([^)]*\))?!?:/;

/**
 * Whether a merged PR is a fix, the population both detectors are counted over: its title is a
 * conventional `fix`, or it closes an issue labelled `bug`.
 * @param {DetectorPr} pr
 */
export const isFixPr = (pr) => FIX_TITLE.test(pr.title ?? '') || bugIssues(pr).length > 0;

/**
 * The detectors' counts over a set of PRs, side by side, for the dry run (§7, M2), with the
 * detail behind them for the Owner's hand check. Every count is over merged fix PRs (`isFixPr`)
 * except `revertedItems` and `reverts`.
 *
 *   explicit, szz       fixes each detector links to at least one earlier item
 *   both, explicitOnly, szzOnly, neither   their overlap
 *   undetected          fixes the explicit detector, the headline's, links to nothing
 *   nonCodeGap          of those, the ones that change no code-area file: §3.5's non-code gap,
 *                       which condition 3 can never detect
 *   revertedItems       merged items some later merged PR reverts
 *   reverts             merged PRs that revert an earlier item
 *
 * @param {DetectorPr[]} prs
 * @param {{ repo: string, isCode: (path: string) => boolean, blame: Blame }} opts
 */
export async function detectorCounts(prs, opts) {
  const merged = prs.filter((p) => !Number.isNaN(mergedTime(p))).sort(byMerge);
  /** @type {{ pr: number, explicit: ExplicitLink[], szz: Link[], touchesCode: boolean }[]} */
  const fixes = [];
  for (const fix of merged.filter(isFixPr)) {
    const explicit = explicitLinks(fix, merged, opts);
    const szz = await szzLinks(fix, merged, opts);
    const touchesCode = fix.files.some((f) => opts.isCode(f.path) || (!!f.previousPath && opts.isCode(f.previousPath)));
    fixes.push({ pr: fix.number, explicit, szz, touchesCode });
  }
  const e = (/** @type {typeof fixes[number]} */ f) => f.explicit.length > 0;
  const s = (/** @type {typeof fixes[number]} */ f) => f.szz.length > 0;
  const count = (/** @type {(f: typeof fixes[number]) => boolean} */ p) => fixes.filter(p).length;
  const revertingPrs = merged.filter((r) => revertedBy(r, merged, opts).length > 0);
  return {
    counts: {
      fixes: fixes.length,
      explicit: count(e),
      szz: count(s),
      both: count((f) => e(f) && s(f)),
      explicitOnly: count((f) => e(f) && !s(f)),
      szzOnly: count((f) => !e(f) && s(f)),
      neither: count((f) => !e(f) && !s(f)),
      undetected: count((f) => !e(f)),
      // A fix the explicit detector links shares a code file by condition 3, so it is never here.
      nonCodeGap: count((f) => !f.touchesCode),
      revertedItems: merged.filter((i) => revertsOf(i, merged, opts).length > 0).length,
      reverts: revertingPrs.length,
    },
    fixes,
  };
}
