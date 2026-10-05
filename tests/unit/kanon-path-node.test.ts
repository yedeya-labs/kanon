import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { kanonActionRef, laneBlockOf } from './helpers/agent-lanes.mjs';

/**
 * kanon#110. Two things a lane needs from `actions/kanon-path` that no adopter's hook may be
 * relied on to supply:
 *
 * 1. KANON'S NODE, PINNED. Kanon's scripts run on the Node major its package.json declares.
 *    `kanon-path` installs it with `actions/setup-node`, pinned to an exact release of the
 *    action (Dependabot proposes each bump) and to that major. A floating spec would let the
 *    runner image, or the newest release on the day, choose the Node a guard runs on.
 * 2. `KANON` IN THE AGENT'S ENVIRONMENT. The prompts tell the agent to run
 *    `node "$KANON/…"`. Every agent step sets `KANON` itself, from the OUTPUT of a
 *    `kanon-path` step earlier in its job: an output is the runner's, so a project hook that
 *    rewrites `$GITHUB_ENV` cannot point the agent somewhere else, and a hook that never
 *    exports `KANON` (Kolophon's) leaves it set.
 *
 * Each check is a function, shown red on small fixtures first, so a check that cannot fail
 * shows up here rather than as a green run over clean files.
 */

type Step = { id?: string; uses?: unknown; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { steps?: Step[]; uses?: unknown };
type Workflow = { jobs?: Record<string, Job> };
type Action = { runs?: { steps?: Step[] } };

const y = <T>(text: string) => parse(text) as T;

const isKanonPath = (s: Step) => kanonActionRef(s.uses)?.name === 'kanon-path';
const isAgentStep = (s: Step) =>
  laneBlockOf(s) === 'agent-run' || (typeof s.uses === 'string' && s.uses.startsWith('anthropics/claude-code-action@'));

/** The engines major Kanon declares: `>=24` is 24. */
export const declaredMajor = (engines: unknown): string | undefined =>
  typeof engines === 'string' ? /^\s*>=?\s*(\d+)(?:\.\d+){0,2}\s*$/.exec(engines)?.[1] : undefined;

/** An exact release of an action: `v7.0.0` or a full commit SHA. A major tag (`v7`) moves. */
const EXACT_REF = /^(v\d+\.\d+\.\d+|[0-9a-f]{40})$/;

/**
 * What is wrong with how an action sets up Node, against the major Kanon declares: no
 * `setup-node` step, an action ref that moves, a Node spec that floats, or `check-latest`.
 */
export const nodePinProblems = (action: Action, major: string | undefined): string[] => {
  if (!major) return ['package.json declares no Node major in engines.node'];
  const steps = (action.runs?.steps ?? []).filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'));
  if (steps.length !== 1) return [`expected one actions/setup-node step, found ${steps.length}`];
  const step = steps[0]!;
  const problems: string[] = [];
  const ref = String(step.uses).slice(String(step.uses).indexOf('@') + 1);
  if (!EXACT_REF.test(ref)) problems.push(`actions/setup-node@${ref} is not an exact release`);
  const w = step.with ?? {};
  if ('node-version-file' in w) problems.push('node-version-file reads the workspace, which is the adopter\'s');
  const version = w['node-version'];
  if (String(version ?? '') !== major) problems.push(`node-version is ${JSON.stringify(version)}, not "${major}"`);
  if (w['check-latest'] === true || w['check-latest'] === 'true') problems.push('check-latest floats the version');
  return problems;
};

/**
 * The agent steps of a workflow that do not take `KANON` from the output of a `kanon-path`
 * step earlier in the same job, as `job: step` strings.
 */
export const agentStepsWithoutKanon = (doc: Workflow): string[] =>
  Object.entries(doc.jobs ?? {}).flatMap(([job, j]) => {
    const steps = j.steps ?? [];
    return steps.flatMap((s, i) => {
      if (!isAgentStep(s)) return [];
      const ids = steps.slice(0, i).filter(isKanonPath).map((k) => k.id).filter((id): id is string => !!id);
      const value = s.env?.KANON;
      const ok = ids.some((id) => value === `\${{ steps.${id}.outputs.path }}`);
      return ok ? [] : [`${job}: ${s.id ?? String(s.uses)}`];
    });
  });

describe('kanon-path sets up Kanon\'s Node, pinned (kanon#110)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines?: { node?: string } };
  const major = declaredMajor(pkg.engines?.node);
  const action = y<Action>(readFileSync('actions/kanon-path/action.yml', 'utf8'));
  const pinned = (uses: string, w: string) =>
    y<Action>(`runs:\n  steps:\n    - uses: ${uses}\n      with:\n${w}\n    - run: echo`);

  it('reads the major from engines', () => {
    expect(major).toBe('24');
    expect(declaredMajor('>=24')).toBe('24');
    expect(declaredMajor('^24')).toBeUndefined();
    expect(declaredMajor(undefined)).toBeUndefined();
  });

  it('accepts an exact action release and the declared major', () => {
    expect(nodePinProblems(pinned('actions/setup-node@v7.0.0', '        node-version: "24"'), '24')).toEqual([]);
    expect(nodePinProblems(pinned(`actions/setup-node@${'a'.repeat(40)}`, '        node-version: "24"'), '24')).toEqual([]);
  });

  it.each([
    ['a major tag', 'actions/setup-node@v7', '        node-version: "24"'],
    ['a branch', 'actions/setup-node@main', '        node-version: "24"'],
    ['lts/*', 'actions/setup-node@v7.0.0', '        node-version: lts/*'],
    ['latest', 'actions/setup-node@v7.0.0', '        node-version: latest'],
    ['a range', 'actions/setup-node@v7.0.0', '        node-version: ">=24"'],
    ['24.x', 'actions/setup-node@v7.0.0', '        node-version: 24.x'],
    ['another major', 'actions/setup-node@v7.0.0', '        node-version: "22"'],
    ['no version at all', 'actions/setup-node@v7.0.0', '        cache: ""'],
    ['the workspace\'s version file', 'actions/setup-node@v7.0.0', '        node-version-file: .nvmrc'],
    ['check-latest', 'actions/setup-node@v7.0.0', '        node-version: "24"\n        check-latest: true'],
  ])('fails on %s', (_, uses, w) => {
    expect(nodePinProblems(pinned(uses, w), '24')).not.toEqual([]);
  });

  it('fails when there is no setup-node step', () => {
    expect(nodePinProblems(y<Action>('runs:\n  steps:\n    - run: echo'), '24')).not.toEqual([]);
  });

  it('holds for actions/kanon-path', () => {
    expect(nodePinProblems(action, major)).toEqual([]);
  });
});

describe('every lane\'s agent step has KANON from kanon-path (kanon#110)', () => {
  const lane = (agentEnv: string, before = '      - uses: $/actions/kanon-path\n        id: kanon\n') =>
    y<Workflow>(`jobs:\n  run:\n    steps:\n${before}      - uses: $/actions/agent-run\n        id: agent\n${agentEnv}        with:\n          prompt: x\n`);
  const ENV = '        env:\n          KANON: ${{ steps.kanon.outputs.path }}\n';

  it('accepts the shape every lane takes', () => {
    expect(agentStepsWithoutKanon(lane(ENV))).toEqual([]);
  });

  it.each([
    ['no env', lane('')],
    ['KANON from the job environment', lane('        env:\n          KANON: ${{ env.KANON }}\n')],
    ['a kanon-path step with no id', lane(ENV, '      - uses: $/actions/kanon-path\n')],
    ['no kanon-path step', lane(ENV, '')],
    ['kanon-path after the agent', y<Workflow>(`jobs:\n  run:\n    steps:\n      - uses: $/actions/agent-run\n${ENV}      - uses: $/actions/kanon-path\n        id: kanon\n`)],
    ['a kanon-path step in another job', y<Workflow>(`jobs:\n  a:\n    steps:\n      - uses: $/actions/kanon-path\n        id: kanon\n  b:\n    steps:\n      - uses: $/actions/agent-run\n${ENV}`)],
    ['claude-code-action called directly', y<Workflow>(`jobs:\n  run:\n    steps:\n      - uses: anthropics/claude-code-action@v1.0.239\n`)],
  ])('fails on %s', (_, doc) => {
    expect(agentStepsWithoutKanon(doc)).toHaveLength(1);
  });

  const dir = '.github/workflows';
  const workflows = readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => ({ f, doc: y<Workflow>(readFileSync(join(dir, f), 'utf8')) }));
  const lanes = workflows.filter(({ doc }) => Object.values(doc.jobs ?? {}).some((j) => (j.steps ?? []).some(isAgentStep)));

  it('finds the spine and every direct-block lane, so the walk is not vacuous', () => {
    expect(lanes.map(({ f }) => f)).toEqual(expect.arrayContaining([
      'lane-agent-job.yml', 'lead-split-agent-job.yml', 'merge-reconcile-agent-job.yml', 'rebase-agent-job.yml',
      'review-agent-job.yml', 'verify-acs-agent-job.yml', 'explore-agent-job.yml', 'code-audit-agent-job.yml', 'overseer-agent-job.yml',
    ]));
  });

  it('holds for every agent step in every workflow', () => {
    expect(workflows.flatMap(({ f, doc }) => agentStepsWithoutKanon(doc).map((x) => `${f} ${x}`))).toEqual([]);
  });
});
