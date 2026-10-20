import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * kanon#1136 — the "shared" lists in the release-note helpers' headers name only what both
 * callers use (`K-AGENT-20`). They said `classify` was shared, but only announce-deploy.mjs
 * calls it; the weekly digest groups by area through its own `INTERNAL_AREAS`.
 */

const read = (path: string) => readFileSync(path, 'utf8');

/** The names a script imports from `./lib/release-notes.mjs`; throws when it imports none. */
const importsOf = (path: string): Set<string> => {
  const m = read(path).match(/import\s*\{([^}]*)\}\s*from\s*'\.\/lib\/release-notes\.mjs'/);
  if (!m) throw new Error(`${path} no longer imports ./lib/release-notes.mjs`);
  return new Set(m[1]!.split(',').map((s) => s.trim()).filter(Boolean));
};

/** The backticked names in the first match of `anchor`'s group 1; throws when it moved. */
const namesAt = (text: string, anchor: RegExp): string[] => {
  const m = text.match(anchor);
  if (!m) throw new Error(`anchor ${anchor} moved`);
  return [...m[1]!.matchAll(/`(\w+)`/g)].map((x) => x[1]!);
};

const announce = importsOf('scripts/announce-deploy.mjs');
const digest = importsOf('scripts/weekly-digest.mjs');

describe('the release-note helpers say truly what both callers share (kanon#1136)', () => {
  it("the library's Shared list is exactly what the weekly digest imports", () => {
    const shared = namesAt(read('scripts/lib/release-notes.mjs'), /Shared:([\s\S]*?)\.\s/);
    expect(shared).not.toContain('classify');
    expect(new Set(shared)).toEqual(digest);
  });

  it("each function the test's header says both callers parse with, both import", () => {
    const named = namesAt(read('tests/library/release-notes.test.ts'),
      /Both callers parse with the same functions \(([^)]*)\)/);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(announce, `announce-deploy.mjs imports ${name}`).toContain(name);
      expect(digest, `weekly-digest.mjs imports ${name}`).toContain(name);
    }
  });
});
