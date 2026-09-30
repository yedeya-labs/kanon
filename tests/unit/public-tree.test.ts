import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Kanon is public, and was extracted from a private reference adopter whose working files
// live in a separate private repository. This test keeps the reference adopter's names
// out of the public tree without spelling them out: a guard that listed them would
// publish them. Every word in every tracked file is hashed and compared against the
// SHA-256 of each forbidden name, in lowercase. The list of names is kept in the private
// extraction repository.
const FORBIDDEN_WORD_HASHES = new Set([
  'eb6d4cb1d4d4fd087a92bd52a7c778fbcc46dc621ba6344f6fd93e047acdcc33',
  '158385f3d76e7655f02bd15674a48626946ece7464201dbc4400e73209880c7e',
  '898bf036643470de81f5b53327142a6aa333296219b9af8c09b652bc12011c88',
]);

// Patterns that reveal nothing themselves.
const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ['an AWS account id', /(?<![\d.])\d{12}(?![\d.])/],
  ['a local home-directory path', /\/Users\/[a-z]/],
  ["the extraction's working files", /\bPROVENANCE\.md\b|\bextraction\/(?:inventory|provenance)/],
];

const sha256 = (word: string): string => createHash('sha256').update(word).digest('hex');

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !/^(package-lock\.json|LICENSE)$/.test(f));

describe('the public tree names nothing from the private extraction', () => {
  it("no tracked file contains a forbidden name (compared by hash)", () => {
    const hits = tracked.filter((f) =>
      (readFileSync(f, 'utf8').toLowerCase().match(/[a-z0-9]+/g) ?? []).some((w) => FORBIDDEN_WORD_HASHES.has(sha256(w))),
    );
    expect(hits).toEqual([]);
  });

  for (const [what, pattern] of FORBIDDEN_PATTERNS) {
    it(`no tracked file contains ${what}`, () => {
      expect(tracked.filter((f) => pattern.test(readFileSync(f, 'utf8')))).toEqual([]);
    });
  }
});
