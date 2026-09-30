import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { run?: string; env?: Record<string, string>; shell?: string; uses?: string };
type Action = { inputs?: Record<string, unknown>; runs: { using: string; steps: Step[] } };

const dir = new URL('../../actions/dco/', import.meta.url);
const text = readFileSync(new URL('action.yml', dir), 'utf8');
const action = parse(text) as Action;
const steps = action.runs.steps;
const runSteps = steps.filter((s) => s.run !== undefined);

describe('ADR 0010 the dco composite action', () => {
  it('is a composite action with no inputs (ADR 0002)', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.inputs).toBeUndefined();
  });

  it('runs the script from its own directory, through GITHUB_ACTION_PATH', () => {
    expect(runSteps).toHaveLength(1);
    expect(runSteps[0]?.run?.trim()).toBe('node "$GITHUB_ACTION_PATH/dco.mjs"');
    expect(existsSync(new URL('dco.mjs', dir))).toBe(true);
  });

  it('passes the token, repository, PR number and base only through the environment', () => {
    expect(runSteps[0]?.env).toEqual({
      GITHUB_TOKEN: '${{ github.token }}',
      REPOSITORY: '${{ github.repository }}',
      PR_NUMBER: '${{ github.event.pull_request.number }}',
      BASE_REF: '${{ github.base_ref }}',
    });
    const script = readFileSync(new URL('dco.mjs', dir), 'utf8');
    expect(script).toContain('process.env');
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

  it('names and justifies its fixed exemptions in the header', () => {
    const header = readFileSync(new URL('dco.mjs', dir), 'utf8').split('\nimport ')[0] ?? '';
    for (const word of ['Merge commits', 'dependabot[bot]', 'github-actions[bot]', 'ADR 0002', 'verified']) {
      expect(header).toContain(word);
    }
  });
});

describe('ADR 0010 the script, run as the action runs it', () => {
  const script = fileURLToPath(new URL('dco.mjs', dir));

  it('fails, without calling the API, when the pull request number is missing', () => {
    const env = { ...process.env, GITHUB_TOKEN: 'x', REPOSITORY: 'o/r', PR_NUMBER: '', GITHUB_API_URL: 'http://127.0.0.1:9' };
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pull_request');
  });

  it('fails closed when the API cannot be reached', () => {
    const env = { ...process.env, GITHUB_TOKEN: 'x', REPOSITORY: 'o/r', PR_NUMBER: '1', GITHUB_API_URL: 'http://127.0.0.1:9' };
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not read the pull request's commits");
  });
});
