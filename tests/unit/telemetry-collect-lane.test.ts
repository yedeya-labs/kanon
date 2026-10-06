import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COLLECT_JOB, COLLECT_JOB_OVERRIDE } from '../../scripts/telemetry-collect.mjs';

/**
 * Plan 0002 S7: the collector's reusable workflow, and Kanon's own caller of it.
 */

type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
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
    expect(creds.with).toEqual({ 'role-to-assume': '${{ inputs.writer-role }}', 'aws-region': 'eu-central-1', 'role-session-name': 'kanon-telemetry-collect' });
  });

  it('passes the override through with no fallback, so a schedule is never an override', () => {
    const script = collect.steps!.find((s) => s.run)!;
    expect(script.env).toEqual({ GH_TOKEN: '${{ github.token }}', KANON_TELEMETRY_URL: '${{ inputs.url }}', WINDOW: '${{ inputs.window_minutes }}' });
  });

  it('says so, holding nothing, when a value is missing', () => {
    expect(unset.permissions).toEqual({});
    expect(unset.if).toContain("inputs.url == '' || inputs.writer-role == ''");
    expect(unset.steps!.map((s) => s.run ?? '').join('')).toContain('::warning title=telemetry-collect::');
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

  it('is inert: no live schedule until its pin ships the collector (kanon#304), with the hourly one written out', () => {
    // GitHub resolves a called workflow before any `if:`, so a schedule at a pin that lacks the
    // collector fails at startup every hour. kanon#304 removes the comment marks.
    expect(Object.keys(caller.on)).toEqual(['workflow_dispatch']);
    expect(CALLER_TEXT).toMatch(/^ {2}# schedule:\n {2}# {3}- cron: "40 \* \* \* \*"$/m);
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
