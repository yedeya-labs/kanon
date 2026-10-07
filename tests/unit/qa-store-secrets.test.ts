import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { evaluate, interpolate, mask, stepHeader, type Contexts } from './helpers/expression.js';
import { STORE_SECRETS, STORE_SECRETS_WITH } from './helpers/store-jobs.js';

/**
 * kanon#433: the QA store's coordinates never reach a public log.
 *
 * The runner prints a `uses:` step's evaluated `with:`, and every step's evaluated `env:`, at the
 * head of its log, and masks only secrets. So this follows one store operation down the chain
 * the way the runner evaluates it: a lane's store step, the `qa-store` block's hook step, the
 * hook (Kanon's own, and the template docs/qa-store.md gives an adopter), and the AWS action it
 * calls. At each step it renders the header as the runner prints it (`stepHeader`, which masks
 * every secret's value wherever it appears), and the role ARN, the bucket and the account id
 * they carry must appear in none of them, while the AWS action still receives both.
 */

type Step = { uses?: string; id?: string; name?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Action = { inputs?: Record<string, { default?: string }>; runs: { steps: Step[] } };

// Built, never written: the public-tree guard refuses a literal twelve-digit account id.
const ACCOUNT = ['123456', '789012'].join('');
const ARN = `arn:aws:iam::${ACCOUNT}:role/kanon-qa-store`;
const BUCKET = `kanon-qa-store-${ACCOUNT}-eu-central-1`;
const LANES = ['agent-code-audit', 'agent-explore', 'agent-dispatch-sweep', 'agent-overseer'];

const yaml = <T>(path: string) => parse(readFileSync(path, 'utf8')) as T;
const BLOCK = yaml<Action>('actions/qa-store/action.yml');
const AWS = yaml<Action>('infra/qa-store/aws/action.yml');
const KANON_HOOK = yaml<Action>('.github/actions/qa-store/action.yml');
const TEMPLATE_HOOK = parse(readFileSync('docs/qa-store.md', 'utf8').split('Then write the hook')[1]!.split('```yaml\n')[1]!.split('```')[0]!) as Action;

/** Every store step of the four store-coupled lanes, with where it is. */
const storeSteps = LANES.flatMap((lane) => Object.entries(yaml<{ jobs: Record<string, { steps?: Step[] }> }>(`.github/workflows/${lane}.yml`).jobs)
  .flatMap(([job, j]) => (j.steps ?? []).filter((s) => s.uses === '$/actions/qa-store' && s.with?.operation !== 'delete-export').map((s) => ({ at: `${lane}:${job}:${String(s.with?.operation)}`, step: s }))));

/** An action's inputs: its declared defaults, then what the caller's `with:` gave. */
const inputsOf = (action: Action, given: Record<string, string>) => ({
  ...Object.fromEntries(Object.entries(action.inputs ?? {}).map(([k, v]) => [k, v.default ?? ''])),
  ...given,
});

/**
 * One store operation, from the lane's store step to the AWS action, with the repository's
 * variables and the secrets the caller mapped. Returns every header the runner prints, masked,
 * and what the AWS action received.
 */
const chain = (step: Step, hook: Action, vars: Record<string, string>, secrets: Record<string, string>) => {
  const printed: string[] = [];
  const unmasked: string[] = [];
  const run = (s: Step, ctx: Contexts) => {
    const h = stepHeader(s, ctx, secrets);
    printed.push(h.printed);
    unmasked.push(h.unmasked);
    return h;
  };
  const lane = run(step, { vars, secrets, github: { sha: 'f'.repeat(40), event_name: 'schedule', run_id: 1 }, runner: { temp: '/tmp' }, inputs: {} });
  const blockInputs = inputsOf(BLOCK, lane.inputs);
  const hookStep = BLOCK.runs.steps.find((s) => s.uses === './.github/actions/qa-store')!;
  const toHook = run(hookStep, { inputs: blockInputs, steps: { prepare: { outputs: { dir: '/tmp/store', from: '', to: '' } } } });
  const hookInputs = inputsOf(hook, toHook.inputs);
  let aws: Record<string, string> = {};
  let check: Record<string, string> = {};
  for (const s of hook.runs.steps) {
    const h = run(s, { inputs: hookInputs });
    if (s.uses?.includes('infra/qa-store/aws')) aws = h.inputs;
    else check = h.env;
  }
  for (const s of AWS.runs.steps) run(s, { inputs: inputsOf(AWS, aws) });
  return { printed, unmasked, aws, check };
};

const leaks = (lines: string[]) => lines.filter((l) => l.includes(ACCOUNT) || l.includes(ARN) || l.includes(BUCKET));

describe('the QA store\'s coordinates reach no log once they are secrets (#433)', () => {
  const SECRETS = { QA_STORE_ROLE_ARN: ARN, QA_STORE_BUCKET: BUCKET };

  it('finds the eight store steps, each handing the block the two secrets by name', () => {
    expect(storeSteps.map((s) => s.at)).toHaveLength(8);
    for (const { at, step } of storeSteps) expect(step.with?.secrets, at).toBe(STORE_SECRETS_WITH);
    for (const lane of LANES) {
      const declared = yaml<{ on: { workflow_call: { secrets: Record<string, { required: boolean }> } } }>(`.github/workflows/${lane}.yml`).on.workflow_call.secrets;
      for (const n of STORE_SECRETS) expect(declared[n], `${lane}: ${n}`).toEqual({ required: false });
    }
  });

  for (const [name, hook] of [['Kanon\'s hook', KANON_HOOK], ['the template hook', TEMPLATE_HOOK]] as const) {
    describe(name, () => {
      it.each(storeSteps.map((s) => [s.at, s.step] as const))('%s: prints neither, and the AWS action receives both', (_, step) => {
        // The worst case of the move: the secrets are set and mapped, and the variables still exist.
        const c = chain(step, hook, { QA_STORE_ROLE_ARN: ARN, QA_STORE_BUCKET: BUCKET, OTHER: 'x' }, SECRETS);
        expect(leaks(c.printed)).toEqual([]);
        expect(c.aws['role-arn']).toBe(ARN);
        expect(c.aws.bucket).toBe(BUCKET);
        // Not vacuous: unmasked, the same headers hold both.
        expect(leaks(c.unmasked).length).toBeGreaterThan(0);
      });

      it('reads the secrets, not the variables, when both are set', () => {
        const c = chain(storeSteps[0]!.step, hook, { QA_STORE_ROLE_ARN: `arn:aws:iam::${'9'.repeat(12)}:role/old`, QA_STORE_BUCKET: 'old' }, SECRETS);
        expect([c.aws['role-arn'], c.aws.bucket]).toEqual([ARN, BUCKET]);
      });

      // #479: the variables path is gone. With the secrets unmapped and the old variables still
      // set, the hook gets no coordinates, and no header prints the variables, masked or not.
      it.each(storeSteps.map((s) => [s.at, s.step] as const))('%s: never reads or prints the variables, even with the secrets unmapped (#479)', (_, step) => {
        const c = chain(step, hook, { QA_STORE_ROLE_ARN: ARN, QA_STORE_BUCKET: BUCKET, OTHER: 'x' }, {});
        expect([c.aws['role-arn'], c.aws.bucket]).toEqual(['', '']);
        expect(leaks(c.unmasked)).toEqual([]);
      });
    });
  }

  it('declares no `variables` input in either hook, and Kanon\'s fails by name without the secrets (#479)', () => {
    for (const hook of [KANON_HOOK, TEMPLATE_HOOK]) expect(Object.keys(hook.inputs ?? {})).toEqual(['operation', 'kind', 'dir', 'from', 'to', 'secrets']);
    const without = chain(storeSteps[0]!.step, KANON_HOOK, { QA_STORE_ROLE_ARN: ARN, QA_STORE_BUCKET: BUCKET }, {});
    expect(without.check).toEqual({ ROLE_ARN: '', BUCKET: '' });
    const run = String(KANON_HOOK.runs.steps[0]!.run);
    expect(run).toContain('if [ -z "$ROLE_ARN" ] || [ -z "$BUCKET" ]; then');
    expect(run).toContain('exit 1');
  });
});

// #480: the maintenance workflow takes the store's role as the secret the documented caller maps,
// and so never prints it. #479: the secret is required, and the deprecated `role-arn` input is gone.
describe('the QA store maintenance workflow and its documented caller (#480)', () => {
  type Input = { type?: string; required?: boolean; default?: unknown };
  type Workflow = { on: { workflow_call: { inputs: Record<string, Input>; secrets?: Record<string, unknown> } }; jobs: Record<string, { steps: Step[] }> };
  type Caller = { on: { workflow_dispatch: { inputs: Record<string, Input> } }; jobs: Record<string, { uses: string; with?: Record<string, unknown>; secrets?: Record<string, unknown> }> };
  const WF = yaml<Workflow>('.github/workflows/qa-store-aws-maintenance.yml');
  const DOC = parse(readFileSync('docs/qa-store.md', 'utf8').split('### Maintenance')[1]!.split('```yaml\n')[1]!.split('```')[0]!) as Caller;
  const call = WF.on.workflow_call;
  const job = DOC.jobs.maintenance!;
  const step = WF.jobs.maintenance!.steps.find((x) => x.uses === '$/infra/qa-store/aws/maintenance')!;

  /** The maintenance step's header, called as `callerJob` calls it with `repo` the repository's secrets. */
  const header = (callerJob: Caller['jobs'][string], repo: Record<string, string>) => {
    const dispatched = Object.fromEntries(Object.entries(DOC.on.workflow_dispatch.inputs).map(([k, v]) => [k, v.default]));
    const given = Object.fromEntries(Object.entries(callerJob.with ?? {}).map(([k, v]) => [k, interpolate(v, { inputs: dispatched })]));
    const inputs = Object.fromEntries(Object.entries(call.inputs).map(([k, v]) => {
      const raw = k in given ? given[k] : v.default ?? '';
      return [k, v.type === 'boolean' ? raw === true || raw === 'true' : raw];
    }));
    // A called workflow sees only the secrets its caller maps.
    const secrets = Object.fromEntries(Object.entries(callerJob.secrets ?? {}).map(([k, v]) => [k, interpolate(v, { secrets: repo })]));
    return stepHeader(step, { inputs, secrets }, secrets);
  };

  it('declares the secret required and every input the caller passes, and the caller passes every required one', () => {
    expect(job.uses).toMatch(/^yedeya-labs\/kanon\/\.github\/workflows\/qa-store-aws-maintenance\.yml@v\d+\.\d+\.\d+$/);
    expect(call.secrets?.QA_STORE_ROLE_ARN).toMatchObject({ required: true });
    expect(Object.keys(call.secrets ?? {})).toEqual(['QA_STORE_ROLE_ARN']);
    // GitHub refuses a call that maps a secret, or passes an input, the called workflow doesn't declare.
    expect(Object.keys(job.secrets ?? {}).filter((n) => !(n in (call.secrets ?? {})))).toEqual([]);
    expect(Object.keys(job.with ?? {}).filter((k) => !(k in call.inputs))).toEqual([]);
    expect(Object.entries(call.inputs).filter(([k, v]) => v.required && !(k in (job.with ?? {}))).map(([k]) => k)).toEqual([]);
    expect(Object.keys(job.secrets ?? {})).toEqual(['QA_STORE_ROLE_ARN']);
    expect(job.with).not.toHaveProperty('role-arn');
  });

  it('hands the documented caller\'s secret to the step as its role, and the log masks it', () => {
    const h = header(job, { QA_STORE_ROLE_ARN: ARN });
    expect(h.inputs['role-arn']).toBe(ARN);
    expect(h.printed).not.toContain(ACCOUNT);
    expect(h.printed).toContain('role-arn: ***');
  });

  it('takes the role from the secret alone: no `role-arn` input, which printed it (#479)', () => {
    expect(Object.keys(call.inputs).sort()).toEqual(['apply', 'region', 'table', 'task']);
    expect(step.with?.['role-arn']).toBe('${{ secrets.QA_STORE_ROLE_ARN }}');
  });
});

describe('the expression fake behaves as the runner does', () => {
  it('builds the JSON the store step passes, and reads it back', () => {
    const json = interpolate(STORE_SECRETS_WITH, { secrets: { QA_STORE_ROLE_ARN: ARN, QA_STORE_BUCKET: '' } });
    expect(JSON.parse(json)).toEqual({ QA_STORE_ROLE_ARN: ARN, QA_STORE_BUCKET: '' });
    expect(evaluate("fromJSON(inputs.secrets || '{}').QA_STORE_BUCKET || fromJSON(inputs.variables || '{}').QA_STORE_BUCKET", { inputs: { secrets: json, variables: '{"QA_STORE_BUCKET":"b"}' } })).toBe('b');
    expect(evaluate("fromJSON(inputs.secrets || '{}').X != ''", { inputs: { secrets: '' } })).toBe(false);
  });
  it('masks every occurrence of a secret, and nothing else', () => {
    expect(mask(`a ${ARN} b "${ARN}"`, { R: ARN, E: '' })).toBe('a *** b "***"');
  });
  it('throws on a construct it does not model', () => {
    expect(() => evaluate('contains(github.ref, 1)', { github: {} })).toThrow(/not modelled/);
    expect(() => evaluate('vars.X', {})).toThrow(/not given/);
  });
});
