import { describe, expect, it } from 'vitest';
import { LEAD_LOGIN } from './register.js';
import { CASES, MEMBER, PERMS, runGate, STRANGER } from './lane-gate.js';

/**
 * kanon#46 half 2, the gate step of each lane, executed, for each trigger of its caller: the four
 * cases tests/unit/lane-gate-run*.test.ts run for each. A file runs its cases one after another,
 * and in two halves each half still took 40% of a full run beside a second one, so the lanes and
 * triggers are split in thirds, one file each, to run in parallel (#1204). Every lane and trigger
 * is in exactly one third, and one added later lands in one of them.
 */

/** The issue backstop's opened issue is the one trigger that admits anyone, so it is held to its own cases. */
export const BACKSTOP = 'agent-issue-backstop.yml';

const RUN_CASES = CASES.filter(([file, trigger]) => !(file === BACKSTOP && trigger === 'issue-opened'));

/** The first, second or last third of the lanes' triggers, in the order of the lanes' names. */
export const third = (part: 1 | 2 | 3) => {
  const size = Math.ceil(RUN_CASES.length / 3);
  return RUN_CASES.slice((part - 1) * size, part * size);
};

/** The four cases, for each lane and trigger of `cases`. */
export const describeGateRun = (cases: typeof RUN_CASES) =>
  describe.each(cases)('%s on a %s', (file, trigger) => {
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
