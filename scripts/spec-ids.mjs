#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-913 — allocate stable IDs to L2 spec invariants.
//
// Both the one-time backfill and the incremental allocator: an invariant that
// already carries an ID keeps it, one that does not gets the next number for its
// area. So re-running after adding invariants is the normal way to number them.
//
// IDs ARE PERMANENT CITATIONS. Issues cite them as acceptance criteria, tests
// declare which one they lock, and the coverage report joins the two. That only
// works if `STORE-14` means the same thing next year, so:
//   • numbers are never reused — the registry holds a per-area high-water mark, not
//     max(current), and deleting the last invariant in a file does not free its
//     number for the next one;
//   • an ID is never renumbered to tidy a gap. Gaps are the visible evidence that
//     something was retired, which is information, not mess;
//   • the ID is orthogonal to the promotion status beside it. A [seed] -> [confirmed]
//     promotion changes maturity and never identity.
//   • when two clauses DO end up sharing an id on `main` (a collision the step below
//     could not see) and one must move, the move is recorded in the registry's
//     `renumbered` map — `{"<OLD-ID>": {"to": "<NEW-ID>", "by": <PR>}}` — by whoever
//     resolves it, in the same change. The old number still resolves, to the clause
//     that kept it, so a reference written against the old numbering is wrong in a way
//     only that trail can surface (`spec-id-renumbered.mjs`, RA-2004).
//
// ALLOCATES ABOVE EVERY OPEN PR'S CLAIM, not only above the committed mark (RA-2071).
// The registry is `main` as of when this branch was cut, so two branches cut from the
// same `main` would each take the same next number and merge cleanly into a duplicate —
// `[STORE-102]` on `main` (RA-2005/RA-2006/RA-2012) and PR RA-2056's two renumbers. So the
// allocator reads every open PR's claims (`spec-id-claims.mjs`) through `gh` and starts
// above the highest. The gap this leaves on `main` when the sibling merges later is
// legal by design (see above). `gh` missing or unauthenticated is SAID, not fatal: an
// offline allocation is still correct against `main`, it just cannot see siblings — and
// CI's `spec-id-claims` step is the backstop for that case. `--offline` skips the read.
//
// SAFE BY DEFAULT: a bare run is a dry run, matching the other scripts/ tools.
// Usage: node scripts/spec-ids.mjs [--apply] [--offline]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimedFloor, openPrClaims } from './spec-id-claims.mjs';
import { DECL, REGISTRY, RENUMBERED, SPEC_DIR, loadPrefixes, loadRegistry, loadRenumbered, parseAll, parseSpec, specFiles } from './spec-lib.mjs';

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
const OFFLINE = process.argv.includes('--offline');

/** Open PRs other than this branch's own, with their claims — or null when unreadable. */
function siblings() {
  if (OFFLINE) return { prs: null, why: '--offline' };
  let branch = null;
  try { branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(); } catch { /* detached */ }
  try {
    return { prs: openPrClaims().filter((p) => p.headRefName !== branch) };
  } catch (e) {
    return { prs: null, why: String(e.message).split('\n')[0] };
  }
}

/**
 * The allocation itself, with no I/O beyond reading `dir` — exported so the unit tier
 * can drive it over a fixture with a sibling floor, rather than only through a CLI
 * that reads the real specs and the network.
 *
 * @param {{dir?: string, registry: Record<string, number>, floor?: Record<string, number>}} opts
 *   `registry` is what `_id-registry.json` says; `floor` is the highest id each prefix
 *   has been claimed at by an open sibling PR (`claimedFloor`).
 * @returns {{assigned: {id: string, file: string, line: number}[], after: Record<string, number>,
 *            behind: Record<string, number>, writes: {path: string, text: string}[]}}
 */
export function allocate({ dir = SPEC_DIR, registry, floor = {} }) {
  const after = { ...registry };
  const behind = {};
  const assigned = [];
  const writes = [];

  const prefixes = loadPrefixes(dir);
  for (const file of specFiles(dir)) {
    const prefix = prefixes[file];
    const invariants = parseSpec(file, dir).filter((i) => !i.legend);
    // Start above the high-water mark AND above anything already in the file, so a
    // registry that has fallen behind the specs can never mint a duplicate.
    const inFile = invariants
      .filter((i) => i.id?.startsWith(`${prefix}-`))
      .map((i) => Number(i.id.slice(prefix.length + 1)));
    const highestInFile = Math.max(0, ...inFile);
    if (highestInFile > (registry[prefix] ?? 0)) behind[prefix] = highestInFile;
    // …and above every number an open sibling PR has already claimed (RA-2071).
    let next = Math.max(registry[prefix] ?? 0, highestInFile, floor[prefix] ?? 0) + 1;

    const path = join(dir, file);
    const lines = readFileSync(path, 'utf8').split('\n');
    let touched = false;

    for (const inv of invariants) {
      if (inv.id) continue;
      const id = `${prefix}-${next++}`;
      const m = DECL.exec(lines[inv.line - 1]);
      // Insert the ID immediately before the status tag, preserving indentation and
      // any list marker exactly as found.
      lines[inv.line - 1] =
        `${m[1]}${m[2] ?? ''}\`[${id}]\` ` + lines[inv.line - 1].slice((m[1] + (m[2] ?? '')).length);
      assigned.push({ id, file, line: inv.line });
      touched = true;
    }

    // The mark advances to what this run actually minted, or to an id the file already
    // carries (a lagging registry). Stepping over a sibling's claim is recorded through
    // the ids it mints — never by reserving the sibling's numbers when nothing was minted.
    after[prefix] = touched ? next - 1 : Math.max(registry[prefix] ?? 0, highestInFile);
    if (touched) writes.push({ path, text: lines.join('\n') });
  }
  return { assigned, after, behind, writes };
}

/**
 * The registry lines, stated so a LAGGING registry cannot read as a clean one (RA-1355).
 *
 * TWO DIFFERENT DELTAS, and the dry run used to print neither — only the post-`--apply`
 * object, so a registry that had fallen BEHIND the specs printed the mark it would write,
 * byte-identical to a clean tree's output, and read as "in sync" to the one person asking
 * exactly that question (PR RA-908, whose push then went red on `spec-guard`):
 *   • BEHIND — an id already in the specs is above the mark on disk. `spec-guard` is red
 *     on this tree until the registry is written, whatever this run mints.
 *   • ADVANCE — the mark moves because this run mints ids. Normal allocation.
 */
export function report(onDisk, { after, behind }, applied) {
  const lines = [];
  const lag = Object.keys(behind).sort();
  if (lag.length) {
    const d = lag.map((k) => `${k}: ${onDisk[k] ?? '(none)'} on disk, ${behind[k]} in the specs`).join(', ');
    lines.push(
      applied
        ? `high-water marks were BEHIND the specs (${d}) — written now.`
        : `high-water marks on disk are BEHIND the specs — ${d}. \`spec-guard\` fails until --apply writes them.`,
    );
  }
  const moved = Object.keys(after).filter((k) => onDisk[k] !== after[k] && !lag.includes(k)).sort();
  if (moved.length) {
    const d = moved.map((k) => `${k}: ${onDisk[k] ?? '(none)'} -> ${after[k]}`).join(', ');
    lines.push(applied ? `high-water marks advanced: ${d}` : `--apply would advance: ${d}`);
  }
  lines.push(`high-water marks on disk${lag.length || moved.length ? (applied ? ' (before this run)' : '') : ', in sync'}: ${JSON.stringify(onDisk)}`);
  return lines.join('\n');
}

function run() {
  const onDisk = loadRegistry();
  const { prs, why } = siblings();
  const floor = prs ? claimedFloor(prs) : {};
  const result = allocate({ registry: onDisk, floor });

  if (APPLY) {
    for (const w of result.writes) writeFileSync(w.path, w.text);
    // The renumber trail rides in the same file (RA-2004) and is never the allocator's to
    // change: `loadRegistry` hands over the marks only, so it is written back verbatim.
    const trail = loadRenumbered();
    const out = Object.keys(trail).length ? { ...result.after, [RENUMBERED]: trail } : result.after;
    writeFileSync(REGISTRY, `${JSON.stringify(out, null, 2)}\n`);
  }

  const byFile = result.assigned.reduce((a, x) => ((a[x.file] = (a[x.file] || 0) + 1), a), {});
  for (const [f, n] of Object.entries(byFile)) console.log(`  ${String(n).padStart(3)}  ${f}`);
  console.log(`\n${result.assigned.length} ID(s) ${APPLY ? 'assigned' : 'would be assigned'}: ${result.assigned.map((a) => a.id).join(', ') || 'none'}.`);
  console.log(report(onDisk, result, APPLY));

  if (prs) {
    // An id this tree already carries that a sibling also claims — the collision the
    // allocator cannot undo, because the id was minted before the sibling was visible.
    const mine = new Set(parseAll().map((i) => i.id).filter(Boolean));
    const contested = prs.flatMap((p) => p.ids.filter((id) => mine.has(id)).map((id) => `\`${id}\` (also PR #${p.number})`));
    const stepped = Object.entries(floor).map(([k, v]) => `${k}: ${v}`).join(', ');
    console.log(`open PRs read: ${prs.length}${stepped ? `; allocation starts above their claims (${stepped})` : ', none claims an id'}.`);
    if (contested.length) {
      console.log(
        `\n⚠ this tree carries id(s) an open PR also claims: ${contested.join(', ')}. Renumber: strip them and re-run with --apply.` +
          `\n  If an id you move off has already been on \`main\`, record the move in _id-registry.json's \`${RENUMBERED}\` map` +
          ` ({"<OLD-ID>": {"to": "<NEW-ID>", "by": <this PR>}}) so every reference to the old number is re-read once (RA-2004).`,
      );
    }
  } else {
    console.log(`open PRs NOT read (${why}) — allocation is against \`main\`'s mark only, and a sibling PR may hold the same number.`);
  }
  if (!APPLY) console.log('\nDry run. Pass --apply to write.');
}

// Importing for `allocate`/`report` (the unit tier does) must not allocate.
if (process.argv[1] && process.argv[1].endsWith('spec-ids.mjs')) run();
