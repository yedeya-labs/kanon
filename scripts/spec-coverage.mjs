#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-913 — how much of the L2 oracle is actually enforced by L3?
//
// docs/agentic-qa-pipeline.md §3 calls the L2 -> L3 ladder the compounding engine of
// the whole pipeline: "Layer 3 — tests. The strongest oracle because it is executable
// and cannot drift. Confirmed bugs graduate here." Until now nobody could say what
// fraction had graduated, because an invariant was a prose bullet with no handle. A
// test could not name one and a script could not count them.
//
// The report answers four questions, ranked by how much they should worry you:
//
//   1. [confirmed] with no test — the worst cell. Claimed as ground truth, enforced by
//      nothing. The Explorer treats these as hard oracle and will file bugs against
//      them, so a wrong one is expensive in both directions.
//   2. [seed] WITH a test — promotion candidates. Someone wrote the executable check
//      and never promoted the prose; a human can clear these in one pass.
//   3. [structural]/[seed] with no test — the ordinary gap list, per area.
//   4. CLAIMED coverage that no test confirms. 105 invariants already name a test in
//      their prose — "*(Confirmed by `e2e/storefront.spec.ts`.)*". That is a claim a
//      human wrote, not a link a machine can follow: nothing checks the file still
//      exists, and nothing checks that test still asserts this invariant rather than
//      something it drifted into. Reported as its own tier, because the distance
//      between CLAIMED and LOCKED is exactly the migration this scheme enables.
//   5. citations naming an ID that does not exist — a typo, or an invariant deleted
//      out from under a test that still claims to lock it.
//
// It reports; it never fails. The CI guard (spec-guard.mjs) is what fails, and it
// checks ID integrity, not coverage — coverage is a number to move, not a gate to
// pass, and gating it would just teach people to cite an ID from an unrelated test.
//
// Usage: node scripts/spec-coverage.mjs [--json]

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QA_TOOLING_IMPORT, idPattern, loadPrefixes, parseAll } from './spec-lib.mjs';
import { LOCKED_SET, byId, readLockedSet, serialiseLockedSet } from './locked-set.mjs';
import { conventionFor, isTestFile } from './lib/test-conventions.mjs';
import { execFileSync } from 'node:child_process';

/** Where the JavaScript row's tests live. Other languages name a test file by its name
 *  (`test_*.py`, `*_test.go`) wherever it is, so the table, not this list, decides. */
export const TEST_DIRS = ['tests', 'e2e'];

/** Every test source file the scanner reads, in every language of the per-language table
 *  (`scripts/lib/test-conventions.mjs`, kanon#20). Exported so the AST oracle (RA-1255)
 *  checks `titlesIn` over the SAME file set the report is computed from — a check
 *  against a different set would be a different question.
 *
 *  The tree is read through git — tracked files and untracked ones it does not ignore — so a
 *  virtualenv or a vendored module, which `.gitignore` already names, is never read as the
 *  project's tests. Outside a git repository it walks the tree instead. */
export const testFiles = () => sourceFiles().filter(isTestFile);

const sourceFiles = () => {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e9 })
      .split('\0').filter(Boolean).filter((f) => existsSync(f));
  } catch {
    return walk('.').map((f) => f.replace(/^\.\//, ''));
  }
};

/** A test file's titles, by its language's reader. */
const titlesOf = (file, text) => conventionFor(file)?.titles?.(text) ?? titlesIn(text);
/** A test file minus its string literals, comments kept, by its language's reader. */
const mentionsOf = (file, text) => conventionFor(file)?.mentions?.(text) ?? outsideStrings(text);

// The ID tooling's own tests cite REAL ids — `[STORE-14]` to prove `idPattern()`
// matches it, `[STORE-500]` to prove the high-water rule rejects it. Scanned
// naively they read as coverage of the storefront, which is this report's own
// thesis ("nothing checks that test still asserts THIS invariant") reproduced one
// layer down, inside the mechanism built to detect it. Measured before excluding
// them: 8 locked against 3 real, and `STORE-500` in the unknown-citation list on
// every run — a section that is never empty is one people learn to skip.
//
// That was fixed by NARROWING THE SCAN rather than by listing the offenders — see
// `citations()`. These fixtures still say `STORE-n` (a fixture spec declares
// `**Id prefix:** \`STORE\`` the way a real one does, RA-2701), but an ID in a
// fixture string is no longer a citation, so nothing has to name them.
// THE OPT-OUT LIST IS GONE, and its absence is the fix (RA-1214).
//
// It named the ID tooling's own tests, whose fixtures quote real IDs and assert
// nothing about them. Being OPT-IN, it could only ever be updated after the fact: a
// new tool test counted real invariants until somebody noticed. That happened three
// times — `spec-ids.test.ts` (8 locked against 3 real), `verify-acs.test.ts` (RA-1068,
// five of project RA-961's criteria reading as `has-test`), and `citation-guard.test.ts`
// (RA-1198, moving ESCAPE from `6|0|4` to `6|1|3` on a `[confirmed]` clause).
//
// `citations()` now reads TEST TITLES rather than whole files, which is the convention
// this scheme already documents (`it('[COURSE-6] …')`). Measured: emptying the list
// changes no number, because a fixture quoting an ID in a string argument is not a
// title. So the list was a patch for a scan that was too broad, and the scan is the
// thing that is fixed. Nothing has to be remembered now.
const QUIET = process.argv.includes('--quiet');
const JSON_OUT = process.argv.includes('--json');
// Regenerate the locked set from the tree. Deliberately NOT run by `lint`: the gate
// must fail on an unacknowledged change, and a gate that silently rewrites its own
// baseline records nothing. This is the acknowledgement, invoked by hand.
const WRITE_LOCKED = process.argv.includes('--write-locked');

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let stat;
    // A broken symlink under tests/ must be skipped, not thrown on.
    try { stat = statSync(p); } catch { continue; }
    // Dot-directories (`.git`, `.venv`) and `node_modules` hold no project test.
    if (stat.isDirectory()) { if (!e.startsWith('.') && e !== 'node_modules') walk(p, out); }
    else out.push(p);
  }
  return out;
}


/** Skip a balanced (...) / [...] / `...` group starting at `k`; -1 if none. */
function skipGroup(text, k) {
  const open = text[k];
  // `{` IS SCANNABLE (RA-1249). Without it, `readString` asked `skipGroup` to skip a
  // template's `${…}` interpolation, got -1, and returned null — so an interpolated
  // title was not mis-read, it was DISCARDED, and every ID it cited vanished from both
  // halves of the report. Pre-existing since RA-1214; invisible only because the one
  // file doing it also cites the same IDs in plain-string titles, which nothing
  // enforces. The idiomatic way to write an exhaustive-status assertion here is a loop
  // over statuses with an interpolated title, so the next one would have read `Bare`
  // while genuinely asserting the invariant.
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  if (open === '`') {
    for (let i = k + 1; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      // A nested template lives inside `${…}`; skipping the interpolation as a group
      // is what stops an inner backtick being read as this template's terminator.
      if (text[i] === '$' && text[i + 1] === '{') {
        const end = skipGroup(text, i + 1);
        if (end < 0) return -1;
        i = end - 1;
        continue;
      }
      if (text[i] === '`') return i + 1;
    }
    return -1;
  }
  if (!close) return -1;
  let depth = 0;
  for (let i = k; i < text.length; i++) {
    const c = text[i];
    // COMMENTS ARE SKIPPED, NOT PARSED. Measured on `origin/main`: an `it.each` table
    // whose row carries `// a different agent's PR` lost its title and every title
    // after it in the file, because that apostrophe opened a phantom string here.
    // `titlesIn` and `outsideStrings` both learned this (RA-1232, RA-1247); the group
    // skipper did not, so the same defect survived one call deeper — where it is
    // WORSE, because a group that runs to -1 discards a title rather than mis-reading
    // one. Found by the AST oracle, not by eye, which is the point of building it.
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i);
      if (e < 0) return -1;
      i = e + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {           // a bracket inside a string
      const end = c === '`' ? skipGroup(text, i) : skipString(text, i);
      if (end < 0) return -1;
      i = end - 1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** Read the string literal at `k`; returns [value, endIndex] or null. */
function readString(text, k) {
  const q = text[k];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let out = '';
  for (let i = k + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { out += text[i + 1] ?? ''; i++; continue; }
    if (c === q) return [out, i + 1];
    if (q === '`' && c === '$' && text[i + 1] === '{') {   // `[PAY-${n}]` is not an ID anyway
      const end = skipGroup(text, i + 1);
      if (end < 0) return null;
      i = end - 1;
      continue;
    }
    out += c;
  }
  return null;
}
const skipString = (text, k) => { const r = readString(text, k); return r ? r[1] : -1; };

const skipSpace = (text, k) => { while (k < text.length && /\s/.test(text[k])) k++; return k; };

/** Skip a REGEX LITERAL starting at `k`; -1 if this `/` does not start one.
 *
 *  A regex owns its quotes, and missing that is the same defect as parsing quotes
 *  inside a comment: `/You're registered/i` opens a phantom string that swallows
 *  everything to the next apostrophe. Measured when this was added: 67 real titles
 *  disappeared from the scan, none of them carrying an ID *yet* — so the ID-level
 *  differential that cleared the change could not see it, and the loss would have
 *  surfaced only when someone added a `[STORE-n]` to one of those tests.
 *
 *  `/` is also division, so position decides. A regex can only begin where an
 *  expression can, which after the last meaningful character means one of the
 *  operators/punctuators below — never after an identifier, `)`, `]` or a literal. */
const REGEX_OK_AFTER = new Set([...'(,=:[!&|?{};+-*%~^<>', '']);

/** Keywords a regex may legally follow (RA-1250).
 *
 *  A single-character lookback cannot express this: a keyword's last letter (`n` in
 *  `return`, `f` in `typeof`, `e` in `case`) cannot go in the set without making every
 *  identifier ending in that letter a false regex start — and a false start is worse
 *  than a miss, because it consumes real code as a literal. So the word is read. */
const REGEX_OK_AFTER_WORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'throw', 'await', 'yield', 'void',
  'delete', 'do', 'else', 'instanceof', 'new',
]);

/** The scanner's memory of the last meaningful token, which is what decides `/`.
 *
 *  READ FROM TRACKED STATE, NEVER FROM RAW TEXT (RA-1253). The keyword branch used to
 *  walk `text` backwards from the `/`, which lands on whatever characters are there
 *  rather than on whatever the scanner CONSUMED — so `return /* why *\/ /You're here/`
 *  read `*\/` as the preceding word, declined the regex, and the apostrophe opened a
 *  phantom string that swallowed every title after it. The three loops below already
 *  step over comments, strings and regexes correctly; the fix is to let this question
 *  be answered by that walk instead of by a second, dumber one.
 *
 *  `beforeWord` is the character before the word started, so a property access spelled
 *  like a keyword — `o.new / a / b` — is division. The file's own argument for reading
 *  the word at all says a FALSE regex start is worse than a miss, because it consumes
 *  real code as a literal; `.`-prefixed words are the reachable false start. */
const newScan = () => ({ prev: '', word: '', beforeWord: '' });

/** Fold one consumed character into the token state. Whitespace is not a token. */
const noteChar = (st, c) => {
  if (/\s/.test(c)) return;
  if (/[A-Za-z0-9_$]/.test(c)) {
    if (st.word === '') st.beforeWord = st.prev;
    st.word += c;
  } else {
    st.word = '';
  }
  st.prev = c;
};

/** Fold a whole consumed literal (string, template, regex) into the token state. */
const noteLiteral = (st) => { st.prev = 'x'; st.word = ''; };

/** True when a `/` can begin a regex here rather than being division. */
const regexAllowedAt = (st) => st.word !== ''
  ? st.beforeWord !== '.' && REGEX_OK_AFTER_WORD.has(st.word)
  : REGEX_OK_AFTER.has(st.prev);

export function skipRegexLiteral(text, k, st) {
  if (text[k] !== '/' || !regexAllowedAt(st)) return -1;
  let inClass = false;
  for (let i = k + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '\n') return -1;                       // regex literals do not span lines
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let j = i + 1;
      while (j < text.length && /[a-z]/.test(text[j])) j++;   // flags
      return j;
    }
  }
  return -1;
}

/** The title literal of a test call whose name ends at `k`, or null.
 *
 *  ANY MODIFIER MAY TAKE ARGUMENTS, NOT JUST `.each`. The scanner special-cased
 *  `it.each([table])('title')` — correctly, since the table sits between the method
 *  and the title — and every other curried modifier fell through it: measured on
 *  `origin/main`, `it.runIf(cond)('every label the reconciler applies is declared')`
 *  produced NO title, and `it.skipIf` is the same shape. Both are in use in this repo
 *  and vitest documents `for`, `concurrent` and `extend` chains besides.
 *
 *  So the question is asked structurally instead of by name: is the first argument a
 *  string? If it is, that is the title. If it is not — a table, an identifier, a
 *  boolean — and this call had a modifier chain, then the group is the modifier's
 *  argument and the title is in the call AFTER it. That is exactly what the AST sees
 *  when the callee is itself a `CallExpression`, and `it('x')` cannot reach the second
 *  branch because a bare name has no chain.
 *
 *  Bounded at one indirection: `it.a(x)(y)('t')` is not a form anything writes, and an
 *  unbounded loop would let a malformed file walk the rest of the scan. */
function titleAt(text, k, hasModifier) {
  for (let hop = 0; hop < 2; hop++) {
    if (text[k] === '(') {
      const lit = readString(text, skipSpace(text, k + 1));
      if (lit) return lit[0];
    }
    if (!hasModifier) return null;
    const end = skipGroup(text, k);          // `(table)` or a tagged `\u0060table\u0060`
    if (end < 0) return null;
    k = skipSpace(text, end);
  }
  return null;
}

/** The title strings of every `describe` / `it` / `test` in a file.
 *
 *  A CITATION IS A TEST TITLE, not a mention (RA-1214). Scanning whole files counted an
 *  ID written as fixture data, so the ID tooling's own tests became evidence for the
 *  invariants they merely quote — three times: `spec-ids.test.ts`, `verify-acs.test.ts`
 *  (RA-1068, five of project RA-961's criteria read as `has-test`), and
 *  `citation-guard.test.ts`, which moved ESCAPE from `6|0|4` to `6|1|3` on a
 *  `[confirmed]` clause the Explorer files bugs against.
 *
 *  A hand-maintained opt-out cannot close that: it is opt-in, so the next tool test is
 *  counted until somebody remembers, which is exactly what happened all three times.
 *  The convention this scheme documents is `it('[COURSE-6] …')`, so reading titles is
 *  both the narrower rule and the one already written down.
 *
 *  MEASURED before adopting, because the risk is dropping REAL locks. Counting KNOWN
 *  invariant ids only: against a raw whole-file scan this drops 11; against what the
 *  module shipped before — which already excluded three tool-test files by name — it
 *  drops exactly 2. `Locked` goes 17 -> 15, and 5 of that 17 were false locks this
 *  file's own fixtures created. Every dropped id but two is a tool-test fixture. The
 *  two that are not — `[STORE-59]` and
 *  `[STORE-63]` in `tests/tenant-contact-email-1157.test.ts` — appear only in a
 *  docblock DISCUSSING them, while every test in that file locks `[STORE-86]` in its
 *  title. So they were false locks too, and dropping them is the fix working.
 *
 *  SCANNED, not regexed, because of `it.each`: its table sits between the method and
 *  the title (`it.each([...])('[PAY-1] …')`), often across lines with nested brackets
 *  and quotes, so a regex assuming the title is the first `(` argument misses it.
 *  MEASURED: no invariant is locked through `it.each` today, so this recovers nothing
 *  now — 23 files use the form, and the first lock written that way would have gone
 *  missing silently, which is the failure this whole issue is about. */
export function titlesIn(text) {
  const out = [];
  // A SINGLE LEFT-TO-RIGHT PASS THAT CONSUMES LITERALS WHOLE (RA-1232).
  //
  // `matchAll` over raw text could not tell a call from a string CONTAINING one, so
  // a fixture written as `const src = "it('[STORE-1] a', () => {})"` parsed as a real
  // title and locked a real invariant. RA-1228 hit this in its own new test and counted
  // five storefront invariants that no test asserts.
  //
  // The mitigation adopted then was a CONVENTION — fixtures must use an unknown
  // `SAMPLE-` prefix, plus a per-file backstop assertion. That is the same shape as
  // the `NOT_COVERAGE` list RA-1214 deleted, one level down: opt-in, per-file, applied
  // after the fact, and silent when forgotten. RA-1214's stated goal was "nothing has
  // to be remembered now", and a convention is a thing to remember.
  //
  // Consuming literals makes it structural instead. Comments are skipped for the same
  // reason: an ID named in a docblock is a MENTION, which the report now surfaces
  // separately (RA-1235) rather than counting as coverage.
  const NAME = /(?:describe|it|test)((?:\.\w+)*)\s*(?=[([`])/y;
  let i = 0;
  const st = newScan();                              // last meaningful token, for `/`
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {        // a literal, however long
      const end = c === '`' ? skipGroup(text, i) : skipString(text, i);
      i = end < 0 ? i + 1 : end;
      noteLiteral(st);
      continue;
    }
    if (c === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
      const end = skipRegexLiteral(text, i, st);     // a regex owns its quotes too
      if (end > 0) { i = end; noteLiteral(st); continue; }
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    // Only at an identifier boundary — `submit(` ends in `it(` and is not a test.
    if ((c === 'd' || c === 'i' || c === 't') && !/[\w$.]/.test(text[i - 1] ?? '')) {
      NAME.lastIndex = i;
      const m = NAME.exec(text);
      if (m) {
        const lit = titleAt(text, NAME.lastIndex, m[1] !== '');
        if (lit) out.push(lit);
        i += m[0].length;
        continue;
      }
    }
    noteChar(st, c);
    i++;
  }
  return out.join('\n');
}

/** IDs that appear in a test file's TEXT but in no test title anywhere (RA-1235).
 *
 *  The complement of `citations()`, and the reason it is needed: narrowing to titles
 *  fixed a LOUD over-count — a wrong lock showed up in the table and in the
 *  unknown-citation section, which is how RA-1068 and RA-1198 were caught — and opened a
 *  SILENT under-count in the mirror direction. An invariant a test genuinely asserts,
 *  whose ID it names only in a docblock, now reads as `Bare`, identical to one no test
 *  touches. The first is a fixable citation; the second is a real coverage gap; a
 *  human deciding a `[seed]` promotion needs to tell them apart.
 *
 *  Measured when this landed: 5 ids stayed Locked while losing an evidence FILE, which
 *  the invariant-level count could not show — and `citations()` feeds
 *  `scripts/verify-acs.mjs`, which reports the set of files evidencing each
 *  acceptance criterion, so phase-5 output moves even where `Locked` does not. */
export const outsideStrings = (text) => {
  // Blanks string and template literals, keeping length so nothing else shifts, and
  // KEEPS comments — a docblock mention is the thing being looked for.
  let out = '', i = 0;
  const st = newScan();
  while (i < text.length) {
    const c = text[i];
    // COMMENTS ARE COPIED VERBATIM, AND NOT PARSED FOR QUOTES. A docblock mention is
    // exactly what this function is looking for, so comments must survive — but an
    // apostrophe in one (`// don't`) would otherwise open a phantom string literal and
    // desynchronise every quote after it, which is how the first version of this let
    // fixture ids through while blanking the code around them.
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i);
      const end = e < 0 ? text.length : e + 2;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
      const end = skipRegexLiteral(text, i, st);     // same exposure as titlesIn
      if (end > 0) { out += text.slice(i, end).replace(/[^\n]/g, ' '); i = end; noteLiteral(st); continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = c === '`' ? skipGroup(text, i) : skipString(text, i);
      if (end < 0) { out += c; i++; continue; }
      // Newlines preserved so offsets still map to the right LINE — blanking them
      // collapsed a multi-line template into one line and made every later report
      // point at the wrong place.
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      noteLiteral(st);
      continue;
    }
    out += c;
    noteChar(st, c);
    i++;
  }
  return out;
};

/** A clause that has OPTED OUT of being cited, in its own words.
 *
 *  `[PAY-8]` is the case this exists for. Its spec text says: *"This clause
 *  deliberately names no test file. A reproduction exists ... but it pins the
 *  DEFECTIVE behaviour ... naming it here would have `spec-coverage` report `[PAY-8]`
 *  as Claimed and list it as a promotion candidate on the strength of a test asserting
 *  its exact opposite."*
 *
 *  PROPHYLACTIC, NOT REMEDIAL, and the difference decides who may remove it (RA-1283).
 *  This docblock used to say the section "listed it anyway"; re-measured on merged
 *  `main` at 5a4af1e, it never had. Listing needs a bracketed `[PAY-8]` surviving
 *  `outsideStrings`, and before RA-1276 no test wrote one — `verify-acs.test.ts` has it
 *  inside a template fixture, which is stripped, and
 *  `settle-order-enrollment-row-1053.test.ts` writes it unbracketed on purpose. The
 *  first bracketed one was a docblock RA-1276 itself added, and RA-1278 has since stopped
 *  scanning that file at all. So no listing has ever been observed, and a reader who
 *  believes this is remedial will mis-scope what may retire it.
 *
 *  It keeps its value on the state it guards against, which is one commit away: a real
 *  assertion-bearing test that brackets `[PAY-8]` in a docblock WOULD be listed, and
 *  the advice given — move the ID into the test title — is the precise harm the spec
 *  author wrote a paragraph to prevent. A report that recommends a change the spec
 *  forbids is worse than one that stays silent, because it converts `unverifiable`
 *  into a false `passed`, which is the silent absence phase 5 exists to prevent.
 *
 *  Matched on the author's own sentence rather than a new marker: this is a rare,
 *  deliberate act, and the phrase is already the way it is declared. */
const OPTED_OUT = /deliberately names no test file/i;
export const citationOptOut = (invariants) =>
  new Set(invariants.filter((i) => OPTED_OUT.test(i.raw ?? '')).map((i) => i.id));

/** A clause that declares, in its own words, that it will NEVER be Locked (RA-1654).
 *
 *  `Claimed` is defined as the migration list — "Converting Claimed to Locked is the
 *  migration this scheme exists to make possible" — and PR RA-1651 put two clauses in it
 *  that are permanently unlockable BY DECISION: `[STORE-17]` asserts the absence of a
 *  bound (a human on a bank's 3DS challenge) and `[STORE-20]` what a `disabled={…}`
 *  expression renders on a surface no automated tier reaches. Each names a test file for
 *  findability, which is what made it Claimed, and each says it is "**deliberately not
 *  migrating** … to Locked". Counted as Claimed, the decision was indistinguishable from
 *  a backlog entry except by reading a paragraph of prose.
 *
 *  THE AUTHOR'S OWN SENTENCE, for the reason `OPTED_OUT` above gives: a hand-kept list
 *  in this script is what RA-1214 deleted, because it could only ever be updated after
 *  the fact. Measured when adopted: the phrase occurs on exactly those two clauses in
 *  `docs/qa/specs/**`, so it excludes nothing that did not say so. The match requires
 *  "to Locked" after it, so a clause saying it is deliberately not migrating something
 *  ELSE is not swept in.
 *
 *  STILL REPORTED, as its own tier. A silently-dropped invariant is worse than a
 *  miscategorised one — the tier is what keeps the decision visible and countable. */
const DECLARED_UNLOCKABLE = /deliberately not migrating\**\s+(?:from Claimed\s+)?to Locked/i;
export const declaredUnlockable = (invariants) =>
  new Set(invariants.filter((i) => DECLARED_UNLOCKABLE.test(i.raw ?? '')).map((i) => i.id));

/** True when a test file is a test OF THE ID TOOLING, so its ID mentions are quotes.
 *
 *  RA-1278. `citations()` was narrowed to test titles precisely so the tooling's own
 *  fixtures stopped counting as coverage (RA-1214/RA-1232), but this section kept scanning
 *  whole files — so the class survived in the half that RECOMMENDS ACTION, which is
 *  worse than where it started. Measured: `[STORE-14]` was listed from a docblock in
 *  `spec-ids.test.ts` reading *"this file cites REAL ids … to prove `idPattern()`
 *  matches it"*, and `[FILTER-3]` from a docblock narrating a fixture fed to the
 *  citation guard. Acting on either — moving the ID into a title — would lock a
 *  storefront invariant on a regex test, converting `unverifiable` into a false
 *  `passed`: the report's own thesis reproduced one layer down.
 *
 *  KEYED ON WHAT THE FILE IMPORTS, NOT ON ITS NAME. RA-1214 deleted a hand-maintained
 *  opt-out list because it "could only ever be updated after the fact", and a list of
 *  tooling test files would re-create that defect exactly. An import is a property of
 *  the file, so the next tool test qualifies the day it is written.
 *
 *  The tradeoff, stated: a test that imports a `scripts/qa/` module for an unrelated
 *  reason AND names an invariant in a docblock is silently excluded. Measured on this
 *  tree, no such file exists, and the alternative rule considered — count a mention
 *  only where some title in the same file cites the same PREFIX — gave an identical
 *  result here while losing genuine signal from any file that cites nothing at all,
 *  which is the under-count this whole section exists to surface.
 *
 *  The pattern (`QA_TOOLING_IMPORT`) lives in `spec-lib.mjs`, shared with the reference
 *  corpus the existence sweep and the renumber check read (RA-2004). */

export function mentionsWithoutTitle(known, optedOut = new Set()) {
  const cited = citations();
  const found = new Map();
  {
    for (const file of testFiles()) {
      const raw = readFileSync(file, 'utf8');
      if (QA_TOOLING_IMPORT.test(raw)) continue;
      // OUTSIDE STRINGS, because a mention inside one is FIXTURE DATA, and the advice
      // this section gives — "move the ID into the title" — is wrong for a fixture.
      // Without this the section listed the three ID-tooling tests, which is precisely
      // the noise RA-1214 spent two rounds removing from the coverage number itself.
      const text = mentionsOf(file, raw);
      for (const m of text.matchAll(idPattern())) {
        const id = `${m[1]}-${m[2]}`;
        if (!known.has(id) || cited.has(id) || optedOut.has(id)) continue;
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(file);
      }
    }
  }
  return found;
}

/** Every invariant ID cited in a TEST TITLE under tests/ and e2e/, with where.
 *
 *  Said precisely because the previous wording — "cited anywhere under tests/ and
 *  e2e/" — was a verbatim description of the whole-file scan this module was changed
 *  to stop doing (RA-1214). A stale sentence asserting the removed semantics, left in
 *  the file that removed them, is the same class the change is about.
 *
 *  ID -> the set of test files that CITE it. Exported for RA-1068: phase 5 asks the
 *  same question per acceptance criterion that this asks per invariant. */
export function citations() {
  const found = new Map();
  {
    for (const file of testFiles()) {
      const text = titlesOf(file, readFileSync(file, 'utf8'));
      for (const m of text.matchAll(idPattern())) {
        const id = `${m[1]}-${m[2]}`;
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(file);
      }
    }
  }
  return found;
}

// The spec's own back-link: "(Confirmed by `e2e/storefront.spec.ts`)". Reading it
// costs nothing and turns a 0%-locked report into a useful one on day one.
// Any backticked path that is a test file by the per-language table: `tests/test_core.py` and
// `internal/orders/core_test.go` as well as `e2e/storefront.spec.ts`.
const CLAIM = /`([A-Za-z0-9._/-]+\.[A-Za-z]+)`/g;
/** The ratchet floor for `Locked`. A drop below it fails `lint`, AND SO DOES SLACK
 *  ABOVE IT (RA-1315). Deliberately not auto-updated — the bump is the acknowledgement.
 *
 *  WHY BOTH DIRECTIONS. A one-sided floor only detects a lost citation while `locked`
 *  sits exactly ON it. Every PR that adds a lock without bumping this constant buys
 *  that many free deletions repo-wide: at `locked = 20, floor = 16`, four citations
 *  can be dropped by a rename or a title reword and `lint` stays green — the precise
 *  regression the ratchet exists to catch, silently disarmed by an unrelated PR. It
 *  has never had slack, so this closes a hole rather than a bug; PR RA-1314 is the first
 *  change that would have opened one, and it is open as this lands.
 *
 *  THIS IS ALSO WHY FOUR SCANNER DEFECTS WENT UNDETECTED. RA-1247, RA-1249, RA-1250 and
 *  RA-1253 each silently dropped titles, and PR RA-1252 named the reason none of them
 *  reddened anything: a simultaneous add-and-lose reads clean under a floor. The AST
 *  oracle in `tests/library/spec-ids.test.ts` is the real answer to that class; this makes
 *  the count itself stop lying in the meantime.
 *
 *  THE COST, STATED. Every PR that adds a lock must now also edit this line, which
 *  puts `scripts/spec-coverage.mjs` in a diff that otherwise touches only `tests/`
 *  and `docs/qa/specs/**`. That does NOT newly break the red-test gate: such a PR
 *  already reports UNVERIFIABLE on its `docs/qa/specs/**` half (RA-1197), which the
 *  triage/fix playbook requires it to carry.
 *
 *  AND IT COSTS A REBASE, WHICH THIS PR PAID FIRST. RA-1314 merged eight seconds after
 *  the PR introducing this arm opened, so CI's merge ref never saw its four locks and
 *  the PR was green while its merged state was red — `lint` and `test:unit` both. The
 *  one-sided floor made a stale base harmless for ADDED locks; two-sided, every
 *  spec-lock PR is exposed. Tracked as RA-1325; this line is re-derived after a rebase
 *  onto the current `main`, not copied from a review comment.
 *
 *  AND RA-1325 HAS NOW HAPPENED A SECOND TIME, ON MAIN (RA-1618). RA-1591 added the
 *  `[OBS-5]` citation in `tests/unit/payer-budget-doc-544.test.ts` and DID bump this
 *  line — 34 to 35, its own delta of +1. The merged state was 36, because another
 *  lock landed in the interval, so the bump UNDERSHOT. Its own CI was green (the
 *  merge ref it was evaluated against did not yet contain the other lock) and `main`
 *  went red the moment it landed, failing `lint` and `test:unit` for EVERY
 *  subsequent PR until the next bump.
 *
 *  THE FRAMING MATTERS MORE THAN THE FACT (RA-1620). Read as "an author forgot the
 *  bump", the obvious guard is "a PR that adds a lock must also edit LOCKED_FLOOR" —
 *  a rule RA-1591 SATISFIED, and which would not have prevented this. The stale-base
 *  diagnosis in RA-1325 is the right one: the floor must be checked against the count
 *  on the MERGE RESULT, not against the author's own delta. That is what RA-1325 still
 *  owes; a per-PR rule cannot deliver it.
 *
 *  AND A THIRD TIME, ON MAIN, IN A SHAPE THE FIRST TWO DID NOT HAVE (2026-09-13).
 *  RA-1791 and RA-1814 both branched from `98a45ea8` (floor 58, locked 58), both added
 *  exactly one lock, and BOTH BUMPED THIS LINE TO 59 — each correct against its own
 *  base, each green on its own merge ref. They merged thirty seconds apart. Because
 *  both diffs changed this line to the same literal, the second merge was TEXTUALLY
 *  CLEAN: git had no conflict to raise, and the merged state carries one bump for two
 *  locks. `main` went red on the release commit that followed (run 34755907610), with
 *  `Build`, `Integration` and `E2E` all skipped behind it.
 *
 *  Note what that rules out. RA-1618's bump undershot because its author could not see
 *  the other lock; a "re-derive after rebase" habit would have caught it. Here there
 *  was nothing to re-derive — the value 59 was right for both authors at the moment
 *  each wrote it, and a rebase would have produced the same clean merge. Only a check
 *  against the merge RESULT distinguishes 59-is-correct from 59-is-stale, which is
 *  RA-1325 again and is the third incident it has now caused.
 *
 *  WHO REPAIRED IT, AND WHAT THE REPAIR DEMONSTRATED. RA-1821 carried the 59 -> 60 bump
 *  that greened `main`, incidentally: it is a payer-reminder fix that touched this line
 *  only to unblock itself. The PR raised to repair this deliberately was rebased onto
 *  that, and the rebase is the point — the comment above conflicted and had to be
 *  resolved by hand, while `LOCKED_FLOOR` itself AUTO-MERGED, both sides having written
 *  the identical literal. A second demonstration, inside the fix for the first, that
 *  git cannot see this class of disagreement: agreement on the TEXT of this line is not
 *  agreement on whether the NUMBER is still right. Only RA-1325's merge-result check can
 *  tell those apart, and until it lands the repair for the next occurrence is a manual
 *  re-measure — `node scripts/spec-coverage.mjs --quiet` on the merge result, not a
 *  re-read of anyone's diff.
 *
 *  A FOURTH AND FIFTH TIME, TOGETHER, AND THIS ONE SAT RED FOR HOURS (2026-09-13).
 *  RA-1827 added a lock and bumped 60 -> 61, correctly. RA-1824 and RA-1826 then each added
 *  one and bumped nothing, so `main` reached 63 against a floor of 61 — off by TWO,
 *  where every prior occurrence was off by one. CI failed on the release commits for
 *  0.72.10 and 0.72.11 and stayed failing; nothing pages on a red `main`, so the only
 *  signal was the next person to look. That is the cost this comment keeps
 *  understating: the ratchet reports the defect accurately and immediately, to nobody.
 *
 *  Two things this pair adds to the record. First, the arithmetic no longer identifies
 *  the culprit — at a delta of two you cannot tell one PR that skipped a bump from two
 *  that did, so blame needs `git log -S`, which is what produced the attribution above.
 *  Second, the guard degrades as it drifts: at floor 61 against 63 locked, TWO
 *  citations could be deleted repo-wide with `lint` still green, and the longer red
 *  `main` persists the wider that hole opens. A stale floor is not a paused ratchet,
 *  it is a loosening one.
 *
 *  AND THE REPAIR AGAIN CAME FROM A PR THAT WANTED SOMETHING ELSE. RA-1822 (a module
 *  server-action gate) added its own lock and wrote `64`, which was correct against the
 *  63 it merged onto, so `main` went green as a side effect of unrelated product work —
 *  exactly as RA-1821 had ended the previous occurrence. Twice running, the deliberate
 *  repair PR was overtaken by an incidental one, and both times the deliberate PR then
 *  had to be rebased to STOP lowering the floor it no longer needed to raise. Worth
 *  stating because it looks like luck and is not: any PR that adds a lock is forced to
 *  touch this line, so on a busy day the ratchet is usually repaired by whoever happens
 *  to land next. That is not a fix. It means the red window is bounded by unrelated
 *  traffic rather than by anyone noticing, and on a quiet day nothing bounds it. */
/** WHAT REPLACED THE FLOOR, AND WHY THE LOG ABOVE STAYS.
 *
 *  The seven incidents above are not a list of people forgetting a bump. Read
 *  together they say the mechanism was wrong in three separable ways, and each is now
 *  fixed somewhere else:
 *
 *    · THE NUMBER WAS IN AN ESCALATING PATH. The reference adopter escalated `^scripts/qa/`,
 *      so every lock-adding PR needed a human merge, and on RA-888 the lock was reverted
 *      to get the PR merged. The baseline now lives in `docs/qa/specs/_locked-floor.json`
 *      (RA-1398), which is deliberately outside that rule. This file still escalates, for
 *      any change to the mechanism — the exemption is about the VALUE, not the file.
 *
 *    · THE NUMBER WAS A SINGLE SCALAR. Two concurrent PRs both wrote the same literal,
 *      so git merged them CLEAN and the result was wrong — three of the seven. A sorted
 *      list of ids does not collide that way: measured over five pairs, four merge
 *      clean and only two locks adjacent in the SAME area still conflict (RA-1830). And a
 *      conflict there is honest work, where the scalar's clean merge was silent damage.
 *
 *    · THE PR WAS GRADED ON A STALE MERGE REF. `actions/checkout` does not recompute it
 *      when `main` moves, so the failure landed on `main` rather than on the author.
 *      `scripts/qa/locked-merge-check.mjs` re-grades against the live base tip on every
 *      PR run (RA-1325), and attributes to the base when the base is the one at fault.
 *
 *  The fourth thing the log records is not a property of this gate at all: nothing
 *  announced a red `main`, so two releases shipped red and both were repaired
 *  incidentally by unrelated traffic. That is `.github/workflows/main-red.yml` (RA-1848).
 *
 *  KEPT AS CARDINALITY. `LOCKED_FLOOR` is now derived, not authored — the report lines
 *  and `spec-ids.test.ts` want a number, and a second hand-maintained count would be a
 *  second thing to drift. */
export const LOCKED_FLOOR = readLockedSet().length;

/** The ids themselves, which is what the gate actually compares. `LOCKED_FLOOR` stays
 *  exported as its cardinality: callers that only want the number (the report lines,
 *  `spec-ids.test.ts`'s armed-ratchet assertion) keep working unchanged. */
export const lockedBaseline = () => new Set(readLockedSet());

/** THE GATE, IN ONE PLACE. `--quiet` and the full report both need it, and two copies
 *  of a gate drift — which is the defect class this whole module is about. */
export const failures = ({ dangling, missingFiles, locked, baseline = lockedBaseline() }) => {
  const out = [];
  if (dangling.length) out.push(`${dangling.length} citation(s) name an unknown invariant: ${dangling.join(', ')}`);
  if (missingFiles.length) out.push(`${missingFiles.length} claim(s) name a file that does not exist`);

  // BOTH DIRECTIONS, AND BOTH NAMED. `lost` is the regression the ratchet exists for:
  // an id the baseline records as locked that no test titles any more. `gained` is the
  // acknowledgement arm — a new lock that nobody wrote down leaves that many citations
  // deletable with lint still green. Reported SEPARATELY and never netted against each
  // other: a simultaneous add-and-lose is exactly what a count cannot see, and is how
  // RA-1247/RA-1249/RA-1250/RA-1253 each stayed green while dropping a title.
  const now = new Set(locked.map((i) => i.id ?? i));
  const lost = [...baseline].filter((id) => !now.has(id)).sort(byId);
  const gained = [...now].filter((id) => !baseline.has(id)).sort(byId);

  if (lost.length) out.push(
    `${lost.length} invariant(s) lost their citation: ${lost.join(', ')}. A test that named ` +
    `the ID no longer does — restore the citation, or remove the ID from ` +
    `${LOCKED_SET} deliberately and say why.`);
  if (gained.length) out.push(
    `${gained.length} invariant(s) are newly locked and unrecorded: ${gained.join(', ')}, so ` +
    `that many citation(s) could now be deleted anywhere in the repo without failing lint. ` +
    `Re-run spec-coverage with \`--write-locked\` and commit ${LOCKED_SET} — the diff is ` +
    `the acknowledgement.`);
  return out;
};
const claimsIn = (inv) => [...new Set([...inv.raw.matchAll(CLAIM)].map((m) => m[1]).filter(isTestFile))];

function main() {
  const invariants = parseAll();
  const cited = citations();
  const known = new Set(invariants.map((i) => i.id));

  const locked = invariants.filter((i) => cited.has(i.id));
  const bare = invariants.filter((i) => !cited.has(i.id));
  const confirmedBare = bare.filter((i) => i.status === 'confirmed');
  const seedLocked = locked.filter((i) => i.status === 'seed');
  const dangling = [...cited.keys()].filter((id) => !known.has(id));

  // Claimed is the MIGRATION LIST, so a clause that declares it will never be locked is
  // held out of it and reported as its own tier (RA-1654).
  const unlockableIds = declaredUnlockable(invariants);
  const claimedAll = bare.filter((i) => claimsIn(i).length > 0);
  const claimed = claimedAll.filter((i) => !unlockableIds.has(i.id));
  const unlockable = claimedAll.filter((i) => unlockableIds.has(i.id));
  const missingFiles = invariants
    .flatMap((i) => claimsIn(i).filter((f) => !existsSync(f)).map((f) => ({ id: i.id, file: i.file, claim: f })));

  if (WRITE_LOCKED) {
    writeFileSync(LOCKED_SET, serialiseLockedSet(locked.map((i) => i.id)));
    console.log(`${LOCKED_SET}: ${locked.length} locked id(s) written.`);
    return;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      total: invariants.length,
      locked: locked.length,
      claimedNotLocked: claimed.map((i) => i.id),
      declaredUnlockable: unlockable.map((i) => i.id),
      claimsMissingFile: missingFiles,
      confirmedWithoutTest: confirmedBare.map((i) => i.id),
      seedWithTest: seedLocked.map((i) => i.id),
      dangling,
      mentionedNotCited: [...mentionsWithoutTitle(known, citationOptOut(invariants))].map(([id, files]) => ({ id, files: [...files] })),
    }, null, 2));
    return;
  }

  // QUIET IN `lint` (RA-1196). The full report is a working document — 137 `[confirmed]`
  // entries — and printing it on every lint run buries the one line that matters and
  // trains people to scroll past the whole thing. `--quiet` prints the verdict; the
  // report is what a run without `--quiet` is for.
  if (QUIET) {
    const problems = failures({ dangling, missingFiles, locked });
    if (problems.length) {
      console.error(`spec-coverage FAILED:\n${problems.map((x) => `  - ${x}`).join('\n')}`);
      process.exitCode = 1;
      return;
    }
    const mentionedQ = mentionsWithoutTitle(known, citationOptOut(invariants));
    console.log(`spec-coverage: ${locked.length} locked (floor ${LOCKED_FLOOR}), ${dangling.length} dangling, ${mentionedQ.size} mentioned but not cited in a title. Run it without \`--quiet\` for the full ladder.`);
    return;
  }

  const pct = (n) => `${((n / invariants.length) * 100).toFixed(1)}%`;
  console.log(`# L2 -> L3 coverage\n`);
  console.log(`**Locked** — a test names the invariant's ID: **${locked.length} of ${invariants.length}** (${pct(locked.length)}).`);
  console.log(`**Claimed** — the spec names a test file, but no test cites the ID: **${claimed.length}**.`);
  console.log(`**Declared unlockable** — names a test file, and says it is *deliberately not migrating* to Locked: **${unlockable.length}**.`);
  console.log(`**Bare** — neither: **${bare.length - claimedAll.length}**.\n`);
  console.log(`Claimed is not locked. It is a sentence a human wrote, and nothing checks that the named test still asserts this invariant. Converting Claimed to Locked is the migration this scheme exists to make possible. Declared-unlockable clauses are held out of it by their own sentence, and listed below so the decision stays visible.\n`);

  console.log('| Area | Invariants | Locked | Confirmed, untested |');
  console.log('|---|---|---|---|');
  for (const prefix of Object.values(loadPrefixes()).sort()) {
    const mine = invariants.filter((i) => i.prefix === prefix);
    if (!mine.length) continue;
    const l = mine.filter((i) => cited.has(i.id)).length;
    const c = mine.filter((i) => !cited.has(i.id) && i.status === 'confirmed').length;
    console.log(`| ${prefix} | ${mine.length} | ${l} | ${c} |`);
  }

  const optedOut = citationOptOut(invariants);
  const mentioned = mentionsWithoutTitle(known, optedOut);
  if (mentioned.size) {
    console.log(`\n## Mentioned in a test file, cited by no title — ${mentioned.size}\n`);
    console.log('These read as `Bare` above, but a test file names them somewhere other than a title — a docblock or an inline comment. Often that is a FIXABLE CITATION: the test asserts the invariant and only the title is missing. **Check that it does before adding one** — a citation on a test that asserts something else, or asserts the DEFECTIVE behaviour a finding reproduces, turns `unverifiable` into a false `passed`, which is worse than the gap. A clause that says it *deliberately names no test file* is excluded from this list for exactly that reason.\n');
    for (const [id, files] of [...mentioned].sort()) console.log(`- \`${id}\` — ${[...files].map((f) => `\`${f}\``).join(', ')}`);
  }

  if (missingFiles.length) {
    console.log(`\n## Claims naming a file that does not exist — ${missingFiles.length}\n`);
    for (const x of missingFiles) console.log(`- \`${x.id}\` (${x.file}) claims \`${x.claim}\``);
  }

  const section = (title, items, note) => {
    console.log(`\n## ${title} — ${items.length}`);
    if (note) console.log(`\n${note}`);
    for (const i of items) console.log(`- \`${i.id}\` (${i.file}:${i.line}) ${i.text.slice(0, 90)}`);
  };

  section('Declared unlockable — not migration candidates', unlockable,
    'Each says in its own text that no automated tier can lock it. Re-read the reason if the test surface changes; removing the sentence returns the clause to Claimed.');
  section('`[confirmed]` with no test', confirmedBare,
    'Claimed as ground truth and enforced by nothing. The Explorer treats these as hard oracle.');
  section('`[seed]` with a test — promotion candidates', seedLocked,
    'The executable check exists; only the prose is unpromoted. A human can clear these in one pass.');

  if (dangling.length) {
    console.log(`\n## Citations naming an unknown invariant — ${dangling.length}\n`);
    for (const id of dangling) console.log(`- \`${id}\` cited by ${[...cited.get(id)].join(', ')}`);
  }

  // IT CAN NOW FAIL, AND IT NOW RUNS (RA-1196).
  //
  // This module was invoked by nothing — not `lint`, not `ci.yml`, not any `agent-*`
  // workflow — and had no `process.exit` or `exitCode` anywhere, so it could not have
  // failed even if something had run it. The only path to a human was somebody typing
  // spec-coverage from memory, which means the number moved in one direction
  // between manual runs and nothing said when.
  //
  // Fatal on the two REAL errors, both clean today (checked before wiring it into
  // `lint`, so this does not land red):
  //   - a test cites an ID no spec defines — a typo, or an invariant that was deleted
  //     out from under its test
  //   - a spec claims a test file that does not exist
  //
  // The locked set is a RATCHET, not a threshold. The baseline is the list of ids in
  // `docs/qa/specs/_locked-floor.json` — a generated file, but never auto-regenerated
  // by `lint`: `--write-locked` is run by hand and the resulting diff is the
  // acknowledgement (RA-1315). A gate that rewrites its own baseline records nothing.
  // Both directions fail and both name what moved (RA-1830).
  const problems = failures({ dangling, missingFiles, locked });
  if (problems.length) {
    console.error(`\nspec-coverage FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nspec-coverage: ${locked.length} locked (floor ${LOCKED_FLOOR}), ${dangling.length} dangling, ${mentioned.size} mentioned-not-cited.`);
}

// Guarded so this module can be IMPORTED for its `citations()` map without
// printing the whole coverage report as a side effect (RA-1068). Running it directly
// is unchanged.
// try/catch is half the precedent (lead-reconcile.mjs:3747): without it, importing
// this module with no argv[1] THROWS rather than quietly not running.
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
