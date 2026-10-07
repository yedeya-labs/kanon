import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_SECRETS, STORE_SECRETS_WITH, storeLaneProblems, type Workflow } from './helpers/store-jobs.js';
import { agentPrompt, runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { effectiveSteps } from './helpers/spine.js';
import { readFlattened, workflowText } from './helpers/called-workflow.js';
import { callerInputs, realGroup } from './helpers/smoke-group.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * Plan 0004 step 12: the Explorer's sweep lane, moved from the reference adopter onto the store
 * contract. Its change gate reads the QA store in a store job, the sweep is the adopter's hook,
 * and the agent triages the hook's summary, in the format `scripts/explore-summary.mjs` fixes.
 *
 * The plan's checks, as far as they run without a model or a store: the agent job holds no
 * store credentials (P9's check, through `store-jobs.ts`); a scheduled run on an unchanged commit
 * skips and records the skip; a dispatch with a tier runs the sweep hook and files from its
 * summary; and with the store hook removed, the gate sweeps and says the store is absent. These
 * run the lane's real `run:` bodies with Kanon's scripts, as the runner does.
 */
const ROOT = process.cwd();
const FILE = '.github/workflows/agent-explore.yml';
const raw = workflowText(join(ROOT, FILE));
type Step = WorkflowStep & { with?: Record<string, unknown> };
type Job = { if?: string; needs?: string | string[]; environment?: string; outputs?: Record<string, string>; permissions?: Record<string, string>; steps: Step[] };
const wf = readFlattened(join(ROOT, FILE)) as { on: { workflow_call: { inputs: Record<string, { type?: string; default?: string; required?: boolean }>; secrets: Record<string, unknown> } }; jobs: Record<string, Job>; concurrency: { group: string } };
const jobs = wf.jobs;
const explore = jobs.explore!;
const steps = explore.steps;
const at = (id: string) => steps.findIndex((s) => s.id === id);
const byId = (id: string) => steps.find((s) => s.id === id)!;
const storeOp = (name: string) => jobs[name]!.steps.find((s) => s.uses === '$/actions/qa-store')?.with;

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('the store contract (plan 0004 §3.2, P9\'s check)', () => {
  it('has the shape store-jobs.ts holds every store-coupled lane to', () => {
    expect(storeLaneProblems(wf as unknown as Workflow)).toEqual([]);
  });

  it('reads the baseline, records a skip and puts the run, each in a store job of its own', () => {
    const store = Object.entries(jobs).filter(([, j]) => j.permissions?.['id-token'] === 'write').map(([n]) => n).sort();
    expect(store).toEqual(['last-green', 'put', 'record-skip']);
    for (const [n, j] of Object.entries(jobs)) expect(j.environment, n).toBeUndefined();
    expect(storeOp('last-green')).toEqual({ operation: 'last-green', secrets: STORE_SECRETS_WITH });
    expect(storeOp('record-skip')).toEqual({ operation: 'record-skip', secrets: STORE_SECRETS_WITH, commit: '${{ github.sha }}', trigger: '${{ github.event_name }}', tier: 'all', reason: 'unchanged-commit' });
    expect(storeOp('put')).toMatchObject({ operation: 'put', kind: 'explorer', report: '${{ runner.temp }}/kanon-explore/qa-explore-summary.json' });
  });

  it('names no cloud: the store is reached only through the hook', () => {
    expect(raw).not.toMatch(/aws|dynamodb|s3:|role-to-assume|vars\./i);
  });

  it('runs only on its caller\'s two triggers, and never two sweeps at once', () => {
    expect(jobs.gate!.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(realGroup(wf.concurrency.group)).toBe('agent-explore');
    expect(Object.keys(callerInputs(wf.on.workflow_call.inputs)!)).toEqual(['tier']);
    expect(wf.on.workflow_call.inputs.tier).toMatchObject({ type: 'string', default: '', required: false });
    expect(Object.keys(wf.on.workflow_call.secrets).sort()).toEqual(['AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', ...STORE_SECRETS]);
  });
});

// Its cases run the gate step in `bash` against a stub `gh`, so the block takes the spawn budget (#436).
describe('the change gate (RA-167): skip a scheduled run on a commit already swept green', SPAWNS, () => {
  it('reads the baseline only on the schedule, the one trigger it gates', () => {
    expect(jobs['last-green']!.needs).toBe('gate');
    expect(jobs['last-green']!.if).toBe("needs.gate.outputs.member == 'true' && github.event_name == 'schedule'");
  });

  it('decides in a job with no credentials, whatever happened to the store job', () => {
    expect(jobs.change!.needs).toEqual(['gate', 'last-green']);
    expect(jobs.change!.if).toBe("${{ !cancelled() && needs.gate.outputs.member == 'true' }}");
    expect(jobs.change!.permissions).toEqual({ contents: 'read' });
  });

  it('records a skip only when it skips, and sweeps only when it sweeps', () => {
    expect(jobs['record-skip']!.needs).toBe('change');
    expect(jobs['record-skip']!.if).toBe("${{ !cancelled() && needs.change.result == 'success' && needs.change.outputs.sweep == 'false' }}");
    expect(explore.needs).toBe('change');
    expect(explore.if).toBe("${{ !cancelled() && needs.change.result == 'success' && needs.change.outputs.sweep == 'true' }}");
  });

  // GitHub prepends `success()` to a job `if:` with no status function, and evaluates it over
  // every job in the `needs` chain, grandparents included (actions/runner#491). `last-green` is
  // skipped on every dispatch and can fail on a schedule, so a job downstream of it that relies
  // on the implicit `success()` never starts on a dispatch, whatever `change` decided.
  const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
    for (const n of [jobs[name]!.needs ?? []].flat()) if (!seen.has(n)) { seen.add(n); ancestors(n, seen); }
    return seen;
  };
  const STATUS = /\b(always|cancelled|success|failure)\(\)/;
  it.each(Object.keys(jobs).filter((n) => ancestors(n).has('last-green')))(
    '%s, downstream of the store job a dispatch skips, names a status function and needs its parent to have succeeded',
    (name) => {
      const cond = String(jobs[name]!.if ?? '');
      expect(cond, name).toMatch(STATUS);
      expect(cond, name).toMatch(/^\$\{\{ !cancelled\(\) && /);
      // Without a parent check, `!cancelled()` would start it after a failed or refused parent.
      const parents = [jobs[name]!.needs ?? []].flat();
      const guarded = parents.some((p) => cond.includes(`needs.${p}.result == 'success'`) || cond.includes(`needs.${p}.outputs.`));
      expect(guarded, name).toBe(true);
    },
  );

  it('finds the jobs downstream of last-green, so the rule above is not vacuous', () => {
    expect(Object.keys(jobs).filter((n) => ancestors(n).has('last-green')).sort()).toEqual(['change', 'explore', 'put', 'record-skip']);
  });

  const decide = jobs.change!.steps.find((s) => s.id === 'decide')!;
  const run = (env: Record<string, string>) => runWorkflowStep(decide, {
    env: { KANON: ROOT, HEAD_SHA: SHA, ...env },
  });

  it('a scheduled run on the commit of the last green full sweep skips, and says so', () => {
    const r = run({ EVENT: 'schedule', BASELINE_RESULT: 'success', STATE: 'ok', LAST_GREEN: SHA });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.sweep).toBe('false');
    expect(r.summary).toContain('already swept green: skipping the sweep, and recording the skip');
  });

  it('a scheduled run on a changed commit sweeps', () => {
    const r = run({ EVENT: 'schedule', BASELINE_RESULT: 'success', STATE: 'ok', LAST_GREEN: OTHER });
    expect(r.outputs.sweep).toBe('true');
    expect(r.summary).toContain('The commit changed since the last green full sweep');
  });

  it('with the store hook removed, the gate sweeps and the summary says the store is absent', () => {
    // What the block answers without a hook: `state: absent` and no commit (qa-store.mjs).
    const r = run({ EVENT: 'schedule', BASELINE_RESULT: 'success', STATE: 'absent', LAST_GREEN: '' });
    expect(r.outputs.sweep).toBe('true');
    expect(r.summary).toContain('The QA store is absent');
    expect(r.output).not.toContain('::warning');
  });

  it('a degraded read, or a store job that failed, sweeps and warns: never a silent skip (RA-702)', () => {
    for (const env of [
      { STATE: 'degraded', BASELINE_RESULT: 'success', LAST_GREEN: '' },
      { STATE: '', BASELINE_RESULT: 'failure', LAST_GREEN: '' },
      // A failed job's outputs are not trusted, even a commit equal to this one.
      { STATE: 'ok', BASELINE_RESULT: 'failure', LAST_GREEN: SHA },
    ]) {
      const r = run({ EVENT: 'schedule', ...env });
      expect(r.outputs.sweep, JSON.stringify(env)).toBe('true');
      expect(r.output, JSON.stringify(env)).toContain('::warning title=Explorer change gate degraded::');
    }
  });

  it('a dispatch always sweeps, with the baseline job skipped', () => {
    const r = run({ EVENT: 'workflow_dispatch', BASELINE_RESULT: 'skipped', STATE: '', LAST_GREEN: '' });
    expect(r.outputs.sweep).toBe('true');
    expect(r.output).not.toContain('::warning');
  });
});

// Its cases run the sweep step in `bash` against a stub hook, so the block takes the spawn budget (#436).
describe('the sweep is the project\'s hook, and its summary is Kanon\'s format (decision 5, §4)', SPAWNS, () => {
  it('sets the project up, then sweeps, then checks the summary, then uploads it, all before the token', () => {
    const order = ['checkout', 'hook', 'kanon', 'database', 'project', 'setup', 'sweep', 'summary', 'upload', 'app-token', 'agent'].map(at);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('calls the sweep hook with the caller\'s tier, from the checkout', () => {
    expect(byId('sweep').uses).toBe('./.github/actions/explore-sweep');
    expect(byId('sweep').with).toEqual({ tier: '${{ inputs.tier }}' });
    expect(byId('project').with).toEqual({ lane: 'explorer', install: 'true', database: '${{ steps.database.outputs.database }}', browsers: 'true' });
    expect(raw).toMatch(/^# NEEDS HOOK: \.github\/actions\/explore-sweep\/action\.yml$/m);
  });

  it('fails by name when either hook is missing, with the telemetry code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'explore-hooks-'));
    const r = runWorkflowStep(byId('hook'), { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.output).toContain('title=project-setup hook missing::');
    expect(r.outputs['kanon-error']).toBe('hook_missing');
    // The project-setup hook alone is not enough: the sweep hook is checked by name too.
    mkdirSync(join(dir, '.github/actions/project-setup'), { recursive: true });
    writeFileSync(join(dir, '.github/actions/project-setup/action.yml'), 'runs: { using: composite, steps: [] }\n');
    const s = runWorkflowStep(byId('hook'), { cwd: dir });
    expect(s.status).toBe(1);
    expect(s.output).toContain('title=explore-sweep hook missing::');
    expect(s.outputs['kanon-error']).toBe('hook_missing');
  });

  /** Run the lane's real summary check in a checkout holding `summary` (or none). */
  const check = (summary: unknown, env: Record<string, string> = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), 'explore-summary-'));
    if (summary !== undefined) writeFileSync(join(cwd, 'qa-explore-summary.json'), typeof summary === 'string' ? summary : JSON.stringify(summary));
    return runWorkflowStep(byId('summary'), { cwd, env: { KANON: ROOT, COMMIT: SHA, TIER: '', ...env } });
  };
  const good = {
    timestamp: '2026-10-04T06:21:42.512Z', trigger: 'schedule', commit: SHA, tier: 'all',
    routes_swept: 2, passed: 1, failed: 1,
    routes: [{ route: '/', status: 'passed' }, { route: '/admin', status: 'failed', signal: '[pageerror] boom' }],
    cost_proxy: { duration_ms_total: 1200, screenshots: 1 },
  };

  it('passes a well-formed summary of this run, and hands on its counts', () => {
    const r = check(good);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs).toMatchObject({ routes_swept: '2', passed: '1', failed: '1' });
    expect(r.summary).toContain('2 routes, 1 passed, 1 failed');
  });

  it('reads a missing summary as no sweep, never as green', () => {
    const r = check(undefined);
    expect(r.status).toBe(1);
    expect(r.output).toContain('wrote no qa-explore-summary.json: no sweep, which is never green');
  });

  it('fails a malformed summary by name', () => {
    const r = check({ ...good, version: 1 });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error title=Explorer sweep summary::`version` is not a summary key');
  });

  it('a dispatch with a tier reads a summary of that tier, and fails one of another', () => {
    expect(check({ ...good, trigger: 'workflow_dispatch', tier: 'admin' }, { TIER: 'admin' }).status).toBe(0);
    const r = check(good, { TIER: 'admin' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('`tier` is all, and this run asked for admin');
  });

  it('runs only after both hooks and the setup succeeded, and gates the upload', () => {
    expect(byId('summary').if).toBe("${{ !cancelled() && steps.hook.outcome == 'success' && steps.project.outcome == 'success' }}");
    expect(byId('upload').if).toBe("${{ !cancelled() && steps.summary.outcome == 'success' }}");
    expect(byId('upload').with).toMatchObject({ path: 'qa-explore-summary.json', 'if-no-files-found': 'error' });
  });

  it('hands the put job the summary only when one was uploaded, so no summary records nothing', () => {
    expect(explore.outputs?.['summary-artifact']).toBe("${{ steps.upload.outputs.artifact-id && format('kanon-explore-summary-{0}-{1}', github.run_id, github.run_attempt) || '' }}");
    expect(byId('upload').with?.name).toBe('kanon-explore-summary-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(jobs.put!.needs).toBe('explore');
    expect(jobs.put!.if).toBe("${{ !cancelled() && needs.explore.outputs.summary-artifact != '' }}");
    const download = jobs.put!.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with).toEqual({ name: '${{ needs.explore.outputs.summary-artifact }}', path: '${{ runner.temp }}/kanon-explore' });
  });
});

describe('the agent triages the summary (plan 0004 §4\'s second open item)', () => {
  const prompt = agentPrompt(effectiveSteps(steps)).replace(/\s+/g, ' ');

  it('reads the summary, and no raw report of the project\'s tool', () => {
    expect(prompt).toContain('`qa-explore-summary.json`');
    expect(prompt).toContain('read no other report');
    expect(raw).not.toMatch(/qa-explore-report|playwright/i);
  });

  it('files into the bucket, never a roadmap milestone', () => {
    expect(prompt).toContain('Milestone: Product Backlog, a bucket');
    expect(prompt).not.toMatch(/Production Ready/);
  });

  it('records its row as the explore lane, with the claude_args it ran', () => {
    const finish = byId('finish').with!;
    expect(finish.lane).toBe('explore');
    expect(finish.agent).toBe('explorer');
    expect(finish.claude_args).toBe(byId('agent').with!.claude_args);
    expect(finish['artifacts-filed']).toBe('${{ steps.quality.outputs.artifacts_filed }}');
  });
});
