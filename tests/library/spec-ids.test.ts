import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECL, SPEC_DIR, STATUSES, idPattern, loadPrefixes, parseAll } from '../../scripts/spec-lib.mjs';
import { check, DUP_MIN_WORDS } from '../../scripts/spec-guard.mjs';
import { allocate, report } from '../../scripts/spec-ids.mjs';
import { claimsIn, claimedFloor, collisionsWith } from '../../scripts/spec-id-claims.mjs';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { titlesIn, outsideStrings, citationOptOut, declaredUnlockable, failures } from '../../scripts/spec-coverage.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-913 — L2 invariant IDs.
 *
 * The scheme is only worth citing if "what counts as an invariant" is stable, so
 * the parser is pinned in BOTH directions. The first backfill validated only one:
 * it checked that no invariant was missed, never that nothing spurious was caught,
 * and silently numbered all 18 per-file LEGEND entries — turning storefront.md's
 * promotion-status key into STORE-1..3. Caught by reading the diff. The
 * legend-exclusion tests below are that bug's regression.
 *
 * KANON'S HALF (plan 0001, step 3). The reference adopter keeps the checks that read its own specs, tests and CI wiring.
 */

const SPEC = (body: string) => `# L2 Spec — Fixture

**Id prefix:** \`STORE\`

Promotion tags as in storefront.md.

- \`[structural]\` — derived from a reviewed contract.
- \`[confirmed]\` — a human confirmed this.
- \`[seed]\` — a hypothesis, not yet confirmed.

## Behavioral invariants

${body}
`;

function fixture(body: string, registry: Record<string, number> = { STORE: 99 }) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-'));
  writeFileSync(join(dir, 'storefront.md'), SPEC(body));
  const registryPath = join(dir, '_id-registry.json');
  writeFileSync(registryPath, JSON.stringify(registry));
  return { dir, registryPath };
}

describe('parser', () => {
  it('matches the bulleted shape', () => {
    const { dir } = fixture('- `[STORE-1]` `[confirmed]` Browsing renders the storefront.');
    expect(parseAll(dir)).toHaveLength(1);
    expect(parseAll(dir)[0]).toMatchObject({ id: 'STORE-1', status: 'confirmed' });
  });

  it('matches the BARE paragraph shape', () => {
    // Most `[structural]` contracts in corporate/kiosk/instructor/student/superadmin
    // are unbulleted. A bullets-only rule silently drops 38 real invariants.
    const { dir } = fixture('`[STORE-1]` `[structural]` `kioskLogin.input` validates a code.');
    expect(parseAll(dir)).toHaveLength(1);
  });

  it('EXCLUDES the preamble legend — the regression', () => {
    // The legend is bulleted and tag-leading, so it is indistinguishable from an
    // invariant by shape. The rule is positional: invariants live in sections.
    const { dir } = fixture('- `[STORE-1]` `[confirmed]` A real invariant.');
    const all = parseAll(dir, { legend: true });
    expect(all).toHaveLength(4); // 3 legend entries + 1 invariant
    expect(parseAll(dir)).toHaveLength(1);
    expect(parseAll(dir)[0].text).toContain('A real invariant');
  });

  it('ignores a tag mentioned mid-prose', () => {
    const { dir } = fixture('The `[confirmed]` clauses above are promoted from issue dispositions.');
    expect(parseAll(dir)).toHaveLength(0);
  });

  it('reads an invariant that has no ID yet', () => {
    const { dir } = fixture('- `[confirmed]` Not numbered yet.');
    expect(parseAll(dir)[0].id).toBeNull();
  });

  it('keeps every spec file mapped to an area prefix', () => {
    // A file with no prefix throws rather than being skipped: silently dropping a
    // whole spec from coverage is the failure this catches.
    //
    // DERIVED FROM THE DIRECTORY, not a frozen list. This was ten literal
    // filenames, which made ADDING AN L2 SPEC AREA fail CI even when the addition
    // was entirely correct — it fired on the first real project brief (RA-964),
    // whose `payments.md` + its `PAY` prefix + `"PAY": 7` were all right and
    // which `spec-guard` passed cleanly. The assertion was named for the property
    // and written to the snapshot, so it forbade exactly the growth the scheme
    // exists for, and landed the failure on whoever added an area rather than on
    // whoever froze the list.
    //
    // Deriving it also catches the direction the literal list never could: a
    // prefix left behind for a spec that has been deleted. Since RA-2701 the prefixes
    // are DECLARED in the spec files, so `loadPrefixes` throws on a spec without one —
    // and this equality is what notices a spec it skipped rather than threw on.
    //
    // `_id-registry.json` is state, not a spec — hence the `_` exclusion.
    const specFilesOnDisk = readdirSync(SPEC_DIR)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .sort();
    expect(Object.keys(loadPrefixes()).sort()).toEqual(specFilesOnDisk);
  });
});

describe('idPattern', () => {
  it('matches only the real area prefixes', () => {
    // `[F-1]` is a pre-existing feature-flag citation in instructor.md. A loose
    // /[A-Z]+-\d+/ picks it up and reports a phantom invariant.
    const text = 'cites [STORE-14] and [F-1] and [KIOSK-3] and [BOGUS-9]';
    expect(text.match(idPattern())).toEqual(['[STORE-14]', '[KIOSK-3]']);
  });
});

describe('guard', () => {
  const problems = (body: string, registry?: Record<string, number>) => {
    const { dir, registryPath } = fixture(body, registry);
    return check({ dir, registryPath }).problems;
  };

  it('passes a well-formed spec', () => {
    expect(problems('- `[STORE-1]` `[confirmed]` Fine.')).toEqual([]);
  });

  it('rejects an invariant with no ID', () => {
    expect(problems('- `[confirmed]` Unnumbered.')[0]).toMatch(/has no ID/);
  });

  it('rejects a duplicate ID', () => {
    const p = problems('- `[STORE-1]` `[confirmed]` One.\n- `[STORE-1]` `[seed]` Two.');
    expect(p.some((x) => /duplicate ID `STORE-1`/.test(x))).toBe(true);
  });

  it('rejects an unknown area prefix', () => {
    expect(problems('- `[NOPE-1]` `[confirmed]` Wrong area.')[0]).toMatch(/unknown area prefix/);
  });

  it('rejects an ID above the registry high-water mark', () => {
    // This is what makes numbers permanent: the registry records the highest EVER
    // allocated, so a deleted invariant's number cannot be handed to a new one.
    expect(problems('- `[STORE-500]` `[confirmed]` Minted by hand.')[0]).toMatch(/high-water mark/);
  });

  it('accepts a gap below the high-water mark — retirement is not an error', () => {
    // STORE-1 retired, STORE-2 remains. The gap is evidence, not mess.
    expect(problems('- `[STORE-2]` `[confirmed]` Survivor.')).toEqual([]);
  });

  it('rejects an invariant parked in the preamble where coverage cannot see it', () => {
    const { dir, registryPath } = fixture('- `[STORE-1]` `[confirmed]` Fine.');
    const path = join(dir, 'storefront.md');
    const text = SPEC('- `[STORE-1]` `[confirmed]` Fine.')
      .replace('## Behavioral invariants', '- `[confirmed]` Stray.\n\n## Behavioral invariants');
    writeFileSync(path, text);
    expect(check({ dir, registryPath }).problems[0]).toMatch(/above the first `##` heading/);
  });
});

describe('coverage does not count its own fixtures', () => {

  it('reads a title however it is written', () => {
    // Titles are single-quoted, double-quoted, backticked, and reached through
    // `it.each` / `describe.only`. Missing a form silently drops real locks. The
    // first draft used one regex, assumed the title was the first `(` argument,
    // and could not read `it.each` at all. No invariant is locked that way today,
    // so this guards the form rather than recovering anything — 23 files use it.
    //
    // THESE USE REAL IDs, DELIBERATELY (RA-1232). They said `SAMPLE-n` because the
    // scanner read file TEXT and could not tell test-shaped source quoted inside a
    // string from the real thing — written as `STORE-n` they registered as genuine
    // coverage for five real storefront invariants, this file reproducing RA-1214's own
    // bug in the test written to prove it fixed.
    //
    // An unknown prefix fixed that instance and left the class: it was a CONVENTION,
    // the same opt-in per-file shape as the `NOT_COVERAGE` list RA-1214 deleted, and
    // silent when the next tool test forgot it. `titlesIn` now consumes string
    // literals whole, so a title inside a string is structurally not a call. Using
    // real ids here is the assertion that it holds.
    const forms = [
      "it('[STORE-1] a', () => {})",
      'it("[STORE-2] b", () => {})',
      'describe(`[STORE-3] c`, () => {})',
      "it.each([1])('[STORE-4] d', () => {})",
      "describe.only('[STORE-5] e', () => {})",
    ].join('\n');
    for (const n of [1, 2, 3, 4, 5]) expect(titlesIn(forms)).toContain(`[STORE-${n}]`);
    // ...and an ID in the BODY is not a title.
    expect(titlesIn("it('x', () => { check('[STORE-9]') })")).not.toContain('STORE-9');
  });

  it('a REGEX LITERAL owns its quotes (RA-1247 review)', () => {
    // THE REGRESSION THIS LOCKS, and it was mine. The left-to-right pass consumed
    // string and template literals but not regexes, so an apostrophe inside one —
    // `/You're registered/i` — opened a phantom string that swallowed everything to
    // the next quote. Measured: 65 real titles vanished from the scan, and NONE of
    // them carried an ID yet, so the id-level differential that cleared the change
    // could not see it. The loss would have surfaced the day someone added a
    // `[STORE-n]` to one of those tests — a silent under-count, which is exactly the
    // failure RA-1235 exists to prevent, reintroduced by the fix for RA-1232.
    const src = [
      "await expect(page.getByText(/You're registered/i)).toBeVisible();",
      "test('[STORE-1] a title after a regex', () => {})",
    ].join('\n');
    expect(titlesIn(src)).toContain('[STORE-1] a title after a regex');

    // A character class may contain an unescaped `/`, and flags follow the close.
    const withClass = [
      'const re = /[a-z/]+/gi;',
      "it('[STORE-2] after a class', () => {})",
    ].join('\n');
    expect(titlesIn(withClass)).toContain('[STORE-2] after a class');

    // ...and DIVISION is not a regex: `a / b` must not swallow the rest of the file.
    const division = ['const ratio = width / height;', "it('[STORE-3] after division', () => {})"].join('\n');
    expect(titlesIn(division)).toContain('[STORE-3] after division');
  });

  it('reads an INTERPOLATED template title, eliding the interpolation (RA-1249)', () => {
    // Not mis-read — DISCARDED. `readString` asked `skipGroup` to skip `${…}`,
    // `skipGroup` had no `{` in its close map and returned -1, so `readString` returned
    // null and the caller pushed nothing. Every ID in that title vanished from BOTH
    // halves of the report, including the mentioned-not-cited section built to catch
    // exactly this. Pre-existing since RA-1214; invisible only because the one file doing
    // it also cites those IDs in plain-string titles, which nothing enforces — and a
    // loop over statuses with an interpolated title is how this repo writes exhaustive
    // assertions, so the next one would have read `Bare` while asserting the invariant.
    expect(titlesIn('it(`[STORE-1] a ${status} b`, () => {});')).toContain('[STORE-1]');
    // A nested template inside the interpolation must not terminate the outer one.
    expect(titlesIn('it(`[STORE-2] ${a ? `x` : `y`} end`, () => {});')).toContain('[STORE-2]');
    // ...nor an object literal inside it.
    expect(titlesIn('it(`[STORE-3] ${ {a:1}.a } z`, () => {});')).toContain('[STORE-3]');
  });

  it('a regex may follow a KEYWORD, not just a punctuator (RA-1250)', () => {
    // A single-char lookback cannot express this: a keyword's last letter (`n` in
    // `return`) cannot join the set without making every identifier ending in `n` a
    // false regex start — and a false start is worse than a miss, because it consumes
    // real code as a literal. So the word is read.
    const afterReturn = [
      "const f = (s) => { return /You're here/.test(s); };",
      "it('[STORE-4] after a returned regex', () => {})",
    ].join('\n');
    expect(titlesIn(afterReturn)).toContain('[STORE-4] after a returned regex');
    // DIVISION is still division — `total / count` must not swallow the file.
    const division = ['const r = total / count;', "it('[STORE-5] after division', () => {})"].join('\n');
    expect(titlesIn(division)).toContain('[STORE-5] after division');
  });

  it('reads a multi-line it.each table, brackets and quotes included', () => {
    // The shape that actually occurs: a table spanning lines, with nested arrays
    // and a `)` inside a string. Skipping it needs balance-tracking, not a lazy
    // match to the first `)`.
    const src = [
      'it.each([',
      "  ['a)b', [1, 2]],",
      "  ['c', []],",
      "])('[STORE-7] handles %s', () => {})",
    ].join('\n');
    expect(titlesIn(src)).toContain('[STORE-7]');
  });

});

describe('a mention is not a citation, and the report says which (RA-1235)', () => {
  it('blanks string literals but keeps comments', () => {
    const src = [
      "const fixture = \"it('[STORE-1] x', () => {})\";",
      '// a docblock naming [STORE-2]',
    ].join('\n');
    const out = outsideStrings(src);
    expect(out, 'a fixture string is not a mention').not.toContain('[STORE-1]');
    expect(out, 'a comment is exactly what we are looking for').toContain('[STORE-2]');
  });

  it("an apostrophe in a comment does not desynchronise the scan", () => {
    // THE BUG THIS LOCKS. The first version kept comments but still parsed quotes
    // inside them, so `don't` opened a phantom string literal and every quote after it
    // was mispaired — fixture ids survived while the code around them was blanked.
    const src = [
      "// it doesn't matter what this says",
      "const fixture = \"it('[STORE-1] x', () => {})\";",
    ].join('\n');
    expect(outsideStrings(src)).not.toContain('[STORE-1]');
  });

  it('blanks a regex literal too, so its quotes cannot desynchronise the scan', () => {
    const src = ["const re = /You're here/i;", '// [STORE-2] a real mention'].join('\n');
    const out = outsideStrings(src);
    expect(out, 'the comment mention survives').toContain('[STORE-2]');
    expect(out, "and the regex's apostrophe did not open a string").not.toContain("You're");
  });

  it('preserves line structure, so an offset still maps to its line', () => {
    const src = 'const a = `line one\nline two`;\n// [STORE-2]\n';
    expect(outsideStrings(src).split('\n').length).toBe(src.split('\n').length);
  });

});


describe('a clause may decline to be cited, and the report must honour it', () => {

  it('opts out only the clauses that say so', () => {
    // A blunt exclusion would hide real gaps. Every invariant stays eligible
    // unless it says otherwise in its own words — and since RA-603 removed
    // `[PAY-8]`'s declaration, none currently does. Asserted as an exact count so
    // that a new opt-out has to be a deliberate, visible act rather than
    // something that accretes.
    const invariants = parseAll();
    expect(citationOptOut(invariants).size).toBe(0);
  });
});

describe("titlesIn is checked against an independent parser, not against the shape last found broken (RA-1255)", () => {
  // WHY AN ORACLE AND NOT MORE FIXTURES. Four consecutive changes to the same ~40
  // lines each fixed a different way the hand scanner silently discards a title, and
  // every one was found by a human reading the code: RA-1247 (a regex after a
  // punctuator), RA-1250 (a regex after a keyword), RA-1249 (an interpolated title),
  // RA-1253 (a comment between the keyword and the regex). Nothing detected any of
  // them, because `LOCKED_FLOOR` only fires on a drop BELOW the floor — so a
  // simultaneous add-and-lose reads clean, and a title's IDs vanish from the report
  // on the day it is written rather than three PRs later.
  //
  // MEASURED, and this is why the check is worth its runtime: on `origin/main` at
  // 606c3f6 — with RA-1247, RA-1249, RA-1250 and RA-1252 all merged — this oracle found THREE
  // titles the scanner was still dropping, from two classes no fixture covered:
  // `skipGroup` parsed quotes inside comments (so `// a different agent's PR` inside
  // an `it.each` table killed the title), and only `.each` was treated as a modifier
  // that takes arguments (so `it.runIf(cond)('…')` produced nothing). Both are fixed
  // in this change; the oracle is what will find the next one.
  //
  // SUBSET, NOT EQUALITY, and the direction is load-bearing. `titlesIn` legitimately
  // produces titles a naive AST walk does not, because `it.each(table)('…')` has a
  // CallExpression as its callee — a walker that only unwraps property access never
  // reaches it, and reports 54 phantom extras. The walker below unwraps calls and
  // tagged templates for that reason, but the assertion stays one-directional: an
  // oracle miss is an oracle bug, a scanner miss is a lost lock.
  const ORACLE_CALLERS = new Set(['it', 'test', 'describe']);

  /** The bare `it` / `test` / `describe` at the root of a (possibly curried) callee. */
  const rootName = (expr: ts.Expression): string | null => {
    let n: ts.Node = expr;
    for (;;) {
      if (ts.isPropertyAccessExpression(n)) { n = n.expression; continue; }
      if (ts.isCallExpression(n)) { n = n.expression; continue; }
      if (ts.isTaggedTemplateExpression(n)) { n = n.tag; continue; }
      break;
    }
    return ts.isIdentifier(n) ? n.text : null;
  };

  /** The literal text of a title argument, eliding interpolations as `readString` does. */
  const literalText = (a: ts.Expression | undefined): string | null => {
    if (!a) return null;
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text;
    if (ts.isTemplateExpression(a)) {
      return a.head.text + a.templateSpans.map((s) => s.literal.text).join('');
    }
    return null;
  };

  // SCRIPT KIND BY EXTENSION. Parsing a `.ts` file as TSX makes an angle-bracket type
  // assertion (`<Foo>x`) parse as JSX — no file does that today, so the difference is
  // unobservable and that is exactly why it should be right rather than lucky.
  const kindOf = (f: string) => f.endsWith('.tsx') ? ts.ScriptKind.TSX
    : f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;

  const oracleTitles = (file: string, src: string): string[] => {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
    const found: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = rootName(n.expression);
        if (name && ORACLE_CALLERS.has(name)) {
          const t = literalText(n.arguments[0]);
          if (t !== null) found.push(t);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  };


  it('the oracle itself sees the forms the scanner special-cases', () => {
    // Non-vacuity in the direction that matters: an oracle that found nothing would
    // pass the check above forever. These are the four shapes the scanner handles by
    // hand, so if the walker cannot reach them the subset assertion is empty of them.
    const src = [
      "it('plain title', () => {})",
      "it.each([['a', 1]])('each title %s', () => {})",
      "it.runIf(true)('runIf title', () => {})",
      'it.each`\n  a\n  ${1}\n`("tagged each title", () => {})',
    ].join('\n');
    expect(oracleTitles('probe.ts', src)).toEqual([
      'plain title', 'each title %s', 'runIf title', 'tagged each title',
    ]);
  });
});

describe('the `/` decision reads the scanner\'s own state, never the raw text (RA-1253)', () => {
  // LATENT, NOT LIVE, and that is exactly why it needs a fixture. The AST oracle above
  // catches a title the scanner drops in THIS repo's files; measured, no test or e2e
  // file writes either shape below, so reverting this fix leaves the oracle green.
  // The two checks are complements: the oracle finds the classes nobody predicted, a
  // fixture pins a class found by reading the code before it reaches a file.

  it('allows a regex after a keyword the scanner passed a block comment to reach', () => {
    // RA-1250 fixed `return /You're here/` by reading the preceding WORD — from raw
    // text, walking backwards from the `/`. One block comment moves the raw text out
    // from under it: the walk lands on `*/`, the word comes back empty, the regex is
    // read as division, and its apostrophe opens a phantom string that swallows every
    // title after it. `prev` was already maintained correctly across comments; only
    // this branch threw it away.
    const src = "function f(s){ return /* why */ /You're here/.test(s); }\n"
      + "it('[STORE-1] kept', () => {})";
    expect(titlesIn(src)).toContain('[STORE-1] kept');
    // and the plain form, which RA-1250 already covered, still works
    expect(titlesIn("function f(s){ return /You're here/.test(s); }\nit('[STORE-2] kept', () => {})"))
      .toContain('[STORE-2] kept');
  });

  it('treats a property spelled like a keyword as division, not as a regex start', () => {
    // The other half of the same root cause: the backwards word walk never looked at
    // the character BEFORE the word, so `o.new / a / b` read as a regex literal. The
    // file's own argument for reading the word at all (`REGEX_OK_AFTER_WORD`) is that
    // a false start is WORSE than a miss, because it consumes real code as a literal.
    //
    // Asserted through `outsideStrings`, which blanks a regex literal and leaves code
    // alone, because that is the observable this actually changes. A title fixture
    // here would be VACUOUS: probed on this tree, the falsely-consumed span ends at
    // the second `/` on the same line and carries balanced quotes, so no title is
    // lost either way — which is why the issue filed the reachability of this half as
    // unconfirmed, and why it stays a correctness fix rather than a bug fix.
    for (const word of ['new', 'of', 'in', 'do']) {
      const src = `const r = o.${word} / a / b;`;
      expect(outsideStrings(src), `o.${word} is a property access, so / is division`).toBe(src);
    }
    // The keyword itself, unprefixed, IS a regex position — so the check above is not
    // just "never treat a word as a regex start".
    expect(outsideStrings('const r = typeof / a / b;')).not.toBe('const r = typeof / a / b;');
  });

  it('still refuses a regex where a `/` can only be division', () => {
    // Non-vacuity in the other direction: a `regexAllowedAt` that always said yes
    // would pass both tests above. After `)` or an identifier, `/` is division, and
    // treating it as a literal would eat the rest of the line.
    const src = "const r = f(1) / 2;\nit('[STORE-5] kept', () => {})";
    expect(titlesIn(src)).toContain('[STORE-5] kept');
    expect(outsideStrings("const r = total / 2; // [STORE-6]")).toContain('[STORE-6]');
  });
});


describe('the Locked ratchet detects slack, not only a drop (RA-1315), by ID (RA-1830)', () => {
  // The baseline is now a SET of ids, not a count, so these drive `failures` with
  // explicit ids rather than an array of the right length. `ids()` builds the shape
  // `failures` consumes; `base` is a fixed three-id baseline so each arm states
  // exactly which invariants moved.
  const base = new Set(['PAY-1', 'PAY-2', 'STORE-3']);
  const ids = (locked: string[]) => ({ dangling: [], missingFiles: [], locked, baseline: base });

  it('fails when a lock is newly present and unrecorded, and NAMES it', () => {
    // The hole: a floor only detects a lost citation while Locked sits ON it. A PR
    // that adds locks without recording them buys that many free deletions repo-wide
    // — a rename or a title reword, anywhere, and lint stays green.
    const out = failures(ids(['PAY-1', 'PAY-2', 'STORE-3', 'STORE-4', 'CERT-9']));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('2 invariant(s) are newly locked and unrecorded');
    expect(out[0], 'the message must name which').toContain('CERT-9, STORE-4');
    expect(out[0], 'and how to acknowledge').toContain('--write-locked');
  });

  it('still fails when a recorded lock has lost its citation, and NAMES it', () => {
    // Not replaced by the arm above — this is the original regression, and a two-sided
    // check written as `!==` with one message would tell the reader to RECORD a lock
    // when a citation had in fact been lost.
    const out = failures(ids(['PAY-1', 'STORE-3']));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('lost their citation: PAY-2');
    expect(out[0]).toContain('restore the citation');
  });

  it('reports BOTH when one lock is swapped for another — the case a count cannot see', () => {
    // RA-1830's reason for holding ids rather than a number. Cardinality is unchanged
    // here, so the old scalar floor passed; that is how RA-1247/RA-1249/RA-1250/RA-1253 each
    // dropped a title while lint stayed green. The two arms must not net out.
    const out = failures(ids(['PAY-1', 'PAY-2', 'STORE-9']));
    expect(out).toHaveLength(2);
    expect(out.join('\n')).toContain('lost their citation: STORE-3');
    expect(out.join('\n')).toContain('newly locked and unrecorded: STORE-9');
  });

  it('passes only when the set matches exactly', () => {
    expect(failures(ids(['PAY-1', 'PAY-2', 'STORE-3']))).toEqual([]);
  });

});


describe('DECL is derived from STATUSES, so a fifth status cannot be invisible (RA-2122)', () => {
  // DECL is the trust root: `parseSpec`, spec-guard, spec-coverage and the allocator all
  // see an invariant only through it. It used to restate the four statuses as a literal,
  // one line below STATUSES — a status added there and not here would be an invariant
  // that exists for nobody.
  it('matches a declaration for EVERY status STATUSES declares, with id and status in groups 3 and 4', () => {
    expect(STATUSES.length).toBeGreaterThanOrEqual(4);
    for (const status of STATUSES) {
      const m = DECL.exec(`- \`[STORE-7]\` \`[${status}]\` Something.`);
      expect(m?.[3], status).toBe('STORE-7');
      expect(m?.[4], status).toBe(status);
    }
  });

  it('does not match a tag that is not a status', () => {
    expect(DECL.exec('- `[STORE-7]` `[pending]` Something.')).toBeNull();
  });

  it('is built from STATUSES rather than restating it', () => {
    // The two tests above would pass on a correct LITERAL too; this is the one that
    // fails if the literal comes back.
    const src = readFileSync(join(ROOT, 'scripts/spec-lib.mjs'), 'utf8');
    expect(src).toMatch(/export const DECL = new RegExp\([\s\S]*?STATUSES\.join\('\|'\)/);
    expect(src).not.toMatch(/confirmed\|seed\|structural\|retired/);
  });
});

describe('a spliced paragraph — one sentence twice inside one invariant — fails the guard (RA-2070)', () => {
  // PR RA-2055 inserted `[CERT-9]`'s new tail beside the old one: two "Stated limits"
  // counts, a severed sentence, and one sentence verbatim twice. Every guard was green.
  const REPEAT = 'The transport boundary rule itself is unit-locked in `tests/unit/arc-client.test.ts`.';
  const problems = (body: string) => {
    const { dir, registryPath } = fixture(body);
    return check({ dir, registryPath }).problems;
  };

  it('names BOTH lines of a sentence repeated inside one invariant', () => {
    const p = problems(`- \`[STORE-1]\` \`[seed]\` Head.\n  ${REPEAT}\n  Something in between that changed.\n  ${REPEAT}`);
    const hit = p.find((x) => /states the same sentence twice/.test(x));
    expect(hit, p.join('\n')).toBeDefined();
    // The fixture's first bullet is on line 13 of the SPEC() wrapper (11 before RA-2701's
    // `**Id prefix:**` line and its blank); the copies follow.
    expect(hit).toMatch(/storefront\.md:14 and storefront\.md:16/);
    expect(hit).toMatch(/`STORE-1`/);
  });

  it('finds a copy that wraps across lines differently from the first', () => {
    const wrapped = REPEAT.replace(' unit-locked', '\n  unit-locked');
    const p = problems(`- \`[STORE-1]\` \`[seed]\` Head. ${REPEAT}\n  Middle.\n  ${wrapped}`);
    expect(p.some((x) => /states the same sentence twice/.test(x)), p.join('\n')).toBe(true);
  });

  it('accepts the same sentence in two DIFFERENT invariants — formulaic repetition across bullets is legitimate', () => {
    expect(problems(`- \`[STORE-1]\` \`[seed]\` ${REPEAT}\n- \`[STORE-2]\` \`[seed]\` ${REPEAT}`)).toEqual([]);
  });

  it('ignores a short repeated phrase below the word floor', () => {
    // `Left [seed] per oracle integrity.` repeats inside one clause on the real corpus.
    expect(DUP_MIN_WORDS).toBe(8);
    expect(problems('- `[STORE-1]` `[seed]` Head. Left seed per oracle integrity.\n  Left seed per oracle integrity.')).toEqual([]);
  });

  it('stops at a heading, so the next section is not part of the last invariant', () => {
    expect(problems(`- \`[STORE-1]\` \`[seed]\` ${REPEAT}\n\n## Another section\n\n${REPEAT}`)).toEqual([]);
  });

});

describe('spec-ids allocates above every open PR\'s claim (RA-2071)', () => {
  const body = '- `[STORE-1]` `[seed]` Numbered.\n- `[seed]` Not yet numbered.';

  it('mints above the registry when no sibling claims anything', () => {
    const { dir } = fixture(body, { STORE: 99 });
    const r = allocate({ dir, registry: { STORE: 99 } });
    expect(r.assigned.map((a: { id: string }) => a.id)).toEqual(['STORE-100']);
    expect(r.after.STORE).toBe(100);
  });

  it('mints above a sibling PR\'s claim, and records only what it minted', () => {
    const { dir } = fixture(body, { STORE: 99 });
    const r = allocate({ dir, registry: { STORE: 99 }, floor: { STORE: 105 } });
    expect(r.assigned.map((a: { id: string }) => a.id)).toEqual(['STORE-106']);
    // The gap 100..105 is legal: the sibling's numbers arrive with the sibling.
    expect(r.after.STORE).toBe(106);
  });

  it('does not reserve a sibling\'s numbers when it mints nothing', () => {
    const { dir } = fixture('- `[STORE-1]` `[seed]` Numbered.', { STORE: 99 });
    expect(allocate({ dir, registry: { STORE: 99 }, floor: { STORE: 105 } }).after.STORE).toBe(99);
  });

  it('reads claims as ADDED ids minus REMOVED ones, so an edited or moved clause is not a claim', () => {
    const patch = [
      '@@ -10,1 +10,2 @@',
      '-- `[STORE-50]` `[seed]` Old wording.',
      '+- `[STORE-50]` `[confirmed]` New wording.',
      '+- `[STORE-113]` `[seed]` A new clause.',
    ].join('\n');
    const r = claimsIn([
      { filename: 'docs/qa/specs/storefront.md', patch },
      { filename: 'docs/qa/specs/_id-registry.json', patch: '+  "STORE": 113' },
      { filename: 'src/x.ts', patch: '+// - `[STORE-900]` `[seed]` not a spec' },
      { filename: 'docs/qa/specs/kiosk.md' }, // no patch: too large for the API
    ]);
    expect(r.ids).toEqual(['STORE-113']);
    expect(r.unreadable).toEqual(['docs/qa/specs/kiosk.md']);
  });

  it('an id inside a CODE FENCE of the head file is an example, not a claim', () => {
    const content = ['Context.', '```md', '- `[STORE-900]` `[seed]` An example of the declaration shape.', '```', '- `[STORE-113]` `[seed]` A real clause.', ''].join('\n');
    const patch = [
      '@@ -1,1 +1,6 @@',
      ' Context.',
      '+```md',
      '+- `[STORE-900]` `[seed]` An example of the declaration shape.',
      '+```',
      '+- `[STORE-113]` `[seed]` A real clause.',
      '+',
    ].join('\n');
    expect(claimsIn([{ filename: 'docs/qa/specs/storefront.md', patch, content }]).ids).toEqual(['STORE-113']);
  });

  it('a fence opened ABOVE the hunk is seen through the head file, and without it nothing is dropped', () => {
    // The fence opens on line 2 and closes on line 6; the hunk sees only lines 4-8, so
    // on its own it would read the CLOSER as an opener and hide the real clause after it.
    const content = [
      'Intro.',
      '```md',
      'An example block:',
      '- `[STORE-901]` `[seed]` Example.',
      'More example.',
      '```',
      '- `[STORE-114]` `[seed]` A real clause.',
      'Tail.',
    ].join('\n');
    const patch = [
      '@@ -4,3 +4,5 @@',
      '+- `[STORE-901]` `[seed]` Example.',
      ' More example.',
      ' ```',
      '+- `[STORE-114]` `[seed]` A real clause.',
      ' Tail.',
    ].join('\n');
    const file = { filename: 'docs/qa/specs/storefront.md', patch };
    expect(claimsIn([{ ...file, content }]).ids).toEqual(['STORE-114']);
    // No head file (its read failed): the conservative answer over-counts, never drops.
    expect(claimsIn([file]).ids).toEqual(['STORE-114', 'STORE-901']);
  });

  it('computes the floor per prefix across PRs', () => {
    expect(claimedFloor([{ ids: ['STORE-113', 'KIOSK-40'] }, { ids: ['STORE-115'] }])).toEqual({ STORE: 115, KIOSK: 40 });
  });

  it('fails the LATER-opened PR and names the holder; the earlier one is only warned', () => {
    const others = [{ number: 2053, title: 'holder', ids: ['STORE-113'] }, { number: 2056, title: 'late', ids: ['STORE-113'] }];
    expect(collisionsWith({ number: 2056, ids: ['STORE-113'] }, others)).toEqual([
      { id: 'STORE-113', pr: 2053, title: 'holder', yields: true },
    ]);
    expect(collisionsWith({ number: 2053, ids: ['STORE-113'] }, others)).toEqual([
      { id: 'STORE-113', pr: 2056, title: 'late', yields: false },
    ]);
    expect(collisionsWith({ number: 2053, ids: ['STORE-114'] }, others)).toEqual([]);
  });

});

describe('the dry run says when the registry is BEHIND, not only what it would write (RA-1355)', () => {
  it('reports a lagging registry as behind, with both values', () => {
    const out = report({ STORE: 115, KIOSK: 3 }, { after: { STORE: 116, KIOSK: 3 }, behind: { STORE: 116 } }, false);
    expect(out).toMatch(/BEHIND the specs — STORE: 115 on disk, 116 in the specs/);
    expect(out).toMatch(/"STORE":115/);
    expect(out).not.toMatch(/in sync/);
  });

  it('says "in sync" only when nothing differs', () => {
    expect(report({ STORE: 116 }, { after: { STORE: 116 }, behind: {} }, false)).toMatch(/on disk, in sync: \{"STORE":116\}/);
  });

  it('distinguishes a normal advance (ids minted) from a lag', () => {
    const out = report({ STORE: 116 }, { after: { STORE: 117 }, behind: {} }, false);
    expect(out).toMatch(/--apply would advance: STORE: 116 -> 117/);
    expect(out).not.toMatch(/BEHIND/);
  });

  it('allocate() detects the lag from the specs themselves', () => {
    const { dir } = fixture('- `[STORE-100]` `[seed]` Minted by hand, registry not advanced.', { STORE: 99 });
    const r = allocate({ dir, registry: { STORE: 99 } });
    expect(r.behind).toEqual({ STORE: 100 });
    expect(r.assigned).toEqual([]);
  });
});

describe('a clause may declare itself deliberately unlockable (RA-1654)', () => {
  it('matches the author\'s own sentence, and only with "to Locked" after it', () => {
    const got = declaredUnlockable([
      { id: 'FIX-1', raw: 'named for findability and this clause is **deliberately not migrating** from Claimed to Locked on it' },
      { id: 'FIX-2', raw: 'this clause is **deliberately not migrating** to Locked on either' },
      { id: 'FIX-3', raw: 'we are deliberately not migrating the schema yet' },
      { id: 'FIX-4', raw: 'An ordinary clause.' },
    ]);
    expect([...got].sort()).toEqual(['FIX-1', 'FIX-2']);
  });


});
