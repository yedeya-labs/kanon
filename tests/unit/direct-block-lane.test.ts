import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STAGE_BLOCKS, agentJobsIn, laneBlockOf, localActionRef, resolvedAgentJobs } from './helpers/agent-lanes.mjs';
import { blockOf, effectiveSteps, readAction, readBlock } from './helpers/spine.js';
import { agentStep, telemetryStep, type WorkflowStep } from './helpers/workflow-step.js';

/**
 * RA-2669 — a lane that keeps its own job and calls the agent-lane BLOCKS directly.
 *
 * KANON'S HALF (plan 0001, step 2): the resolver's reading of that shape, on the fixture lane,
 * and the rule that every block call in Kanon's workflows is a Kanon reference. The scanners
 * the reference adopter points at the same fixture stay there with the scanners (plan §6).
 *
 * WHY IT MATTERS. A direct lane's job holds no `claude-code-action` step and no
 * `agent-telemetry` step: both are inside the blocks. A resolver that read a job as its
 * file says would return a SHORTER list, which is not an error anywhere: a clean run with
 * less to say.
 */
const FIXTURE = 'tests/fixtures/agent-direct-lane.yml';
const JOB = 'fixture';
const ARM = 'direct-fixture';
type Job = { steps: WorkflowStep[]; permissions?: Record<string, string> };
const doc = parse(readFileSync(FIXTURE, 'utf8')) as { jobs: Record<string, Job>; permissions?: Record<string, string> };
const job = doc.jobs[JOB]!;
const call = (block: string) => job.steps.find((s) => laneBlockOf(s) === block)!;
const ARGS = String(call('agent-run').with?.claude_args);

describe('the fixture is the shape a direct lane takes', () => {
  it('keeps its own job, calls every block, and has steps of its own between them', () => {
    expect((job as { uses?: string }).uses).toBeUndefined();
    // Every STAGE; the fourth block, `agent-classify`, is called by `agent-finish` (RA-2691).
    expect(job.steps.filter((s) => laneBlockOf(s)).map((s) => laneBlockOf(s))).toEqual([...STAGE_BLOCKS]);
    const at = (block: string) => job.steps.indexOf(call(block));
    const own = job.steps.map((s, i) => (!laneBlockOf(s) && s.run ? i : -1)).filter((i) => i >= 0);
    expect(own.some((i) => i > at('agent-setup') && i < at('agent-run')), 'a step of its own before the agent').toBe(true);
    expect(own.some((i) => i > at('agent-run') && i < at('agent-finish')), 'and one after it').toBe(true);
    // As a file, it holds neither step a pre-RA-2669 scanner looked for.
    expect(agentStep(job.steps)).toBeUndefined();
    expect(telemetryStep(job.steps)).toBeUndefined();
  });
});

describe('agent-lanes.mjs — the shared resolver', () => {
  it('reads the arm off the block calls, with no reader — as every CI scanner calls it', () => {
    expect(resolvedAgentJobs(doc)).toEqual([
      { job: JOB, via: 'step', agent: ARM, claudeArgs: ARGS, prompt: 'Work the fixture issue.', id: 'agent', spine: undefined },
    ]);
  });

  it('gives the same answer with a reader as without one', () => {
    expect(agentJobsIn(doc, { readAction })).toEqual(agentJobsIn(doc));
  });

  it('reports the id the JOB reads, whatever the lane calls its run step', () => {
    // Inside the block the action's id is `agent`; the job can only read the CALL's.
    const renamed = { jobs: { x: { steps: job.steps.map((s) => (s === call('agent-run') ? { ...s, id: 'run-agent' } : s)) } } };
    expect(agentJobsIn(renamed).map((e: { id?: string }) => e.id)).toEqual(['run-agent']);
    expect(agentJobsIn(renamed, { readAction }).map((e: { id?: string }) => e.id)).toEqual(['run-agent']);
    const anonymous = { jobs: { x: { steps: job.steps.map((s) => (s === call('agent-run') ? { ...s, id: undefined } : s)) } } };
    expect(agentJobsIn(anonymous).map((e: { id?: string }) => e.id)).toEqual([undefined]);
    expect(agentJobsIn(anonymous, { readAction }).map((e: { id?: string }) => e.id)).toEqual([undefined]);
  });

  it('gives the same answer with a reader as without one on every workflow in Kanon', () => {
    const dir = '.github/workflows';
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
    expect(files).toEqual(expect.arrayContaining(['agent-lane.yml', 'agent-triage.yml', 'agent-implement-revise.yml', 'agent-lead-revise.yml']));
    for (const f of files) {
      const d = parse(readFileSync(join(dir, f), 'utf8'));
      expect(agentJobsIn(d), f).toEqual(agentJobsIn(d, { readAction }));
    }
  });
});

describe('telemetry and classification — the lane is measured and explained as a spine lane is', () => {
  const steps = effectiveSteps(job.steps);
  const agent = agentStep(steps)!;
  const t = telemetryStep(steps)!;

  it('records the run under the lane\'s arm, with the flags that ran', () => {
    expect(t, 'no telemetry step in the job as it runs').toBeDefined();
    expect(t.with?.agent).toBe(ARM);
    expect(t.with?.claude_args).toBe(agent.with?.claude_args);
    expect(readBlock('agent-run').outputs?.execution_file?.value).toBe('${{ steps.agent.outputs.execution_file }}');
    expect(t.with?.execution_file).toBe(`\${{ steps.${call('agent-run').id}.outputs.execution_file }}`);
  });

  it('measures a failed run and can never red a good one', () => {
    const finish = call('agent-finish');
    expect(finish.if).toBe('always()');
    expect(finish['continue-on-error']).toBe(true);
    expect(t.if).toBe('always()');
    expect(t['continue-on-error']).toBe(true);
  });

  it('classifies a red run under the lane\'s arm, from the job status it is handed', () => {
    const classify = steps.find((s) => /classify-agent-result\.mjs" "\$@"/.test(String(s.run)))!;
    expect(classify, 'no classifier in the job as it runs').toBeDefined();
    expect(String(classify.run)).toContain('set -- --arm "$ARM"');
    // Two calls deep (RA-2691): the lane's `agent-finish` call, then that block's call to
    // `agent-classify`, which carries the gate.
    const nested = blockOf(classify)?.call;
    expect(blockOf(classify)?.block).toBe('agent-classify');
    expect(blockOf(nested!)?.block).toBe('agent-finish');
    expect(blockOf(nested!)?.call).toBe(call('agent-finish'));
    expect(classify.env?.ARM, 'the arm, substituted through both calls').toBe('direct-block fixture');
    expect(nested?.if).toBe("inputs.classify == 'true' && inputs.job-status == 'failure'");
    expect(call('agent-finish').with?.['job-status']).toBe('${{ job.status }}');
    expect(call('agent-finish').with?.classify).toBeUndefined();
    expect(readBlock('agent-finish').inputs?.classify?.default).toBe('true');
  });
});

/**
 * THE ONE RULE A LANE AUTHOR COULD MISS SILENTLY: the blocks are never read from the
 * workspace. Every block call is a Kanon reference, read from the runner's action cache: `$/`
 * inside Kanon, `yedeya-labs/kanon/actions/<name>@<tag>` from an adopter. One `./` call would
 * bring back the hazard the load, reload and tamper machinery answered (plan 0001 §2), with
 * none of that machinery.
 */
/** Every job in Kanon's workflows that calls a stage block itself, plus the fixture's. */
const blockJobs: [string, WorkflowStep[]][] = [
  ...readdirSync('.github/workflows').filter((f) => f.endsWith('.yml')).flatMap((f) => {
    const d = parse(readFileSync(join('.github/workflows', f), 'utf8'));
    return Object.entries<{ steps?: WorkflowStep[] }>(d?.jobs ?? {})
      .filter(([, j]) => (j?.steps ?? []).some((s) => STAGE_BLOCKS.includes(String(laneBlockOf(s)))))
      .map(([j, def]) => [`${f}:${j}`, def.steps!] as [string, WorkflowStep[]]);
  }),
  [`${FIXTURE}:${JOB}`, job.steps],
];

describe('every job that calls a block calls it from Kanon, and carries nothing to put it back', () => {
  const jobs = blockJobs;

  it('finds the spine, the direct-block lanes, the blocks smoke and the fixture, so this is not vacuous', () => {
    expect(jobs.map(([w]) => w).sort()).toEqual([
      'agent-blocks-smoke.yml:smoke', 'explore-agent-job.yml:explore', 'lane-agent-job.yml:run', 'merge-reconcile-agent-job.yml:reconcile',
      'agent-project-digest.yml:digest', 'agent-weekly-digest.yml:digest', 'code-audit-agent-job.yml:audit', 'overseer-agent-job.yml:overseer',
      'explore-telemetry-agent-job.yml:explore', 'lead-split-agent-job.yml:split', 'rebase-agent-job.yml:resolve', 'review-agent-job.yml:review', 'verify-acs-agent-job.yml:verify', `${FIXTURE}:${JOB}`,
    ].sort());
  });

  it.each(jobs.filter(([w]) => !w.startsWith('agent-blocks-smoke')))('%s', (_where, steps) => {
    const blocks = steps.filter((s) => laneBlockOf(s));
    expect(blocks.filter((s) => STAGE_BLOCKS.includes(String(laneBlockOf(s)))).map((s) => laneBlockOf(s))).toEqual([...STAGE_BLOCKS]);
    for (const s of blocks) expect(localActionRef(s.uses)?.form, String(s.uses)).toBe('kanon');
    expect(steps.find((s) => s.id === 'blocks'), 'a load step is back').toBeUndefined();
    expect(steps.find((s) => laneBlockOf(s) === 'agent-run')!.with ?? {}).not.toHaveProperty('restore-paths');
    expect(steps.filter((s) => /\.github\/actions\/agent-/.test(String(s.run ?? ''))).map((s) => s.name)).toEqual([]);
  });
});

/**
 * RA-2685 — a direct lane with a gate of its own holds every block call to that gate.
 *
 * If a gated lane leaves a block call on its own, a declined run still mints, installs or
 * runs the agent, or `agent-finish` writes a `not-reached` telemetry row for a run that
 * never tried — polluting the cost series every comparison keys on. A lane-specific test
 * held `agent-lead-split.yml` to this; nothing held the NEXT gated direct lane to it.
 *
 * THE GATE IS READ, NOT NAMED. A job's gate is the `if:` on its first gated
 * `agent-setup`/`agent-run` call. Then: both calls carry every conjunct of it, and
 * `agent-finish` is exactly `always() && <gate>`. With no gate, neither call carries an
 * `if:` and `agent-finish` is exactly `always()`.
 */
describe('a gated direct lane holds every block call, agent-finish included, to its gate', () => {
  const cond = (s: WorkflowStep | undefined): string | undefined => {
    const raw = s?.if;
    if (raw === undefined || raw === null) return undefined;
    return String(raw).trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
  };
  const conjuncts = (c: string | undefined): string[] => (c ? c.split(/\s+&&\s+/).map((x) => x.trim()) : []);

  /** The violations in one job's block calls; empty means it is held to its gate. */
  const misGated = (steps: WorkflowStep[]): string[] => {
    const at = (block: string) => steps.find((s) => laneBlockOf(s) === block);
    const setup = cond(at('agent-setup'));
    const run = cond(at('agent-run'));
    const finish = cond(at('agent-finish'));
    const gate = setup ?? run;
    const out: string[] = [];
    if (gate === undefined) {
      if (finish !== 'always()') out.push(`ungated, so agent-finish must be exactly always(), not ${finish}`);
      return out;
    }
    for (const [block, c] of [['agent-setup', setup], ['agent-run', run]] as const) {
      const missing = conjuncts(gate).filter((g) => !conjuncts(c).includes(g));
      if (missing.length) out.push(`${block} does not carry the gate: ${missing.join(' && ')}`);
    }
    if (finish !== `always() && ${gate}`) out.push(`agent-finish must be "always() && ${gate}", not ${finish}`);
    return out;
  };

  // The blocks smoke is a harness, not a lane: its `agent-run` is held off with
  // `github.run_id == '0'` so the smoke exercises setup and finish without spending a
  // run. That is the one deliberate exception, and it is named rather than inferred.
  const lanes = blockJobs.filter(([w]) => !w.startsWith('agent-blocks-smoke.yml:'));

  it('finds gated lanes and ungated ones, so neither branch is vacuous', () => {
    const gated = lanes.filter(([, steps]) => cond(steps.find((s) => laneBlockOf(s) === 'agent-setup')) !== undefined);
    expect(gated.map(([w]) => w)).toEqual(expect.arrayContaining(['lead-split-agent-job.yml:split', 'review-agent-job.yml:review']));
    expect(lanes.length - gated.length).toBeGreaterThan(0);
  });

  it.each(lanes)('%s', (_where, steps) => {
    expect(misGated(steps)).toEqual([]);
  });

  it('reds a gated lane whose agent-finish dropped the gate, or whose agent-run did', () => {
    const [, split] = lanes.find(([w]) => w === 'lead-split-agent-job.yml:split')!;
    const swap = (block: string, ifValue: string | undefined) =>
      split.map((s) => (laneBlockOf(s) === block ? { ...s, if: ifValue } : s));
    expect(misGated(swap('agent-finish', 'always()'))).not.toEqual([]);
    expect(misGated(swap('agent-run', undefined))).not.toEqual([]);
    expect(misGated(swap('agent-setup', undefined))).not.toEqual([]);
    // An ungated lane that gates its agent-run alone: setup still installs for a declined run.
    expect(misGated(job.steps.map((s) => (laneBlockOf(s) === 'agent-run' ? { ...s, if: "x == 'y'" } : s))))
      .not.toEqual([]);
    // And an ungated lane that grows a condition on agent-finish alone.
    expect(misGated(job.steps.map((s) => (laneBlockOf(s) === 'agent-finish' ? { ...s, if: "always() && x == 'y'" } : s))))
      .not.toEqual([]);
  });
});
