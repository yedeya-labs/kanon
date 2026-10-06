import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { auditCitations, codeSpans, resolvePath, tokensOf, clauseAt, enclosingDeclarations, anchorsFor, coordinatesIn, codeOnly, isOracleSpec, namesIdentifier, topLevelDeclarations, declarationShift, strongNames, BLOCK_MIN, discardedPhrase, gitIgnored, externalSuspicion, suspectExternalLines, selfCheck, DOC_PATTERNS, docPatternsFrom, globToRegExp, selectDocs } from '../../scripts/citation-guard.mjs';
import { STATUSES } from '../../scripts/spec-lib.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-658 / RA-919 — a `file:line` in a doc is a claim about code, and nothing checked it.
 *
 * WHY RANGE-CHECKING IS NOT ENOUGH, from the case that prompted this. PR RA-1128 was
 * rebased; `settleOrderWith`'s enrollment write moved from `payments.ts:44-52` to
 * `:180-189`, and `:44-52` became `[PAY-1]`'s doc comment. The citation still resolved
 * and was still in range — it pointed at a DIFFERENT INVARIANT, in the oracle. So the
 * check is: an identifier the citing sentence names must be findable at the coordinate.
 *
 * EVERY RELAXATION BELOW WAS FORCED BY A FALSE POSITIVE, and each is load-bearing: a
 * cleanup driven by the un-relaxed version would have rewritten CORRECT coordinates
 * into worse ones and made them look freshly verified.
 */
const doc = (body: string) => ({ 'docs/x.md': body });
const audit = (docs: Record<string, string>, files: Record<string, string>) =>
  auditCitations(
    Object.keys(docs),
    (p: string) => ({ ...docs, ...files })[p],
    [...Object.keys(docs), ...Object.keys(files)],
  );
/** `audit`, with git's ignore rules given as a predicate: by default, the usual dependency trees. */
const auditIgnoring = (
  docs: Record<string, string>,
  files: Record<string, string>,
  ignored = (p: string) => /^(node_modules|\.venv)\//.test(p),
) =>
  auditCitations(Object.keys(docs), (p: string) => ({ ...docs, ...files })[p], [...Object.keys(docs), ...Object.keys(files)], { ignored });

describe('a coordinate that moved is caught (RA-658)', () => {
  it('flags a citation whose range no longer names what the sentence does', () => {
    const r = audit(
      doc('The write selects by `inArray(enrollments.courseId, courseIds)` (`src/a.ts:1`).'),
      { 'src/a.ts': '// a comment about something else entirely\nconst x = 1;\n' },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toMatch(/names none of what its sentence does/);
  });

  it('passes when the range does name it', () => {
    const r = audit(
      doc('The write selects by `inArray(enrollments.courseId, courseIds)` (`src/a.ts:1`).'),
      { 'src/a.ts': '  inArray(enrollments.courseId, courseIds),\n' },
    );
    expect(r.findings).toEqual([]);
  });

  it('flags a line beyond the end of the file', () => {
    const r = audit(doc('See `src/a.ts:99`.'), { 'src/a.ts': 'one\ntwo\n' });
    expect(r.findings[0].problem).toMatch(/beyond/);
  });

  it('flags a file that does not exist (RA-919)', () => {
    const r = audit(doc('See `src/gone.ts:1`.'), { 'src/a.ts': 'x\n' });
    expect(r.findings[0].problem).toMatch(/no such file/);
  });
});

describe('backtick spans are paired before they are filtered — a one-character span does not shift the rest', () => {
  // The identifier regex carried its 2-character floor INSIDE the pairing, so `&` could
  // not match and every later backtick paired one out of phase: the prose between spans
  // became a "span", and the identifiers after it were lost. Seen at
  // `html-escaping-invariants.md` ("a literal `&amp;` where the sender meant `&`").
  it('finds the identifier after a one-character span', () => {
    const line = 'The sender meant `&`, so `renderTemplate` escapes nothing (`src/a.ts:1`).';
    expect(anchorsFor(line, line.indexOf('`src/a.ts')).anchors).toEqual(['renderTemplate']);
  });

  it('so a coordinate that no longer names it is caught, not range-checked only', () => {
    const r = audit(
      doc('The sender meant `&`, so `renderTemplate` escapes nothing (`src/a.ts:1`).'),
      { 'src/a.ts': 'const unrelated = 1;\n' },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toMatch(/names none of what its sentence does \(`renderTemplate`\)/);
  });

  it('a continuation answers for the identifier its OWN clause names, not one inherited from elsewhere', () => {
    const body = 'Built by `firstBuilder` (`src/a.ts:1`) then `&` joins in `secondBuilder` (`:2`).';
    const files = { 'src/a.ts': 'firstBuilder();\nsecondBuilder();\n' };
    expect(audit(doc(body), files).findings).toEqual([]);
    // And it is really checked against its own name: a line naming neither is caught.
    const drifted = audit(doc(body), { 'src/a.ts': 'firstBuilder();\nconst other = 2;\n' });
    expect(drifted.findings).toHaveLength(1);
    expect(drifted.findings[0].problem).toMatch(/secondBuilder/);
  });

  it('pairs runs as CommonMark does', () => {
    expect(codeSpans('a `&` b `x.y` c')).toEqual(['&', 'x.y']);
    expect(codeSpans('literal `` `&amp;` `` then `z()`')).toEqual(['`&amp;`', 'z()']);
    expect(codeSpans('an unmatched `` run, then `ok()`')).toEqual(['ok()']);
  });
});

describe('the relaxations, each pinned by the false positive that forced it', () => {
  it('accepts a citation pointing INSIDE the function its sentence names', () => {
    // `| enrollStudent | services/enrollment.ts:124-129 |` targets the `insert(orders)`
    // within `enrollStudent` — correct, and containing that name nowhere.
    const r = audit(
      doc('Admin enrollment (`enrollStudent`) opens the order — `src/a.ts:3-4`.'),
      { 'src/a.ts': 'export const enrollStudent = defineService({\n  async resolve() {\n    await db\n      .insert(orders)\n' },
    );
    expect(r.findings).toEqual([]);
  });

  it('does not treat the clause\'s own `[AREA-N]` / `[confirmed]` prefix as evidence', () => {
    // Every clause line opens with these, so without the exclusion EVERY citation on a
    // clause inherits two anchors that can never appear in source — and one of them
    // buried a real anchor that tokenises too short to keep.
    const { anchorTokens } = anchorsFor('- `[ESCAPE-2]` `[confirmed]` wraps in `<li>` (`src/a.ts:1`).', 50);
    expect(anchorTokens).not.toContain('ESCAPE');
    expect(anchorTokens).not.toContain('confirmed');
  });

  it.each(STATUSES)('excludes the `[%s]` status tag, not just two of the four (RA-2090)', (status) => {
    // The exclusion listed `seed|confirmed` while `spec-lib` declares four, so
    // `[structural]` and `[retired]` stayed anchor candidates. Latent here only because
    // clause prose usually carries a real identifier alongside and `anchorTokens.some`
    // needs one to land — so the line below is the shape that exposes it: the status
    // tag is the ONLY other backticked token, and the guard would demand a source range
    // name its own markup. Parameterised over STATUSES so a fifth status is covered the
    // day it is declared, which is the whole point of deriving the list.
    const line = `- \`[STORE-9]\` \`[${status}]\` \`confirmReservation()\` holds the seat (\`src/a.ts:1\`).`;
    const { anchorTokens } = anchorsFor(line, line.indexOf('`src/a.ts:1`'));
    expect(anchorTokens).not.toContain(status);
    // NON-VACUITY PARTNER. Without a real identifier on the line the assertion above
    // holds against an empty array, so it would keep passing if `anchorsFor` stopped
    // finding anchors here for an unrelated reason — passing louder rather than
    // failing. This is the discipline the RA-2093 suite applies; it belongs here too.
    expect(anchorTokens, 'the status tag is dropped, the real identifier is not')
      .toContain('confirmReservation');
  });

  it('anchors each citation to the text before IT, not to the whole sentence', () => {
    // `A -> B` chains: pooling made the STORAGE citation answer for the RENDERING
    // side's identifiers, and reported a correct coordinate as drifted.
    const r = audit(
      doc('Bodies are text (`src/a.ts:1` → `src/b.ts:1`, `{n.body}` under `whitespace-pre-wrap`).'),
      { 'src/a.ts': 'export function noteBody() {}\n', 'src/b.ts': '  {n.body}\n' },
    );
    // Neither coordinate names an identifier BEFORE it, so since kanon#387 both fail as
    // unanchored. Pooled, the storage side would answer for `{n.body}` instead, and fail as
    // drift: "the range names none of what its sentence does".
    expect(r.findings.map((f) => f.citation)).toEqual(['`src/a.ts:1`', '`src/b.ts:1`']);
    for (const f of r.findings) expect(f.problem).toMatch(/^unanchored citation/);
  });

  it('drops tokens too short to be distinctive rather than matching on noise', () => {
    // `<li>` -> `li` would match almost any line. Yielding nothing leaves the citation
    // unanchored, which fails and names the span as too short to look for (kanon#387).
    expect(tokensOf('<li>')).toEqual([]);
    expect(tokensOf('orders.status')).toEqual(['orders', 'status']);
  });

  it.each([
    ['a statement inside a function', 'export function placeOrder() {\n  const x = 1;\n  return x;\n}\n', '3', '`placeOrder` (`src/a.ts:3`)'],
    ['a doc comment, widened to what it documents', 'const total = 1;\n/** Places the order. */\nexport const placeOrder = () => 1;\n', '2', '`placeOrder` (`src/a.ts:2-3`)'],
    ['a line with nothing declared near it', 'x = 1\n', '1', '`theFunction` (`src/a.ts:1`)'],
    // Review of #398: measured from the range's END this named `bravo`, declared below the
    // start with code between, and the printed example failed as an insertion shift.
    ['the block the range opens in, not the one it ends in', 'export function placeAlpha() {\n  return 1;\n}\nexport function placeBravo() {\n  return 2;\n', '2-5', '`placeAlpha` (`src/a.ts:2-5`)'],
    // A plain word reads as prose to the anchor, so `alpha` as written would fail again.
    // `a_b` looks like code but is too short to be a token, so as written it would not anchor.
    ['the placeholder when the only name is too short to look for', 'export function a_b() {\n  return 1;\n}\n', '2', '`theFunction` (`src/a.ts:2`)'],
    ['the placeholder when the only name is a plain word', 'export function alpha() {\n  return 1;\n}\n', '2', '`theFunction` (`src/a.ts:2`)'],
    // Review of #398: the range is widened to the declaration, never narrowed to it.
    ['a doc comment whose range runs past the declaration, keeping its end', '/** Places it. */\nexport function placeOrder() {\n  return 1;\n}\n', '1-4', '`placeOrder` (`src/a.ts:1-4`)'],
    ['a range that opens on the declaration, keeping its end', 'export function placeOrder() {\n  return 1;\n}\n', '1-3', '`placeOrder` (`src/a.ts:1-3`)'],
  ])("an unanchored citation's remedy names %s, and the example passes the guard", (_, src, line, example) => {
    const r = audit(doc(`See \`src/a.ts:${line}\`.`), { 'src/a.ts': src });
    expect(r.findings[0].problem).toContain(`as in \`\` ${example} \`\``);
    if (!example.startsWith('`theFunction`')) expect(audit(doc(`Written as the remedy says: ${example}.`), { 'src/a.ts': src }).findings).toEqual([]);
  });

  it('says when the sentence names a span too short to look for', () => {
    const r = audit(doc('The `<li>` (`src/a.ts:1`).'), { 'src/a.ts': '<li>\n' });
    expect(r.findings[0].problem).toMatch(/^unanchored citation: its sentence names no identifier the guard can look for \(`<li>` is too short/);
  });

  it('fails a citation whose sentence names no identifier, as unanchored (kanon#387)', () => {
    const r = audit(doc('See `src/a.ts:1` for context.'), { 'src/a.ts': 'anything\n' });
    expect(r.findings).toEqual([expect.objectContaining({ at: 'docs/x.md:1', citation: '`src/a.ts:1`' })]);
    expect(r.findings[0].problem).toMatch(/^unanchored citation: its sentence names no identifier, so nothing checks that line 1/);
    expect(r.checked).toBe(1);
    expect(r.anchored, 'an unanchorable citation must not be counted as anchor-checked').toBe(0);
  });
});

describe('a bare basename is disambiguated, not rejected (docs cite short names)', () => {
  const files = {
    'src/db/schema/courses.ts': 'export const courses = pgTable(\n',
    'src/server/services/courses.ts': 'export const listCourses = defineService({\n',
  };
  it('resolves to the candidate whose range matches the anchor', () => {
    const r = audit(doc('`listCourses` collapses fan-out — `courses.ts:1`.'), files);
    expect(r.findings).toEqual([]);
  });

  it('reports it as ambiguous when no candidate fits', () => {
    const r = audit(doc('`somethingElse` lives at `courses.ts:1`.'), files);
    expect(r.findings[0].problem).toMatch(/ambiguous/);
    expect(r.findings[0].problem, 'must say what to do about it').toMatch(/qualify the path/);
  });
});

describe('a [confirmed] invariant is reported as the harder failure (RA-1196)', () => {
  /**
   * `[confirmed]` is hard oracle — the Explorer files bugs against it. A confirmed
   * clause pointing at code that no longer does the thing does not merely mislead a
   * reader, it manufactures false positives from a trusted source. Measured instance:
   * `[FILTER-3]` cited four decline-persistence sites, two of which named code that had
   * not called `persistFailedPayment` for months, with every gate green.
   */
  it('attaches the clause id and status to a finding', () => {
    const r = audit(
      doc('- `[FILTER-3]` `[confirmed]` A decline persists via `persistFailedPayment` — `src/a.ts:1`.'),
      { 'src/a.ts': '// unrelated\n' },
    );
    expect(r.findings[0].clause).toEqual({ id: 'FILTER-3', status: 'confirmed' });
  });

  it('distinguishes a seed clause, which is a documentation defect and no more', () => {
    const r = audit(
      doc('- `[PAY-9]` `[seed]` A settle names its `fromSet` — `src/a.ts:1`.'),
      { 'src/a.ts': '// unrelated\n' },
    );
    expect(r.findings[0].clause?.status).toBe('seed');
  });

  it('does not attribute a citation below a heading to the clause above it', () => {
    const lines = ['- `[PAY-1]` `[seed]` something', '', '## Another section', 'prose citing `src/a.ts:1`'];
    expect(clauseAt(lines, 3)).toBeNull();
  });

  it.each(STATUSES)('stops on a `[%s]` clause, not only on two of the four (RA-2105)', (status) => {
    // THE MEASURED FAILURE. `CLAUSE` restated `(seed|confirmed)` seventy lines below the
    // half-list RA-2090 removed, so the upward walk passed straight THROUGH a `[structural]`
    // declaration and kept going — attributing its citation to whichever confirmed clause
    // sat above. On the corpus at the time: `[ESCAPE-5]` `[structural]` was reported as
    // `[ESCAPE-4]` `[confirmed]`, inheriting the hard-oracle bucket from a neighbour.
    const lines = [
      '- `[ESCAPE-4]` `[confirmed]` the neighbour above',
      `- \`[ESCAPE-5]\` \`[${status}]\` the clause that owns the citation`,
      'prose citing `src/a.ts:1`',
    ];
    expect(clauseAt(lines, 2)).toEqual({ id: 'ESCAPE-5', status });
  });

  it.each(STATUSES)('sees the bare-paragraph `[%s]` form, which most structural contracts use', (status) => {
    // The second half of the same defect: `CLAUSE` required a leading `-`/`*`, so every
    // bare-paragraph declaration was invisible and its citations got no clause at all.
    // That was 38 of them, and `spec-lib.mjs` records that this is the form `[structural]`
    // contracts normally take — so the two halves compounded on the same clauses.
    const lines = [
      `\`[STUD-1]\` \`[${status}]\` \`myEnrollments.input\` takes no parameters`,
      'prose citing `src/a.ts:1`',
    ];
    expect(clauseAt(lines, 1)).toEqual({ id: 'STUD-1', status });
  });

  it('still ignores the per-file legend, which is bulleted and tag-leading', () => {
    // NON-VACUITY FOR THE RELAXATION ABOVE. Making the list marker optional is only safe
    // because the ID stays mandatory: every spec opens with a legend defining the tags,
    // which `spec-lib.mjs:24` calls "indistinguishable from an invariant by shape alone"
    // and which a backfill silently numbered once already. No `[AREA-N]`, no match.
    const legend = STATUSES.map((s) => `- \`[${s}]\` — what this tag means`);
    for (const line of legend) expect(clauseAt([line, 'citing `src/a.ts:1`'], 1)).toBeNull();
    // And the walk does not simply fail on everything: a real declaration still lands.
    expect(clauseAt(['- `[PAY-1]` `[confirmed]` real', 'citing `src/a.ts:1`'], 1))
      .toEqual({ id: 'PAY-1', status: 'confirmed' });
  });
});

describe('helpers', () => {
  it('enclosingDeclarations stops at the nearest top-level declaration', () => {
    const lines = ['export const outer = 1;', 'export const target = defineService({', '  const inner = 2;', '  cited();'];
    expect(enclosingDeclarations(lines, 4)).toContain('target');
    expect(enclosingDeclarations(lines, 4), 'anything above a top-level decl encloses a different block').not.toContain('outer');
  });

  it('resolvePath prefers an exact path over a basename match', () => {
    expect(resolvePath('src/a.ts', ['src/a.ts', 'other/src/a.ts']).path).toBe('src/a.ts');
  });
});

describe('the continuation shorthand is a citation (RA-1198 review)', () => {
  /**
   * The docs write a full citation then bare `:NNN` for further coordinates in the
   * same file — "`storefront.ts:752`, `:945`, `:1333`". 73 of the corpus's 238
   * coordinates are written that way, 39 of them in payments.md, the oracle whose
   * drift prompted this guard. They were not weakly checked; they were invisible, and
   * the all-clear counted only what it could see — understating its own corpus by 31%
   * while claiming to be the answer to silent-absence.
   *
   * Three were stale when the reviewer looked, one on a `[confirmed]` clause whose
   * five coordinates were 1-of-5 correct.
   */
  it('resolves a bare :NNN against the citation before it on the line', () => {
    const cs = coordinatesIn('filter `x` — `src/a.ts:10`, `:20`, `:30`.');
    expect(cs.map((c) => `${c.file}:${c.a}`)).toEqual(['src/a.ts:10', 'src/a.ts:20', 'src/a.ts:30']);
  });

  it('re-anchors to the NEAREST preceding citation, not the first', () => {
    // A line naming two files hands each bare coordinate to the right one — the bug
    // the reviewer found was `:2382` resolving against a `core.ts` 317 lines long.
    const cs = coordinatesIn('`src/a.ts:1` then `src/b.ts:2`, `:3`.');
    expect(cs.map((c) => `${c.file}:${c.a}`)).toEqual(['src/a.ts:1', 'src/b.ts:2', 'src/b.ts:3']);
  });

  it('DROPS a bare :NNN with nothing before it rather than reporting it', () => {
    // `:00` in a cron, `:75` meaning a line of the document you are reading, a legacy
    // note naming its file once in a heading. Reporting those is the guard crying
    // about correct prose, and a check people learn to override is worse than none.
    expect(coordinatesIn('the hourly tick at `:00` and this file at `:75`')).toEqual([]);
  });

  it('checks a stale continuation, which is what makes it worth reading', () => {
    const r = audit(
      { 'docs/x.md': 'names `thing()` — `src/a.ts:1`, and `otherThing` at `:20`.' },
      // Line 20 is clear of the 8-line window above a range, so nothing admits it.
      { 'src/a.ts': `thing()\n${Array.from({ length: 18 }, () => 'filler').join('\n')}\nsomething else\n` },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].citation).toBe('`:20`');
  });
});

describe('a comment is not evidence for a citation (RA-1192, RA-1198 review)', () => {
  /**
   * The anchor is a substring test, so one common token matched an English sentence:
   * `orders.status` "resolved" to `// … but the status is`, on the word `status`. That
   * is worse than reporting nothing, because it green-lights the coordinate a human
   * would otherwise re-check.
   */
  it('strips line and block comments before matching', () => {
    expect(codeOnly('// the status is here\nconst x = 1;')).not.toContain('status');
    expect(codeOnly('/* status */ const y = 2;')).not.toContain('status');
    expect(codeOnly('const y = 2;'), 'code must survive').toContain('const y = 2;');
  });

  it('flags a citation whose only match is inside a comment', () => {
    const r = audit(
      { 'docs/x.md': 'the `orders.status` enum — `src/a.ts:1`.' },
      { 'src/a.ts': '// but the status is kept for analytics\n' },
    );
    expect(r.findings).toHaveLength(1);
  });
});

describe('the guard fails when it stops checking (RA-945, self-applied)', () => {
  /**
   * Adding the shorthand renamed the match object's offset field, so every anchor lookup ran
   * at `undefined`, every citation silently demoted to range-checked, and the guard printed a
   * green `0 anchor-checked` over 19 real failures. The fatal rule that followed inferred the
   * guard's health from the corpus ("read N, anchored none"), and kanon#387 is what that cost:
   * a corpus whose one citation named no identifier failed as a broken guard. So the question
   * is now asked of a fixture whose answer is known (`selfCheck`), and the corpus's
   * unanchored citations are ordinary findings.
   */
  it('the self-check passes the guard as it is', () => {
    expect(selfCheck()).toEqual({ ok: true, checked: 2, anchored: 2, caught: 1 });
  });

  it('the self-check fails a guard that anchors nothing, one that cannot fail, and one that reads nothing', () => {
    type Audit = typeof auditCitations;
    const anchorsNothing: Audit = (docs, read, tracked, o) =>
      auditCitations(docs, (p) => read(p).replace(/`selfCheckAnchor`/g, 'it'), tracked, o);
    const neverFails: Audit = (...a) => ({ ...auditCitations(...a), findings: [] });
    const readsNothing: Audit = (docs, read, tracked, o) => auditCitations(docs, () => '', tracked, o);
    expect(selfCheck(anchorsNothing)).toMatchObject({ ok: false, anchored: 0 });
    expect(selfCheck(neverFails)).toMatchObject({ ok: false, caught: 0 });
    expect(selfCheck(readsNothing)).toMatchObject({ ok: false, checked: 0 });
    // The all-clear's count is part of what the guard claims, so a miscount is a broken guard too.
    const miscounts: Audit = (...a) => ({ ...auditCitations(...a), anchored: 0 });
    expect(selfCheck(miscounts)).toMatchObject({ ok: false, anchored: 0 });
  });

  /** The CLI on a one-doc repository: a copy of the script, as it is or mutated. */
  const runGuard = (docBody: string, mutate?: (src: string) => string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cite-health-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'src/a.ts'), '// Reads the deploy workflow.\nexport const readDeploy = () => 1;\n');
      writeFileSync(join(dir, 'docs/x.md'), docBody);
      execFileSync('git', ['add', '.'], { cwd: dir });
      // Outside the repository, so the guard does not read its own copy as part of the tree.
      // The copy runs beside the real `scripts/`, which it imports, under a name of its own.
      const tools = mkdtempSync(join(tmpdir(), 'cite-tools-'));
      cpSync(join(ROOT, 'scripts'), join(tools, 'scripts'), { recursive: true });
      const source = readFileSync(join(ROOT, 'scripts/citation-guard.mjs'), 'utf8');
      const copy = join(tools, 'scripts', 'copy.mjs');
      writeFileSync(copy, mutate ? mutate(source) : source);
      const r = spawnSync('node', [copy], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
      rmSync(tools, { recursive: true, force: true });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // kanon#377's shape: a plan row whose one coordinate names no identifier in its cell.
  const tableRow = '| Step | Check |\n|---|---|\n| **P6** | The grep prints nothing. Today it prints `src/a.ts:1`. |\n';

  it('a lone table-row coordinate fails as an unanchored citation, with its file, line and remedy, not as a broken guard', () => {
    const r = runGuard(tableRow);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('docs/x.md:3');
    expect(r.out).toContain('`src/a.ts:1` — unanchored citation: its sentence names no identifier');
    // The remedy names the declaration at or above the cited line, and how to write it.
    // The cited line is readDeploy's doc comment, so the example reaches the declaration.
    expect(r.out).toContain('as in `` `readDeploy` (`src/a.ts:1-2`) ``');
    expect(r.out).not.toMatch(/anchor-checked NONE|broken guard/);
  });

  it('the same row, naming what the line holds, passes', () => {
    const r = runGuard(tableRow.replace('Today it prints `src/a.ts:1`', 'It reads `readDeploy` (`src/a.ts:2`)'));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('1 citation(s) across 1 docs resolve; 1 anchor-checked');
  });

  it('a guard whose anchor logic has stopped fails as broken, before it judges docs/', () => {
    // RA-945's mutation, on a copy: no segment yields an anchor any more.
    const broken = (src: string) => {
      const line = 'const anchors = identifierSpans(segment).filter(looksLikeCode);';
      expect(src).toContain(line);
      return src.replace(line, 'const anchors = [];');
    };
    const r = runGuard('It reads `readDeploy` (`src/a.ts:2`).\n', broken);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('anchor-checked NONE of them');
    expect(r.out).toContain('That is a broken guard, not a stale citation');
    expect(r.out).not.toContain('unanchored citation');
  });
});

describe('a file path is never evidence about a range', () => {
  it('ignores a sibling citation\'s path when anchoring', () => {
    // "rendered at `src/app/…/[id]/page.tsx:198` and `course-wizard.tsx:797-800`" made
    // the wizard's coordinate answer for the OTHER file's path, which no line of the
    // wizard contains. The `[id]` segment is why the first exclusion missed it.
    const line = 'rendered at `src/app/admin/courses/[id]/page.tsx:198` and `course-wizard.tsx:797-800`.';
    const { anchors } = anchorsFor(line, line.indexOf('`course-wizard.tsx:797-800`'));
    expect(anchors).toEqual([]);
  });
});

describe('a continuation inherits the identifier named once, before the first (RA-1212)', () => {
  /**
   * The corpus names the identifier ONCE — "`storefront.ts:752`, `:945`, `:1333`" —
   * so every continuation's own segment is `, ` and yields nothing. Reading the
   * shorthand therefore added 53 coordinates and exactly ZERO anchors: all of them
   * demoted to range-checked, which only asserts the line exists. `[FILTER-2]` was
   * 1-of-5 correct on a `[confirmed]` clause with the guard exiting 0 over it.
   */
  it('checks a stale continuation against the identifier named before the first', () => {
    const r = audit(
      { 'docs/x.md': 'the write is `inArray(courseIds)` at `src/a.ts:1`, `:20`.' },
      // Line 20 is clear of the 8-line window above a range, so only the inherited
      // anchor can judge it — which is the point of the case.
      { 'src/a.ts': `inArray(courseIds)\n${Array.from({ length: 18 }, () => 'filler').join('\n')}\nsomething else entirely\n` },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].citation).toBe('`:20`');
  });

  it('passes a continuation that IS the identifier', () => {
    const r = audit(
      { 'docs/x.md': 'the write is `inArray(courseIds)` at `src/a.ts:1`, `:20`.' },
      { 'src/a.ts': `inArray(courseIds)\n${Array.from({ length: 18 }, () => 'filler').join('\n')}\ninArray(courseIds)\n` },
    );
    expect(r.findings).toEqual([]);
  });

  it('inherits ONLY when the continuation names nothing itself', () => {
    // The table-cell fix stays intact: a continuation with its own identifier answers
    // for that one, not for the antecedent's.
    const line = 'the write is `inArray(courseIds)` at `src/a.ts:1`, with `otherThing` at `:3`.';
    const { anchors } = anchorsFor(line, line.indexOf('`:3`'), ['inArray(courseIds)']);
    expect(anchors).toEqual(['otherThing']);
  });

  it('stops inheriting across a clause boundary', () => {
    // "…`X` is `managesTransaction` (`a.ts:1`), so `Z` opens blocks — `:3` for the
    // read". `:3` answers for the BLOCKS clause, not for `managesTransaction`.
    // Inheriting across that reported a correct coordinate as drift.
    const line = '`X` is `managesTransaction` (`src/a.ts:1`), so it opens blocks — `:3` for the read';
    const { anchors } = anchorsFor(line, line.indexOf('`:3`'), ['managesTransaction']);
    expect(anchors).toEqual([]);
  });
});

describe('a file named without a line is still an antecedent (RA-1212)', () => {
  it('resolves a continuation against a bare path', () => {
    // `tests/unit/order-status-writers.test.ts` then `` (`:123`, `:212`) `` — both
    // correct, both previously dropped because an antecedent had to carry a `:NNN`.
    const cs = coordinatesIn('see `src/a.ts` at `:12` and `:20`');
    expect(cs.map((c) => `${c.file}:${c.a}`)).toEqual(['src/a.ts:12', 'src/a.ts:20']);
  });

  it('does not make the path itself a citation', () => {
    // It names no coordinate, so there is nothing to check about it.
    expect(coordinatesIn('see `src/a.ts` at `:12`')).toHaveLength(1);
  });

  it('stays line-scoped, so a file named in a HEADING is not an antecedent', () => {
    // `docs/legacy-api-payloads.md` names its file once per section heading and then
    // writes bare `:970`. Pulling those in would add twelve unresolvable coordinates.
    expect(coordinatesIn('## 1. Cancel-and-refund — `Api/Courses::cancelandrefundStudent()` (`:970`)')).toEqual([]);
  });
});

describe('the all-clear says what it threw away (RA-1212)', () => {
  it('counts a bare coordinate with no file on the line', () => {
    const r = audit({ 'docs/x.md': 'the hourly tick at `:00`' }, { 'src/a.ts': 'x\n' });
    expect(r.discarded).toBe(1);
    expect(r.checked, 'and does not count it as checked').toBe(0);
  });

  it('counts nothing when every coordinate resolves', () => {
    const r = audit({ 'docs/x.md': 'see `src/a.ts:1`' }, { 'src/a.ts': 'x\n' });
    expect(r.discarded).toBe(0);
  });

  it('the CLI prints the count, so it cannot quietly grow', () => {
    // Dropping them is right; not saying so is the RA-945 shape in the line that exists
    // to prevent it.
    const src = readFileSync(join(ROOT, 'scripts/citation-guard.mjs'), 'utf8');
    expect(src).toMatch(/bare coordinate\(s\) discarded/);
  });
});

describe('inheritance stops at a sentence, not only at a clause (RA-1220 review)', () => {
  /**
   * `anchorsFor` is sentence-scoped, but `inheritable` lived in the per-line loop and
   * knew nothing about sentences — so a FULL STOP, a strictly stronger boundary than
   * the em dash `brokeClause` already refuses, passed straight through and reported a
   * CORRECT coordinate as drift. A false positive fails `npm run lint`, and the file's
   * own comment is the argument for caring: a check people learn to override is worse
   * than no check.
   */
  const files = { 'src/a.ts': `inArray(courseIds)\n${Array.from({ length: 25 }, () => 'filler').join('\n')}` };

  it('does not carry anchors across a full stop', () => {
    const r = audit(
      { 'docs/x.md': 'The write is `inArray(courseIds)` at `src/a.ts:1`. Unrelatedly, the helper lives at `:20`.' },
      files,
    );
    // The second sentence names nothing, so `:20` fails as unanchored (kanon#387). What this
    // pins is that it is not judged against `inArray`, the first sentence's identifier.
    expect(r.findings.map((f) => f.citation)).toEqual(['`:20`']);
    expect(r.findings[0].problem).toMatch(/^unanchored citation/);
  });

  it('still carries them within one sentence', () => {
    const r = audit(
      { 'docs/x.md': 'The write is `inArray(courseIds)` at `src/a.ts:1`, `:20`.' },
      files,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].citation).toBe('`:20`');
  });
});

describe('a coordinate that names no line is not certified (RA-1220 review)', () => {
  /**
   * `BARE_PATH` made `` `:00` `` resolve whenever a filename appeared earlier on the
   * line — the exact case this file's own comment names as the reason to discard. It
   * did not merely slip through: with `a = 0` the range check passed vacuously, the
   * cited slice was empty, and the enclosing window became the WHOLE FILE, so any
   * token anchored it. A meaningless coordinate reported as anchor-checked is RA-945
   * inside the guard built to answer it.
   */
  it('discards `:00` even when a filename precedes it', () => {
    const r = audit(
      { 'docs/y.md': '`src/a.ts` schedules `runHourly()` on the hour at `:00`.' },
      { 'src/a.ts': 'runHourly()\n' },
    );
    expect(r.checked, 'line 0 is not a line').toBe(0);
    expect(r.anchored, 'and must never be certified').toBe(0);
    expect(r.discarded).toBe(1);
  });

  it('still reads a real coordinate on the same shape of line', () => {
    const r = audit(
      { 'docs/y.md': '`src/a.ts` defines `runHourly()` at `:1`.' },
      { 'src/a.ts': 'runHourly()\n' },
    );
    expect(r.checked).toBe(1);
    expect(r.findings).toEqual([]);
  });
});

describe('a FULL citation naming line 0 is a finding, not a silent discard (RA-1221)', () => {
  /**
   * RA-1220 stopped a line-0 coordinate being CERTIFIED by discarding every `a < 1` — right
   * for a cron's bare `:00`, wrong for `` `src/a.ts:0` ``, which is a typo. Three defects:
   * no finding; an all-clear calling it "no file named on the line"; and, because the
   * discard ran before the antecedent was taken, every continuation after it on the line
   * lost its file and was discarded too.
   */
  const files = { 'src/a.ts': `inArray(courseIds)\n${Array.from({ length: 25 }, () => 'filler').join('\n')}` };

  it.each(['`src/a.ts:0`', '`src/a.ts:0-5`'])('reports %s as a finding', (cite) => {
    const r = audit({ 'docs/x.md': `The write is \`inArray(courseIds)\` at ${cite}.` }, files);
    expect(r.findings.map((f) => f.problem).join('\n')).toMatch(/names line 0/);
    expect(r.anchored, 'and never certifies it').toBe(0);
    expect(r.discarded, 'it is reported, not dropped').toBe(0);
  });

  it('still lends its file to the continuations after it on the line', () => {
    // The issue's measurement, verbatim: before, `{ checked: 0, discarded: 2, findings: [] }`.
    const r = audit({ 'docs/x.md': 'The write is `inArray(courseIds)` at `src/a.ts:0`, `:20`.' }, files);
    expect(r.discarded, 'the continuation keeps its antecedent').toBe(0);
    expect(r.checked).toBe(2);
    expect(r.findings.map((f) => f.citation).sort()).toEqual(['`:20`', '`src/a.ts:0`']);
  });

  it('reports a line-0 typo into node_modules/ rather than counting it as external', () => {
    const r = auditIgnoring({ 'docs/x.md': 'The default is `node_modules/next/dist/x.js:0`.' }, files);
    expect(r.findings.map((f) => f.problem).join('\n')).toMatch(/names line 0/);
    expect(r.external).toBe(0);
  });

  it('LINE_AFTER naming L0 is a full citation too', () => {
    const r = audit({ 'docs/x.md': 'The write is `inArray(courseIds)` in `src/a.ts` L0.' }, files);
    expect(r.findings.map((f) => f.problem).join('\n')).toMatch(/names line 0/);
  });

  it('leaves the bare `:00` exactly as RA-1220 did — discarded, and counted as line 0', () => {
    const r = audit({ 'docs/y.md': '`src/a.ts` schedules `runHourly()` on the hour at `:00`.' }, { 'src/a.ts': 'runHourly()\n' });
    expect(r.findings).toEqual([]);
    expect(r.discarded).toBe(1);
    expect(r.discardedLineZero).toBe(1);
  });

  it('the all-clear names each discard reason, and never calls a line-0 discard "no file named"', () => {
    expect(discardedPhrase(3, 0)).toBe('3 bare coordinate(s) discarded (3 naming no file on the line)');
    expect(discardedPhrase(3, 1)).toBe('3 bare coordinate(s) discarded (2 naming no file on the line, 1 naming line 0)');
    expect(discardedPhrase(1, 1)).not.toMatch(/no file/);
  });
});

describe('an anchor found only in the enclosing scope is disclosed as such (RA-1217)', () => {
  // The relaxation stays — RA-1198 showed removing it flags correct citations — but a
  // coordinate that merely sits inside a function the sentence names is a weaker verdict
  // than one whose range names it, and the all-clear counted both as `anchor-checked`.
  const src = 'export const enrollStudent = defineService({\n  async resolve() {\n    await db\n      .insert(orders)\n';

  it('counts an enclosing-scope anchor separately, without changing the verdict', () => {
    const r = audit(doc('Admin enrollment (`enrollStudent`) opens the order — `src/a.ts:3-4`.'), { 'src/a.ts': src });
    expect(r.findings, 'reporting only: the relaxation still admits it').toEqual([]);
    expect(r.anchored).toBe(1);
    expect(r.viaEnclosing).toBe(1);
    expect(r.viaEnclosingAt).toEqual(['docs/x.md:1  `src/a.ts:3-4`']);
  });

  it('does not count an anchor found inside the range', () => {
    const r = audit(doc('The write is `insert(orders)` — `src/a.ts:3-4`.'), { 'src/a.ts': src });
    expect(r.anchored).toBe(1);
    expect(r.viaEnclosing).toBe(0);
  });

  it('the CLI prints the split with the all-clear', () => {
    const cli = readFileSync(join(ROOT, 'scripts/citation-guard.mjs'), 'utf8');
    expect(cli).toMatch(/only via the enclosing scope, not inside the cited range/);
  });
});

describe('docs/projects/** is not read at all (RA-1742)', () => {
  /**
   * THE CHECK REMOVED HERE WAS POLICING A CLAIM THE ARTIFACT NO LONGER MAKES, and that
   * distinction is the whole argument, so it is recorded as a test rather than only in
   * a commit message.
   *
   * A brief used to be a DATED MEASUREMENT: it named the commit its coordinates were
   * taken against, and `main` resolved them against that tree (RA-1449/RA-1451), because
   * re-deriving a deletion project's coordinates against a later tree falsifies the
   * record rather than fixing it (RA-1305, RA-1445). That machinery was correct. It was
   * also ~120 lines — a header parse, a `git show` reader, a shallow-clone fail-open, an
   * orphaned-sha finding, `fetch-depth: 0` in three workflows — whose only consumer was
   * six documents that should never have carried a coordinate.
   *
   * RA-1742 removed the claim instead: a brief cites an invariant id or a command, and
   * `brief-guard.mjs` fails a new one containing a coordinate. So there is nothing here
   * to resolve. This asserts the exclusion by CONTENT of the run's own output, since
   * "the guard reads fewer files" is otherwise indistinguishable from a guard that
   * quietly stopped working — the shape (RA-945) this whole file exists to serve.
   */
  it('excludes the brief tree from the corpus it audits, and says so', () => {
    const out = execFileSync('node', [join(ROOT, 'scripts/citation-guard.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out).toMatch(/not reading \d+ file\(s\) under `docs\/projects\/`/);
    expect(out).not.toMatch(/docs\/projects\/\d+\.md — checked against/);
  });

  it('exports no brief machinery any more', async () => {
    // A dead export is what "removed" degrades into: `measuredCommitIn` with no caller
    // still typechecks, still passes its own unit tests, and reads as a live contract.
    const mod = await import('../../scripts/citation-guard.mjs');
    expect(Object.keys(mod)).not.toContain('measuredCommitIn');
    expect(Object.keys(mod)).not.toContain('isProjectBrief');
  });
});

describe('a line number pointing into the document itself is refused in the oracle (RA-1479)', () => {
  /**
   * `docs/qa/specs/payments.md` carried two of these — *"See `:177` for the fully
   * qualified statement"* — both written by `71a8eb0`, both already off by exactly the
   * two lines that same commit inserted above them, and both invisible: the guard
   * discards a bare `:NNN` with no file named earlier on the line, so they were not
   * even counted as a defect. A range check cannot rescue them either, since `:177`
   * and `:179` are equally in bounds.
   *
   * SCOPED TO THE ORACLE, and the scope is measured rather than assumed. Of the 112
   * antecedent-less bare coordinates in `docs/`, 110 are continuations whose file was
   * named on an EARLIER line — 91 in one brief's wrapped prose, 12 in
   * `legacy-api-payloads.md`, which cites a CakePHP tree that is not in this repository
   * and can never resolve. Banning the form everywhere would fire on all of those. The
   * two genuine self-references were both in `docs/qa/specs/**`, which is also the one
   * corpus whose authority rests on being checked evidence.
   */
  it('covers docs/qa/specs/, and only that', () => {
    expect(isOracleSpec('docs/qa/specs/payments.md')).toBe(true);
    expect(isOracleSpec('docs/qa/specs/storefront.md')).toBe(true);
    expect(isOracleSpec('docs/qa/reviewer-playbook.md')).toBe(false);
    expect(isOracleSpec('docs/projects/1015.md')).toBe(false);
    expect(isOracleSpec('docs/legacy-api-payloads.md')).toBe(false);
  });

  it('fails on a self-reference in a spec instead of discarding it', () => {
    const r = audit(
      { 'docs/qa/specs/x.md': 'See `:177` for the fully qualified statement.' },
      {},
    );
    expect(r.discarded, 'not silently dropped — that is the whole defect').toBe(0);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toMatch(/quote the heading or marker phrase/);
  });

  it('still reads a continuation in a spec, which names its file on the line', () => {
    const r = audit(
      { 'docs/qa/specs/x.md': 'The write is `inArray(courseIds)` at `src/a.ts:1`, `:2`.' },
      { 'src/a.ts': 'inArray(courseIds)\ninArray(courseIds)\n' },
    );
    expect(r.checked).toBe(2);
    expect(r.findings).toEqual([]);
  });

  it('keeps discarding it outside the oracle, where it is a wrapped continuation', () => {
    const r = audit({ 'docs/legacy.md': 'The refund helper (`:3106`) validates the keys.' }, {});
    expect(r.findings).toEqual([]);
    expect(r.discarded).toBe(1);
    // NAMED, not just counted (RA-1451): a number says something was dropped and nothing
    // about where, so a new bare coordinate lands in a bucket of a hundred and reads as
    // unchanged.
    expect(r.discardedBy).toEqual({ 'docs/legacy.md': 1 });
  });
});

describe('a LONGER identifier does not certify a shorter one (RA-2211)', () => {
  /**
   * `` `createTenant()` … `tenancy.ts:80` `` anchored on `createTenantInput`, which merely
   * CONTAINS `createTenant` as a substring. `createTenant` itself was on line 88, eight
   * lines down — the block shift RA-2208 left behind — and the guard reported the citation
   * as anchor-checked. Two plausible names eight lines apart is the worst case for a
   * substring test: it does not degrade to range-checked, it affirms the wrong line.
   */
  it('refuses `createTenant` anchored on `createTenantInput`', () => {
    const r = audit(
      doc('`createTenant()` is the minimal path (`src/a.ts:1`).'),
      { 'src/a.ts': 'export const createTenantInput = z.object({\n' },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toMatch(/names none of what its sentence does/);
  });

  it('still matches the identifier itself, so the tightening is not a blanket refusal', () => {
    const r = audit(
      doc('`createTenant()` is the minimal path (`src/a.ts:1`).'),
      { 'src/a.ts': 'export async function createTenant(rawInput: unknown) {\n' },
    );
    expect(r.findings).toEqual([]);
  });

  it('treats `$` as part of an identifier, which `\\b` alone does not', () => {
    expect(namesIdentifier('const $foo = 1;', 'foo')).toBe(false);
    expect(namesIdentifier('const foo_bar = 1;', 'foo')).toBe(false);
    expect(namesIdentifier('  return foo(1);', 'foo')).toBe(true);
  });
});

describe('the anchor was found — in the wrong place (RA-2211)', () => {
  /**
   * `[SUPER-14]` cited `` `setTenantStatus` (`tenancy.ts:266-274`) ``. After RA-2208 shifted
   * the file by +8, `setTenantStatus` was declared on line **274** — the LAST line of the
   * stale range — so an identifier WAS found in the range, the citation was reported as
   * anchor-checked, and it pointed overwhelmingly at `updateTenant`'s body. That is not
   * the `range-checked only` degradation the run then printed a count for (a citation that
   * names no identifier, which since kanon#387 fails as unanchored).
   *
   * The rule: a range that opens inside a different block and only reaches the
   * declaration its sentence names at its far end is the signature of an insertion.
   */
  const two = [
    'export function updateTenant() {', // 1
    '  const a = 1;', //                   2
    '  const b = 2;', //                   3
    '  return a + b;', //                  4
    '}', //                                5
    '', //                                 6
    'export function setTenantStatus() {', // 7
    '  return 2;', //                      8
    '}', //                                9
  ].join('\n');

  it('refuses a range whose named declaration sits at its far end, behind other code', () => {
    const r = audit(doc('`setTenantStatus` flips the row (`src/a.ts:2-7`).'), { 'src/a.ts': two });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toMatch(/declared at src\/a\.ts:7, 5 line\(s\) BELOW/);
  });

  it('accepts the same sentence once the coordinate names the declaration', () => {
    // NON-VACUITY PARTNER. Without this the assertion above would keep passing if the
    // check started refusing every multi-line range — passing louder rather than failing.
    const r = audit(doc('`setTenantStatus` flips the row (`src/a.ts:7-9`).'), { 'src/a.ts': two });
    expect(r.findings).toEqual([]);
  });

  it('refuses a range that ends BEFORE the declaration its sentence names', () => {
    // The other half of the same shape, and the commoner one: `[COURSE-2]` cited
    // `courses.ts:128-174` for `createCourse`'s idempotency dedup while `createCourse` is
    // declared at 277. It passed because the range happens to contain the weak token
    // `courses`, which the sentence also names. A declaration the sentence names outvotes
    // a generic token that merely appears.
    const src = [
      'export function listCourses() {', //          1
      '  return db.select().from(courses);', //      2
      '}', //                                        3
      '', //                                         4
      'export function createCourse() {', //         5
      '  return 1;', //                              6
      '}', //                                        7
    ].join('\n');
    const r = audit(doc('`createCourse` dedups on `courses.idempotencyKey` (`src/a.ts:1-3`).'), { 'src/a.ts': src });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toMatch(/`createCourse` is declared at src\/a\.ts:5/);
  });

  it('still accepts a coordinate INSIDE the body of the function its sentence names', () => {
    // The commonest correct shape in the corpus — `getTenantDetail` (`tenancy.ts:249-251`)
    // targets a statement in its body. The check is deliberately one-directional for this
    // reason: a declaration ABOVE the range start is always admitted.
    const r = audit(doc('`setTenantStatus` flips the row (`src/a.ts:8`).'), { 'src/a.ts': two });
    expect(r.findings).toEqual([]);
  });

  it('still accepts a range that opens on the declaration\'s own doc comment', () => {
    // `tenancy.ts:197-207` deliberately includes the block comment above the statement.
    // Comment and blank lines between the range start and the declaration are what
    // separates "this citation includes the docstring" from "this range covers another
    // block's code", and that distinction is the whole discriminator.
    const src = ['/**', ' * What it does.', ' */', 'export function doIt() {', '  return 1;', '}'].join('\n');
    const r = audit(doc('`doIt` does it (`src/a.ts:1-6`).'), { 'src/a.ts': src });
    expect(r.findings).toEqual([]);
  });

  it('does not fire on a declaration that is not TOP-LEVEL', () => {
    // MEASURED FALSE POSITIVE, six of them. `docs/qa/specs/observability.md` names
    // `pagedBusinessEvents` — declared six indents down inside a function in
    // `sst.config.ts` — while deliberately citing six `alarmDescription`s eight hundred
    // lines ABOVE it, to say they are outside that array's scope. Reading nested
    // declarations reported every one as drifted. They are correct.
    const src = [
      'export function build() {', //           1
      '  const alarmDescription = "x";', //     2
      '  const pagedBusinessEvents = [];', //   3
      '  return [alarmDescription, pagedBusinessEvents];', // 4
      '}', //                                   5
    ].join('\n');
    const r = audit(
      doc('Outside the `pagedBusinessEvents` loop, each `alarmDescription` (`src/a.ts:2`) is short.'),
      { 'src/a.ts': src },
    );
    expect(topLevelDeclarations(src.split('\n')).has('pagedBusinessEvents')).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it('measures the shift, so the number is available to correlate on', () => {
    const lines = two.split('\n');
    expect(declarationShift(lines, 2, ['setTenantStatus'])).toEqual({
      token: 'setTenantStatus',
      declLine: 7,
      shift: 5,
    });
    expect(declarationShift(lines, 7, ['setTenantStatus'])).toBeNull();
    expect(declarationShift(lines, 2, ['somethingElse']), 'no named declaration, no verdict')
      .toBeNull();
  });
});

describe('one edit shifts a BLOCK, and the block is what gets reported (RA-2211)', () => {
  /**
   * THE REASON THIS EXISTS IS THE CITATIONS IT CANNOT SEE. Of the 16 coordinates into
   * `tenancy.ts` that RA-2208 shifted, the per-citation rule above reaches the ones whose
   * sentence names a top-level declaration. The rest name nothing checkable — *"**Insert
   * the tenant row** — `tenancy.ts:197-207`"* names no identifier at all — so no
   * per-citation rule can say they shifted (since kanon#387 they fail as unanchored, which
   * says nothing about a shift). They were stale by
   * exactly the same `k`. Naming the FILE is what carries the finding across to them.
   */
  const shifted = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      `export function fillerBlock${i}() {`,
      '  return 0;',
      '}',
      '',
      `export function movedTarget${i}() {`,
      '  return 1;',
      '}',
      '',
    ]).flat().join('\n');

  // Each block is 8 lines; `movedTargetN` is declared at `8n + 5`, and each citation opens
  // 4 lines early — one uniform `k` of 4, the way one insertion produces one uniform shift.
  const citations = (n: number) =>
    Array.from({ length: n }, (_, i) => `\`movedTarget${i}()\` returns one (\`src/a.ts:${8 * i + 1}-${8 * i + 5}\`).`).join('\n');

  it('names the file once when enough citations agree on one shift', () => {
    const r = audit({ 'docs/x.md': citations(BLOCK_MIN) }, { 'src/a.ts': shifted(BLOCK_MIN) });
    expect(r.findings).toHaveLength(BLOCK_MIN);
    expect(r.blocks).toEqual([{ path: 'src/a.ts', shift: 4, count: BLOCK_MIN, citations: BLOCK_MIN }]);
  });

  it('does not call a smaller agreement a block', () => {
    // Exact equality is already a strong coincidence filter, but this report sends
    // someone to re-derive EVERY coordinate in a file, which is an expensive instruction
    // to issue wrongly. The individual findings still stand — only the file-level claim
    // is withheld.
    const r = audit({ 'docs/x.md': citations(BLOCK_MIN - 1) }, { 'src/a.ts': shifted(BLOCK_MIN - 1) });
    expect(r.findings).toHaveLength(BLOCK_MIN - 1);
    expect(r.blocks).toEqual([]);
  });

  it('counts EVERY coordinate into the file, not only the ones it could judge', () => {
    // The count is the instruction: "N of them are shifted; M point into this file; go
    // and re-derive all M". A total equal to the finding count would silently understate
    // the work and re-create the gap.
    const docBody = `${citations(BLOCK_MIN)}\nInsert the tenant row — \`src/a.ts:2-3\`.`;
    const r = audit({ 'docs/x.md': docBody }, { 'src/a.ts': shifted(BLOCK_MIN) });
    expect(r.blocks[0].citations).toBe(BLOCK_MIN + 1);
    expect(r.blocks[0].count).toBe(BLOCK_MIN);
  });

  it('the CLI prints the block before the per-citation list', () => {
    // A block shift changes what the list below it MEANS — the listed findings become a
    // sample rather than the set. Printed after, it would read as a summary of the list.
    const src = readFileSync(join(ROOT, 'scripts/citation-guard.mjs'), 'utf8');
    expect(src).toMatch(/BLOCK SHIFT — \$\{bl\.count\}/);
    expect(src.indexOf('BLOCK SHIFT')).toBeLessThan(src.indexOf('HARD ORACLE, which the Explorer files bugs against'));
  });
});


describe('only a WHOLE identifier may accuse a coordinate of drift (RA-2254)', () => {
  /**
   * `tokensOf` splits `orders.status` into `orders` and `status` — right for the anchor,
   * wrong for `declarationShift`, whose verdict is "re-derive this coordinate". `orders`
   * is a top-level table in `commerce.ts`, so a CORRECT citation of the `orderStatus` enum
   * measured as a +10 shift towards the table, and the remedy told its author to replace
   * a right coordinate with a wrong one.
   */
  const commerce = [
    'import { pgEnum, pgTable } from "x";', //         1
    'export const orderStatus = pgEnum("status", [', // 2
    '  "open",', //                                     3
    '  "paid",', //                                     4
    ']);', //                                           5
    '', //                                              6
    'export const orderRows = pgTable("orders", {', // 7
    '  status: orderStatus("status"),', //              8
    '});', //                                           9
  ].join('\n');

  it('does not accuse on a token that came from a compound span', () => {
    // The anchor still lands (`status` is in the range); `orders` merely does not govern.
    const r = audit(doc('The six values of `orderRows.status` (`src/commerce.ts:2-5`).'), { 'src/commerce.ts': commerce });
    expect(r.findings).toEqual([]);
    expect(r.anchored).toBe(1);
  });

  it('still accuses when the sentence names the declaration as a whole identifier', () => {
    // NON-VACUITY PARTNER: the same coordinate, with the table named on its own.
    const r = audit(doc('The `orderRows` table carries `orderRows.status` (`src/commerce.ts:2-5`).'), { 'src/commerce.ts': commerce });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].problem).toMatch(/`orderRows` is declared at src\/commerce\.ts:7/);
    // …and says the other reading out loud rather than only "insertion".
    expect(r.findings[0].problem).toMatch(/unless the sentence names `orderRows` in passing/);
  });

  it('reads a called identifier, with or without arguments, as whole', () => {
    expect(strongNames(['createCourse()', 'setTenantStatus(id, status)', 'orders.status', 'a b', '`x`'])).toEqual([
      'createCourse',
      'setTenantStatus',
    ]);
  });

  it('the CLI footer tells the reader to confirm by content before moving an accused coordinate', () => {
    const src = readFileSync(join(ROOT, 'scripts/citation-guard.mjs'), 'utf8');
    expect(src).toMatch(/confirm by content before moving it/);
  });
});

describe('a line number written OUTSIDE the backticks is a coordinate (RA-2224)', () => {
  /**
   * `` `tenancy.ts` L179-214 `` was parsed as a bare path — antecedent only — and its
   * numbers were dropped uncounted, so `[SUPER-10]` rotted on a `[confirmed]` clause
   * while the all-clear counted nothing amiss.
   */
  const src = [
    'export function other() {', //    1
    '  return 0;', //                  2
    '}', //                            3
    'export function provisionTenant() {', // 4
    '  insertTenant();', //            5
    '  insertMembership();', //        6
    '}', //                            7
  ].join('\n');

  it('parses it, and replaces the path-only antecedent at the same offset', () => {
    const cs = coordinatesIn('`provisionTenant` in `src/a.ts` L4-7 inserts.');
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ file: 'src/a.ts', a: 4, b: 7 });
  });

  it('checks it: a stale L-range is a finding, a correct one passes', () => {
    const stale = audit(doc('`provisionTenant` in `src/a.ts` L1-3 inserts the rows.'), { 'src/a.ts': src });
    expect(stale.findings).toHaveLength(1);
    expect(stale.findings[0].citation).toBe('`src/a.ts` L1-3');
    const ok = audit(doc('`provisionTenant` in `src/a.ts` L4-7 inserts the rows.'), { 'src/a.ts': src });
    expect(ok.findings).toEqual([]);
    expect(ok.checked).toBe(1);
  });

  it('anchors a later coordinate on its own segment, not on the text before the L-form', () => {
    const cs = coordinatesIn('`a.ts` L1-2 then `:5`');
    expect(cs.map((c) => [c.file, c.a])).toEqual([['a.ts', 1], ['a.ts', 5]]);
  });

  it('counts a coordinate into an untracked, ignored dependency as EXTERNAL — never failed, never silently dropped', () => {
    const r = auditIgnoring(doc('Better Auth defaults it (`node_modules/better-auth/x.mjs` L117-124, `node_modules/y.mjs:4`).'), {});
    expect(r.findings).toEqual([]);
    expect(r.external).toBe(2);
    expect(r.externalBy).toEqual({ 'docs/x.md': 2 });
    expect(r.checked).toBe(0);
  });
});

/**
 * #108 — what counts as a dependency is what git ignores and doesn't track, not a folder
 * name, so every stack's dependency tree is external and a typo still fails.
 */
describe('isExternal: an untracked, git-ignored path, on any stack (#108)', () => {
  it('counts a Python venv coordinate as external', () => {
    const r = auditIgnoring(doc('Requests retries it (`.venv/lib/python3.12/site-packages/requests/api.py:59`).'), {});
    expect(r.findings).toEqual([]);
    expect(r.external).toBe(1);
  });

  it('still fails a mistyped repository path, which is untracked but not ignored (K-PRIN-8)', () => {
    const r = auditIgnoring(doc('`provisionTenant` (`src/oders/a.ts:4`).'), { 'src/orders/a.ts': 'x\n'.repeat(9) });
    expect(r.external).toBe(0);
    expect(r.findings.map((f) => f.problem)).toEqual(['no such file in the repository']);
  });

  it('judges a TRACKED file under an ignored folder, exactly or by basename: the repository holds it', () => {
    const files = { '.venv/vendored.py': 'x\n'.repeat(3) };
    const r = auditIgnoring(doc('Vendored (`.venv/vendored.py:40`) and by name (`vendored.py:41`).'), files, () => true);
    expect(r.external).toBe(0);
    expect(r.findings).toHaveLength(2);
  });

  it('counts nothing as external when no ignore rule is given', () => {
    const r = audit(doc('Dep (`node_modules/y.mjs:4`).'), {});
    expect(r.external).toBe(0);
    expect(r.findings).toHaveLength(1);
  });

  it('names each external PATH per doc, distinct, not only a count (kanon#120)', () => {
    const r = auditIgnoring(doc('Dep (`node_modules/y.mjs:4`, `node_modules/y.mjs:9`, `.venv/z.py:2`).'), {});
    expect(r.external).toBe(3);
    expect(r.externalPaths).toEqual({ 'docs/x.md': ['node_modules/y.mjs', '.venv/z.py'] });
  });

  // kanon#120: GitHub's stock Python template ignores `lib/` and `build/`. With a file under
  // `src/pkg/lib/` tracked anyway, git calls every untracked path under it ignored.
  const pythonTemplate = (p: string) => /(^|\/)(lib|build)\//.test(p) || /^(node_modules|\.venv)\//.test(p);
  const ownLib = { 'src/pkg/lib/a.py': 'def a():\n    pass\n' };

  it('judges a typo under an ignored directory the repository tracks files in (kanon#120)', () => {
    const r = auditIgnoring(doc('`a` (`src/pkg/lib/aa.py:1`) and (`src/pkg/lib/nested/x.py:1`).'), ownLib, pythonTemplate);
    expect(r.external).toBe(0);
    expect(r.findings.map((f) => f.problem)).toEqual(['no such file in the repository', 'no such file in the repository']);
  });

  it('still counts a dependency external under the same ignore file (kanon#120)', () => {
    const r = auditIgnoring(doc('Dep (`node_modules/better-auth/dist/x.mjs:4`) and (`.venv/lib/python3.12/site-packages/requests/api.py:59`).'), ownLib, pythonTemplate);
    expect(r.findings).toEqual([]);
    expect(r.external).toBe(2);
  });

  it('keeps a path ignored by a FILE pattern, with no ignored directory above it, external (kanon#120)', () => {
    const generated = (p: string) => /\.generated\.ts$/.test(p);
    const r = auditIgnoring(doc('Codegen (`src/api.generated.ts:4`).'), { 'src/orders/a.ts': 'x\n' }, generated);
    expect(r.findings).toEqual([]);
    expect(r.external).toBe(1);
  });

  it('an allow-list ignore file still hides a top-level typo — named, not judged (kanon#120, the residual)', () => {
    const allowList = (p: string) => !p.startsWith('src/');
    const r = auditIgnoring(doc('`a` (`scr/orders/a.ts:4`).'), { 'src/orders/a.ts': 'x\n'.repeat(9) }, allowList);
    expect(r.external).toBe(1);
    expect(r.externalPaths).toEqual({ 'docs/x.md': ['scr/orders/a.ts'] });
  });

  it('gitIgnored answers by the ignore rules alone, so a directory holding a tracked file reads as ignored (kanon#120)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ignored-lib-'));
    const cwd = process.cwd();
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), 'lib/\nnode_modules/\n');
      mkdirSync(join(dir, 'src/pkg/lib'), { recursive: true });
      writeFileSync(join(dir, 'src/pkg/lib/a.py'), 'def a():\n    pass\n');
      execFileSync('git', ['add', '.gitignore'], { cwd: dir });
      execFileSync('git', ['add', '-f', 'src/pkg/lib/a.py'], { cwd: dir });
      process.chdir(dir);
      const ignored = gitIgnored();
      expect(ignored('src/pkg/lib/')).toBe(true);
      const tracked = ['.gitignore', 'src/pkg/lib/a.py'];
      const r = auditCitations(['docs/x.md'], (p: string) => (p === 'docs/x.md' ? '`a` (`src/pkg/lib/aa.py:1`), dep (`node_modules/x.mjs:3`).' : readFileSync(join(dir, p), 'utf8')), ['docs/x.md', ...tracked], { ignored });
      expect(r.externalPaths).toEqual({ 'docs/x.md': ['node_modules/x.mjs'] });
      expect(r.findings.map((f) => [f.citation, f.problem])).toEqual([['`src/pkg/lib/aa.py:1`', 'no such file in the repository']]);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gitIgnored reads the working directory\'s ignore rules, for paths that need not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ignored-'));
    const cwd = process.cwd();
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), '.venv/\nnode_modules\n');
      process.chdir(dir);
      const ignored = gitIgnored();
      expect(ignored('.venv/lib/python3.12/site-packages/requests/api.py')).toBe(true);
      expect(ignored('node_modules/y.mjs')).toBe(true);
      expect(ignored('src/orders/a.ts')).toBe(false);
      // git's error for a path outside the repository is not "ignored", so it is judged.
      expect(ignored('../elsewhere/x.py')).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // kanon#232: a placeholder force-added into an ignored dependency tree is not the
  // repository's code, so the tree's coordinates stay external.
  it('keeps a dependency external when a placeholder is force-added into its ignored directory (kanon#232)', () => {
    const vendor = (p: string) => p.startsWith('vendor/');
    for (const placeholder of ['vendor/.gitkeep', 'vendor/README.md']) {
      const r = auditIgnoring(doc('Rack (`vendor/bundle/ruby/3.3.0/gems/rack/lib/rack.rb:12`).'), { [placeholder]: '' }, vendor);
      expect(r.findings).toEqual([]);
      expect(r.externalPaths).toEqual({ 'docs/x.md': ['vendor/bundle/ruby/3.3.0/gems/rack/lib/rack.rb'] });
    }
  });

  it('with real git: a force-added `vendor/.gitkeep` leaves `vendor/bundle/…` external (kanon#232)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ignored-vendor-'));
    const cwd = process.cwd();
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), 'vendor/\n');
      mkdirSync(join(dir, 'vendor'), { recursive: true });
      writeFileSync(join(dir, 'vendor/.gitkeep'), '');
      execFileSync('git', ['add', '.gitignore'], { cwd: dir });
      execFileSync('git', ['add', '-f', 'vendor/.gitkeep'], { cwd: dir });
      process.chdir(dir);
      const r = auditCitations(['docs/x.md'], () => 'Rack (`vendor/bundle/ruby/3.3.0/gems/rack/lib/rack.rb:12`).', ['docs/x.md', '.gitignore', 'vendor/.gitkeep'], { ignored: gitIgnored() });
      expect(r.findings).toEqual([]);
      expect(r.external).toBe(1);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still judges a typo beside a tracked SOURCE file in the same ignored directory (kanon#120 after kanon#232)', () => {
    const vendor = (p: string) => p.startsWith('vendor/');
    const r = auditIgnoring(doc('`a` (`vendor/own/aa.rb:1`).'), { 'vendor/.gitkeep': '', 'vendor/own/a.rb': 'x\n' }, vendor);
    expect(r.external).toBe(0);
    expect(r.findings.map((f) => f.problem)).toEqual(['no such file in the repository']);
  });
});

/**
 * kanon#120's residuals, ADVISORY: an external path that looks like a typo is warned about,
 * never failed. `absent` reads the working tree; `suffix` reads the index.
 */
describe('externalSuspicion: an external path that looks like a typo (kanon#120, advisory)', () => {
  const pythonTemplate = (p: string) => /(^|\/)(lib|build)\//.test(p) || /^(node_modules|\.venv)\//.test(p);
  const ownLib = { 'src/pkg/lib/a.py': 'def a():\n    pass\n' };

  it('flags a typo cited by suffix under an ignored directory the repository keeps source in', () => {
    const r = auditIgnoring(doc('`a` (`lib/aa.py:1`), (`pkg/lib/aa.py:1`), dep (`node_modules/x.mjs:3`).'), ownLib, pythonTemplate);
    expect(r.findings).toEqual([]);
    expect(r.external).toBe(3);
    expect(r.suspectExternal).toEqual([
      { doc: 'docs/x.md', path: 'lib/aa.py', reasons: ['suffix'] },
      { doc: 'docs/x.md', path: 'pkg/lib/aa.py', reasons: ['suffix'] },
    ]);
  });

  it('does not count a placeholder as source for the suffix reason', () => {
    const r = auditIgnoring(doc('`a` (`lib/aa.py:1`).'), { 'src/pkg/lib/.gitkeep': '' }, pythonTemplate);
    expect(r.suspectExternal).toEqual([]);
  });

  it('flags an allow-list top-level typo that is not on disk, and not an installed dependency', () => {
    const allowList = (p: string) => !p.startsWith('src/') && p !== 'docs/x.md';
    const installed = (p: string) => p.startsWith('node_modules/');
    const r = auditCitations(
      ['docs/x.md'],
      () => '`a` (`scr/orders/a.ts:4`), dep (`node_modules/y.mjs:2`).',
      ['docs/x.md', 'src/orders/a.ts'],
      { ignored: allowList, exists: installed },
    );
    expect(r.findings).toEqual([]);
    expect(r.external).toBe(2);
    expect(r.suspectExternal).toEqual([{ doc: 'docs/x.md', path: 'scr/orders/a.ts', reasons: ['absent'] }]);
  });

  it('names a path once per doc, with every reason that applies', () => {
    expect(externalSuspicion('lib/aa.py', ['src/pkg/lib/a.py'], pythonTemplate, () => false)).toEqual(['absent', 'suffix']);
    expect(externalSuspicion('node_modules/x.mjs', ['src/pkg/lib/a.py'], pythonTemplate, () => true)).toEqual([]);
    const r = auditIgnoring(doc('`a` (`lib/aa.py:1`, `lib/aa.py:2`).'), ownLib, pythonTemplate);
    expect(r.suspectExternal).toHaveLength(1);
  });

  it('end to end: the CLI prints the advisory for an allow-list typo and still exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ignored-allow-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), '/*\n!/src/\n!/docs/\n!/.gitignore\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'src/a.ts'), 'export const placeOrder = 1;\n');
      writeFileSync(join(dir, 'docs/x.md'), '`placeOrder` (`src/a.ts:1`); a typo (`scr/a.ts:1`).\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      const out = execFileSync('node', [join(ROOT, 'scripts/citation-guard.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
      expect(out).toContain('citation-guard (advisory): `scr/a.ts` in docs/x.md was counted as a dependency');
      expect(out).toContain('1 citation(s) across 1 docs resolve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints one warning per path, as an annotation in CI, and never changes a verdict', () => {
    const list = [{ doc: 'docs/x.md', path: 'lib/aa.py', reasons: ['absent', 'suffix'] }];
    const [local] = suspectExternalLines(list, false);
    expect(local).toMatch(/^citation-guard \(advisory\): `lib\/aa\.py` in docs\/x\.md was counted as a dependency/);
    expect(local).toContain('not in the working tree');
    expect(local).toContain('one the repository keeps source files in');
    expect(suspectExternalLines(list, true)[0]).toMatch(/^::warning::citation-guard \(advisory\)/);
  });


});

describe('the Clause typedef names the statuses clauseAt can return, derived (RA-2138)', () => {
  it('rejects a status outside STATUSES and accepts each one inside it, under a real checkJs', () => {
    // NOTHING IN CI TYPECHECKS `.mjs` (`tsconfig.json` includes only `*.ts(x)`, `checkJs`
    // off), so a JSDoc reference that fails to resolve degrades SILENTLY to `any` — and
    // `STATUSES` without its `@type {const}` makes the element type plain `string`, which
    // accepts anything. This compiles a probe that uses the typedef and asserts both.
    const dir = mkdtempSync(join(tmpdir(), 'clause-type-'));
    const guard = join(ROOT, 'scripts/citation-guard.mjs').replace(/\\/g, '/');
    const probe = join(dir, 'probe.mjs');
    writeFileSync(
      probe,
      [
        `/** @typedef {import('${guard}').Clause} C */`,
        ...STATUSES.map((st, i) => `/** @type {C} */ export const ok${i} = { id: 'X-1', status: '${st}' };`),
        `/** @type {C} */ export const bad = { id: 'X-1', status: 'bogus' };`,
      ].join('\n'),
    );
    const program = ts.createProgram([probe], {
      allowJs: true, checkJs: true, noEmit: true, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [],
    });
    const errors = ts.getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === probe)
      .map((d) => `${d.file!.getLineAndCharacterOfPosition(d.start!).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^${STATUSES.length + 2}: Type '"bogus"' is not assignable`));
  }, 30_000);
});

describe('the Markdown a run reads is a list of globs, `docs/**/*.md` by default (kanon#388)', () => {
  const tracked = [
    'docs/a.md', 'docs/qa/specs/b.md', 'docs/.notes/c.md', 'docs/projects/1.md', 'docs/x.ts',
    'rulebook/01-work-items.md', 'rulebook/templates/brief.md', 'README.md', 'actions/dco/README.md', 'actions/dco/action.yml', 'src/a.ts',
  ];

  it('reads with no --path exactly what the `docs/` prefix test it replaced read', () => {
    const before = tracked.filter((f) => f.startsWith('docs/') && f.endsWith('.md') && !f.startsWith('docs/projects/'));
    expect(docPatternsFrom([])).toEqual({ patterns: DOC_PATTERNS, explicit: false });
    expect(DOC_PATTERNS).toEqual(['docs/**/*.md']);
    expect(selectDocs(tracked, docPatternsFrom([]))).toEqual({ docs: before, briefsSkipped: 1, unmatched: [] });
  });

  it('reads the globs it is given instead, each once, and never a non-Markdown file or a brief', () => {
    const sel = docPatternsFrom(['--verbose', '--path', 'rulebook/**/*.md', '--path', 'README.md', '--path', 'actions/*/README.md', '--path', 'docs/**']);
    expect(sel).toEqual({ patterns: ['rulebook/**/*.md', 'README.md', 'actions/*/README.md', 'docs/**'], explicit: true });
    expect(selectDocs(tracked, sel)).toEqual({
      docs: ['docs/a.md', 'docs/qa/specs/b.md', 'docs/.notes/c.md', 'rulebook/01-work-items.md', 'rulebook/templates/brief.md', 'README.md', 'actions/dco/README.md'],
      briefsSkipped: 1,
      unmatched: [],
    });
  });

  it('names an explicit glob that selects nothing it reads, and exempts the default', () => {
    const sel = docPatternsFrom(['--path', 'rulbook/**/*.md', '--path', 'src/**', '--path', 'docs/projects/*.md', '--path', 'README.md']);
    expect(selectDocs(tracked, sel).unmatched).toEqual(['rulbook/**/*.md', 'src/**', 'docs/projects/*.md']);
    expect(selectDocs(['src/a.ts'], docPatternsFrom([]))).toEqual({ docs: [], briefsSkipped: 0, unmatched: [] });
  });

  it('refuses a --path with no glob after it', () => {
    expect(() => docPatternsFrom(['--path'])).toThrow('--path needs a glob');
    expect(() => docPatternsFrom(['--path', '--verbose'])).toThrow('--path needs a glob');
  });

  it('globs: `*` and `?` stay in a segment, a `**` segment spans none or many, the rest is literal', () => {
    const m = (g: string, f: string) => globToRegExp(g).test(f);
    expect(m('actions/*/README.md', 'actions/dco/README.md')).toBe(true);
    expect(m('actions/*/README.md', 'actions/a/b/README.md')).toBe(false);
    expect(m('rulebook/**/*.md', 'rulebook/a.md')).toBe(true);
    expect(m('rulebook/**/*.md', 'rulebook/t/p/a.md')).toBe(true);
    expect(m('rulebook/**', 'rulebook/t/a.md')).toBe(true);
    expect(m('README.md', 'actions/dco/README.md')).toBe(false);
    expect(m('README.md', 'READMExmd')).toBe(false);
    expect(m('doc?/a.md', 'docs/a.md')).toBe(true);
    expect(m('doc?/a.md', 'doc/a.md')).toBe(false);
    expect(m('(a)+/[b].md', '(a)+/[b].md')).toBe(true);
  });

  /** The CLI on a repository with a stale coordinate in `rulebook/` and a sound one in `docs/`. */
  const runGuard = (args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'cite-paths-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'docs'));
      mkdirSync(join(dir, 'rulebook'));
      writeFileSync(join(dir, 'src/a.ts'), '// Reads the deploy workflow.\nexport const readDeploy = () => 1;\n');
      writeFileSync(join(dir, 'docs/x.md'), 'It reads `readDeploy` (`src/a.ts:2`).\n');
      writeFileSync(join(dir, 'rulebook/r.md'), '# A rule\n\nIt reads `readDeploy` (`src/a.ts:1`).\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      const r = spawnSync('node', [join(ROOT, 'scripts/citation-guard.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('the default list still ignores a stale coordinate in rulebook/', () => {
    const r = runGuard([]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('1 citation(s) across 1 docs resolve');
    expect(r.out).toContain('  read: docs/**/*.md (the default; `--path <glob>` reads others)');
  });

  it('a stale coordinate in rulebook/ fails the guard once rulebook/ is on the list', () => {
    const r = runGuard(['--path', 'docs/**/*.md', '--path', 'rulebook/**/*.md']);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('rulebook/r.md:3');
    expect(r.out).toContain('`src/a.ts:1`');
    expect(r.out).not.toContain('docs/x.md:1');
  });

  it('a mistyped glob fails by name, and a bare --path fails, before anything is judged', () => {
    const typo = runGuard(['--path', 'rulbook/**/*.md']);
    expect(typo.status, typo.out).toBe(1);
    expect(typo.out).toContain('`--path rulbook/**/*.md` selected no tracked Markdown file it reads');
    const bare = runGuard(['--path']);
    expect(bare.status, bare.out).toBe(1);
    expect(bare.out).toContain('--path needs a glob');
  });
});
