#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-913 — the check that keeps invariant IDs worth citing.
//
// An ID scheme is worthless the moment it silently drifts, and every failure mode
// below is silent by nature: a duplicate ID makes two invariants answer to one
// citation, a reused number makes a 2026 citation resolve to different behaviour in
// 2027, and an un-IDed invariant is simply invisible to coverage. None of these
// breaks a build, renders wrong, or fails a test. So they are checked here, and
// `npm run lint` runs it.
//
// It deliberately does NOT check coverage. Coverage is a number to move, not a gate
// to pass — gating it would teach people to cite an ID from whatever test was handy,
// which buys a green check and destroys the signal.
//
// Exit 1 on any violation. Usage: node scripts/spec-guard.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECL, DECL_LIKE, REGISTRY, SPEC_DIR, fencedLines, loadRegistry, parseAll, parseSpec, prefixProblems, specFiles } from './spec-lib.mjs';

/** How long a repeated sentence must be before a repeat is evidence of a splice. */
export const DUP_MIN_WORDS = 8;

/**
 * A sentence that appears TWICE INSIDE ONE INVARIANT, with the line of each copy (RA-2070).
 *
 * The shape is an edit that INSERTED a replacement paragraph without deleting the one
 * it replaced. PR RA-2055 did it to `[CERT-9]`: two `**Stated limits, N.**` declarations
 * (`four` with a 15-minute threshold, `five` with 2 minutes — the first being exactly
 * the claim the PR falsified), a severed sentence at the splice, and one sentence
 * verbatim twice. Every guard was green and a full review round missed it. Both copies
 * read as authoritative, and the Explorer — which files bugs against this oracle — has
 * no way to tell which is current.
 *
 * KEYED ON REPETITION, never on vocabulary. `Stated limits` looks like the anchor and
 * is not one: it occurs in one file, so a guard built on it would protect `certificates.md`
 * and nothing else. A verbatim repeat of a long-enough sentence inside one clause is the
 * general signature of the splice.
 *
 * SCOPED TO ONE INVARIANT (the declaration line up to the next declaration or heading),
 * which is what keeps it quiet: specs legitimately repeat formulaic clauses ACROSS
 * bullets. Measured over `docs/qa/specs/**` when adopted (364 invariants): zero repeats
 * at any threshold from 6 words up; at 5 the first appears, and it is legitimate — a
 * formulaic `Left `[seed]` per oracle integrity.)*` closing two notes inside one
 * clause. So the 8-word floor is margin above real prose, not tuning, and it still
 * catches RA-2055's repeated sentence (9 words; `certificates.md` at `f0652cc`, where
 * this reports lines 295 and 314).
 *
 * @param {string[]} lines the whole spec file
 * @param {{line: number, id: string|null}[]} decls its invariants, in order
 * @returns {{id: string|null, first: number, second: number, sentence: string}[]}
 */
export function duplicateSentences(lines, decls, minWords = DUP_MIN_WORDS) {
  const out = [];
  decls.forEach((d, k) => {
    const start = d.line - 1;
    let end = k + 1 < decls.length ? decls[k + 1].line - 1 : lines.length;
    for (let j = start + 1; j < end; j += 1) if (/^#{1,6}\s/.test(lines[j])) { end = j; break; }
    // One string for the whole clause, with a map back to source lines: a sentence
    // wraps across lines as often as not, and the reader needs the line of each copy.
    let text = '';
    const lineOf = [];
    for (let j = start; j < end; j += 1) {
      for (let c = 0; c <= lines[j].length; c += 1) lineOf.push(j + 1);
      text += `${lines[j]}\n`;
    }
    const seen = new Map();
    // A sentence ends at . ! or ? (plus any closing markup) followed by whitespace — so
    // a path like `arc-client.test.ts` or `v0.2.0` does not split one.
    const SENTENCE = /[^\s].*?(?:[.!?][*_`)"']*(?=\s)|$)/gs;
    for (const m of text.matchAll(SENTENCE)) {
      const sentence = m[0].replace(/\s+/g, ' ').trim();
      if (sentence.split(' ').filter((w) => /[A-Za-z0-9]/.test(w)).length < minWords) continue;
      const at = lineOf[m.index];
      if (seen.has(sentence)) out.push({ id: d.id, first: seen.get(sentence), second: at, sentence });
      else seen.set(sentence, at);
    }
  });
  return out;
}

/** Returns the list of problems. Exported so the unit tier can drive it over
 *  fixtures — a guard whose only exercise is "CI is green" is a guard nobody has
 *  ever seen fail, and RA-917 is the standing reminder of what that costs. */
export function check({ dir = SPEC_DIR, registryPath = REGISTRY } = {}) {
const problems = [];
const fail = (msg) => problems.push(msg);

// 0. Every spec declares its area prefix, once, in its preamble, and no two declare the
//    same one (RA-2701, `K-LAYOUT-2`). Every rule below reads ids through those
//    declarations, so a broken one is reported ALONE — as findings, not as a stack trace
//    from the parser — and the rest of the check waits for it to be fixed.
const declared = prefixProblems(dir);
if (declared.problems.length) return { problems: declared.problems, invariants: [] };
const known = new Set(Object.values(declared.prefixes));

const invariants = parseAll(dir);
const registry = loadRegistry(registryPath);

// 1. Every invariant carries an ID.
for (const i of invariants) {
  if (!i.id) fail(`${i.file}:${i.line} — invariant has no ID. Run \`node scripts/spec-ids.mjs --apply\`.\n    ${i.text.slice(0, 90)}`);
}

// 2. IDs are unique. A duplicate makes one citation resolve to two invariants.
const seen = new Map();
for (const i of invariants.filter((x) => x.id)) {
  if (seen.has(i.id)) {
    const first = seen.get(i.id);
    fail(
      `duplicate ID \`${i.id}\` — ${first.file}:${first.line} and ${i.file}:${i.line}. Renumber one (strip its id, ` +
        'run `node scripts/spec-ids.mjs --apply`) and record the move in `_id-registry.json`\'s `renumbered` map — ' +
        `\`{"${i.id}": {"to": "<NEW-ID>", "by": <PR>}}\` — so every reference to \`[${i.id}]\` outside the specs is re-read once (RA-2004).`,
    );
  }
  seen.set(i.id, i);
}

// 3. An ID's prefix matches the file it lives in. Moving an invariant between specs
//    must keep its ID (citations outlive the move), so this is a warning-shaped rule
//    with a deliberate exception: a foreign prefix is allowed, an UNKNOWN one is not.
for (const i of invariants.filter((x) => x.id)) {
  const prefix = i.id.replace(/-\d+$/, '');
  if (!known.has(prefix)) {
    fail(`${i.file}:${i.line} — \`${i.id}\` uses an unknown area prefix. Declare it with \`**Id prefix:**\` in its area's spec file.`);
  }
}

// 4. No ID exceeds its area's high-water mark. This is what makes numbers permanent:
//    the registry records the highest EVER allocated, so a deleted invariant's number
//    is burnt and cannot be handed to a new one.
for (const i of invariants.filter((x) => x.id)) {
  const prefix = i.id.replace(/-\d+$/, '');
  const n = Number(i.id.slice(prefix.length + 1));
  const high = registry[prefix];
  if (high === undefined) {
    fail(`area \`${prefix}\` is missing from the ID registry — re-run spec-ids.mjs --apply.`);
  } else if (n > high) {
    fail(`${i.file}:${i.line} — \`${i.id}\` is above the recorded high-water mark (${prefix}: ${high}). Allocate via spec-ids.mjs so the registry advances.`);
  }
}

// 5. Nothing that looks like an invariant is parked in the preamble, where the parser
//    treats it as legend and coverage will never see it.
for (const file of specFiles(dir)) {
  for (const d of parseSpec(file, dir).filter((x) => x.legend)) {
    // The legend defines the tags themselves and reads "`[confirmed]` — a human has…".
    // Any dash, not just an em dash: a legend written `- \`[retired]\` - no longer
    // applies` is still a legend, and telling its author to "move it into a section"
    // would be wrong advice. The rule is positional; this only distinguishes the
    // definition list from a stray invariant parked above it.
    if (!/^\s*[—–-]/.test(d.raw.slice(d.raw.indexOf('`', d.raw.indexOf(`[${d.status}]`)) + 1))) {
      fail(`${file}:${d.line} — a tagged line sits above the first \`##\` heading, where it is read as legend and never gets an ID. Move it into a section.\n    ${d.text.slice(0, 90)}`);
    }
  }
}

// 6. No invariant carries two copies of one sentence (RA-2070) — a replacement inserted
//    beside the text it replaced. See `duplicateSentences`.
for (const file of specFiles(dir)) {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  for (const x of duplicateSentences(lines, parseSpec(file, dir).filter((d) => !d.legend))) {
    fail(
      `${file}:${x.first} and ${file}:${x.second} — ${x.id ? `\`${x.id}\`` : 'one invariant'} states the same sentence twice. ` +
        'An edit inserted a replacement beside the text it replaced: delete the stale copy (and check the paragraph around it — the splice usually leaves more than one sentence behind).\n' +
        `    ${x.sentence.slice(0, 110)}`,
    );
  }
}

// 7. Nothing is WRITTEN as a declaration that the parser does not read as one (RA-926).
//    `DECL` takes `-`/`*` bullets and bare paragraphs; an ordered-list, `+`-bulleted,
//    blockquoted or emphasis-wrapped tag at the head of a line was parsed as nothing, so
//    it got no id, no coverage row and no finding — indistinguishable from the invariant
//    not existing. A fenced example is exempt: that is `fencedLines`' whole point.
for (const file of specFiles(dir)) {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  const fenced = fencedLines(lines);
  // A fence that never closes hides the rest of the file from the parser AND from this
  // rule, which is the silent absence RA-926 exists to end — so it is a problem in itself.
  if (fenced.unclosed !== -1) {
    fail(
      `${file}:${fenced.unclosed + 1} — a code fence opens here and never closes, so every line below it is read as an ` +
        'example: its invariants get no ID and no coverage. Close the fence (same character, at least as many, at most 3 spaces of indent).',
    );
  }
  lines.forEach((l, i) => {
    if (fenced.has(i) || DECL.test(l) || !DECL_LIKE.test(l)) return;
    fail(
      `${file}:${i + 1} — this line is shaped like an invariant declaration, but the parser does not read it, so it gets no ID ` +
        'and coverage never sees it. Write it as a `- ` bullet or a bare paragraph starting with the tag; if it is prose ABOUT a tag, ' +
        'do not open the line with one.\n' +
        `    ${l.trim().slice(0, 90)}`,
    );
  });
}

  return { problems, invariants };
}

// CLI. Importing this module (the unit tier does) must not exit the process.
if (process.argv[1] && process.argv[1].endsWith('spec-guard.mjs')) {
  const { problems, invariants } = check();
  if (problems.length) {
    console.error(`spec-guard: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.log(`spec-guard: ${invariants.length} invariants, ${new Set(invariants.map((i) => i.id)).size} unique IDs, registry consistent.`);
}
