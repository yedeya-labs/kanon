import { describe, expect, it, vi } from 'vitest';
import { LEAD_LOGIN, REGISTER_FIXTURE } from './helpers/register.js';
import { PERMS, runGate, MEMBER, STRANGER, LANES, read, gateOf } from './helpers/lane-gate.js';
import { BACKSTOP, describeGateRun, third } from './helpers/lane-gate-run.js';
import { SPAWNS } from './helpers/spawns.js';

// Each case runs a lane's gate step in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// kanon#46 half 2: the gate step of each lane, executed, for each trigger of its caller.
//
// One of the lane-gate files split by area (kanon#381): vitest runs one file's cases serially.
// tests/unit/lane-gate.test.ts says what the gate is; the helpers they share are in
// tests/unit/helpers/lane-gate.ts. The first third of the lanes' triggers runs here, the others in
// lane-gate-run-second-third.test.ts and lane-gate-run-last-third.test.ts, with the four cases each
// in tests/unit/helpers/lane-gate-run.ts (#1204).
describeGateRun(third(1));

// Issue #990: the gate step itself, reading a default branch's register that holds Other App rows.
describe('a lane\'s gate step and an App that isn\'t an agent', () => {
  const file = 'agent-implement.yml';
  const register = `${REGISTER_FIXTURE.trimEnd()}\n| Other App | \`example-reporter\` | Read | Read & write | No access | No access |\n`;
  it('[REG-3] refuses an App whose only row is an Other App row, as it refuses an App the register doesn\'t name', () => {
    const r = runGate(file, 'dispatch', { login: 'example-reporter[bot]', association: 'NONE' }, {
      STUB_REGISTER: register,
      STUB_PERMS: JSON.stringify({ 'example-reporter[bot]': PERMS['a-member'] }),
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('example-reporter[bot]');
    expect(r.summary).toContain('not in the App register');
  });
  it('still admits the agent Apps beside it', () => {
    const r = runGate(file, 'dispatch', { login: `${LEAD_LOGIN}[bot]`, association: 'NONE' }, { STUB_REGISTER: register });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
  });
});

// kanon#768, Owner decision 2026-10-14: the issue backstop buckets an outsider's issue too. It runs
// no model, reads no issue text and writes only a bucket and labels, so its gate admits whoever
// opens an issue, with no permission lookup. No other lane does.
describe('the issue backstop admits whoever opens an issue (K-AGENT-45\'s exception)', () => {
  it.each([
    ['an outsider', STRANGER],
    ['a member', MEMBER],
    ['a bot outside the App register', { login: 'some-bot[bot]', association: 'NONE' }],
  ])('admits %s, without a permission lookup', (_who, actor) => {
    const r = runGate(BACKSTOP, 'issue-opened', actor, { STUB_PERMISSION_FAILS: '1' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.summary).toContain('Owner decision 2026-10-14');
  });

  it('still judges a dispatch as a member\'s', () => {
    expect(runGate(BACKSTOP, 'dispatch', STRANGER).outputs.member).toBe('false');
  });

  it('is the only lane whose gate declares the exception', () => {
    const declaring = LANES.filter((file) => {
      const wf = read(file);
      const g = gateOf(wf)!;
      return (wf.jobs[g.jobId]!.steps![g.index]!.env ?? {}).LANE_GATE_ISSUE_OPENED !== undefined;
    });
    expect(declaring).toEqual([BACKSTOP]);
  });

  it.each(LANES.filter((f) => f !== BACKSTOP))('%s refuses an outsider\'s opened issue', (file) => {
    const r = runGate(file, 'issue-opened', STRANGER);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
  });
});
