import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fencedLines, parseAll } from '../../scripts/spec-lib.mjs';
import { check } from '../../scripts/spec-guard.mjs';
import { allocate } from '../../scripts/spec-ids.mjs';

/**
 * RA-926 — `spec-lib`'s parser is the trust root of the id scheme: `spec-guard` can only
 * check the invariants it SEES. It had been verified against spurious reads (the legend
 * trap) but not against MISSED ones, and it had no idea what a code fence was.
 *
 *   1. `1. \`[seed]\` …`, `+ \`[seed]\` …`, `> \`[seed]\` …` parsed as nothing: no id
 *      demanded, no coverage row, `check()` at 0 problems. The same outcome as the
 *      invariant not existing.
 *   2. A declaration shown as an EXAMPLE inside a fence parsed as a real one, and the
 *      remedy the guard printed would have burnt a permanent id into a code sample.
 */

const SPEC = (body: string) => `# L2 Spec — Fixture

**Id prefix:** \`STORE\`

Promotion tags as in storefront.md.

- \`[structural]\` — derived from a reviewed contract.
- \`[confirmed]\` — a human confirmed this.
- \`[seed]\` — a hypothesis, not yet confirmed.

## Behavioral invariants

- \`[STORE-1]\` \`[seed]\` **A real one, so the population is never empty.**

${body}
`;

function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-926-'));
  writeFileSync(join(dir, 'storefront.md'), SPEC(body));
  const registryPath = join(dir, '_id-registry.json');
  writeFileSync(registryPath, JSON.stringify({ STORE: 99 }));
  return { dir, registryPath };
}

describe('a declaration the parser cannot read fails the guard (RA-926.1)', () => {
  it.each([
    ['an ordered-list item', '1. `[seed]` **An ordered-list invariant.**'],
    ['a `)`-numbered item', '2) `[seed]` **Another ordered-list invariant.**'],
    ['a `+` bullet', '+ `[seed]` **A plus-bullet invariant.**'],
    ['a blockquote', '> `[seed]` **A blockquoted invariant.**'],
    ['an emphasis-wrapped tag', '**`[seed]`** **An emphasised invariant.**'],
    ['one already carrying an id', '1. `[STORE-2]` `[seed]` **Numbered, with an id.**'],
  ])('%s', (_label, line) => {
    const { dir, registryPath } = fixture(line);
    // The issue's measurement: the parser still does not read it…
    expect(parseAll(dir).length, 'not parsed — the guard has to be what notices').toBe(1);
    // …and the guard now refuses it rather than staying at 0 problems.
    const problems = check({ dir, registryPath }).problems;
    expect(problems.join('\n')).toMatch(/shaped like an invariant declaration, but the parser does not read it/);
    expect(problems.join('\n')).toMatch(/storefront\.md:15/);
  });

  it.each([
    ['prose about a tag', 'Promotion tags as in storefront.md: `[structural]`, `[confirmed]`, `[seed]`.'],
    ['a blockquoted promotion note', '> **Promotion pass — 2026-08-24.** Moved to `[confirmed]` after review.'],
    ['a legend-shaped bullet in a section (DECL reads it; rule 1 judges it)', '- `[STORE-3]` `[seed]` fine.'],
  ])('does not fire on %s', (_label, line) => {
    const { dir, registryPath } = fixture(line);
    expect(check({ dir, registryPath }).problems).toEqual([]);
  });
});

describe('a tag inside a code fence is an example, not an invariant (RA-926.2)', () => {
  const EXAMPLE = '- `[confirmed]` **This is only an EXAMPLE in a code fence.**';

  it.each([
    ['backtick fence', '```markdown', '```'],
    ['tilde fence', '~~~', '~~~'],
    ['longer closing fence', '```', '`````'],
  ])('is not parsed, not flagged, and not numbered — %s', (_label, open, close) => {
    const { dir, registryPath } = fixture(`${open}\n${EXAMPLE}\n${close}`);
    expect(parseAll(dir).length).toBe(1);
    expect(check({ dir, registryPath }).problems).toEqual([]);
    // The remedy the old guard printed was `spec-ids.mjs --apply`; it must mint nothing here.
    expect(allocate({ dir, registry: { STORE: 99 } }).assigned).toEqual([]);
  });

  it('a fence closes, so a real declaration after it is still read', () => {
    const { dir } = fixture(`\`\`\`\n${EXAMPLE}\n\`\`\`\n\n- \`[STORE-4]\` \`[seed]\` **After the fence.**`);
    expect(parseAll(dir).map((i: { id: string }) => i.id)).toEqual(['STORE-1', 'STORE-4']);
  });

  it('an unclosed fence fails the guard rather than hiding the rest of the file', () => {
    const { dir, registryPath } = fixture(`\`\`\`\n${EXAMPLE}\n\n- \`[STORE-5]\` \`[seed]\` **Hidden below it.**`);
    expect(check({ dir, registryPath }).problems.join('\n')).toMatch(/storefront\.md:15 — a code fence opens here and never closes/);
  });

  it('an inline triple-backtick span is not a fence', () => {
    const lines = ['```x``` inline', '- `[STORE-6]` `[seed]` still read.'];
    expect(fencedLines(lines).size).toBe(0);
    expect(fencedLines(lines).unclosed).toBe(-1);
  });

  it('a shorter or different run does not close a fence', () => {
    const lines = ['````', 'a', '```', '~~~~', 'b', '````', 'c'];
    expect([...fencedLines(lines)]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

