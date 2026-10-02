#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-2004 — a reference to a RENUMBERED spec id must be looked at once.
//
// THE FAILURE, which no other guard can see. RA-2003 moved RA-1891's send-refusal clause
// from `[STORE-102]` to `[STORE-103]` (two concurrent PRs had allocated the same id),
// swept the specs and two test citations, and missed `docs/fe-gap-analysis.md:214`.
// RA-2013 then wrote a NEW `[STORE-102]` into an `e2e/` docblock against the numbering it
// had seen mid-flight. Both references still resolved — `[STORE-102]` is RA-1854's
// reminder-transfer clause — so `spec-guard` (declarations), the existence sweep in
// `tests/library/spec-ids.test.ts` (does the id exist?) and `citation-guard` (file:line
// coordinates) were all green, and a reader following either landed on the wrong
// invariant.
//
// WHY NOT DETECT IT AFTER THE FACT. Anchoring a reference to its clause by a shared
// issue number was measured on RA-2294 before being rejected: of 177 references whose
// line and clause both carry a `#N`, 51 share none, nearly all correct. So the RENUMBER
// leaves a trail instead — `_id-registry.json`'s `renumbered` map, written by whoever
// resolves the collision (`loadRenumbered` in `spec-lib.mjs`) — and this lists every
// reference to a moved-off id in the reference corpus (`referenceCorpus`: `src/`, `e2e/`,
// `tests/`, non-spec `docs/`, minus the id tooling's own tests), failing until each has
// been acknowledged ONCE:
//
//   • it meant the clause that MOVED — rewrite it to the new id, and it leaves the list;
//   • it means the clause that HOLDS the old number now — say so with a marker,
//     `renumber-checked: <OLD-ID>`, written once anywhere in that FILE (a `//` comment,
//     or `<!-- … -->` in markdown).
//
// WHY THE MARKER IS PER FILE, NOT PER REFERENCE — the "least noisy" choice RA-2004 asked
// for, measured on the tree this landed on. The only key, `STORE-102`, has 8 references
// outside the specs, all correct and all TEST TITLES (RA-1854's tests in three files).
// A per-reference marker costs 8 trailing comments today and one more on every test
// ever written for that clause — a permanent tax on citing a renumbered id, which is
// the kind of friction that teaches people to stop citing. Per file it costs 3 lines,
// once. What it gives up, stated rather than implied (RA-945): a stale reference added
// LATER to a file already acknowledged for that id is not re-listed. Both instances
// that motivated this were in files with no correct reference to the id at all — a doc
// that had quoted the moved clause and a brand-new e2e spec — so both are caught.
//
// A MARKER MUST STILL BE TRUE. One naming an id the trail does not hold, or sitting in
// a file with no reference to that id, fails too: a leftover marker is a pre-signed
// acknowledgement for whatever that file cites next.
//
// Exit 1 on any finding. Usage: node scripts/spec-id-renumbered.mjs

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { idPattern, loadPrefixes, loadRenumbered, parseAll, referenceCorpus } from './spec-lib.mjs';

export const MARKER = /renumber-checked:\s*([A-Z]+-\d+)/g;

/**
 * Problems with the trail itself. A malformed entry would silently acknowledge nothing
 * (a key no reference can match) or send a reader to a clause that does not exist.
 *
 * @param {Record<string, {to: string, by: number}>} renumbered
 * @param {Set<string>} known ids the specs declare
 */
export const trailProblems = (renumbered, known) => {
  const shape = new RegExp(`^(${Object.values(loadPrefixes()).join('|')})-\\d+$`);
  const out = [];
  for (const [from, entry] of Object.entries(renumbered)) {
    if (!shape.test(from)) out.push(`\`${from}\` is not an id with a registered area prefix.`);
    if (!entry || typeof entry !== 'object') { out.push(`\`${from}\` needs \`{"to": "<ID>", "by": <PR>}\`.`); continue; }
    if (!known.has(entry.to)) out.push(`\`${from}\` -> \`${entry.to}\`: no spec clause declares \`${entry.to}\`.`);
    if (entry.to === from) out.push(`\`${from}\` is renumbered to itself.`);
    if (!Number.isInteger(entry.by) || entry.by < 1) out.push(`\`${from}\`: \`by\` must be the number of the PR that renumbered it.`);
  }
  return out;
};

/**
 * The verdicts, from data alone — exported so the unit tier drives it over fixtures.
 *
 * @param {Record<string, {to: string, by: number}>} renumbered
 * @param {{path: string, text: string}[]} files
 */
export const renumberFindings = (renumbered, files) => {
  const keys = new Set(Object.keys(renumbered));
  const unacknowledged = [];
  const markers = [];
  let references = 0;
  const citing = new Set();
  for (const { path, text } of files) {
    const lines = text.split('\n');
    const refs = [];
    const marked = new Map();
    lines.forEach((l, i) => {
      for (const m of l.matchAll(idPattern())) {
        const id = `${m[1]}-${m[2]}`;
        if (keys.has(id)) refs.push({ id, line: i + 1 });
      }
      for (const m of l.matchAll(MARKER)) if (!marked.has(m[1])) marked.set(m[1], i + 1);
    });
    references += refs.length;
    if (refs.length) citing.add(path);
    for (const r of refs) {
      if (!marked.has(r.id)) unacknowledged.push({ path, ...r, ...renumbered[r.id] });
    }
    for (const [id, line] of marked) {
      if (!keys.has(id)) markers.push({ path, line, id, why: `\`${id}\` is not in the \`renumbered\` trail` });
      else if (!refs.some((r) => r.id === id)) markers.push({ path, line, id, why: `this file no longer cites \`[${id}]\`` });
    }
  }
  return { unacknowledged, markers, references, citing: citing.size };
};

const main = () => {
  const renumbered = loadRenumbered();
  const known = new Set(parseAll().map((i) => i.id).filter(Boolean));
  const corpus = referenceCorpus();
  const trail = trailProblems(renumbered, known);
  const r = renumberFindings(renumbered, corpus.map((path) => ({ path, text: readFileSync(path, 'utf8') })));

  if (trail.length) {
    console.error('spec-id-renumbered: the `renumbered` map in docs/qa/specs/_id-registry.json is malformed:\n');
    for (const t of trail) console.error(`  • ${t}`);
    console.error('');
  }
  if (r.unacknowledged.length) {
    console.error(`spec-id-renumbered: ${r.unacknowledged.length} reference(s) to a renumbered id, not yet checked against the renumber:\n`);
    for (const u of r.unacknowledged) {
      console.error(`  ${u.path}:${u.line}  [${u.id}]  — moved to [${u.to}] by #${u.by}; [${u.id}] now names a different clause`);
    }
    console.error(
      '\nFor each: if it means the clause that MOVED, rewrite it to the new id. If it means the\n' +
        'clause that holds the old number NOW, write `renumber-checked: <OLD-ID>` once anywhere in\n' +
        'that file (a `//` comment, or `<!-- renumber-checked: <OLD-ID> -->` in markdown). Read the\n' +
        'clause before choosing — both ids resolve, which is why nothing else can tell.\n',
    );
  }
  if (r.markers.length) {
    console.error(`spec-id-renumbered: ${r.markers.length} marker(s) acknowledging nothing — delete them:\n`);
    for (const m of r.markers) console.error(`  ${m.path}:${m.line}  renumber-checked: ${m.id}  — ${m.why}`);
    console.error('');
  }
  if (trail.length || r.unacknowledged.length || r.markers.length) {
    process.exitCode = 1;
    return;
  }
  const n = Object.keys(renumbered).length;
  console.log(
    `spec-id-renumbered: ${n} renumbered id(s) in the trail; ${r.references} reference(s) to them in ` +
      `${r.citing} of ${corpus.length} swept file(s), every one acknowledged.`,
  );
};

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
