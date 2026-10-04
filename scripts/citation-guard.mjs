#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// Fail lint when a `file:line` citation in docs/ no longer points at what its own
// sentence says it points at (RA-658, RA-919).
//
// WHY RANGE-CHECKING IS NOT ENOUGH, measured on the case that prompted this. PR RA-1128
// was force-push rebased; `settleOrderWith`'s enrollment write moved from
// `payments.ts:44-52` to `:180-189`, and `:44-52` became `[PAY-1]`'s doc comment. The
// citation still resolved, was still in range, and pointed at a DIFFERENT INVARIANT —
// in `docs/qa/specs/payments.md`, the oracle, whose whole claim to authority is that
// it is checked evidence rather than prose. A guard that only checked existence and
// range would have passed all five drifted citations in that PR.
//
// THE ANCHOR. A sentence citing code almost always names the code: "…selects the rows
// it writes by `inArray(enrollments.courseId, courseIds)` + `studentUserId`
// (`payments.ts:180-189`)". So the check is: at least one backticked identifier in the
// citing sentence must appear inside the cited range. That is inferable from what is
// already written — no format change, no marker to remember.
//
// WHEN NO ANCHOR IS INFERABLE the citation is range-checked only, and the run REPORTS
// how many fell back. A guard that silently degrades to a weaker check on most of its
// corpus is the "detector that finds nothing looks like a healthy system" shape (RA-945),
// so the number is printed with the all-clear rather than left to be discovered.
//
// WHY FINDING THE ANCHOR IS NOT ENOUGH EITHER (RA-2211). PR RA-2208 inserted 8 lines near the
// top of `tenancy.ts` and re-pointed 5 of the 16 citations into it; the other 11 were left
// pointing 8 lines above what they name, and this guard exited 0 over all of them. Two
// distinct ways an anchor was found in the WRONG place:
//
//   1. THE ANCHOR MOVED WITH THE DRIFT. `[SUPER-14]` cited `` `setTenantStatus`
//      (`tenancy.ts:266-274`) ``, and `setTenantStatus` is declared on line 274 — the LAST
//      line of the stale range — so the identifier was found while the range pointed
//      overwhelmingly at `updateTenant`. A range that opens inside one block and only
//      reaches the declaration it names on its final line is the signature of a shift, not
//      of a correct citation. `declarationShift` below is that test.
//   2. THE ANCHOR MATCHED A LONGER IDENTIFIER — a token such as `createTenantInput`
//      answering for `createTenant`, which it merely CONTAINS. The match is on word
//      boundaries now (`namesIdentifier`), which changed nothing about the corpus as it
//      stands — measured at zero re-classified citations over 298 — and closes the shape.
//      THIS ONE IS PROSPECTIVE, NOT HISTORY, and the distinction is worth the lines:
//      RA-2211 named `` `createTenant()` … `tenancy.ts:80` `` (`docs/tenant-provisioning.md`)
//      as the instance, and it is not one. That citation is a markdown TABLE ROW, and
//      `anchorsFor` deliberately scopes anchors to the cell, so it carries NO anchors at
//      all and is range-checked only — restoring the stale `:80` still exits 0, on this
//      guard as on the old one. The substring hole was real and is now shut; nothing in
//      today's corpus was falling through it, which is exactly why the measurement above
//      is zero rather than merely small. Do not re-derive a history from this entry.
//
// AND THE SHIFT IS REPORTED AS A BLOCK, not only per citation. One edit moves every
// coordinate below it by the same `k`, so agreeing shifts into one file are evidence about
// the FILE: the run names it once, with the count and the total, because the citations the
// anchor cannot judge at all (11 of the 16 in RA-2208 named no identifier, or named one
// declared above the drift) are stale for the same reason and nothing else will say so.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// STATUSES only — `spec-lib` does its `readdirSync` inside `specFiles()`, not at module
// load, so importing it here does not give this file a `docs/qa/specs` dependency. That
// matters: this guard runs correctly in a tree that has no spec directory at all.
import { STATUSES } from './spec-lib.mjs';

/**
 * The extensions a coordinate may name: the reference adopter's, and the source files of the
 * common languages besides, because an adopter's stack is its own (#15, #16). A coordinate
 * into a file whose extension is missing here is not read at all, so without them a Python
 * project's `core.py:12` would pass every run unchecked. The existence, range and anchor
 * checks are language-neutral. `declarationShift` reads JavaScript declarations only; it
 * finds none in another language, so there it never accuses.
 */
export const SOURCE_EXT =
  '(?:ts|tsx|mjs|cjs|js|json|yml|yaml|sql|sh|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|ex|exs|toml)';

const CITATION = new RegExp(String.raw`\x60([\w./-]+\.${SOURCE_EXT}):(\d+)(?:-(\d+))?\x60`, 'g');
// THE CONTINUATION SHORTHAND, which the docs use constantly and the first version of
// this guard could not see: a full citation, then bare `:NNN` for further coordinates
// in the same file — "`storefront.ts:752`, `:945`, `:1333`". 73 of the 238 coordinates
// in `docs/` are written this way, 39 of them in payments.md, the oracle whose drift
// prompted this guard. Unchecked AND uncounted, so the run's own all-clear understated
// its corpus by 31% while claiming to be the answer to silent-absence (RA-945).
//
// They are not weakly checked; they were not checked at all — and three were stale on
// the branch that claimed all 75 were fixed, one of them on a `[confirmed]` clause
// whose five coordinates were 1-of-5 correct.
const BARE = /`:(\d+)(?:-(\d+))?`/g;
// A file named WITHOUT a line — `tests/unit/order-status-writers.test.ts` followed by
// `` (`:123`, `:212`) ``. Both coordinates are correct and both were dropped, because
// an antecedent had to carry a `:NNN` of its own (RA-1212).
const BARE_PATH = new RegExp(String.raw`\x60([\w./[\]-]+\.${SOURCE_EXT})\x60`, 'g');
// THE LINE NUMBER WRITTEN OUTSIDE THE BACKTICKS — `` `tenancy.ts` L179-214 `` (RA-2224).
// Before this it was not a citation at all: `BARE_PATH` took the path as an antecedent
// and the numbers were dropped without being counted, so `[SUPER-10]` — a `[confirmed]`
// clause — sat in none of the all-clear's three buckets while RA-2208's +8 shift cut its
// range off before the `memberships` insert and the `bus.publish` it cites as evidence.
// Now it is a coordinate like any other: resolved, range-checked, anchored.
//
// Measured when adopted: 21 in `docs/`, all in the oracle. Eighteen are in
// `docs/qa/specs/auth.md` and name `node_modules/better-auth/…` — a dependency's build
// output, outside the tracked tree by design — which is what `isExternal` below is for; a
// nineteenth there named the same kind of file by basename alone and is qualified in the
// change that added this. The other three are in `superadmin.md`, one of which named
// `page.tsx` bare — 67 files match — and is qualified likewise.
const LINE_AFTER = new RegExp(String.raw`\x60([\w./[\]-]+\.${SOURCE_EXT})\x60\s*L(\d+)(?:-(\d+))?\b`, 'g');

/**
 * A coordinate into a dependency, which this guard cannot and should not judge (RA-2224).
 *
 * A dependency tree is not in `git ls-files`, so resolving a coordinate into one reports
 * "no such file in the repository" — correct about the index and wrong about the claim:
 * the reference adopter's `auth.md` cites Better Auth's shipped `.mjs` deliberately, as
 * evidence of a default it accepts. Those coordinates move when the DEPENDENCY is bumped,
 * which is a different event with a different owner. So they are COUNTED AND NAMED as
 * external in the all-clear rather than failed or silently dropped — the RA-945 rule is
 * that the run says what it did not check, not that it checks everything.
 *
 * WHAT COUNTS AS A DEPENDENCY: a path NO tracked file can resolve to (exactly, or by the
 * basename suffix `resolvePath` accepts) AND that the adopter's git ignores (#108). Until
 * #108 this was `/^node_modules\//`, Node's tree alone; once the guard read Python, Go and
 * the rest (#16), a `.venv/…/site-packages/…` coordinate failed as missing on every other
 * stack. The ignore file is where every stack already names the trees it doesn't track,
 * so reading it keeps the rule fixed and stack-neutral without a list of folder names to
 * maintain. "Untracked" alone is not enough: a mistyped repo path is untracked too, and
 * counting it external would turn a real failure into a silent pass (`K-PRIN-8`). A typo
 * is not ignored, so it still fails; a tracked file is judged wherever it lives.
 *
 * "Ignored" is not enough either (kanon#120). git calls an untracked path ignored whenever a
 * pattern covers it, even inside a directory the repository tracks: GitHub's stock Python
 * template ignores `lib/`, so with `src/pkg/lib/a.py` force-added, a typo `src/pkg/lib/aa.py`
 * and `src/pkg/lib/nested/x.py` both read as ignored and would pass unjudged. So the
 * SHALLOWEST ignored directory above the path must hold no tracked file: a dependency tree
 * is one the repository keeps none of its own files in. `node_modules/` and `.venv/` hold
 * none; `src/pkg/lib/` holds `a.py`, so a coordinate under it is the repository's and is
 * judged. A path ignored only by a file pattern (no ignored directory above it) keeps the
 * old rule. What this cannot see is an allow-list ignore file (`/*`, `!/src/`): there a
 * typo in a top-level folder (`scr/…`) is an ignored directory with nothing tracked in it,
 * exactly like `node_modules/`. That case is why the all-clear names every external PATH,
 * not only a count per doc — a reader can see a typo there.
 *
 * @param {string} file the cited path
 * @param {string[]} tracked
 * @param {(path: string) => boolean} ignored whether git ignores the path
 */
export const isExternal = (file, tracked, ignored) => {
  if (tracked.some((f) => f === file || f.endsWith(`/${file}`))) return false;
  if (!ignored(file)) return false;
  const segments = file.split('/');
  for (let k = 1; k < segments.length; k += 1) {
    const dir = `${segments.slice(0, k).join('/')}/`;
    if (ignored(dir)) return !tracked.some((f) => f.startsWith(dir));
  }
  return true;
};

/**
 * `ignored` as the adopter's git answers it, from the working directory, by the ignore
 * rules alone (`--no-index`). `isExternal` asks about an untracked path and about the
 * directories above it — and without `--no-index` git answers "not ignored" for a
 * directory that holds a tracked file, which is precisely the directory kanon#120 needs
 * to see as ignored. The path need
 * not exist: CI checks out the index, which holds no `.venv/`, and git matches a pattern
 * such as `.venv/` against the path's parent directories anyway.
 * Only an answer of "ignored" (exit 0) makes a path external. Anything else, including
 * git's error for a path outside the repository (`../x.py`), leaves the coordinate to be
 * judged, so it fails as "no such file": an error never turns into a pass.
 *
 * @returns {(path: string) => boolean}
 */
export const gitIgnored = () => {
  const seen = new Map();
  return (path) => {
    if (!seen.has(path)) {
      const r = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', path], { stdio: 'ignore' });
      seen.set(path, r.status === 0);
    }
    return seen.get(path);
  };
};
// Every coordinate on one line, in order, each carrying the file it resolves against:
// a bare `:NNN` belongs to the nearest full citation BEFORE it on the same line, which
// is what the shorthand means. One with nothing before it names no file: it is dropped,
// or — where `bareNeedsFile` says the form is banned — carried out with a null file so
// the caller reports it. See the note below the sort for which, and why.
export const coordinatesIn = (line, bareNeedsFile = false) => {
  const out = [];
  const all = [
    ...[...line.matchAll(CITATION)].map((m) => ({ i: m.index, text: m[0], file: m[1], a: +m[2], b: +(m[3] ?? m[2]), bare: false })),
    ...[...line.matchAll(BARE)].map((m) => ({ i: m.index, text: m[0], file: null, a: +m[1], b: +(m[2] ?? m[1]), bare: true })),
    // Antecedent only — it names no coordinate itself, so it is never checked.
    // `a: null` deliberately — a path names no coordinate, and giving it 0 made it
    // CERTIFIABLE: `0 > len` is false so the range check passed vacuously, and the
    // enclosing window `slice(max(0, a - 9), a - 1)` became `slice(0, -1)` — the whole
    // file — so any token anchored it. A meaningless coordinate reported as
    // anchor-checked is RA-945 inside the guard built to answer it (RA-1220 review).
    ...[...line.matchAll(BARE_PATH)].map((m) => ({ i: m.index, text: m[0], file: m[1], a: null, b: null, bare: false, pathOnly: true })),
  ];
  // A path followed by `L<n>` is a coordinate, and it REPLACES the path-only entry
  // `BARE_PATH` made at the same offset — one span, one role.
  for (const m of line.matchAll(LINE_AFTER)) {
    const k = all.findIndex((c) => c.pathOnly && c.i === m.index);
    if (k !== -1) all.splice(k, 1);
    all.push({ i: m.index, text: m[0], file: m[1], a: +m[2], b: +(m[3] ?? m[2]), bare: false, lineAfter: true });
  }
  all.sort((x, y) => x.i - y.i);
  // A bare `:NNN` is a CONTINUATION only when a full citation precedes it ON THIS
  // LINE. With nothing before it, it is not an unresolvable citation — it is not a
  // citation at all, and the corpus is full of them: `:00` in a cron expression,
  // `:75` referring to a line of the document you are reading, and whole legacy
  // notes whose file is named once in a heading and never repeated.
  //
  // Reporting those as findings would be the guard crying about correct prose, which
  // costs more than the drift it catches — a check people learn to override is worse
  // than no check. So they are DROPPED, and the all-clear counts only what it read.
  //
  // EXCEPT WHERE THE FORM IS BANNED (`bareNeedsFile`, RA-1479). Measured over `docs/` at
  // the time: of the 112 antecedent-less bare coordinates, 110 were continuations whose
  // file was named on an EARLIER LINE — 91 of them in one project brief's wrapped prose,
  // and 12 in `legacy-api-payloads.md`, which cites a CakePHP tree that is not in this
  // repository and can never resolve. Banning the form everywhere would fire on all of
  // those, which is the false-positive shape every relaxation above was forced by.
  // (The brief 91 are out of the corpus since RA-1742 — `docs/projects/**` is not read —
  // so the count is smaller now and the conclusion is unchanged: the legacy notes alone
  // still make a blanket ban a false-positive machine. `node scripts/citation-guard.mjs`
  // prints today's discard total and names the documents it came from.)
  //
  // The remaining two are genuine SELF-REFERENCES — "*See `:177` for the fully
  // qualified statement*" pointing at another line of the same document — and both sat
  // in `docs/qa/specs/payments.md`, both introduced by `71a8eb0`, both already off by
  // two lines because the same commit inserted two lines above them, and both invisible
  // because the guard discarded them. A line number in prose rots on ANY insertion
  // above it, and a range check cannot see it: `:177` and `:179` are both in bounds.
  // So in the oracle — the one corpus whose authority rests on being checked evidence —
  // the form is refused outright and the author writes a quoted marker phrase instead,
  // the same answer RA-1362 and RA-1471 gave for code comments.
  let file = null;
  let discarded = 0;
  // How many of `discarded` were a bare `:0`, as opposed to a bare `:NNN` with no file
  // before it. The all-clear names the two separately, because "no file named on the
  // line" is FALSE for `` `src/a.ts` … `:00` `` and the one line whose job is accurate
  // disclosure must not say the opposite of what happened (RA-1221).
  let lineZero = 0;
  for (const c of all) {
    if (c.pathOnly) { file = c.file; continue; }
    // LINE 0 IS NOT A LINE. `:00` in a cron expression parses to 0, and with a
    // filename earlier on the line it resolved, then certified: `0 > len` is false so
    // the range check passed vacuously, and `slice(a - 1, b)` on a 0 is empty while
    // the enclosing window becomes the whole file, so any token anchored it (RA-1220
    // review). A BARE `:0` is discarded like any other coordinate that names nothing —
    // it is the cron's `:00`, not a citation.
    //
    // A FULL CITATION naming line 0 is different, and discarding it was three defects
    // (RA-1221): `` `src/a.ts:0-5` `` is a typo a human should fix, and it vanished with no
    // finding; the all-clear then called it "no file named", which is false; and because
    // the discard ran BEFORE the antecedent was taken, every `:NNN` continuation after it
    // on the line lost its file and was discarded too — one typo removed a whole line of
    // coordinates from the corpus. So it still becomes the antecedent, and it is carried
    // out flagged so `auditCitations` reports it. It is never certified: the flag is
    // checked before any range or anchor is computed.
    if (c.a < 1 && c.bare) { discarded += 1; lineZero += 1; continue; }
    if (!c.bare) { file = c.file; out.push(c.a < 1 ? { ...c, lineZero: true } : c); continue; }
    if (file) out.push({ ...c, file });
    else if (bareNeedsFile) out.push(c);
    else discarded += 1;
  }
  // Carried on the array, not returned separately: every caller iterates it, and a
  // second return value is one more thing a caller can forget to read (RA-1212).
  Object.defineProperty(out, 'discarded', { value: discarded, enumerable: false });
  Object.defineProperty(out, 'discardedLineZero', { value: lineZero, enumerable: false });
  return out;
};
// A backticked span worth treating as an identifier: it looks like code rather than
// prose. Bare words ("the order", "paid") are excluded — anchoring on those would make
// the check pass on almost anything.
//
// THE SPANS ARE PAIRED FIRST AND FILTERED AFTER. This was one regex,
// /`([^`\n]{2,120})`/g, whose length floor sat INSIDE the pairing: a one-character
// span such as `&` could not match, so the engine restarted at its CLOSING backtick
// and paired every later backtick one out of phase. The prose BETWEEN two spans became
// a "span" and each real identifier after it was lost. Seen at
// `html-escaping-invariants.md` (a literal `&amp;` "where the sender meant `&`"), where
// the SMS coordinate lost its anchor, and where a bare `:NNN` whose own clause named
// an identifier found none and INHERITED one from elsewhere in the sentence instead.
// `codeSpans` pairs as CommonMark does; the length bounds apply to what it returns.
const MIN_SPAN = 2;
const MAX_SPAN = 120;

/**
 * Every inline code span in `text`, paired as CommonMark pairs them: a run of N
 * backticks opens a span and the next run of EXACTLY N closes it, so a double-backtick
 * span may carry a single backtick inside. A run with no matching closer is literal
 * text, and scanning resumes after it. One leading and one trailing space are stripped
 * when both are present — `` `` `&amp;` `` `` is the span `` `&amp;` ``.
 */
export const codeSpans = (text) => {
  const runs = [...text.matchAll(/`+/g)];
  const out = [];
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i];
    const j = runs.findIndex((r, k) => k > i && r[0].length === open[0].length);
    if (j === -1) continue;
    let body = text.slice(open.index + open[0].length, runs[j].index);
    if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim()) body = body.slice(1, -1);
    out.push(body);
    i = j;
  }
  return out;
};
const identifierSpans = (text) =>
  codeSpans(text).filter((x) => x.length >= MIN_SPAN && x.length <= MAX_SPAN && !x.includes('\n'));
// DERIVED, NOT RESTATED. This predicate listed `seed|confirmed` while `spec-lib.mjs`
// declares four statuses, so `[structural]` and `[retired]` were kept as anchor
// candidates — the markup the exclusion below exists to drop. It stayed latent because
// `anchorsFor` only needs SOME token to land (`anchorTokens.some(...)`) and clause prose
// here usually carries a real identifier alongside; on a sparse line whose only other
// backticked token is the status tag, the guard reports "the range names none of what
// its sentence does" about the tag itself. A half-list is the second opinion
// `label-guard.mjs:14-16` argues against, so read the list from its one authority (RA-2090).
const STATUS_TAG = new RegExp(`^\\[(${STATUSES.join('|')})\\]$`);
const looksLikeCode = (s) =>
  !/\s{2,}/.test(s) &&
  (/[.(){}[\]<>=]/.test(s) || /[a-z][A-Z]/.test(s) || /_/.test(s)) &&
  !new RegExp(String.raw`^[\w./-]+\.${SOURCE_EXT}:\d+(-\d+)?$`).test(s) &&
  // The clause's OWN prefix is not evidence about the code. Every clause line opens
  // with `[AREA-N]` `[seed|confirmed]`, so without this every citation on a clause
  // inherits two anchors that can never appear in a source file — and then reports
  // "the range names none of what its sentence does" about tokens the sentence only
  // names because of the markup. Four confirmed-clause false positives came from
  // exactly this, and one of them buried a real anchor (`<li>`) that tokenises too
  // short to keep.
  !/^\[[A-Z]+-\d+\]$/.test(s) &&
  !STATUS_TAG.test(s) &&
  // A BARE FILE PATH IS NOT EVIDENCE ABOUT A RANGE. `…rendered at
  // `src/app/…/page.tsx:198` and `course-wizard.tsx:797-800`` made the wizard's
  // coordinate answer for the OTHER file's path, which no line of the wizard contains.
  // The `:NNN` form is already excluded above; this is the same rule for a path cited
  // without one, which the sentence-splitting cannot separate.
  !new RegExp(String.raw`^[\w./[\]-]+\.(?:${SOURCE_EXT}|md)(:\d+(-\d+)?)?$`).test(s);

/** Split a markdown line into sentences, keeping the citation's own sentence. */
const sentenceAround = (line, index) => {
  const bounds = [...line.matchAll(/(?<=[.!?])\s+(?=[A-Z(*`])/g)].map((m) => m.index);
  let start = 0;
  for (const b of bounds) { if (b <= index) start = b; else break; }
  const end = bounds.find((b) => b > index) ?? line.length;
  return line.slice(start, end);
};

/**
 * Distinctive word-tokens of an identifier. Prose qualifies what code leaves bare —
 * a doc says `orders.status` where the schema line says `status: text('status')` — so
 * matching the whole string flags a citation that is perfectly correct. Splitting into
 * tokens and dropping the ones that carry no information is what makes the anchor
 * usable on real prose instead of only on exact quotations.
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'to', 'of', 'in', 'on', 'and', 'or', 'not', 'it', 'id', 'db', 'ts', 'set', 'get', 'if', 'as', 'by', 'at']);
export const tokensOf = (identifier) => {
  const parts = [...new Set(String(identifier).split(/[^A-Za-z0-9_]+/))].filter(Boolean);
  const kept = parts.filter((t) => t.length >= 4 && !STOPWORDS.has(t.toLowerCase()));
  // An identifier whose every token is too short to be distinctive — `<li>`, `id`,
  // `db` — yields nothing rather than yielding noise. Returning a 2-character token
  // would match almost any line; returning none correctly demotes the citation to
  // range-checked, which the run reports.
  return kept;
};

/**
 * Does `text` name this identifier, as an identifier rather than as a substring?
 *
 * `range.includes(t)` let `createTenantInput` answer for `createTenant` — the second
 * failure shape in RA-2208's sweep, and the more dangerous of the two because the two names
 * are 8 lines apart and both plausible. `\b` is not enough on its own: `$` is a legal
 * identifier character and not a word character, so `foo` would match inside `$foo`.
 *
 * Measured before adopting, because every relaxation in this file was forced by a false
 * positive and a tightening is the same bet run backwards: over the 298-citation corpus
 * this re-classifies ZERO citations. It is a closed hole, not a new verdict.
 */
export const namesIdentifier = (text, token) =>
  new RegExp(`(?<![\\w$])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text);

/**
 * Names declared at the TOP LEVEL of a file, by line (1-indexed, several lines per name
 * where a name is declared twice — an overload, a re-`const` in a different branch).
 *
 * TOP-LEVEL ONLY, and that is the whole difference between this and
 * `enclosingDeclarations`. A nested declaration is not evidence about where a coordinate
 * *should* point: `docs/qa/specs/observability.md` names `pagedBusinessEvents` — declared
 * six levels of indentation down in `sst.config.ts:1564` — while deliberately citing six
 * `alarmDescription`s eight hundred lines ABOVE it, to say they are out of that array's
 * scope. Reading nested declarations reported all six as drifted. They are correct.
 */
export const topLevelDeclarations = (lines) => {
  const out = new Map();
  const TOP_DECL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/;
  lines.forEach((l, i) => {
    const m = TOP_DECL.exec(l);
    if (!m) return;
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push(i + 1);
  });
  return out;
};

/** A line that carries no code — blank, or line/block comment. */
const BLANK_OR_COMMENT = /^\s*(?:\/\/|\/\*|\*|$)/;

/**
 * The names a sentence is ABOUT, as opposed to the tokens it merely contains (RA-2254).
 *
 * `tokensOf` splits `` `orders.status` `` into `orders` and `status`, which is right for
 * the anchor test — prose qualifies what code leaves bare. It is wrong for
 * `declarationShift`, whose verdict is "re-derive this coordinate": `orders` is a
 * top-level `pgTable` in `commerce.ts`, so `[PAY]`'s correct citation of the
 * `orderStatus` enum at `commerce.ts:36-43` measured as a +10 shift towards the TABLE,
 * and the printed remedy told its author to replace a right coordinate with a wrong one.
 * Sixteen currently-passing coordinates were one prose edit away from that.
 *
 * So only a backticked span that IS one identifier — optionally called, `` `createCourse()` ``
 * or `` `setTenantStatus(id, status)` `` — may govern where a coordinate should point. A
 * dotted, spaced or otherwise compound span still anchors; it just cannot accuse.
 * Measured before adopting: all seven citations RA-2252 caught (its parent `6904a979^`,
 * audited against its own tree) are still caught, because each was named by a whole
 * identifier. RA-2254's sweep (anchor gate bypassed, every backticked span on the line
 * pooled — far wider than the live cell/segment scope) goes from 14 hits to 11: the
 * three dropped are exactly the compound-span cases, `orders`/`payments` out of
 * `orders.status`-style spans, `payments.md`'s `commerce.ts:36-43` among them.
 *
 * WHAT IT DOES NOT FIX, said plainly: the remaining 11 are whole identifiers the line
 * does name, and some are correct coordinates (`server-error.ts:38` against
 * `isNextControlFlow` at 41). A whole identifier named in passing is indistinguishable
 * from the one the sentence is about, so the finding's text names that possibility
 * instead of only saying "insertion", and the CLI footer says to confirm by content
 * before moving a coordinate.
 */
export const strongNames = (anchors) => [
  ...new Set(
    anchors
      .map((x) => String(x).trim().replace(/\([^()]*\)$/, ''))
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x)),
  ),
];

/**
 * THE DECLARATION IS THE STRONGEST EVIDENCE ABOUT WHERE A THING IS, so when the citing
 * sentence names one, the coordinate has to be consistent with it (RA-2211).
 *
 * A correct citation stands in one of exactly two relations to the declaration it names:
 * the range **starts at or inside** it (`getTenantDetail` (`tenancy.ts:244-246`) targets a
 * statement in its body), or the range **opens on its doc comment** a few lines above
 * (`tenancy.ts:192-202` deliberately includes the block comment). Both are admitted.
 *
 * What is refused is a range that begins inside a DIFFERENT block — code, not comment,
 * sits between the range start and the declaration — because that is what a shift
 * produces and nothing else does. `[SUPER-14]`'s `266-274` is the worked example: eight
 * lines of `updateTenant`'s body, then `setTenantStatus`'s declaration on the last line.
 *
 * DELIBERATELY ONE-DIRECTIONAL. A declaration ABOVE the range start is always accepted,
 * because "the coordinate points into this function's body" is the commonest correct
 * shape in the corpus and is indistinguishable from an upward drift (lines deleted).
 * So this catches the downward direction only — which is the direction an INSERTION
 * produces, and insertions are what PRs do. Said plainly rather than left implied: a
 * guard whose claimed reach exceeds its real one is the failure shape (RA-945) the rest of
 * this file exists to answer.
 *
 * @returns {{token: string, declLine: number, shift: number}|null}
 */
export const declarationShift = (lines, a, anchorTokens) => {
  const decls = topLevelDeclarations(lines);
  const named = anchorTokens.filter((t) => decls.has(t));
  if (!named.length) return null;
  const consistent = named.some((t) =>
    decls.get(t).some((d) => d <= a || lines.slice(a - 1, d - 1).every((l) => BLANK_OR_COMMENT.test(l))),
  );
  if (consistent) return null;
  // Every declaration of every named token is now below `a` with code in between, so the
  // NEAREST one is what the coordinate most plausibly meant and its distance is the shift.
  let best = null;
  for (const t of named) {
    for (const d of decls.get(t)) {
      if (!best || d < best.declLine) best = { token: t, declLine: d, shift: d - a };
    }
  }
  return best;
};

/**
 * Names declared at or above `line` whose block plausibly encloses it — the nearest
 * preceding top-level `export const X` / `function X` / `class X`, plus any declaration
 * within the preceding 60 lines. Deliberately generous: this only ever ADMITS a
 * citation, so a false positive here costs precision on a check whose job is to catch
 * coordinates that moved, while a false negative rejects correct prose.
 */
export const enclosingDeclarations = (lines, line) => {
  const names = [];
  const DECL = /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/;
  for (let i = line - 1; i >= 0 && i > line - 400; i -= 1) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    names.push(m[1]);
    // A top-level declaration (no leading whitespace) closes the search: anything
    // above it encloses a different block.
    if (/^\S/.test(lines[i])) break;
  }
  return names;
};

/**
 * The invariant whose prose carries this citation, and whether a human has promoted it.
 *
 * `[confirmed]` is HARD ORACLE: the Explorer treats it as ground truth and files bugs
 * against it, so a confirmed clause pointing at code that no longer does the thing does
 * not merely mislead a reader — it manufactures false positives from a trusted source.
 * `[seed]` is an agent's proposal awaiting promotion, where a stale coordinate is a
 * documentation defect and nothing more. Same check, different blast radius, so the
 * report says which. Measured instance: `[FILTER-3]` cited four decline-persistence
 * sites, of which two named code that had not called `persistFailedPayment` for
 * months, and every gate was green (RA-1196).
 */
// DERIVED FROM STATUSES, and the list marker is OPTIONAL (RA-2105). This restated
// `(seed|confirmed)` — a second half-list of the same four RA-2090 removed seventy lines
// above — and required a leading `-`/`*`. Both halves cost attribution, measured on the
// corpus at the time of the fix: 1 clause got the WRONG id (`[ESCAPE-5]` `[structural]`
// reported as `[ESCAPE-4]` `[confirmed]`, inheriting the hard-oracle bucket from its
// neighbour) and 38 got none at all — every bare-paragraph declaration, which is the
// form most `[structural]` contracts use.
//
// THE ID STAYS MANDATORY, and that is what makes the optional marker safe. Every spec
// opens with a LEGEND defining the tags — `- `[confirmed]` — a human has confirmed…` —
// which `spec-lib.mjs:24` records as "bulleted and tag-leading and therefore
// indistinguishable from an invariant by shape alone", and which silently got numbered
// once already. A legend entry carries no `[AREA-N]`, so requiring one excludes all 18
// without needing to know they exist.
const CLAUSE = new RegExp(
  `^\\s*(?:[-*]\\s+)?\`\\[([A-Z]+-\\d+)\\]\`\\s+\`\\[(${STATUSES.join('|')})\\]\``,
);
export const clauseAt = (lines, index) => {
  for (let i = index; i >= 0; i -= 1) {
    const m = CLAUSE.exec(lines[i]);
    if (m) return { id: m[1], status: m[2] };
    // A heading ends the clause's scope: prose below one belongs to the section, not
    // to the last clause above it.
    if (/^#{1,6}\s/.test(lines[i])) return null;
  }
  return null;
};

export const resolvePath = (cited, tracked, rangeHasAnchor) => {
  if (tracked.includes(cited)) return { path: cited };
  const matches = tracked.filter((f) => f === cited || f.endsWith(`/${cited}`));
  if (matches.length === 1) return { path: matches[0] };
  if (matches.length === 0) return { error: 'no such file in the repository' };
  // AMBIGUOUS BY BASENAME — `courses.ts` is both a schema and a service here, and the
  // docs cite bare names by convention. Rather than failing prose that a human reads
  // without difficulty, let the anchor disambiguate: if exactly one candidate's cited
  // range contains what the sentence names, that is the file meant. If none or several
  // do, the citation genuinely is ambiguous and says so.
  if (rangeHasAnchor) {
    const fits = matches.filter(rangeHasAnchor);
    if (fits.length === 1) return { path: fits[0], disambiguatedBy: 'anchor' };
  }
  return { error: `ambiguous — matches ${matches.length} files (${matches.slice(0, 3).join(', ')}); qualify the path` };
};

/**
 * What the citing sentence names, as identifiers and as distinctive tokens. Exported
 * so that anything PROPOSING a repair ranks candidates by the same evidence the check
 * will judge it against — a fixer scored on different tokens can confidently suggest a
 * line the guard then rejects.
 */
/** The cited range with COMMENTS REMOVED.
 *
 *  The anchor is a substring test, so a single common token matched English prose and
 *  certified a coordinate that pointed at nothing: `orders.status` "resolved" to
 *  `// … but the status is`, on the strength of the word `status` (RA-1198 review).
 *  A citation's claim is about code, so comments are not evidence for it — and the
 *  guard reporting a comment as a match is worse than reporting nothing, because it
 *  green-lights the coordinate a human would otherwise re-check.
 *
 *  Deliberately crude: line and block comments, and nothing about strings. A citation
 *  that genuinely means a comment (a documented rationale) loses its anchor and falls
 *  back to range-checking, which the run reports as such. */
export const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1').replace(/^\s*\*.*$/, ''))
    .join('\n');

export const anchorsFor = (line, index, inherited) => {
  // SCOPED TO THE TEXT BEFORE THIS CITATION, back to the previous one. Prose names a
  // thing and then cites it, and a sentence often chains several: "note bodies are
  // plain text (`enrollment-notes.ts:14` -> `enrollment-notes-dialog.tsx:85`,
  // `{n.body}` under `whitespace-pre-wrap`)". Pooling the whole sentence demanded that
  // the STORAGE citation contain the RENDERING side's identifiers, and reported a
  // correct coordinate as drifted. Each citation answers for what its own half names.
  const sentence = sentenceAround(line, index);
  const offset = index - line.lastIndexOf(sentence, index);
  const before = sentence.slice(0, offset);
  // Back to the previous coordinate of ANY kind — a bare `:NNN` ends a segment just as
  // a full citation does. Scoping only to full citations pooled a whole table cell's
  // identifiers onto each of its continuations, so `(`:1358` load; `:1365` returns
  // early if already `paid`)` demanded that the LOAD line contain `pending_payment`,
  // and reported two correct coordinates as drift. Each coordinate answers for the
  // clause that introduces it, which is the phrase between it and the one before.
  const prev = [...before.matchAll(CITATION), ...before.matchAll(BARE), ...before.matchAll(LINE_AFTER)].sort((x, y) => x.index - y.index);
  const last = prev[prev.length - 1];
  let segment = last ? before.slice(last.index + last[0].length) : before;
  // A MARKDOWN TABLE CELL IS ITS OWN CLAUSE. These docs put the whole transition table
  // in one line, so without this the anchor pooled every column's identifiers onto a
  // coordinate in a later column: `| ... | pending_payment | earlier read (`:1358`
  // load; ...)` demanded that the ORDER-LOAD line contain `pending_payment`, and
  // reported a correct coordinate as drift. The cell that introduces a coordinate is
  // the claim it answers for; the row's other columns are different claims.
  const cell = segment.lastIndexOf('|');
  if (cell !== -1) segment = segment.slice(cell + 1);
  const anchors = identifierSpans(segment).filter(looksLikeCode);
  // INHERIT WHEN THE SEGMENT IS EMPTY (RA-1212). The docs name the identifier once,
  // before the FIRST coordinate — "`storefront.ts:752`, `:945`, `:1333`" — so every
  // continuation's own segment is `, ` and yields nothing. Reading the shorthand
  // therefore added 53 coordinates and exactly ZERO anchors: all of them demoted to
  // range-checked, which only asserts the line exists. `[FILTER-2]` was 1-of-5 correct
  // on a `[confirmed]` clause with the guard exiting 0 over it.
  //
  // ONLY as a fallback for an EMPTY segment, which is what keeps the table-cell fix
  // intact: a continuation that introduces its own identifier answers for that one,
  // and a cell in a one-line transition table still cannot pool its neighbours'.
  // INHERITANCE STOPS AT A CLAUSE BOUNDARY. A continuation belongs to the phrase that
  // introduced it, and a sentence often moves on between coordinates: "…`X` is
  // `managesTransaction` (`a.ts:1`), and so is `Y` (`:2`), so `Z` opens separate
  // blocks — `:3` for the read, `:4` for the write". `:3` and `:4` answer for the
  // BLOCKS clause, not for `managesTransaction` three clauses back. Inheriting across
  // that reported a correct coordinate as drift — the same false-positive shape every
  // relaxation in this file was forced by.
  //
  // The boundary is prose: an em dash, a semicolon, or a `, and`/`, so` join. Crude
  // deliberately, and it only ever WITHHOLDS inheritance, so the failure mode is a
  // demotion to range-checked rather than a wrong verdict.
  const brokeClause = /[—;]|,\s+(?:and|so|but|which|where)\b/.test(segment);
  if (brokeClause) return { anchors, anchorTokens: [...new Set(anchors.flatMap(tokensOf))], clauseBroken: true };
  if (!anchors.length && inherited?.length) {
    return { anchors: inherited, anchorTokens: [...new Set(inherited.flatMap(tokensOf))], inheritedAnchors: true };
  }
  return { anchors, anchorTokens: [...new Set(anchors.flatMap(tokensOf))] };
};

/**
 * THE ORACLE, where a line number in prose is refused rather than discarded (RA-1479).
 *
 * `docs/qa/specs/**` is the L2 oracle: the Explorer files bugs against a `[confirmed]`
 * clause, so its coordinates are the one corpus whose whole claim to authority is that
 * they are checked evidence. That is also the only corpus where an antecedent-less bare
 * `:NNN` was measured to be a genuine self-reference rather than a wrapped continuation
 * — see the note in `coordinatesIn` for the counts — so it is where the form can be
 * banned without the guard crying about correct prose everywhere else.
 */
export const isOracleSpec = (path) => path.startsWith('docs/qa/specs/');

/**
 * @typedef {typeof import('./spec-lib.mjs').STATUSES[number]} Status — DERIVED, not
 *   listed (RA-2138): this said `'seed'|'confirmed'` after `clauseAt` had been widened to
 *   return all four, which is the half-list RA-2090 and RA-2105 each closed elsewhere in this
 *   file. `STATUSES` is a const tuple, so this is the literal union, not `string`.
 * @typedef {{id: string, status: Status}} Clause
 * @typedef {{at: string, citation: string, problem: string, clause: Clause|null}} Finding
 * @typedef {{path: string, shift: number, count: number, citations: number}} Block
 */

/**
 * @param {string[]} docs
 * @param {(path: string) => string} readFile
 * @param {string[]} tracked
 * @param {{bareNeedsFile?: (doc: string) => boolean, ignored?: (path: string) => boolean}} [options]
 *   `ignored`: whether git ignores a path, for `isExternal`. Without it, nothing is external.
 * @returns {{findings: Finding[], checked: number, anchored: number, viaEnclosing: number,
 *            viaEnclosingAt: string[], discarded: number, discardedLineZero: number,
 *            discardedBy: Record<string, number>, external: number,
 *            externalBy: Record<string, number>, externalPaths: Record<string, string[]>,
 *            blocks: Block[]}}
 */
export const auditCitations = (docs, readFile, tracked, options = {}) => {
  const bareNeedsFile = options.bareNeedsFile ?? isOracleSpec;
  const ignored = options.ignored ?? (() => false);
  const findings = [];
  const discardedBy = {};
  // Per TARGET file (the cited `.ts`, not the citing doc): every shift measured into it,
  // and how many coordinates point at it at all. One edit moves everything below it by the
  // same `k`, so agreement across citations is evidence about the file (RA-2211).
  const shiftsByFile = new Map();
  const citationsByFile = new Map();
  let checked = 0;
  let anchored = 0;
  // Of `anchored`, the coordinates whose anchor was found ONLY through the enclosing-scope
  // relaxation — never inside the cited range itself (RA-1217). The relaxation is right and
  // stays (RA-1198 measured what removing it costs), but it is a weaker verdict: "this line
  // sits somewhere inside a function the sentence names" is not "this line names what the
  // sentence does". Folding both into one `anchor-checked` number overstated how many
  // coordinates were strongly verified, which is RA-945 one level down. Reporting only —
  // no verdict depends on it.
  let viaEnclosing = 0;
  const viaEnclosingAt = [];
  // Bare `:NNN` with no file named on the line — a cron's `:00`, a reference to a line
  // of the doc you are reading, a legacy note naming its file in a heading. Dropping
  // them is right; NOT SAYING SO is the RA-945 shape in the line that exists to prevent
  // it, so the all-clear reports them (RA-1212).
  let discarded = 0;
  // Of `discarded`, the bare `:0`s — named separately because a file MAY have been named
  // on their line, so "no file named on the line" would be false about them (RA-1221).
  let discardedLineZero = 0;
  // Coordinates into a dependency (`isExternal`) — counted and named, never judged (RA-2224).
  let external = 0;
  const externalBy = {};
  // …and WHICH paths, per doc, distinct and in order of first citation: a count alone
  // hides a typo that an allow-list ignore file makes look like a dependency (kanon#120).
  const externalPaths = {};

  for (const doc of docs) {
    const lines = readFile(doc).split('\n');
    lines.forEach((line, i) => {
      const clause = clauseAt(lines, i);
      // The sentence the inheritable anchors were taken from. `anchorsFor` is
      // sentence-scoped, but `inheritable` lived in this per-line loop and knew
      // nothing about sentences — so a FULL STOP, a stronger boundary than the em
      // dash `brokeClause` already refuses, passed straight through and reported a
      // correct coordinate as drift (RA-1220 review). A false positive fails lint, and
      // a check people learn to override is worse than no check.
      let inheritable;
      let inheritableSentence;
      const coords = coordinatesIn(line, bareNeedsFile(doc));
      discarded += coords.discarded ?? 0;
      discardedLineZero += coords.discardedLineZero ?? 0;
      if (coords.discarded) discardedBy[doc] = (discardedBy[doc] ?? 0) + coords.discarded;
      for (const m of coords) {
        // The anchors are needed BEFORE resolution, because they are what
        // disambiguates a bare basename that matches more than one file.
        // A continuation inherits the anchors of the citation it resolves against —
        // the same citation `coordinatesIn` gave it its file from, so the two cannot
        // disagree about which antecedent is meant.
        const sentence = sentenceAround(line, m.i);
        const inheritsHere = m.bare && sentence === inheritableSentence ? inheritable : undefined;
        const a0 = anchorsFor(line, m.i, inheritsHere);
        const { anchors, anchorTokens } = a0;
        // A full citation resets what can be inherited; a clause turn CLEARS it, so a
        // later continuation with a clean segment cannot reach back across a boundary
        // its own predecessor already crossed.
        if (!m.bare) { inheritable = anchors; inheritableSentence = sentence; }
        else if (a0.clauseBroken) {
          inheritable = anchors.length ? anchors : undefined;
          inheritableSentence = anchors.length ? sentence : undefined;
        }
        // A FULL citation naming line 0 — a typo, never a coordinate (RA-1221). Checked
        // AFTER its anchors become inheritable, so a continuation behind it still answers
        // for the identifier it introduced; BEFORE the external test, so a
        // `.venv/…:0` typo is reported rather than counted as external; and before
        // anything is resolved, so it cannot reach the range or anchor test a 0 would pass
        // vacuously (RA-1220 review).
        if (m.lineZero) {
          checked += 1;
          findings.push({
            at: `${doc}:${i + 1}`,
            citation: m.text,
            clause,
            problem: 'names line 0 — files are 1-indexed, so this coordinate points at nothing. Re-derive the line it meant',
          });
          continue;
        }
        if (m.file && isExternal(m.file, tracked, ignored)) {
          external += 1;
          externalBy[doc] = (externalBy[doc] ?? 0) + 1;
          const seenPaths = (externalPaths[doc] ??= []);
          if (!seenPaths.includes(m.file)) seenPaths.push(m.file);
          continue;
        }
        checked += 1;
        const whole = m.text;
        const cited = m.file;
        const a = m.a;
        const b = m.b;
        const at = `${doc}:${i + 1}`;
        if (!cited) {
          findings.push({
            at,
            citation: whole,
            clause,
            problem:
              'a bare `:NNN` with no file named before it on this line. In the oracle a ' +
              'line number is not a reference: if it points into this document, quote the ' +
              'heading or marker phrase instead — any insertion above it moves it, and a ' +
              'range check cannot tell (RA-1479)',
          });
          continue;
        }
        const rangeOf = (path) => {
          const t = readFile(path).split('\n');
          return b > t.length ? null : codeOnly(t.slice(a - 1, b).join('\n'));
        };
        const rangeHasAnchor = (path) => {
          const r = rangeOf(path);
          return r !== null && anchorTokens.some((t) => namesIdentifier(r, t));
        };

        const resolved = resolvePath(cited, tracked, anchorTokens.length ? rangeHasAnchor : null);
        if (resolved.error) {
          findings.push({ at, citation: whole, problem: resolved.error, clause });
          continue;
        }
        citationsByFile.set(resolved.path, (citationsByFile.get(resolved.path) ?? 0) + 1);
        const target = readFile(resolved.path).split('\n');
        if (b > target.length) {
          findings.push({ at, citation: whole, problem: `line ${b} is beyond ${resolved.path} (${target.length} lines)`, clause });
          continue;
        }
        if (a > b) {
          findings.push({ at, citation: whole, problem: `inverted range ${a}-${b}`, clause });
          continue;
        }
        if (!anchorTokens.length) continue; // range-checked only; counted below
        anchored += 1;
        const range = codeOnly(target.slice(a - 1, b).join('\n'));
        // ENCLOSING SCOPE COUNTS, and leaving it out made the check wrong rather than
        // merely strict. A citation frequently points at a STATEMENT INSIDE the thing
        // its sentence names — `| enrollStudent | services/enrollment.ts:124-129 |`
        // targets the `insert(orders)` within `enrollStudent`, which is exactly right
        // and contains the word "enrollStudent" nowhere. Demanding the identifier
        // inside the range flags correct citations, and a cleanup driven by that would
        // have REPLACED good coordinates with worse ones.
        // Enclosing declarations PLUS a small window above the range. A citation
        // frequently points at the statement a nearby line names — `managesTransaction:
        // true` inside a `defineService` whose name is six lines up, or a function
        // whose doc comment carries the identifier the sentence quotes. Comment
        // stripping (above) is what makes the window necessary: it correctly refuses to
        // let prose certify a coordinate, and in doing so removes the anchor from
        // citations that are perfectly right. Widening ADMITS citations only, so the
        // cost is precision on a check whose job is to catch coordinates that moved.
        const enclosing = [
          ...enclosingDeclarations(target, a),
          ...codeOnly(target.slice(Math.max(0, a - 9), a - 1).join('\n')).split(/[^A-Za-z0-9_]+/).filter(Boolean),
        ];
        const inRange = anchorTokens.some((t) => namesIdentifier(range, t));
        if (!inRange && !anchorTokens.some((t) => enclosing.includes(t))) {
          findings.push({
            at,
            citation: whole,
            clause,
            problem:
              `the range names none of what its sentence does ` +
              `(${anchors.slice(0, 3).map((x) => `\`${x}\``).join(', ')})`,
          });
          continue;
        }
        if (!inRange) {
          viaEnclosing += 1;
          viaEnclosingAt.push(`${at}  ${whole}`);
        }
        // THE ANCHOR WAS FOUND — in the wrong place (RA-2211). See `declarationShift`.
        // Whole identifiers only — see `strongNames` (RA-2254).
        const shifted = declarationShift(target, a, strongNames(anchors));
        if (!shifted) continue;
        findings.push({
          at,
          citation: whole,
          clause,
          problem:
            `\`${shifted.token}\` is declared at ${resolved.path}:${shifted.declLine}, ` +
            `${shifted.shift} line(s) BELOW the range start — so the range opens inside a ` +
            'different block and only reaches what the sentence names at its far end. ' +
            'That is the signature of an insertion above it — unless the sentence names ' +
            `\`${shifted.token}\` in passing and the range is about something else, in which ` +
            'case the coordinate is right and the sentence should say what the range is',
        });
        const byFile = shiftsByFile.get(resolved.path) ?? [];
        byFile.push(shifted.shift);
        shiftsByFile.set(resolved.path, byFile);
      }
    });
  }
  return {
    findings, checked, anchored, viaEnclosing, viaEnclosingAt, discarded, discardedLineZero, discardedBy,
    external, externalBy, externalPaths, blocks: blocksIn(shiftsByFile, citationsByFile),
  };
};

/**
 * The all-clear's discard clause, naming each reason separately (RA-1221). A bare `:0` is
 * discarded whether or not a file was named before it on the line, so folding it into
 * "no file named on the line" states the opposite of what happened for
 * `` `src/a.ts` … `:00` ``. The phrase `bare coordinate(s) discarded` is kept verbatim:
 * `tests/library/citation-guard.test.ts` pins that the count is printed at all (RA-1212).
 */
export const discardedPhrase = (discarded, lineZero) => {
  const noFile = discarded - lineZero;
  const parts = [
    noFile ? `${noFile} naming no file on the line` : '',
    lineZero ? `${lineZero} naming line 0` : '',
  ].filter(Boolean);
  return `${discarded} bare coordinate(s) discarded (${parts.join(', ')})`;
};

/**
 * How many agreeing shifts into one file make a BLOCK. Three, not two: exact equality is
 * already a strong coincidence filter, but two citations landing on the same small `k` by
 * chance is reachable and this report's job is to send someone to re-derive every
 * coordinate in a file — an expensive instruction to issue wrongly. RA-2208's sweep produced
 * four agreeing at `+8` in `superadmin.md` alone, so the margin is real rather than tuned
 * to just fit.
 */
export const BLOCK_MIN = 3;

/**
 * THE REASON THIS IS REPORTED AT ALL, and it is not the citations it names.
 *
 * Of the 16 coordinates into `tenancy.ts` that RA-2208 shifted, `declarationShift` sees the
 * ones whose sentence names a top-level declaration. The rest name nothing checkable —
 * *"**Insert the tenant row** — `tenancy.ts:192-202`"* names no identifier at all, and
 * `tenantIntegrationSettings` is declared in the schema, not here — so they are
 * range-checked only and no per-citation rule can ever reach them. They were stale for
 * exactly the same reason and by exactly the same `k`. Naming the FILE is what carries the
 * finding across to them.
 */
const blocksIn = (shiftsByFile, citationsByFile) => {
  const blocks = [];
  for (const [path, shifts] of shiftsByFile) {
    const counts = new Map();
    for (const s of shifts) counts.set(s, (counts.get(s) ?? 0) + 1);
    for (const [shift, count] of counts) {
      if (count >= BLOCK_MIN) blocks.push({ path, shift, count, citations: citationsByFile.get(path) ?? count });
    }
  }
  return blocks.sort((x, y) => y.count - x.count);
};

/**
 * A PROJECT BRIEF CARRIES NO COORDINATES, SO THERE IS NOTHING HERE TO CHECK (RA-1742).
 *
 * The history is worth keeping, because "remove a check" is the shape of a regression
 * and this one is not. RA-1445 skipped `docs/projects/**` entirely — a brief is a dated
 * measurement, and re-deriving a deletion project's coordinates against a later tree
 * falsifies the record rather than fixing it. RA-1449/RA-1451 replaced that with a resolve
 * against the commit the brief's own header named, so a brief was checked on the PR that
 * wrote it. Both answers were right about the artifact as it then was.
 *
 * RA-1742 removed the artifact's claim instead. A brief no longer states a `file:line` at
 * all: it cites an invariant id or a command, and `brief-guard.mjs` fails one that does
 * not. So this guard has nothing to resolve in that tree — not a coordinate it declines
 * to check, but a coordinate that is not written. What went with the claim: the
 * header-commit parse, the `git show`/`ls-tree` reader, the shallow-clone fail-open and
 * the orphaned-sha finding, ~120 lines whose only consumer was the brief corpus, plus
 * the `fetch-depth: 0` those three workflows carried solely to feed it.
 *
 * Pre-standard briefs keep their coordinates and stay byte-identical, which is why this
 * is an exclusion rather than a re-derivation: they are evidence about commits that have
 * passed. The adopter lists them in `docs/qa/exemptions.md` (`K-LAYOUT-15`), and
 * `brief-guard.mjs`'s `isPreStandard` is the one reader of that list.
 */
export const PROJECTS_TREE = 'docs/projects/';

const main = () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch (e) {
    console.error(`citation-guard: could not read the git index — ${e.message}`);
    process.exitCode = 1;
    return;
  }
  // `docs/projects/**` IS NOT READ, and the run says so rather than being quietly
  // narrower than its own all-clear implies (RA-945). A brief carries no coordinates
  // since RA-1742 — see the note above `PROJECTS_TREE` — so there is nothing here to
  // resolve, and the pre-standard briefs' coordinates (`isPreStandard`, `K-LAYOUT-15`)
  // are evidence about commits that have passed.
  const all = tracked.filter((f) => f.startsWith('docs/') && f.endsWith('.md'));
  const md = all.filter((f) => !f.startsWith(PROJECTS_TREE));
  const briefsSkipped = all.length - md.length;
  const read = (p) => readFileSync(p, 'utf8');
  const findings = [];
  const blocks = [];
  const discardedBy = {};
  const externalBy = {};
  const externalPaths = {};
  const viaEnclosingAt = [];
  let checked = 0;
  let anchored = 0;
  let viaEnclosing = 0;
  let discarded = 0;
  let discardedLineZero = 0;
  let external = 0;
  const absorb = (r) => {
    findings.push(...r.findings);
    blocks.push(...r.blocks);
    viaEnclosingAt.push(...r.viaEnclosingAt);
    checked += r.checked;
    anchored += r.anchored;
    viaEnclosing += r.viaEnclosing;
    discarded += r.discarded;
    discardedLineZero += r.discardedLineZero;
    external += r.external;
    for (const [d, n] of Object.entries(r.discardedBy)) discardedBy[d] = (discardedBy[d] ?? 0) + n;
    for (const [d, n] of Object.entries(r.externalBy)) externalBy[d] = (externalBy[d] ?? 0) + n;
    for (const [d, ps] of Object.entries(r.externalPaths)) externalPaths[d] = [...new Set([...(externalPaths[d] ?? []), ...ps])];
  };

  if (briefsSkipped) {
    console.log(
      `citation-guard: not reading ${briefsSkipped} file(s) under \`${PROJECTS_TREE}\` — a brief ` +
        'carries no `file:line` coordinate (RA-1742), and `brief-guard.mjs` is what refuses one.',
    );
  }

  absorb(auditCitations(md, read, tracked, { ignored: gitIgnored() }));
  const audited = md.length;

  if (findings.length) {
    // CONFIRMED FIRST, and labelled. A run that buries the one hard-oracle failure
    // under forty seed-clause ones has reported everything and communicated nothing.
    //
    // STILL KEYED ON `confirmed` ALONE, now that `clauseAt` can return four statuses
    // rather than two (RA-2105). The bucket's own headline is the reason — "HARD ORACLE,
    // which the Explorer files bugs against" — and that is a claim about `[confirmed]`
    // specifically, not about authority in general. `[structural]` is an enforced
    // contract (often by lint or by types) but the Explorer does not file bugs against
    // it, so promoting it here would dilute the one bucket that exists to stay small.
    // It lands in `rest` with its own tag, which is what RA-2105 was actually about: the
    // id and status printed beside a finding are now the clause that contains it.
    //
    // `[retired]` is deliberately not special-cased: there are zero in the corpus, and
    // inventing a rule for a state nothing is in would be a guess. Its citations report
    // under `rest`, tagged `[retired]`, which is visible enough to decide against on the
    // day a first one appears.
    const confirmed = findings.filter((f) => f.clause?.status === 'confirmed');
    const rest = findings.filter((f) => f.clause?.status !== 'confirmed');
    console.error(`citation-guard: ${findings.length} citation(s) do not resolve to what they claim:\n`);
    // FIRST, because it changes what the list below means. A block shift says the file
    // moved, so the individual findings are a SAMPLE of the damage and every other
    // coordinate into that file needs re-deriving too — including the ones no anchor can
    // judge. Printing it after the list would read as a summary of the list (RA-2211).
    for (const bl of blocks) {
      console.error(
        `  BLOCK SHIFT — ${bl.count} citation(s) into ${bl.path} are each ${bl.shift} line(s) ` +
          `above what they name. ${bl.citations} coordinate(s) in docs/ point into that file; ` +
          're-derive ALL of them, not only the ones listed below — a citation whose sentence ' +
          'names no identifier is range-checked only and drifted by the same amount in silence.\n',
      );
    }
    if (confirmed.length) {
      console.error(`  ${confirmed.length} on a [confirmed] invariant — HARD ORACLE, which the Explorer files bugs against:\n`);
      for (const f of confirmed) console.error(`  ${f.at}  [${f.clause.id}] [confirmed]\n    ${f.citation} — ${f.problem}`);
      if (rest.length) console.error('');
    }
    for (const f of rest) {
      const tag = f.clause ? `  [${f.clause.id}] [${f.clause.status}]` : '';
      console.error(`  ${f.at}${tag}\n    ${f.citation} — ${f.problem}`);
    }
    console.error(
      '\nA `file:line` moves whenever the file above it changes. Re-derive it against the\n' +
        'CURRENT tree and verify by content, not by range: a line number that is merely\n' +
        'in-bounds still points at whatever now occupies it (RA-658).\n' +
        '\nA "declared … BELOW the range start" finding measured against the identifier it\n' +
        'names. If the sentence mentions that identifier only in passing, the coordinate may\n' +
        'already be right — confirm by content before moving it, or you replace a correct\n' +
        'coordinate with a worse one (RA-2254).\n' +
        '\nNo finding here can be in `docs/projects/`: that tree is not read, because a brief\n' +
        'no longer states a coordinate at all (RA-1742). If you were about to write one there,\n' +
        '`brief-guard.mjs` is what will refuse it.',
    );
    process.exitCode = 1;
    return;
  }
  // A RUN THAT ANCHORS NOTHING IS A BROKEN RUN, not a clean one. Adding the
  // continuation shorthand renamed the match object's offset field, so every anchor
  // lookup ran at `undefined`, every citation silently demoted to range-checked, and
  // the guard printed a green `0 anchor-checked` all-clear over 19 real failures. The
  // disclosure line was what made it visible — this makes it fatal, because a
  // detector that quietly stops detecting is the class this guard exists to serve
  // (RA-945).
  if (checked > 0 && anchored === 0) {
    console.error(
      `citation-guard: read ${checked} citation(s) and anchor-checked NONE of them. ` +
        'That is a broken guard, not a clean corpus — some citation in `docs/` names an ' +
        'identifier, so anchoring zero means the anchor logic is not running.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `citation-guard: ${checked} citation(s) across ${audited} docs resolve; ` +
      `${anchored} anchor-checked (${viaEnclosing} of them only via the enclosing scope, not inside the cited range), ` +
      `${checked - anchored} range-checked only (no identifier named in the sentence)` +
      `${discarded ? `, ${discardedPhrase(discarded, discardedLineZero)}` : ''}.`,
  );
  // THE WEAKER ANCHOR, LISTED ON REQUEST (RA-1217). The count above is always printed; the
  // coordinates behind it are a `--verbose` list, because a reader auditing one of them
  // needs the `file:line`, and a routine run does not need two hundred lines.
  if (viaEnclosing && process.argv.includes('--verbose')) {
    console.log('  anchored only via the enclosing scope:');
    for (const x of viaEnclosingAt) console.log(`    ${x}`);
  }
  // NAMED, NOT JUST COUNTED (RA-1451, RA-1479). A number in the all-clear says the guard
  // dropped something and nothing about where, so a new bare coordinate lands in a
  // bucket that already had a hundred in it and reads as unchanged. The documents are
  // listed so the bucket has a shape. A `docs/qa/specs/**` path appearing here means a
  // LINE-0 coordinate — a cron's `:00`, dropped by `c.a < 1` before the ban is reached
  // — and never an unresolved self-reference, which is a finding there (RA-1652 review).
  if (discarded) {
    const byDoc = Object.entries(discardedBy).sort((a, b) => b[1] - a[1]);
    console.log(`  discarded in: ${byDoc.map(([d, n]) => `${d} (${n})`).join(', ')}`);
  }
  // Same rule for the dependency coordinates: not checked, so SAID (RA-2224).
  if (external) {
    const byDoc = Object.entries(externalBy).sort((a, b) => b[1] - a[1]);
    console.log(
      `  ${external} coordinate(s) into an untracked, git-ignored path not checked (a dependency, outside the repository): ` +
        `${byDoc.map(([d, n]) => `${d} (${n})`).join(', ')}`,
    );
    // The paths themselves, so a typo an allow-list ignore file hides is still in front of
    // a reader (kanon#120): `scr/orders/a.ts` beside `node_modules/…` reads as one.
    for (const [d] of byDoc) console.log(`    ${d}: ${externalPaths[d].join(', ')}`);
  }
};

// `try`, because `realpathSync(undefined)` THROWS. `node -e "import(...)"` has no
// argv[1], so importing this module for a REPL check crashed on the entry-point guard
// rather than on anything it guards — the hardening from RA-1170 traded one silent
// failure for a loud one in a case that should simply not run `main`.
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
