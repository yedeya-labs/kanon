import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT, SCRIPT, TRIAGE, IMPL, adopter, check, red, job, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the fixture whole, Kanon's own tree, and what a calling job
 * holds and passes.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  it('passes Kanon itself, its six lane callers on the Author and the Judge (ADR 0011)', () => {
    // In this tree, not a copy: Kanon is its own adopter. CI runs the RELEASED action on it, at
    // the version its callers pin; this run reads the lanes as this PR leaves them, so a lane
    // change that would break Kanon's caller is red here before it is released. Since plan
    // 0005's L5 the callers map the Author's and the Judge's secrets, and the register names
    // one slug per App. The fifth is the Overseer's, since kanon#423, and the sixth the rebase
    // lane's, since kanon#448.
    const r = spawnSync('bash', [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('6 lane caller(s) pass');
    // One lane-check run over Kanon's whole tree: under a loaded full run it outlasted the 5s
    // default once, as the three-run test below did.
  }, 30_000);

  it('passes the fixture adopter whole, and counts its four callers', () => {
    const r = check(adopter());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('4 lane caller(s) pass');
  });

  describe('a caller holds only its triggers, permissions and one job', () => {
    it('refuses a workflow-level env', () => red((t) => t.edit(TRIAGE, (d) => { d.env = { X: '1' }; }), 'it also has: env'));
    it('refuses concurrency on the caller, which the lane holds (decision 11)', () =>
      red((t) => t.edit(TRIAGE, (d) => { d.concurrency = { group: 'x' }; }), 'it also has: concurrency'));
    it('refuses concurrency on the calling job too', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).concurrency = 'x'; }), 'the calling job holds only uses, with, secrets and permissions; it also has: concurrency'));
    it('refuses a second job', () =>
      red((t) => t.edit(TRIAGE, (d) => { (d as Caller).jobs.more = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] }; }), 'exactly one job, not 2'));
    it('refuses a job-level `if`, which is the lane\'s admission rule', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).if = 'true'; }), 'it also has: if'));
  });

  describe('the calling job passes only its own inputs through', () => {
    it('refuses a literal value, which would be a setting (ADR 0002)', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '12' }; }), 'a caller only passes its own input through'));
    it('refuses another input\'s value', () =>
      red((t) => t.edit(IMPL, (d) => { job(d).with = { pr_number: '${{ inputs.reset }}', reset: '${{ inputs.reset }}' }; }), 'passes `pr_number: ${{ inputs.reset }}`'));
    it('refuses the smoke-only `smoke` input, though every lane declares it (kanon#321)', () => {
      const r = red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '${{ inputs.issue_number }}', smoke: '${{ inputs.smoke }}' }; }),
        "passes `smoke`, which only Kanon's lanes smoke sets");
      expect(r.out).toContain('docs/lanes.md');
    });
    it('refuses an input the lane does not declare', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '${{ inputs.issue_number }}', bogus: '${{ inputs.bogus }}' }; }), 'passes `bogus`, which the Kanon lane agent-triage does not declare'));
  });
});

describe('the lane-check action', () => {
  const action = parse(readFileSync(join(ROOT, 'actions/lane-check/action.yml'), 'utf8')) as {
    inputs?: unknown;
    runs: { using: string; steps: { run?: string; env?: Record<string, string> }[] };
  };

  it('takes no inputs: what a lane needs is read from the lane (ADR 0002)', () => {
    expect(action.inputs).toBeUndefined();
  });

  it('runs its script from its own directory, at the version it was called at', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toHaveLength(2);
    expect(action.runs.steps[1]?.run).toBe('bash "$GITHUB_ACTION_PATH/lane-check.sh"');
    expect(action.runs.steps[1]?.env).toEqual({ ACTION_REF: '${{ github.action_ref }}' });
  });

  it("puts Kanon's own Node on the PATH first, for the library's readers (kanon#110, kanon#153)", () => {
    expect((action.runs.steps[0] as { uses?: string }).uses).toBe('$/actions/kanon-path');
  });

  it('the agents smoke runs it on the fixture adopter, through `$/`', () => {
    const smoke = parse(readFileSync(join(ROOT, '.github/workflows/agent-lanes-smoke.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: { uses?: string; run?: string }[] }>;
    };
    const steps = smoke.jobs.smoke?.steps ?? [];
    expect(steps.map((s) => s.uses).filter(Boolean)).toEqual(['actions/checkout@v7', '$/actions/kanon-path', '$/actions/lane-check']);
    expect(steps.some((s) => s.run?.includes('cp -R tests/fixtures/lane-check/adopter/. .'))).toBe(true);
  });
});
