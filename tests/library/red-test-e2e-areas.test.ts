import { describe, expect, it } from 'vitest';
import { UNDECLARED } from '../../scripts/lib/code-areas.mjs';
import { exitCodeFor, planOutputs } from '../../scripts/red-test.mjs';
import { STACK, check, BUGGY, FIXED, REAL_TEST, VACUOUS_TEST } from './helpers/red-test.js';

// The red-test check end to end: the PR's stack document can't steer the check (kanon#761). Split
// out of red-test.test.ts (#1204); the fixture is `check` in tests/library/helpers/red-test.ts.

describe('end to end, on a real repository and a real runner: the code areas', { timeout: 120_000 }, () => {
  // ── kanon#761: the PR's stack document can't steer the check ──────────────
  const SRC_AS_TESTS = '# Stack\n\n## Gates\n\n1. run the tests\n\n## Code areas\n\n- `src/` — tests: the application, now "tests"\n- `tests/` `vitest` — tests: the suite\n';
  const NO_RUNNER = '# Stack\n\n## Gates\n\n1. run the tests\n\n## Code areas\n\n- `src/` — code: the application\n- `tests/` — tests: the suite\n';
  const NO_AREAS = '# Stack\n\n## Gates\n\n1. run the tests\n';

  it('a PR that re-declares its source as a tests tree is refused, not skipped: the plan still sends verify, which fails', () => {
    const plan = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': SRC_AS_TESTS }, { args: ['--plan'] });
    expect(plan.status, plan.out).toBe(0);
    expect(plan.outputs.verify).toBe('true');
    expect(plan.outputs.areas_changed).toBe('true');
    expect(plan.out).toContain('**Refused: this pull request changes the code areas the check judges with.**');
    expect(plan.out).not.toContain('Skipped');
    const run = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': SRC_AS_TESTS });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('**Refused');
  });

  it('a PR that drops its tests tree\'s runner is refused, not skipped', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': NO_RUNNER }, { args: ['--plan'] });
    expect(r.outputs.verify).toBe('true');
    expect(r.outputs.areas_changed).toBe('true');
    expect(r.out).toContain('declares the `tests` trees `tests/`, and `trusted` declares `tests/` `vitest`');
  });

  it('a PR that adds its first tests tree is refused, never SKIPPED', () => {
    const r = check({ 'docs/qa/stack.md': NO_AREAS, ...BUGGY }, { ...FIXED, ...REAL_TEST, 'docs/qa/stack.md': STACK }, { args: ['--plan'] });
    expect(r.outputs.verify).toBe('true');
    expect(r.outputs.areas_changed).toBe('true');
    expect(r.out).toContain('and `trusted` declares none');
  });

  it('a PR whose stack document can\'t be parsed is refused by name', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST, 'docs/qa/stack.md': '# Stack\n\n## Code areas\n\n- `src` — code: the application\n' }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.areas_changed).toBe('true');
    expect(r.out).toMatch(/This pull request's docs\/qa\/stack\.md can't be read: docs\/qa\/stack\.md:\d+: a `code` area is a directory/);
  });

  it('a PR that only rewords its areas, keeping the tests trees, is judged as usual', () => {
    const reworded = STACK.replace('the suite', 'every test we have');
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': reworded });
    expect(r.out).not.toContain('Refused');
    expect(r.out).toContain('**UNVERIFIABLE');
  });

  it('a branch behind a default branch whose areas moved is judged by the default branch\'s, not refused and not its own', () => {
    // The merge base declares no areas, so the PR's test has no runner there; the default branch
    // has since declared `tests/` with Vitest. The PR touched neither.
    const r = check({ 'docs/qa/stack.md': NO_AREAS, ...BUGGY }, { ...FIXED, ...REAL_TEST }, { trusted: { 'docs/qa/stack.md': STACK } });
    expect(r.out).not.toContain('Refused');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('**PASS.** 1 file(s) failed an assertion against the reverted source.');
  });

  it('the stack document on disk is never read: a rewrite after checkout (the hook\'s) changes nothing', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { after: { 'docs/qa/stack.md': SRC_AS_TESTS } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**BLOCKED');
  });

  it('the verifying run judges with the areas the plan handed it, whatever the tree on disk says', () => {
    const plan = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { args: ['--plan'] });
    expect(plan.outputs.areas_changed).toBe('false');
    const areas = plan.outputs.areas as string;
    expect(JSON.parse(areas).tests).toEqual([{ path: 'tests/', what: 'the suite', runner: 'vitest' }]);
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { areasArgs: ['--areas-json', areas], after: { 'docs/qa/stack.md': SRC_AS_TESTS } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**BLOCKED');
  });

  it('fails closed with no trusted source of areas: none given, an unreadable ref, or a garbled hand-over', () => {
    for (const areasArgs of [[], ['--areas-ref', 'no-such-branch'], ['--areas-json', ''], ['--areas-json', '{"declared":true}']]) {
      const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { areasArgs, args: ['--plan'] });
      expect(r.status, `${areasArgs.join(' ')}: ${r.out}`).toBe(1);
      expect(r.outputs.verify, areasArgs.join(' ')).toBeUndefined();
      expect(r.out).toMatch(/^red-test: /m);
    }
  });

  it('planOutputs and exitCodeFor: a refusal sends verify, says so, and fails it', () => {
    expect(planOutputs({ areasChanged: true }, UNDECLARED)).toEqual(['verify=true', `areas=${JSON.stringify(UNDECLARED)}`, 'areas_changed=true']);
    expect(planOutputs({ skipped: true }, UNDECLARED)[2]).toBe('areas_changed=false');
    expect(exitCodeFor({ areasChanged: true })).toBe(1);
  });
});
