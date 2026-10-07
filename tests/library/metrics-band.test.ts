import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BAND_THRESHOLDS, BAND_VERSION, LOCKFILES, bandOf, diffSize, isExcludedFromSize } from '../../scripts/metrics/band.mjs';
import { areaOf } from '../../scripts/metrics/areas.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * Plan 0003 §3.6, band version 1: S up to 200 changed lines, M up to 500, L up to 1,200, XL
 * above; one band up at 20 files or 8 directories; capped at XL; risk never a bump. The
 * thresholds are calibrated on the reference adopter's quartiles (§1.2: p25 227, p50 449, p75
 * 810, p90 1,381), and the dry run (M2 part C) checks the counts on its history.
 */

const band = (changed_lines: number, changed_files = 1, changed_dirs = 1) => bandOf({ changed_lines, changed_files, changed_dirs });

describe('bandOf, version 1', () => {
  it('is version 1, with the plan\'s thresholds', () => {
    expect(BAND_VERSION).toBe(1);
    expect(BAND_THRESHOLDS[1]).toEqual({ lines: [200, 500, 1200], files: 20, dirs: 8 });
  });

  it('bands by lines at each threshold and one past it', () => {
    expect([0, 200, 201, 500, 501, 1200, 1201, 100000].map((n) => band(n))).toEqual(['S', 'S', 'M', 'M', 'L', 'L', 'XL', 'XL']);
  });

  it("puts the reference adopter's quartiles where §3.6 says they sit", () => {
    // p25 227 and p50 449 sit just inside M; p75 810 in L; p90 1,381 in XL.
    expect([227, 449, 810, 1381].map((n) => band(n))).toEqual(['M', 'M', 'L', 'XL']);
  });

  it('bumps one band at 20 files, and not at 19', () => {
    expect(band(100, 19)).toBe('S');
    expect(band(100, 20)).toBe('M');
    expect(band(600, 20)).toBe('XL');
  });

  it('bumps one band at 8 directories, and not at 7', () => {
    expect(band(300, 1, 7)).toBe('M');
    expect(band(300, 1, 8)).toBe('L');
  });

  it('bumps once when both spread thresholds are reached', () => {
    expect(band(100, 20, 8)).toBe('M');
  });

  it('caps at XL', () => {
    expect(band(5000, 50, 50)).toBe('XL');
    expect(band(1201, 20)).toBe('XL');
  });

  it('never reads risk: an escalation path changes no band', () => {
    expect(bandOf({ changed_lines: 100, changed_files: 1, changed_dirs: 1, esc_pipeline: true, esc_auth: true } as never)).toBe('S');
  });

  it('is unknown when the lines are, never S', () => {
    expect(bandOf({})).toBeUndefined();
    expect(bandOf({ changed_lines: -1 })).toBeUndefined();
    expect(bandOf({ changed_lines: 1.5 })).toBeUndefined();
  });

  it('treats an unknown spread count as no bump', () => {
    expect(bandOf({ changed_lines: 100 })).toBe('S');
  });

  it('refuses a version it does not know, rather than banding by another', () => {
    expect(() => bandOf({ changed_lines: 1 }, 2)).toThrow(/band version 2/);
  });
});

describe('band.mjs, the module', () => {
  // §3.6: "`band.mjs` imports nothing, so the ingest side may copy it". An import of
  // `areas.mjs` would bring the code-areas and escalation readers, and `node:fs`, with it.
  it('imports nothing, so the ingest side may copy it', () => {
    // Comments out first: a JSDoc type, `import('./types.mjs')`, loads nothing at run time.
    const src = readFileSync(join(ROOT, 'scripts/metrics/band.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bfrom\s*['"]/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

describe('diffSize', () => {
  const f = (path: string, additions: number, deletions = 0) => ({ path, status: 'modified' as const, additions, deletions });

  it('counts additions and deletions, files and directories, the root as one directory', () => {
    expect(diffSize([f('README.md', 3, 2), f('src/a.ts', 10, 5), f('src/b.ts', 1), f('src/x/c.ts', 4)])).toEqual({
      changed_lines: 25, changed_files: 4, changed_dirs: 3, excluded_lines: 0,
    });
  });

  it('leaves lockfiles, snapshots and the changelog out of the size, and reports their lines', () => {
    const files = [f('package-lock.json', 4000, 3000), f('web/yarn.lock', 10), f('tests/__snapshots__/a.test.ts.snap', 50), f('CHANGELOG.md', 7), f('docs/CHANGELOG.md', 1), f('Cargo.lock', 9), f('src/a.ts', 12)];
    expect(diffSize(files)).toEqual({ changed_lines: 12, changed_files: 1, changed_dirs: 1, excluded_lines: 7077 });
  });

  it("leaves every stack's lockfile out, not only JavaScript's, Rust's and Go's (#520)", () => {
    for (const p of ['gradle.lockfile', 'src/Api/packages.lock.json', 'paket.lock', 'mix.lock', 'rebar.lock', 'Package.resolved', 'ios/Podfile.lock', 'Cartfile.resolved', 'pubspec.lock', 'deno.lock']) {
      expect(isExcludedFromSize(p), p).toBe(true);
    }
    for (const p of ['pom.xml', 'build.gradle.kts', 'Api.csproj', 'mix.exs', 'pubspec.yaml']) expect(isExcludedFromSize(p), p).toBe(false);
  });

  it("leaves out exactly the `deps` area's lockfiles, one list for both (#520)", () => {
    for (const name of LOCKFILES) {
      expect(isExcludedFromSize(`svc/${name}`), name).toBe(true);
      expect(areaOf(`svc/${name}`), name).toBe('deps');
    }
  });

  it('keeps a dependency manifest in the size: only generated files are left out', () => {
    expect(isExcludedFromSize('package.json')).toBe(false);
    expect(isExcludedFromSize('changelog.md')).toBe(false);
    expect(isExcludedFromSize('src/CHANGELOG.md.ts')).toBe(false);
  });

  it('bands a dependency bump by its manifest, not its lockfile', () => {
    expect(bandOf(diffSize([f('package.json', 1, 1), f('package-lock.json', 3000, 2500)]))).toBe('S');
  });
});
