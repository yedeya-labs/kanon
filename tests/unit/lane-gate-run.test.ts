import { describe, expect, it } from 'vitest';
import { LEAD_LOGIN } from './helpers/register.js';
import { PERMS, runGate, MEMBER, STRANGER, CASES } from './helpers/lane-gate.js';

// kanon#46 half 2: the gate step of each lane, executed, for each trigger of its caller.
//
// One of the lane-gate files split by area (kanon#381): vitest runs one file's cases serially.
// tests/unit/lane-gate.test.ts says what the gate is; the helpers they share are in
// tests/unit/helpers/lane-gate.ts.

describe.each(CASES)('%s on a %s', (file, trigger) => {
  it('refuses a non-member, visibly', () => {
    const r = runGate(file, trigger, STRANGER);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('Membership gate: refused.');
    expect(r.summary).toContain('a-stranger');
    expect(r.output).toContain('::notice title=Membership gate::');
  });
  it('admits a member', () => {
    const r = runGate(file, trigger, MEMBER);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.summary).toContain('a-member');
  });
  it('admits a registered agent App', () => {
    const r = runGate(file, trigger, { login: `${LEAD_LOGIN}[bot]`, association: 'NONE' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.summary).toContain("the repository's Implementer, Lead App");
  });
  it('refuses a bot outside the App register', () => {
    // Even one the permission lookup would pass: a bot is judged by the register alone.
    const r = runGate(file, trigger, { login: 'dependabot[bot]', association: 'COLLABORATOR' }, {
      STUB_PERMS: JSON.stringify({ 'dependabot[bot]': PERMS['a-member'] }),
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('dependabot[bot]');
    expect(r.summary).toContain('not in the App register');
  });
});
