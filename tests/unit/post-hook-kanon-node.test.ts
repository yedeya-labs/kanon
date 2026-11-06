import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * kanon#1676 (the composite-action half of #1667's class): a Kanon composite action that runs after
 * a project's setup hook starts its own scripts on Kanon's Node, not the `node` the hook left on the
 * `PATH`. A composite action can't read its caller's step outputs, so it takes the Node as an
 * input, `node`, which defaults to `node` from the `PATH`, and every lane that calls it after the
 * hook passes the kanon step's `node` output (`actions/kanon-path/action.yml`, kanon#761).
 *
 * kanon#1667 holds the lane steps themselves: a step that runs one of Kanon's scripts after the hook
 * takes `KANON_NODE` and `KANON` from the kanon step's outputs and runs `"$KANON_NODE"`.
 */
type Step = { name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Action = { inputs?: Record<string, { default?: string; required?: boolean }>; runs?: { steps?: Step[] } };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const ROOT = process.cwd();
const isHook = (s: Step) => /(^|\/)\.github\/actions\/project-setup$/.test(String(s.uses ?? ''));
const ACTION_PATH = String.raw`(?:\$GITHUB_ACTION_PATH|\$\{\{ github\.action_path \}\})`;
/** A Node script of the action's own, started by the action's path. */
const runsOwnScript = (run: string) => new RegExp(`${ACTION_PATH}/[\\w.-]+\\.mjs`).test(run);
/** A shell script of the action's own, which may start Node itself, by its name. */
const ownShellScripts = (run: string) => [...run.matchAll(new RegExp(`${ACTION_PATH}/([\\w.-]+\\.sh)`, 'g'))].map((m) => m[1]!);
const bareNode = (run: string) => /(^|[\s;&|(`])node\s/m.test(run) || /command -v node/.test(run);

const ACTIONS: Record<string, Action> = Object.fromEntries(
  readdirSync(join(ROOT, 'actions'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'actions', d.name, 'action.yml')))
    .map((d) => [d.name, parse(readFileSync(join(ROOT, 'actions', d.name, 'action.yml'), 'utf8')) as Action]),
);
/** The actions that take Kanon's Node as an input. */
const TAKES_NODE = Object.keys(ACTIONS).filter((a) => ACTIONS[a]!.inputs?.node !== undefined).sort();
/** The name of a `$/actions/<name>` (or a released) reference to one of them, or null. */
const nodeAction = (uses: string | undefined) => {
  const m = /(?:^\$|yedeya-labs\/kanon)\/actions\/([\w-]+)(?:@\S+)?$/.exec(String(uses ?? ''));
  return m && TAKES_NODE.includes(m[1]!) ? m[1]! : null;
};

/** A script's lines with its comments dropped. */
const code = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** What is wrong with an action that takes the input; empty when it holds. `shell` reads a script beside it. */
const actionProblems = (action: Action, shell: (file: string) => string = () => ''): string[] => {
  const out: string[] = [];
  const input = action.inputs?.node;
  if (input?.default !== 'node' || input.required === true) out.push('its `node` input is not optional with the default `node`');
  for (const s of action.runs?.steps ?? []) {
    const run = String(s.run ?? '');
    if (runsOwnScript(run)) {
      if (bareNode(run)) out.push(`${s.name ?? s.id ?? 'a step'}: starts its script with node from the PATH`);
      if (!run.includes('"$KANON_NODE"') || s.env?.KANON_NODE !== '${{ inputs.node }}') out.push(`${s.name ?? s.id ?? 'a step'}: does not run "$KANON_NODE" from its node input`);
    }
    // A shell script of its own starts no bare node, and one that starts Kanon's gets the input by
    // environment. A script that starts no Node at all needs neither.
    for (const sh of ownShellScripts(run)) {
      const text = code(shell(sh));
      if (bareNode(text)) out.push(`${sh}: starts node from the PATH`);
      if (text.includes('KANON_NODE') && s.env?.KANON_NODE !== '${{ inputs.node }}') out.push(`${s.name ?? s.id ?? 'a step'}: runs ${sh} without its node input in KANON_NODE`);
    }
    // A nested call of one that takes it passes this action's own on.
    if (nodeAction(s.uses) && s.with?.node !== '${{ inputs.node }}') out.push(`${s.uses}: not passed this action's node`);
  }
  return out;
};

/** Each lane's post-hook call of an action that takes the input, by `<file> <job>: <uses>`. */
const postHookCalls = (files: Record<string, Workflow>) =>
  Object.entries(files).flatMap(([file, wf]) =>
    Object.entries(wf.jobs ?? {}).flatMap(([job, j]) => {
      const steps = j.steps ?? [];
      const hook = steps.findIndex(isHook);
      if (hook < 0) return [];
      return steps.slice(hook + 1).filter((s) => nodeAction(s.uses)).map((s) => ({ key: `${file} ${job}: ${nodeAction(s.uses)}`, step: s }));
    }));

/** Does an action start a script of its own: a Node script, or a shell script beside it? */
const startsScripts = (action: Action) => (action.runs?.steps ?? []).some((s) => runsOwnScript(String(s.run ?? '')) || ownShellScripts(String(s.run ?? '')).length > 0);
/**
 * Does an action start Node in any way (kanon#1681)? A step whose `run` calls `node` (an action-path
 * script, a script under `$KANON/scripts/`, an inline `-e`, or anything else) or already runs
 * `"$KANON_NODE"`; a shell script beside it that does; or a nested call of another action that does.
 * `shell` reads a script beside the action.
 */
const startsNode = (name: string, shell: (action: string, file: string) => string, actions: Record<string, Action> = ACTIONS, seen = new Set<string>()): boolean => {
  const action = actions[name];
  if (!action || seen.has(name)) return false;
  seen.add(name);
  return (action.runs?.steps ?? []).some((s) => {
    const run = String(s.run ?? '');
    if (bareNode(run) || run.includes('"$KANON_NODE"')) return true;
    if (ownShellScripts(run).some((sh) => { const text = code(shell(name, sh)); return bareNode(text) || text.includes('KANON_NODE'); })) return true;
    const nested = /^\$\/actions\/([\w-]+)$/.exec(String(s.uses ?? ''))?.[1];
    return nested ? startsNode(nested, shell, actions, seen) : false;
  });
};
const besideAction = (action: string, file: string) => { try { return readFileSync(join(ROOT, 'actions', action, file), 'utf8'); } catch { return ''; } };

/** Every `$/actions/<name>` a lane calls after its hook, by name. */
const calledAfterHook = (files: Record<string, Workflow>) => [...new Set(Object.values(files).flatMap((wf) =>
  Object.values(wf.jobs ?? {}).flatMap((j) => {
    const steps = j.steps ?? [];
    const hook = steps.findIndex(isHook);
    return hook < 0 ? [] : steps.slice(hook + 1).flatMap((st) => /^\$\/actions\/([\w-]+)$/.exec(String(st.uses ?? ''))?.[1] ?? []);
  })))].sort();

/** The actions lanes call after their hook that start Node and don't take the input. */
const owedWithoutInput = (files: Record<string, Workflow>, actions: Record<string, Action> = ACTIONS, shell = besideAction) =>
  calledAfterHook(files).filter((a) => startsNode(a, shell, actions) && actions[a]?.inputs?.node === undefined);

const WORKFLOWS: Record<string, Workflow> = Object.fromEntries(
  readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).map((f) => [f, parse(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')) as Workflow]),
);

/** A run that starts one of Kanon's scripts, by Kanon's path (#1667). */
const runsKanon = (run: string) => /\$(\{)?KANON(_ROOT)?(\})?\/scripts\//.test(run);

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

describe("Kanon's composite actions after the project-setup hook run on Kanon's Node (#1676)", () => {
  it('every action a lane calls after the hook that starts Node in any way takes the input (#1681)', () => {
    expect(owedWithoutInput(WORKFLOWS)).toEqual([]);
    const owed = calledAfterHook(WORKFLOWS).filter((a) => startsNode(a, besideAction));
    // A floor, so the derivation above can't pass on an empty list.
    expect(owed).toEqual(expect.arrayContaining(['agent-classify', 'agent-finish', 'agent-run', 'agent-setup']));
    // `implementer-status` runs after no hook today; it takes the input all the same.
    expect(TAKES_NODE).toEqual(expect.arrayContaining(['agent-telemetry', 'implementer-status']));
  });

  it.each(TAKES_NODE)('%s runs its scripts on its node input, and passes it on', (name) => {
    expect(actionProblems(ACTIONS[name]!, (f) => readFileSync(join(ROOT, 'actions', name, f), 'utf8'))).toEqual([]);
  });

  it('finds the lanes that call one after the hook, so the check is not vacuous', () => {
    const keys = postHookCalls(WORKFLOWS).map((c) => c.key);
    for (const k of ['lane-agent-job.yml run: agent-run', 'lane-agent-job.yml run: agent-finish', 'explore-agent-job.yml explore: agent-run', 'rebase-agent-job.yml resolve: agent-finish', 'lead-split-agent-job.yml split: agent-run', 'agent-blocks-smoke.yml smoke: agent-classify']) {
      expect(keys, k).toContain(k);
    }
  });

  it.each(postHookCalls(WORKFLOWS).map((c) => [c.key, c.step] as const))('%s passes the kanon step\'s node', (_key, step) => {
    expect(step.with?.node).toBe('${{ steps.kanon.outputs.node }}');
  });

  it('refuses a bare node, a script not on the input, a required input and a nested call without it', () => {
    const good: Action = { inputs: { node: { default: 'node', required: false } }, runs: { steps: [{ name: 's', env: { KANON_NODE: '${{ inputs.node }}' }, run: '"$KANON_NODE" "$GITHUB_ACTION_PATH/x.mjs"' }] } };
    expect(actionProblems(good)).toEqual([]);
    const step = (s: Partial<Step>): Action => ({ ...good, runs: { steps: [{ ...good.runs!.steps![0]!, ...s }] } });
    expect(actionProblems(step({ run: 'node "$GITHUB_ACTION_PATH/x.mjs"' }))).toContain('s: starts its script with node from the PATH');
    expect(actionProblems(step({ run: 'set -e\n  node "${{ github.action_path }}/x.mjs"' }))).toContain('s: starts its script with node from the PATH');
    expect(actionProblems(step({ env: {} }))).toContain('s: does not run "$KANON_NODE" from its node input');
    expect(actionProblems({ ...good, inputs: { node: { default: 'node', required: true } } })).toContain('its `node` input is not optional with the default `node`');
    expect(actionProblems({ ...good, runs: { steps: [{ uses: '$/actions/agent-classify', with: {} }] } })).toContain("$/actions/agent-classify: not passed this action's node");
    // A shell script beside it: the input by environment, and no bare node in the script's code.
    const sh: Action = { ...good, runs: { steps: [{ name: 'c', env: { KANON_NODE: '${{ inputs.node }}' }, run: 'bash "$GITHUB_ACTION_PATH/x.sh"' }] } };
    expect(actionProblems(sh, () => '# node in a comment\n"${KANON_NODE:-node}" -e 1\n')).toEqual([]);
    expect(actionProblems(sh, () => 'x="$(node -e 1)"\n')).toContain('x.sh: starts node from the PATH');
    expect(actionProblems({ ...sh, runs: { steps: [{ ...sh.runs!.steps![0]!, env: {} }] } }, () => '"${KANON_NODE:-node}" -e 1')).toContain('c: runs x.sh without its node input in KANON_NODE');
    expect(actionProblems({ ...sh, runs: { steps: [{ ...sh.runs!.steps![0]!, env: {} }] } }, () => 'echo nothing to start')).toEqual([]);
    expect(startsScripts(sh)).toBe(true);
    expect(startsScripts({ runs: { steps: [{ run: 'echo hi' }] } })).toBe(false);
    expect(calledAfterHook({ 'x.yml': { jobs: { a: { steps: [{ uses: '$/actions/agent-run' }, { uses: './.github/actions/project-setup' }, { uses: '$/actions/agent-setup' }] } } } })).toEqual(['agent-setup']);
    // #1681: Node started other than by the action's own script line counts too.
    const after = (name: string) => ({ 'x.yml': { jobs: { a: { steps: [{ uses: './.github/actions/project-setup' }, { uses: `$/actions/${name}` }] } } } });
    // The real brief-guard runs `node "$KANON/scripts/brief-guard.mjs"`, and takes no input.
    expect(owedWithoutInput(after('brief-guard'))).toEqual(['brief-guard']);
    const fake: Record<string, Action> = {
      inline: { runs: { steps: [{ run: 'echo "$(node -e 1)"' }] } },
      kanon: { runs: { steps: [{ run: 'node "$KANON/scripts/x.mjs"' }] } },
      outer: { runs: { steps: [{ uses: '$/actions/inline' }] } },
      shell: { runs: { steps: [{ run: 'bash "$GITHUB_ACTION_PATH/s.sh"' }] } },
      quiet: { runs: { steps: [{ run: 'echo hi' }, { uses: 'actions/upload-artifact@v7' }] } },
      taken: { inputs: { node: { default: 'node' } }, runs: { steps: [{ run: 'node -e 1' }] } },
    };
    const besideFake = (_a: string, f: string) => (f === 's.sh' ? 'x="$(node -e 1)"' : '');
    for (const n of ['inline', 'kanon', 'outer', 'shell']) expect(owedWithoutInput(after(n), fake, besideFake), n).toEqual([n]);
    for (const n of ['quiet', 'taken']) expect(owedWithoutInput(after(n), fake, besideFake), n).toEqual([]);
    // Only a call after the hook, in the same job, is held.
    const wf = { 'x.yml': { jobs: { a: { steps: [{ uses: '$/actions/agent-run' }, { uses: './.github/actions/project-setup' }, { uses: '$/actions/agent-finish' }] }, b: { steps: [{ uses: '$/actions/agent-run' }] } } } };
    expect(postHookCalls(wf).map((c) => c.key)).toEqual(['x.yml a: agent-finish']);
  });
});
