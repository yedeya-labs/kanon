import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { accountMasks } from '../../actions/qa-store/qa-store.mjs';
import { interpolate, mask } from './helpers/expression.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * kanon#488: a store job's log never shows the AWS account id, not even in an AWS error.
 *
 * The runner masks each secret as a whole value, so the role ARN and the bucket print as `***`
 * (#433). But an AWS error names the account in other strings, the assumed role's `sts` ARN and
 * the table's ARN, which are not those values. So every path a store job takes registers the
 * account id with `::add-mask::` before it can reach AWS: the `qa-store` block (every adopter's
 * store job runs it), the hook (Kanon's own, and the template in docs/qa-store.md), and the
 * maintenance action, which no block precedes. Each is run here for real, and its output is fed,
 * with AWS-style errors, through a fake of the runner's log masking.
 */

type Step = { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Action = { runs: { steps: Step[] } };

// Built, never written: the public-tree guard refuses a literal twelve-digit account id.
const ACCOUNT = ['210987', '654321'].join('');
const ARN = `arn:aws:iam::${ACCOUNT}:role/kanon-qa-store`;
const BUCKET = `kanon-qa-store-${ACCOUNT}-eu-central-1`;
const SECRETS = { QA_STORE_ROLE_ARN: ARN, QA_STORE_BUCKET: BUCKET };
const SECRETS_JSON = JSON.stringify(SECRETS);
const TWELVE = /(?<!\d)\d{12}(?!\d)/;

/** What the AWS CLI prints on stderr when the store's role is refused (the issue's examples). */
const SESSION = `arn:aws:sts::${ACCOUNT}:assumed-role/kanon-qa-store/GitHubActions`;
const AWS_ERRORS = [
  `An error occurred (AccessDeniedException) when calling the PutItem operation: User: ${SESSION} is not authorized to perform: dynamodb:PutItem on resource: arn:aws:dynamodb:eu-central-1:${ACCOUNT}:table/kanon-qa-store because no identity-based policy allows the dynamodb:PutItem action`,
  `upload failed: report.json to s3://${BUCKET}/explorer/20261007T120000Z.json An error occurred (AccessDenied) when calling the PutObject operation: User: ${SESSION} is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::${BUCKET}/explorer/20261007T120000Z.json"`,
  `An error occurred (AccessDenied) when calling the GetCallerIdentity operation: account ${ACCOUNT} denied`,
];

/**
 * The runner's log, as GitHub writes it: a `::add-mask::` line registers a value and prints
 * nothing; every other line is printed with each secret, and each registered value, replaced.
 */
const runnerLog = (lines: string[], secrets: Record<string, string>) => {
  const masks: Record<string, string> = { ...secrets };
  const out: string[] = [];
  for (const line of lines) {
    const m = /^::add-mask::(.*)$/.exec(line);
    if (m) masks[`added${Object.keys(masks).length}`] = m[1]!;
    else out.push(mask(line, masks));
  }
  return out.join('\n');
};

const lines = (s: string) => s.split('\n').filter(Boolean);
const yaml = (p: string) => parse(readFileSync(p, 'utf8')) as Action;
const MASK_STEP = 'Mask the store\'s account id';

/** Run a composite `bash` step as the runner does: `bash --noprofile --norc -eo pipefail`. */
const runBash = (step: Step, ctx: Record<string, unknown>) => {
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, interpolate(v, ctx)]));
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', String(step.run)], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};

const runBlockMask = (secretsJson: string) => {
  const r = spawnSync(process.execPath, ['actions/qa-store/qa-store.mjs', 'mask'], { env: { ...process.env, STORE_SECRETS: secretsJson }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};

/** Each masking route: what it prints before AWS is reached, given the store's secrets. */
const ROUTES: Array<[string, () => string]> = [
  ['the qa-store block', () => runBlockMask(SECRETS_JSON)],
  ['Kanon\'s hook', () => runBash(yaml('.github/actions/qa-store/action.yml').runs.steps[0]!, { inputs: { secrets: SECRETS_JSON } })],
  ['the template hook', () => runBash(templateHook().runs.steps[0]!, { inputs: { secrets: SECRETS_JSON } })],
  ['the maintenance action', () => runBash(yaml('infra/qa-store/aws/maintenance/action.yml').runs.steps[0]!, { inputs: { 'role-arn': ARN } })],
];

function templateHook(): Action {
  return parse(readFileSync('docs/qa-store.md', 'utf8').split('Then write the hook')[1]!.split('```yaml\n')[1]!.split('```')[0]!) as Action;
}

// Its cases run the store's scripts in `bash` against a stub `aws`, so the block takes the spawn budget (#436).
describe('the store\'s account id never reaches the log through an AWS error (#488)', SPAWNS, () => {
  it('is not vacuous: masking the secrets whole leaves the account id in every error', () => {
    for (const e of AWS_ERRORS) expect(runnerLog([e], SECRETS)).toMatch(TWELVE);
  });

  it.each(ROUTES)('%s masks it before AWS prints an error', (_, route) => {
    const printed = route();
    expect(lines(printed)).toEqual([`::add-mask::${ACCOUNT}`]);
    const log = runnerLog([...lines(printed), ...AWS_ERRORS], SECRETS);
    expect(log).not.toMatch(TWELVE);
    // The error itself still reads: only the account id is gone.
    expect(log).toContain('is not authorized to perform: dynamodb:PutItem on resource: arn:aws:dynamodb:eu-central-1:***:table/kanon-qa-store');
  });

  it('masks first: before the hook in the block, before the AWS action in each hook, before the credentials in the maintenance action', () => {
    const block = yaml('actions/qa-store/action.yml').runs.steps;
    expect(block[0]).toMatchObject({ name: MASK_STEP, if: 'inputs.operation != \'delete-export\'', env: { STORE_SECRETS: '${{ inputs.secrets }}' } });
    expect(block[0]!.run?.trim()).toBe('node "$GITHUB_ACTION_PATH/qa-store.mjs" mask');
    for (const hook of [yaml('.github/actions/qa-store/action.yml'), templateHook()]) {
      expect(hook.runs.steps[0]!.name).toBe(MASK_STEP);
      expect(hook.runs.steps.findIndex((s) => s.uses?.includes('infra/qa-store/aws'))).toBeGreaterThan(0);
    }
    const maintenance = yaml('infra/qa-store/aws/maintenance/action.yml').runs.steps;
    expect(maintenance[0]!.name).toBe(MASK_STEP);
    expect(maintenance[1]!.uses).toMatch(/^aws-actions\/configure-aws-credentials@/);
  });

  it('has configure-aws-credentials mask the account it assumed, in both AWS actions', () => {
    for (const p of ['infra/qa-store/aws/action.yml', 'infra/qa-store/aws/maintenance/action.yml']) {
      const creds = yaml(p).runs.steps.find((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials@'))!;
      expect(creds.with?.['mask-aws-account-id'], p).toBe(true);
    }
  });

  it('prints nothing, and succeeds, with the secrets unmapped or holding no account id', () => {
    for (const json of ['', '{}', '{"QA_STORE_ROLE_ARN":"","QA_STORE_BUCKET":"plain"}']) {
      expect(runBlockMask(json)).toBe('');
      expect(runBash(yaml('.github/actions/qa-store/action.yml').runs.steps[0]!, { inputs: { secrets: json } })).toBe('');
      expect(runBash(templateHook().runs.steps[0]!, { inputs: { secrets: json } })).toBe('');
    }
  });
});

describe('accountMasks', () => {
  it('takes every run of exactly twelve digits in the secrets\' values, once', () => {
    const other = ['1'.repeat(6), '2'.repeat(6)].join('');
    expect(accountMasks(SECRETS_JSON)).toEqual([ACCOUNT]);
    expect(accountMasks(JSON.stringify({ A: ARN, B: `b-${other}` }))).toEqual([ACCOUNT, other]);
  });
  it('ignores shorter and longer runs, and JSON it cannot read', () => {
    expect(accountMasks(JSON.stringify({ A: `x${ACCOUNT}9`, B: '12345678901' }))).toEqual([]);
    expect(accountMasks(undefined)).toEqual([]);
    expect(accountMasks('not json')).toEqual([]);
    expect(accountMasks('null')).toEqual([]);
  });
});
