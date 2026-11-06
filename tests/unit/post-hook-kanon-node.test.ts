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
/** Every `$/actions/<name>` a lane calls after its hook, by name. */
const calledAfterHook = (files: Record<string, Workflow>) => [...new Set(Object.values(files).flatMap((wf) =>
  Object.values(wf.jobs ?? {}).flatMap((j) => {
    const steps = j.steps ?? [];
    const hook = steps.findIndex(isHook);
    return hook < 0 ? [] : steps.slice(hook + 1).flatMap((st) => /^\$\/actions\/([\w-]+)$/.exec(String(st.uses ?? ''))?.[1] ?? []);
  })))].sort();

const WORKFLOWS: Record<string, Workflow> = Object.fromEntries(
  readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).map((f) => [f, parse(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')) as Workflow]),
);

describe("Kanon's composite actions after the project-setup hook run on Kanon's Node (#1676)", () => {
  it('every action a lane calls after the hook that starts a script of its own takes the input', () => {
    const owed = calledAfterHook(WORKFLOWS).filter((a) => ACTIONS[a] && startsScripts(ACTIONS[a]!));
    expect(owed.filter((a) => !TAKES_NODE.includes(a))).toEqual([]);
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
    // Only a call after the hook, in the same job, is held.
    const wf = { 'x.yml': { jobs: { a: { steps: [{ uses: '$/actions/agent-run' }, { uses: './.github/actions/project-setup' }, { uses: '$/actions/agent-finish' }] }, b: { steps: [{ uses: '$/actions/agent-run' }] } } } };
    expect(postHookCalls(wf).map((c) => c.key)).toEqual(['x.yml a: agent-finish']);
  });
});
