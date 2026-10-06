import { describe, expect, it } from 'vitest';
import { runGate, MEMBER, CASES, caller, STACKED, REPOSITORY } from './helpers/lane-gate.js';

// kanon#69: the gate step of each lane, executed, run from a stacked base: it runs the Kanon
// version the default branch's caller pins, or refuses, visibly.
//
// One of the lane-gate files split by area (kanon#381): vitest runs one file's cases serially.
// tests/unit/lane-gate.test.ts says what the gate is; the helpers they share are in
// tests/unit/helpers/lane-gate.ts.

describe.each(CASES)('%s on a %s, from a stacked base (kanon#69)', (file, trigger) => {
  it('refuses a caller that pins another Kanon version than the default branch, visibly', () => {
    const r = runGate(file, trigger, MEMBER, { ...STACKED, STUB_CALLER_BRANCH: caller('v0.9.0'), STUB_CALLER_MAIN: caller('v0.10.0') }, REPOSITORY);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('Kanon pin: refused.');
    expect(r.summary).toContain('@v0.9.0');
    expect(r.summary).toContain('@v0.10.0');
    expect(r.output).toContain('::notice title=Kanon pin::');
  });
  it('admits a caller that pins what the default branch pins', () => {
    const r = runGate(file, trigger, MEMBER, { ...STACKED, STUB_CALLER_BRANCH: caller('v0.10.0'), STUB_CALLER_MAIN: caller('v0.10.0') }, REPOSITORY);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
  });
});
