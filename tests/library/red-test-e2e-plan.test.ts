import { describe, expect, it } from 'vitest';
import { verifyRun, SCOPE_FAILED_STEP, check, BUGGY, FIXED, REAL_TEST } from './helpers/red-test.js';

// The red-test check end to end: the scope job's plan, and a malformed declaration. Split out of
// red-test.test.ts (#1204); the fixture is `check` in tests/library/helpers/red-test.ts.

describe('end to end, on a real repository and a real runner: the plan', { timeout: 120_000 }, () => {
  it('--plan: tests only → verify=false, so the verification job does not run, and no behaviour change is named', () => {
    const r = check({}, REAL_TEST, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped: no behaviour change to revert.** No non-test file changed, so');
  });

  it('--plan: tests beside a non-doc file it cannot revert, and no source → verify=false, saying only that nothing was reverted', () => {
    const r = check({ 'config/flags.json': '{"a":1}\n' }, { 'config/flags.json': '{"a":2}\n', ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped:** no source file changed');
    expect(r.out).not.toContain('no behaviour change');
  });

  it('--plan: tests AND source → verify=true, with the scope heading, not a verdict', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('true');
    expect(r.out.split('\n')[0]).toBe('## Red-test scope');
    expect(r.out).not.toContain('PASS');
  });

  it('--plan with no tests tree declared names the default and skips: no runner is assumed', () => {
    const r = check({ 'docs/qa/stack.md': '# Stack\n\n## Gates\n\n1. test\n', ...BUGGY }, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain("declares no `## Code areas`, so Kanon's default applies");
    expect(r.out).toContain('**Not run**: no `tests` tree in docs/qa/stack.md names a runner for these');
  });

  it('a malformed declaration fails by name, before anything is read', () => {
    const r = check({ 'docs/qa/stack.md': '# Stack\n\n## Code areas\n\n- `src` — code: the application\n', ...BUGGY }, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/^red-test: docs\/qa\/stack\.md:\d+: a `code` area is a directory/m);
  });

  // kanon#1186: the PR can't cause it, since the declaration is the default branch's, but a ruleset
  // reads a skipped required check as passing, so every PR would pass until someone fixed it.
  it('a malformed declaration on the default branch fails the required check, never skips it', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { args: ['--plan'], trusted: { 'docs/qa/stack.md': '# Stack\n\n## Code areas\n\n- `src` — code: the application\n' } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/^red-test: docs\/qa\/stack\.md:\d+: a `code` area is a directory/m);
    const run = verifyRun({ result: 'failure', outputs: r.outputs });
    expect(run.runs, '`Red-test verification` skipped, which a ruleset counts as passing').toBe(true);
    expect(run.runs && run.failedAt).toBe(SCOPE_FAILED_STEP);
  });
});
