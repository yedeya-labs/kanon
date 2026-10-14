import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The collector's messages send the adopter to a section of a doc by name, as
 * `docs/<file>.md, "<Section>"` (PR #841's review). Each must name a heading that exists, or the
 * message points at nothing.
 */
const SOURCES = ['scripts/lib/telemetry-token.mjs', 'scripts/telemetry-collect.mjs'];
/** `docs/x.md, "Section"`, with the quotes plain or escaped in a JS string, the name possibly on the next comment line. */
const CITATION = /(docs\/[a-z0-9/-]+\.md),\s*(?:\*\s*)?\\?"([^"\\]+)\\?"/g;

const headings = (doc: string) => new Set(readFileSync(doc, 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+ /, '').trim()));

/** Every citation in a source text, as [doc, section]. */
export const citationsOf = (text: string) => [...text.matchAll(CITATION)].map((m) => [m[1]!, m[2]!] as const);

describe("the telemetry scripts' doc citations name sections that exist", () => {
  for (const file of SOURCES) {
    it(`${file}`, () => {
      const cited = citationsOf(readFileSync(file, 'utf8'));
      expect(cited.length).toBeGreaterThan(0);
      for (const [doc, section] of cited) expect(headings(doc), `${file} cites ${doc}, "${section}"`).toContain(section);
    });
  }

  it('reads both forms, and a missing section fails (the check is not vacuous)', () => {
    expect(citationsOf('a (docs/telemetry.md, \\"Quotas\\") b')).toEqual([['docs/telemetry.md', 'Quotas']]);
    expect(citationsOf(' * (docs/telemetry.md,\n * "Publish the hosted URLs").')).toEqual([['docs/telemetry.md', 'Publish the hosted URLs']]);
    expect(headings('docs/telemetry.md')).not.toContain('No such section');
    expect(headings('docs/telemetry.md')).toContain('Quotas');
  });
});
