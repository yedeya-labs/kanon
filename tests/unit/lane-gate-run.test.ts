import { describe, expect, it, vi } from 'vitest';
import { LEAD_LOGIN, REGISTER_FIXTURE } from './helpers/register.js';
import { PERMS, runGate, MEMBER, STRANGER, CASES, LANES, read, gateOf } from './helpers/lane-gate.js';
import { SPAWNS } from './helpers/spawns.js';

// Each case runs a lane's gate step in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// kanon#46 half 2: the gate step of each lane, executed, for each trigger of its caller.
//
// One of the lane-gate files split by area (kanon#381): vitest runs one file's cases serially.
// tests/unit/lane-gate.test.ts says what the gate is; the helpers they share are in
// tests/unit/helpers/lane-gate.ts.

// The issue backstop's opened issue is the one trigger that admits anyone (below), so it is held
// to its own cases rather than these.
const BACKSTOP = 'agent-issue-backstop.yml';
describe.each(CASES.filter(([file, trigger]) => !(file === BACKSTOP && trigger === 'issue-opened')))('%s on a %s', (file, trigger) => {
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

// A schedule on a merge-queue repository runs as the queue, named without its `[bot]` suffix
// (run 37638246558 failed red on it). Every scheduled lane admits it, without a permission lookup.
describe.each(CASES.filter(([, trigger]) => trigger === 'schedule'))('%s on a schedule run as the merge queue', (file) => {
  it('admits it', () => {
    const r = runGate(file, 'schedule', { login: 'github-merge-queue' }, { STUB_PERMISSION_FAILS: '1' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.summary).toContain('github-merge-queue[bot]');
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
