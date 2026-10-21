import { describe, expect, it } from 'vitest';
import { check, BUGGY, FIXED, REAL_TEST, VACUOUS_TEST } from './helpers/red-test.js';

// The red-test check end to end: the verdict on each shape of PR. Split out of red-test.test.ts
// (#1204); the fixture is `check` in tests/library/helpers/red-test.ts.

describe('end to end, on a real repository and a real runner: the verdicts', { timeout: 120_000 }, () => {
  it('a real fix whose test fails on the reverted source is green, and the tree is given back', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('| `tests/add.test.ts` | 🔴 failed an assertion: **strong** |');
    expect(r.out).toContain('**PASS.** 1 file(s) failed an assertion against the reverted source.');
    expect(r.dirty, 'the source is back at head').toBe('');
  });

  it('a change whose test still passes on the reverted source is red: BLOCKED', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('| `tests/add.test.ts` | 🟢 still passed |');
    expect(r.out).toContain('**BLOCKED: every changed test passed without the source change, so none of them proves anything.**');
  });

  it('the same vacuous test beside a file the check cannot revert is UNVERIFIABLE, and still red', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/add.md': 'Adding.\n' });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**UNVERIFIABLE: 1 changed file(s) were not reverted, so a block would not be about them.**');
    expect(r.out).toContain('`docs/add.md`');
  });

  it('a new module and its test pass weakly: the test cannot load without the module, and the added file is restored', () => {
    const r = check({ 'src/keep.mjs': 'export {};\n' }, { ...FIXED, ...REAL_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('| `tests/add.test.ts` | 🟠 did not collect: *weak* |');
    expect(r.out).toContain('**PASS, weakly.**');
    expect(r.addedOnDisk, 'the file the PR added is back').toBe(true);
    expect(r.dirty).toBe('');
  });

  it('…and UNVERIFIABLE when an unreverted test helper changed beside it, which could have caused that', () => {
    const r = check({ 'src/keep.mjs': 'export {};\n', 'tests/helpers.ts': 'export const h = 1;\n' }, { ...FIXED, ...REAL_TEST, 'tests/helpers.ts': 'export const h = 2;\n' });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**Not run, and NOT reverted**');
    expect(r.out).toContain('unreverted test harness file(s) could have caused that.**');
  });

  it('refuses, rather than overwrites, uncommitted work in the revert set, and exits 1', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { after: { 'src/add.mjs': 'export const add = (a, b) => b + a;\n' } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**Refused: 1 file(s) in the revert set have uncommitted changes:** `src/add.mjs`');
    expect(r.dirty, 'the work is still there').toContain('src/add.mjs');
  });

  it('a runner that is not installed is INCONCLUSIVE, never a pass or a block', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { runner: false });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('| `tests/add.test.ts` | ⚪ no data: the runner reported nothing for this file |');
    expect(r.out).toContain('**INCONCLUSIVE');
  });
});
