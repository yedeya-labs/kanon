import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TRIGGERS } from '../../cli/callers.mjs';
import { SPAWNS } from './helpers/spawns.js';

const { trackingIssueRefusal } = await import('../../scripts/lead-tracking-issue.mjs');

/**
 * kanon#1558 (point 11 of #1551): a brief-lane dispatch with an empty `context` ran 15 turns,
 * about $0.66, and ended green with nothing: no pull request, no branch, no comment, and a
 * telemetry row saying `ok`. The prompt's "If you were given no tracking issue, STOP and say so"
 * was all that held `K-AGENT-30`, and nobody who dispatched it could see it.
 *
 * So the lane refuses such a dispatch before any model call, as the turn-budget check refuses
 * a raise: its `filter` job reads `context`, and a context with no tracking issue becomes the
 * spine's `refusal`, which `agent-run` fails on before the agent starts. The run is red, its
 * error says what to do, and its telemetry row records `not-reached`, never `ok`. Every way the
 * Lead's brief is started (the mandate skill, the caller's form, a `gh workflow run`) is a
 * dispatch of this lane, so the refusal holds for each. The caller `kanon init` writes requires
 * `context` too, so the form asks for it.
 */
const ROOT = process.cwd();
const WF = join(ROOT, '.github/workflows');
const yml = (f: string) => parse(readFileSync(f, 'utf8'));

describe('the brief lane\'s context names the tracking issue (K-AGENT-30)', () => {
  it.each(['42', '#42', ' 42 ', '42,43', '#42, #43', '42, 43,44'])('takes %j: issue numbers, the tracking issue among them', (context) => {
    expect(trackingIssueRefusal(context)).toBe('');
  });

  it.each(['', '   ', '\n'])('refuses %j: no tracking issue, and says what to do', (context) => {
    const r = trackingIssueRefusal(context);
    expect(r).toMatch(/K-AGENT-30/);
    expect(r).toContain("File the project's tracking issue, then dispatch again with its number as `context`");
    expect(r).toContain('docs/lanes.md, "Start a project"');
  });

  it.each(['the roadmap', '42 and 43', 'kanon#42', '0', '#', '42,,43', '4.2', '42; rm -rf /'])('refuses %j: context holds issue numbers only, comma-separated', (context) => {
    expect(trackingIssueRefusal(context)).toMatch(/issue numbers, comma-separated/);
  });

  it('never repeats the context it refuses, so a value can\'t write a workflow command of its own', () => {
    const r = trackingIssueRefusal('x\n::add-mask::y');
    expect(r).not.toContain('add-mask');
    expect(r).not.toMatch(/[\r\n]/);
  });
});

describe('the script, as the filter job runs it', SPAWNS, () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const run = (context: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'lead-tracking-'));
    dirs.push(dir);
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const r = spawnSync('node', [join(ROOT, 'scripts/lead-tracking-issue.mjs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CONTEXT: context, GITHUB_OUTPUT: out },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, written: readFileSync(out, 'utf8') };
  };

  it('writes an empty refusal for a context that names the tracking issue', () => {
    const r = run('42');
    expect(r.status, r.out).toBe(0);
    expect(r.written).toBe('refusal=\n');
  });

  it('writes the refusal, on one line, for a context that names none, and says so in the log', () => {
    const r = run('');
    expect(r.status, r.out).toBe(0);
    expect(r.written).toBe(`refusal=${trackingIssueRefusal('')}\n`);
    expect(r.out).toContain('K-AGENT-30');
  });
});

describe('the refusal reaches agent-run, which fails on it before the agent starts', () => {
  type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; 'continue-on-error'?: unknown };
  const lead = yml(join(WF, 'agent-lead.yml'));
  const action = yml(join(ROOT, 'actions/agent-run/action.yml')) as { inputs: Record<string, { default?: string }>; runs: { steps: Step[] } };

  it('the filter job checks the context, by env only, and hands its refusal to the spine', () => {
    const steps = lead.jobs.filter.steps as Step[];
    const check = steps.find((s) => s.id === 'tracking')!;
    expect(check.run).toBe('node "$KANON/scripts/lead-tracking-issue.mjs"');
    expect(check.env).toEqual({ CONTEXT: '${{ inputs.context }}' });
    expect(steps.indexOf(check)).toBeGreaterThan(steps.findIndex((s) => s.id === 'gate'));
    expect(lead.jobs.filter.outputs.refusal).toBe('${{ steps.tracking.outputs.refusal }}');
    expect(lead.jobs.brief.with.refusal).toBe('${{ needs.filter.outputs.refusal }}');
    for (const s of steps) expect(String(s.run ?? '')).not.toMatch(/inputs\.context/);
  });

  it('the spine passes it through to agent-run, empty by default', () => {
    const lane = yml(join(WF, 'agent-lane.yml'));
    const job = yml(join(WF, 'lane-agent-job.yml'));
    expect(lane.on.workflow_call.inputs.refusal).toMatchObject({ required: false, type: 'string', default: '' });
    expect(lane.jobs.run.with.refusal).toBe('${{ inputs.refusal }}');
    expect(job.on.workflow_call.inputs.refusal).toMatchObject({ required: false, type: 'string', default: '' });
    const agent = (job.jobs.run.steps as Array<Step & { with?: Record<string, string> }>).find((s) => s.id === 'agent')!;
    expect(agent.with?.refusal).toBe('${{ inputs.refusal }}');
    expect(action.inputs.refusal?.default).toBe('');
  });

  it('agent-run fails on a refusal after the turn-limit check and before the credential and the agent', () => {
    const steps = action.runs.steps;
    const at = steps.findIndex((s) => s.id === 'refusal');
    expect(at).toBeGreaterThan(steps.findIndex((s) => s.id === 'turns'));
    expect(at).toBeLessThan(steps.findIndex((s) => s.id === 'credential'));
    expect(at).toBeLessThan(steps.findIndex((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@')));
    const step = steps[at]!;
    expect(step.if).toBe("inputs.refusal != ''");
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.env).toEqual({ REFUSAL: '${{ inputs.refusal }}' });
    expect(step.run).toMatch(/::error title=agent-run::/);
    expect(step.run).toMatch(/exit 1\s*$/);
    for (const s of steps) expect(String(s.run ?? '')).not.toMatch(/inputs\.refusal/);
  });

  it.each([
    ['a refusal', 'No tracking issue (K-AGENT-30).', 1, '::error title=agent-run::No tracking issue (K-AGENT-30).'],
    ['one that would write a command of its own, encoded', 'a%\n::add-mask::b', 1, '::error title=agent-run::a%25%0A::add-mask::b'],
  ])('the step, run: %s', (_name, refusal, status, line) => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-run-refusal-'));
    try {
      const summary = join(dir, 'summary');
      writeFileSync(summary, '');
      const step = action.runs.steps.find((s) => s.id === 'refusal')!;
      const r = spawnSync('bash', ['-e', '-c', step.run!], { encoding: 'utf8', env: { PATH: process.env.PATH, REFUSAL: refusal, GITHUB_STEP_SUMMARY: summary } });
      expect(r.status).toBe(status);
      expect(r.stdout.split('\n')).toContain(line);
      expect(readFileSync(summary, 'utf8')).toContain('Refused before the agent started');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the caller kanon init writes requires the tracking issue', () => {
  it('asks the dispatch form for context, as well as the mandate', () => {
    expect(TRIGGERS['agent-lead']?.dispatch).toEqual({ mandate: true, context: true });
  });

  it('describes context as the tracking issue, in the lane and in Kanon\'s own caller', () => {
    const lane = yml(join(WF, 'agent-lead.yml'));
    const caller = yml(join(WF, 'lead.yml'));
    const description = lane.on.workflow_call.inputs.context.description as string;
    expect(description).toMatch(/^The project's tracking issue number/);
    expect(caller.on.workflow_dispatch.inputs.context).toEqual({ description, required: true });
  });
});
