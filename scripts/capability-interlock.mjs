#!/usr/bin/env node
// RA-866 — the capability-review backlog INTERLOCK, counted so an abandoned PR cannot
// deflate it (`K-SELF-17`). Moved from the reference adopter into Kanon's library with the
// Overseer's lane (plan 0004, step 13); the repository is the one the lane runs in.
//
// ── WHAT THE INTERLOCK IS ───────────────────────────────────────────────────
// The Overseer's weekly capability review may file ONE capability-investigation issue per
// scan, and only while at most 6 such issues are open and unabsorbed (RA-845). "Unabsorbed"
// was defined as "no linked PR", and counted with one search:
//
//   repo:<owner>/<repo> is:issue is:open label:capability -linked:pr
//
// ── WHY THAT QUERY ALONE IS NOT THE COUNT ───────────────────────────────────
// `linked:pr` is STATE-BLIND. An issue is linked as soon as any PR carries a closing
// reference to it, and it STAYS linked after that PR is closed unmerged (verified on
// RA-619, whose only closing PR, RA-623, is CLOSED with `mergedAt: null`). So an open,
// unabsorbed capability investigation whose PR was abandoned is subtracted from the count
// for good. That moves the count toward `<= 6`, the UNLOCK direction, which is the one
// direction the interlock exists to prevent.
//
// GitHub issue search has no qualifier that constrains the linked PR's state (`linked:pr`
// is the only form), so this cannot be fixed inside the query. It is fixed by one more
// read: the GraphQL `closedByPullRequestsReferences(includeClosedPrs: true)` connection
// reports each linked PR's state, and an issue whose linked PRs are ALL `CLOSED` (none
// open, none merged) is added back.
//
// ── FAILS CLOSED ────────────────────────────────────────────────────────────
// Every read failure, including a search that reports `incomplete_results`, exits
// non-zero and prints `unknown`, and the prompt treats that as
// "file nothing". A linked issue whose PRs this token cannot see (a cross-repo or private
// reference, so the connection comes back empty) is counted IN and listed, because
// counting it out would be the same silent unlock by another route. A result that was
// truncated by paging throws rather than under-counting.
//
// DEPENDENCY-FREE: the Overseer job installs nothing, so this imports `node:` only, like
// every script under scripts/ (`K-SELF-8`).
//
// Usage: node "$KANON/scripts/capability-interlock.mjs"
//   On GITHUB_REPOSITORY, the repository the lane runs in, which it requires. Line 1 of
//   stdout is the count (or `unknown`); the lines after it explain it.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The RA-845 cohort query. Canonical: the Overseer's prompt quotes it verbatim, with the
 * repository it runs in.
 * @param {string} repo `owner/name`
 */
export const unlinkedQuery = (repo) => `repo:${repo} is:issue is:open label:capability -linked:pr`;
/**
 * The complement: the issues `-linked:pr` subtracted, whose PR states this reads.
 * @param {string} repo `owner/name`
 */
export const linkedQuery = (repo) => `repo:${repo} is:issue is:open label:capability linked:pr`;
/** `> THRESHOLD` means file nothing. Stated here for the output line only; the rule
 *  itself lives in the prompt and the playbook, and this must not change it. */
export const THRESHOLD = 6;

/**
 * The interlock count. Pure, so the add-back rule is assertable.
 *
 * @param {{unlinked: number, linked: {number: number, prs: {number: number, state: string}[]}[]}} input
 *   `unlinked` is the `-linked:pr` total; `linked` is every open capability issue the
 *   search calls linked, with the state of each PR that references it.
 * @returns {{count: number, unlinked: number, abandoned: number[], unverifiable: number[]}}
 */
export function interlockCount({ unlinked, linked }) {
  // Only a PR that is still OPEN or was MERGED absorbs the issue. A CLOSED-unmerged one
  // is an abandoned attempt, and the issue is exactly as outstanding as before it.
  const absorbs = (/** @type {{ state: string }} */ pr) => pr.state === 'OPEN' || pr.state === 'MERGED';
  const abandoned = linked.filter((i) => i.prs.length > 0 && !i.prs.some(absorbs)).map((i) => i.number);
  // Search says linked, but no PR is visible: count it IN (see the header).
  const unverifiable = linked.filter((i) => i.prs.length === 0).map((i) => i.number);
  return { count: unlinked + abandoned.length + unverifiable.length, unlinked, abandoned, unverifiable };
}

/**
 * What the agent reads. Line 1 is the number alone, so it cannot be misparsed.
 * @param {{count: number, unlinked: number, abandoned: number[], unverifiable: number[]}} r
 */
export function renderInterlock({ count, unlinked, abandoned, unverifiable }) {
  const nums = (/** @type {number[]} */ xs) => xs.map((n) => `#${n}`).join(', ');
  return [
    String(count),
    `${unlinked} open \`capability\` issue(s) with no linked PR`,
    abandoned.length
      ? `+ ${abandoned.length} whose linked PRs were all closed unmerged, added back (RA-866): ${nums(abandoned)}`
      : '+ 0 whose linked PRs were all closed unmerged',
    ...(unverifiable.length
      ? [`+ ${unverifiable.length} linked by a PR this token cannot see, counted in to fail closed: ${nums(unverifiable)}`]
      : []),
    count > THRESHOLD ? `> ${THRESHOLD}: the interlock is CLOSED, so file nothing.` : `<= ${THRESHOLD}: the interlock is clear.`,
  ].join('\n');
}

/**
 * The REST search's `-linked:pr` total. THROWS on `incomplete_results`: a search that
 * timed out answers HTTP 200 with a partial, LOW `total_count`, and a low count is the
 * unlock direction.
 * @param {any} json
 * @returns {number}
 */
export function unlinkedFromSearch(json) {
  if (json?.incomplete_results) throw new Error('the search reported incomplete_results; its total_count is partial');
  const n = json?.total_count;
  if (!Number.isInteger(n)) throw new Error('the -linked:pr search returned no integer total_count');
  return n;
}

/**
 * GraphQL search nodes → the `linked` input. THROWS on truncation rather than
 * under-counting, because a missing issue reads as a smaller count.
 * @param {any} data
 * @returns {{ number: number, prs: { number: number, state: string }[] }[]}
 */
export function linkedFromGraphql(data) {
  const search = data?.data?.search;
  if (!search || !Array.isArray(search.nodes)) throw new Error('GraphQL response has no search.nodes');
  if (search.issueCount > search.nodes.length) {
    throw new Error(`search matched ${search.issueCount} linked issues but returned ${search.nodes.length}; refusing to under-count`);
  }
  return search.nodes.map((/** @type {any} */ n) => {
    const conn = n.closedByPullRequestsReferences;
    if (conn?.pageInfo?.hasNextPage) throw new Error(`#${n.number} has more linked PRs than one page; refusing to guess`);
    return { number: n.number, prs: (conn?.nodes ?? []).map((/** @type {any} */ p) => ({ number: p.number, state: p.state })) };
  });
}

const GRAPHQL = `query($q: String!) {
  search(type: ISSUE, first: 100, query: $q) {
    issueCount
    nodes { ... on Issue { number
      closedByPullRequestsReferences(first: 50, includeClosedPrs: true) {
        pageInfo { hasNextPage } nodes { number state } } } }
  }
}`;

/**
 * The interlock, counted on `repo`. THROWS on any read failure: the caller treats that as a
 * closed interlock.
 * @param {string} repo `owner/name`
 * @param {(args: string[]) => string} [gh] `gh`, injected for tests
 */
export function countInterlock(repo, gh = (args) => execFileSync('gh', args, { encoding: 'utf8' })) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`'${repo}' is not an owner/name repository`);
  const unlinked = unlinkedFromSearch(JSON.parse(gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${unlinkedQuery(repo)}`, '-f', 'per_page=1'])));
  const linked = linkedFromGraphql(JSON.parse(gh(['api', 'graphql', '-f', `query=${GRAPHQL}`, '-f', `q=${linkedQuery(repo)}`])));
  return interlockCount({ unlinked, linked });
}

/* c8 ignore start */
function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.log('unknown');
    console.error('capability-interlock: GITHUB_REPOSITORY must be set');
    process.exitCode = 2;
    return;
  }
  try {
    console.log(renderInterlock(countInterlock(repo)));
  } catch (err) {
    console.log('unknown');
    console.log(`could not count the interlock (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]}). Treat it as CLOSED: file nothing.`);
    process.exitCode = 1;
  }
}

// Compare the RESOLVED path (RA-944): through a symlinked checkout the typed argv[1]
// differs from import.meta.url and a raw compare exits 0 having counted nothing.
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(String(process.argv[1]))).href; } catch { return false; }
})();
if (IS_CLI) main();
/* c8 ignore stop */
