import { describe, expect, it } from 'vitest';
import { LEAD_LOGIN } from './register.js';
import { CASES, LANES, MEMBER, PERMS, runGate, STRANGER } from './lane-gate.js';

/**
 * kanon#46 half 2, the gate step of each lane, executed, for each trigger of its caller: the four
 * cases tests/unit/lane-gate-run*.test.ts run for each. A file runs its cases one after another,
 * so the lanes are split in two halves, one file each, to run in parallel (#1204). Every lane is
 * in exactly one half, and a lane added later lands in one of them by its name.
 */

/** The issue backstop's opened issue is the one trigger that admits anyone, so it is held to its own cases. */
export const BACKSTOP = 'agent-issue-backstop.yml';

/** The first or the second half of the lanes, by name. */
export const laneHalf = (half: 1 | 2): string[] => {
  const cut = Math.ceil(LANES.length / 2);
  return half === 1 ? LANES.slice(0, cut) : LANES.slice(cut);
};

/** The four cases, for each trigger of each of `lanes`. */
export const describeGateRun = (lanes: string[]) =>
  describe.each(CASES.filter(([file, trigger]) => lanes.includes(file) && !(file === BACKSTOP && trigger === 'issue-opened')))('%s on a %s', (file, trigger) => {
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
