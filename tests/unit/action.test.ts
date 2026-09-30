import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { run?: string; env?: Record<string, string>; shell?: string; uses?: string };
type Action = {
  inputs: Record<string, { default?: string; required?: boolean }>;
  runs: { using: string; steps: Step[] };
};

const dir = new URL('../../actions/pr-title/', import.meta.url);
const text = readFileSync(new URL('action.yml', dir), 'utf8');
const action = parse(text) as Action;
const steps = action.runs.steps;
const runSteps = steps.filter((s) => s.run !== undefined);

describe('K-SHIP-4 the pr-title composite action', () => {
  it('is a composite action whose title input defaults to the pull request title', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.inputs.title?.default).toBe('${{ github.event.pull_request.title }}');
    expect(action.inputs.title?.required).not.toBe(true);
  });

  it('runs the script from its own directory, through GITHUB_ACTION_PATH', () => {
    expect(runSteps).toHaveLength(1);
    expect(runSteps[0]?.run?.trim()).toBe('node "$GITHUB_ACTION_PATH/pr-title.mjs"');
    expect(existsSync(new URL('pr-title.mjs', dir))).toBe(true);
  });

  it('passes the title to the script only through the environment', () => {
    expect(runSteps[0]?.env).toEqual({ PR_TITLE: '${{ inputs.title }}' });
    const script = readFileSync(new URL('pr-title.mjs', dir), 'utf8');
    expect(script).toContain('process.env.PR_TITLE');
  });

  it('interpolates no expression into any run line, and never names github.event there', () => {
    for (const s of runSteps) {
      expect(s.run).not.toContain('${{');
      expect(s.run).not.toContain('github.event');
    }
  });

  it('declares a shell on every run step, as a composite action must', () => {
    for (const s of runSteps) expect(s.shell).toBe('bash');
  });

  it('uses no other action, so it needs nothing but Node on the runner', () => {
    expect(steps.filter((s) => s.uses !== undefined)).toEqual([]);
  });
});

describe('K-SHIP-4 the script, run as the action runs it', () => {
  const script = fileURLToPath(new URL('pr-title.mjs', dir));
  const envName = Object.keys(runSteps[0]?.env ?? {})[0] ?? 'missing';
  const run = (title: string) =>
    spawnSync(process.execPath, [script], { env: { ...process.env, [envName]: title }, encoding: 'utf8' });

  it('passes a valid title read from the environment', () => {
    const result = run('feat(actions): ship the PR-title check as a composite action');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PR title OK');
  });

  it('fails an invalid title read from the environment, and lists the recognised types', () => {
    const result = run('feat: a thing (#1)');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('issue reference');
    expect(result.stderr).toContain('Recognised types: feat, fix, perf, refactor, build, revert, docs, style, test, ci, chore.');
  });
});
