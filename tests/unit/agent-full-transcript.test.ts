import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { blockInputsFor, blockOf, effectiveSteps, readBlock, spineJobFor } from './helpers/spine.js';

/**
 * RA-2651 — the implementer's whole transcript goes to the job log, and only there.
 *
 * Silent implementer runs (`completed`, no push, no comment) could not be diagnosed,
 * because `claude-code-action` hides its output and the execution file is deleted with
 * the runner. The fix is one switch on the spine, which both implement lanes set. Two ways it
 * goes wrong silently: the
 * implement lane stops setting it (the next silent run is undiagnosable again), or the
 * spine stops passing it through (the input exists and does nothing).
 */
const REPO = process.cwd();
const WF = '.github/workflows';
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

type Step = { uses?: string; with?: Record<string, unknown> };
type Job = { uses?: string; with?: Record<string, unknown>; steps?: Step[] };
const jobs = (file: string) => (parse(read(join(WF, file))) as { jobs: Record<string, Job> }).jobs;
const agentStep = (job: Job) => job.steps?.find((s) => s.uses?.startsWith('anthropics/claude-code-action'));

describe('the implementer transcript reaches the job log', () => {
  it('the implement lane opts in', () => {
    expect(jobs('agent-implement.yml').implement!.with?.['full-transcript']).toBe(true);
  });

  it('the revise lane opts in too, because it stops silently the same way', () => {
    expect(jobs('agent-implement-revise.yml').revise!.with?.['full-transcript']).toBe(true);
  });

  it('the spine defaults it off and hands it to the action as show_full_output', () => {
    const lane = parse(read(join(WF, 'agent-lane.yml')));
    expect(lane.on.workflow_call.inputs['full-transcript']).toMatchObject({ type: 'boolean', default: false });
    // THROUGH THE RUN BLOCK (RA-2666): the action sits in `agent-run`, so the switch is two
    // hops — the spine hands its input to the block, the block hands its input to the
    // action — and both are asserted, or a dropped hop leaves an input that does nothing.
    const step = agentStep({ steps: effectiveSteps(lane.jobs.run.steps) });
    expect(step?.with?.show_full_output).toBe('${{ inputs.full-transcript }}');
    const call = blockOf(step as never)?.call;
    expect(call?.with?.['full-transcript']).toBe('${{ inputs.full-transcript }}');
    // The block's own default is off too, for a lane that calls it directly.
    expect(readBlock('agent-run').inputs?.['full-transcript']?.default).toBe('false');
  });

  it('reaches the action ON for the Implementer\'s two lanes only, of Kanon\'s lanes', () => {
    // What the action is actually handed, per lane: the block input the call evaluates
    // to. 'true' for the implement and revise lanes, which both stopped silently
    // (RA-2651), and 'false' for every other spine caller.
    const handed = (file: string, job: string) => {
      const { steps, inputs } = spineJobFor(jobs(file)[job] as never);
      const step = agentStep({ steps: steps as Step[] });
      return blockInputsFor(blockOf(step as never)!.call, inputs)['full-transcript'];
    };
    expect(handed('agent-implement.yml', 'implement')).toBe('true');
    expect(handed('agent-implement-revise.yml', 'revise')).toBe('true');
    for (const [file, job] of [['agent-triage.yml', 'triage-fix'], ['agent-lead-revise.yml', 'revise'], ['agent-lead.yml', 'brief']]) {
      expect(handed(file!, job!), `${file} prints a transcript it never opted into`).toBe('false');
    }
  });

  it('no workflow turns the action output on except through the spine', () => {
    // A lane that set `show_full_output` on its own agent step would bypass the switch
    // this file pins, so every mention outside the spine's one line is a failure.
    const walk = (dir: string): string[] =>
      readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const found: Record<string, number> = {};
    // Kanon's workflows and actions.
    for (const f of [...walk(WF), ...walk('actions')]) {
      const n = read(f).split('\n').filter((l) => /show_full_output/.test(l)).length;
      if (n) found[f.replace(/^\.github\//, '')] = n;
    }
    expect(found).toEqual({
      'workflows/agent-lane.yml': 1, // the input's description
      'actions/agent-run/action.yml': 2, // the block input's description, the with: line (RA-2666)
    });
  });
});
