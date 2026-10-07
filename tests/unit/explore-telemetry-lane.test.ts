import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AGGREGATE_FILE, AGGREGATE_JOB, agentJobProblems, idTokenProblems, isAggregateJob, telemetryReads, type Job, type Workflow } from './helpers/store-jobs.js';
import { handedIn, mintFor, readFlattened, workflowText } from './helpers/called-workflow.js';
import { LANES, LANE_ROLES } from '../../actions/agent-telemetry/schema.mjs';
import { TRIGGERS } from '../../cli/callers.mjs';

/**
 * Plan 0004 step 14 (decision 13), plan 0002 §6.1: the Explorer's telemetry mode, a lane of its
 * own (`agent-explore-telemetry.yml`). One job, `aggregate`, holds `id-token: write`: it assumes
 * the repository's aggregate invoker role, calls the aggregate-only function with a signed `GET`,
 * and hands the checked answer on as an artifact. The agent's job holds no cloud credentials and
 * a token that reads only. A `file` job with no agent checks the agent's findings against the
 * aggregate and files them (`scripts/telemetry-file.mjs`, held by
 * `tests/library/telemetry-file.test.ts`).
 */

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: boolean };
type LaneJob = Job & { steps?: Step[]; 'timeout-minutes'?: number };
type Lane = Workflow & { on: { workflow_call: { inputs?: Record<string, unknown>; secrets: Record<string, unknown> } }; jobs: Record<string, LaneJob> };

const WF = '.github/workflows';
const LANE_FILE = `${WF}/agent-explore-telemetry.yml`;
const raw = (): Lane => parse(readFileSync(LANE_FILE, 'utf8')) as Lane;
const wf = raw();
const flat = readFlattened(LANE_FILE) as Lane;
const explore = flat.jobs.explore!;
const steps = (explore.steps ?? []) as Step[];
const byId = (id: string) => steps.find((s) => s.id === id)!;
const prompt = String(byId('agent').with?.prompt).replace(/\s+/g, ' ');
const all = (): Record<string, Workflow> => Object.fromEntries(readdirSync(WF).filter((f) => /\.ya?ml$/.test(f))
  .map((f) => [f, parse(readFileSync(join(WF, f), 'utf8')) as Workflow]));

describe('where the mode lives: a lane of its own, any repository can install', () => {
  it('is a lane in the telemetry schema, the caller catalogue and the Explorer\'s role', () => {
    expect(LANES).toContain('explore-telemetry');
    expect(LANE_ROLES['explore-telemetry']).toBe('explorer');
    expect(TRIGGERS['agent-explore-telemetry']).toEqual({ name: 'Explore the telemetry (Explorer)', job: 'explore', schedule: '30 6 * * 2', dispatch: {} });
    expect(readFileSync(LANE_FILE, 'utf8')).toMatch(/^# KANON ROLE: Explorer$/m);
    expect(byId('finish').with).toMatchObject({ lane: 'explore-telemetry', agent: 'telemetry-explorer' });
  });

  it('names no repository, no account and no key: the URL is a variable, the role a secret its caller maps', () => {
    const text = workflowText(LANE_FILE);
    expect(text).not.toMatch(/arn:aws|\d{12}|lambda-url\.[a-z0-9-]+\.on\.aws\//);
    expect(text).not.toMatch(/yedeya-labs\/kanon[^/]|github\.repository == /);
    const vars = [...new Set([...text.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
    expect(vars).toEqual(['KANON_AGGREGATE_URL']);
    expect(wf.on.workflow_call.secrets).toEqual({
      AUTHOR_APP_ID: { required: true }, AUTHOR_APP_PRIVATE_KEY: { required: true }, CLAUDE_CODE_OAUTH_TOKEN: { required: true },
      KANON_AGGREGATE_ROLE: { required: false },
    });
  });
});

describe('the aggregate job: the only one with id-token (K-OBS-17\'s shape)', () => {
  it('holds id-token, and no other job of the lane does', () => {
    const withToken = Object.entries(wf.jobs).filter(([, j]) => typeof j.permissions === 'object' && 'id-token' in j.permissions).map(([n]) => n);
    expect(withToken).toEqual([AGGREGATE_JOB]);
    expect(Object.values(wf.jobs).filter((j) => j.environment !== undefined)).toEqual([]);
    expect(isAggregateJob('agent-explore-telemetry.yml', AGGREGATE_JOB, wf.jobs.aggregate!)).toBe(true);
    expect(AGGREGATE_FILE).toBe('agent-explore-telemetry.yml');
  });

  it('masks the URL and the account id first, reads the role from its secret, and never passes toJSON(vars) (kanon#433, kanon#471)', () => {
    const s = wf.jobs.aggregate!.steps as Step[];
    expect(s.map((x) => x.uses ?? x.name)).toEqual(['$/actions/kanon-path', 'Mask the aggregate function\'s URL and the account id',
      'aws-actions/configure-aws-credentials@v6', 'Read the aggregate', 'actions/upload-artifact@v7']);
    expect(s[1]!.env).toEqual({ URL: '${{ vars.KANON_AGGREGATE_URL }}', ROLE: '${{ secrets.KANON_AGGREGATE_ROLE }}' });
    expect(s[2]!.with).toEqual({ 'role-to-assume': '${{ secrets.KANON_AGGREGATE_ROLE }}', 'aws-region': 'eu-central-1', 'role-session-name': 'kanon-explore-telemetry' });
    expect(s[3]!.env).toEqual({ KANON_AGGREGATE_URL: '${{ vars.KANON_AGGREGATE_URL }}', OUT: '${{ runner.temp }}/aggregate' });
    expect(workflowText(LANE_FILE)).not.toMatch(/\$\{\{\s*toJSON\(vars\)/);
    expect(s[4]!.with).toMatchObject({ path: '${{ runner.temp }}/aggregate/aggregate.json', 'retention-days': 1, 'if-no-files-found': 'error' });
  });

  it('runs only for a member, with the URL and the role set, on the default branch\'s ref, which the role trusts', () => {
    const cond = String(wf.jobs.aggregate!.if).replace(/\s+/g, ' ');
    expect(cond).toBe("needs.gate.outputs.member == 'true' && needs.gate.outputs.configured == 'true' && (github.event_name == 'schedule' || github.ref_name == github.event.repository.default_branch)");
    // A job's if: can't read a secret, so the gate job's step says whether both are set.
    const gate = wf.jobs.gate!.steps as Step[];
    const configured = gate.find((x) => x.id === 'configured')!;
    expect(configured.if).toBe("steps.gate.outputs.member == 'true'");
    expect(configured.env).toEqual({ URL: '${{ vars.KANON_AGGREGATE_URL }}', ROLE: '${{ secrets.KANON_AGGREGATE_ROLE }}' });
    expect(configured.run).not.toMatch(/echo "\$(URL|ROLE)"|printf[^\n]*\$(URL|ROLE)/);
    // And when it doesn't run, a job says why, green.
    expect(String(wf.jobs.unconfigured!.if).replace(/\s+/g, ' ')).toContain("needs.gate.outputs.configured != 'true'");
    expect(wf.jobs.unconfigured!.permissions).toEqual({});
  });

  describe('mutations: each turns the id-token guard red, by name', () => {
    const red = (change: (j: LaneJob) => void) => {
      const w = all();
      change(w[AGGREGATE_FILE]!.jobs[AGGREGATE_JOB] as LaneJob);
      return idTokenProblems(w);
    };
    // The job itself, and the smoke caller that grants id-token to a lane left with no job that
    // may hold it.
    const named = [
      `${AGGREGATE_FILE}: job ${AGGREGATE_JOB} holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job or the aggregate read job, may`,
      `agent-lanes-smoke.yml: job explore-telemetry holds id-token: write (its own permissions grant) and calls ${AGGREGATE_FILE}, which has no store job to pass it to`,
    ];
    it('the guard is green as shipped', () => expect(idTokenProblems(all())).toEqual([]));
    it('a step added', () => expect(red((j) => { j.steps!.push({ run: 'echo hi' }); })).toEqual(named));
    it('the read step handed NODE_OPTIONS', () => expect(red((j) => { j.steps![3]!.env = { ...j.steps![3]!.env, NODE_OPTIONS: '-r x' }; })).toEqual(named));
    it('the masking step handed every variable', () => expect(red((j) => { j.steps![1]!.env = { VARS: '${{ toJSON(vars) }}' }; })).toEqual(named));
    it('another script in the read step', () => expect(red((j) => { j.steps![3]!.run = 'node "$KANON/scripts/telemetry-collect.mjs"'; })).toEqual(named));
    it('the role from anywhere but the lane\'s secret', () => expect(red((j) => { (j.steps![2]!.with as Record<string, unknown>)['role-to-assume'] = '${{ vars.KANON_AGGREGATE_ROLE }}'; })).toEqual(named));
    it('a wider grant', () => expect(red((j) => { j.permissions = { 'id-token': 'write', contents: 'read' }; })).toEqual(named));
    it('the upload from the workspace', () => expect(red((j) => { (j.steps![4]!.with as Record<string, unknown>).path = 'qa-telemetry'; })).toEqual(named));
    it('a job env', () => expect(red((j) => { (j as Record<string, unknown>).env = { NODE_OPTIONS: '-r x' }; })).toEqual(named));
    it('the same job in another workflow is not allowed by this shape', () => {
      const w = all();
      w['agent-code-audit.yml']!.jobs[AGGREGATE_JOB] = structuredClone(w[AGGREGATE_FILE]!.jobs[AGGREGATE_JOB]!);
      expect(idTokenProblems(w)).toEqual([`agent-code-audit.yml: job ${AGGREGATE_JOB} holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job or the aggregate read job, may`]);
    });
  });
});

describe('the agent\'s job: no cloud credentials, a token that reads, and something to read', () => {
  it('declares its own permissions without id-token, and reads what the telemetry step reads (P9\'s check)', () => {
    expect(wf.jobs.explore!.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'read' });
    expect(agentJobProblems('explore', explore, telemetryReads())).toEqual([]);
  });

  it('mints a token that reads the tree and issues, and nothing that writes', () => {
    const mint = mintFor(LANE_FILE, 'explore');
    const perms = Object.fromEntries(Object.entries(mint.with as Record<string, string>).filter(([k]) => k.startsWith('permission-')));
    expect(perms).toEqual({ 'permission-contents': 'read', 'permission-issues': 'read' });
    expect(byId('agent').with?.['github-token']).toBe('${{ steps.app-token.outputs.token }}');
  });

  it('runs only when the aggregate holds something, and only on the attempt that read it', () => {
    expect(wf.jobs.explore!.if).toBe("needs.aggregate.outputs.empty == 'false' && needs.aggregate.outputs.attempt == github.run_attempt");
    expect(handedIn(LANE_FILE, 'explore', 'artifact-name')).toBe('kanon-telemetry-aggregate-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(byId('agent') ? steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!.with : null).toEqual({ name: '${{ inputs.artifact-name }}', path: 'qa-telemetry' });
  });

  it('is told the report\'s shape the filing step reads, and the rules it holds each finding to', () => {
    for (const key of ['qa-telemetry-findings.json', '"examined"', '"held_back"', '"findings"', '"signals"', '"cells"', '"severity"', '"source": "own"', '"source": "cross_adopter"']) expect(prompt).toContain(key);
    expect(prompt).toContain('NO DIGIT IN THE TITLE OR THE BODY');
    expect(prompt).toContain('You file nothing and comment on nothing');
    expect(prompt).toContain('No findings is a good run');
    expect(prompt).toContain('qa-telemetry/aggregate.json');
    expect(prompt).not.toMatch(/aws |dynamodb|curl /i);
  });

  it('uploads its report whatever happened, after the telemetry row', () => {
    const report = byId('report');
    expect(report.if).toBe('always()');
    expect(report.with).toMatchObject({ name: 'qa-telemetry-findings-${{ github.run_id }}-${{ github.run_attempt }}', path: 'qa-telemetry-findings.json', 'retention-days': 1 });
    expect(steps.findIndex((s) => s.id === 'finish')).toBeLessThan(steps.findIndex((s) => s.id === 'report'));
  });
});

describe('the file job: no agent, and the only token that writes', () => {
  const file = wf.jobs.file!;
  const fsteps = (file.steps ?? []) as Step[];
  it('checks out nothing, runs no agent, and mints issues: write alone, only when the repository files its findings itself', () => {
    expect(fsteps.some((s) => /agent-(run|setup|finish)|claude-code-action|actions\/checkout@/.test(s.uses ?? ''))).toBe(false);
    expect(file.permissions).toEqual({});
    const mint = fsteps.filter((s) => s.uses?.startsWith('actions/create-github-app-token@'));
    expect(mint.map((s) => s.id)).toEqual(['file-token']);
    expect(mint[0]!.if).toBe("needs.gate.outputs.upstream == 'filed here'");
    expect(Object.entries(mint[0]!.with ?? {}).filter(([k]) => k.startsWith('permission-'))).toEqual([['permission-issues', 'write']]);
  });

  it('judges the findings against the aggregate the read job uploaded, downloaded outside a workspace', () => {
    const downloads = fsteps.filter((s) => s.uses?.startsWith('actions/download-artifact@')).map((s) => s.with);
    expect(downloads).toEqual([
      { name: 'kanon-telemetry-aggregate-${{ github.run_id }}-${{ github.run_attempt }}', path: '${{ runner.temp }}/aggregate' },
      { name: 'qa-telemetry-findings-${{ github.run_id }}-${{ github.run_attempt }}', path: '${{ runner.temp }}/report' },
    ]);
    const last = fsteps.at(-1)!;
    expect(last.run).toBe('node "$KANON/scripts/telemetry-file.mjs"');
    expect(last.env).toMatchObject({ UPSTREAM: '${{ needs.gate.outputs.upstream }}', GH_TOKEN: '${{ steps.file-token.outputs.token }}', AGGREGATE_PATH: '${{ runner.temp }}/aggregate/aggregate.json', REPORT_PATH: '${{ runner.temp }}/report/qa-telemetry-findings.json' });
  });

  it('starts on the agent job\'s success, whatever the agent concluded, and refuses an earlier attempt\'s report first', () => {
    expect(file.if).toBe("${{ !cancelled() && needs.explore.result == 'success' }}");
    expect(fsteps[0]!.name).toBe('Refuse a report from an earlier attempt');
    expect(byId('agent')['continue-on-error']).toBe(true);
  });
});

describe('where findings go: the adoption record\'s Upstream findings choice (kanon#471, as the Overseer\'s, kanon#426)', () => {
  const gate = wf.jobs.gate!;
  const gsteps = gate.steps as Step[];
  const read = gsteps.find((s) => s.id === 'upstream')!;
  it('is read in the gate job, from the default branch, before any agent runs, and handed to the file job alone', () => {
    expect(read.run).toContain('upstream="$(node "$KANON/scripts/upstream-findings.mjs")"');
    expect(read.if).toBe("steps.configured.outputs.configured == 'true'");
    expect((gate as { outputs?: Record<string, string> }).outputs?.upstream).toBe('${{ steps.upstream.outputs.upstream }}');
    expect([wf.jobs.file!.needs].flat()).toContain('gate');
    // No other job, and nothing the agent's job runs, names the choice.
    for (const [name, j] of Object.entries(wf.jobs)) {
      if (name === 'gate' || name === 'file') continue;
      expect(JSON.stringify(j), name).not.toMatch(/outputs\.upstream|UPSTREAM|upstream-findings/);
    }
    for (const f of ['explore-telemetry-run.yml', 'explore-telemetry-agent-job.yml']) {
      expect(readFileSync(`${WF}/${f}`, 'utf8'), f).not.toMatch(/outputs\.upstream|\bUPSTREAM\b|upstream-findings/);
    }
  });
});
