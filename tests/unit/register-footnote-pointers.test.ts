import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_GRANTS, registerFootnotes } from '../../scripts/app-register.mjs';
import { ADOPTION_RECORD, readAppExtras } from '../../scripts/lib/app-extras.mjs';

// A pointer into the App register's footnotes ("`docs/qa/agent-identities.md` footnote 2", or
// "agent-identities.md ²") names a record a reader goes to find. Kanon's register has the
// footnotes its own broadened permissions need (`K-AGENT-3`), and an adopter's has its own, so
// a number carried over from another register points at nothing (#491, #504). This holds every
// such pointer in the tree to a `[^N]` the register defines; a claim that isn't a footnote of
// Kanon's register cites the record that holds it instead, such as a roles-table row or a rule.
//
// A bare "footnote N", with no register named, is held too (#1250): it resolves to the register's
// `[^N]`, or to a `[^N]:` the file it sits in defines, which is that file's own footnote. And
// Kanon's register itself passes lane-check's footnote check, here in the unit suite, since
// Kanon's CI runs lane-check at the release its callers pin.

const REGISTER = 'docs/qa/agent-identities.md';
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

// The register's name, then only punctuation, whitespace and comment leaders (`//`, `#`, ` * `)
// before the footnote, so a pointer a comment wraps across lines is still read.
const POINTER = new RegExp(
  `(?:agent-identities\\.md|App register)\`?(?:'s)?[\\s\`'*#/(]*(?:footnote\\s+(\\d+[a-z]?)|([${SUPERSCRIPT}]+))`,
  'g',
);

// The word "footnote" and a number or a superscript, wherever it sits.
const BARE = new RegExp(`\\bfootnotes?\\s+(?:(\\d+[a-z]?)\\b|([${SUPERSCRIPT}]+))`, 'gi');

function footnotesOf(register: string): Set<string> {
  return new Set([...register.matchAll(/^\[\^([^\]]+)\]:/gm)].map((m) => m[1] as string));
}

/** Each pointer in `text` to a footnote `footnotes` doesn't hold, with its line. */
function danglingPointers(text: string, footnotes: Set<string>): Array<{ line: number; footnote: string }> {
  return [...text.matchAll(POINTER)]
    .map((m) => ({
      line: text.slice(0, m.index).split('\n').length,
      footnote: m[1] ?? [...(m[2] ?? '')].map((c) => SUPERSCRIPT.indexOf(c)).join(''),
    }))
    .filter((p) => !footnotes.has(p.footnote));
}

/** Each bare "footnote N" in `text` that neither `footnotes` nor the text's own `[^N]:` holds, with its line. */
function danglingBare(text: string, footnotes: Set<string>): Array<{ line: number; footnote: string }> {
  const own = footnotesOf(text);
  return [...text.matchAll(BARE)]
    .map((m) => ({
      line: text.slice(0, m.index).split('\n').length,
      footnote: m[1] ?? [...(m[2] ?? '')].map((c) => SUPERSCRIPT.indexOf(c)).join(''),
    }))
    .filter((p) => !footnotes.has(p.footnote) && !own.has(p.footnote));
}

/** Both readers' hits, one per footnote a line names. */
function dangling(text: string, footnotes: Set<string>): Array<{ line: number; footnote: string }> {
  const seen = new Set<string>();
  return [...danglingPointers(text, footnotes), ...danglingBare(text, footnotes)].filter((p) => {
    const key = `${p.line}:${p.footnote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The changelog records history, and the fixtures are other trees' text; this file spells out
// the dangling pointers its own cases need.
const scanned = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && f !== 'CHANGELOG.md' && !f.startsWith('tests/fixtures/') && f !== 'tests/unit/register-footnote-pointers.test.ts');

describe("every pointer to an App-register footnote resolves in Kanon's register", () => {
  it('names only footnotes docs/qa/agent-identities.md defines', () => {
    const footnotes = footnotesOf(readFileSync(REGISTER, 'utf8'));
    const hits = scanned.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      // A binary file has no pointers to read.
      if (text.includes('\0')) return [];
      return dangling(text, footnotes).map((p) => `${f}:${p.line} footnote ${p.footnote}`);
    });
    expect(hits).toEqual([]);
  });

  // lane-check's footnote check (`registerFootnotes`, K-AGENT-3, K-LAYOUT-6) on Kanon's own
  // register, here, since Kanon's CI runs lane-check at the release its callers pin.
  it("passes lane-check's footnote check: every marker resolves, every widening has its reason", () => {
    const { extras, errors } = readAppExtras(readFileSync(ADOPTION_RECORD, 'utf8'), Object.keys(APP_GRANTS));
    expect(errors).toEqual([]);
    expect(registerFootnotes(readFileSync(REGISTER, 'utf8'), extras)).toEqual([]);
  });
});

describe('the pointer reader (K-PRIN-11: the guard goes red on a dangling pointer)', () => {
  const register = '| Role | App slug |\n| --- | --- |\n| Implementer | `x` [^1] |\n\n[^1]: **Why.**\n';
  const footnotes = footnotesOf(register);

  it("reads the register's footnotes", () => {
    expect([...footnotes]).toEqual(['1']);
  });

  it('passes a pointer to a footnote the register has', () => {
    expect(danglingPointers('See docs/qa/agent-identities.md footnote 1.', footnotes)).toEqual([]);
  });

  it('flags a numbered pointer to a footnote the register lacks', () => {
    expect(danglingPointers('See docs/qa/agent-identities.md footnote 3.', footnotes)).toEqual([{ line: 1, footnote: '3' }]);
    expect(danglingPointers("// `docs/qa/agent-identities.md`'s footnote 2 gives", footnotes)).toEqual([{ line: 1, footnote: '2' }]);
    expect(danglingPointers('// `docs/qa/agent-identities.md` footnote 7b', footnotes)).toEqual([{ line: 1, footnote: '7b' }]);
  });

  it('flags a superscript pointer', () => {
    expect(danglingPointers('the grant reaches (agent-identities.md ⁷):', footnotes)).toEqual([{ line: 1, footnote: '7' }]);
  });

  it('flags a pointer a comment wraps across lines', () => {
    const text = '/**\n * The App (`agent-identities.md`\n *  footnote 2, whose row this reads).\n */';
    expect(danglingPointers(text, footnotes)).toEqual([{ line: 2, footnote: '2' }]);
    expect(danglingPointers('# read the App register\'s\n# footnote 4 for why', footnotes)).toEqual([{ line: 1, footnote: '4' }]);
  });

  it('flags a bare "footnote N" that no footnote of the register or of its own file defines (#1250)', () => {
    expect(dangling('// see footnote 7 for why the Lead can read Actions', footnotes)).toEqual([{ line: 1, footnote: '7' }]);
    expect(dangling('the grant (footnote ³) holds', footnotes)).toEqual([{ line: 1, footnote: '3' }]);
    expect(dangling('the Implementer\'s footnote 1 says why', footnotes)).toEqual([]);
    expect(dangling('as footnote 2 says.[^2]\n\n[^2]: This file\'s own.\n', footnotes)).toEqual([]);
  });

  it('names a pointer the register reader and the bare reader both read once', () => {
    expect(dangling('See docs/qa/agent-identities.md footnote 3.', footnotes)).toEqual([{ line: 1, footnote: '3' }]);
  });

  it('reads no unnumbered mention of a footnote as a pointer', () => {
    expect(dangling('`docs/qa/agent-identities.md` holds one table. Every broadened permission carries a numbered footnote below it.', footnotes)).toEqual([]);
    expect(dangling('below 2³¹, and a footnote of its own', footnotes)).toEqual([]);
  });
});
