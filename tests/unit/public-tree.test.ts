import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { namesForbiddenWord } from '../../.github/scripts/public-words.mjs';

// Kanon is public, and was extracted from a private reference adopter whose working files
// live in a separate private repository. This test keeps the reference adopter's names
// out of the public tree without spelling them out: a guard that listed them would
// publish them. Every word in every tracked file is hashed and compared against the
// SHA-256 of each forbidden name, in lowercase. The hashes live in
// .github/scripts/public-words.mjs, which the PR-text check (public-text.yml) shares, and
// the list of names is kept in the private extraction repository.

// Patterns that reveal nothing themselves. An account id is twelve digits that aren't part of a
// longer number, a dotted version, a hex string or a UUID: a commit hash in a changelog link
// (`3eb5613ee908262524890f935d…`) can hold a run of twelve digits between hex letters, and a
// UUID's last group is twelve hex characters that are sometimes all digits. Only a dot *before*
// the run is excluded (`1.<id>`): a dot after it is how an ECR hostname carries the id
// (`<id>.dkr.ecr.<region>.amazonaws.com`), the form a repository most often holds one in.
const AWS_ACCOUNT_ID = /(?<![\dA-Fa-f.])(?<![\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-)\d{12}(?![\dA-Fa-f])/;
const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ['an AWS account id', AWS_ACCOUNT_ID],
  ['a local home-directory path', /\/Users\/[a-z]/],
  ["the extraction's working files", /\bPROVENANCE\.md\b|\bextraction\/(?:inventory|provenance)/],
];

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !/^(package-lock\.json|LICENSE)$/.test(f));

describe('the public tree names nothing from the private extraction', () => {
  it("no tracked file contains a forbidden name (compared by hash)", () => {
    const hits = tracked.filter((f) => namesForbiddenWord(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  for (const [what, pattern] of FORBIDDEN_PATTERNS) {
    it(`no tracked file contains ${what}`, () => {
      expect(tracked.filter((f) => pattern.test(readFileSync(f, 'utf8')))).toEqual([]);
    });
  }
});

describe('the account-id pattern', () => {
  // Built, not written out, so this file doesn't trip the guard it tests.
  const id = `${'123456'}${'789012'}`;

  it("doesn't read a commit hash's digits as an account id", () => {
    // The 0.16.0 changelog's link to 3eb5613, whose hash holds twelve digits in a row.
    const link = '([3eb5613](https://github.com/yedeya-labs/kanon/commit/3eb5613ee908262524890f935d95a1d076cd6a26))';
    expect(AWS_ACCOUNT_ID.test(link)).toBe(false);
    // The run at either end of the hex, so each side's check is needed on its own.
    expect(AWS_ACCOUNT_ID.test(`/commit/${id}ab3f`)).toBe(false);
    expect(AWS_ACCOUNT_ID.test(`/commit/ab3f${id})`)).toBe(false);
    expect(AWS_ACCOUNT_ID.test(`/commit/AB3F${id}`)).toBe(false);
    expect(AWS_ACCOUNT_ID.test(`/commit/${id}AB3F`)).toBe(false);
  });

  it("doesn't read a UUID's all-digit last group as an account id", () => {
    expect(AWS_ACCOUNT_ID.test(`"6f1c2a9e-4b7d-4e2a-9c3f-${id}"`)).toBe(false);
    expect(AWS_ACCOUNT_ID.test(`"6F1C2A9E-4B7D-4E2A-9C3F-${id}"`)).toBe(false);
  });

  it('still finds a bare account id, and one in an ARN', () => {
    expect(AWS_ACCOUNT_ID.test(`the account ${id} holds it`)).toBe(true);
    expect(AWS_ACCOUNT_ID.test(`arn:aws:iam::${id}:role/deploy`)).toBe(true);
    expect(AWS_ACCOUNT_ID.test(`"${id}"`)).toBe(true);
  });

  it('finds an account id in an ECR hostname, and one that ends a sentence', () => {
    expect(AWS_ACCOUNT_ID.test(`${id}.dkr.ecr.us-east-1.amazonaws.com/app:latest`)).toBe(true);
    expect(AWS_ACCOUNT_ID.test(`deploys to ${id}.`)).toBe(true);
  });

  it('finds an account id after a hyphenated segment that is not a UUID', () => {
    // The UUID exclusion matches the whole UUID prefix, not any `-hhhh-` before the digits (#146).
    expect(AWS_ACCOUNT_ID.test(`stack-2024-${id}`)).toBe(true);
    expect(AWS_ACCOUNT_ID.test(`-beef-${id}`)).toBe(true);
  });

  it('leaves longer numbers and dotted versions alone', () => {
    expect(AWS_ACCOUNT_ID.test(`${id}3`)).toBe(false);
    expect(AWS_ACCOUNT_ID.test(`1.${id}`)).toBe(false);
  });
});
