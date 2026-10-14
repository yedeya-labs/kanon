import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COLLECT_JOB, COLLECT_JOB_OVERRIDE, ERASE_JOB } from '../../scripts/telemetry-collect.mjs';
import { evaluate } from './helpers/expression.js';
import { COLLECTOR_CHECK_ENV, isCollectorJob } from './helpers/store-jobs.js';

/**
 * Plan 0002 S7: the collector's reusable workflow, and Kanon's own caller of it; on GitHub's OIDC
 * token since plan 0008 J5.
 */

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { name?: string; if?: string; uses?: string; with?: Record<string, string>; secrets?: unknown; permissions?: unknown; environment?: unknown; steps?: Step[]; 'timeout-minutes'?: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed YAML, read by known paths
type Workflow = { on: Record<string, any>; permissions?: unknown; concurrency?: { group: string; 'cancel-in-progress': boolean }; jobs: Record<string, Job> };

const LANE_TEXT = readFileSync('.github/workflows/telemetry-collect.yml', 'utf8');
const CALLER_TEXT = readFileSync('.github/workflows/telemetry.yml', 'utf8');
const lane = parse(LANE_TEXT) as Workflow;
const caller = parse(CALLER_TEXT) as Workflow;
const collect = lane.jobs.collect!;

/** Whether a job's `if:` lets it start, for an event on a ref of a repository whose default branch is `main`. */
const starts = (cond: string, event: string, ref: string) =>
  Boolean(evaluate(cond, { github: { event_name: event, ref_name: ref, event: { repository: { default_branch: 'main' } } }, inputs: {} }));

describe('telemetry-collect.yml, the lane', () => {
  it('is called only: a self-hosted store\'s url and audience, the deprecated writer role, the override, and the two dispatch inputs', () => {
    expect(Object.keys(lane.on)).toEqual(['workflow_call']);
    const inputs = lane.on.workflow_call.inputs as Record<string, { type: string; default: string; required: boolean; description?: string }>;
    expect(Object.keys(inputs).sort()).toEqual(['audience', 'erase', 'register', 'url', 'window_minutes', 'writer-role']);
    for (const k of ['audience', 'url', 'window_minutes', 'writer-role']) expect(inputs[k]).toMatchObject({ type: 'string', default: '', required: false });
    for (const k of ['erase', 'register']) expect(inputs[k]).toMatchObject({ type: 'string', default: 'no', required: false });
    expect(inputs['writer-role']!.description ?? '').toMatch(/refused before any token is minted/i);
    expect(lane.on.workflow_call.secrets).toBeUndefined();
  });

  it('runs one sweep at a time, and grants nothing at the top', () => {
    expect(lane.concurrency).toEqual({ group: 'kanon-telemetry-collect', 'cancel-in-progress': false });
    expect(lane.permissions).toEqual({});
  });

  it('is its one job: no `unset` job, since an unconfigured store is the script\'s to say', () => {
    expect(Object.keys(lane.jobs)).toEqual(['collect']);
  });

  it('names the collect job as the watermark looks for it, an override run otherwise (kanon#315), and an erasure as neither', () => {
    expect(collect.name).toBe(`\${{ inputs.erase == 'yes' && '${ERASE_JOB}' || inputs.window_minutes == '' && '${COLLECT_JOB}' || '${COLLECT_JOB_OVERRIDE}' }}`);
    const name = (inputs: Record<string, string>) => evaluate(String(collect.name).slice(3, -2), { inputs });
    expect(name({ erase: '', window_minutes: '' })).toBe(COLLECT_JOB);
    expect(name({ erase: 'no', window_minutes: '30' })).toBe(COLLECT_JOB_OVERRIDE);
    expect(name({ erase: 'yes', window_minutes: '' })).toBe(ERASE_JOB);
  });

  it('holds GitHub\'s OIDC token with no environment, no AWS credentials and only the reads the sweep needs', () => {
    expect(collect.environment).toBeUndefined();
    // `contents: read` reads the record's upstream-findings level from the default branch (plan 0006 F4);
    // `issues: read` and `pull-requests: read` read what the work-item rows are derived from (plan 0003 M4).
    expect(collect.permissions).toEqual({ actions: 'read', contents: 'read', 'id-token': 'write', issues: 'read', 'pull-requests': 'read' });
    expect(collect['timeout-minutes']).toBe(15);
    expect(LANE_TEXT).not.toMatch(/configure-aws-credentials|role-to-assume/);
  });

  it('checks the inputs in a step of their own before the sweep, and passes the writer role only as whether it is set', () => {
    const [path, check, run] = collect.steps!;
    expect(path!.uses).toBe('$/actions/kanon-path');
    expect(check!.run?.trim()).toBe('node "$KANON/scripts/telemetry-collect.mjs" check');
    expect(check!.env).toEqual(COLLECTOR_CHECK_ENV);
    expect(run!.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      KANON_TELEMETRY_URL: '${{ inputs.url }}',
      KANON_TELEMETRY_AUDIENCE: '${{ inputs.audience }}',
      LEGACY: "${{ inputs.writer-role != '' }}",
      WINDOW: '${{ inputs.window_minutes }}',
      ERASE: '${{ inputs.erase }}',
      REGISTER: '${{ inputs.register }}',
    });
    // Never the role's value: it named an account.
    expect(JSON.stringify(collect.steps)).not.toContain('${{ inputs.writer-role }}');
  });

  it('is the shape the id-token guard admits, and a fourth step is not (plan 0008 J5)', () => {
    expect(isCollectorJob('telemetry-collect.yml', 'collect', collect as never)).toBe(true);
    // MUTATION: a fourth step in the collect job turns the guard red.
    const four = { ...collect, steps: [...collect.steps!, { name: 'Anything', run: 'echo hi' }] };
    expect(isCollectorJob('telemetry-collect.yml', 'collect', four as never)).toBe(false);
  });
});

/**
 * Plan 0008 §2.3: the store admits a `workflow_dispatch` token as the default branch's because
 * this job's `if:` can't start on any other ref, and GitHub evaluates `if:` before the job runs,
 * so before a token can be minted. That makes the `if:` a security check.
 */
describe("the collect job's if: holds a dispatch to the default branch (plan 0008 §2.3)", () => {
  const cond = String(collect.if);

  it('starts on a schedule, and on a dispatch of the default branch', () => {
    expect(starts(cond, 'schedule', 'main')).toBe(true);
    expect(starts(cond, 'workflow_dispatch', 'main')).toBe(true);
  });

  it('never starts on a dispatch of another branch, nor on any other event', () => {
    expect(starts(cond, 'workflow_dispatch', 'feature')).toBe(false);
    for (const e of ['push', 'pull_request', 'pull_request_target', 'merge_group', 'workflow_run', 'dynamic']) expect(starts(cond, e, 'main')).toBe(false);
  });

  it('turns red when the default-branch clause is dropped (the mutation J5 names)', () => {
    // MUTATION, on a copy: the clause dropped, a dispatch of any branch would start the job.
    const mutated = cond.replace(/ && github\.ref_name == github\.event\.repository\.default_branch/, '');
    expect(mutated).not.toBe(cond);
    expect(starts(mutated, 'workflow_dispatch', 'feature')).toBe(true);
  });
});

describe("telemetry.yml, Kanon's caller (S7, S9)", () => {
  const job = caller.jobs.collect!;
  const pin = (text: string) => /yedeya-labs\/kanon\/[^@\s]+@(v\d+\.\d+\.\d+)/.exec(text)?.[1];

  it("calls the collector at Kanon's last release, the same pin as the review lane's caller (ADR 0011)", () => {
    expect(job.uses).toMatch(/^yedeya-labs\/kanon\/\.github\/workflows\/telemetry-collect\.yml@v\d+\.\d+\.\d+$/);
    expect(pin(job.uses!)).toBe(pin(readFileSync('.github/workflows/review.yml', 'utf8')));
  });

  it('passes what its pinned release takes, and no secret; it drops the two variables when its pin moves to the token path (plan 0008 §9 step 4)', () => {
    // The pin is a release before the token path, whose collector still takes the two variables.
    // J7 moves the pin and the caller together.
    expect(job.with).toEqual({
      url: '${{ vars.KANON_TELEMETRY_URL }}',
      'writer-role': '${{ vars.KANON_TELEMETRY_WRITER_ROLE }}',
      window_minutes: '${{ inputs.window_minutes }}',
    });
    expect(job.secrets).toBeUndefined();
    expect(caller.permissions).toEqual({ actions: 'read', contents: 'read', 'id-token': 'write', issues: 'read', 'pull-requests': 'read' });
  });

  it('runs hourly at minute 40 and on dispatch, now that its pin ships the collector (kanon#304)', () => {
    // The collector's contract (plan 0002 §1.2): the two triggers, and nothing else, since a
    // called workflow runs on whatever its caller is called on.
    expect(Object.keys(caller.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(caller.on.schedule).toEqual([{ cron: '40 * * * *' }]);
    expect(caller.on.workflow_dispatch.inputs.window_minutes.default).toBe('');
  });

  it('the runbook names the variables the caller reads until its pin moves', () => {
    const doc = readFileSync('docs/telemetry.md', 'utf8');
    for (const v of ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE']) {
      expect(CALLER_TEXT).toContain(v);
      expect(doc).toContain(v);
    }
  });
});
