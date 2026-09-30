import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TYPES } from '../../actions/pr-title/pr-title.mjs';

type Section = { type: string; section: string; hidden?: boolean };
type Config = { packages: Record<string, { 'changelog-sections': Section[]; 'initial-version'?: string }> };

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const config = read('release-please-config.json') as Config;
const root = config.packages['.'];

describe("K-SHIP-4 the check's types agree with the release tool's", () => {
  it('release-please has exactly one package, at the root', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
  });

  it("the changelog sections name exactly the action's types, once each", () => {
    const types = root?.['changelog-sections'].map((s) => s.type) ?? [];
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual(Object.keys(TYPES).sort());
  });

  it('no section is hidden, so every type produces a release (K-SHIP-7)', () => {
    expect(root?.['changelog-sections'].filter((s) => s.hidden)).toEqual([]);
  });
});

describe('K-SHIP-7 the first release is 0.1.0', () => {
  // The manifest holds the last released version, so it changes with every release: pin
  // the invariants that hold across releases, not a value that the first release changes.
  it('the first release is 0.1.0, and the manifest agrees with package.json', () => {
    expect(root?.['initial-version']).toBe('0.1.0');
    const manifest = read('.release-please-manifest.json') as Record<string, string>;
    expect(Object.keys(manifest)).toEqual(['.']);
    expect(manifest['.']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest['.']).toBe((read('package.json') as { version: string }).version);
  });
});
