#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-1384 — the coordinates a diff MOVED, derived from the diff rather than guessed from prose.
//
// WHAT `citation-guard` CANNOT SEE. It judges each `file:line` against the current tree
// alone, so a coordinate whose sentence names no identifier is range-checked only: it
// proves the line exists, which stays true however far the code slides. Measured on
// PR RA-811: three coordinates into `course-wizard.tsx`, correct on its base, pointed at a
// Back button and a `)}` on its head — one on a `[confirmed]` clause — with every gate
// green. On PR RA-873 the guard flagged 28 and ~144 had moved; 97 of the misses sat on
// doc lines the fix commit never touched, and they CLUSTERED on the same lines as the
// fixes, because a guard's output gets treated as the work list.
//
// SO THIS DOES NOT JUDGE PROSE AT ALL. For every source file the diff changes, it builds
// the old-line -> new-line map from the hunks (`git diff -U0`) and pushes each doc
// coordinate the diff LEFT AS IT WAS through that map. A coordinate that was `:297` on
// the base and still reads `:297`, while the map says line 297 is now line 256, is stale
// BY CONSTRUCTION — no identifier, no anchor, no heuristic. The fix is mechanical too:
// `--fix` rewrites exactly those coordinates to the mapped value.
//
// MEASURED BEFORE ADOPTING, replayed over merged history with `--head`: RA-873's merge
// commit carries 50 coordinates it moved and left — including every one its review
// found by hand (`[FILTER-2]`'s `storefront.ts:2193` -> `:2207`, `[KIOSK-29]`'s `:529`
// -> `:543`, `[PAY-1]`'s `kiosk.ts:561`, …). Over the 80 most recent non-release commits
// on `main`, 15 merged at least one such coordinate. That is the rot RA-1384 describes,
// and the size of the stream this will now stop at the PR.
//
// ARRIVED-STALE, stated precisely. A coordinate that was already wrong on the base is
// flagged ONLY if this diff moved the lines it names, and then only to say where those
// lines went — `--fix` keeps it pointing at the same (wrong) code, so the PR is never
// asked to judge someone else's drift, only not to add to it (RA-1992's second
// requirement). If this diff did not move the cited lines, it says nothing at all.
//
// WHAT IT DELIBERATELY DOES NOT FLAG, each for a reason:
//   • A coordinate the diff CHANGED. Its author re-derived it — or took one side of a
//     conflict, which this cannot tell from a deliberate correction (the rest of RA-1992).
//     `citation-guard` still judges it against the tree, as it judges every coordinate.
//   • A coordinate whose cited lines the diff EDITED rather than moved. There is no
//     mechanical answer — whether a rewritten line still says what the sentence claims
//     is a reading question — so these are LISTED as advisory, never fatal.
//   • `docs/projects/**`, as in `citation-guard`: a brief carries no coordinate (RA-1742).
//   • The QA tooling's own comments — the adopter's declared pipeline code (`## Pipeline
//     code` in `docs/qa/escalation-paths.md`, kanon#54) and every test that imports it
//     (`readsCodeComments`). The two verbatim quotations of `course-wizard.tsx:797-800`
//     in `tests/library/citation-guard.test.ts` and in `citation-guard.mjs`'s comments are a
//     GUARD's regression record, not a claim about the wizard, and must never be
//     retargeted (RA-1384's third criterion). They are outside the corpus by construction.
//   • Code and string literals. Only a COMMENT is a claim; `expect(err).toContain(
//     'services/payments.ts:4')` is a fixture (`commentCoordinates`).
//
// CODE COMMENTS ARE READ TOO (RA-2293), under `e2e/`, `tests/`, `src/` and `scripts/`, with
// or without backticks — RA-1384's own third example was one: `e2e/helpers.ts` says the
// wizard "bails at `course-wizard.tsx:180`". MEASURED BEFORE MAKING IT FATAL, replayed
// the way the doc corpus was, over the 80 most recent non-release commits on `main`
// (2026-09-24, `c97e6ee8` back): 46 code-comment coordinates moved and left behind, in
// 17 of the 80 commits (the doc corpus: 124, in 15). Every one read as a live pointer —
// `send-course-reminders.ts:318` from a `src/` docblock and three tests, left behind by
// three successive PRs because nothing said so; `e2e/helpers.ts`'s `course-wizard.tsx:180`
// among them. None was a quotation, so none was a false positive. Without the tooling
// exclusion the same replay flags 68: the extra 22 are 7 of the deliberate quotations
// above (`payments.ts:44-52`, `course-wizard.tsx:797-800`, `enrollment.ts:124-129`) and
// 15 live pointers in tooling comments (`merge-gate.mjs:506` in `permissions-guard.mjs`,
// `lead-reconcile.mjs:975` in `spec-coverage.mjs`; both were stale by 2026-09-24 and have
// since been fixed by hand, the first reworded without a line number, the second
// re-pointed). Those 15 are the price of a rule that
// reads a property of the file rather than a list of lines, and they are said here so
// the all-clear is not read as covering them. Two forms are not read in code: a bare
// `:NNN` continuation (a port or a time as often as a line), and every coordinate after
// the first in a comma list (`sst.config.ts:763, 810, 850`).
//
// A DOC LINE THE DIFF EDITED is paired with the lines its hunk removed: a coordinate on
// the new line that also appears, identically, on the removed side was carried through
// the rewrite unchanged, which is the RA-873 shape exactly — the sentence was touched, the
// neighbouring coordinate on it was not.
//
// BASE. In CI (`pull_request`) the checkout is GitHub's merge commit, so the base is its
// first parent and the diff is precisely what this PR does to the base it will merge
// into. Locally it is `merge-base origin/main HEAD`, compared against the WORKING TREE,
// so an author sees the verdict on uncommitted doc edits. `--base <rev>` overrides both.
//
// `--head <rev>` compares two commits instead of the working tree — how the history
// cases (RA-811, RA-873, RA-2208) are replayed.
//
// Usage: node scripts/citation-shift.mjs [--base <rev>] [--head <rev>] [--fix]

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PROJECTS_TREE, SOURCE_EXT, coordinatesIn, isOracleSpec, resolvePath } from './citation-guard.mjs';
import { QA_TOOLING_IMPORT } from './spec-lib.mjs';
import { DeclarationError, ESCALATION_FILE, parseEscalationFile, readEscalationFile } from './lib/escalation-paths.mjs';
import { TABLE_EXT, conventionFor } from './lib/test-conventions.mjs';

/**
 * @typedef {{os: number, oc: number, ns: number, nc: number, removed: string[], added: string[]}} Hunk
 * @typedef {{at: string, doc: string, line: number, index: number, citation: string, path: string,
 *            from: number[], to: number[], replacement: string, kind: 'doc'|'code'}} Moved
 * @typedef {{at: string, doc: string, line: number, citation: string, path: string, kind: 'doc'|'code'}} Edited
 */

/** Where a CODE COMMENT can carry a coordinate worth mapping (RA-2293). */
export const CODE_TREES = ['e2e/', 'tests/', 'src/', 'scripts/'];
// The languages of the per-language table (`scripts/lib/test-conventions.mjs`, kanon#20),
// whose comment syntax this file knows, plus `cjs`, which is JavaScript too.
const CODE_EXT = new RegExp(`\\.(?:${TABLE_EXT}|cjs)$`);

/**
 * Is this code file read for comment coordinates? Everything under `CODE_TREES` EXCEPT
 * the QA tooling's own source (the directories the adopter declares under `## Pipeline
 * code`, kanon#54) and its tests (a test that imports `scripts/qa/` or Kanon's library —
 * `QA_TOOLING_IMPORT`, the rule the spec-id sweeps use, which still names the reference
 * adopter's directory; #54 tracks it). Their comments
 * quote OLD coordinates on purpose — `course-wizard.tsx:797-800` in `citation-guard.mjs`
 * and its test, `payments.ts:44-52` — as the guard's regression record, and RA-1384's
 * third criterion forbids retargeting them. Both halves are properties of the file,
 * not a list of names (RA-1214), so the next guard qualifies the day it is written.
 */
export const readsCodeComments = (path, text, pipelineDirs) => {
  if (!Array.isArray(pipelineDirs)) throw new TypeError('readsCodeComments needs the declared pipeline-code directories');
  return CODE_TREES.some((t) => path.startsWith(t)) &&
  CODE_EXT.test(path) &&
  !pipelineDirs.some((d) => path.startsWith(d)) &&
  !(/^(tests|e2e)\//.test(path) && QA_TOOLING_IMPORT.test(text));
};

// A coordinate in a code comment is written with or without backticks — the corpus has
// both (`// checkout (storefront.ts:1155, RA-253)`) — so the path is matched on its own,
// bounded so it cannot start inside a longer token.
// The extensions are `citation-guard`'s, so a comment can point into any file a doc can.
const CODE_COORD = new RegExp(String.raw`(?<![\w./[\]@-])([\w./[\]-]+\.${SOURCE_EXT}):(\d+)(?:-(\d+))?(?![\w-])`, 'g');

/**
 * The coordinates in the COMMENT part of one line of code: a line that opens a comment
 * (`//`, `/*`, a `*` docblock continuation), or the tail after a `//` or `/*` that
 * follows code. Code and string literals are never read — `expect(out).toContain(
 * 'services/payments.ts:4')` is a fixture, not a claim.
 *
 * A bare `:NNN` continuation is NOT read here, unlike in docs: in code it is as often a
 * port or a time as a line.
 *
 * `syntax` is the file's comment syntax from the per-language table: `slash` for
 * JavaScript and Go, `hash` for Python's `# …` (kanon#20). A Python docstring is a string
 * literal, so a coordinate in one is not read, as one in a JavaScript string is not.
 *
 * @param {string} line
 * @param {'slash' | 'hash'} [syntax]
 */
export const commentCoordinates = (line, syntax = 'slash') => {
  let from = -1;
  if (syntax === 'hash') {
    const m = /(?:^|\s)#/.exec(line);
    if (m) from = m.index;
  } else if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) from = 0;
  else {
    const m = /(?:^|[\s{;,)])(\/\/|\/\*)/.exec(line);
    if (m) from = m.index;
  }
  if (from < 0) return [];
  const out = [];
  for (const m of line.slice(from).matchAll(CODE_COORD)) {
    const a = +m[2];
    if (a < 1) continue;
    out.push({ i: from + m.index, text: m[0], file: m[1], a, b: +(m[3] ?? m[2]), bare: false });
  }
  return out;
};

/**
 * Parse `git diff -U0 --no-renames` output into per-file hunks.
 * @returns {Map<string, Hunk[]>}
 */
export const parseDiff = (text) => {
  const files = new Map();
  let hunks = null;
  let h = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { hunks = null; h = null; continue; }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4);
      if (path === '/dev/null') { hunks = null; continue; }
      hunks = [];
      files.set(path.replace(/^b\//, ''), hunks);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && hunks) {
      h = { os: +m[1], oc: m[2] === undefined ? 1 : +m[2], ns: +m[3], nc: m[4] === undefined ? 1 : +m[4], removed: [], added: [] };
      hunks.push(h);
      continue;
    }
    if (!h) continue;
    if (line.startsWith('-')) h.removed.push(line.slice(1));
    else if (line.startsWith('+')) h.added.push(line.slice(1));
  }
  return files;
};

/**
 * Old line -> new line, or `null` when the diff removed or rewrote that line.
 *
 * Git's `-U0` convention: a hunk with `oc > 0` replaces old lines `os..os+oc-1`; a pure
 * insertion (`oc === 0`) goes AFTER old line `os`. Every hunk wholly above a line moves
 * it by `nc - oc`.
 */
export const lineMapper = (hunks) => (n) => {
  let delta = 0;
  for (const h of hunks) {
    if (h.oc === 0) {
      if (n <= h.os) return n + delta;
    } else {
      if (n < h.os) return n + delta;
      if (n < h.os + h.oc) return null;
    }
    delta += h.nc - h.oc;
  }
  return n + delta;
};

/** Rewrite the line number(s) at the end of a coordinate's text. */
export const retarget = (text, a, b) =>
  text.replace(/(\d+)(?:-(\d+))?(`?)$/, (_, _a, _b, tick) => `${a === b ? a : `${a}-${b}`}${tick}`);

/**
 * The verdicts, from data alone — exported so the unit tier drives it over fixtures.
 *
 * @param {object} p
 * @param {string[]} p.docs            doc paths to read (head side)
 * @param {(path: string) => string} p.readHead
 * @param {string[]} p.trackedHead
 * @param {string[]} p.trackedBase
 * @param {Map<string, Hunk[]>} p.diff
 * @param {string[]} [p.code]          code files whose COMMENTS are read too (RA-2293)
 * @returns {{moved: Moved[], edited: Edited[], pointing: number, pointingCode: number, ambiguous: number, unmapped: number, changedSources: number}}
 */
export const shiftedCoordinates = ({ docs, readHead, trackedHead, trackedBase, diff, code = [] }) => {
  const changed = new Set([...diff.keys()].filter((f) => !f.endsWith('.md')));
  const mappers = new Map([...changed].map((f) => [f, lineMapper(diff.get(f))]));
  /** @type {Moved[]} */
  const moved = [];
  /** @type {Edited[]} */
  const edited = [];
  let pointing = 0;
  let pointingCode = 0;
  // A bare basename matching several files cannot be mapped without an anchor to pick
  // one, so it is skipped — and COUNTED, so the all-clear does not overstate its reach.
  let ambiguous = 0;
  // A coordinate whose file did not exist at the SAME PATH on the base has no old->new
  // map to apply (RA-2294 review). `--no-renames` shows a moved file as a delete plus a
  // whole-file add, `@@ -0,0 +1,N @@`, whose mapper sends every line n to n+N — so a
  // basename coordinate into a moved file was flagged fatal and `--fix` wrote a line
  // past EOF. Skipped, never flagged (citation-guard still judges it), and COUNTED.
  let unmapped = 0;
  const baseSet = new Set(trackedBase);

  const resolved = (c, tracked, count = false) => {
    // A dependency coordinate (`isExternal`) is untracked, so it resolves to nothing here.
    if (!c.file) return null;
    const r = resolvePath(c.file, tracked, null);
    if (r.error && count && r.error.startsWith('ambiguous') && tracked.some((f) => changed.has(f) && f.endsWith(`/${c.file}`))) ambiguous += 1;
    return r.error ? null : r.path;
  };

  for (const doc of [...docs, ...code]) {
    const kind = doc.endsWith('.md') ? 'doc' : 'code';
    const oracle = isOracleSpec(doc);
    // A full citation naming line 0 is a typo `citation-guard` reports, not a coordinate:
    // mapping it would "move" `:0-5` to `:0-7` and `--fix` would write the new typo (RA-1221).
    const extract = kind === 'doc'
      ? (l) => coordinatesIn(l, oracle).filter((c) => !c.lineZero)
      : (l) => commentCoordinates(l, conventionFor(doc)?.comment ?? 'slash');
    const lines = readHead(doc).split('\n');
    const docHunks = diff.get(doc) ?? [];
    // For each head line: the base-side coordinates it may have carried through unchanged.
    // An untouched line carried all of its own; a line inside a hunk may have carried any
    // coordinate on that hunk's removed lines.
    const hunkOf = (n) => docHunks.find((h) => h.nc > 0 && n >= h.ns && n < h.ns + h.nc);
    //
    // PAIRED LINE BY LINE when the hunk removed exactly as many lines as it added — the
    // shape of an in-place edit, where line k replaced line k. Pooling the whole hunk
    // there paired a coordinate with a DIFFERENT line's removed twin: re-pointing `:2711`
    // to `:2725` on one table row, while the next row's `:2725` moved on, read as `:2725`
    // "carried through" and was flagged as stale (RA-2353's batch). An uneven hunk has no
    // such correspondence, so it keeps the pool.
    const removedPool = new Map();
    const coordsOf = (ls) => ls.flatMap((l) => extract(l).map((c) => `${resolved(c, trackedBase)}:${c.a}-${c.b}`));
    const poolFor = (h, n) => {
      const paired = h.removed.length === h.nc;
      const key = paired ? `${h.ns}:${n}` : h;
      if (!removedPool.has(key)) removedPool.set(key, coordsOf(paired ? [h.removed[n - h.ns]] : h.removed));
      return removedPool.get(key);
    };

    lines.forEach((line, i) => {
      const n = i + 1;
      const h = hunkOf(n);
      for (const c of extract(line)) {
        const path = resolved(c, trackedHead, true);
        if (!path || !changed.has(path)) continue;
        pointing += 1;
        if (kind === 'code') pointingCode += 1;
        if (!baseSet.has(path) || resolved(c, trackedBase) !== path) { unmapped += 1; continue; }
        if (h) {
          const pool = poolFor(h, n);
          const k = pool.indexOf(`${resolved(c, trackedBase) ?? path}:${c.a}-${c.b}`);
          if (k === -1) continue; // written or rewritten by this diff — not ours to judge
          pool.splice(k, 1);
        }
        const map = mappers.get(path);
        const a2 = map(c.a);
        const b2 = map(c.b);
        const at = `${doc}:${n}`;
        if (a2 === null || b2 === null) {
          edited.push({ at, doc, line: n, citation: c.text, path, kind });
        } else if (a2 !== c.a || b2 !== c.b) {
          moved.push({ at, doc, line: n, index: c.i, citation: c.text, path, from: [c.a, c.b], to: [a2, b2], replacement: retarget(c.text, a2, b2), kind });
        }
      }
    });
  }
  return { moved, edited, pointing, pointingCode, ambiguous, unmapped, changedSources: changed.size };
};

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (args) => { try { return git(args).trim(); } catch { return null; } };

const resolveBase = () => {
  const i = process.argv.indexOf('--base');
  if (i !== -1) return { base: process.argv[i + 1], how: '--base' };
  // A merge commit is GitHub's `pull_request` checkout: its first parent is the base.
  // Read from the RAW commit object, not `rev-list --parents`: in a shallow clone the
  // boundary commit's parents are grafted away, so `rev-list` reports none and a merge
  // commit would read as an ordinary one.
  const parents = [...(tryGit(['cat-file', '-p', 'HEAD']) ?? '').matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]);
  if (parents.length === 2) {
    if (!tryGit(['rev-parse', '--verify', '--quiet', `${parents[0]}^{commit}`])) {
      tryGit(['fetch', '--quiet', '--no-tags', '--depth=2', 'origin', tryGit(['rev-parse', 'HEAD'])]);
    }
    return { base: parents[0], how: 'the merge commit\'s first parent' };
  }
  const mb = tryGit(['merge-base', 'origin/main', 'HEAD']);
  return mb ? { base: mb, how: 'merge-base with origin/main' } : { base: null, how: 'no origin/main to diff against' };
};

const main = () => {
  const FIX = process.argv.includes('--fix');
  const { base, how } = resolveBase();
  if (!base || !tryGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) {
    // Reported, not fatal — the same rule `locked-merge-check.mjs` states for a base it
    // cannot fetch: a guard that fails closed on what it cannot judge blocks every PR.
    // In CI the skip is an ANNOTATION, not only a log line: a check that quietly stops
    // running reads as a green one, which is the RA-945 shape this file exists to answer.
    const lead = process.env.GITHUB_ACTIONS ? '::warning::' : '';
    console.log(`${lead}citation-shift: skipped — no base commit to diff against (${how}).`);
    return;
  }
  const hi = process.argv.indexOf('--head');
  const head = hi === -1 ? null : process.argv[hi + 1];
  if (head && FIX) {
    console.error('citation-shift: --fix rewrites the working tree, so it cannot be combined with --head.');
    process.exitCode = 1;
    return;
  }
  // THE ADOPTER'S PIPELINE CODE (kanon#54), whose comments are a guard's regression record.
  // Read from the tree being checked, and a missing or malformed declaration stops the run
  // by name rather than reading every pipeline comment as a claim.
  let pipelineDirs;
  try {
    const declared = head
      ? (() => {
          const text = tryGit(['show', `${head}:${ESCALATION_FILE}`]);
          if (text === null) throw new DeclarationError(`${ESCALATION_FILE} doesn't exist at \`${head}\` (K-LAYOUT-8)`);
          return parseEscalationFile(text);
        })()
      : readEscalationFile();
    pipelineDirs = declared.pipeline.map(({ dir }) => dir);
  } catch (e) {
    console.error(`citation-shift: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const diff = parseDiff(git(['diff', '-U0', '--no-renames', '--no-color', base, ...(head ? [head] : [])]));
  const trackedHead = (head ? git(['ls-tree', '-r', '-z', '--name-only', head]) : git(['ls-files', '-z'])).split('\0').filter(Boolean);
  const trackedBase = git(['ls-tree', '-r', '-z', '--name-only', base]).split('\0').filter(Boolean);
  const docs = trackedHead.filter((f) => f.startsWith('docs/') && f.endsWith('.md') && !f.startsWith(PROJECTS_TREE));
  const readHead = head ? (p) => git(['show', `${head}:${p}`]) : (p) => readFileSync(p, 'utf8');
  // Code files are read only when they contain something coordinate-shaped at all — a
  // `git grep` prefilter, so the replay (`--head`) does not `git show` every source file.
  const grep = tryGit(['grep', '-l', '-E', `\\.${SOURCE_EXT.replace('(?:', '(')}:[0-9]`, ...(head ? [head] : []), '--', ...CODE_TREES]) ?? '';
  const code = grep.split('\n').filter(Boolean).map((l) => (head ? l.slice(head.length + 1) : l))
    .filter((f) => readsCodeComments(f, readHead(f), pipelineDirs));
  const r = shiftedCoordinates({ docs, code, readHead, trackedHead, trackedBase, diff });

  if (FIX && r.moved.length) {
    const byDoc = new Map();
    for (const m of r.moved) byDoc.set(m.doc, [...(byDoc.get(m.doc) ?? []), m]);
    for (const [doc, ms] of byDoc) {
      const lines = readFileSync(doc, 'utf8').split('\n');
      // Right to left within a line, so an earlier rewrite cannot shift a later index.
      for (const m of ms.sort((x, y) => y.line - x.line || y.index - x.index)) {
        const l = lines[m.line - 1];
        lines[m.line - 1] = l.slice(0, m.index) + m.replacement + l.slice(m.index + m.citation.length);
      }
      writeFileSync(doc, lines.join('\n'));
    }
    console.log(`citation-shift: re-pointed ${r.moved.length} coordinate(s) this diff moved. Review the doc diff, then re-run.`);
    return;
  }

  if (r.edited.length) {
    console.log(`citation-shift: ${r.edited.length} coordinate(s) cite lines this diff EDITED — not a failure, but re-read each against the new code:`);
    for (const e of r.edited) console.log(`  ${e.at}  ${e.citation} -> ${e.path}`);
  }
  if (r.moved.length) {
    console.error(`citation-shift: ${r.moved.length} coordinate(s) point at lines this diff MOVED, and were left as they were:\n`);
    for (const m of r.moved) console.error(`  ${m.at}  ${m.citation}  ->  ${m.replacement}`);
    console.error(
      '\nEach target is derived from the diff, not guessed: the line the coordinate named is\n' +
        'now at the new number. Run `node scripts/citation-shift.mjs --fix` to rewrite them\n' +
        '(it touches only these), or re-point them by hand. If one of them was already wrong\n' +
        'before this diff, re-derive it from the code instead — moving it keeps it wrong.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `citation-shift: ${r.changedSources} changed source file(s), ${r.pointing - r.pointingCode} doc coordinate(s) and ` +
      `${r.pointingCode} code-comment coordinate(s) into them (${code.length} code file(s) read); ` +
      `none left behind by a move (base: ${how})` +
      `${r.ambiguous ? `; ${r.ambiguous} bare basename(s) matching a changed file were ambiguous and not mapped` : ''}` +
      `${r.unmapped ? `; ${r.unmapped} into a file that is new or moved at that path, so there is no line map to apply` : ''}.`,
  );
};

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
