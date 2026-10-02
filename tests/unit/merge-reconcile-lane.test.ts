import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STAGE_BLOCKS, laneBlockOf } from './helpers/agent-lanes.mjs';
import { blockOf, readBlock, stepsAsRun } from './helpers/spine.js';
import type { WorkflowStep } from './helpers/workflow-step.js';

/**
 * RA-2660 — merge-reconcile calls the agent-lane blocks directly, and installs NOTHING.
 *
 * The arm never ran `npm ci` and has no database: its agent reads the merged tree and calls
 * `gh`. `agent-setup` runs `npm ci` by default, so moving onto the blocks could add a
 * dependency install to every reconcile — real minutes, at roughly one run per merged
 * reviewed PR — and no other test would notice, because nothing it installs is used. So the
 * job's steps are resolved AS THEY RUN (each block call expanded, each block step whose
 * `if:` is statically false for the literal inputs the call passes dropped), and the
 * install is held absent there, not merely absent from the file.
 */
const FILE = '.github/workflows/agent-merge-reconcile.yml';
type Job = { steps: WorkflowStep[]; services?: unknown };
const doc = parse(readFileSync(FILE, 'utf8')) as { jobs: Record<string, Job> };
const job = doc.jobs.reconcile!;
const call = (block: string) => job.steps.find((s) => laneBlockOf(s) === block)!;
const INSTALL = /\bnpm (?:ci|install|i)\b/;

describe('merge-reconcile keeps its own job and calls every block', () => {
  it('calls agent-setup, agent-run and agent-finish, in that order', () => {
    expect((job as { uses?: string }).uses).toBeUndefined();
    // The three stages; `agent-classify` is reached through `agent-finish` (RA-2691).
    expect(job.steps.filter((s) => laneBlockOf(s)).map((s) => laneBlockOf(s))).toEqual([...STAGE_BLOCKS]);
  });

  it('writes the playbook excerpt as its own step, between the set-up and the agent', () => {
    const at = job.steps.findIndex((s) => String(s.run ?? '').includes('scripts/playbook-excerpt.mjs'));
    expect(at, 'no excerpt step in the job').toBeGreaterThan(-1);
    expect(blockOf(job.steps[at]!), 'the excerpt is the lane\'s, not a block\'s').toBeUndefined();
    expect(at).toBeGreaterThan(job.steps.indexOf(call('agent-setup')));
    expect(at).toBeLessThan(job.steps.indexOf(call('agent-run')));
  });
});

describe('it installs nothing, as it never did', () => {
  // SINCE RA-2694 THE INSTALL IS THE PROJECT-SETUP HOOK'S, and a lane that installs nothing
  // does not call the hook at all (Kanon plan 0001 §5). `agent-setup` has no install switch
  // left to pass 'false' to; the property is that this job reaches no install by any path.
  const HOOK = './.github/actions/project-setup';

  it('does not call the project-setup hook, nor check for it', () => {
    expect(job.steps.filter((s) => s.uses === HOOK)).toEqual([]);
    expect(job.steps.filter((s) => s.id === 'hook')).toEqual([]);
  });

  it('meets no install switch in agent-setup: the block holds no install to switch', () => {
    const setup = readBlock('agent-setup');
    expect(Object.keys(setup.inputs ?? {})).not.toContain('install');
    expect(Object.keys(setup.inputs ?? {})).not.toContain('npm-cache');
    expect(setup.runs.steps.filter((s) => INSTALL.test(String(s.run ?? '')) || String(s.uses ?? '').startsWith('actions/setup-node'))).toEqual([]);
    expect(call('agent-setup').with?.install).toBeUndefined();
  });

  it('runs no install step, no toolchain step, no database and no browser, as the job runs', () => {
    const steps = stepsAsRun(job.steps);
    expect(steps.some((s) => laneBlockOf(s)), 'the block calls were expanded').toBe(false);
    // Not vacuous: the agent step, from the run block, is there.
    expect(steps.some((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action'))).toBe(true);
    // No toolchain step either: the lane's scripts run on the runner's own Node, as every
    // step before the hook does on the other lanes (RA-2694).
    expect(steps.some((s) => String(s.uses ?? '').startsWith('actions/setup-node'))).toBe(false);
    expect(steps.filter((s) => INSTALL.test(String(s.run ?? ''))).map((s) => s.name ?? s.run)).toEqual([]);
    expect(steps.filter((s) => /db:init|playwright/.test(String(s.run ?? '')))).toEqual([]);
    expect(job.services).toBeUndefined();
  });

  it('would run the install if it called the hook — the resolver reads it, so the check above can fail', () => {
    const at = job.steps.indexOf(call('agent-setup'));
    const on = [...job.steps.slice(0, at), { uses: HOOK, with: { lane: 'merge-reconcile' } }, ...job.steps.slice(at)];
    expect(stepsAsRun(on).filter((s) => INSTALL.test(String(s.run ?? '')))).toHaveLength(1);
    expect(stepsAsRun(on).some((s) => String(s.uses ?? '').startsWith('actions/setup-node'))).toBe(true);
  });
});
