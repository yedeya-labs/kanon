import { describe, expect, it, vi } from 'vitest';

/**
 * #105 — `renumberFindings` builds the id pattern once per run, not once per line.
 *
 * Each `idPattern()` call stats every spec to validate its cache, so calling it per line
 * made one CLI run over a real corpus take 8–23 s and time out under parallel test load.
 * Pinned as a COUNT, so a regression fails here rather than as a flaky timeout elsewhere.
 * Its own file because `vi.mock` replaces the module for the whole file.
 */
vi.mock('../../scripts/spec-lib.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/spec-lib.mjs')>();
  return { ...actual, idPattern: vi.fn(actual.idPattern) };
});

const { idPattern } = await import('../../scripts/spec-lib.mjs');
const { renumberFindings } = await import('../../scripts/spec-id-renumbered.mjs');

const TRAIL = { 'STORE-102': { to: 'STORE-103', by: 2003 } };
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} cites [STORE-102]`).join('\n');

describe('renumberFindings cost', () => {
  it('calls idPattern() once for a whole run, however many files and lines it scans', () => {
    vi.mocked(idPattern).mockClear();
    const r = renumberFindings(TRAIL, [
      { path: 'docs/a.md', text: lines(50) },
      { path: 'docs/b.md', text: lines(30) },
    ]);
    // The scan still finds every reference: the shared pattern is not exhausted by `lastIndex`.
    expect(r.references).toBe(80);
    expect(vi.mocked(idPattern)).toHaveBeenCalledTimes(1);
  });
});
