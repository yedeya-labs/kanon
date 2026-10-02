#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-2071 — invariant ids that OPEN PRs have already claimed.
//
// THE HOLE. `spec-ids.mjs` allocates against the committed high-water mark in
// `_id-registry.json`, which is a snapshot of `main` at the moment the branch was cut,
// and `spec-guard.mjs` checks duplicates and the mark WITHIN ONE TREE. Neither can see a
// sibling PR. Two branches cut from the same `main` therefore both take `STORE-113`, the
// two clauses do not conflict textually (they insert at different lines), and the merge
// of both is clean and carries a duplicate id — exactly the state `main` reached with
// `[STORE-102]` (RA-2005/RA-2006/RA-2012), red for every branch cut from it until RA-2003
// renumbered one side. PR RA-2056 had to renumber twice for the same reason; the second
// time it was caught by the author reading the other open PRs by hand.
//
// TWO CONSUMERS, ONE DEFINITION OF "A CLAIM":
//   • `spec-ids.mjs` allocates ABOVE every open PR's claim, so a branch that allocates
//     after a sibling has pushed cannot take the sibling's number. That is the
//     prevention, and it runs where ids are minted, so it depends on nobody remembering
//     to run `gh pr list` (RA-2071's second requirement).
//   • this file's CLI, run by CI on every PR, is the backstop for what the allocator
//     cannot see: two branches allocating before either has pushed, or an id written by
//     hand. It names the PR that holds the contested id (RA-2071's fourth requirement).
//
// WHAT A CLAIM IS: an id on an ADDED line of a `docs/qa/specs/*.md` patch, minus every
// id on a REMOVED line of any spec patch in the same PR. The subtraction is what keeps
// an EDITED clause (its declaration line rewritten, id unchanged — the commonest spec
// diff there is) and a clause MOVED between spec files from reading as a new claim.
// An id inside a FENCED code block is an example, not a declaration — `spec-guard` and
// the parser already skip it (`fencedLines`, RA-926), and this reader used to count it.
// A patch hunk cannot say whether it starts inside a fence, so an added line is judged
// against the WHOLE new file (the head blob, read only for a patch that adds a
// declaration-shaped line). Where that read fails, NOTHING is skipped — the hunk alone
// reads a closing fence above it as an opener and would drop the real ids after it, which
// under-counts, the unsafe direction for an allocator. REMOVED lines are never
// fence-filtered either: subtracting every removed id is what this did before, and the
// base file it would take to do better is a second read per file for a rarer case.
//
// WHO YIELDS. The HIGHER-NUMBERED PR — the one opened later — fails; the lower one gets a
// warning naming the sibling and stays green. Push order is not the answer: whoever
// re-pushes second would lose, and on RA-2053/RA-2056 that would have been an accident. PR
// number is the order in which the claims became visible to the other side, which is the
// rule RA-2056's author applied by hand when yielding to RA-2053.
//
// WHAT IT CANNOT SEE, said rather than implied (RA-945):
//   • a claim on a branch with no open PR yet — the allocator reads open PRs only;
//   • a stale branch whose id `main` has since used — that is a duplicate inside the
//     merge result, which `spec-guard` catches once the branch is rebased;
//   • a LOWER-numbered PR that later adds an id a higher-numbered sibling already holds.
//     The lower one is warned, not failed, by the rule above, and the higher one is not
//     re-run by the lower one's push. It needs an id minted by hand to get there, since
//     the allocator steps over the sibling's claim — and a hand-minted id above the
//     registry fails `spec-guard` unless the registry was hand-edited to match.
//   • a GAP is not a claim and is not a problem: a registry that steps over a sibling's
//     reservation is correct, and nothing here asks for contiguity.
//
// Usage (CI):     node scripts/spec-id-claims.mjs --pr <number>
// Usage (local):  node scripts/spec-id-claims.mjs         (claims against this branch)

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DECL, SPEC_DIR, fencedLines } from './spec-lib.mjs';

const isSpecDoc = (f) => f.startsWith(`${SPEC_DIR}/`) && f.endsWith('.md');

/**
 * A unified-diff patch as hunks, each line tagged with its index on the side it belongs
 * to — `new` for context and added lines, `old` for context and removed ones — both
 * relative to the hunk and absolute in the file (0-based).
 */
const hunksOf = (patch) => {
  const hunks = [];
  let h = null;
  for (const line of patch.split('\n')) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) { h = { oldStart: Number(at[1]) - 1, newStart: Number(at[2]) - 1, lines: [] }; hunks.push(h); continue; }
    const sign = line[0];
    if (sign !== ' ' && sign !== '+' && sign !== '-') continue; // `\ No newline at end of file`
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    // A patch with no header (hand-written fixtures) is one hunk starting at line 1.
    if (!h) { h = { oldStart: 0, newStart: 0, lines: [] }; hunks.push(h); }
    h.lines.push({ sign, text: line.slice(1) });
  }
  return hunks;
};

/**
 * The added and removed lines of one hunk, minus every ADDED line inside a code fence of
 * the head file. Without the head file (`newFileFenced` null) nothing is skipped.
 */
const unfencedChanges = (h, newFileFenced) => {
  const out = [];
  let j = 0;
  for (const l of h.lines) {
    if (l.sign === '-') { out.push(l); continue; }
    if (l.sign === '+' && !newFileFenced?.has(h.newStart + j)) out.push(l);
    j += 1;
  }
  return out;
};

/**
 * Ids a PR's spec patches claim. `files` is the pulls-files API shape
 * (`[{filename, patch, content?}]`); a file whose `patch` is missing (GitHub omits a
 * patch over its size limit) is reported rather than read as "no claims". `content`,
 * when given, is the file's full text on the PR head: it is what decides whether an
 * added line sits inside a code fence, including one opened ABOVE its hunk. Without it
 * no line is skipped (the pre-fence behaviour), because the hunk alone cannot tell.
 * @returns {{ids: string[], unreadable: string[]}}
 */
export const claimsIn = (files) => {
  const added = new Set();
  const removed = new Set();
  const unreadable = [];
  for (const f of files) {
    if (!isSpecDoc(f.filename)) continue;
    if (typeof f.patch !== 'string') { unreadable.push(f.filename); continue; }
    const newFileFenced = typeof f.content === 'string' ? fencedLines(f.content.split('\n')) : null;
    for (const h of hunksOf(f.patch)) {
      for (const { sign, text } of unfencedChanges(h, newFileFenced)) {
        const m = DECL.exec(text);
        if (!m?.[3]) continue;
        (sign === '+' ? added : removed).add(m[3]);
      }
    }
  }
  return { ids: [...added].filter((id) => !removed.has(id)).sort(), unreadable };
};

const numberOf = (id) => Number(id.slice(id.lastIndexOf('-') + 1));
const prefixOf = (id) => id.slice(0, id.lastIndexOf('-'));

/** The highest id each prefix has claimed across `prs` — what an allocator must start above. */
export const claimedFloor = (prs) => {
  const floor = {};
  for (const pr of prs) {
    for (const id of pr.ids) floor[prefixOf(id)] = Math.max(floor[prefixOf(id)] ?? 0, numberOf(id));
  }
  return floor;
};

/**
 * Every id `mine` claims that another open PR also claims, and who must move.
 * @param {{number: number|null, ids: string[]}} mine  `number` null for a branch with no PR yet
 * @param {{number: number, title?: string, ids: string[]}[]} others
 * @returns {{id: string, pr: number, title?: string, yields: boolean}[]}
 */
export const collisionsWith = (mine, others) => {
  const out = [];
  for (const other of others) {
    if (other.number === mine.number) continue;
    for (const id of mine.ids) {
      if (!other.ids.includes(id)) continue;
      // A branch without a PR has claimed nothing visible yet, so it is the one that
      // moves; otherwise the later-opened PR yields.
      out.push({ id, pr: other.number, title: other.title, yields: mine.number === null || mine.number > other.number });
    }
  }
  return out.sort((x, y) => x.id.localeCompare(y.id) || x.pr - y.pr);
};

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * A spec file's full text on the PR head, from its blob — or `undefined`, which
 * `claimsIn` reads hunk by hunk. A failed read degrades to that rather than failing
 * the check: the hunk-only read is what this did before fences were considered.
 */
const headContent = (f) => {
  if (!isSpecDoc(f.filename) || f.status === 'removed' || typeof f.patch !== 'string' || !f.sha) return undefined;
  // Only a patch that ADDS a declaration-shaped line can be changed by a fence, so only
  // those pay for the read (one `gh api` per such file per open PR).
  if (!f.patch.split('\n').some((l) => l[0] === '+' && !l.startsWith('+++') && DECL.test(l.slice(1)))) return undefined;
  try {
    return Buffer.from(gh(['api', `repos/{owner}/{repo}/git/blobs/${f.sha}`, '--jq', '.content']).replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
};

/** Every open PR's claims, via the `gh` CLI. Throws when `gh` cannot be run or answered. */
export const openPrClaims = () => {
  const prs = JSON.parse(gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName']));
  return prs.map((pr) => {
    const out = gh([
      'api', '--paginate', `repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`,
      '--jq', `.[] | select(.filename | startswith("${SPEC_DIR}/")) | {filename, patch, sha, status}`,
    ]);
    const files = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((f) => ({ ...f, content: headContent(f) }));
    return { number: pr.number, title: pr.title, headRefName: pr.headRefName, ...claimsIn(files) };
  });
};

const main = () => {
  const i = process.argv.indexOf('--pr');
  const prArg = i === -1 ? null : Number(process.argv[i + 1]);
  let branch = null;
  try { branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(); } catch { /* detached */ }

  let open;
  try {
    open = openPrClaims();
  } catch (e) {
    // In CI a failure to read is a broken check, not a clean one. Locally it is a
    // missing or unauthenticated `gh`, which must not block someone working offline.
    console[prArg ? 'error' : 'log'](`spec-id-claims: could not read open PRs — ${String(e.message).split('\n')[0]}`);
    if (prArg) process.exitCode = 1;
    return;
  }

  const mineRow = prArg !== null
    ? open.find((p) => p.number === prArg)
    : open.find((p) => p.headRefName === branch);
  // NOT FINDING ITSELF IS A BROKEN RUN. In CI the PR under test is open by definition,
  // so an empty or partial listing — a missing `pull-requests: read`, which makes the
  // listing come back EMPTY rather than erroring on this private repo — would otherwise
  // read as "no sibling claims anything" forever (RA-945).
  if (prArg !== null && !mineRow) {
    console.error(`spec-id-claims: PR #${prArg} is not in the open-PR listing (${open.length} read) — the check cannot see the PRs it compares against.`);
    process.exitCode = 1;
    return;
  }
  const mine = mineRow ?? { number: null, ids: [], unreadable: [] };
  if (!mineRow) {
    console.log(`spec-id-claims: branch \`${branch ?? '(detached)'}\` has no open PR — nothing it claims is visible to a sibling yet. Read ${open.length} open PR(s).`);
    return;
  }
  for (const p of open.filter((x) => x.unreadable.length)) {
    console.log(`::warning::spec-id-claims: PR #${p.number}'s patch for ${p.unreadable.join(', ')} is too large for the API to return, so its claims there are unread.`);
  }
  const hits = collisionsWith(mine, open);
  const fatal = hits.filter((h) => h.yields);
  for (const h of hits.filter((x) => !x.yields)) {
    console.log(`::warning::spec-id-claims: \`${h.id}\` is also claimed by PR #${h.pr} (${h.title}). That PR was opened later and is the one to renumber.`);
  }
  if (fatal.length) {
    console.error(`spec-id-claims: ${fatal.length} id(s) this PR adds are already claimed by an earlier open PR:\n`);
    for (const h of fatal) console.error(`  • \`${h.id}\` — claimed by PR #${h.pr} (${h.title})`);
    console.error(
      '\nRenumber them: strip the ids from the clauses this PR adds and re-run\n' +
        '`node scripts/spec-ids.mjs --apply`, which allocates above every open PR\'s claim.\n' +
        'Move every test title and `_locked-floor.json` entry that cites them in the same commit,\n' +
        'and every other reference this PR writes to them (docs, code comments). No `renumbered`\n' +
        'entry in `_id-registry.json` is needed: the number never reached `main` naming this\n' +
        'clause, so nothing outside this PR can have cited it (RA-2004).',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`spec-id-claims: PR #${mine.number} claims ${mine.ids.length} new id(s) (${mine.ids.join(', ') || 'none'}); ${open.length - 1} other open PR(s) read, no collision.`);
};

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
