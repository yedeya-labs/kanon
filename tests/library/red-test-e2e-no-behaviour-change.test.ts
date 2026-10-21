import { describe, expect, it } from 'vitest';
import { planOutput } from '../../scripts/red-test.mjs';
import { check, BUGGY, FIXED, REAL_TEST, VACUOUS_TEST } from './helpers/red-test.js';

// The red-test check end to end: comment-only source, and a person's `test:characterization`
// label. Split out of red-test.test.ts (#1204); the fixture is `check` in
// tests/library/helpers/red-test.ts.

describe('end to end, on a real repository and a real runner: no behaviour change to revert', { timeout: 120_000 }, () => {
  // The shape of the case that showed the gap: a characterization test, comment-only edits to the
  // source it guards, and a spec whose line references those comments moved.
  const GUARDED = { 'src/add.mjs': '// Adds.\nexport const add = (a, b) => a + b;\n', 'docs/spec.md': 'See src/add.mjs:2.\n' };
  const RECOMMENTED = { 'src/add.mjs': '// Adds two numbers.\n// The second line moved the code down.\nexport const add = (a, b) => a + b;\n', 'docs/spec.md': 'See src/add.mjs:3.\n' };

  it('comment-only source beside a doc: "no behaviour change to revert", never UNVERIFIABLE, and not red', () => {
    const r = check(GUARDED, { ...RECOMMENTED, ...REAL_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('**Skipped: no behaviour change to revert.**');
    expect(r.out).toContain('`src/add.mjs`');
    expect(r.out).not.toContain('UNVERIFIABLE');
    expect(r.dirty, 'nothing was reverted').toBe('');
  });

  it('--plan: comment-only source → verify=false, so the check concludes SKIPPED, never red', () => {
    const r = check(GUARDED, { ...RECOMMENTED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('no behaviour change to revert');
  });

  it('--plan: tests and docs, no non-test source at all → verify=false, with the same message', () => {
    const r = check({ 'docs/spec.md': 'One.\n' }, { 'docs/spec.md': 'Two.\n', ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped: no behaviour change to revert.**');
  });

  it('a behaviour change beside the same comment edits and doc is still verified, and still red', () => {
    const changed = { ...RECOMMENTED, 'src/add.mjs': '// Adds two numbers.\n// The second line moved the code down.\nexport const add = (a, b) => b + a;\n' };
    const r = check(GUARDED, { ...changed, ...VACUOUS_TEST });
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toContain('no behaviour change');
    expect(r.out).toContain('**UNVERIFIABLE: 1 changed file(s) were not reverted');
  });

  it('comment-only source beside a non-doc file it cannot revert stays on the verifying path', () => {
    const r = check({ ...GUARDED, 'config/flags.json': '{"a":1}\n' }, { ...RECOMMENTED, 'config/flags.json': '{"a":2}\n', ...REAL_TEST });
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toContain('no behaviour change');
    expect(r.out).toContain('`config/flags.json`');
  });

  const labelled = (sender: { login: string, type: string }) => ({
    action: 'labeled', label: { name: 'test:characterization' }, sender,
    pull_request: { labels: [{ name: 'agent:implement' }, { name: 'test:characterization' }] },
  });

  it('--plan: a person\'s `test:characterization` turns a behaviour-changing diff\'s check SKIPPED', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { args: ['--plan'], event: labelled({ login: 'yedeya', type: 'User' }) });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped: a person applied `test:characterization`** (@yedeya)');
  });

  it('--plan: the same label applied by an App is ignored, and says so: the check still verifies', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { args: ['--plan'], event: labelled({ login: 'kanon-author[bot]', type: 'Bot' }) });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('true');
    expect(r.out).toContain('applied by an App (@kanon-author[bot]), and an App cannot waive this check (K-MERGE-13): ignored.');
  });

  it('the label is read in the scope job only: the verifying run, where the PR\'s hook has run, ignores it', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { event: labelled({ login: 'yedeya', type: 'User' }) });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**BLOCKED');
  });

  it('only a skip declines in the plan: a refusing result still sends the real job to report it', () => {
    expect(planOutput({ skipped: true })).toBe('verify=false');
    expect(planOutput({ plan: true })).toBe('verify=true');
    expect(planOutput({ blocked: true })).toBe('verify=true');
    expect(planOutput(undefined)).toBe('verify=true');
  });
});
