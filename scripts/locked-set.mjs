// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/** THE LOCKED SET — which invariants a test currently names by ID.
 *
 *  WHY A FILE, AND WHY THIS FILE. The ratchet needs a committed record of what was
 *  locked last time, or it cannot tell "a citation was deleted" from "there were
 *  never that many". That record used to be `LOCKED_FLOOR`, a single integer in
 *  `scripts/spec-coverage.mjs`. Moving it here fixes two separate defects:
 *
 *  RA-1398 — the reference adopter's escalation paths matched `^scripts/qa/`, so EVERY
 *  lock-adding PR tripped `escalating-path` and the Merger declined it. On RA-888 the lock
 *  was reverted to get the PR merged, and the Locked ladder moved by zero. `docs/qa/
 *  specs/**` is deliberately outside the escalation paths — the specs are the pilot's
 *  deliverable — so a lock PR now edits only its spec, its test and this file, and
 *  never touches the QA pipeline. The *meaning* stays in `spec-coverage.mjs`: a PR
 *  editing that script for any other reason still escalates, which is the property
 *  RA-1398 asks for ("the exemption must be about the value, not the file").
 *
 *  RA-1830 — a single scalar per line means any two concurrent spec PRs conflict
 *  TEXTUALLY even when their work does not overlap at all. Measured: a batch of six
 *  agent PRs, six of six touching the floor; merging one flipped four of the
 *  remaining five to CONFLICTING in the same minute, and a conflicting PR fires no
 *  `pull_request` events, so each went CI- and review-silent until a human rebased
 *  it. A sorted list of IDs does not have that property: two PRs locking different
 *  invariants add different lines and git merges them.
 *
 *  WHY IDS RATHER THAN A COUNT — the part that is an improvement, not just a move.
 *  A count says "you are two off" and cannot say which two; on 2026-09-13 that cost
 *  a `git log -S` bisect across three PRs to attribute a delta of 2 (the incident
 *  log in `spec-coverage.mjs` records it). A set says `[STORE-21] lost its citation`
 *  and names the file to look in. It is also STRICTLY stronger: swapping one lock
 *  for another leaves the count unchanged and is invisible to a floor, while the set
 *  reports both halves. Four scanner defects (RA-1247/RA-1249/RA-1250/RA-1253) went
 *  undetected behind exactly that simultaneous add-and-lose.
 *
 *  This file is generated. `node scripts/spec-coverage.mjs --write-locked` rewrites
 *  it from the tree; the diff is what you acknowledge in review. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_DIR } from './spec-lib.mjs';

export const LOCKED_SET = join(SPEC_DIR, '_locked-floor.json');

/** Prefix first, then NUMERIC — so `PAY-2` sorts before `PAY-10` and an area's ids
 *  stay contiguous. Lexicographic order would scatter them, which both reads badly
 *  and puts unrelated areas on adjacent lines, re-creating the conflicts RA-1830 is
 *  about. Stable: the same set always serialises identically, so a regenerated file
 *  diffs only where the set actually changed. */
export const byId = (a, b) => {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
};

/** A locked set that can't be read: missing or malformed, said plainly, with what to do (kanon#1644). */
export class LockedSetError extends Error {}

/** The command that writes the locked set from the tree, as a lane's PATH names it. */
const WRITE = '`kanon-spec-coverage --write-locked` (`node "$KANON/scripts/spec-coverage.mjs" --write-locked` from a step)';

/** THE BASELINE, READ STRICTLY (kanon#1644). A missing file is NOT an empty set: the floor is
 *  a reviewed record, and if its absence read as `[]`, deleting it beside a test title would hide
 *  the lost citation the ratchet exists to catch. So a missing or malformed file stops the caller
 *  with a `LockedSetError` that names the file and how to make it; `kanon init` writes the empty
 *  floor beside the Lead's brief template, and `--write-locked` never reads it. */
export const readLockedSet = (path = LOCKED_SET) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') throw new LockedSetError(`${path} is missing. Create it with ${WRITE} and commit it: the file records which invariants are locked, the baseline the ratchet compares against.`);
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.locked) || !doc.locked.every((x) => typeof x === 'string')) {
    throw new LockedSetError(`${path} is not the locked set, a JSON object whose one key, "locked", lists invariant ids (K-LAYOUT-4). Restore it from git, or write it again with ${WRITE} and review the diff before you commit it.`);
  }
  return doc.locked;
};

export const serialiseLockedSet = (ids) =>
  JSON.stringify({ locked: [...ids].sort(byId) }, null, 2) + '\n';
