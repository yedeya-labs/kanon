import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * kanon#274: no job that runs an agent, the project's code, or a pull request's code holds an
 * App's private key.
 *
 * WHY THE JOB, NOT THE STEP. Step order inside a job is not a boundary an agent with a shell
 * respects. The runner's action cache is writable by the job's user, and a node action's post
 * step is handed its inputs again: `create-github-app-token`'s post step runs at job end, after
 * the agent, from a script the agent could have rewritten, with the key as `INPUT_PRIVATE-KEY`
 * (measured on a hosted runner, with a placeholder, in #274). The job's user also has `sudo`
 * and the `docker` group there. So a rule like "mint before the agent" would pass and protect
 * nothing; the rule is that the key is not referenced by the job at all.
 *
 * WHAT COUNTS AS RUNNING SOMEONE ELSE'S CODE:
 *   • the agent: Kanon's `agent-run` block, or `claude-code-action` called directly;
 *   • a `./` action: the project's own code from the checkout (the project-setup hook);
 *   • a checkout with a `ref:`: a branch other than the triggering commit (a PR's head). The
 *     default branch by name is not one: it is merged code (the Merger's job checks it out).
 *
 * KNOWN EXCEPTIONS, each until its lane is fixed (#279). The five lanes that call the blocks
 * directly still mint in the agent's job. They are listed by `file:job`, and the list must be
 * exact: a lane that is fixed fails here until its row is removed, so the list cannot outlive
 * the debt it records.
 */

const WF = '.github/workflows';
const KNOWN_EXCEPTIONS: Record<string, string> = {
  'agent-review.yml:review': '#279',
  'agent-rebase.yml:resolve': '#279',
  'agent-lead-split.yml:split': '#279',
  'agent-merge-reconcile.yml:reconcile': '#279',
  'agent-verify-acs.yml:verify': '#279',
};

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { uses?: string; needs?: string | string[]; if?: string; with?: Record<string, unknown>; secrets?: Record<string, unknown> | string; steps?: Step[]; outputs?: Record<string, string> };
type Workflow = { on?: { workflow_call?: { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> } }; jobs?: Record<string, Job> };

const read = (f: string) => parse(readFileSync(join(WF, f), 'utf8')) as Workflow;
const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f)).sort();

/** A reference to an App private key: `secrets.X_PRIVATE_KEY`, `secrets.app-private-key`, or a computed `secrets[…PRIVATE_KEY…]`. */
const KEY = /secrets\s*(?:\.\s*[\w-]*private[-_]key\b|\[[^\]]*private[-_]key[^\]]*\])/i;
const holdsKey = (job: Job): boolean => KEY.test(JSON.stringify(job));

const isAgent = (s: Step) => /(^|\/)actions\/agent-run(@|$)/.test(String(s.uses ?? '')) || String(s.uses ?? '').startsWith('anthropics/claude-code-action');
const isLocal = (s: Step) => String(s.uses ?? '').startsWith('./');
/** The default branch is merged, reviewed code: the Merger checks it out by name to run Kanon's scripts on it. */
const DEFAULT_BRANCH = /^\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}$/;
const isRefCheckout = (s: Step) => String(s.uses ?? '').startsWith('actions/checkout@')
  && String(s.with?.ref ?? '') !== '' && !DEFAULT_BRANCH.test(String(s.with?.ref));
/** Why a job runs code other than Kanon's and the job's own, or `undefined` when it runs none. */
const runsOthersCode = (job: Job): string | undefined => {
  const steps = job.steps ?? [];
  if (steps.some(isAgent)) return 'runs the agent';
  const local = steps.find(isLocal);
  if (local) return `runs \`${local.uses}\` from the checkout`;
  if (steps.some(isRefCheckout)) return 'checks out a ref other than the triggering commit';
  return undefined;
};

/** Every `file:job` that both holds a key and runs someone else's code, with why. */
const violations = (docs: Record<string, Workflow>): Record<string, string> =>
  Object.fromEntries(Object.entries(docs).flatMap(([f, doc]) => Object.entries(doc.jobs ?? {}).flatMap(([name, job]) => {
    const why = runsOthersCode(job);
    return why && holdsKey(job) ? [[`${f}:${name}`, why] as const] : [];
  })));

const docs = Object.fromEntries(files.map((f) => [f, read(f)]));

describe('kanon#274: no job that runs an agent or project code holds an App private key', () => {
  it('finds the jobs it is about, so the check is not vacuous', () => {
    const running = Object.entries(docs).flatMap(([f, d]) => Object.entries(d.jobs ?? {}).filter(([, j]) => runsOthersCode(j)).map(([n]) => `${f}:${n}`));
    expect(running).toEqual(expect.arrayContaining(['lane-agent-job.yml:run', ...Object.keys(KNOWN_EXCEPTIONS)]));
    const keyed = Object.entries(docs).flatMap(([f, d]) => Object.entries(d.jobs ?? {}).filter(([, j]) => holdsKey(j)).map(([n]) => `${f}:${n}`));
    expect(keyed).toEqual(expect.arrayContaining(['agent-lane.yml:mint', 'apps-check.yml:check']));
  });

  it('holds for every job, apart from the known exceptions, which are exact', () => {
    expect(Object.keys(violations(docs)).sort()).toEqual(Object.keys(KNOWN_EXCEPTIONS).sort());
  });

  it("the spine's agent job declares no key it could be handed", () => {
    const job = docs['lane-agent-job.yml']!;
    expect(Object.keys(job.on?.workflow_call?.secrets ?? {}).sort()).toEqual(['app-token', 'claude-token']);
    expect(KEY.test(readFileSync(join(WF, 'lane-agent-job.yml'), 'utf8'))).toBe(false);
  });
});

describe('the spine mints in a job of its own and hands the agent\'s job the token (kanon#274)', () => {
  const spine = docs['agent-lane.yml']!;
  const { mint, run } = spine.jobs as { mint: Job; run: Job };
  const agentJob = docs['lane-agent-job.yml']!;
  const steps = agentJob.jobs!.run!.steps!;

  it('has exactly the two jobs, and the key reaches only the mint', () => {
    expect(Object.keys(spine.jobs ?? {}).sort()).toEqual(['mint', 'run']);
    expect(holdsKey(mint)).toBe(true);
    expect(holdsKey(run)).toBe(false);
    expect(runsOthersCode(mint)).toBeUndefined();
  });

  it('the mint runs only the mint and the seal, and leaves the revoke to the agent\'s job', () => {
    expect(mint.steps!.map((s) => s.uses ?? s.id)).toEqual(['actions/create-github-app-token@v3', 'seal']);
    expect(String(mint.steps![0]!.with?.['skip-token-revoke'])).toBe('true');
    expect(mint.outputs?.sealed).toBe('${{ steps.seal.outputs.sealed }}');
  });

  it('hands the token through the call\'s `secrets:`, the one channel that arrives masked', () => {
    expect(run.uses).toBe('$/.github/workflows/lane-agent-job.yml');
    expect(run.needs).toBe('mint');
    // A failed mint still reaches the agent's job, so the run is recorded as `token=failure`.
    expect(run.if).toMatch(/!cancelled\(\)/);
    expect(run.secrets).toEqual({ 'app-token': '${{ needs.mint.outputs.sealed }}', 'claude-token': '${{ secrets.claude-token }}' });
    // Never as an input: an input is printed in a step's header.
    expect(JSON.stringify(run.with)).not.toMatch(/sealed|token/);
  });

  it('passes every other input through unchanged, under its own name', () => {
    const spineInputs = Object.keys(spine.on!.workflow_call!.inputs!).filter((k) => !k.startsWith('permission-'));
    const jobInputs = Object.keys(agentJob.on!.workflow_call!.inputs!);
    expect(jobInputs.sort()).toEqual([...spineInputs, 'app-slug'].sort());
    for (const k of spineInputs) expect(run.with?.[k], k).toBe(`\${{ inputs.${k} }}`);
    expect(run.with?.['app-slug']).toBe('${{ needs.mint.outputs.app-slug }}');
  });

  it('masks the token in the step that first holds it, before writing it to an output', () => {
    const receive = steps.find((s) => s.id === 'app-token')!;
    expect(receive.env?.SEALED).toBe('${{ secrets.app-token }}');
    const script = String(receive.run);
    expect(script.indexOf('::add-mask::$TOKEN')).toBeGreaterThan(-1);
    expect(script.indexOf('::add-mask::$TOKEN')).toBeLessThan(script.indexOf('token=$TOKEN'));
    // Before the checkout, which persists the token as the push credential.
    expect(steps.indexOf(receive)).toBeLessThan(steps.findIndex((s) => String(s.uses).startsWith('actions/checkout@')));
  });

  it('revokes the token as its last step, whatever happened before', () => {
    const last = steps.at(-1)!;
    expect(last.name).toBe('Revoke the App token');
    expect(last.if).toMatch(/^always\(\)/);
    expect(String(last.run)).toContain('/installation/token');
  });
});

describe('the check catches what it is for', () => {
  const agent: Step = { uses: '$/actions/agent-run' };
  const mint: Step = { uses: 'actions/create-github-app-token@v3', with: { 'private-key': '${{ secrets.LEAD_APP_PRIVATE_KEY }}' } };

  it('a mint in the agent\'s job, before or after the agent', () => {
    expect(violations({ 'x.yml': { jobs: { a: { steps: [mint, agent] }, b: { steps: [agent, mint] } } } })).toEqual({ 'x.yml:a': 'runs the agent', 'x.yml:b': 'runs the agent' });
  });

  it('an agent called without the block, and the block at a pinned release', () => {
    for (const uses of ['anthropics/claude-code-action@v1.0.239', 'yedeya-labs/kanon/actions/agent-run@v1.2.3']) {
      expect(Object.keys(violations({ 'x.yml': { jobs: { a: { steps: [mint, { uses }] } } } })), uses).toEqual(['x.yml:a']);
    }
  });

  it('every spelling of the key: a dash, a computed name, a reusable workflow\'s own secret', () => {
    for (const k of ['${{ secrets.app-private-key }}', "${{ secrets[format('{0}_APP_PRIVATE_KEY', matrix.app)] }}", '${{ secrets.Reviewer_App_Private_Key }}']) {
      expect(holdsKey({ steps: [{ uses: 'x', with: { 'private-key': k } }] }), k).toBe(true);
    }
    expect(holdsKey({ steps: [{ uses: 'x', with: { token: '${{ secrets.claude-token }}' } }] })).toBe(false);
  });

  it('the key in a step\'s env, the job\'s env, or a reusable call\'s secrets', () => {
    const run = { run: 'true', env: { K: '${{ secrets.EXPLORER_APP_PRIVATE_KEY }}' } };
    expect(Object.keys(violations({ 'x.yml': { jobs: { a: { steps: [agent, run] } } } }))).toEqual(['x.yml:a']);
    expect(Object.keys(violations({ 'x.yml': { jobs: { a: { env: { K: '${{ secrets.X_PRIVATE_KEY }}' }, steps: [agent] } as Job } } }))).toEqual(['x.yml:a']);
  });

  it('project code and a PR checkout, as well as the agent', () => {
    expect(violations({ 'x.yml': { jobs: {
      hook: { steps: [mint, { uses: './.github/actions/project-setup' }] },
      pr: { steps: [mint, { uses: 'actions/checkout@v7', with: { ref: '${{ inputs.ref }}' } }] },
      plain: { steps: [mint, { uses: 'actions/checkout@v7' }] },
      main: { steps: [mint, { uses: 'actions/checkout@v7', with: { ref: '${{ github.event.repository.default_branch }}' } }] },
    } } })).toEqual({ 'x.yml:hook': 'runs `./.github/actions/project-setup` from the checkout', 'x.yml:pr': 'checks out a ref other than the triggering commit' });
  });
});
