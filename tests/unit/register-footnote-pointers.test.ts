import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A pointer into the App register's footnotes ("`docs/qa/agent-identities.md` footnote 2", or
// "agent-identities.md ²") names a record a reader goes to find. Kanon's register has the
// footnotes its own broadened permissions need (`K-AGENT-3`), and an adopter's has its own, so
// a number carried over from another register points at nothing (#491, #504). This holds every
// such pointer in the tree to a `[^N]` the register defines; a claim that isn't a footnote of
// Kanon's register cites the record that holds it instead, such as a roles-table row or a rule.

const REGISTER = 'docs/qa/agent-identities.md';
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

// The register's name, then only punctuation, whitespace and comment leaders (`//`, `#`, ` * `)
// before the footnote, so a pointer a comment wraps across lines is still read.
const POINTER = new RegExp(
  `(?:agent-identities\\.md|App register)\`?(?:'s)?[\\s\`'*#/(]*(?:footnote\\s+(\\d+[a-z]?)|([${SUPERSCRIPT}]+))`,
  'g',
);

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
      return danglingPointers(text, footnotes).map((p) => `${f}:${p.line} footnote ${p.footnote}`);
    });
    expect(hits).toEqual([]);
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

  it('reads no unnumbered mention of a footnote as a pointer', () => {
    expect(danglingPointers('`docs/qa/agent-identities.md` holds one table. Every broadened permission carries a numbered footnote below it.', footnotes)).toEqual([]);
  });
});
