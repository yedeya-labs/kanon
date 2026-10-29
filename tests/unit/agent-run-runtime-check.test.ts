import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CHECK_RUN_ID_ENV, RUNTIME_NOT_INSTALLED, readRuntimeNotInstalled, runtimeMarker } from '../../actions/agent-classify/classify-agent-result.mjs';
import { CLI_PATH, PROMPT_FILE, runtimeCheck } from '../../actions/agent-run/runtime-check.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * kanon#1470 — `agent-run` records that claude-code-action's install of Claude Code failed, so
 * `agent-classify` can call the run `unavailable` rather than "cannot tell which".
 *
 * Review run 39739375943 logged "Installation failed, retrying..." twice and wrote no result file.
 * The evidence is what the action leaves on disk, never its log: in the pinned action the prepare
 * phase writes the prompt and the install comes next, putting the CLI at `~/.local/bin/claude`.
 * A failed step with no `conclusion`, no result file, a prompt written during this run and no CLI
 * failed at the install. Every other shape records nothing, so nothing widens what counts as
 * unreachable.
 */

const STARTED = '2026-10-28T10:00:00Z';

/** A runner's temp directory and home, with the prompt the action writes and, optionally, the CLI. */
const world = ({ prompt = true, promptAt = '2026-10-28T10:00:05Z', cli = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-check-'));
  const runnerTemp = join(root, 'temp');
  const home = join(root, 'home');
  mkdirSync(join(runnerTemp, 'claude-prompts'), { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  if (prompt) {
    const p = join(runnerTemp, PROMPT_FILE);
    writeFileSync(p, 'the prompt');
    const at = new Date(promptAt);
    utimesSync(p, at, at);
  }
  if (cli) writeFileSync(join(home, CLI_PATH), '#!/bin/sh\n');
  return { runnerTemp, home };
};

const failedInstall = { outcome: 'failure', conclusion: '', executionFile: '', startedAt: STARTED };

describe('the runtime check reads where the action failed', () => {
  it('records a failed install: a prompt from this run and no CLI in place', () => {
    const r = runtimeCheck({ ...failedInstall, ...world() });
    expect(r.notInstalled).toBe(true);
    expect(r.message).toMatch(/install failed, so the model was never called/);
  });

  it.each([
    ['the agent step passed', { outcome: 'success' }],
    ['the agent step was skipped', { outcome: 'skipped' }],
    ['the CLI returned a conclusion', { conclusion: 'failure' }],
    ['the CLI wrote a result file', { executionFile: '/runner/temp/claude-execution-output.json' }],
    ['no start stamp to date the prompt by', { startedAt: '' }],
  ])('records nothing when %s', (_name, over) => {
    expect(runtimeCheck({ ...failedInstall, ...world(), ...over }).notInstalled).toBe(false);
  });

  it('records nothing when the action failed before its prepare wrote the prompt', () => {
    expect(runtimeCheck({ ...failedInstall, ...world({ prompt: false }) }).notInstalled).toBe(false);
  });

  it("records nothing for a prompt an earlier job left on a reused runner", () => {
    expect(runtimeCheck({ ...failedInstall, ...world({ promptAt: '2026-10-28T09:59:00Z' }) }).notInstalled).toBe(false);
  });

  it('records nothing when a CLI is in place: the install worked, or an earlier one is there', () => {
    const r = runtimeCheck({ ...failedInstall, ...world({ cli: true }) });
    expect(r.notInstalled).toBe(false);
    expect(r.message).toMatch(/CLI is in place/);
  });

  it('records nothing without an absolute temp directory and home', () => {
    const w = world();
    expect(runtimeCheck({ ...failedInstall, ...w, runnerTemp: '' }).notInstalled).toBe(false);
    expect(runtimeCheck({ ...failedInstall, ...w, home: 'relative' }).notInstalled).toBe(false);
  });
});

describe('the runtime check, run as the block runs it', SPAWNS, () => {
  const script = join(process.cwd(), 'actions/agent-run/runtime-check.mjs');
  const JOB = { GITHUB_RUN_ID: '40715172609', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'review', KANON_JOB_CHECK_RUN_ID: '58200000001' };
  const run = (w: { runnerTemp: string; home: string }, over: Record<string, string> = {}) => spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, RUNNER_TEMP: w.runnerTemp, HOME: w.home, ...JOB,
      OUTCOME: 'failure', CONCLUSION: '', EXECUTION_FILE: '', STARTED_AT: STARTED, ...over,
    },
  });

  it('writes the marker agent-classify reads, for this job alone, and exits 0', () => {
    const w = world();
    const r = run(w);
    expect(r.status).toBe(0);
    expect(existsSync(join(w.runnerTemp, RUNTIME_NOT_INSTALLED))).toBe(true);
    expect(readRuntimeNotInstalled(w.runnerTemp, { env: JOB })).toBe(true);
    expect(readRuntimeNotInstalled(w.runnerTemp, { env: { ...JOB, GITHUB_RUN_ID: '1' } }), 'a later job on the runner').toBe(false);
    expect(readRuntimeNotInstalled(w.runnerTemp, { env: { ...JOB, KANON_JOB_CHECK_RUN_ID: '58200000002' } }), 'a sibling matrix entry').toBe(false);
  });

  it('writes no marker when the CLI is in place, and still exits 0', () => {
    const w = world({ cli: true });
    expect(run(w).status).toBe(0);
    expect(readRuntimeNotInstalled(w.runnerTemp, { env: JOB })).toBe(false);
  });

  it('exits 0 even when it cannot write the marker', () => {
    const w = world();
    mkdirSync(join(w.runnerTemp, RUNTIME_NOT_INSTALLED));   // a directory where the file goes
    const r = run(w);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^::warning title=runtime-check::Could not record/m);
  });
});

/**
 * A marker present before the block starts is not this run's (the PR #1491 review). A
 * non-ephemeral runner can keep `RUNNER_TEMP`, so an earlier block of the same job, whose marker
 * names this very job, could otherwise mark a later failure `unavailable`. The block's first step
 * deletes it, before the agent can run; it is run here as the runner runs it.
 */
describe("agent-run's first step clears a marker left before it started", SPAWNS, () => {
  type Step = { name?: string; run?: string; shell?: string };
  const first = (parse(readFileSync(join(process.cwd(), 'actions/agent-run/action.yml'), 'utf8')).runs.steps as Step[])[0]!;
  const runStep = (runnerTemp: string) => {
    const out = join(runnerTemp, 'out.txt');
    writeFileSync(out, '');
    const r = spawnSync('bash', ['-e', '-c', String(first.run)], { encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: out } });
    return { status: r.status, output: readFileSync(out, 'utf8') };
  };

  it('is the start stamp, under the shell every block step uses', () => {
    expect(first.name).toBe('Record when the agent started');
    expect(first.shell).toBe('bash -e {0}');
  });

  it("deletes the marker, so it isn't read as this run's, and still stamps the start", () => {
    const { runnerTemp } = world();
    const JOB = { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'review', KANON_JOB_CHECK_RUN_ID: '58200000001' };
    writeFileSync(join(runnerTemp, RUNTIME_NOT_INSTALLED), runtimeMarker(JOB, 'an earlier block'));
    expect(readRuntimeNotInstalled(runnerTemp, { env: JOB }), 'the check is not vacuous').toBe(true);
    const r = runStep(runnerTemp);
    expect(r.status).toBe(0);
    expect(existsSync(join(runnerTemp, RUNTIME_NOT_INSTALLED))).toBe(false);
    expect(readRuntimeNotInstalled(runnerTemp, { env: JOB })).toBe(false);
    expect(r.output).toMatch(/^at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
  });

  it('never fails: no marker, or no temp directory, still stamps the start', () => {
    const { runnerTemp } = world();
    expect(runStep(runnerTemp).status).toBe(0);
    const out = join(runnerTemp, 'out2.txt');
    writeFileSync(out, '');
    const r = spawnSync('bash', ['-e', '-c', String(first.run)], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out } });
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toMatch(/^at=/m);
  });
});

describe("agent-run runs the check after the action, and only after it failed", () => {
  type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; 'continue-on-error'?: boolean };
  const steps = (parse(readFileSync(join(process.cwd(), 'actions/agent-run/action.yml'), 'utf8')).runs.steps as Step[]);
  const agent = steps.findIndex((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'));
  const check = steps.findIndex((s) => String(s.run ?? '').includes('runtime-check.mjs'));

  it('is one step, after the agent step', () => {
    expect(agent, 'the check is not vacuous').toBeGreaterThan(-1);
    expect(steps[agent]!.id).toBe('agent');
    expect(check).toBeGreaterThan(agent);
  });

  it("runs on the agent step's failure, and can never change the block's outcome", () => {
    const s = steps[check]!;
    expect(s.if).toBe("!cancelled() && steps.agent.outcome == 'failure'");
    expect(s['continue-on-error']).toBe(true);
    expect(s.run).toBe('node "$GITHUB_ACTION_PATH/runtime-check.mjs"');
  });

  it("reads the agent step's outcome and outputs and the start stamp, through env only", () => {
    expect(steps[check]!.env).toEqual({
      OUTCOME: '${{ steps.agent.outcome }}',
      CONCLUSION: '${{ steps.agent.outputs.conclusion }}',
      EXECUTION_FILE: '${{ steps.agent.outputs.execution_file }}',
      STARTED_AT: '${{ steps.started.outputs.at }}',
      KANON_JOB_CHECK_RUN_ID: '${{ job.check_run_id }}',
    });
  });
});

/**
 * The marker names this job execution's check run (kanon#1499), and the runner sets no variable
 * for it: the step that writes the marker and each step that reads it pass `job.check_run_id`
 * themselves. A step that dropped it would leave the id empty, and the marker would never count.
 */
describe("the marker's writer and readers each pass this job's check run", () => {
  type Step = { name?: string; env?: Record<string, string> };
  const steps = (action: string) => parse(readFileSync(join(process.cwd(), `actions/${action}/action.yml`), 'utf8')).runs.steps as Step[];
  it.each([
    ['agent-run', 'Record whether claude-code-action failed to install Claude Code'],
    ['agent-classify', 'Say whether the model was unreachable or the run genuinely failed'],
    ['agent-telemetry', 'Normalize and summarize'],
  ])('%s: %s', (action, name) => {
    const step = steps(action).find((s) => s.name === name);
    expect(step, `${action} has the step`).toBeDefined();
    expect(step!.env?.[CHECK_RUN_ID_ENV]).toBe('${{ job.check_run_id }}');
  });
});
