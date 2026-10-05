import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { blockInputsFor, blockOf, callsSpine, effectiveSteps, laneBlockOf, readBlock, readSpine, spineJobFor } from './helpers/spine.js';

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
    // The steps are the spine's agent job's since kanon#274 (`readSpine` joins the two files).
    const step = agentStep({ steps: effectiveSteps(readSpine().jobs.run.steps) });
    expect(step?.with?.show_full_output).toBe('${{ inputs.full-transcript }}');
    const call = blockOf(step as never)?.call;
    expect(call?.with?.['full-transcript']).toBe('${{ inputs.full-transcript }}');
    // The block's own default is off too, for a lane that calls it directly.
    expect(readBlock('agent-run').inputs?.['full-transcript']?.default).toBe('false');
  });

  // EVERY CALLER OF `agent-run`, DISCOVERED (RA-2688): a job that calls the spine, and a
  // job that calls the `agent-run` block itself. A hand-written list of spine callers
  // left the direct-block lanes unresolved, so one of them setting `full-transcript: true`
  // stayed green — and direct-block lanes are added regularly.
  type Caller = { where: string; via: 'spine' | 'direct'; def: Job };
  const callers: Caller[] = readdirSync(join(REPO, WF)).filter((f) => f.endsWith('.yml')).sort().flatMap((file) =>
    Object.entries(jobs(file)).flatMap(([job, def]): Caller[] => {
      if (callsSpine(def as never)) return [{ where: `${file}:${job}`, via: 'spine' as const, def }];
      // The spine forwards its caller's input, through its agent's job (`lane-agent-job.yml`,
      // kanon#274); both are resolved per caller above.
      if (file === 'agent-lane.yml' || file === 'lane-agent-job.yml') return [];
      if ((def.steps ?? []).some((s) => laneBlockOf(s as never) === 'agent-run')) {
        return [{ where: `${file}:${job}`, via: 'direct' as const, def }];
      }
      return [];
    }));

  // What the action is actually handed, per job: the `agent-run` block input its call
  // evaluates to. A direct-block job has no job-level `with:`; its own call's `with:` is
  // resolved against no caller inputs, so an `${{ inputs.x }}` it passes stays a template
  // and never reads as 'false'.
  const handed = ({ via, def }: Caller): unknown => {
    if (via === 'spine') {
      const { steps, inputs } = spineJobFor(def as never);
      const step = agentStep({ steps: steps as Step[] });
      return blockInputsFor(blockOf(step as never)!.call, inputs)['full-transcript'];
    }
    const call = def.steps!.find((s) => laneBlockOf(s as never) === 'agent-run')!;
    return blockInputsFor(call as never, {})['full-transcript'];
  };

  it('finds the spine callers and the direct-block lanes, so the check is not vacuous', () => {
    const where = (via: string) => callers.filter((c) => c.via === via).map((c) => c.where);
    expect(where('spine')).toEqual(expect.arrayContaining([
      'agent-implement.yml:implement', 'agent-implement-revise.yml:revise',
      'agent-triage.yml:triage-fix', 'agent-lead-revise.yml:revise', 'agent-lead.yml:brief',
    ]));
    expect(where('direct')).toEqual(expect.arrayContaining([
      'agent-lead-split.yml:split', 'agent-merge-reconcile.yml:reconcile', 'agent-rebase.yml:resolve',
    ]));
    // And the direct-block resolution reads the call, rather than reporting the default.
    const optIn = { steps: [{ uses: '$/actions/agent-run', with: { 'full-transcript': true } }] };
    expect(handed({ where: 'x', via: 'direct', def: optIn })).toBe('true');
  });

  it('reaches the action ON for the Implementer\'s two lanes only, of every caller of agent-run', () => {
    // 'true' for the implement and revise lanes, which both stopped silently (RA-2651),
    // and 'false' for every other caller, through the spine or not.
    const on = callers.filter((c) => handed(c) !== 'false').map((c) => `${c.where}=${String(handed(c))}`);
    expect(on).toEqual(['agent-implement-revise.yml:revise=true', 'agent-implement.yml:implement=true']);
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
      'workflows/lane-agent-job.yml': 1, // the same input, passed through to the agent's job (kanon#274)
      'actions/agent-run/action.yml': 2, // the block input's description, the with: line (RA-2666)
    });
  });
});
