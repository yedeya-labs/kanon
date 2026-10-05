import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STORE_ENVIRONMENT } from '../../actions/qa-store/qa-store.mjs';
import { WINDOW_DAYS } from '../../scripts/lib/telemetry-artifacts.mjs';
import { storeLaneProblems, telemetryReads, type Job, type Workflow } from './helpers/store-jobs.js';

/**
 * Plan 0004 step 9: the dispatch sweep, moved from the reference adopter as a Kanon lane
 * (`agent-dispatch-sweep.yml`). It reads its cost rows through the store hook in a store job of
 * its own, or from run artifacts without a hook (§3.3, decision 3 as changed on 2026-10-04).
 *
 * The workflow half of the reference adopter's `dispatch-sweep.test.ts` ("the workflow that runs
 * it", "the workflow gives the sweep what it needs to read the store") moved here; the library
 * half is `tests/library/dispatch-sweep.test.ts`. The adopter's AWS step, its `qa` environment
 * and its `QA_DYNAMO_TABLE` plumbing are gone: the store job and `storeLaneProblems` replace them.
 */

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string> };
type LaneJob = Job & { steps?: Step[]; 'timeout-minutes'?: number };
type Lane = Workflow & {
  name: string;
  on: { workflow_call: { inputs: Record<string, { type: string; default?: string }>; secrets: Record<string, { required?: boolean }> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, LaneJob>;
};

const LANE_TEXT = readFileSync('.github/workflows/agent-dispatch-sweep.yml', 'utf8');
const lane = (): Lane => parse(LANE_TEXT) as Lane;
const wf = lane();
const sweep = wf.jobs.sweep!;
const sweepSteps = sweep.steps ?? [];
const run = sweepSteps.find((s) => s.name?.startsWith('Reconcile open'))!;
const caller = parse(readFileSync('tests/fixtures/lane-check/extra/agent-dispatch-sweep.yml', 'utf8')) as {
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs: { apply: { default: boolean } } } };
};
// The sweep script reads the App register when it loads, so its lanes come from the fixture adopter.
const { LANES } = await (async () => {
  const cwd = process.cwd();
  process.chdir('tests/fixtures/adopter');
  try {
    return await import('../../scripts/dispatch-sweep.mjs');
  } finally {
    process.chdir(cwd);
  }
})();
const storeRowsEnv = (agent: string) => `QA_STORE_COST_ROWS_${agent.toUpperCase().replace(/-/g, '_')}`;

describe('the store job and the sweep job (plan 0004 step 9, P9\'s check)', () => {
  it('the lane has the store-coupled shape, with no agent job', () => {
    expect(storeLaneProblems(wf, telemetryReads(), { agentless: true })).toEqual([]);
  });

  it('only the store job runs in kanon-qa-store, and only it holds id-token', () => {
    const withEnv = Object.entries(wf.jobs).filter(([, j]) => j.environment !== undefined).map(([n]) => n);
    expect(withEnv).toEqual(['store']);
    expect(wf.jobs.store!.environment).toBe(STORE_ENVIRONMENT);
    const withToken = Object.entries(wf.jobs).filter(([, j]) => typeof j.permissions === 'object' && 'id-token' in j.permissions).map(([n]) => n);
    expect(withToken).toEqual(['store']);
  });

  it('the job that runs dispatch-sweep.mjs declares its own permissions without id-token, and no environment', () => {
    expect(run.run).toBe('node "$KANON/scripts/dispatch-sweep.mjs"');
    expect(sweep.permissions).toEqual({ contents: 'read' });
    expect(sweep.environment).toBeUndefined();
  });

  describe('mutations: each turns the check red', () => {
    const mutate = (change: (l: Lane) => void, opts = { agentless: true }) => {
      const l = lane();
      change(l);
      return storeLaneProblems(l, telemetryReads(), opts);
    };
    it('id-token on the sweep job', () =>
      expect(mutate((l) => { (l.jobs.sweep!.permissions as Record<string, string>)['id-token'] = 'write'; })).toEqual(['sweep: grants id-token: write; only store jobs do']));
    it('the sweep job in an environment', () =>
      expect(mutate((l) => { l.jobs.sweep!.environment = 'kanon-qa-store'; })).toEqual(["sweep: declares environment 'kanon-qa-store'; only store jobs declare one"]));
    it('the sweep job with no permissions of its own, inheriting the caller\'s id-token', () =>
      expect(mutate((l) => { delete l.jobs.sweep!.permissions; })).toEqual(["sweep: declares no permissions block of its own, so it inherits the caller's grant, id-token included"]));
    it('the store job under the adopter\'s old environment name', () =>
      expect(mutate((l) => { l.jobs.store!.environment = 'qa'; })).toEqual(["store: a store job's environment is 'qa', not 'kanon-qa-store'"]));
    it('a step of the sweep\'s in the store job', () =>
      expect(mutate((l) => { l.jobs.store!.steps!.push({ run: 'node "$KANON/scripts/dispatch-sweep.mjs"' }); }))
        .toEqual(['store: a store job runs step 3 (run: node "$KANON/scripts/dispatch-sweep.mjs"), which is neither the qa-store block nor the download of the report it puts']));
    it('an agent job added to a lane that runs no model', () =>
      expect(mutate((l) => { l.jobs.agent = { permissions: { contents: 'read' }, steps: [{ uses: '$/actions/agent-run' }] } as LaneJob; }))
        .toContain('a lane that runs no model has an agent job (agent)'));
    it('the check run as for a model lane, which the sweep is not', () =>
      expect(mutate(() => {}, { agentless: false })).toEqual(['the lane has no agent job']));
  });
});

describe('the cost rows reach the sweep from the store job', () => {
  const storeSteps = wf.jobs.store!.steps ?? [];

  it('reads cost-rows once per telemetry agent the sweep watches, for its 14-day window', () => {
    const agents = LANES.map((l: { telemetryAgent: string }) => l.telemetryAgent);
    expect(storeSteps.map((s) => s.with?.kind)).toEqual(agents);
    for (const s of storeSteps) {
      expect(s.uses).toBe('$/actions/qa-store');
      expect(s.id).toBe(s.with?.kind);
      expect(s.with).toEqual({ operation: 'cost-rows', kind: s.id, days: String(WINDOW_DAYS) });
    }
    expect(WINDOW_DAYS).toBe(14);
  });

  it('hands each agent\'s rows, the hook\'s presence and the job\'s result to the sweep', () => {
    const outputs = wf.jobs.store!.outputs ?? {};
    expect(outputs.present).toBe('${{ steps.implementer.outputs.present }}');
    for (const l of LANES as Array<{ telemetryAgent: string }>) {
      expect(outputs[l.telemetryAgent]).toBe(`\${{ steps.${l.telemetryAgent}.outputs.rows }}`);
      expect(run.env?.[storeRowsEnv(l.telemetryAgent)]).toBe(`\${{ needs.store.outputs.${l.telemetryAgent} }}`);
    }
    expect(run.env?.QA_STORE_RESULT).toBe('${{ needs.store.result }}');
    expect(run.env?.QA_STORE_PRESENT).toBe('${{ needs.store.outputs.present }}');
    // The adopter's direct read is not this lane's: no table, region or AWS outcome.
    expect(Object.keys(run.env ?? {}).filter((k) => /^QA_(DYNAMO|AWS)/.test(k))).toEqual([]);
  });

  it('sweeps after a store job that FAILED, charging every dispatch, but never past the gate or the soft skip', () => {
    expect(sweep.needs).toEqual(['gate', 'store']);
    expect(sweep.if).toBe("${{ !cancelled() && needs.gate.outputs.member == 'true' && needs.gate.outputs.ready == 'true' }}");
    expect(wf.jobs.store!.needs).toBe('gate');
    expect(wf.jobs.store!.if).toBe("needs.gate.outputs.member == 'true' && needs.gate.outputs.ready == 'true'");
  });

  it('names no cloud anywhere in the lane', () => {
    expect(LANE_TEXT).not.toMatch(/configure-aws-credentials|role-to-assume|QA_DYNAMO_TABLE|vars\.QA_/);
  });
});

describe('the workflow that runs it (moved from the reference adopter)', () => {
  it('mints an App token: the workflow token cannot start the implement lane', () => {
    // Events raised by the workflow token never start another workflow run, so a sweep
    // authenticated with it would re-label and silently start nothing.
    const minter = sweepSteps.find((s) => s.uses?.startsWith('actions/create-github-app-token'));
    expect(minter?.id).toBe('app-token');
    expect(run.env?.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
  });

  it('mints the LEAD\'s App, not the Implementer it watches, narrowed to what the sweep does', () => {
    const minter = sweepSteps.find((s) => s.uses?.startsWith('actions/create-github-app-token'))!;
    expect(minter.with?.['client-id']).toBe('${{ secrets.LEAD_APP_ID }}');
    expect(minter.with?.['private-key']).toBe('${{ secrets.LEAD_APP_PRIVATE_KEY }}');
    expect(Object.keys(wf.on.workflow_call.secrets).sort()).toEqual(['LEAD_APP_ID', 'LEAD_APP_PRIVATE_KEY']);
  });

  it('asserts the minted App slug against the script constant (RA-918)', () => {
    const assertion = sweepSteps.find((s) => s.name?.startsWith('Assert the minted App'))!;
    expect(assertion.env?.MINTED_SLUG).toBe('${{ steps.app-token.outputs.app-slug }}');
    // Read from the script, never repeated as a literal.
    expect(assertion.run).toContain("import(process.env.KANON + '/scripts/dispatch-sweep.mjs')");
    expect(assertion.run).toContain('m.SWEEP_LOGIN');
    expect(assertion.run).toMatch(/App slug mismatch[\s\S]{0,400}?exit 1/);
  });

  it('mints AFTER checkout, so the assertion can read the register the script reads', () => {
    const at = (p: (s: Step) => boolean) => sweepSteps.findIndex(p);
    expect(at((s) => s.uses === 'actions/checkout@v7')).toBeLessThan(at((s) => s.id === 'app-token'));
    expect(at((s) => s.id === 'app-token')).toBeLessThan(at((s) => s.name?.startsWith('Assert') ?? false));
    expect(at((s) => s.name?.startsWith('Assert') ?? false)).toBeLessThan(sweepSteps.indexOf(run));
  });

  it('soft-skips the store and the sweep when the Lead\'s App is not configured', () => {
    // A daily red run for a known-pending one-time setup is alarm fatigue. Secrets cannot be
    // read in a job-level `if`, so the check is a step in the gate job, and both later jobs
    // require its output.
    const app = wf.jobs.gate!.steps!.find((s) => s.id === 'app')!;
    expect(app.if).toBe("steps.gate.outputs.member == 'true'");
    expect(app.env?.APP_ID).toBe('${{ secrets.LEAD_APP_ID }}');
    expect(app.run).toContain('::warning title=agent-dispatch-sweep::');
    expect(app.run).toContain('ready=false');
    expect(wf.jobs.gate!.outputs?.ready).toBe('${{ steps.app.outputs.ready }}');
    for (const job of ['store', 'sweep']) expect(wf.jobs[job]!.if, job).toContain("needs.gate.outputs.ready == 'true'");
    // Not required, so a caller whose secrets don't exist yet reaches the skip instead of
    // failing to start.
    for (const s of Object.values(wf.on.workflow_call.secrets)) expect(s.required).toBe(false);
  });

  it('applies on the schedule and dry-runs a dispatch without apply', () => {
    expect(run.env?.APPLY).toBe("${{ (github.event_name == 'schedule' || inputs.apply == 'true') && '1' || '' }}");
    expect(wf.on.workflow_call.inputs.apply).toMatchObject({ type: 'string', default: '' });
    expect(caller.on.workflow_dispatch.inputs.apply.default).toBe(false);
  });

  it('keeps the daily schedule at 04:40, clear of the other agent crons', () => {
    expect(caller.on.schedule).toEqual([{ cron: '40 4 * * *' }]);
    expect(LANE_TEXT).toContain('schedule: "40 4 * * *"');
  });

  it('serialises runs so two sweeps cannot double-dispatch one issue', () => {
    expect(wf.concurrency.group).toBe('agent-dispatch-sweep');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('admits only its caller\'s two triggers', () => {
    expect(wf.jobs.gate!.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
  });

  it('bounds a hang (RA-1336)', () => {
    for (const [name, job] of Object.entries(wf.jobs)) expect(job['timeout-minutes'], name).toBeGreaterThan(0);
  });
});
