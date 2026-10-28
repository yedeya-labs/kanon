import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { RUNTIME_NOT_INSTALLED, readRuntimeNotInstalled } from '../../actions/agent-classify/classify-agent-result.mjs';
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
  const run = (w: { runnerTemp: string; home: string }, over: Record<string, string> = {}) => spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, RUNNER_TEMP: w.runnerTemp, HOME: w.home,
      OUTCOME: 'failure', CONCLUSION: '', EXECUTION_FILE: '', STARTED_AT: STARTED, ...over,
    },
  });

  it('writes the marker agent-classify reads, and exits 0', () => {
    const w = world();
    const r = run(w);
    expect(r.status).toBe(0);
    expect(existsSync(join(w.runnerTemp, RUNTIME_NOT_INSTALLED))).toBe(true);
    expect(readRuntimeNotInstalled(w.runnerTemp)).toBe(true);
  });

  it('writes no marker when the CLI is in place, and still exits 0', () => {
    const w = world({ cli: true });
    expect(run(w).status).toBe(0);
    expect(readRuntimeNotInstalled(w.runnerTemp)).toBe(false);
  });

  it('exits 0 even when it cannot write the marker', () => {
    const w = world();
    mkdirSync(join(w.runnerTemp, RUNTIME_NOT_INSTALLED));   // a directory where the file goes
    const r = run(w);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^::warning title=runtime-check::Could not record/m);
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
    });
  });
});
