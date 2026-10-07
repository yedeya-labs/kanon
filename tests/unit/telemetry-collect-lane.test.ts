import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COLLECT_JOB, COLLECT_JOB_OVERRIDE } from '../../scripts/telemetry-collect.mjs';
import { interpolate, mask, stepHeader } from './helpers/expression.js';

/**
 * Plan 0002 S7: the collector's reusable workflow, and Kanon's own caller of it.
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
const unset = lane.jobs.unset!;

describe('telemetry-collect.yml, the lane', () => {
  it('is called only, with the URL, the writer role and the override, none with a default but empty', () => {
    expect(Object.keys(lane.on)).toEqual(['workflow_call']);
    const inputs = lane.on.workflow_call.inputs as Record<string, { type: string; default: string; required: boolean }>;
    expect(Object.keys(inputs).sort()).toEqual(['url', 'window_minutes', 'writer-role']);
    for (const i of Object.values(inputs)) expect(i).toMatchObject({ type: 'string', default: '', required: false });
    expect(lane.on.workflow_call.secrets).toBeUndefined();
  });

  it('runs one sweep at a time, and grants nothing at the top', () => {
    expect(lane.concurrency).toEqual({ group: 'kanon-telemetry-collect', 'cancel-in-progress': false });
    expect(lane.permissions).toEqual({});
  });

  it('names the collect job as the watermark looks for it, and an override run otherwise (kanon#315)', () => {
    expect(collect.name).toBe(`\${{ inputs.window_minutes == '' && '${COLLECT_JOB}' || '${COLLECT_JOB_OVERRIDE}' }}`);
  });

  it("collects on the caller's two triggers, on the default branch only, once both values are passed", () => {
    const cond = (collect.if ?? '').replace(/\s+/g, ' ');
    expect(cond).toContain("github.event_name == 'schedule'");
    expect(cond).toContain("github.event_name == 'workflow_dispatch' && github.ref_name == github.event.repository.default_branch");
    expect(cond).toContain("inputs.url != '' && inputs.writer-role != ''");
    expect(cond).not.toContain('pull_request');
  });

  it('holds the writer role with no environment and only the reads the sweep needs', () => {
    expect(collect.environment).toBeUndefined();
    expect(collect.permissions).toEqual({ actions: 'read', 'id-token': 'write' });
    expect(collect['timeout-minutes']).toBe(15);
    const creds = collect.steps!.find((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials@'))!;
    expect(creds.with).toEqual({ 'role-to-assume': '${{ inputs.writer-role }}', 'aws-region': 'eu-central-1', 'role-session-name': 'kanon-telemetry-collect', 'mask-aws-account-id': true });
  });

  it('passes the override through with no fallback, so a schedule is never an override', () => {
    const script = collect.steps!.find((s) => s.run?.includes('telemetry-collect.mjs') && !s.run.includes(' mask'))!;
    expect(script.env).toEqual({ GH_TOKEN: '${{ github.token }}', KANON_TELEMETRY_URL: '${{ inputs.url }}', WINDOW: '${{ inputs.window_minutes }}' });
  });

  it('says so, holding nothing, when a value is missing', () => {
    expect(unset.permissions).toEqual({});
    expect(unset.if).toContain("inputs.url == '' || inputs.writer-role == ''");
    expect(unset.steps!.map((s) => s.run ?? '').join('')).toContain('::warning title=telemetry-collect::');
  });
});

/**
 * kanon#514: the collector's log never shows the writer role's account id after its mask step,
 * not even in an AWS error. The role's ARN is a repository variable (KANON_TELEMETRY_WRITER_ROLE),
 * which the runner never masks, and an AWS error names the account in other ARNs besides. So the
 * job registers the ARN and its account id with `::add-mask::` before any AWS call, as the QA
 * store's jobs do since kanon#511, and asks `configure-aws-credentials` to mask the account it
 * assumed. The mask step is run here for real, and its output fed, with the credentials step's
 * header and AWS-style errors, through a fake of the runner's log masking.
 */
describe("the writer role's account id never reaches the collector's log after the mask (kanon#514)", () => {
  // Built, never written: the public-tree guard refuses a literal twelve-digit account id.
  const ACCOUNT = ['210987', '654321'].join('');
  const ROLE = `arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-writer-kanon`;
  const SESSION = `arn:aws:sts::${ACCOUNT}:assumed-role/kanon-telemetry-writer-kanon/kanon-telemetry-collect`;
  const AWS_ERRORS = [
    `Error: Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity on ${ROLE}`,
    `ingest answered 403: User: ${SESSION} is not authorized to perform: lambda:InvokeFunctionUrl on resource: arn:aws:lambda:eu-central-1:${ACCOUNT}:function:kanon-telemetry-ingest`,
  ];
  const TWELVE = /(?<!\d)\d{12}(?!\d)/;
  const MASK_STEP = "Mask the writer role's account id";
  const ctx = (role: string) => ({ inputs: { 'writer-role': role, url: '', window_minutes: '' } });
  const steps = collect.steps!;
  const credsAt = steps.findIndex((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials@'));
  const maskAt = steps.findIndex((s) => s.name === MASK_STEP);

  /** The runner's log: `::add-mask::` registers a value and prints nothing; every other line is masked. */
  const runnerLog = (lines: string[]) => {
    const masks: Record<string, string> = {};
    const out: string[] = [];
    for (const line of lines) {
      const m = /^::add-mask::(.*)$/.exec(line);
      if (m) masks[`added${Object.keys(masks).length}`] = m[1]!;
      else out.push(mask(line, masks));
    }
    return { log: out.join('\n'), masks };
  };

  /** Run the mask step as the runner does, with Kanon's path (`$KANON`) at this checkout. */
  const runMask = (role: string) => {
    const step = steps[maskAt]!;
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, interpolate(v, ctx(role))]));
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', String(step.run)], { env: { PATH: process.env.PATH, KANON: process.cwd(), ...env }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split('\n').filter(Boolean);
  };

  it('has configure-aws-credentials mask the account it assumed', () => {
    expect(steps[credsAt]!.with?.['mask-aws-account-id']).toBe(true);
  });

  it('masks first: after Kanon\'s path, which runs it, and before the credentials step', () => {
    expect(steps[0]!.uses).toBe('$/actions/kanon-path');
    expect(maskAt).toBe(1);
    expect(credsAt).toBe(2);
    expect(steps[maskAt]!.env).toEqual({ ROLE: '${{ inputs.writer-role }}' });
  });

  it('is not vacuous: unmasked, the credentials header and every AWS error name the account', () => {
    const header = stepHeader(steps[credsAt]!, ctx(ROLE), {}).printed;
    expect(header).toMatch(TWELVE);
    for (const e of AWS_ERRORS) expect(runnerLog([e]).log).toMatch(TWELVE);
  });

  it('registers the ARN and its account id, so no later line of the job names the account', () => {
    const printed = runMask(ROLE);
    expect(printed.filter((l) => l.startsWith('::add-mask::')).sort()).toEqual([`::add-mask::${ACCOUNT}`, `::add-mask::${ROLE}`].sort());
    const { log, masks } = runnerLog(printed);
    const header = stepHeader(steps[credsAt]!, ctx(ROLE), masks).printed;
    expect(header).not.toMatch(TWELVE);
    expect(header).toContain('role-to-assume: ***');
    const errors = runnerLog([...printed, ...AWS_ERRORS]).log;
    expect(`${log}\n${errors}`).not.toMatch(TWELVE);
    // The error itself still reads: only the account id is gone.
    expect(errors).toContain('on resource: arn:aws:lambda:eu-central-1:***:function:kanon-telemetry-ingest');
  });

  it('registers no empty mask, and succeeds, with a role that holds no account id', () => {
    expect(runMask('').filter((l) => l.startsWith('::add-mask::'))).toEqual([]);
    expect(runMask('not-an-arn').filter((l) => l.startsWith('::add-mask::'))).toEqual(['::add-mask::not-an-arn']);
  });
});

describe("telemetry.yml, Kanon's caller (S7, S9)", () => {
  const job = caller.jobs.collect!;
  const pin = (text: string) => /yedeya-labs\/kanon\/[^@\s]+@(v\d+\.\d+\.\d+)/.exec(text)?.[1];

  it("calls the collector at Kanon's last release, the same pin as the review lane's caller (ADR 0011)", () => {
    expect(job.uses).toMatch(/^yedeya-labs\/kanon\/\.github\/workflows\/telemetry-collect\.yml@v\d+\.\d+\.\d+$/);
    expect(pin(job.uses!)).toBe(pin(readFileSync('.github/workflows/review.yml', 'utf8')));
  });

  it('passes the two repository variables, the override, and no secret', () => {
    expect(job.with).toEqual({
      url: '${{ vars.KANON_TELEMETRY_URL }}',
      'writer-role': '${{ vars.KANON_TELEMETRY_WRITER_ROLE }}',
      window_minutes: '${{ inputs.window_minutes }}',
    });
    expect(job.secrets).toBeUndefined();
    expect(caller.permissions).toEqual({ actions: 'read', 'id-token': 'write' });
  });

  it('runs hourly at minute 40 and on dispatch, now that its pin ships the collector (kanon#304)', () => {
    // The collector's contract (plan 0002 §1.2): the two triggers, and nothing else, since a
    // called workflow runs on whatever its caller is called on.
    expect(Object.keys(caller.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(caller.on.schedule).toEqual([{ cron: '40 * * * *' }]);
    expect(caller.on.workflow_dispatch.inputs.window_minutes.default).toBe('');
  });

  it('the runbook names the variables the caller reads', () => {
    const doc = readFileSync('docs/telemetry.md', 'utf8');
    for (const v of ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE']) {
      expect(CALLER_TEXT).toContain(v);
      expect(doc).toContain(v);
    }
  });
});
