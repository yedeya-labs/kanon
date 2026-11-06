import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * kanon#1667 (the class #1661 started): a step that runs one of Kanon's scripts after the
 * project-setup hook, in the same job, takes Kanon's Node by absolute path from the `kanon`
 * step's `node` output, and runs it as `"$KANON_NODE"`. The hook is the project's code and may
 * put another Node first on the `PATH` (`actions/kanon-path/action.yml`, kanon#761), so a bare
 * `node` there runs Kanon's script on whatever Node the project chose.
 *
 * The guard reads every workflow, so a new post-hook step can't go back to a bare `node`.
 */
type Step = { name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const DIR = join(process.cwd(), '.github/workflows');
/** The hook, as a lane calls it, or as a smoke calls a fixture's. */
const isHook = (s: Step) => /(^|\/)\.github\/actions\/project-setup$/.test(String(s.uses ?? ''));
/** A run that starts one of Kanon's scripts, by Kanon's path. */
const runsKanon = (run: string) => /\$(\{)?KANON(_ROOT)?(\})?\/scripts\//.test(run);
/** A `node` taken from the `PATH`: a command named `node`, or `command -v node`. */
const bareNode = (run: string) => /(^|[\s;&|(`])node\s/m.test(run) || /command -v node/.test(run);

/**
 * Steps exempt by name, each with why. Only a step that means to run the `PATH`'s Node.
 */
const EXEMPT: Record<string, string> = {
  // It proves that, after a project's hook, the Node on the `PATH` is still Kanon's (kanon#110), so it
  // has to run that Node, not the output's.
  "agent-blocks-smoke.yml smoke: Run Kanon's guards on the python fixture, on Kanon's pinned Node": 'checks the PATH Node itself',
};

/** Each step after a job's hook that runs a Kanon script, by `<file> <job>: <name>`. */
const postHookSteps = (files: Record<string, Workflow>) =>
  Object.entries(files).flatMap(([file, wf]) =>
    Object.entries(wf.jobs ?? {}).flatMap(([job, j]) => {
      const steps = j.steps ?? [];
      const hook = steps.findIndex(isHook);
      if (hook < 0) return [];
      return steps.slice(hook + 1).filter((s) => runsKanon(String(s.run ?? ''))).map((s) => ({ key: `${file} ${job}: ${s.name ?? s.id ?? ''}`, step: s }));
    }));

/** What is wrong with one such step; empty when it holds. */
const problems = (step: Step): string[] => {
  const run = String(step.run ?? '');
  const out: string[] = [];
  if (bareNode(run)) out.push('runs `node` from the PATH');
  if (!run.includes('"$KANON_NODE"')) out.push('does not run "$KANON_NODE"');
  if (step.env?.KANON_NODE !== '${{ steps.kanon.outputs.node }}') out.push("its env's KANON_NODE is not the kanon step's node output");
  const path = step.env?.KANON ?? step.env?.KANON_ROOT;
  if (path !== '${{ steps.kanon.outputs.path }}') out.push("its env's KANON is not the kanon step's path output");
  return out;
};

const WORKFLOWS: Record<string, Workflow> = Object.fromEntries(
  readdirSync(DIR).filter((f) => f.endsWith('.yml')).map((f) => [f, parse(readFileSync(join(DIR, f), 'utf8')) as Workflow]),
);

describe("a step after the project-setup hook runs Kanon's scripts on Kanon's Node (#1667)", () => {
  const found = postHookSteps(WORKFLOWS);

  it('finds the post-hook steps, so the check is not vacuous', () => {
    const keys = found.map((f) => f.key);
    for (const k of [
      "lane-agent-job.yml run: Create the lane's labels the repository lacks",
      "lane-agent-job.yml run: Put Kanon's scripts on the agent's PATH, by name",
      "lane-agent-job.yml run: Summarise the agent's run, without what its tools read or wrote",
      "explore-agent-job.yml explore: Check the sweep's summary",
      "explore-agent-job.yml explore: Create the lane's labels the repository lacks",
      'explore-agent-job.yml explore: Read what this run filed, for the telemetry row',
      "rebase-agent-job.yml resolve: Create the lane's labels the repository lacks",
      "lead-split-agent-job.yml split: Create the lane's labels the repository lacks",
      ...Object.keys(EXEMPT),
    ]) expect(keys, k).toContain(k);
  });

  it.each(postHookSteps(WORKFLOWS).filter((f) => !Object.hasOwn(EXEMPT, f.key)).map((f) => [f.key, f.step] as const))('%s', (_key, step) => {
    expect(problems(step)).toEqual([]);
  });

  it('exempts only steps that still exist', () => {
    for (const k of Object.keys(EXEMPT)) expect(found.map((f) => f.key)).toContain(k);
  });

  it('refuses a bare node, a missing env and a step that reads the PATH for Node', () => {
    const good: Step = { env: { KANON: '${{ steps.kanon.outputs.path }}', KANON_NODE: '${{ steps.kanon.outputs.node }}' }, run: '"$KANON_NODE" "$KANON/scripts/ensure-labels.mjs" x' };
    expect(problems(good)).toEqual([]);
    expect(problems({ ...good, run: 'node "$KANON/scripts/ensure-labels.mjs" x' })).toContain('runs `node` from the PATH');
    expect(problems({ ...good, run: 'set -e\n  node "$KANON/scripts/x.mjs"' })).toContain('runs `node` from the PATH');
    expect(problems({ ...good, run: `exec "$(command -v node)" "$KANON_ROOT/scripts/x.mjs"` })).toContain('runs `node` from the PATH');
    expect(problems({ ...good, env: { KANON: good.env!.KANON! } })).toContain("its env's KANON_NODE is not the kanon step's node output");
    expect(problems({ ...good, env: { KANON_NODE: good.env!.KANON_NODE! } })).toContain("its env's KANON is not the kanon step's path output");
    // Only a step after the hook, in the same job, is held.
    const wf = { 'x.yml': { jobs: { a: { steps: [{ run: 'node "$KANON/scripts/a.mjs"' }, { uses: './.github/actions/project-setup' }, { name: 'after', run: 'node "$KANON/scripts/b.mjs"' }] }, b: { steps: [{ run: 'node "$KANON/scripts/c.mjs"' }] } } } };
    expect(postHookSteps(wf).map((f) => f.key)).toEqual(['x.yml a: after']);
  });
});
